import test from 'node:test'
import assert from 'node:assert/strict'
import { measureStem, finishAnalysis, makeStemKeys, encodeMixWav, suppressKickBleed, SAMPLE_RATE } from './stemAnalysis.js'
import { renameMix, isStoredMix } from './browserMixStorage.js'
import { closestAnalysisFrame } from '../export/videoTimeline.js'

const tone = (frequency, gain = 0.2, seconds = 1) => Float32Array.from({ length: Math.round(SAMPLE_RATE * seconds) }, (_, i) => Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) * gain)

test('mono and stereo analysis preserve frequency, width, pan, and absolute silence thresholds', () => {
  const left = tone(440), right = tone(440, 0.05)
  const mono = measureStem([left], SAMPLE_RATE, 'piano')
  const stereo = measureStem([left, right], SAMPLE_RATE, 'guitar')
  assert.ok(Math.abs(mono.freq - 440 / 8000) < 0.002)
  assert.equal(mono.width, 0); assert.equal(mono.pan, 0); assert.equal(mono.active, true)
  assert.equal(stereo.width, 0); assert.ok(Math.abs(stereo.pan + 0.6) < 0.001)
  assert.equal(measureStem([tone(440, 0.0001)], SAMPLE_RATE, 'vocals').active, false)
  assert.equal(measureStem([tone(110, 0.009)], SAMPLE_RATE, 'kick').active, true)
  assert.equal(measureStem([new Float32Array(5000)], SAMPLE_RATE, 'bass').freq, 0)
  assert.throws(() => measureStem([new Float32Array([NaN])], SAMPLE_RATE, 'bass'), /invalid audio/)
})

test('independent stereo channels make a wider instrument and faint high-frequency tails do not dominate', () => {
  const wide = measureStem([tone(220), tone(880)], SAMPLE_RATE, 'synth')
  assert.ok(wide.width > 0.98)
  const audio = new Float32Array(SAMPLE_RATE * 4)
  audio.set(tone(400)); audio.set(tone(8000, 0.00001, 3), SAMPLE_RATE)
  assert.ok(measureStem([audio], SAMPLE_RATE, 'synth').freq < 0.1)
})

test('mix context preserves quieter activity and follows the same relative balance under master gain changes', () => {
  const analyze = gain => finishAnalysis([0.2, 0.02].map((level, i) => ({ key: ['kick', 'snare'][i], label: `Stem ${i}`, fileName: `${i}.wav`, measurement: measureStem([tone(400, level * gain)], SAMPLE_RATE, ['kick', 'snare'][i]) })), 'Song')
  const original = analyze(1), quieter = analyze(0.5)
  const loud = original.framesByKey.kick, soft = original.framesByKey.snare
  assert.ok(soft.some(frame => frame.loud > 0.5)); assert.ok(loud[3].loud > soft[3].loud)
  assert.deepEqual(original.framesByKey, quieter.framesByKey)
  assert.equal(soft.at(-1).loud, 0); assert.equal(soft.at(-1).t, 1)
})

test('weaker matching kick bleed is suppressed while independent toms remain active', () => {
  const kick = tone(110), bleed = tone(110, 0.04), tom = tone(350, 0.15)
  const bleedMeasure = measureStem([bleed], SAMPLE_RATE, 'toms')
  suppressKickBleed(bleed, kick, bleedMeasure, SAMPLE_RATE)
  assert.ok(bleedMeasure.bleed[3] > 0.99); assert.ok(bleedMeasure.activity[3] < 0.01)
  const tomMeasure = measureStem([tom], SAMPLE_RATE, 'toms')
  suppressKickBleed(tom, kick, tomMeasure, SAMPLE_RATE)
  assert.equal(tomMeasure.bleed[3], 0); assert.equal(tomMeasure.activity[3], 1)
})

test('arbitrary and duplicate labels produce unique safe keys without changing display names or filenames', () => {
  const keys = makeStemKeys(['Kick', 'Kick', 'Kick 2', '音声', '123', 'constructor'].map(label => ({ label, file: { name: 'same.wav' } })))
  assert.equal(new Set(keys.map(stem => stem.key)).size, keys.length)
  for (const stem of keys) { assert.match(stem.key, /^[a-z][a-z0-9_]*$/); assert.equal(stem.fileName, 'same.wav') }
})

test('playback WAV preserves stereo balance, duration, silence, and common headroom gain', () => {
  const left = new Float32Array([2, 0, -2]), right = new Float32Array([1, 0, -1])
  const wav = encodeMixWav(left, right), view = new DataView(wav)
  assert.equal(wav.byteLength, 44 + 3 * 4); assert.equal(view.getUint32(24, true), SAMPLE_RATE)
  assert.equal(view.getUint16(22, true), 2); assert.equal(view.getUint32(40, true), 12)
  assert.ok(Math.abs(view.getInt16(44, true) / 32767 - 0.98) < 1e-4)
  assert.ok(Math.abs(view.getInt16(46, true) / 32767 - 0.49) < 1e-4)
  assert.equal(view.getInt16(48, true), 0); assert.equal(view.getInt16(50, true), 0)
})

test('renaming preserves the audio, keys, measured qualities, filenames, and analysis frames', () => {
  const record = { version: 1, id: 'test', audioBlob: new Blob([new Uint8Array(50)]), framesByKey: { piano: [{ t: 0, loud: 1 }] }, metadata: { processingMode: 'stems', title: 'Original', instruments: [{ key: 'piano', label: 'Piano', fileName: 'long original.wav', active: false, freq: 0.3 }] } }
  assert.equal(isStoredMix(record), true)
  assert.equal(isStoredMix({ ...record, metadata: { ...record.metadata, processingMode: 'quick' } }), true)
  assert.equal(isStoredMix(null), false)
  assert.equal(isStoredMix({ ...record, framesByKey: {} }), false)
  const renamed = renameMix(record, ' New title ', [{ key: 'piano', label: ' Keys ' }])
  assert.equal(renamed.audioBlob, record.audioBlob); assert.equal(renamed.framesByKey, record.framesByKey)
  assert.equal(renamed.id, record.id); assert.equal(renamed.metadata.title, 'New title')
  assert.deepEqual(renamed.metadata.instruments[0], { ...record.metadata.instruments[0], label: 'Keys' })
  assert.equal(record.metadata.title, 'Original')
  assert.throws(() => renameMix(record, '', []), /title/)
  assert.throws(() => renameMix(record, 'Song', [{ key: 'missing', label: 'Keys' }]), /does not match/)
})

test('fast live frame lookup matches the previous closest-frame behavior, including seeks and ties', () => {
  const frames = [{ t: 0, loud: 0.2 }, { t: 0.1, loud: 0.8 }, { t: 0.2, loud: 0 }]
  for (const time of [0, 0.05, 0.08, 0.15, 0.2, 10, -1]) {
    const expected = frames.reduce((a, b) => Math.abs(b.t - time) < Math.abs(a.t - time) ? b : a)
    assert.equal(closestAnalysisFrame(frames, time), expected)
  }
})
