import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './server.js'

async function fixture(t, analyzeStems) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-room-stems-test-'))
  const audioDir = path.join(root, 'audio'), assetsDir = path.join(root, 'assets')
  const server = createApp({ audioDir, assetsDir, analyze: () => { throw new Error('Song separation must not run') }, analyzeStems }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, audioDir, assetsDir, url: `http://127.0.0.1:${server.address().port}/api/upload-stems` }
}

function upload(url, labels = ['Kick', 'Kick'], title) {
  const body = new FormData()
  body.append('stems', new Blob(['first audio']), 'same.wav')
  body.append('stems', new Blob(['second audio']), 'same.wav')
  body.append('labels', JSON.stringify(labels))
  if (title !== undefined) body.append('title', title)
  return fetch(url, { method: 'POST', body })
}

async function output(stems, { outputDir, mixPath, title }) {
  await fs.writeFile(mixPath, 'combined audio')
  const instruments = stems.map((stem, index) => ({ key: `stem_${index}`, label: stem.label, fileName: stem.fileName, active: true }))
  await Promise.all(instruments.map(stem => fs.writeFile(path.join(outputDir, `${stem.key}_frames.json`), '[]')))
  await fs.writeFile(path.join(outputDir, 'instrument_meta.json'), JSON.stringify({ audioUrl: `/audio/${path.basename(mixPath)}`, instruments, processingMode: 'stems', title }))
}

test('stem upload keeps duplicate filenames distinct, pairs names in order, and publishes the combined audio', async t => {
  let received
  const { audioDir, assetsDir, url } = await fixture(t, async (stems, report, options) => {
    received = stems
    assert.notEqual(stems[0].file, stems[1].file)
    assert.equal(await fs.readFile(stems[0].file, 'utf8'), 'first audio')
    assert.equal(await fs.readFile(stems[1].file, 'utf8'), 'second audio')
    report(60, 'Analyzing instruments')
    await output(stems, options)
  })
  const response = await upload(url, [' Bass guitar ', 'Backing vocals'])
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(await fs.readFile(path.join(audioDir, result.filename), 'utf8'), 'combined audio')
  const meta = JSON.parse(await fs.readFile(path.join(assetsDir, 'instrument_meta.json')))
  assert.deepEqual(meta.instruments.map(stem => stem.label), ['Bass guitar', 'Backing vocals'])
  assert.equal(meta.audioUrl, `/audio/${result.filename}`)
  assert.equal(meta.title, 'stem mix')
  assert.deepEqual(meta.instruments.map(stem => stem.fileName), ['same.wav', 'same.wav'])
  for (const stem of received) await assert.rejects(fs.access(stem.file), { code: 'ENOENT' })
})

test('stem upload forwards a custom song title and rejects empty or oversized titles', async t => {
  let calls = 0
  const { assetsDir, url } = await fixture(t, async (stems, report, options) => { calls++; await output(stems, options) })
  for (const title of ['', ' ', 'a'.repeat(121)]) assert.equal((await upload(url, ['Kick', 'Bass'], title)).status, 400)
  assert.equal(calls, 0)
  assert.equal((await upload(url, ['Kick', 'Bass'], '  My song  ')).status, 200)
  const meta = JSON.parse(await fs.readFile(path.join(assetsDir, 'instrument_meta.json')))
  assert.equal(meta.title, 'My song')
})

function rename(url, body) {
  return fetch(url.replace('/upload-stems', '/rename'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

test('renaming preserves audio, frame data, instrument keys, and filenames without analyzing again', async t => {
  let calls = 0
  const { audioDir, assetsDir, url } = await fixture(t, async (stems, report, options) => { calls++; await output(stems, options) })
  const uploadResult = await (await upload(url)).json()
  const filename = path.join(assetsDir, 'instrument_meta.json')
  const before = JSON.parse(await fs.readFile(filename))
  const frames = await fs.readFile(path.join(assetsDir, 'stem_0_frames.json'))
  const audio = await fs.readFile(path.join(audioDir, uploadResult.filename))
  const request = {
    audioUrl: before.audioUrl, title: '  Renamed song  ',
    instruments: before.instruments.map((instrument, index) => ({ key: instrument.key, label: ` Instrument ${index} ` })),
  }
  assert.equal((await rename(url, request)).status, 200)
  const after = JSON.parse(await fs.readFile(filename))
  assert.equal(after.title, 'Renamed song')
  assert.deepEqual(after.instruments, before.instruments.map((instrument, index) => ({ ...instrument, label: `Instrument ${index}` })))
  assert.deepEqual(await fs.readFile(path.join(audioDir, uploadResult.filename)), audio)
  assert.deepEqual(await fs.readFile(path.join(assetsDir, 'stem_0_frames.json')), frames)
  assert.equal(calls, 1)
  assert.deepEqual((await fs.readdir(assetsDir)).sort(), ['instrument_meta.json', 'stem_0_frames.json', 'stem_1_frames.json'])
})

test('invalid names, mismatched instruments, and stale mix edits leave metadata intact', async t => {
  const { assetsDir, url } = await fixture(t, async () => { throw new Error('Renaming must not run analysis') })
  assert.equal((await rename(url, { title: 'Song', instruments: [] })).status, 404)
  // Use explicit metadata to test validation independently of model inference.
  const metadata = { audioUrl: '/audio/fixture.wav', processingMode: 'stems', title: 'Original', instruments: [{ key: 'piano', label: 'Piano', active: false, freq: 0.3 }] }
  await fs.mkdir(assetsDir)
  await fs.writeFile(path.join(assetsDir, 'instrument_meta.json'), JSON.stringify(metadata))
  const base = { audioUrl: metadata.audioUrl, title: 'New title', instruments: [{ key: 'piano', label: 'Keys' }] }
  for (const invalid of [
    { ...base, title: '' }, { ...base, title: 'a'.repeat(121) },
    { ...base, instruments: [] }, { ...base, instruments: [{ key: 'unknown', label: 'Keys' }] },
    { ...base, instruments: [{ key: 'piano', label: '' }] },
    { ...base, instruments: [{ key: 'piano', label: 'Keys' }, { key: 'piano', label: 'Duplicate' }] },
  ]) assert.equal((await rename(url, invalid)).status, 400)
  assert.equal((await rename(url, { ...base, audioUrl: '/audio/older.wav' })).status, 409)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(assetsDir, 'instrument_meta.json'))), metadata)
  assert.equal((await rename(url, base)).status, 200)
})

test('missing files or invalid instrument names fail before analysis and release the slot', async t => {
  let calls = 0
  const { url } = await fixture(t, async (stems, report, options) => { calls++; await output(stems, options) })
  assert.equal((await fetch(url, { method: 'POST', body: new FormData() })).status, 400)
  for (const labels of [[], ['Kick'], [' ', 'Bass'], ['a'.repeat(61), 'Bass'], [42, 'Bass']]) {
    assert.equal((await upload(url, labels)).status, 400)
  }
  assert.equal(calls, 0)
  assert.equal((await upload(url)).status, 200)
})

test('stems share the song upload lock and cancellation preserves the current room', async t => {
  let entered, staged
  const started = new Promise(resolve => { entered = resolve })
  const { audioDir, assetsDir, url } = await fixture(t, async (stems, report, { signal }) => {
    staged = stems[0].file
    report(60, 'Analyzing instruments')
    entered()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  })
  await fs.mkdir(assetsDir)
  await fs.writeFile(path.join(assetsDir, 'instrument_meta.json'), 'previous room')
  await fs.writeFile(path.join(audioDir, 'song.wav'), 'previous audio')
  const id = '77777777-7777-4777-8777-777777777777'
  const request = upload(`${url}?jobId=${id}`)
  await started
  assert.equal((await upload(url)).status, 409)
  assert.equal((await rename(url, { title: 'Song', instruments: [] })).status, 409)
  assert.equal((await fetch(url.replace('/upload-stems', '/upload'), { method: 'POST' })).status, 409)
  const cancelled = await (await fetch(url.replace('/upload-stems', `/cancel/${id}`), { method: 'POST' })).json()
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await (await request).json()).cancelled, true)
  assert.equal(await fs.readFile(path.join(assetsDir, 'instrument_meta.json'), 'utf8'), 'previous room')
  assert.equal(await fs.readFile(path.join(audioDir, 'song.wav'), 'utf8'), 'previous audio')
  await assert.rejects(fs.access(staged), { code: 'ENOENT' })
})
