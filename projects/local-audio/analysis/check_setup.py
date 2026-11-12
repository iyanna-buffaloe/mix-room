"""Check the local processing installation before loading any models."""

import platform
import shutil
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def main():
    print(f"System: {platform.system()} {platform.machine()}")
    print(f"Python: {sys.version.split()[0]} ({sys.executable})")
    failed = sys.version_info < (3, 10)
    for package in ("audio-separator", "torch", "onnxruntime", "audioread", "librosa", "numpy", "soundfile", "psutil"):
        try:
            print(f"{package}: {version(package)}")
        except PackageNotFoundError:
            print(f"MISSING: {package}")
            failed = True
    for command in ("ffmpeg", "ffprobe"):
        executable = shutil.which(command)
        print(f"{command}: {executable or 'MISSING — install FFmpeg and reopen your terminal'}")
        failed |= executable is None
    if failed:
        print("Setup incomplete. Install dependencies using the Windows setup instructions.")
        return 1
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import torch
    import psutil
    print(f"RAM: {psutil.virtual_memory().total / 1024 ** 3:.1f} GiB total; {psutil.virtual_memory().available / 1024 ** 3:.1f} GiB available")
    print(f"Disk free: {shutil.disk_usage(Path(__file__).resolve().parent).free / 1024 ** 3:.1f} GiB")
    device = "CUDA" if torch.cuda.is_available() else "MPS" if torch.backends.mps.is_available() else "CPU"
    print(f"Processing device: {device}")
    print("Setup checks passed. Run npm start to test an upload locally.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
