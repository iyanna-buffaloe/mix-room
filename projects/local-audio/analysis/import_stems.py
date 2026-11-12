"""Analyze user-supplied stems and build a playback mix, without separation."""

import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

import numpy as np
import soundfile as sf

from analysis import write_analysis
from progress import report_progress

SAMPLE_RATE = 44100
BLOCK_SIZE = 65536
MAX_STEMS = 32
DRUM_KEYS = {"drums", "kick", "snare", "toms", "hihat", "cymbals"}


def read_manifest(path):
    entries = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_STEMS:
        raise ValueError(f"Upload between 1 and {MAX_STEMS} stems.")
    stems, used = [], set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Invalid stem entry.")
        label = entry.get("label")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 60:
            raise ValueError("Each instrument needs a name of 1–60 characters.")
        label = label.strip()
        source = Path(entry["file"])
        if not source.is_file():
            raise ValueError(f"Stem file not found: {label}")
        base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "stem"
        if not base[0].isalpha():
            base = "stem_" + base
        # Display names can repeat; generated frame filenames must be unique.
        key, suffix = base, 2
        while key in used:
            key = f"{base}_{suffix}"
            suffix += 1
        used.add(key)
        stems.append({"key": key, "label": label, "file": str(source), "fileName": entry.get("fileName", source.name)})
    return stems


def prepare_audio(stems, work_dir, progress):
    prepared = []
    for index, stem in enumerate(stems):
        target = work_dir / f"decoded-{index}.wav"
        # FFmpeg handles compressed formats and resampling. Its child process is
        # in the analysis process group, so the existing cancel action stops it.
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", stem["file"], "-vn", "-ar", str(SAMPLE_RATE), "-ac", "2",
            "-c:a", "pcm_f32le", str(target),
        ], capture_output=True, text=True)
        if result.returncode:
            raise ValueError(f"Could not decode {stem['label']}: {result.stderr[-2000:]}")
        info = sf.info(target)
        if info.frames == 0:
            raise ValueError(f"Empty audio file: {stem['label']}")
        prepared.append({**stem, "file": str(target), "duration": info.frames / info.samplerate})
        progress(5 + 25 * (index + 1) / len(stems), f"Reading stem {index + 1} of {len(stems)}")
    return prepared


def build_mix(stems, destination, progress):
    """Sum aligned stems in blocks, pad short files, and prevent mix clipping."""
    floating_mix = destination.with_suffix(".float.wav")
    peak = 0.0
    with ExitStack() as stack:
        inputs = [stack.enter_context(sf.SoundFile(stem["file"])) for stem in stems]
        total_frames = max(audio.frames for audio in inputs)
        output = stack.enter_context(sf.SoundFile(floating_mix, "w", samplerate=SAMPLE_RATE, channels=2, subtype="FLOAT"))
        for offset in range(0, total_frames, BLOCK_SIZE):
            count = min(BLOCK_SIZE, total_frames - offset)
            block = np.zeros((count, 2), dtype=np.float64)
            for audio in inputs:
                samples = audio.read(count, dtype="float32", always_2d=True)
                if not np.isfinite(samples).all():
                    raise ValueError("A stem contains invalid audio samples.")
                block[:len(samples)] += samples
            peak = max(peak, float(np.max(np.abs(block))))
            output.write(block)
            progress(30 + 10 * (offset + count) / total_frames, "Combining stems for playback")
    # A single gain adjustment keeps the stems' relative volume and stereo pan.
    gain = min(1.0, 0.98 / peak) if peak else 1.0
    with sf.SoundFile(floating_mix) as source, sf.SoundFile(
        destination, "w", samplerate=SAMPLE_RATE, channels=2, subtype="PCM_24"
    ) as output:
        for samples in source.blocks(blocksize=BLOCK_SIZE, dtype="float32", always_2d=True):
            output.write(samples * gain)
    floating_mix.unlink()


def import_stems(manifest, output_dir, mix_path, progress=report_progress, title="stem mix"):
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
        raise ValueError("The song title must contain 1–120 characters.")
    output_dir, mix_path = Path(output_dir), Path(mix_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    stems = read_manifest(manifest)
    stems = prepare_audio(stems, output_dir, progress)
    build_mix(stems, mix_path, progress)
    write_analysis(
        stems, f"/audio/{quote(mix_path.name)}", DRUM_KEYS,
        progress=lambda fraction, message: progress(40 + 59 * fraction, message),
        processing_mode="stems", output_dir=str(output_dir), title=title.strip(),
    )
    # Decoded stems are temporary; only the analysis and combined audio publish.
    for stem in stems:
        Path(stem["file"]).unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--mix-path", required=True)
    parser.add_argument("--title", default="stem mix")
    args = parser.parse_args()
    import_stems(args.manifest, args.output_dir, args.mix_path, title=args.title)
