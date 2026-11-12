import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPanMotionProfile, PAN_MOTION, panMotionAt, panMotionX } from './panMotion.js'
import { stereoImageShape } from './stereoImage.js'
import { createFrameSampler } from '../export/videoTimeline.js'

const framesFor = (seconds, panAt, loudAt = () => 0.6, width = 0.04) => Array.from({ length: seconds * 10 + 1 }, (_, index) => {
  const t = index / 10
  return { t, loud: loudAt(t), pan: panAt(t), width }
})

test('NIN lead vocals qualify at 0.546 and snap at the late phrase without crossing the quiet gap', () => {
  const frames = JSON.parse(readFileSync(new URL('../demo/nin-1000000/lead_vocals_frames.json', import.meta.url)))
  const profile = buildPanMotionProfile(frames, 0.043)
  assert.equal(PAN_MOTION.minimumRange, 0.54)
  assert.equal(profile.range, 0.546)
  assert.equal(profile.enabled, true)
  assert.equal(profile.localWidth, 0.001)
  assert.deepEqual(profile.jumps, [{ t: 216.3, from: 0.002, pan: 0.539 }])
  for (let time = 200; time < 216.3; time += 0.1) assert.equal(panMotionAt(profile, time), 0.002)
  const sample = createFrameSampler(frames, profile)
  sample(216.2, 1 / 60)
  assert.equal(sample(216.3, 1 / 60).pan, 0.539)
  assert.equal(sample(120, 1 / 60).pan, 0.002)
  assert.equal(sample(225, 1 / 60).pan, 0.539)
  const disabled = { ...profile, enabled: false, anchors: [] }
  const fixed = createFrameSampler(frames, disabled)
  assert.equal(fixed(120, 1 / 60).pan, 0.043)
  assert.equal(fixed(225, 1 / 60).pan, 0.043)
  assert.equal(buildPanMotionProfile(framesFor(15, time => time < 5 ? 0 : 0.539)).enabled, false)
})

test('small fluctuations in a static or strongly panned instrument remain completely stationary', () => {
  for (const center of [-0.4, 0, 0.9]) {
    const frames = framesFor(15, t => center + Math.sin(t * 31) * 0.05)
    const profile = buildPanMotionProfile(frames, center)
    assert.equal(profile.enabled, false)
    const sample = createFrameSampler(frames, profile)
    for (let time = 0; time < 15; time += 1 / 30) assert.equal(sample(time, 1 / 30).pan, center)
  }
})

test('a sustained slow sweep is recognized and follows its changing position', () => {
  const profile = buildPanMotionProfile(framesFor(30, t => -0.8 + t / 30 * 1.6))
  assert.equal(profile.enabled, true)
  assert.ok(profile.range > 1.5)
  assert.ok(panMotionAt(profile, 1) < -0.65)
  assert.ok(Math.abs(panMotionAt(profile, 15)) < 0.1)
  assert.ok(panMotionAt(profile, 29) > 0.65)
  assert.equal(profile.jumps.length, 0)
})

test('a settled hard cut snaps at the new frame and never travels through the middle', () => {
  const profile = buildPanMotionProfile(framesFor(15, t => t < 5 ? -.8 : .8))
  assert.equal(profile.enabled, true)
  assert.equal(profile.jumps.length, 1)
  assert.equal(profile.jumps[0].t, 5)
  assert.equal(panMotionAt(profile, 4.999), -.8)
  assert.equal(panMotionAt(profile, 5), .8)
  for (const rate of [30, 60, 120]) {
    const render = createFrameSampler(framesFor(15, t => t < 5 ? -.8 : .8), profile)
    render(4.9, 1 / rate)
    assert.equal(render(5, 1 / rate).pan, .8)
    assert.equal(render(6, 1 / rate).pan, .8)
  }
})

test('a hard change after silence snaps at the new phrase, while an isolated spike is ignored', () => {
  const profile = buildPanMotionProfile(framesFor(12, t => t < 6 ? -.7 : .7, t => t < 3 || t >= 8 ? .6 : 0))
  const sample = createFrameSampler(framesFor(12, t => t < 6 ? -.7 : .7), profile)
  assert.equal(panMotionAt(profile, 7.9), -.7)
  sample(7.99, 1 / 60)
  assert.equal(sample(8, 1 / 60).pan, .7)
  assert.equal(buildPanMotionProfile(framesFor(20, t => t === 3 ? 1 : -.7), -.7).enabled, false)
})

test('moderate quiet-to-loud section cuts snap despite stereo texture, then hold still', () => {
  // Song 2 exposed this case: an already-qualified stem crosses much of the
  // room with a measured step below 0.55, and has modest intra-section jitter.
  const frames = framesFor(30, t => t < 4 ? -.34 : t < 10 ? -.24 : t < 20 ? .25 + .06 * Math.sin(t * 31) : -.23,
    t => t < 10 || t >= 20 ? .2 : .75)
  const profile = buildPanMotionProfile(frames)
  assert.equal(profile.enabled, true)
  assert.deepEqual(profile.jumps.map(jump => jump.t), [10, 20])
  const sample = createFrameSampler(frames, profile)
  sample(9.99, 1 / 60)
  assert.equal(sample(10, 1 / 60).pan, profile.jumps[0].pan)
  const settled = sample(10.1, 1 / 60).pan
  for (let t = 10.2; t < 20; t += .1) assert.equal(sample(t, 1 / 60).pan, settled)
  assert.equal(sample(20, 1 / 60).pan, profile.jumps[1].pan)
})

test('a real gradual sweep survives when another section has a hard cut', () => {
  const profile = buildPanMotionProfile(framesFor(30, t => t < 20 ? -.8 + t / 20 * 1.6 : -.8))
  assert.equal(profile.jumps.length, 1)
  assert.ok(panMotionAt(profile, 3) < -.5)
  assert.ok(Math.abs(panMotionAt(profile, 10)) < .15)
  assert.ok(panMotionAt(profile, 18) > .5)
  assert.equal(panMotionAt(profile, 20), -.8)
})

test('brief extreme spikes and large inaudible pan changes do not trigger motion', () => {
  const spikes = framesFor(20, t => t === 3 ? -1 : t === 15 ? 1 : 0)
  assert.equal(buildPanMotionProfile(spikes).enabled, false)
  const tails = framesFor(20, t => t >= 5 && t <= 10 ? Math.sin(t * 23) : -0.4, t => t >= 5 && t <= 10 ? 0.01 : 0.6)
  assert.equal(buildPanMotionProfile(tails, -0.4).enabled, false)
  const jitter = framesFor(20, t => Math.sin(t * 31) * 0.9)
  assert.equal(buildPanMotionProfile(jitter).enabled, false)
})

test('separate sustained phrases can move while silent gaps hold the previous position', () => {
  const frames = framesFor(12, t => t < 6 ? -0.7 : 0.7, t => t < 3 || t >= 8 ? 0.6 : 0)
  const profile = buildPanMotionProfile(frames)
  assert.equal(profile.enabled, true)
  assert.ok(panMotionAt(profile, 2) < -0.6)
  assert.equal(panMotionAt(profile, 5), panMotionAt(profile, 2))
  assert.ok(panMotionAt(profile, 9) > 0.6)
})

test('two brief settled regions need enough total audible evidence before enabling motion', () => {
  const frames = framesFor(10, t => t < 5 ? -0.8 : 0.8, t => t <= 0.7 || (t >= 8 && t <= 8.7) ? 0.6 : 0)
  const profile = buildPanMotionProfile(frames)
  assert.ok(profile.range > PAN_MOTION.minimumRange)
  assert.ok(profile.stableSeconds < PAN_MOTION.minimumTotalStableSeconds)
  assert.equal(profile.enabled, false)
})

test('moving sources use a single audible local width and preserve the oval while traveling', () => {
  const frames = framesFor(12, t => t < 6 ? -0.7 : 0.7)
  const profile = buildPanMotionProfile(frames)
  assert.equal(profile.localWidth, 0.04)
  const shape = stereoImageShape(0, profile.localWidth, 0.8, 0.2)
  const original = structuredClone(shape)
  const left = panMotionX(shape, profile, -0.7), right = panMotionX(shape, profile, 0.7)
  assert.ok(left < -3 && right > 3)
  assert.ok(left - shape.radii[0] >= -5 - 1e-10)
  assert.ok(right + shape.radii[0] <= 5 + 1e-10)
  assert.deepEqual(shape, original)
  assert.equal(panMotionX(shape, { enabled: false }, 1), shape.x)
})

test('live and video motion agree, settle without overshoot, and seek to the correct side', () => {
  const frames = framesFor(15, t => t < 5 ? -0.75 : 0.75)
  const profile = buildPanMotionProfile(frames)
  const live = createFrameSampler(frames, profile), exportSample = createFrameSampler(frames, profile)
  for (let time = 0; time < 15; time += 1 / 30) assert.deepEqual(live(time, 1 / 30), exportSample(time, 1 / 30))
  assert.ok(live(1, 1 / 30).pan < -0.7)
  assert.ok(live(10, 1 / 30).pan > 0.7)
  const first = createFrameSampler(frames, profile)
  assert.equal(first(10, 1 / 30).pan, panMotionAt(profile, 10))
})

test('motion smoothing is consistent at different refresh rates', () => {
  const frames = framesFor(15, t => t < 5 ? -0.75 : 0.75)
  const profile = buildPanMotionProfile(frames)
  const simulate = rate => {
    const sample = createFrameSampler(frames, profile)
    sample(4, 1 / rate)
    let result
    for (let index = 1; index <= rate; index++) result = sample(5 + index / rate, 1 / rate)
    return result.pan
  }
  assert.ok(Math.abs(simulate(30) - simulate(60)) < 0.015)
  assert.ok(Math.abs(simulate(60) - simulate(120)) < 0.015)
  assert.ok(PAN_MOTION.responseSeconds > 0)
})

test('missing pan data stays static and legacy frames can still qualify without width data', () => {
  assert.equal(buildPanMotionProfile([]).enabled, false)
  assert.equal(buildPanMotionProfile([{ t: 0, loud: 1 }]).enabled, false)
  const frames = framesFor(15, t => t < 5 ? -0.75 : 0.75).map(({ width: _width, ...frame }) => frame)
  const profile = buildPanMotionProfile(frames)
  assert.equal(profile.enabled, true)
  assert.equal(profile.localWidth, undefined)
})
