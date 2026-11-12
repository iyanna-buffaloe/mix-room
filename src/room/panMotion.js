// Pan is -1 (left) to +1 (right). Keep all motion thresholds here so the
// behavior can be tuned without touching the scene or video exporter.
export const PAN_MOTION = {
  audibleFloor: 0.12,
  windowSeconds: 0.8,
  minimumSamples: 4,
  maximumLocalJitter: 0.12,
  minimumCoherentFraction: 0.8,
  minimumStableSeconds: 0.6,
  minimumTotalStableSeconds: 2,
  minimumRange: 0.54,
  deadband: 0.08,
  maximumInterpolationGap: 0.35,
  responseSeconds: 0.45,
  minimumJump: 0.28,
  minimumRawJump: 0.18,
  jumpConfirmationSeconds: 0.8,
  settledRegionRange: 0.28,
  settleTolerance: 0.003,
}

const clampPan = pan => Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function localWidth(frames) {
  const values = frames.filter(frame => Number.isFinite(frame.width)).map(frame => ({ width: Math.max(0, Math.min(1, frame.width)), weight: frame.loud ** 2 }))
  if (!values.length) return undefined
  values.sort((a, b) => a.width - b.width)
  const midpoint = values.reduce((sum, value) => sum + value.weight, 0) / 2
  let accumulated = 0
  return values.find(value => { accumulated += value.weight; return accumulated >= midpoint })?.width
}

export function buildPanMotionProfile(frames, referencePan = 0) {
  const audible = frames.filter(frame => Number.isFinite(frame.t) && Number.isFinite(frame.pan) && frame.loud >= PAN_MOTION.audibleFloor)
  const profile = { enabled: false, referencePan: clampPan(referencePan), range: 0, stableSeconds: 0, anchors: [], jumps: [], localWidth: localWidth(audible) }
  if (audible.length < PAN_MOTION.minimumSamples) return profile
  const hops = frames.slice(1).map((frame, i) => frame.t - frames[i].t).filter(hop => hop > 0 && hop <= 0.5)
  const hop = hops.length ? median(hops) : 0.1
  const candidates = []
  let start = 0, end = 0
  for (const frame of audible) {
    while (audible[start]?.t < frame.t - PAN_MOTION.windowSeconds / 2) start++
    while (end < audible.length && audible[end].t <= frame.t + PAN_MOTION.windowSeconds / 2) end++
    const window = audible.slice(start, end)
    if (window.length < PAN_MOTION.minimumSamples) continue
    const pan = median(window.map(point => clampPan(point.pan)))
    const jitter = median(window.map(point => Math.abs(clampPan(point.pan) - pan)))
    const coherent = window.filter(point => Math.abs(clampPan(point.pan) - pan) <= PAN_MOTION.maximumLocalJitter).length / window.length
    if (jitter <= PAN_MOTION.maximumLocalJitter && coherent >= PAN_MOTION.minimumCoherentFraction) candidates.push({ t: frame.t, pan })
  }

  // A large one-frame spike or a quiet reverberant tail is not a pan move.
  // Require sustained, locally coherent positions before comparing their range.
  let run = []
  const acceptRun = () => {
    if (!run.length) return
    const duration = run.at(-1).t - run[0].t + hop
    if (duration + 1e-9 >= PAN_MOTION.minimumStableSeconds) {
      profile.anchors.push(...run)
      profile.stableSeconds += duration
    }
    run = []
  }
  for (const point of candidates) {
    if (run.length && point.t - run.at(-1).t > hop * 2.5) acceptRun()
    run.push(point)
  }
  acceptRun()
  if (!profile.anchors.length) return profile
  const pans = profile.anchors.map(point => point.pan)
  profile.range = Math.max(...pans) - Math.min(...pans)
  profile.enabled = profile.range >= PAN_MOTION.minimumRange && profile.stableSeconds >= PAN_MOTION.minimumTotalStableSeconds
  if (!profile.enabled) { profile.anchors = []; return profile }

  // Once a stem qualifies, retain a steady position through small fluctuations.
  let held = profile.anchors[0].pan
  profile.anchors = profile.anchors.map(point => {
    if (Math.abs(point.pan - held) >= PAN_MOTION.deadband) held = point.pan
    return { t: point.t, pan: held }
  })
  // Confirm an abrupt change against settled audio on both sides. The
  // centered coherence window otherwise delays a cut and turns it into a glide.
  for (let index = 1; index < audible.length; index++) {
    const point = audible[index], previous = audible[index - 1]
    if (Math.abs(point.pan - previous.pan) < PAN_MOTION.minimumRawJump) continue
    let left = index - 1, right = index
    while (left > 0 && audible[left - 1].t >= previous.t - PAN_MOTION.jumpConfirmationSeconds) left--
    while (right < audible.length && audible[right].t <= point.t + PAN_MOTION.jumpConfirmationSeconds) right++
    const before = audible.slice(left, index), after = audible.slice(index, right)
    if (before.length < PAN_MOTION.minimumSamples || after.length < PAN_MOTION.minimumSamples) continue
    const from = median(before.map(frame => clampPan(frame.pan))), to = median(after.map(frame => clampPan(frame.pan)))
    const coherent = (values, pan) => values.filter(frame => Math.abs(frame.pan - pan) <= PAN_MOTION.maximumLocalJitter).length / values.length >= PAN_MOTION.minimumCoherentFraction
    if (Math.abs(to - from) < PAN_MOTION.minimumJump || Math.abs(point.pan - to) > PAN_MOTION.maximumLocalJitter || !coherent(before, from) || !coherent(after, to)) continue
    profile.jumps.push({ t: point.t, from, pan: to })
    // Keep the old side until the actual new audible frame, then switch in
    // one step. Gaps stay still and do not invent a cross-room transition.
    profile.anchors = profile.anchors.filter(anchor => anchor.t < previous.t || anchor.t > point.t)
    profile.anchors.push({ t: previous.t, pan: from }, { t: point.t, pan: to, jump: true })
  }
  profile.anchors.sort((a, b) => a.t - b.t)
  // A section change is different from an automated pan. Collapse modest
  // variation inside each settled section, while preserving a genuine sweep's
  // broad range. This prevents stereo guitar texture from wandering on screen.
  if (profile.jumps.length) {
    const boundaries = [-Infinity, ...profile.jumps.map(jump => jump.t), Infinity]
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const region = profile.anchors.filter(point => point.t >= boundaries[index] && point.t < boundaries[index + 1])
      if (!region.length) continue
      const ordered = region.map(point => point.pan).sort((a, b) => a - b)
      const range = ordered[Math.floor((ordered.length - 1) * .9)] - ordered[Math.floor((ordered.length - 1) * .1)]
      if (range <= PAN_MOTION.settledRegionRange) {
        const pan = median(ordered)
        for (const point of region) point.pan = pan
      }
    }
    for (const jump of profile.jumps) {
      const index = profile.anchors.findIndex(point => point.jump && point.t === jump.t)
      jump.pan = profile.anchors[index].pan
      jump.from = profile.anchors[Math.max(0, index - 1)].pan
    }
  }
  return profile
}

export function panMotionAt(profile, time) {
  if (!profile?.enabled || !profile.anchors.length) return profile?.referencePan ?? 0
  const points = profile.anchors
  let low = 0, high = points.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (points[middle].t <= time) low = middle
    else high = middle - 1
  }
  const before = points[low], after = points[low + 1]
  if (!after || after.jump || time <= before.t || after.t - before.t > PAN_MOTION.maximumInterpolationGap) return before.pan
  const fraction = (time - before.t) / (after.t - before.t)
  return before.pan + fraction * (after.pan - before.pan)
}

export function crossedPanJump(profile, before, time) {
  return profile?.jumps?.some(jump => jump.t > before && jump.t <= time) ?? false
}

export function panMotionX(shape, profile, pan, panScale = 7) {
  if (!profile?.enabled) return shape.x
  const limit = Math.max(0, 5 - shape.radii[0])
  const desired = shape.x + (clampPan(pan) - profile.referencePan) * panScale
  return Math.max(-limit, Math.min(limit, desired))
}
