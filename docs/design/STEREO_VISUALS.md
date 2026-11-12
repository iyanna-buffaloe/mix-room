# What the sound shapes mean

The room is an estimate of the stereo image, inspired by David Gibson's
soundbox. It does not recover a real instrument's physical size or location.
One separated track may also contain several sounds or unwanted bleed.

## Reading the room

| Visual | Meaning |
| --- | --- |
| Left/right position | Balance of energy in the two audio channels |
| Oval width | How different the channels are, adjusted for their balance |
| Height | Average spectral brightness, not the musical note's pitch |
| Relative depth | Whole-song measured level compared with other parts |
| Visibility/brightness | Whether the measured activity is strong enough |

Positions and dimensions include spacing for readability. They are not a precise
measurement ruler. Phase-opposed channels can appear wide and may cancel in mono.
Older mixes without RMS level metadata use a consistent older depth fallback.
Reanalyzing stems applies the newer measurements; opening an old save does not.

## Why only some instruments move

Ordinary stereo texture should not make every ball wander. Motion needs strong,
sustained evidence of a pan change. Quiet gaps keep the last reliable position;
seeking jumps directly to the right point. The ball keeps fixed dimensions.
Live playback and video use the same motion profile.

Confirmed section changes snap, while genuine gradual sweeps glide. October 22
checks used Song 2's actual guitar changes at 16.4, 31.9, 46.5, 72.6, and 87.2
seconds. Labels travel with their own ball; neighboring labels keep their plan.

## Quiet sounds and bleed

An absolute quiet-signal floor prevents tiny residuals from becoming constantly
visible after normalization. Strong short events and sustained quiet material
can qualify. The conservative tom/kick guard reduces matching spill but can
also limit very soft real toms. It does not remove bleed from the audio.

October 24's activity fix covers the full timeline instead of leaving gaps
between sample windows. It retains the existing floor and tom policy.
Short-hit findings.

## Technical tuning reference

Start with the plain-language result above; use these settings only when tuning:

| File | Controls |
| --- | --- |
| `src/room/stereoImage.js` | Correlation/balance width, pan scale, spacing |
| `src/room/panMotion.js` | Whole-song motion qualification, cuts, smoothing |
| `src/room/instrumentDepth.js` | Relative loudness depth and overlap spacing |
| `src/room/fixedLabelLayout.js` | Stable per-mix label planning |
| `src/audio/stemAnalysis.js`, `stemActivity.js` | Activity coverage, level, presence, spill checks |
| `src/export/videoTimeline.js` | Shared playback/export sampling |

Recorded pan tuning: sustained range 0.55 on −1…+1, 0.6-second stable regions,
two seconds of evidence, 0.08 deadband, and 450 ms response. Section cuts use
0.18 raw steps with 0.8-second neighborhoods confirming 0.28 stable difference.
Read the current constants before changing them.

Recorded activity floor fades from −80 to −70 dBFS. Presence uses a −45 dBFS
strong window or sustained −70 dBFS material. RMS measures signal level; dBFS
expresses it relative to digital full scale. Keep quiet genuine sounds and
known bleed examples in any tuning comparison.

Stem findings explain the limits.
Label findings separate readability from audio accuracy.
