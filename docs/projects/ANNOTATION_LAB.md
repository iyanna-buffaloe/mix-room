# The local listening-label tool

The annotation lab helps you mark when a separated sound is genuine, bleed,
or uncertain. It runs locally, uses no MVSEP credits, and does not change the
public website or automatically train a model.

## Start

From `mix-room`, run `npm run lab` and open **http://127.0.0.1:3002**.
Keep the terminal open; Ctrl+C stops it. You do not need Vite or the website API.
This Mac already has the Python/model setup. For a new machine, use
[offline audio setup](LOCAL_AUDIO.md). The lab needs Python 3.11+ and FFmpeg.

## Label a song

1. Add files, then choose Quick six instruments, six-part drums, or vocals.
   A batch can hold up to thirty files under 1 GB each.
2. If a source is already isolated drums/vocals, select that option to skip
   the first separation stage. Songs process one at a time.
3. Select a stem. Its player, waveform, and own label table load together.
   Reference-mix buttons do not change which stem you are labeling.
4. Drag a time range or enter start/end seconds, then mark Genuine, Bleed/absent,
   or Uncertain. Unlabeled audio means unknown, not absent.
5. Review conflicting/overlapping labels before using them. Export saved JSON/CSV.

Fit waveform enlarges the picture of a quiet stem; it does not amplify playback.
The waveform is amplitude, not a frequency view. Click to seek or use arrow keys
for five seconds; Shift+arrow moves thirty seconds.

Labels save to disk and survive reload/restart. A conflicting edit in another
tab requires exporting the draft and reloading. Cancel stops the worker; retry
reuses validated stages. A restart marks unfinished work interrupted rather
than silently resuming it.

## Files to preserve

Generated audio, labels, waveforms, and job records live in
`projects/annotation-lab/data/`. Cached model outputs are there too. Model weights
live in `projects/local-audio/analysis/models/`. These folders are Git-ignored;
back them up separately. JSON exports contain provenance and relative audio
paths, but do not replace the audio files themselves.

Job records also contain absolute local paths. Restore to the same location or
migrate those paths if moving the data. `LAB_DATA_DIR` can choose a private
alternative; ignore it in Git if it is inside a repository. `LAB_PORT` changes
the port. There is no destructive delete-dataset button.

## Technical reference

Quick uses BS-Roformer SW; drums then use MDX23C DrumSep; vocals use the MelBand
karaoke splitter. The lab's Quick differs from the older four-part offline CLI.
Inputs become aligned stereo 44.1 kHz WAV. The lab uses full precision, batch
size one, no amplification, and peak threshold 1.0, with no display bleed rules.

Records retain source/output/model/configuration hashes, versions, device, and
settings. Cache reuse validates those details and outputs. Bump `PIPELINE_VERSION`
in `worker.py` if decoding/separation meaning changes; labeling alone needs no
new inference. Reserve whole songs for later evaluation.

`npm run test:lab` checks queue, labels, cancellation, persistence, export, and
waveform behavior using fixtures. Earlier real local model smoke checks proved
the tool flow, not musical accuracy.
