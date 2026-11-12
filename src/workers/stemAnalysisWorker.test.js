import test from 'node:test'
import assert from 'node:assert/strict'

test('MVSEP analysis produces the same measurements without allocating a throwaway playback mix', async t => {
  const previous = globalThis.self, messages = []
  t.after(() => { globalThis.self = previous })
  globalThis.self = { postMessage: data => messages.push(data) }
  await import('./stemAnalysis.worker.js')
  const channel = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 44100) * .2)
  const descriptor = { key: 'guitar', label: 'Guitar', fileName: 'guitar.wav' }
  const run = mixAudio => {
    messages.length = 0
    self.onmessage({ data: { type: 'stem', descriptor, channels: [channel], index: 0, total: 1, mixAudio } })
    self.onmessage({ data: { type: 'finish', title: 'Test mix', mixAudio } })
    return messages.find(message => message.type === 'complete')
  }
  const normal = run(true), mvsep = run(false)
  assert.deepEqual(mvsep.metadata, normal.metadata)
  assert.deepEqual(mvsep.framesByKey, normal.framesByKey)
  assert.equal(mvsep.wav, null); assert.ok(normal.wav.byteLength > 44)
})
