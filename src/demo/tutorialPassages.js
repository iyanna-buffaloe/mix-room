import { ACTIVITY_FLOOR } from '../room/audioVisuals.js'

// Analysis is sampled every 0.1s. Build whole passages rather than toggling a
// hole on every silent frame: bridge brief rests, but never bridge a departure
// of several seconds. This leaves the underlying bubble/audio untouched.
export const PASSAGE_GAP = 1.25
export function buildTutorialPassages(frames, { gap = PASSAGE_GAP, floor = ACTIVITY_FLOOR } = {}) {
  const passages = []
  let current
  for (const frame of frames) {
    if (!Number.isFinite(frame.t) || !Number.isFinite(frame.loud) || frame.loud <= floor) continue
    if (!current || frame.t - current.last > gap + .1 + 1e-6) {
      current = { start: frame.t, end: frame.t + .1, last: frame.t }
      passages.push(current)
    } else { current.last = frame.t; current.end = frame.t + .1 }
  }
  return passages.map(({ start, end }) => ({ start, end: Math.round(end * 1e6) / 1e6 }))
}
export function inTutorialPassage(passages, time) {
  return passages?.some(passage => time >= passage.start && time < passage.end) ?? false
}
