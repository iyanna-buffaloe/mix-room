# Player, phone layout, and demo

Keep the room and music stable while someone changes panels. A screen change
should not restart playback, discard selected stems, or lose pending names.

## The layout

The silver frame and blue controls follow the Media Player reference. Desktop
uses left navigation, a main workspace, and the player below. Upload/Account
can show the live room beside forms. Phones use their available space for the
form, keep the header available, and scroll long content inside panels.

Current panels include Now playing, Visible instruments, Upload tracks, My mixes,
Editor, How it works, and Preferences. Room style is in Preferences. Mix Data
was replaced by Editor; older screenshots may show the earlier navigation.
Archive remains a top mode choice. GitHub is a small external link outside the frame.

Keep close, Cancel, Save, Download, and Expand reachable on short screens.
Progress or failure uses the full room; the opening prompt must not cover it.
The room/audio stay mounted while phone forms temporarily hide playback controls
above the keyboard. Keep phone fields at least 16 px and close targets 44 px.

## Playback and fullscreen

Playback provides play/pause, seek, time, and a volume popover. Fullscreen keeps
the same audio and time. Its bottom-center controls stay outside the rotating
scene and fade after 2.5 idle seconds. Mouse/touch/keyboard input reveals them;
dragging holds them visible and hidden controls leave the focus order.

On phones, use native fullscreen/orientation support where available, with a
window-filling fallback. That fallback cannot remove browser-owned bars. Home
Screen web-app use is available for hands-on checking; it is not offline support.
Physical Safari/phone/keyboard behavior remains in the manual plan.

## Preferences and export

Sensitivity, panning, label visibility/size, looping, transparency, and room
palette stay in this browser. Reset view keeps the song and playback time.
Light, Dark, and Traditional palettes also apply to exports.

Export has its own fixed camera at 1246 × 606, 30 fps, with an 8 Mbps video
target and 192 kbps audio. Encoders can use less on simple scenes. MP4 is used
where supported, otherwise WebM. The screen's aspect ratio must not change
export framing. Sign-in is required; cloud saving remains optional.

## Demon Seed demo

The bundled Nine Inch Nails example (The Slip, Creative Commons
BY-NC-SA) contains thirteen precomputed parts from the original multitrack
stems. Its duration is about 306 seconds. Audio and its license notice are in
`public/audio/nin-demon-seed.mp3` and `nin-demon-seed-LICENSE.txt`; analysis is
in `src/demo/nin-demon-seed/`. Opening it uses no separation job or credit.
The earlier Nice Shoes demo was removed on November 12, 2026 because its
commercial recording could not be redistributed.

A fresh visit shows the opening prompt. Loading the demo is explicit and asks
before leaving unsaved work. Demo selection does not restore after refresh.
The original demo result provenance is preserved in the recovery archive.

## Where to adjust it

Page colors and sizes start in `src/App.css`; global viewport/font rules are
in `src/index.css`. Room palettes are in `src/room/roomStyles.js`. View defaults
and validation are in `src/config/viewSettings.js`. `RoomViewport.jsx` and
`roomViewport.js` control fitting; `useViewportSize.js` follows keyboard space.

See screen checks and
results before repeating completed checks.
