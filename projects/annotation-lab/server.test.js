import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createLab } from './server.js'
import { PROFILES } from './profiles.js'

export function audioFixture() {
  const buffer = Buffer.alloc(44 + 16000 * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40)
  for (let sample = 0; sample < 16000; sample++) buffer.writeInt16LE(Math.round(Math.sin(sample / 8000 * 2 * Math.PI * 220) * 3000), 44 + sample * 2)
  return buffer
}

export async function fakeOutput(job, { directory }) {
  const tracks = []
  for (const key of ['source', ...PROFILES[job.profile].keys]) {
    const file = path.join(directory, `${key}.wav`)
    const waveformFile = path.join(directory, `${key}.waveform.json`)
    await fs.writeFile(file, audioFixture())
    await fs.writeFile(waveformFile, JSON.stringify({ duration: 2, secondsPerBin: .01, peaks: [Array.from({ length: 200 }, (_, i) => .05 + Math.sin(i / 10) * .03)] }))
    tracks.push({ key, label: key, file, waveformFile, annotatable: key !== 'source', duration: 2, sampleRate: 8000, channels: 1, peak: .1, rmsDb: -24, sha256: `fixture-${key}` })
  }
  return { tracks, provenance: { pipelineVersion: 'test-fixture', inputSha256: 'fixture-hash' } }
}

async function fixture(t, analyze = fakeOutput) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-room-lab-test-'))
  const lab = createLab({ dataDir, analyze, setup: async () => ({ ready: true }) })
  const server = lab.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await lab.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }) })
  return { ...lab, dataDir, url: `http://127.0.0.1:${server.address().port}` }
}

function upload(url, profile = 'drums', names = ['song.wav'], isolated = false) {
  const body = new FormData()
  for (const name of names) body.append('songs', new Blob([audioFixture()], { type: 'audio/wav' }), name)
  return fetch(`${url}/api/batches?profile=${profile}&isolated=${isolated}`, { method: 'POST', body })
}

async function waitFor(url, predicate) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const jobs = await (await fetch(`${url}/api/jobs`)).json()
    if (predicate(jobs)) return jobs
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('The lab queue did not reach the expected state')
}

function save(url, id, key, intervals, version = 0) {
  return fetch(`${url}/api/jobs/${id}/annotations/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, intervals }) })
}

test('a batch shares one profile, distinct upload paths, and a serial processing queue', async t => {
  let active = 0, maximum = 0
  const inputs = []
  const f = await fixture(t, async (job, options) => {
    active++; maximum = Math.max(active, maximum); inputs.push(job.input)
    assert.equal(job.profile, 'quick')
    await new Promise(resolve => setTimeout(resolve, 20))
    options.onProgress({ percent: 50, message: 'Halfway' })
    const output = await fakeOutput(job, options)
    active--
    return output
  })
  assert.equal((await upload(f.url, 'quick', ['same.wav', 'same.wav'])).status, 202)
  const jobs = await waitFor(f.url, jobs => jobs.length === 2 && jobs.every(job => job.status === 'done'))
  assert.equal(maximum, 1)
  assert.notEqual(inputs[0], inputs[1])
  assert.equal(new Set(jobs.map(job => job.batchId)).size, 1)
  assert.deepEqual(jobs[0].tracks.filter(track => track.annotatable).map(track => track.key), PROFILES.quick.keys)
  assert.ok(!('input' in jobs[0]) && jobs[0].tracks.every(track => !('file' in track) && !('waveformFile' in track)))
})

test('a failed song does not stop the batch, and a retry can complete it', async t => {
  let fail = true
  const f = await fixture(t, async (job, options) => {
    if (job.filename === 'broken.wav' && fail) throw new Error('Deliberate model failure')
    return fakeOutput(job, options)
  })
  await upload(f.url, 'vocals', ['broken.wav', 'good.wav'])
  const jobs = await waitFor(f.url, jobs => jobs.length === 2 && ['failed', 'done'].every((state, index) => jobs[index].status === state))
  assert.match(jobs[0].error, /Deliberate model failure/)
  fail = false
  assert.equal((await fetch(`${f.url}/api/jobs/${jobs[0].id}/retry`, { method: 'POST' })).status, 200)
  await waitFor(f.url, jobs => jobs.every(job => job.status === 'done'))
})

test('progress stays finite and monotonic, and Unicode upload titles stay readable', async t => {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const released = new Promise(resolve => { release = resolve })
  const f = await fixture(t, async (job, options) => {
    options.onProgress({ percent: 60, message: 'Separating drums' })
    options.onProgress({ percent: 20, message: 'Saving cached stage' })
    options.onProgress({ percent: NaN, message: 'Bad record' })
    options.signal.addEventListener('abort', release, { once: true })
    enter()
    await released
    return fakeOutput(job, options)
  })
  await upload(f.url, 'drums', ['café synth 音楽.wav'])
  await entered
  const [processing] = await (await fetch(`${f.url}/api/jobs`)).json()
  assert.equal(processing.percent, 60)
  assert.equal(processing.filename, 'café synth 音楽.wav')
  release()
  const [done] = await waitFor(f.url, jobs => jobs[0]?.status === 'done')
  assert.equal(done.percent, 100)
})

test('cancellation stops the active worker and skips cancelled queued songs before continuing', async t => {
  const started = []
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  const f = await fixture(t, async (job, options) => {
    started.push(job.filename)
    if (job.filename === 'first.wav') {
      enter()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      options.signal.throwIfAborted()
    }
    return fakeOutput(job, options)
  })
  const jobs = await (await upload(f.url, 'drums', ['first.wav', 'skip.wav', 'last.wav'])).json()
  await entered
  await fetch(`${f.url}/api/jobs/${jobs[1].id}/cancel`, { method: 'POST' })
  await fetch(`${f.url}/api/jobs/${jobs[0].id}/cancel`, { method: 'POST' })
  await waitFor(f.url, jobs => jobs[0].status === 'cancelled' && jobs[1].status === 'cancelled' && jobs[2].status === 'done')
  assert.deepEqual(started, ['first.wav', 'last.wav'])
})

test('labels are stem-specific, reject invalid intervals and stale edits, and persist across restart', async t => {
  const f = await fixture(t)
  await upload(f.url, 'drums')
  const [job] = await waitFor(f.url, jobs => jobs[0]?.status === 'done')
  const toms = [{ start: .2, end: 1, label: 'bleed_absent' }]
  const crash = [{ start: 1, end: 1.9, label: 'genuine' }]
  assert.equal((await save(f.url, job.id, 'toms', toms)).status, 200)
  assert.equal((await save(f.url, job.id, 'crash', crash)).status, 200)
  for (const invalid of [[{ start: 1, end: .5, label: 'genuine' }], [{ start: -.1, end: 1, label: 'genuine' }], [{ start: 0, end: 5, label: 'genuine' }], [{ start: 0, end: 1, label: 'unknown' }], [{ start: null, end: 1, label: 'genuine' }]]) {
    assert.equal((await save(f.url, job.id, 'toms', invalid, 1)).status, 400)
  }
  assert.equal((await save(f.url, job.id, 'toms', [], 0)).status, 409)
  assert.equal((await save(f.url, job.id, 'source', toms)).status, 404)
  const restarted = createLab({ dataDir: f.dataDir, analyze: () => { throw new Error('Finished songs must not be reprocessed') } })
  assert.deepEqual(restarted.jobs.get(job.id).annotations.toms.intervals, toms)
  assert.deepEqual(restarted.jobs.get(job.id).annotations.crash.intervals, crash)
  assert.equal(restarted.jobs.get(job.id).status, 'done')
  await restarted.close()
})

test('exports retain provenance and labels, escape CSV formulas, and audio supports byte ranges', async t => {
  const f = await fixture(t)
  await upload(f.url, 'quick', ['=formula.wav'])
  const [job] = await waitFor(f.url, jobs => jobs[0]?.status === 'done')
  await save(f.url, job.id, 'drums', [{ start: 0, end: 1.5, label: 'uncertain' }])
  const dataset = await (await fetch(`${f.url}/api/export`)).json()
  assert.equal(dataset.schemaVersion, 1)
  assert.equal(dataset.songs[0].provenance.pipelineVersion, 'test-fixture')
  assert.equal(dataset.songs[0].annotations.drums.intervals[0].label, 'uncertain')
  assert.ok(dataset.songs[0].tracks.every(track => !path.isAbsolute(track.localFile)))
  const csv = await (await fetch(`${f.url}/api/export?format=csv`)).text()
  assert.match(csv, /"'=formula.wav"/)
  assert.match(csv, /"uncertain"/)
  const media = await fetch(`${f.url}${job.tracks[0].url}`, { headers: { Range: 'bytes=0-43' } })
  assert.equal(media.status, 206)
  assert.equal((await media.arrayBuffer()).byteLength, 44)
  const waveform = await (await fetch(`${f.url}${job.tracks[0].waveformUrl}`)).json()
  assert.equal(waveform.peaks[0].length, 200)
})

test('foreign origins, invalid profiles, and non-audio uploads cannot create jobs', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(`${f.url}/api/config`, { headers: { Origin: 'https://example.com' } })).status, 403)
  assert.equal((await upload(f.url, 'constructor')).status, 400)
  assert.equal((await upload(f.url, 'quick', ['song.wav'], true)).status, 400)
  assert.equal((await upload(f.url, 'drums', [])).status, 400)
  assert.equal((await upload(f.url, 'drums', ['program.exe'])).status, 400)
  assert.equal(f.jobs.size, 0)
  assert.equal((await fetch(`${f.url}/data/jobs`)).status, 404)
})

test('shutdown waits for the active worker and unfinished jobs recover as interrupted', async t => {
  let stopped = false, enter
  const entered = new Promise(resolve => { enter = resolve })
  const f = await fixture(t, async (_job, { signal }) => {
    enter()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    stopped = true
    signal.throwIfAborted()
  })
  await upload(f.url, 'drums', ['first.wav'])
  await entered
  await upload(f.url, 'drums', ['queued.wav'])
  await f.close()
  assert.equal(stopped, true)
  const restarted = createLab({ dataDir: f.dataDir, analyze: fakeOutput })
  assert.equal([...restarted.jobs.values()].find(job => job.filename === 'queued.wav').status, 'interrupted')
  await restarted.close()
})
