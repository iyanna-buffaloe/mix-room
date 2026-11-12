import test from 'node:test'
import assert from 'node:assert/strict'
import { processBrowserStems, validateStemUpload } from './browserStemProcessing.js'

test('invalid titles, empty batches, and oversized files fail before allocating a decoder or worker', () => {
  assert.throws(() => validateStemUpload([], 'Song'), /between 1 and 32/)
  assert.throws(() => validateStemUpload([{ label: 'Piano', file: { size: 1 } }], ' '), /title/)
  assert.throws(() => validateStemUpload([{ label: ' ', file: { size: 1 } }], 'Song'), /instrument name/)
  assert.throws(() => validateStemUpload([{ label: 'Piano', file: { name: 'large.wav', size: 301 * 1024 * 1024 } }], 'Song'), /too large/)
})

test('cancel releases the worker immediately and a late decoder cannot resume analysis', async t => {
  const previousWindow = globalThis.window, previousWorker = globalThis.Worker
  t.after(() => { globalThis.window = previousWindow; globalThis.Worker = previousWorker })
  let finishDecode, started, stopped = false, requests = 0
  const decoding = new Promise(resolve => { started = resolve })
  const result = new Promise(resolve => { finishDecode = resolve })
  class Decoder { decodeAudioData() { started(); return result } }
  class Worker { terminate() { stopped = true } postMessage() { requests++ } }
  globalThis.Worker = Worker
  globalThis.window = { Worker, OfflineAudioContext: Decoder }
  const controller = new AbortController()
  const task = processBrowserStems([{ label: 'Piano', file: { name: 'piano.wav', size: 1, arrayBuffer: async () => new ArrayBuffer(1) } }], 'Song', { signal: controller.signal })
  await decoding
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(stopped, true)
  finishDecode({ length: 1, duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 0)
})
