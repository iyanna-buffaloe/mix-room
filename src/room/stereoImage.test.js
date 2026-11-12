import test from 'node:test'
import assert from 'node:assert/strict'
import { measureStem, finishAnalysis, SAMPLE_RATE } from '../audio/stemAnalysis.js'
import { measureStereoFrames, spaceInstruments, stereoImageShape } from './stereoImage.js'
import { createFrameSampler } from '../export/videoTimeline.js'

const tone = (frequency, seconds = 1, gain = 0.2) => Float32Array.from({ length: SAMPLE_RATE * seconds }, (_, i) => gain * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE))

test('dual mono, panned mono, hard panning, and silence remain narrow', () => {
  const left = tone(220)
  for (const right of [left, tone(220, 1, 0.05), new Float32Array(left.length)]) {
    const result = measureStem([left, right], SAMPLE_RATE, 'guitar')
    assert.ok(result.width < 0.001)
    assert.ok(result.widths.every(width => width < 0.001))
  }
  assert.equal(measureStem([new Float32Array(5000)], SAMPLE_RATE, 'guitar').width, 0)
})

test('independent channels widen while weak opposite-channel spill does not occupy the room', () => {
  const wide = measureStem([tone(220), tone(880)], SAMPLE_RATE, 'guitar')
  const spill = measureStem([tone(220), tone(880, 1, 0.002)], SAMPLE_RATE, 'guitar')
  assert.ok(wide.width > 0.99)
  assert.ok(spill.width < 0.025)
  assert.ok(wide.widths[5] > 0.99)
})

test('opposite polarity stays audible and wide instead of masquerading as centered mono', () => {
  const left = tone(440), right = left.map(sample => -sample)
  const result = measureStem([left, right], SAMPLE_RATE, 'guitar')
  assert.equal(result.width, 1); assert.equal(result.correlation, -1)
  assert.ok(Math.abs(result.freq - 440 / 8000) < 0.002)
})

test('width follows stereo changes locally rather than spreading mono sections across the room', () => {
  const left = tone(220, 3), right = new Float32Array(left)
  right.set(tone(880), SAMPLE_RATE)
  const result = measureStem([left, right], SAMPLE_RATE, 'guitar')
  const frames = finishAnalysis([{ key: 'guitar', label: 'Guitar', fileName: 'g.wav', measurement: result }], 'Song').framesByKey.guitar
  assert.equal(frames[5].width, 0); assert.ok(frames[15].width > 0.99); assert.equal(frames[25].width, 0)
  const quieter = measureStereoFrames(left.map(x => x / 2), right.map(x => x / 2), SAMPLE_RATE, result.times)
  result.widths.forEach((width, index) => assert.ok(Math.abs(width - quieter.widths[index]) < 1e-6))
})

test('ovals expand horizontally, keep measured centers, and fit within the stereo room', () => {
  for (const pan of [-1, -0.7, 0, 0.7, 1]) {
    const mono = stereoImageShape(pan, 0), wide = stereoImageShape(pan, 1)
    assert.equal(mono.x, wide.x)
    assert.deepEqual(mono.radii, [0.8, 0.8, 0.8])
    assert.deepEqual(wide.radii.slice(1), mono.radii.slice(1))
    assert.ok(wide.x - wide.radii[0] >= -5 - 1e-10)
    assert.ok(wide.x + wide.radii[0] <= 5 + 1e-10)
  }
  assert.equal(stereoImageShape(0, 1).radii[0], 5)
})

test('live and export sampling agree, retain legacy widths, and recover stereo position on seeks', () => {
  const frames = [{ t: 0, loud: 1, pan: -1, width: 0 }, { t: 1, loud: 1, pan: 0.5, width: 1 }]
  const live = createFrameSampler(frames), video = createFrameSampler(frames)
  for (let time = 0; time < 2; time += 1 / 30) assert.deepEqual(live(time, 1 / 30), video(time, 1 / 30))
  const seek = live(0, 1 / 30)
  assert.equal(seek.pan, -1); assert.equal(seek.width, 0)
  assert.equal(createFrameSampler([{ t: 0, loud: 1, pan: 0.7 }])(0, 0.1).width, undefined)
})

test('the earlier pan scale spreads sounds out and respects fixed spacing in the oval renderer', () => {
  assert.equal(stereoImageShape(0.5, 0).x, 3.5)
  assert.equal(stereoImageShape(-0.5, 0).x, -3.5)
  assert.equal(stereoImageShape(1, 0).x, 4.2)
  const input = [
    { key: 'kick', pan: 0, baseX: 0, baseY: 0, baseZ: 1 },
    { key: 'snare', pan: 0, baseX: 0, baseY: 0.2, baseZ: 1 },
  ]
  const spaced = spaceInstruments(input)
  assert.ok(spaced[1].baseY - spaced[0].baseY >= 1.8 - 1e-10)
  assert.equal(input[0].baseY, 0); assert.equal(spaced[0].pan, 0)
  const coincident = spaceInstruments([input[0], { ...input[0], key: 'bass' }])
  assert.equal(stereoImageShape(0, 0.5, 0.8, coincident[0].baseX).x, coincident[0].baseX)
  assert.deepEqual(spaceInstruments(input), spaced)
})
