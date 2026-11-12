import { stereoImageShape } from './stereoImage.js'

// Presentation depth, relative to this mix. Measurements are kept separately.
// A slightly restrained depth range keeps the layers distinct without
// pushing them to the extremes of the room.
export const DEPTH_LAYOUT = Object.freeze({ back: -3.75, front: 1.25, gap: 0.18 })

export function layoutInstrumentDepth(instruments) {
  if (!instruments.length) return []
  // Compare measured whole-song RMS when every part has it. Older saved mixes
  // and the bundled demo retain one consistent activity-based fallback; never
  // mix raw RMS amplitudes with normalized activity percentages in one layout.
  const measured = instruments.every(instrument => Number.isFinite(instrument.rms) && instrument.rms >= 0)
  const level = instrument => {
    const value = measured ? instrument.rms : instrument.avgLoudness
    return Number.isFinite(value) ? Math.max(0, value) : 0
  }
  const sorted = [...instruments].sort((a, b) => level(a) - level(b) || a.key.localeCompare(b.key))
  const quietest = level(sorted[0]), loudest = level(sorted.at(-1))
  const span = DEPTH_LAYOUT.front - DEPTH_LAYOUT.back
  const desired = sorted.map(instrument => loudest - quietest > 1e-6
    ? DEPTH_LAYOUT.back + span * (level(instrument) - quietest) / (loudest - quietest)
    : 0)
  const shapes = sorted.map(instrument => stereoImageShape(instrument.pan, instrument.width, instrument.radius, instrument.baseX))
  const heights = sorted.map(instrument => {
    const radius = instrument.radius ?? 0.8
    return Math.max(-3 + radius, Math.min(2 - radius, instrument.baseY))
  })
  const depths = [...desired]
  for (let j = 1; j < sorted.length; j++) {
    // Preserve loudness ordering even when neighboring shapes don't overlap.
    depths[j] = Math.max(depths[j], depths[j - 1])
    for (let i = 0; i < j; i++) {
      const horizontal = shapes[i].radii[0] + shapes[j].radii[0]
      const vertical = (sorted[i].radius ?? 0.8) + (sorted[j].radius ?? 0.8)
      const overlap = ((shapes[j].x - shapes[i].x) / horizontal) ** 2
        + ((heights[j] - heights[i]) / vertical) ** 2
      if (overlap >= 1) continue
      const separation = vertical * Math.sqrt(1 - overlap) + DEPTH_LAYOUT.gap
      depths[j] = Math.max(depths[j], depths[i] + separation)
    }
  }
  const extent = depths.at(-1) - depths[0]
  if (extent > span) {
    // Crowded mixes cannot always fit completely separate shapes. Compress
    // consistently rather than clipping, crossing, or jumping during playback.
    const start = depths[0]
    for (let i = 0; i < depths.length; i++) depths[i] = DEPTH_LAYOUT.back + (depths[i] - start) * span / extent
  } else {
    const drift = depths.reduce((sum, value, i) => sum + value - desired[i], 0) / depths.length
    const shift = Math.max(depths.at(-1) - DEPTH_LAYOUT.front, Math.min(depths[0] - DEPTH_LAYOUT.back, drift))
    for (let i = 0; i < depths.length; i++) depths[i] -= shift
  }
  const byKey = new Map(sorted.map((instrument, i) => [instrument.key, depths[i]]))
  return instruments.map(instrument => ({ ...instrument, baseZ: Math.max(DEPTH_LAYOUT.back, Math.min(DEPTH_LAYOUT.front, byKey.get(instrument.key))) }))
}
