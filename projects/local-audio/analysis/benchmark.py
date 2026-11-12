"""Measure uncached processing without publishing a new song to the room."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

import psutil

ROOT = Path(__file__).resolve().parent


def process_memory(pid):
    """Sample resident memory of analysis and any decoder subprocesses."""
    try:
        process = psutil.Process(pid)
        processes = [process, *process.children(recursive=True)]
    except psutil.Error:
        return 0
    total = 0
    for process in processes:
        try:
            total += process.memory_info().rss
        except psutil.Error:
            pass
    return total


def run_mode(song, mode):
    with tempfile.TemporaryDirectory(prefix="mix-room-benchmark-") as output_dir:
        command = [sys.executable, "-X", "faulthandler", "-u", str(ROOT / "analysis.py"),
                   str(song), "--mode", mode, "--force", "--output-dir", output_dir]
        started = time.perf_counter()
        process = subprocess.Popen(command, cwd=ROOT)
        peak = 0
        try:
            while process.poll() is None:
                peak = max(peak, process_memory(process.pid))
                time.sleep(0.2)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
        return {"mode": mode, "seconds": round(time.perf_counter() - started, 2),
                "peak_ram_gib": round(peak / 1024 ** 3, 3), "exit_code": process.returncode}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("song", type=Path)
    parser.add_argument("--mode", choices=("quick", "thorough", "both"), default="quick")
    args = parser.parse_args()
    song = args.song.resolve(strict=True)
    modes = ("quick", "thorough") if args.mode == "both" else (args.mode,)
    print("Benchmark forces fresh inference; existing model downloads are reused.", flush=True)
    print("First runs include downloading weights. Re-run for steady-state timing.", flush=True)
    print("Your room's audio and analysis are left unchanged; stem caches are regenerated.", flush=True)
    results = []
    for mode in modes:
        print(f"\nStarting {mode} benchmark...", flush=True)
        result = run_mode(song, mode)
        results.append(result)
        print(f"\n{mode.capitalize()}: {result['seconds']:.1f}s; sampled peak process RAM {result['peak_ram_gib']:.2f} GiB; exit code {result['exit_code']}", flush=True)
        if result["exit_code"] != 0:
            break
    folder = ROOT / "benchmarks"
    folder.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    report = folder / f"{stamp}.json"
    report.write_text(json.dumps({"song": song.name, "system": platform.platform(),
                                  "python": platform.python_version(),
                                  "total_ram_gib": round(psutil.virtual_memory().total / 1024 ** 3, 2),
                                  "results": results}, indent=2), encoding="utf-8")
    print(f"Report saved to {report}")
    return 0 if all(result["exit_code"] == 0 for result in results) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nBenchmark cancelled.")
        raise SystemExit(130)
