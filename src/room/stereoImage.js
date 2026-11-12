// Stereo spread is an estimate from channel independence and channel energy,
// not a physical source measurement. Correlated dual mono stays narrow even
// when panned; negative correlation must not collapse into apparent mono.
export function stereoWidth(leftPower, rightPower, correlation) {
  const total = leftPower + rightPower
  if (!(total > 1e-16)) return 0
  const balance = 2 * Math.sqrt(Math.max(0, leftPower * rightPower)) / total
  return Math.min(1, balance * Math.sqrt(1 - Math.max(0, Math.min(1, correlation))))
}

// 200 ms overlapping windows stabilize bass and reverb measurements. Rolling
// moments keep the work linear in song length instead of rereading each window.
export function measureStereoFrames(left, right, sampleRate, times) {
  const half = Math.round(sampleRate * 0.1)
  const widths = [], correlations = []
  let start = 0, end = 0, sumL = 0, sumR = 0, ll = 0, rr = 0, lr = 0
  const add = (index, sign) => {
    const l = left[index], r = right[index]
    sumL += sign * l; sumR += sign * r
    ll += sign * l * l; rr += sign * r * r; lr += sign * l * r
  }
  for (const time of times) {
    const center = Math.round(time * sampleRate)
    const nextStart = Math.max(0, center - half), nextEnd = Math.min(left.length, center + half)
    while (end < nextEnd) add(end++, 1)
    while (start < nextStart && start < end) add(start++, -1)
    const count = Math.max(1, end - start)
    const l = Math.max(0, ll / count - (sumL / count) ** 2)
    const r = Math.max(0, rr / count - (sumR / count) ** 2)
    const correlation = l > 1e-16 && r > 1e-16
      ? Math.max(-1, Math.min(1, (lr / count - sumL * sumR / count ** 2) / Math.sqrt(l * r))) : 1
    widths.push(stereoWidth(l, r, correlation)); correlations.push(correlation)
  }
  return { widths, correlations }
}

// Presentation controls: the original room used pan * 7 and 1.8 units between
// nearby instruments. These offsets are fixed for the whole song.
export const STEREO_LAYOUT = { panScale: 7, minDistance: 1.8 }

export function spaceInstruments(instruments, minDistance = STEREO_LAYOUT.minDistance) {
  const positions = instruments.map(instrument => [instrument.baseX, instrument.baseY, instrument.baseZ])
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const direction = positions[j].map((value, axis) => value - positions[i][axis])
      const distance = Math.hypot(...direction)
      if (distance >= minDistance) continue
      // Give exactly coincident instruments a deterministic direction too.
      const normal = distance > 0.001 ? direction.map(value => value / distance) : [1, 0, 0]
      const push = (minDistance - distance) / 2
      positions[i] = positions[i].map((value, axis) => value - normal[axis] * push)
      positions[j] = positions[j].map((value, axis) => value + normal[axis] * push)
    }
  }
  return instruments.map((instrument, index) => ({
    ...instrument, baseX: positions[index][0], baseY: positions[index][1], baseZ: positions[index][2],
  }))
}

export function stereoImageShape(pan = 0, width = 0, radius = 0.8, centerX) {
  const desiredX = Number.isFinite(centerX) ? centerX : (Number.isFinite(pan) ? pan : 0) * STEREO_LAYOUT.panScale
  const center = Math.max(-5 + radius, Math.min(5 - radius, desiredX))
  const spread = Math.max(0, Math.min(1, Number.isFinite(width) ? width : 0))
  // The center stays at its fixed layout position. Only the horizontal axis grows;
  // it stops at the nearer wall rather than moving the instrument inward.
  const horizontal = radius + (5 - Math.abs(center) - radius) * spread
  return { x: center, radii: [horizontal, radius, radius] }
}
