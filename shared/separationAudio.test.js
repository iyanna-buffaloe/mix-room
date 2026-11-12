import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeSeparationWav, validateSeparationWav, UPLOAD_SAMPLE_RATE } from './separationAudio.js'

test('canonical float WAV preserves channel values, mono duplication, and verifiable duration', () => {
  const left = Float32Array.from([.999, -.4, .2]), right = Float32Array.from([-.7, .8, -.1])
  const wav = new Uint8Array(encodeSeparationWav(left, right)), view = new DataView(wav.buffer)
  assert.equal(view.getFloat32(44, true), left[0]); assert.equal(view.getFloat32(48, true), right[0])
  assert.equal(validateSeparationWav(wav.subarray(0, 44), wav.length, 6), 3 / UPLOAD_SAMPLE_RATE)
  const mono = new DataView(encodeSeparationWav(left))
  assert.equal(mono.getFloat32(44, true), mono.getFloat32(48, true))
  assert.throws(() => validateSeparationWav(wav.subarray(0, 44), wav.length + 8, 6), /invalid/)
  assert.throws(() => validateSeparationWav(wav.subarray(0, 44), wav.length, 0), /no longer/)
})
