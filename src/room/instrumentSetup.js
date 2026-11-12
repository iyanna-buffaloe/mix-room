import { spaceInstruments, stereoImageShape } from './stereoImage.js'
import { buildPanMotionProfile } from './panMotion.js'
import { layoutInstrumentDepth } from './instrumentDepth.js'

// Turn the song's instrument details and audio measurements into starting
// labels, colors, shapes and positions. This file calculates values; it does
// not remember the user's choices. getFrames(key) supplies an instrument's
// measurements, or an empty list when there are none.

// ============================================================
// STATIC FEATURE HELPERS
// ============================================================
//
// Choose starting height and depth from the audio measurements. The frequency
// score runs from 0 to 1 (lower to higher sounds); it is not a value in Hertz.
// Another layout step adjusts each instrument's final depth afterward.

function freqToY(freq, roomHeight = 2.5) {
  return (freq - 0.5) * 2 * roomHeight
}

function loudnessToZ(loud, roomDepth = 3) {
  return loud * roomDepth
}

// ============================================================
// ROOM BOUNDS
// ============================================================
//
// Keep bubbles inside the room after spacing them out. Leave enough room for
// their edges beside walls, the floor and ceiling. The front limit keeps them
// out of the camera rather than against a wall, so it uses a different margin.

export function clampToRoom(position, radius) {
  const [x, y, z] = position

  const ROOM_HALF_WIDTH = 5
  const ROOM_FLOOR_Y = -3
  const ROOM_CEILING_Y = 2
  const ROOM_BACK_Z = -5
  const ROOM_FRONT_Z = 2.5

  return [
    Math.max(-ROOM_HALF_WIDTH + radius, Math.min(ROOM_HALF_WIDTH - radius, x)),
    Math.max(ROOM_FLOOR_Y + radius, Math.min(ROOM_CEILING_Y - radius, y)),
    Math.max(ROOM_BACK_Z + radius, Math.min(ROOM_FRONT_Z, z)),
  ]
}

// ============================================================
// PER-STEM AVERAGES
// ============================================================
//
// Work out average left/right position and activity from an instrument's
// measurements. Louder moments count more toward its left/right position, so
// quiet endings do not pull it around. Without measurements, use a centered
// position and a middle activity value to choose a starting depth.

function getAvgPan(frames) {
  if (!frames.length) return 0

  let weightedSum = 0
  let totalWeight = 0

  for (const f of frames) {
    weightedSum += f.pan * f.loud
    totalWeight += f.loud
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

function getAvgLoudness(frames) {
  if (!frames.length) return 0.5
  const sum = frames.reduce((acc, f) => acc + f.loud, 0)
  return sum / frames.length
}

// Keep the color order even when a silent instrument will not be shown.
const INSTRUMENT_COLORS = [
  '#b65f40', // terracotta
  '#43876a', // forest green
  '#3f74ad', // blue
  '#b68a35', // ochre
  '#80529d', // violet
  '#aa4871', // rose
  '#397f87', // teal
  '#a74c3c', // brick red
  '#666ba6', // indigo
  '#7d8738', // olive
]

// Use the saved active/silent flag when present; older mixes use this activity cutoff.
const SILENCE_THRESHOLD = 0.05

// ============================================================
// PREPARE A MIX FOR DISPLAY
// ============================================================
//
// Prepare each instrument for the room without changing its saved details or
// audio measurements. First prepare the values, then remove silent parts, space
// the remaining bubbles and set their depth. Keep that order: changing it can
// change which instruments appear or where they sit.

export function makeInstruments(songData, getFrames, labelOverrides = {}) {
  return layoutInstrumentDepth(spaceInstruments(songData.instruments
    .map((meta, i) => {
      const frames = getFrames(meta.key)
      const pan = meta.pan ?? getAvgPan(frames)
      const panMotion = buildPanMotionProfile(frames, pan)
      const avgLoudness = getAvgLoudness(frames)
      const labelOverride = labelOverrides[meta.key]
      return {
        key: meta.key,
        label: labelOverride?.text ?? (meta.label ?? meta.key.replaceAll('_', ' ')).replace(/\s+/g, '\n').toUpperCase(),
        labelScale: labelOverride?.scale ?? 1,
        displayName: meta.label ?? (meta.key === 'hihat' ? 'hi-hat' : meta.key.replaceAll('_', ' ')),
        color: INSTRUMENT_COLORS[i % INSTRUMENT_COLORS.length],
        radius: 0.8,

        // A narrow sound moving left/right can look wide when averaged over the
        // whole song. Use its width in short sections to keep the oval's shape steady.
        width: panMotion.enabled ? panMotion.localWidth ?? meta.width ?? 0 : meta.width ?? 0,
        pan, panMotion,
        baseX: stereoImageShape(pan, meta.width).x,
        baseY: freqToY(meta.freq),
        baseZ: loudnessToZ(avgLoudness),
        avgLoudness,
        rms: meta.rms,

        // Decide whether sound is present, separately from how loud it is beside other parts.
        active: meta.active ?? frames.some(frame => frame.loud > SILENCE_THRESHOLD),
      }
    })
    .filter(inst => inst.active)))
}

// ============================================================
// FRESH VISIBILITY CHOICES
// ============================================================
//
// Start a new mix or a view reset with every instrument shown. Renaming the
// current mix keeps its mixId, so it keeps the user's show/hide choices too.

export function initialInstrumentVisibility(instruments) {
  return Object.fromEntries(instruments.map(instrument => [instrument.key, true]))
}
