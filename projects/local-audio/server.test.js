import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createApp } from './server.js'

async function fixture(t, analyze) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-room-upload-'))
  const audioDir = path.join(root, 'audio')
  const assetsDir = path.join(root, 'assets')
  const server = createApp({ audioDir, assetsDir, analyze: async (file, report, mode, options) => {
    await analyze(file, report, mode, options)
    await fs.writeFile(path.join(options.outputDir, 'instrument_meta.json'), JSON.stringify({
      audioUrl: `/audio/${path.basename(file)}`, instruments: [], processingMode: mode,
    }))
  } }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  return { audioDir, assetsDir, url: `http://127.0.0.1:${server.address().port}/api/upload` }
}

function upload(url, name = 'song.wav') {
  const form = new FormData()
  form.append('song', new Blob(['audio fixture'], { type: 'audio/wav' }), name)
  return fetch(url, { method: 'POST', body: form })
}

test('upload passes an absolute audio path and supports spaces and punctuation', async t => {
  const calls = []
  const { audioDir, url } = await fixture(t, async file => calls.push({ file, data: await fs.readFile(file, 'utf8') }))
  const name = 'a song $(name).wav'
  const res = await upload(url, name)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { success: true, filename: name })
  assert.equal(path.isAbsolute(calls[0].file), true)
  assert.equal(path.basename(calls[0].file), name)
  assert.equal(calls[0].data, 'audio fixture')
  assert.equal(await fs.readFile(path.join(audioDir, name), 'utf8'), 'audio fixture')
  await assert.rejects(fs.access(calls[0].file), { code: 'ENOENT' })
})

test('missing audio is rejected and releases the upload slot', async t => {
  let calls = 0
  const { url } = await fixture(t, async () => { calls++ })
  const missing = await fetch(url, { method: 'POST', body: new FormData() })
  assert.equal(missing.status, 400)
  assert.equal(calls, 0)
  assert.equal((await upload(url)).status, 200)
})

test('concurrent uploads are rejected before they overwrite the input', async t => {
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const { url } = await fixture(t, async () => { entered(); await waiting })
  const first = upload(url)
  await started
  assert.equal((await upload(url)).status, 409)
  release()
  assert.equal((await first).status, 200)
})

test('failed analysis reports failure and permits the next upload', async t => {
  let calls = 0
  const { url } = await fixture(t, async () => {
    if (calls++ === 0) throw new Error('Model fixture failed')
  })
  const failed = await upload(url)
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).success, false)
  assert.equal((await upload(url)).status, 200)
})

test('live progress is monotonic and reaches 100 only after analysis succeeds', async t => {
  let release, entered, report
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const { url } = await fixture(t, async (file, onProgress) => {
    report = onProgress
    onProgress(40, 'Instruments ready')
    entered()
    await waiting
  })
  const id = '11111111-1111-4111-8111-111111111111'
  const first = upload(`${url}?jobId=${id}`)
  await started
  const statusUrl = url.replace('/upload', `/progress/${id}`)
  let progress = await (await fetch(statusUrl)).json()
  assert.deepEqual(progress, { status: 'processing', percent: 40, message: 'Instruments ready' })
  report(20, 'Separating drums')
  progress = await (await fetch(statusUrl)).json()
  assert.equal(progress.percent, 40)
  report(100, 'Room ready')
  progress = await (await fetch(statusUrl)).json()
  assert.equal(progress.percent, 99)
  assert.equal(progress.status, 'processing')
  release()
  assert.equal((await first).status, 200)
  progress = await (await fetch(statusUrl)).json()
  assert.deepEqual(progress, { status: 'complete', percent: 100, message: 'Room ready' })
  assert.equal((await fetch(url.replace('/upload', '/progress/unknown'))).status, 404)
})

test('failed processing leaves a recoverable failure status below 100', async t => {
  const { url } = await fixture(t, async (file, report) => {
    report(55, 'Drums ready')
    throw new Error('Model fixture failed')
  })
  const id = '22222222-2222-4222-8222-222222222222'
  assert.equal((await upload(`${url}?jobId=${id}`)).status, 500)
  const progress = await (await fetch(url.replace('/upload', `/progress/${id}`))).json()
  assert.equal(progress.status, 'failed')
  assert.equal(progress.percent, 55)
})

test('invalid and reused job IDs are rejected without locking uploads', async t => {
  const { url } = await fixture(t, async () => {})
  assert.equal((await upload(`${url}?jobId=invalid`)).status, 400)
  const id = '33333333-3333-4333-8333-333333333333'
  assert.equal((await upload(`${url}?jobId=${id}`)).status, 200)
  assert.equal((await upload(`${url}?jobId=${id}`)).status, 409)
  assert.equal((await upload(url)).status, 200)
})

test('upload forwards Quick or Thorough and defaults legacy uploads to Thorough', async t => {
  const modes = []
  const { url } = await fixture(t, async (file, onProgress, mode) => {
    modes.push(mode)
    onProgress(95, 'Instruments ready')
  })
  for (const query of ['?mode=quick', '?mode=thorough', '']) {
    assert.equal((await upload(url + query)).status, 200)
  }
  assert.deepEqual(modes, ['quick', 'thorough', 'thorough'])
})

test('invalid processing modes are rejected before upload writes or analysis', async t => {
  let calls = 0
  const { audioDir, url } = await fixture(t, async () => { calls++ })
  for (const query of ['?mode=unknown', '?mode=', '?mode=quick&mode=thorough']) {
    const response = await upload(url + query)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'Invalid processing mode.')
  }
  assert.equal(calls, 0)
  assert.deepEqual(await fs.readdir(audioDir), [])
  assert.equal((await upload(url + '?mode=quick')).status, 200)
})

test('cancel waits for analysis to stop, keeps the current room and permits retry', async t => {
  let entered, aborted, release, stagedFile, calls = 0
  const started = new Promise(resolve => { entered = resolve })
  const stopping = new Promise(resolve => { aborted = resolve })
  const cleanup = new Promise(resolve => { release = resolve })
  const { audioDir, assetsDir, url } = await fixture(t, async (file, report, mode, { signal }) => {
    if (calls++) return
    stagedFile = file
    report(40, 'Separating drums')
    entered()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    aborted()
    await cleanup
    signal.throwIfAborted()
  })
  t.after(() => release())
  await fs.writeFile(path.join(audioDir, 'song.wav'), 'previous song')
  await fs.mkdir(assetsDir)
  await fs.writeFile(path.join(assetsDir, 'instrument_meta.json'), 'previous metadata')
  const id = '44444444-4444-4444-8444-444444444444'
  const first = upload(`${url}?jobId=${id}`)
  await started
  let confirmed = false
  const cancelUrl = url.replace('/upload', `/cancel/${id}`)
  const cancel = fetch(cancelUrl, { method: 'POST' }).then(response => { confirmed = true; return response.json() })
  await stopping
  assert.equal(confirmed, false)
  assert.equal((await (await fetch(url.replace('/upload', `/progress/${id}`))).json()).status, 'cancelling')
  assert.equal((await upload(url)).status, 409)
  release()
  assert.deepEqual(await cancel, { status: 'cancelled', percent: 40, message: 'Processing cancelled' })
  assert.deepEqual(await (await first).json(), { success: false, cancelled: true })
  assert.equal(await fs.readFile(path.join(audioDir, 'song.wav'), 'utf8'), 'previous song')
  assert.equal(await fs.readFile(path.join(assetsDir, 'instrument_meta.json'), 'utf8'), 'previous metadata')
  await assert.rejects(fs.access(stagedFile), { code: 'ENOENT' })
  assert.equal((await (await fetch(cancelUrl, { method: 'POST' })).json()).status, 'cancelled')
  assert.equal((await upload(url)).status, 200)
})

test('cancel after completion preserves published results; unknown jobs return 404', async t => {
  const { audioDir, url } = await fixture(t, async () => {})
  const id = '55555555-5555-4555-8555-555555555555'
  assert.equal((await upload(`${url}?jobId=${id}`)).status, 200)
  const response = await fetch(url.replace('/upload', `/cancel/${id}`), { method: 'POST' })
  assert.equal((await response.json()).status, 'complete')
  assert.equal(await fs.readFile(path.join(audioDir, 'song.wav'), 'utf8'), 'audio fixture')
  assert.equal((await fetch(url.replace('/upload', '/cancel/unknown'), { method: 'POST' })).status, 404)
})

test('cancel interrupts an unfinished multipart upload without replacing the previous file', async t => {
  let calls = 0
  const { audioDir, url } = await fixture(t, async () => { calls++ })
  await fs.writeFile(path.join(audioDir, 'song.wav'), 'previous song')
  const id = '66666666-6666-4666-8666-666666666666'
  const request = http.request(`${url}?jobId=${id}`, {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=upload-fixture' },
  })
  request.on('error', () => {}) // Cancellation deliberately closes this connection.
  t.after(() => request.destroy())
  request.write('--upload-fixture\r\nContent-Disposition: form-data; name="song"; filename="song.wav"\r\nContent-Type: audio/wav\r\n\r\npartial audio')
  const statusUrl = url.replace('/upload', `/progress/${id}`)
  let registered = false
  for (let i = 0; i < 50; i++) {
    if ((await fetch(statusUrl)).ok) { registered = true; break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(registered, true)
  const result = await fetch(url.replace('/upload', `/cancel/${id}`), { method: 'POST' })
  assert.equal((await result.json()).status, 'cancelled')
  assert.equal(calls, 0)
  assert.equal(await fs.readFile(path.join(audioDir, 'song.wav'), 'utf8'), 'previous song')
  assert.equal((await upload(url)).status, 200)
})
