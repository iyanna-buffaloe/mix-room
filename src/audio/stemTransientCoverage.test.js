import test from 'node:test'
import assert from 'node:assert/strict'
import { measureStem, finishAnalysis, suppressKickBleed, SAMPLE_RATE } from './stemAnalysis.js'
import { getBubbleVisibility } from '../room/audioVisuals.js'

function burst(seconds, onset, duration = .02, amplitude = .25, frequency = 1800) {
  const audio = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const count = Math.round(duration * SAMPLE_RATE)
  const start = Math.round(onset * SAMPLE_RATE)
  for (let i = 0; i < count && start + i < audio.length; i++) {
    const envelope = .5 - .5 * Math.cos(2 * Math.PI * i / (count - 1))
    audio[start + i] = amplitude * envelope * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE)
  }
  return audio
}

const stem = (key, audio) => ({ key, label: key, fileName: `${key}.wav`, measurement: measureStem([audio], SAMPLE_RATE, key) })
const visible = frames => frames.some(frame => getBubbleVisibility(frame.loud) > 0)

test('short transients remain visible throughout the gaps between analysis timestamps', () => {
  for (const duration of [.005, .01, .02, .04, .08]) {
    for (let offsetMs = 0; offsetMs < 100; offsetMs += 5) {
      const measured = stem('percussion', burst(1, .2 + offsetMs / 1000, duration))
      const result = finishAnalysis([measured], 'Short hit')
      assert.equal(measured.measurement.active, true, `${duration}s burst at ${offsetMs}ms`)
      assert.ok(visible(result.framesByKey.percussion), `${duration}s burst at ${offsetMs}ms has no visible frame`)
      assert.ok(result.framesByKey.percussion.filter(f => f.t < .1 || f.t > .5).every(f => f.loud === 0))
    }
  }
})

test('hits at the beginning and end remain visible for short files and partial final frames', () => {
  for (const seconds of [.04, .099, .1, .101, .15, .199, .999, 1, 1.049, 1.099]) {
    for (const onset of [0, seconds - .015]) {
      const measured = stem('percussion', burst(seconds, onset, .015))
      const result = finishAnalysis([measured], 'Boundary hit')
      assert.equal(measured.measurement.active, true, `${seconds}s file, onset ${onset}`)
      assert.ok(visible(result.framesByKey.percussion), `${seconds}s file, onset ${onset} has no visible frame`)
      assert.equal(result.framesByKey.percussion.at(-1).loud, 0)
      const duration = Math.round(seconds * SAMPLE_RATE) / SAMPLE_RATE
      assert.equal(result.framesByKey.percussion.at(-1).t, Math.round(duration * 1e6) / 1e6)
      assert.ok(result.framesByKey.percussion.slice(0, -1).every(f => f.t < duration))
    }
  }
})

test('covering off-grid transients does not promote sparse weak residue or the PCM16 floor', () => {
  const weak = stem('residue', burst(4, 2.05, .02, .002))
  assert.equal(weak.measurement.active, false)
  const audio = Float32Array.from({ length: 4 * SAMPLE_RATE }, (_, i) => i % 2 ? -1 / 32768 : 0)
  const hit = burst(4, 2.05)
  for (let i = 0; i < audio.length; i++) audio[i] += hit[i]
  const measured = stem('percussion', audio)
  const result = finishAnalysis([measured, weak], 'Hit with background residue')
  assert.ok(visible(result.framesByKey.percussion))
  assert.ok(result.framesByKey.percussion.filter(f => f.t < 1.8 || f.t > 2.3).every(f => f.loud === 0))
  assert.ok(result.framesByKey.residue.every(f => f.loud === 0))
})

test('off-grid kick bleed uses the same coverage while independent tom hits survive', () => {
  const kick = burst(1, .25, .02, .4, 90)
  const bleed = Float32Array.from(kick, value => value * .1)
  const copied = stem('toms', bleed)
  assert.equal(copied.measurement.active, true)
  suppressKickBleed(bleed, kick, copied.measurement, SAMPLE_RATE)
  const suppressed = finishAnalysis([stem('kick', kick), copied], 'Kick spill')
  assert.ok(!visible(suppressed.framesByKey.toms))
  const tom = burst(1, .25, .02, .15, 500)
  const independent = stem('toms', tom)
  suppressKickBleed(tom, kick, independent.measurement, SAMPLE_RATE)
  const retained = finishAnalysis([stem('kick', kick), independent], 'Independent tom')
  assert.ok(visible(retained.framesByKey.toms))
})
