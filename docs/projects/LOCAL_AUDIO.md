# Optional offline audio tools

These Python tools separate songs on your computer. The public website uses
MVSEP instead; browser stem analysis needs no Python installation.

## Before installing

This Mac's existing environment and models already work. Keep them. For a new
machine, install Node 22.12+, Python compatible with the requirements, and FFmpeg.
Create a project virtual environment and install
`projects/local-audio/analysis/requirements.txt`. `npm run doctor` checks setup.
The launcher uses `.venv`, an explicit `MIX_ROOM_PYTHON`, or system Python.

On Windows, use `npm.cmd` in PowerShell to avoid script-policy issues. Do not
copy the Mac's `node_modules` or `.venv`; install fresh. The retained Windows
setup used 64-bit Python 3.13 and CPU PyTorch on the Intel laptop:

```powershell
npm.cmd ci
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install -r projects/local-audio/analysis/requirements.txt
npm.cmd run doctor
```

Install FFmpeg separately and confirm `ffmpeg`/`ffprobe` are on PATH. These are
retained setup instructions, not a fresh compatibility audit. Keep the exact
error if a new installation fails. No public tunnel or firewall change is needed.

## Run a local experiment

From `mix-room`:

```bash
npm run benchmark -- "/path/to/song.wav" --mode quick
npm run benchmark -- "/path/to/song.wav" --mode thorough
```

Benchmarking forces new inference while reusing model downloads. Stop another
local analysis first; run one job at a time on the 8 GiB Mac. It records speed
and approximate process memory under `projects/local-audio/analysis/benchmarks/`.
This does not publish a new website room.

The direct CLI is also retained:

```bash
python3 projects/local-audio/analysis/analysis.py "/path/to/song.wav"
```

Options include `--mode quick`, `--analysis-only` for a valid cache,
`--precision fp32`, and `--force` to regenerate stages. `npm run local:server`
starts the older local tool API. `npm run server` starts the current MVSEP API.

## Pipeline and files

Thorough separates six groups, then drum parts and lead/backing vocals, producing
twelve display parts. Quick's older CLI uses a smaller four-group model. The
drum stage stays full precision; supported RoFormer devices can use float16.
The lab deliberately keeps its own full-precision evaluation settings.

Keep `projects/local-audio/analysis/models/` and `separated/`: validated caches
depend on input/model/settings/version and complete output hashes. Changed or
partial stages are regenerated. Near-silent vocals can skip the vocal model
after checking the entire track. Outputs go to `projects/local-audio/output/`,
separate from the website demo. Files stay local and are ignored by Git.

Local results do not validate the hosted provider or automatically update a
built Netlify site. A public Mac worker remains a future proposal in
services and costs.

Checks: `npm run test:python`, `npm run test:lab`, and the relevant local JS
tests. A changed analysis display should also use retained reference examples.
