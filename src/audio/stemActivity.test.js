import test from 'node:test'
import assert from 'node:assert/strict'
import { measureStem, finishAnalysis, suppressKickBleed, SAMPLE_RATE } from './stemAnalysis.js'
import { signalActivity } from './stemActivity.js'
import { getBubbleVisibility } from '../room/audioVisuals.js'

const tone = (frequency, gain, seconds = 1) => Float32Array.from({ length: Math.round(SAMPLE_RATE * seconds) }, (_, i) => gain * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE))
const stem = (key, audio) => ({ key, label: key, fileName: `${key}.wav`, measurement: measureStem([audio], SAMPLE_RATE, key) })

test('a short event cannot make the PCM16 one-bit background floor visible for the entire song', () => {
  const audio = Float32Array.from({ length: SAMPLE_RATE * 4 }, (_, i) => i % 2 ? -1 / 32768 : 0)
  audio.set(tone(90, 0.15, 0.06), SAMPLE_RATE * 2)
  const result = finishAnalysis([stem('drums', audio), stem('guitar', tone(440, .2, 4))], 'One transient')
  assert.equal(result.metadata.instruments[0].active, true)
  const frames = result.framesByKey.drums
  assert.ok(frames.some(f => f.t >= 2 && f.t <= 2.2 && getBubbleVisibility(f.loud) === 1))
  assert.ok(frames.filter(f => f.t < 1.8 || f.t > 2.3).every(f => f.loud === 0))
})

test('quiet genuine sources remain visible in context without relying on an instrument-specific label', () => {
  const quiet = tone(440, .002)
  for (const key of ['guitar', 'toms', 'toms_2', 'my_quiet_recording']) {
    const result = finishAnalysis([stem('vocals', tone(220, .2)), stem(key, quiet)], 'Quiet part')
    assert.equal(result.metadata.instruments[1].active, true)
    assert.ok(result.framesByKey[key].filter(f => f.t > .1 && f.t < .9).every(f => getBubbleVisibility(f.loud) === 1))
  }
  const floorOnly = finishAnalysis([stem('guitar', tone(440, .00001))], 'Noise floor')
  assert.equal(floorOnly.metadata.instruments[0].active, false)
  assert.ok(floorOnly.framesByKey.guitar.every(f => f.loud === 0))
})

test('a few weak residual events do not qualify like a sustained soft part', () => {
  const sparse = new Float32Array(SAMPLE_RATE * 4)
  sparse.set(tone(440, .002, .06), SAMPLE_RATE * 2)
  const rejected = finishAnalysis([stem('drums', sparse)], 'Weak isolated residue')
  assert.equal(rejected.metadata.instruments[0].active, false)
  assert.ok(rejected.framesByKey.drums.every(f => f.loud === 0))
  const sustained = finishAnalysis([stem('guitar', tone(440, .002, 4))], 'Persistent quiet source')
  assert.equal(sustained.metadata.instruments[0].active, true)
  assert.ok(sustained.framesByKey.guitar.some(f => getBubbleVisibility(f.loud) === 1))
})

test('absolute floor fades smoothly and remains bounded for silence and nonfinite values', () => {
  const levels = [0, .00001, .0001, .00012, .00018, .00025, .00031623, .001, 1].map(signalActivity)
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b))
  assert.ok(levels.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
  assert.equal(signalActivity(NaN), 0)
  assert.equal(signalActivity(-Infinity), 0)
})

test('the tom guard retains a brief real event without promoting an independent low noise bed', () => {
  let seed = 17
  const tom = Float32Array.from({ length: SAMPLE_RATE * 4 }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return (seed / 2 ** 32 * 2 - 1) * .0007
  })
  tom.set(tone(350, .1, .06), SAMPLE_RATE * 2)
  const kick = tone(110, .2, 4), measured = stem('toms', tom)
  suppressKickBleed(tom, kick, measured.measurement, SAMPLE_RATE)
  const result = finishAnalysis([stem('kick', kick), measured], 'Tom and residual noise')
  assert.ok(result.framesByKey.toms.some(f => f.t >= 2 && f.t <= 2.2 && getBubbleVisibility(f.loud) === 1))
  assert.ok(result.framesByKey.toms.filter(f => f.t < 1.8 || f.t > 2.3).every(f => f.loud === 0))
})

test('metadata retains measured stereo RMS independently of normalized activity', () => {
  const left = tone(440, .2), right = tone(440, .05)
  const measurement = measureStem([left, right], SAMPLE_RATE, 'guitar')
  const expected = Math.sqrt((.2 ** 2 + .05 ** 2) / 4)
  assert.ok(Math.abs(measurement.rms - expected) < 1e-7)
  const result = finishAnalysis([{ key: 'guitar', label: 'Guitar', fileName: 'guitar.wav', measurement }], 'Measured level')
  assert.equal(result.metadata.instruments[0].rms, measurement.rms)
})

test('unequal stem tails use the same playback duration for relative RMS depth', () => {
  const short = stem('intro', tone(440, .2, 1))
  const long = stem('guitar', tone(440, .2, 4))
  const result = finishAnalysis([short, long], 'Different tails')
  assert.ok(Math.abs(result.metadata.instruments[0].rms - short.measurement.rms / 2) < 1e-7)
  assert.equal(result.metadata.instruments[1].rms, long.measurement.rms)
  assert.equal(result.framesByKey.intro.at(-1).t, 1)
  assert.equal(result.framesByKey.guitar.at(-1).t, 4)
})
