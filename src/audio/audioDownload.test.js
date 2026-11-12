import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadAudio } from './audioDownload.js'

const wav = new Uint8Array(48)
const options = { retryMilliseconds: 0, idleMilliseconds: 500 }

test('a truncated transfer is retried as a read and never reveals the signed URL', async () => {
  let reads = 0
  const file = await downloadAudio('https://storage.invalid/?secret=private-signature', new AbortController().signal, 'bass.wav', { ...options, expectedBytes: 48, fetcher: async () => new Response(++reads === 1 ? wav.subarray(0, 46) : wav) })
  assert.equal(reads, 2); assert.equal(file.size, 48)
  await assert.rejects(downloadAudio('https://storage.invalid/?secret=private-signature', new AbortController().signal, 'bass.wav', { ...options, expectedBytes: 48, fetcher: async () => new Response(wav.subarray(0, 46)) }), error => error.code === 'DOWNLOAD_INCOMPLETE' && !error.message.includes('private-signature'))
})

test('HTTP rejection, interrupted streams, and user cancellation remain distinguishable', async () => {
  let reads = 0
  await assert.rejects(downloadAudio('https://storage.invalid/', new AbortController().signal, 'original.wav', { ...options, fetcher: async () => { reads++; return new Response('', { status: 403 }) } }), error => error.status === 403 && error.code === 'DOWNLOAD_HTTP')
  assert.equal(reads, 1)
  await assert.rejects(downloadAudio('https://storage.invalid/', new AbortController().signal, 'bass.wav', { ...options, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('stream interrupted')) } })) }), error => error.code === 'DOWNLOAD_NETWORK' && error.recoverable)
  const controller = new AbortController()
  controller.abort(new DOMException('Cancelled', 'AbortError'))
  await assert.rejects(downloadAudio('https://storage.invalid/', controller.signal, 'bass.wav'), { name: 'AbortError' })
})

test('an idle transfer times out and the decoder never receives an empty body', async () => {
  await assert.rejects(downloadAudio('https://storage.invalid/', new AbortController().signal, 'bass.wav', { ...options, idleMilliseconds: 5, fetcher: async (_url, { signal }) => new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }) } })) }), error => error.code === 'DOWNLOAD_TIMEOUT')
  await assert.rejects(downloadAudio('https://storage.invalid/', new AbortController().signal, 'bass.wav', { ...options, fetcher: async () => new Response(new Uint8Array()) }), error => error.code === 'DOWNLOAD_INCOMPLETE')
})
