"""Audio Separator stages and validated, content-based stem caching."""

import hashlib
import gc
import json
import logging
import os
import re
import shutil
import tempfile
import time
from importlib.metadata import version
from pathlib import Path

import soundfile as sf
import librosa
import numpy as np
from progress import model_progress

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
SEPARATED_DIR = ROOT / "separated"
BASE_MODEL = "BS-Roformer-SW.ckpt"
QUICK_MODEL = "htdemucs.yaml"
VOCAL_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
DRUM_MODEL = "MDX23C-DrumSep-aufr33-jarredou.ckpt"
BASE_STEMS = {key: key for key in ("bass", "guitar", "piano", "other", "vocals", "drums")}
QUICK_STEMS = {key: key for key in ("bass", "drums", "other", "vocals")}
DRUM_STEMS = {"kick": "kick", "snare": "snare", "toms": "toms", "hh": "hihat", "ride": "ride", "crash": "crash"}
# This model labels lead vocals "Vocals" and accompaniment "Instrumental".
# With vocals as its input, the accompaniment output contains backing vocals.
VOCAL_STEMS = {"Instrumental": "backing_vocals", "Vocals": "lead_vocals"}
# Far below either vocal visibility threshold; retain the residual in the lead WAV.
QUIET_VOCAL_PEAK = 10 ** (-80 / 20)
UNCOMPRESSED_SUBTYPES = {"PCM_U8", "PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"}
SEPARATOR_SETTINGS = {
    "output_format": "WAV",
    "sample_rate": 44100,
    "normalization_threshold": 0.9,
    "amplification_threshold": 0.0,
    "use_soundfile": True,
    "mdxc_params": {"batch_size": 1, "overlap": None},
}
QUICK_SETTINGS = {
    **SEPARATOR_SETTINGS,
    "demucs_params": {"segment_size": "Default", "shifts": 0, "overlap": 0.25, "segments_enabled": True},
}


def create_separator(**settings):
    # Cached uploads and analysis-only runs do not need Torch, ONNX, or model loaders.
    import onnxruntime as ort
    # Avoid the native telemetry dispatcher crash seen during macOS shutdown.
    ort.disable_telemetry_events()
    from audio_separator.separator import Separator
    return Separator(**settings)


def release_separator(separator):
    """Release model weights before clearing the allocator on memory-limited GPUs."""
    import torch
    device = str(separator.torch_device)
    separator.model_instance = None
    gc.collect()
    if device.startswith("mps"):
        torch.mps.empty_cache()
    elif device.startswith("cuda"):
        torch.cuda.empty_cache()


def file_digest(path):
    with open(path, "rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def song_directory(song_path):
    path = Path(song_path).resolve(strict=True)
    name = re.sub(r"[^\w.-]+", "_", path.stem)[:80] or "song"
    digest = file_digest(path)
    directory = SEPARATED_DIR / f"{name}-{digest[:16]}"
    if not directory.exists():
        # A renamed copy of the same audio can reuse its existing validated stems.
        for candidate in sorted(SEPARATED_DIR.glob(f"*-{digest[:16]}")):
            for stage in ("instruments", "quick_instruments"):
                try:
                    manifest = json.loads((candidate / stage / "manifest.json").read_text())
                    if manifest["signature"]["input_sha256"] == digest:
                        return candidate
                except (OSError, ValueError, KeyError, TypeError):
                    continue
    return directory


def validate_audio(path, expected_duration):
    if not path.is_file():
        raise FileNotFoundError(f"Separation output is missing: {path}")
    info = sf.info(path)
    if info.frames == 0 or info.channels not in (1, 2):
        raise RuntimeError(f"Separation output is not usable audio: {path}")
    if abs(info.duration - expected_duration) > 0.1:
        raise RuntimeError(f"Separation output has the wrong duration: {path}")


def audio_duration(path):
    try:
        info = sf.info(path)
    except RuntimeError:
        # Formats such as M4A need the FFmpeg-backed reader.
        return librosa.get_duration(path=str(path))
    if info.subtype in UNCOMPRESSED_SUBTYPES:
        return info.duration
    # MP3 headers can include encoder padding or estimate the sample count.
    # Validate stems against the samples actually decoded, not that estimate.
    with sf.SoundFile(path) as source:
        frames = 0
        while True:
            block = source.read(65536, dtype="float32", always_2d=True)
            if len(block) == 0:
                break
            frames += len(block)
        return frames / source.samplerate


def prepare_separation_input(audio_path, staging, settings):
    """Avoid Audio Separator copying an incompatible input encoding into WAV."""
    if not settings.get("use_soundfile") or settings.get("output_format") != "WAV":
        return audio_path
    try:
        info = sf.info(audio_path)
    except RuntimeError:
        # Audio Separator's FFmpeg-backed reader handles these formats itself.
        return audio_path
    # libsndfile reports WAV/MP3 as valid even though its WAV writer rejects it.
    # Preserve standard uncompressed encodings; decode compressed inputs once.
    if info.subtype in UNCOMPRESSED_SUBTYPES:
        return audio_path
    print(f"Decoding {info.subtype} input to floating-point WAV for compatible stem export", flush=True)
    input_dir = Path(staging) / ".input"
    input_dir.mkdir()
    converted = input_dir / "source.wav"
    with sf.SoundFile(audio_path) as source, sf.SoundFile(converted, "w", samplerate=info.samplerate, channels=info.channels, subtype="FLOAT") as output:
        # Sequential reads keep the MP3 decoder state across block boundaries.
        while True:
            block = source.read(65536, dtype="float32", always_2d=True)
            if len(block) == 0:
                break
            output.write(block)
    return converted


def quiet_vocal_outputs(audio_path, staging):
    """Avoid vocal inference only when the entire isolated vocal stem is inaudible."""
    info = sf.info(audio_path)
    if info.samplerate != SEPARATOR_SETTINGS["sample_rate"]:
        return None
    for block in sf.blocks(audio_path, blocksize=65536, dtype="float32", always_2d=True):
        if not np.isfinite(block).all() or np.max(np.abs(block)) > QUIET_VOCAL_PEAK:
            return None
    lead = Path(staging) / "lead_vocals.wav"
    backing = Path(staging) / "backing_vocals.wav"
    shutil.copyfile(audio_path, lead)
    with sf.SoundFile(backing, "w", samplerate=info.samplerate, channels=info.channels, subtype=info.subtype) as output:
        remaining = info.frames
        zeros = np.zeros((65536, info.channels), dtype=np.float32)
        while remaining:
            count = min(remaining, len(zeros))
            output.write(zeros[:count])
            remaining -= count
    return [str(lead), str(backing)]


def separate_stage(audio_path, model, stem_names, output_dir, force=False, cached_only=False, progress=None, precision="auto", settings=None):
    """Publish a complete stage only after every expected WAV has been validated."""
    audio_path = Path(audio_path).resolve(strict=True)
    output_dir = Path(output_dir).resolve()
    if precision not in {"auto", "fp32"}:
        raise ValueError("Precision must be auto or fp32")
    started = time.perf_counter()
    settings = SEPARATOR_SETTINGS if settings is None else settings
    label = {"instruments": "instruments", "quick_instruments": "instruments", "drum_parts": "drums", "vocal_parts": "lead and backing vocals"}.get(output_dir.name, output_dir.name)

    def notify(fraction, message):
        if progress is not None:
            progress(fraction, message)

    notify(0, f"Preparing {label}")
    duration = audio_duration(audio_path)
    signature = {
        "schema": 1,
        "input_sha256": file_digest(audio_path),
        "model": model,
        "audio_separator_version": version("audio-separator"),
        "settings": settings,
        "stem_names": stem_names,
    }
    expected_keys = list(stem_names.values())
    manifest_path = output_dir / "manifest.json"
    stems = [{"key": key, "file": str(output_dir / f"{key}.wav")} for key in expected_keys]

    if not force:
        try:
            manifest = json.loads(manifest_path.read_text())
            # Auto can reuse either precision, including existing full-precision caches.
            # Explicit fp32 requires full-precision outputs; legacy manifests are fp32.
            if not isinstance(manifest, dict) or not isinstance(manifest.get("execution", {}), dict):
                raise ValueError("Invalid cache metadata")
            cached_precision = manifest.get("execution", {}).get("precision", "fp32")
            if manifest["signature"] == signature and (precision == "auto" or cached_precision == "fp32"):
                for stem in stems:
                    path = Path(stem["file"])
                    validate_audio(path, duration)
                    if manifest["outputs"][stem["key"]] != file_digest(path):
                        raise ValueError("Cached audio changed")
                print(f"Using cached {output_dir.name} stems ({time.perf_counter() - started:.2f}s)", flush=True)
                notify(1, f"{label.capitalize()} ready")
                return stems
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            pass

    if cached_only:
        raise RuntimeError(f"No valid {output_dir.name} cache. Run without --analysis-only to generate it.")

    output_dir.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Separating {output_dir.name} with {model}...", flush=True)
    with tempfile.TemporaryDirectory(prefix=".processing-", dir=output_dir) as staging:
        files = quiet_vocal_outputs(audio_path, staging) if model == VOCAL_MODEL and stem_names == VOCAL_STEMS else None
        if files is not None:
            execution = {"precision": "fp32", "device": "cpu", "mode": "quiet_vocals"}
            print("Vocal stem peak is at or below -80 dBFS; preserving residual as lead and skipping vocal inference", flush=True)
        else:
            # MP3/Vorbis encodings cannot be used inside the generated WAVs.
            # Decode only on a cache miss; keep the original upload and cache hash.
            separation_input = prepare_separation_input(audio_path, staging, settings)
            runtime = {"use_native_fp16": True} if precision == "auto" and model in {BASE_MODEL, VOCAL_MODEL} else {}
            separator = create_separator(
                output_dir=staging, model_file_dir=str(MODEL_DIR),
                log_level=logging.WARNING, **settings, **runtime,
            )
            notify(0.03, f"Preparing {label}")
            load_started = time.perf_counter()
            try:
                separator.load_model(model_filename=model)
                load_seconds = time.perf_counter() - load_started
                execution = {
                    "precision": separator.effective_precision,
                    "device": str(separator.model_instance.torch_device),
                }
                print(f"{label.capitalize()}: {execution['device']}, {execution['precision']}; model loaded in {load_seconds:.2f}s", flush=True)
                notify(0.08, f"Separating {label}")
                callback = (lambda fraction: notify(0.08 + 0.82 * fraction, f"Separating {label}")) if progress else None
                inference_started = time.perf_counter()
                with model_progress(callback):
                    files = separator.separate(str(separation_input), custom_output_names=stem_names)
                print(f"{label.capitalize()}: separation took {time.perf_counter() - inference_started:.2f}s", flush=True)
            finally:
                release_separator(separator)
        notify(0.94, f"Saving {label}")
        produced = {}
        for filename in files:
            path = Path(filename)
            if not path.is_absolute():
                path = Path(staging) / path
            if path.stem in produced:
                raise RuntimeError(f"Separation returned duplicate output: {path.stem}")
            produced[path.stem] = path
        missing = set(expected_keys) - produced.keys()
        if missing:
            raise RuntimeError(f"Separation did not produce: {', '.join(sorted(missing))}")

        for key in expected_keys:
            validate_audio(produced[key], duration)
        hashes = {key: file_digest(produced[key]) for key in expected_keys}
        for stem in stems:
            os.replace(produced[stem["key"]], stem["file"])
        manifest_tmp = Path(staging) / "manifest.json"
        manifest_tmp.write_text(json.dumps({"signature": signature, "outputs": hashes, "execution": execution}, indent=2))
        os.replace(manifest_tmp, manifest_path)
    notify(1, f"{label.capitalize()} ready")
    print(f"{label.capitalize()}: stage completed in {time.perf_counter() - started:.2f}s", flush=True)
    return stems


def split_stem(stems, key, model, names, stage, **options):
    stem = next((stem for stem in stems if stem["key"] == key), None)
    if stem is None:
        raise FileNotFoundError(f"Initial separation did not produce {key}.wav")
    output_dir = Path(stem["file"]).parent.parent / stage
    return separate_stage(stem["file"], model, names, output_dir, **options)


def run_separation(song_path, force=False, cached_only=False, progress=None, precision="auto", mode="thorough"):
    if mode not in {"quick", "thorough"}:
        raise ValueError("Processing mode must be quick or thorough")
    options = {"force": force, "cached_only": cached_only, "precision": precision}

    def stage_progress(start, end):
        if progress is None:
            return None
        return lambda fraction, message: progress(start + (end - start) * fraction, message)

    directory = song_directory(song_path)
    if mode == "quick":
        return separate_stage(song_path, QUICK_MODEL, QUICK_STEMS, directory / "quick_instruments", settings=QUICK_SETTINGS, progress=stage_progress(5, 95), **options)
    stems = separate_stage(song_path, BASE_MODEL, BASE_STEMS, directory / "instruments", progress=stage_progress(5, 40), **options)
    drums = split_stem(stems, "drums", DRUM_MODEL, DRUM_STEMS, "drum_parts", progress=stage_progress(40, 55), **options)
    vocals = split_stem(stems, "vocals", VOCAL_MODEL, VOCAL_STEMS, "vocal_parts", progress=stage_progress(55, 95), **options)
    # Combined vocals/drums remain available on disk, but are replaced in the view.
    return [stem for stem in stems if stem["key"] not in {"drums", "vocals"}] + vocals + drums
