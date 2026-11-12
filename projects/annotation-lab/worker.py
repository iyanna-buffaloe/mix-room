"""Local-only separation worker. One subprocess per song keeps model memory bounded."""

import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PIPELINE_VERSION = "annotation-lab-v1"
PACKAGES = ("audio-separator", "torch", "onnxruntime", "audioread", "librosa", "numpy", "soundfile")


def check_setup():
    versions = {}
    missing = []
    if sys.version_info < (3, 11):
        missing.append("Python 3.11 or newer")
    for package in PACKAGES:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            missing.append(package)
    if shutil.which("ffmpeg") is None:
        missing.append("ffmpeg")
    return {
        "ready": not missing,
        "python": sys.version.split()[0],
        "packages": versions,
        "missing": missing,
        "error": f"Missing {', '.join(missing)}. See docs/projects/ANNOTATION_LAB.md for setup." if missing else None,
    }


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf8")
    temporary.replace(path)


def digest(path):
    with open(path, "rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def describe_audio(path, key, label, directory, annotatable=False):
    """100-Hz channel peak envelopes; stats keep original, unscaled amplitudes."""
    import numpy as np
    import soundfile as sf

    path = Path(path)
    peaks = None
    energy = 0.0
    sample_count = 0
    maximum = 0.0
    with sf.SoundFile(path) as source:
        if source.frames == 0 or source.channels not in (1, 2):
            raise ValueError(f"Invalid audio: {path.name}")
        block_frames = max(1, round(source.samplerate / 100))
        peaks = [[] for _ in range(source.channels)]
        while True:
            audio = source.read(block_frames * 512, dtype="float32", always_2d=True)
            if not len(audio):
                break
            if not np.isfinite(audio).all():
                raise ValueError(f"Non-finite samples in {path.name}")
            energy += np.sum(audio.astype(np.float64) ** 2).item()
            sample_count += audio.size
            maximum = max(maximum, float(np.max(np.abs(audio))))
            padding = (-len(audio)) % block_frames
            if padding:
                audio = np.pad(audio, ((0, padding), (0, 0)))
            envelope = np.max(np.abs(audio).reshape(-1, block_frames, source.channels), axis=1)
            for channel in range(source.channels):
                peaks[channel].extend(np.round(envelope[:, channel], 8).tolist())
        duration = source.frames / source.samplerate
        rate = source.samplerate
        channels = source.channels
    waveform = Path(directory) / f"{key}.waveform.json"
    atomic_json(waveform, {"duration": duration, "secondsPerBin": block_frames / rate, "peaks": peaks})
    rms = math.sqrt(energy / sample_count)
    return {
        "key": key, "label": label, "annotatable": annotatable,
        "file": str(path.resolve()), "waveformFile": str(waveform.resolve()),
        "sha256": digest(path), "duration": duration, "sampleRate": rate,
        "channels": channels, "peak": maximum,
        "rmsDb": 20 * math.log10(rms) if rms > 0 else None,
    }


def process(request):
    # Leave capacity for the browser/UI during CPU inference; no global settings change.
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ[name] = "4"
    sys.path.insert(0, str(ROOT / "projects" / "local-audio" / "analysis"))
    import torch
    torch.set_num_threads(4)
    import separation as pipeline
    from progress import report_progress

    profile = request["profile"]
    if profile not in {"drums", "vocals", "quick"}:
        raise ValueError("Invalid separation profile")
    if profile == "quick" and request.get("isolated"):
        raise ValueError("Quick separation requires a full mix")
    directory = Path(request["directory"]).resolve()
    source = directory / "source.wav"
    input_path = Path(request["input"])
    report_progress(1, "Decoding source audio")
    temporary_source = directory / "source.decoding.wav"
    try:
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(input_path),
            "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_f32le", str(temporary_source),
        ], check=True, capture_output=True)
        temporary_source.replace(source)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Could not decode this audio file: {error.stderr.decode(errors='replace')[-2000:]}") from error
    finally:
        temporary_source.unlink(missing_ok=True)

    input_hash = digest(input_path)
    decoded_hash = digest(source)
    package_versions = {package: importlib.metadata.version(package) for package in PACKAGES}
    # A fixed precision and settings signature makes reruns comparable.
    settings = {**pipeline.SEPARATOR_SETTINGS, "normalization_threshold": 1.0, "amplification_threshold": 0.0}
    stages = []
    cache = Path(request["cache"]).resolve() / decoded_hash
    model_configs = {
        pipeline.BASE_MODEL: "BS-Roformer-SW.yaml",
        pipeline.DRUM_MODEL: "config_drumsep_mdx23c.yaml",
        pipeline.VOCAL_MODEL: "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956_config.yaml",
    }

    def stage(audio, model, names, name, start, end):
        config = model_configs[model]
        report_progress(start, f"Preparing {name.replace('_', ' ')}")
        # load_model downloads missing public weights/configuration on the first use.
        # Once installed, inference and annotation are entirely local.
        if not all((pipeline.MODEL_DIR / file).is_file() for file in (model, config)):
            separator = pipeline.create_separator(model_file_dir=str(pipeline.MODEL_DIR), output_dir=str(directory), **settings)
            try:
                separator.load_model(model_filename=model)
            finally:
                pipeline.release_separator(separator)
        model_info = {
            "stage": name, "model": model, "modelSha256": digest(pipeline.MODEL_DIR / model),
            "config": config, "configSha256": digest(pipeline.MODEL_DIR / config),
        }
        identity = hashlib.sha256(json.dumps({"pipeline": PIPELINE_VERSION, "model": model_info, "settings": settings, "packages": package_versions}, sort_keys=True).encode()).hexdigest()[:20]
        output = cache / identity / name
        stems = pipeline.separate_stage(audio, model, names, output, precision="fp32", settings=settings,
            progress=lambda fraction, message: report_progress(start + (end - start) * fraction, message))
        manifest = json.loads((output / "manifest.json").read_text())
        stages.append({**model_info, "execution": manifest["execution"], "signature": manifest["signature"]})
        return stems

    context = [{"key": "source", "file": str(source), "label": "Original mix"}]
    if profile == "quick" or not request.get("isolated"):
        stems = stage(source, pipeline.BASE_MODEL, pipeline.BASE_STEMS, "instruments", 3, 88 if profile == "quick" else 48)
        if profile != "quick":
            parent_key = "drums" if profile == "drums" else "vocals"
            parent = next(stem for stem in stems if stem["key"] == parent_key)
            context.append({"key": f"parent_{parent_key}", "file": parent["file"], "label": "Drum mix" if profile == "drums" else "Vocal mix"})
            stage_input = parent["file"]
    else:
        stage_input = source
        context[0]["label"] = "Original drum track" if profile == "drums" else "Original vocal track"

    if profile == "drums":
        stems = stage(stage_input, pipeline.DRUM_MODEL, pipeline.DRUM_STEMS, "drum_parts", 3 if request.get("isolated") else 49, 88)
    elif profile == "vocals":
        stems = stage(stage_input, pipeline.VOCAL_MODEL, pipeline.VOCAL_STEMS, "vocal_parts", 3 if request.get("isolated") else 49, 88)
    order = {
        "quick": ["bass", "drums", "vocals", "guitar", "piano", "other"],
        "drums": ["kick", "snare", "toms", "hihat", "ride", "crash"],
        "vocals": ["lead_vocals", "backing_vocals"],
    }[profile]
    stems.sort(key=lambda stem: order.index(stem["key"]))
    names = {"hihat": "Hi-hat", "toms": "Toms", "lead_vocals": "Lead vocals", "backing_vocals": "Backing vocals"}
    tracks = []
    all_tracks = [(track, False) for track in context] + [(track, True) for track in stems]
    for index, (track, annotatable) in enumerate(all_tracks):
        report_progress(89 + 10 * index / len(all_tracks), f"Drawing waveform for {track['key'].replace('_', ' ')}")
        label = track.get("label", names.get(track["key"], track["key"].capitalize()))
        tracks.append(describe_audio(track["file"], track["key"], label, directory, annotatable))
    result = {
        "tracks": tracks,
        "provenance": {
            "pipelineVersion": PIPELINE_VERSION, "inputSha256": input_hash, "decodedSha256": decoded_hash,
            "settings": settings, "precision": "fp32", "stages": stages,
            "packages": package_versions,
            "waveform": {"binsPerSecond": 100, "normalization": "none"},
        },
    }
    atomic_json(directory / "result.json", result)
    report_progress(100, "Ready to listen and label")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--check":
        print(json.dumps(check_setup()))
    else:
        process(json.loads(Path(sys.argv[1]).read_text()))
        # All WAVs/JSONs are closed and atomically published before success.
        # This Mac's ONNX Runtime native event logger can segfault during Python
        # interpreter teardown even after disable_telemetry_events(). A short-lived
        # successful worker can safely skip native atexit teardown; errors still
        # propagate normally, and the server still waits for actual process exit.
        if sys.platform == "darwin":
            # Loky's semaphore cleanup is registered with multiprocessing's
            # finalizers. Run those before bypassing native interpreter teardown.
            from multiprocessing.util import _run_finalizers
            _run_finalizers()
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(0)
