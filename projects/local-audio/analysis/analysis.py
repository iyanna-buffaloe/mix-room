import argparse
import librosa
import numpy as np
import json
import os
import time
from pathlib import Path
from separation import DRUM_STEMS, run_separation
from progress import report_progress

# ---- CONFIG ----
OUTPUT_DIR = str(Path(__file__).resolve().parents[1] / "output" / "analysis")
FRAMES_PER_SECOND = 10
SILENCE_THRESHOLD_DB = -35  # tune this if needed
# Individual drum parts and backing vocals may have less energy than main stems.
DRUM_SILENCE_THRESHOLD_DB = -45
BACKING_VOCAL_SILENCE_THRESHOLD_DB = -45
# Preserve each stem's animation while giving relative mix levels some influence.
CONTEXT_WEIGHT = 0.35
TOM_ACTIVITY_FLOOR_DB = -60
TOM_KICK_SIMILARITY = 0.8
TOM_KICK_MAX_RATIO = 0.5

def get_width(path):
    y, sr = librosa.load(path, sr=None, mono=False)
    return measure_width(y)


def measure_width(y):
    if y.ndim == 1:
        return 0.0  # mono file has no width

    left, right = y[0], y[1]
    if left.size == 0:
        return 0.0
    # Accumulate in float64 without allocating full-length centered channel copies.
    left_mean = np.mean(left, dtype=np.float64)
    right_mean = np.mean(right, dtype=np.float64)
    left_var = np.einsum("i,i->", left, left, dtype=np.float64) / left.size - left_mean ** 2
    right_var = np.einsum("i,i->", right, right, dtype=np.float64) / right.size - right_mean ** 2
    covariance = np.einsum("i,i->", left, right, dtype=np.float64) / left.size - left_mean * right_mean
    correlation = covariance / np.sqrt(left_var * right_var) if left_var > 0 and right_var > 0 else 1.0
    width = 1 - abs(correlation)  # invert so wide = high value
    return round(float(np.clip(width, 0, 1)), 3)

def measure_stem(path, fps, silence_threshold_db=SILENCE_THRESHOLD_DB):
    y, sr = librosa.load(path, sr=None, mono=False)
    return measure_audio(y, sr, fps, silence_threshold_db)


def measure_audio(y, sr, fps, silence_threshold_db=SILENCE_THRESHOLD_DB):

    if y.size == 0:
        return {
            "times": np.array([]), "rms": np.array([]), "pan": np.array([]),
            "active": False, "ceiling": 0.0,
        }

    # Mono has zero pan; reuse its samples and RMS instead of duplicating audio.
    mono = y.ndim == 1
    left, right = (y, y) if mono else (y[0], y[1])
    hop_length = int(sr / fps)

    # loudness (RMS) per channel, then averaged for overall loudness
    rms_left = librosa.feature.rms(y=left, hop_length=hop_length)[0]
    rms_right = rms_left if mono else librosa.feature.rms(y=right, hop_length=hop_length)[0]
    rms_avg = (rms_left + rms_right) / 2

    times = librosa.frames_to_time(np.arange(len(rms_avg)), sr=sr, hop_length=hop_length)

    # check absolute level — a stem with only faint noise/bleed should read as silent
    peak_rms = np.max(rms_avg)
    peak_db = librosa.amplitude_to_db(np.array([peak_rms]), ref=1.0)[0]

    pan = np.clip((rms_right - rms_left) / (rms_right + rms_left + 1e-9), -1, 1)
    return {
        "times": times,
        "rms": rms_avg,
        "pan": pan,
        "active": bool(peak_db >= silence_threshold_db),
        "ceiling": float(np.percentile(rms_avg, 95)),
    }


def normalize_stem(measurement, loudness_reference=None):
    times = measurement["times"]
    if not measurement["active"]:
        return [
            {"t": round(float(t), 2), "loud": 0.0, "pan": 0.0}
            for t in times
        ]

    rms = measurement["rms"]
    local = np.clip(rms / (measurement["ceiling"] + 1e-9), 0, 1)
    loudness = local
    if loudness_reference is not None:
        # One fixed reference for the whole song avoids pumping as stems enter/exit.
        shared = np.clip(rms / (loudness_reference + 1e-9), 0, 1)
        loudness = (1 - CONTEXT_WEIGHT) * local + CONTEXT_WEIGHT * shared

    # Apply bleed suppression after normalization so spill is never boosted back up.
    loudness = loudness * measurement.get("activity", 1.0)
    frames = []
    for i, (t, loud, pan) in enumerate(zip(times, loudness, measurement["pan"])):
        frame = {"t": round(float(t), 2), "loud": round(float(loud), 3), "pan": round(float(pan), 3)}
        if "kickBleed" in measurement:
            frame["kickBleed"] = round(float(measurement["kickBleed"][i]), 3)
        frames.append(frame)
    return frames


def get_tom_activity(tom_path, kick_path, measurement):
    """Estimate tom activity and likely kick spill; leave the separated audio intact."""
    toms, sr = librosa.load(tom_path, sr=None, mono=True)
    kick, kick_sr = librosa.load(kick_path, sr=None, mono=True)
    if kick_sr != sr:
        kick = librosa.resample(kick, orig_sr=kick_sr, target_sr=sr)
    return measure_tom_activity(toms, kick, sr, measurement)


def measure_tom_activity(toms, kick, sr, measurement):

    floor = 10 ** (TOM_ACTIVITY_FLOOR_DB / 20)
    # Reject very quiet residue between fills without flattening stronger tom hits.
    activity = np.clip((measurement["rms"] - floor) / floor, 0, 1)
    bleed = np.zeros(len(measurement["times"]))
    kick_floor = 10 ** (DRUM_SILENCE_THRESHOLD_DB / 20)

    for i, t in enumerate(measurement["times"]):
        center = int(round(t * sr))
        start, end = max(0, center - 1024), min(len(toms), center + 1024)
        if end <= start or end > len(kick):
            continue
        tom_window, kick_window = toms[start:end], kick[start:end]
        tom_norm, kick_norm = np.linalg.norm(tom_window), np.linalg.norm(kick_window)
        if kick_norm / np.sqrt(end - start) < kick_floor or tom_norm == 0:
            continue

        ratio = tom_norm / (kick_norm + 1e-12)
        similarity = np.clip(abs(np.dot(tom_window, kick_window)) / (tom_norm * kick_norm + 1e-12), 0, 1)
        # Coincident onsets alone are insufficient: require a weaker, matching waveform.
        # Stronger toms and independent tom waveforms are deliberately preserved.
        if ratio <= TOM_KICK_MAX_RATIO and similarity >= TOM_KICK_SIMILARITY:
            bleed[i] = similarity ** 2

    return activity * (1 - bleed), bleed


def analyze_stem(path, fps, silence_threshold_db=SILENCE_THRESHOLD_DB, loudness_reference=None):
    measurement = measure_stem(path, fps, silence_threshold_db)
    return normalize_stem(measurement, loudness_reference)

#y coordinates
def get_freq(path):
    y, sr = librosa.load(path, sr=None, mono=True)
    return measure_frequency(y, sr)


def measure_frequency(y, sr):
    if len(y) == 0:
        return 0.5

    # Preserve the original 2048-sample windows, 512-sample hop, and zero padding.
    # Small blocks avoid allocating a whole-song spectrogram and its float64 copies.
    frame_length, hop, block_frames = 2048, 512, 256
    frames = 1 + len(y) // hop
    weighted_centroid, total_energy = 0.0, 0.0
    for first in range(0, frames, block_frames):
        count = min(block_frames, frames - first)
        start = first * hop - frame_length // 2
        end = start + (count - 1) * hop + frame_length
        block = y[max(0, start):min(len(y), end)]
        if start < 0 or end > len(y):
            block = np.pad(block, (max(0, -start), max(0, end - len(y))))
        spectrum = np.abs(librosa.stft(block, n_fft=frame_length, hop_length=hop, center=False))
        centroid = librosa.feature.spectral_centroid(S=spectrum, sr=sr)[0]
        # Quiet tails and bleed contribute less to the instrument's height.
        energy = librosa.feature.rms(y=block, frame_length=frame_length, hop_length=hop, center=False)[0] ** 2
        weighted_centroid += float(np.dot(centroid, energy))
        total_energy += float(np.sum(energy, dtype=np.float64))
    avg_centroid = weighted_centroid / total_energy if total_energy > 0 else 0.0

    # Keep the room's existing frequency scale (0-8 kHz).
    FREQ_CEILING = 8000
    freq_norm = avg_centroid / FREQ_CEILING
    return round(float(min(freq_norm, 1.0)), 3)

#x coordinates
def get_pan(path):
    y, sr = librosa.load(path, sr=None, mono=False)
    if y.ndim == 1:
        return 0.0
    left, right = y[0], y[1]
    left_rms = np.sqrt(np.mean(left**2))
    right_rms = np.sqrt(np.mean(right**2))
    return round(float((right_rms - left_rms) / (right_rms + left_rms + 1e-9)), 3)


def write_json(path, data):
    """Leave unchanged exports alone so cached uploads do not trigger repeated HMR."""
    path = Path(path)
    contents = json.dumps(data)
    if path.is_file() and path.read_text() == contents:
        return
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(contents)
    os.replace(temporary, path)


def write_analysis(stems, audio_url, drum_keys, progress=None, processing_mode="thorough", output_dir=None, title=None):
    output_dir = output_dir or OUTPUT_DIR
    os.makedirs(output_dir, exist_ok=True)

    measurements = []
    drum_audio = {}
    for index, stem in enumerate(stems):
        threshold = SILENCE_THRESHOLD_DB
        if stem["key"] in drum_keys:
            threshold = DRUM_SILENCE_THRESHOLD_DB
        elif stem["key"] == "backing_vocals":
            threshold = BACKING_VOCAL_SILENCE_THRESHOLD_DB
        y, sr = librosa.load(stem["file"], sr=None, mono=False)
        measurement = measure_audio(y, sr, FRAMES_PER_SECOND, threshold)
        mono = librosa.to_mono(y)
        measurement["freq"] = measure_frequency(mono, sr)
        measurement["width"] = measure_width(y)
        measurements.append(measurement)
        if stem["key"] in {"toms", "kick"}:
            drum_audio[stem["key"]] = (mono, sr)
        del y, mono
        if progress:
            progress(0.5 * (index + 1) / len(stems), "Analyzing instruments")

    by_key = {stem["key"]: (stem, measurement) for stem, measurement in zip(stems, measurements)}
    if "toms" in by_key and "kick" in by_key:
        _, tom_measurement = by_key["toms"]
        toms, sr = drum_audio["toms"]
        kick, kick_sr = drum_audio["kick"]
        if kick_sr != sr:
            kick = librosa.resample(kick, orig_sr=kick_sr, target_sr=sr)
        activity, bleed = measure_tom_activity(toms, kick, sr, tom_measurement)
        tom_measurement["activity"] = activity
        tom_measurement["kickBleed"] = bleed

    # The loudest active stem's typical peaks anchor every instrument to the same scale.
    loudness_reference = max(
        (m["ceiling"] for m in measurements if m["active"]), default=0.0
    )

    metadata = []
    for index, (stem, measurement) in enumerate(zip(stems, measurements)):
        frames = normalize_stem(measurement, loudness_reference)
        if "duration" in stem:
            # The player holds its closest frame. End imported stems in silence
            # so a shorter file does not remain lit through the rest of the mix.
            duration = stem["duration"]
            frames = [frame for frame in frames if frame["t"] < duration]
            frames.append({"t": round(duration, 6), "loud": 0.0, "pan": 0.0, "kickBleed": 0.0})
        freq = measurement["freq"]
        width = measurement["width"]
        energy = measurement["rms"] ** 2
        pan = float(np.average(measurement["pan"], weights=energy)) if np.sum(energy) > 0 else 0.0

        out_path = os.path.join(output_dir, f"{stem['key']}_frames.json")
        write_json(out_path, frames)

        metadata.append({
            "key": stem["key"], "freq": freq, "width": width,
            "pan": round(pan, 3), "active": measurement["active"],
            **({"label": stem["label"]} if "label" in stem else {}),
            **({"fileName": stem["fileName"]} if "fileName" in stem else {}),
        })
        if progress:
            progress(0.5 + 0.45 * (index + 1) / len(stems), "Building your room")

    song_data = {
        "audioUrl": audio_url,
        "processingMode": processing_mode,
        "instruments": metadata,
    }
    if title:
        song_data["title"] = title

    write_json(os.path.join(output_dir, "instrument_meta.json"), song_data)

    # Remove generated frames for instruments absent from the current result.
    # Otherwise Vite includes old tracks' unused frame files in every build.
    used_frames = {f"{stem['key']}_frames.json" for stem in stems}
    for path in Path(output_dir).glob("*_frames.json"):
        if path.name not in used_frames:
            path.unlink()
    if progress:
        progress(1, "Room ready")


def main():
    parser = argparse.ArgumentParser(description="Separate instruments, drums, and vocals, then refresh the room.")
    parser.add_argument("song", help="Path to the original song")
    parser.add_argument("--mode", choices=("quick", "thorough"), default="thorough", help="Quick extracts four broad stems; thorough also splits drum parts and lead/backing vocals")
    parser.add_argument("--output-dir", help="Write analysis into a staging directory instead of publishing it directly")
    parser.add_argument("--precision", choices=("auto", "fp32"), default=os.environ.get("MIX_ROOM_PRECISION", "auto"), help="Auto uses native float16 for supported GPU RoFormer models; fp32 forces full precision")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--force", action="store_true", help="Regenerate all separation stages")
    mode.add_argument("--analysis-only", action="store_true", help="Analyze cached stems without running any models")
    args = parser.parse_args()
    started = time.perf_counter()
    report_progress(5, "Preparing song")
    stems = run_separation(args.song, force=args.force, cached_only=args.analysis_only, progress=report_progress, precision=args.precision, mode=args.mode)
    analysis_started = time.perf_counter()
    write_analysis(
        stems, f"/audio/{os.path.basename(args.song)}", set(DRUM_STEMS.values()) | {"drums"},
        progress=lambda fraction, message: report_progress(95 + 4 * fraction, message),
        processing_mode=args.mode,
        output_dir=args.output_dir,
    )
    print(f"Analysis completed in {time.perf_counter() - analysis_started:.2f}s; total processing {time.perf_counter() - started:.2f}s", flush=True)


if __name__ == "__main__":
    main()
