import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHmac, createHash } from 'node:crypto'
import { createSeparationService, separationConfig } from './service.js'
import { createMVSEPClient, readStemFiles, STAGES } from './mvsep.js'
import { encodeSeparationWav } from '../../shared/separationAudio.js'
import { createLocalStore } from './storage.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = 'https://mixingvisualizer.netlify.app'
const KEY = 'private-api-key-fixture'
const files = stage => STAGES[stage].keys.map(key => ({ type: key, bytes: 2048, url: `https://de2.mvsep.com/storage/processed/${key}.wav` }))
const legacyFiles = () => ['bass', 'drums', 'vocals', 'other'].map(key => ({ type: key, bytes: 2048, url: `https://de2.mvsep.com/storage/processed/${key}.wav` }))
function fixture({ monthlyJobs = 10, create, get, inspect, configAvailable = true, beforeQuotaSet, verifyUser = async token => ({ id: token }), durableStore, testScope, thoroughPaused } = {}) {
  const entries = new Map(), calls = [], cancelled = [], storageCalls = []
  let revision = 0, clock = Date.UTC(2026, 9, 12)
  const store = durableStore ?? {
    async getWithMetadata(key) { return entries.has(key) ? structuredClone(entries.get(key)) : null },
    async setJSON(key, data, options = {}) {
      if (key.startsWith('quota/') && beforeQuotaSet) await beforeQuotaSet()
      const old = entries.get(key)
      if (options.onlyIfNew && old || options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return { modified: false }
      const etag = String(++revision); entries.set(key, { etag, data: structuredClone(data) }); return { modified: true, etag }
    },
  }
  const audio = new Uint8Array(encodeSeparationWav(new Float32Array(44100)))
  const provider = {
    async create(stage, url, webhook) { calls.push({ stage, url, webhook }); return create ? create(stage) : `hash-${stage}` },
    async get(hash) { return get ? get(hash) : { status: 'done', data: { files: files(hash.slice(5)) } } },
    async cancel(hash) { cancelled.push(hash) },
  }
  const storage = {
    async uploadUrl() { storageCalls.push('upload'); return 'https://account.r2.cloudflarestorage.com/signed-put' },
    async sourceUrl() { storageCalls.push('source'); return 'https://account.r2.cloudflarestorage.com/signed-get' },
    async inspect(key) { storageCalls.push('inspect'); return inspect ? inspect(key) : { size: audio.byteLength, header: audio.subarray(0, 44) } },
  }
  const service = createSeparationService({ store, storage, provider, config: { available: configAvailable, maxSeconds: 360, monthlyJobs, thoroughPaused, ...(testScope !== undefined ? { testScope } : {}) }, verifyUser, apiKey: KEY, now: () => clock, webhookBase: ORIGIN })
  const job = (mode = 'thorough') => ({ id: randomUUID(), token: 'a'.repeat(64), name: 'my song.wav', device: randomUUID().replaceAll('-', '').repeat(2), mode, size: audio.byteLength })
  const request = async (route, job, method = 'POST', body, extraHeaders = {}) => {
    const res = await service(new Request(`${ORIGIN}/api/separation${route}`, { method, headers: { Origin: ORIGIN, ...(job ? { Authorization: `Bearer ${job.token}`, 'X-Mix-Room-Device': job.device, ...(job.account === null ? {} : { 'X-Mix-Room-Account': job.account ?? job.device }) } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    const data = await res.json(); assert.ok(!JSON.stringify(data).includes(KEY)); return { status: res.status, data }
  }
  const init = job => request('/jobs', job, 'POST', { id: job.id, name: job.name, mode: job.mode, size: job.size })
  return { entries, store, calls, cancelled, storageCalls, service, job, guest: mode => ({ ...job(mode), account: null }), request, init, tick: milliseconds => { clock += milliseconds } }
}

test('preview test scope denies another account before job, allowance or storage writes', async () => {
  const testScope = { accountId: randomUUID(), jobId: randomUUID() }
  const f = fixture({ testScope }), job = { ...f.job('quick'), id: testScope.jobId, account: randomUUID() }
  assert.equal((await f.init(job)).status, 403)
  assert.equal(f.entries.size, 0)
  assert.deepEqual(f.storageCalls, [])
  assert.equal(f.calls.length, 0)
})

test('preview test scope denies guests, other jobs and Thorough mode without side effects', async () => {
  const testScope = { accountId: randomUUID(), jobId: randomUUID() }
  for (const changed of [{ account: null }, { id: randomUUID() }, { mode: 'thorough' }]) {
    const f = fixture({ testScope })
    const job = { ...f.job('quick'), account: testScope.accountId, id: testScope.jobId, ...changed }
    assert.equal((await f.init(job)).data.code, 'TEST_SCOPE_DENIED')
    assert.equal(f.entries.size, 0)
    assert.deepEqual(f.storageCalls, [])
    assert.equal(f.calls.length, 0)
  }
})

test('preview test scope fails closed when malformed and keeps its IDs out of public config', async () => {
  const accountId = randomUUID(), jobId = randomUUID()
  for (const testScope of [null, {}, { accountId }, { jobId }, { accountId: '', jobId }, { accountId, jobId: 'bad' }]) {
    const f = fixture({ testScope }), job = { ...f.job('quick'), account: accountId, id: jobId }
    const publicConfig = await f.request('/config', null, 'GET')
    assert.deepEqual(publicConfig.data, { available: true, maxSeconds: 360, monthlyJobs: 10 })
    assert.equal((await f.init(job)).data.code, 'TEST_SCOPE_INVALID')
    assert.equal(f.entries.size, 0)
    assert.deepEqual(f.storageCalls, [])
    assert.equal(f.calls.length, 0)
  }
  for (const env of [{ SEPARATION_TEST_ACCOUNT_ID: accountId }, { SEPARATION_TEST_JOB_ID: '' }]) {
    assert.ok(separationConfig(env).testScope)
  }
  assert.deepEqual(separationConfig({ SEPARATION_TEST_ACCOUNT_ID: accountId, SEPARATION_TEST_JOB_ID: jobId }).testScope, { accountId, jobId })
  assert.equal(separationConfig({}).testScope, undefined)
})

test('preview test scope requires a currently verified account without falling back to guest', async () => {
  const testScope = { accountId: randomUUID(), jobId: randomUUID() }
  for (const verifyUser of [null, async () => null, async () => { throw new Error('Fixture auth outage') }]) {
    const f = fixture({ testScope, verifyUser }), job = { ...f.job('quick'), account: testScope.accountId, id: testScope.jobId }
    assert.ok([401, 503].includes((await f.init(job)).status))
    assert.equal(f.entries.size, 0)
    assert.deepEqual(f.storageCalls, [])
    assert.equal(f.calls.length, 0)
  }
})

test('preview test scope admits one Quick job and reuses durable submission protection across retries', async () => {
  const testScope = { accountId: randomUUID(), jobId: randomUUID() }
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const f = fixture({ testScope, create: () => { entered(); return new Promise(resolve => { release = () => resolve('hash-quick') }) } })
  const job = { ...f.job('quick'), account: testScope.accountId, id: testScope.jobId }
  const initialized = await Promise.all([f.init(job), f.init(job)])
  assert.ok(initialized.some(result => result.status === 200))
  assert.ok(initialized.every(result => [200, 409].includes(result.status)))
  assert.equal((await f.init(job)).status, 200)
  assert.equal([...f.entries.keys()].filter(key => key.startsWith('quota/')).length, 1)
  assert.equal([...f.entries.keys()].filter(key => key.startsWith('credits/')).length, 1)
  const first = f.request(`/jobs/${job.id}/start`, job)
  await waiting
  await Promise.all([f.request(`/jobs/${job.id}/start`, job), f.request(`/jobs/${job.id}/advance`, job)])
  release()
  await first
  const restarted = fixture({ testScope, durableStore: f.store })
  assert.equal((await restarted.request(`/jobs/${job.id}/start`, job)).status, 200)
  const hook = createHmac('sha256', KEY).update(`mvsep-webhook:${job.id}`).digest('hex')
  assert.equal((await restarted.request(`/jobs/${job.id}/webhook?hook=${hook}`, null)).status, 200)
  assert.equal((await restarted.request(`/jobs/${job.id}`, job, 'GET')).data.status, 'complete')
  assert.equal((await restarted.request(`/jobs/${job.id}/recover`, job, 'GET')).data.stems.length, 6)
  assert.equal((await restarted.request(`/jobs/${job.id}`, { ...job, token: 'b'.repeat(64) }, 'GET')).status, 404)
  assert.deepEqual(f.calls.map(call => call.stage), ['quick'])
  assert.equal(restarted.calls.length, 0)
})

test('preview test scope never retries an uncertain paid submission', async () => {
  const testScope = { accountId: randomUUID(), jobId: randomUUID() }
  const f = fixture({ testScope, create: () => { throw new Error('Fixture connection lost after submit') } })
  const job = { ...f.job('quick'), account: testScope.accountId, id: testScope.jobId }
  await f.init(job)
  assert.equal((await f.request(`/jobs/${job.id}/start`, job)).data.status, 'failed')
  await f.request(`/jobs/${job.id}/start`, job)
  await f.request(`/jobs/${job.id}/advance`, job)
  assert.equal(f.calls.length, 1)
})

test('preview test scope blocks old uploads and paid webhook chaining while preserving result recovery', async () => {
  const f = fixture(), quick = f.job('quick'), thorough = f.job('thorough'), uploading = f.job('quick')
  for (const job of [quick, thorough, uploading]) await f.init(job)
  await f.request(`/jobs/${quick.id}/start`, quick)
  await f.request(`/jobs/${thorough.id}/start`, thorough)
  const before = structuredClone([...f.entries])
  const testScope = { accountId: randomUUID(), jobId: randomUUID() }
  const scoped = fixture({ testScope, durableStore: f.store })
  assert.equal((await scoped.request(`/jobs/${uploading.id}/start`, uploading)).data.code, 'TEST_SCOPE_DENIED')
  assert.deepEqual([...f.entries], before)
  assert.deepEqual(scoped.storageCalls, [])
  assert.equal((await scoped.request(`/jobs/${quick.id}/advance`, quick)).data.status, 'complete')
  assert.equal((await scoped.request(`/jobs/${quick.id}/recover`, quick, 'GET')).data.status, 'complete')
  const incomplete = fixture({ testScope: { accountId: testScope.accountId }, durableStore: f.store })
  assert.equal((await incomplete.request(`/jobs/${quick.id}`, quick, 'GET')).data.status, 'complete')
  assert.equal((await incomplete.request(`/jobs/${quick.id}/recover`, quick, 'GET')).data.status, 'complete')
  assert.equal(incomplete.calls.length, 0)
  const hook = createHmac('sha256', KEY).update(`mvsep-webhook:${thorough.id}`).digest('hex')
  await scoped.request(`/jobs/${thorough.id}/webhook?hook=${hook}`, null)
  assert.equal((await scoped.request(`/jobs/${thorough.id}`, thorough, 'GET')).data.status, 'failed')
  assert.equal(scoped.calls.length, 0)
  assert.equal(f.calls.length, 2)
})

test('missing credentials fail closed and configuration never exposes secrets', async () => {
  const env = { MVSEP_API_KEY: KEY }
  assert.equal(separationConfig(env).available, false)
  const f = fixture({ configAvailable: false }), j = f.job()
  assert.equal((await f.request('/config', null, 'GET')).data.available, false)
  assert.equal((await f.init(j)).status, 503)
  assert.equal(f.calls.length, 0)
})

test('Thorough chains isolated drums and vocals once and returns twelve named stems', async () => {
  const f = fixture(), j = f.job()
  assert.equal((await f.init(j)).status, 200)
  await f.request(`/jobs/${j.id}/start`, j)
  await f.request(`/jobs/${j.id}/start`, j)
  for (let i = 0; i < 3; i++) await f.request(`/jobs/${j.id}/advance`, j)
  const result = await f.request(`/jobs/${j.id}`, j, 'GET')
  assert.equal(result.data.status, 'complete')
  assert.deepEqual(f.calls.map(call => call.stage), ['instruments', 'drums', 'vocals'])
  assert.match(f.calls[1].url, /drums.wav$/)
  assert.match(f.calls[2].url, /vocals.wav$/)
  assert.equal(result.data.stems.length, 12)
  assert.ok(!result.data.stems.some(stem => ['drums', 'vocals'].includes(stem.key)))
  await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(f.calls.length, 3)
})

test('actual Karaoke output names complete Thorough mode and recover the same paid job', async () => {
  const f = fixture({ get: async hash => ({ status: 'done', data: { files: hash === 'hash-vocals'
    ? files('vocals').map((file, index) => ({ ...file, type: index ? 'Back instrum' : 'Vocals lead' }))
    : files(hash.slice(5)) } }) }), j = f.job('thorough')
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  for (let i = 0; i < 3; i++) await f.request(`/jobs/${j.id}/advance`, j)
  const complete = await f.request(`/jobs/${j.id}`, j, 'GET')
  assert.equal(complete.data.status, 'complete'); assert.equal(complete.data.stems.length, 12)
  assert.deepEqual(complete.data.stems.slice(-2).map(stem => stem.key), ['lead_vocals', 'backing_vocals'])
  // A job marked failed by the previous parser must remain recoverable.
  const entry = f.entries.get(`job/${j.id}`)
  entry.data.status = 'failed'; delete entry.data.outputs
  const submissions = f.calls.length
  const recovered = await f.request(`/jobs/${j.id}/recover`, j, 'GET')
  assert.equal(recovered.data.status, 'complete'); assert.equal(recovered.data.stems.length, 12)
  assert.equal(f.calls.length, submissions)
})

test('missing vocal results identify the stage and still reject duplicate or unsafe stems', () => {
  assert.throws(() => readStemFiles([files('vocals')[0]], 'vocals'), /incomplete vocals stem set.*Backing vocals/)
  const lead = { ...files('vocals')[0], type: 'Vocals lead' }, back = { ...files('vocals')[1], type: 'Back instrum' }
  assert.throws(() => readStemFiles([lead, lead, back], 'vocals'), /invalid stem manifest/)
  assert.throws(() => readStemFiles([lead, { ...back, url: 'https://attacker.test/back.wav' }], 'vocals'), /invalid stem manifest/)
})

test('Quick submits one model and produces six instruments including guitar and piano', async () => {
  const f = fixture(), j = f.job('quick')
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  const result = await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(result.data.status, 'complete')
  assert.deepEqual(result.data.stems.map(stem => stem.key), ['bass', 'drums', 'vocals', 'guitar', 'piano', 'other'])
  assert.equal(f.entries.get(`job/${j.id}`).data.stages[0].model, '63')
  assert.deepEqual(f.calls.map(call => call.stage), ['quick'])
})

test('new Quick jobs reject incomplete six-stem results without another paid request', async () => {
  const f = fixture({ get: async () => ({ status: 'done', data: { files: legacyFiles() } }) }), j = f.job('quick')
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  const result = await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(result.data.status, 'failed')
  assert.match(result.data.message, /incomplete quick stem set.*guitar, piano/)
  const recovered = await f.request(`/jobs/${j.id}/recover`, j, 'GET')
  assert.equal(recovered.status, 400)
  assert.match(recovered.data.error, /guitar, piano/)
  assert.equal(f.calls.length, 1)
})

test('older four-stem Quick jobs still finish and recover without a new separation', async () => {
  for (const model of [undefined, '20']) {
    const f = fixture({ get: async () => ({ status: 'done', data: { files: legacyFiles() } }) }), j = f.job('quick')
    await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
    const record = f.entries.get(`job/${j.id}`)
    if (model) record.data.stages[0].model = model
    else delete record.data.stages[0].model
    const result = await f.request(`/jobs/${j.id}/advance`, j)
    assert.equal(result.data.status, 'complete')
    assert.deepEqual(result.data.stems.map(stem => stem.key), ['bass', 'drums', 'vocals', 'other'])
    const failed = f.entries.get(`job/${j.id}`)
    failed.data.status = 'failed'; delete failed.data.outputs
    const quotaBefore = structuredClone([...f.entries].filter(([key]) => key.startsWith('quota/')))
    const recovered = await f.request(`/jobs/${j.id}/recover`, j, 'GET')
    assert.equal(recovered.data.status, 'complete')
    assert.deepEqual(recovered.data.stems.map(stem => stem.key), ['bass', 'drums', 'vocals', 'other'])
    assert.equal(f.calls.length, 1)
    assert.deepEqual([...f.entries].filter(([key]) => key.startsWith('quota/')), quotaBefore)
  }
})

test('a temporarily missing provider job waits and later finishes without resubmission', async () => {
  let reads = 0
  const f = fixture({ get: async () => ++reads === 1 ? { status: 'not_found' } : { status: 'done', data: { files: files('quick'), input_file: { url: 'https://de2.mvsep.com/storage/temp/original.wav' } } } }), j = f.job('quick')
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  const waiting = await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(waiting.data.status, 'processing'); assert.match(waiting.data.message, /confirm/)
  const done = await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(done.data.status, 'complete'); assert.ok(done.data.originalUrl.endsWith('/original.wav')); assert.equal(f.calls.length, 1)
})

test('read-only recovery loads a job previously marked failed without spending another quota slot', async () => {
  let missing = true
  const f = fixture({ get: async () => missing ? { status: 'not_found' } : { status: 'done', data: { files: files('quick') } } }), j = f.job('quick')
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  await f.request(`/jobs/${j.id}/advance`, j); f.tick(120001)
  assert.equal((await f.request(`/jobs/${j.id}/advance`, j)).data.status, 'failed')
  const quotaBefore = [...f.entries].filter(([key]) => key.startsWith('quota/'))
  missing = false
  const recovered = await f.request(`/jobs/${j.id}/recover`, j, 'GET')
  assert.equal(recovered.data.status, 'complete'); assert.equal(recovered.data.stems.length, 6)
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.entries].filter(([key]) => key.startsWith('quota/')), quotaBefore)
  assert.equal((await f.request(`/jobs/${j.id}/recover`, { ...j, token: 'b'.repeat(64) }, 'GET')).status, 404)
  assert.equal((await f.request(`/jobs/${j.id}/recover`, j, 'POST')).status, 405)
})

test('recovery never begins a missing paid Thorough stage', async () => {
  const f = fixture(), j = f.job('thorough')
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  const before = f.calls.length
  const result = await f.request(`/jobs/${j.id}/recover`, j, 'GET')
  assert.equal(result.status, 400); assert.match(result.data.error, /before every stage/)
  assert.equal(f.calls.length, before); assert.deepEqual(f.calls.map(call => call.stage), ['instruments'])
})

test('loading an existing result never submits paid stages, reserves quota, or accepts arbitrary downloads', async () => {
  let reads = 0, unsafe = false
  const f = fixture({ get: async () => { reads++; return { success: true, status: 'done', data: { algorithm: 'Demucs4 HT (vocals, drums, bass, other)', files: legacyFiles(), input_file: { url: unsafe ? 'https://attacker.test/audio.wav' : 'https://de2.mvsep.com/storage/temp/source.wav' } } } } })
  const result = await f.request('/results?hash=existing-source.wav', null, 'GET')
  assert.equal(result.status, 200); assert.equal(result.data.stems.length, 4)
  assert.equal(reads, 1); assert.equal(f.calls.length, 0); assert.equal(f.cancelled.length, 0); assert.equal(f.entries.size, 0)
  assert.equal((await f.request('/results?hash=../path', null, 'GET')).status, 400)
  assert.equal((await f.request('/results?hash=existing-source.wav', null, 'POST')).status, 405)
  assert.equal(reads, 1)
  unsafe = true
  assert.equal((await f.request('/results?hash=existing-source.wav', null, 'GET')).status, 400)
})

test('loading a completed six-stem result includes guitar and piano without any paid submissions', async () => {
  const f = fixture({ get: async () => ({ status: 'done', data: { algorithm: 'BS Roformer SW (vocals, bass, drums, guitar, piano, other)', files: files('quick'), input_file: { url: 'https://de2.mvsep.com/storage/temp/source.wav' } } }) })
  const result = await f.request('/results?hash=existing-six-stem-source.wav', null, 'GET')
  assert.equal(result.status, 200)
  assert.deepEqual(result.data.stems.map(stem => stem.key), ['bass', 'drums', 'vocals', 'guitar', 'piano', 'other'])
  assert.equal(f.calls.length, 0)
  assert.equal(f.entries.size, 0)
})

test('concurrent starts and advance polls cannot duplicate paid stages', async () => {
  let release
  const f = fixture({ create: stage => stage === 'instruments' ? new Promise(resolve => { release = () => resolve('hash-instruments') }) : Promise.resolve(`hash-${stage}`) }), j = f.job()
  await f.init(j)
  const first = f.request(`/jobs/${j.id}/start`, j)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  await Promise.all([f.request(`/jobs/${j.id}/start`, j), f.request(`/jobs/${j.id}/advance`, j)])
  assert.equal(f.calls.length, 1); release(); await first
  await Promise.all(Array.from({ length: 8 }, () => f.request(`/jobs/${j.id}/advance`, j)))
  assert.equal(f.calls.filter(call => call.stage === 'drums').length, 1)
})

test('an ambiguous submission fails without automatic paid retries or returning provider secrets', async () => {
  const f = fixture({ create: async () => { throw new Error('network failed after provider accepted request') } }), j = f.job()
  await f.init(j)
  assert.equal((await f.request(`/jobs/${j.id}/start`, j)).data.status, 'failed')
  await f.request(`/jobs/${j.id}/start`, j); await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(f.calls.length, 1)
})

test('a cancel during initial quota reservation cannot corrupt initialization or start paid work', async () => {
  let release, entered, first = true
  const waiting = new Promise(resolve => { entered = resolve })
  const f = fixture({ monthlyJobs: 1, beforeQuotaSet: () => {
    if (!first) return
    first = false; entered(); return new Promise(resolve => { release = resolve })
  } }), j = f.job()
  const initializing = f.init(j)
  await waiting
  assert.equal((await f.request(`/jobs/${j.id}/start`, j)).data.status, 'uploading')
  assert.equal((await f.request(`/jobs/${j.id}/cancel`, j)).data.status, 'cancelled')
  release(); await initializing
  assert.equal((await f.request(`/jobs/${j.id}`, j, 'GET')).data.status, 'cancelled')
  assert.equal(f.calls.length, 0)
  assert.equal((await f.init(f.job())).status, 200)
})

test('a crashed submission with an expired lease is never reissued after recovery', async () => {
  const f = fixture({ monthlyJobs: 1 }), j = f.job()
  await f.init(j)
  const record = f.entries.get(`job/${j.id}`)
  Object.assign(record.data, { phase: 'submitting', status: 'processing', lock: { owner: 'lost-worker', until: 0 } })
  f.entries.get(record.data.quotaKey).data.charged = true
  assert.equal((await f.request(`/jobs/${j.id}/advance`, j)).data.status, 'failed')
  await f.request(`/jobs/${j.id}/start`, j)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.init(f.job())).status, 429)
})

test('cancellation during submission persists intent and stops all subsequent stages', async () => {
  let release
  const f = fixture({ create: () => new Promise(resolve => { release = resolve }) }), j = f.job()
  await f.init(j)
  const starting = f.request(`/jobs/${j.id}/start`, j)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.request(`/jobs/${j.id}/cancel`, j)).data.status, 'cancelled')
  release('hash-instruments'); assert.equal((await starting).data.status, 'cancelled')
  await f.request(`/jobs/${j.id}/advance`, j)
  assert.equal(f.calls.length, 1); assert.deepEqual(f.cancelled, ['hash-instruments'])
})

test('a monthly slot is atomically reserved, released before paid work, and retained after submission', async () => {
  const f = fixture({ monthlyJobs: 1 }), first = f.job(), second = f.job()
  const results = await Promise.all([f.init(first), f.init(second)])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429])
  const accepted = results[0].status === 200 ? first : second
  await f.request(`/jobs/${accepted.id}/cancel`, accepted)
  const third = f.job('quick'); assert.equal((await f.init(third)).status, 200)
  await f.request(`/jobs/${third.id}/start`, third); await f.request(`/jobs/${third.id}/cancel`, third)
  const limited = await f.init(f.job())
  assert.equal(limited.status, 429)
  assert.equal(limited.data.code, 'MONTHLY_LIMIT_REACHED')
  assert.match(limited.data.error, /month’s separation allowance/)
  f.tick(31 * 24 * 60 * 60 * 1000)
  assert.equal((await f.init(f.job())).status, 200)
})

test('raising the site allowance preserves counted songs and makes the extra slots available', async () => {
  const f = fixture({ monthlyJobs: 20 })
  for (let slot = 0; slot < 10; slot++) f.entries.set(`quota/2026-10/${slot}`, { etag: `previous-${slot}`, data: { jobId: randomUUID(), charged: true, expires: 0 } })
  for (let slot = 10; slot < 20; slot++) {
    const job = f.job('quick')
    assert.equal((await f.init(job)).status, 200)
    assert.equal(f.entries.get(`job/${job.id}`).data.quotaKey, `quota/2026-10/${slot}`)
  }
  const limited = await f.init(f.job())
  assert.equal(limited.status, 429)
  assert.equal(limited.data.code, 'MONTHLY_LIMIT_REACHED')
  assert.equal(f.calls.length, 0)
  assert.equal(separationConfig({ MVSEP_API_KEY: KEY, R2_ACCOUNT_ID: 'fixture-account', R2_ACCESS_KEY_ID: 'fixture-access', R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_BUCKET_NAME: 'fixture-bucket', SEPARATION_MONTHLY_JOBS: '20' }).monthlyJobs, 20)
})

test('invalid actual audio size and duration are rejected before spending credits', async () => {
  const badHeader = new Uint8Array(encodeSeparationWav(new Float32Array(44100)))
  new DataView(badHeader.buffer).setUint32(24, 48000, true)
  for (const inspected of [{ size: badHeader.length, header: badHeader.subarray(0, 44) }, { size: badHeader.length + 8, header: badHeader.subarray(0, 44) }]) {
    const f = fixture({ inspect: async () => inspected }), j = f.job()
    await f.init(j)
    assert.equal((await f.request(`/jobs/${j.id}/start`, j)).data.status, 'failed')
    assert.equal(f.calls.length, 0)
  }
})

test('job capabilities, same-origin checks, and signed webhooks protect existing jobs', async () => {
  const f = fixture(), j = f.job()
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  assert.equal((await f.request(`/jobs/${j.id}`, { ...j, token: 'b'.repeat(64) }, 'GET')).status, 404)
  assert.equal((await f.request(`/jobs/${j.id}/advance`, j, 'POST', undefined, { Origin: 'https://elsewhere.example' })).status, 403)
  assert.equal((await f.request(`/jobs/${j.id}/webhook?hook=wrong`, null)).status, 403)
  const hook = createHmac('sha256', KEY).update(`mvsep-webhook:${j.id}`).digest('hex')
  assert.equal((await f.request(`/jobs/${j.id}/webhook?hook=${hook}`, null)).status, 200)
  assert.equal(f.calls.length, 2)
})

test('incomplete provider stems stop chaining and unsafe download hosts are rejected', async () => {
  const f = fixture({ get: async () => ({ status: 'done', data: { files: files('instruments').slice(0, 2) } }) }), j = f.job()
  await f.init(j); await f.request(`/jobs/${j.id}/start`, j)
  assert.equal((await f.request(`/jobs/${j.id}/advance`, j)).data.status, 'failed')
  assert.equal(f.calls.length, 1)
  const bad = files('quick'); bad[0].url = 'http://127.0.0.1/admin'
  assert.throws(() => readStemFiles(bad, 'quick'), /invalid/)
  const aliases = files('vocals').map((file, i) => ({ ...file, type: i ? 'Instrumental' : 'Vocals' }))
  assert.deepEqual(readStemFiles(aliases, 'vocals').map(file => file.key), ['lead_vocals', 'backing_vocals'])
})

test('MVSEP requests use server-only form credentials and explicit economical model options', async () => {
  const calls = []
  const provider = createMVSEPClient(KEY, async (url, options) => { calls.push({ url: String(url), options }); return Response.json({ success: true, data: { hash: 'confirmed-hash' } }) })
  await provider.create('drums', 'https://de2.mvsep.com/stem.wav')
  const { url, options } = calls[0]
  assert.ok(!url.includes(KEY)); assert.equal(options.body.get('api_token'), KEY)
  assert.equal(options.body.get('sep_type'), '37'); assert.equal(options.body.get('add_opt1'), '1'); assert.equal(options.body.get('add_opt2'), '1')
  assert.equal(options.body.get('is_demo'), '0'); assert.equal(options.body.get('output_format'), '1')
  await provider.create('quick', 'https://de2.mvsep.com/source.wav')
  const quick = calls[1]
  assert.equal(quick.options.body.get('sep_type'), '63')
  assert.equal(quick.options.body.get('add_opt1'), null)
  assert.equal(quick.options.body.get('is_demo'), '0')
  assert.equal(quick.options.body.get('output_format'), '1')
  assert.equal(quick.options.body.get('api_token'), KEY)
  assert.ok(!quick.url.includes(KEY))
})

test('URL imports follow the remote-download handoff without resubmitting a separation', async () => {
  const calls = []
  const provider = createMVSEPClient(KEY, async (url, options) => {
    const parsed = new URL(url); calls.push({ route: parsed.pathname.split('/').pop(), method: options.method ?? 'GET' })
    if (parsed.pathname.endsWith('/create')) return Response.json({ success: true, data: { hash: 'remote-id', link: 'https://mvsep.com/api/separation/get-remote?hash=remote-id' } })
    if (parsed.pathname.endsWith('/get-remote')) return Response.json({ success: true, status: 'done', data: { hash: 'final-separation-hash' } })
    return Response.json({ success: true, status: 'done', data: { files: files('quick') } })
  })
  const hash = await provider.create('quick', 'https://example.r2.cloudflarestorage.com/source.wav')
  assert.equal(hash, 'remote:remote-id')
  const handoff = await provider.get(hash)
  assert.equal(handoff.status, 'waiting'); assert.equal(handoff.data.resolvedHash, 'final-separation-hash')
  assert.equal((await provider.get(handoff.data.resolvedHash)).status, 'done')
  assert.deepEqual(calls.map(call => call.route), ['create', 'get-remote', 'get'])
})

test('guests receive one audio analysis and one separate stem analysis', async () => {
  const f=fixture(), guest=f.guest('quick')
  const initial=(await f.request('/credits',guest,'GET')).data
  assert.equal(initial.remaining,1);assert.equal(initial.stemsRemaining,1)
  assert.equal((await f.init(guest)).status,200)
  assert.equal((await f.init(guest)).status,200, 'retry reuses the existing reservation')
  await f.request(`/jobs/${guest.id}/start`,guest)
  await f.request(`/jobs/${guest.id}/start`,guest)
  await f.request(`/jobs/${guest.id}/advance`,guest)
  assert.equal(f.calls.length,1)
  assert.equal((await f.request(`/jobs/${guest.id}`,guest,'GET')).data.status,'complete')
  const next={...f.guest('quick'),device:guest.device}
  assert.equal((await f.init(next)).data.code,'SONG_CREDITS_EXHAUSTED')
  assert.equal((await f.request('/credits',guest,'GET')).data.remaining,0)
  assert.equal((await f.request('/credits',guest,'GET')).data.stemsRemaining,1)
  const stem=randomUUID()
  assert.equal((await f.request('/stems/reserve',guest,'POST',{id:stem})).status,200)
  assert.equal((await f.request('/stems/complete',guest,'POST',{id:stem})).data.completed,true)
  assert.equal((await f.request('/credits',guest,'GET')).data.stemsRemaining,0)
  const other=f.guest('quick')
  assert.equal((await f.request('/credits',other,'GET')).data.remaining,1)
})

test('browser reservations prevent concurrent excess jobs and release on pre-submission cancellation or expiry', async () => {
  const f = fixture(), jobs = Array.from({ length: 4 }, () => f.job('quick'))
  for (const job of jobs) job.device = jobs[0].device
  const results = await Promise.all(jobs.map(job => f.init(job)))
  assert.equal(results.filter(result => result.status === 200).length, 3)
  assert.equal(results.filter(result => result.data.code === 'SONG_CREDITS_EXHAUSTED').length, 1)
  const reserved = jobs[results.findIndex(result => result.status === 200)]
  await f.request(`/jobs/${reserved.id}/cancel`, reserved)
  assert.equal((await f.request('/credits', reserved, 'GET')).data.remaining, 1)
  f.tick(31 * 60 * 1000)
  assert.equal((await f.request('/credits', reserved, 'GET')).data.remaining, 3)
  assert.equal(f.calls.length, 0)
})

test('Thorough stages consume one browser song and cancelling paid work retains that charge', async () => {
  const f = fixture(), job = f.job('thorough')
  await f.init(job)
  await f.request(`/jobs/${job.id}/start`, job)
  await f.request(`/jobs/${job.id}/advance`, job)
  await f.request(`/jobs/${job.id}/advance`, job)
  assert.equal(f.calls.length, 3)
  assert.equal((await f.request('/credits', job, 'GET')).data.remaining, 2)
  await f.request(`/jobs/${job.id}/cancel`, job)
  assert.equal((await f.request('/credits', job, 'GET')).data.remaining, 2)
})

test('verified accounts share three lifetime audio credits across devices without stacking guest credit', async () => {
  const f = fixture({ verifyUser: async token => ['account-a', 'account-b'].includes(token) ? { id: token } : null })
  const guest = f.guest('quick')
  assert.equal((await f.init(guest)).status, 200)
  await f.request(`/jobs/${guest.id}/start`, guest)
  const header = { 'X-Mix-Room-Account': 'account-a' }
  assert.equal((await f.request('/credits', guest, 'GET', null, header)).data.remaining, 3)
  const jobs = Array.from({ length: 4 }, () => f.job('quick'))
  for (const job of jobs.slice(0, 3)) {
    assert.equal((await f.request('/jobs', job, 'POST', { id: job.id, name: job.name, mode: job.mode, size: job.size }, header)).status, 200)
    await f.request(`/jobs/${job.id}/start`, job, 'POST', null, header)
  }
  assert.equal((await f.request('/credits', f.job(), 'GET', null, header)).data.remaining, 0)
  const last = jobs[3]
  assert.equal((await f.request('/jobs', last, 'POST', { id: last.id, name: last.name, mode: last.mode, size: last.size }, header)).data.code, 'SONG_CREDITS_EXHAUSTED')
  assert.equal((await f.request('/credits', guest, 'GET')).data.remaining, 0)
  assert.equal((await f.request('/credits', guest, 'GET', null, { 'X-Mix-Room-Account': 'account-b' })).data.remaining, 3)
  f.tick(32 * 24 * 60 * 60 * 1000)
  assert.equal((await f.request('/credits', guest, 'GET', null, header)).data.remaining, 0)
})

test('job capabilities also require their initiating account or guest identity', async () => {
  const f = fixture({ verifyUser: async token => ({ id: token }) }), job = f.job('quick')
  const account = { 'X-Mix-Room-Account': 'owner-a' }
  await f.request('/jobs', job, 'POST', { id: job.id, name: job.name, mode: job.mode, size: job.size }, account)
  assert.equal((await f.request(`/jobs/${job.id}`, job, 'GET', null, account)).status, 200)
  assert.equal((await f.request(`/jobs/${job.id}`, job, 'GET', null, { 'X-Mix-Room-Account': 'owner-b' })).status, 404)
  assert.equal((await f.request(`/jobs/${job.id}`, job, 'GET')).status, 404)
  assert.equal(f.calls.length, 0)
})

test('invalid account credentials never fall back to the guest allowance', async () => {
  const f = fixture({ verifyUser: async () => null }), job = f.guest('quick')
  assert.equal((await f.request('/credits', job, 'GET', null, { 'X-Mix-Room-Account': 'forged' })).status, 401)
  assert.equal((await f.request('/credits', job, 'GET')).data.remaining, 1)
})

test('site-wide paid limits leave a verified account balance untouched', async () => {
  const f = fixture({ monthlyJobs: 1 }), guest = f.job('quick')
  await f.init(guest); await f.request(`/jobs/${guest.id}/start`, guest)
  const account = f.job('quick'), headers = { 'X-Mix-Room-Account': 'verified' }
  const rejected = await f.request('/jobs', account, 'POST', { id: account.id, name: account.name, mode: account.mode, size: account.size }, headers)
  assert.equal(rejected.data.code, 'MONTHLY_LIMIT_REACHED')
  assert.equal((await f.request('/credits', account, 'GET', null, headers)).data.remaining, 3)
})

test('guest stem trials reserve once, refund cancellation, and remain consumed after successful analysis', async () => {
  const f = fixture({ configAvailable: false }), guest = f.guest(), first = randomUUID(), next = randomUUID()
  assert.equal((await f.request('/stems/reserve', guest, 'POST', { id: first })).status, 200)
  assert.equal((await f.request('/stems/reserve', guest, 'POST', { id: next })).data.code, 'STEM_TRIAL_EXHAUSTED')
  assert.equal((await f.request('/stems/release', guest, 'POST', { id: first })).data.released, true)
  assert.equal((await f.request('/credits', guest, 'GET')).data.stemsRemaining, 1)
  await f.request('/stems/reserve', guest, 'POST', { id: next })
  assert.equal((await f.request('/stems/complete', guest, 'POST', { id: next })).data.completed, true)
  assert.equal((await f.request('/stems/complete', guest, 'POST', { id: next })).data.completed, true)
  assert.equal((await f.request('/stems/release', guest, 'POST', { id: next })).data.released, false)
  f.tick(31 * 60 * 1000)
  assert.equal((await f.request('/stems/reserve', guest, 'POST', { id: next })).data.completed, true)
  assert.equal((await f.request('/credits', guest, 'GET')).data.stemsRemaining, 0)
  assert.equal((await f.request('/stems/reserve', guest, 'POST', { id: randomUUID() })).status, 429)
  assert.equal(f.calls.length, 0)
})

test('account stem analysis is unlimited and an abandoned guest reservation expires', async () => {
  const f = fixture({ configAvailable: false, verifyUser: async () => ({ id: 'account-a' }) }), guest = f.guest()
  await f.request('/stems/reserve', guest, 'POST', { id: randomUUID() })
  f.tick(31 * 60 * 1000)
  assert.equal((await f.request('/stems/reserve', guest, 'POST', { id: randomUUID() })).status, 200)
  for (let n = 0; n < 4; n++) assert.equal((await f.request('/stems/reserve', guest, 'POST', { id: randomUUID() }, { 'X-Mix-Room-Account': 'verified' })).data.unlimited, true)
  assert.equal((await f.request('/credits', guest, 'GET', null, { 'X-Mix-Room-Account': 'verified' })).data.stemsRemaining, null)
  assert.equal(f.calls.length, 0)
})

test('an expired upload reservation cannot start paid work or consume its returned credit', async () => {
  const f = fixture(), job = f.job('quick')
  await f.init(job)
  f.tick(31 * 60 * 1000)
  assert.equal((await f.request('/credits', job, 'GET')).data.remaining, 3)
  const result = await f.request(`/jobs/${job.id}/start`, job)
  assert.equal(result.data.status, 'failed')
  assert.match(result.data.message, /reservation expired/)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.request('/credits', job, 'GET')).data.remaining, 3)
  assert.ok(![...f.entries.entries()].some(([key, entry]) => key.startsWith('quota/') && entry.data.charged))
})

test('guest and lifetime account allowances survive a service/store restart and changed login tokens', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mix-room-allowance-restart-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const verifyUser = async token => ({ id: token === 'different-account' ? 'account-b' : 'account-a' })
  const first = fixture({ durableStore: createLocalStore(directory), verifyUser })
  const guest = first.guest('quick')
  assert.equal((await first.init(guest)).status,200)
  await first.request(`/jobs/${guest.id}/start`,guest)
  const trial = randomUUID()
  await first.request('/stems/reserve', guest, 'POST', { id: trial })
  await first.request('/stems/complete', guest, 'POST', { id: trial })
  const account = { 'X-Mix-Room-Account': 'original-login-token' }
  for (let n = 0; n < 3; n++) {
    const job = first.job('quick')
    assert.equal((await first.request('/jobs', job, 'POST', { id: job.id, name: job.name, mode: job.mode, size: job.size }, account)).status, 200)
    await first.request(`/jobs/${job.id}/start`, job, 'POST', null, account)
  }
  const restarted = fixture({ durableStore: createLocalStore(directory), verifyUser })
  const returnedGuest = (await restarted.request('/credits', guest, 'GET')).data
  assert.equal(returnedGuest.remaining, 0)
  assert.equal(returnedGuest.stemsRemaining, 0)
  const renewed = { 'X-Mix-Room-Account': 'renewed-login-token' }, anotherDevice = restarted.job()
  assert.equal((await restarted.request('/credits', anotherDevice, 'GET', null, renewed)).data.remaining, 0)
  assert.equal((await restarted.request('/credits', anotherDevice, 'GET', null, renewed)).data.stemsRemaining, null)
  restarted.tick(32 * 24 * 60 * 60 * 1000)
  assert.equal((await restarted.request('/credits', anotherDevice, 'GET', null, renewed)).data.remaining, 0)
  assert.equal((await restarted.request('/credits', anotherDevice, 'GET', null, { 'X-Mix-Room-Account': 'different-account' })).data.remaining, 3)
  assert.equal(restarted.calls.length, 0)
})

test('concurrent account uploads reserve at most three lifetime credits across devices', async () => {
  const f = fixture({ verifyUser: async () => ({ id: 'same-account' }) })
  const headers = { 'X-Mix-Room-Account': 'valid' }, jobs = Array.from({ length: 6 }, () => f.job('quick'))
  const results = await Promise.all(jobs.map(job => f.request('/jobs', job, 'POST', { id: job.id, name: job.name, mode: job.mode, size: job.size }, headers)))
  assert.equal(results.filter(result => result.status === 200).length, 3)
  assert.equal(results.filter(result => result.data.code === 'SONG_CREDITS_EXHAUSTED').length, 3)
  assert.equal((await f.request('/credits', f.job(), 'GET', null, headers)).data.remaining, 0)
  assert.equal(f.calls.length, 0)
  assert.equal([...f.entries.entries()].filter(([key, entry]) => key.startsWith('quota/') && !entry.data.available).length, 3)
})

test('concurrent guest audio attempts reserve only one trial and keep job ownership', async () => {
  const f=fixture(), first=f.guest('quick'), jobs=[first,...Array.from({length:3},()=>({...f.guest('quick'),device:first.device}))]
  const results=await Promise.all(jobs.map(job=>f.init(job)))
  assert.equal(results.filter(r=>r.status===200).length,1)
  assert.equal(results.filter(r=>r.data.code==='SONG_CREDITS_EXHAUSTED').length,3)
  const owner=jobs[results.findIndex(r=>r.status===200)], other=f.guest('quick')
  for(const suffix of ['', '/start', '/advance', '/cancel', '/recover']) {
    const method=['','/recover'].includes(suffix)?'GET':'POST'
    assert.equal((await f.request(`/jobs/${owner.id}${suffix}`,{...other,token:owner.token},method)).status,404)
    assert.equal((await f.request(`/jobs/${owner.id}${suffix}`,{...owner,token:'b'.repeat(64)},method)).status,404)
  }
  assert.equal((await f.request('/jobs',{...other,token:owner.token},'POST',{id:owner.id,name:owner.name,mode:owner.mode,size:owner.size})).status,404)
  assert.equal(f.calls.length,0)
  await Promise.all([f.request(`/jobs/${owner.id}/start`,owner),f.request(`/jobs/${owner.id}/start`,owner)])
  assert.equal(f.calls.length,1)
})

test('guest cancellation and expiry refund only unstarted trials; global budgets stay enforced',async()=>{
  const f=fixture({monthlyJobs:1}), job=f.guest('quick')
  await f.init(job);await f.request(`/jobs/${job.id}/cancel`,job)
  assert.equal((await f.request('/credits',job,'GET')).data.remaining,1)
  const expired={...f.guest('quick'),device:job.device}
  await f.init(expired);f.tick(31*60*1000)
  assert.equal((await f.request(`/jobs/${expired.id}/start`,expired)).data.status,'failed')
  assert.equal(f.calls.length,0)
  const paid={...f.guest('quick'),device:job.device}
  await f.init(paid);await f.request(`/jobs/${paid.id}/start`,paid);await f.request(`/jobs/${paid.id}/cancel`,paid)
  assert.equal((await f.request('/credits',paid,'GET')).data.remaining,0)
  assert.equal((await f.init(f.guest('quick'))).data.code,'MONTHLY_LIMIT_REACHED')
  assert.equal(f.calls.length,1)
})

test('guest Thorough stages and retries consume one trial without duplicate stages',async()=>{
  const f=fixture(),job=f.guest('thorough')
  await f.init(job);await f.request(`/jobs/${job.id}/start`,job)
  for(let i=0;i<4;i++)await Promise.all([f.request(`/jobs/${job.id}/advance`,job),f.request(`/jobs/${job.id}/advance`,job)])
  assert.equal((await f.request(`/jobs/${job.id}`,job,'GET')).data.status,'complete')
  assert.equal(f.calls.length,3)
  assert.equal((await f.request('/credits',job,'GET')).data.remaining,0)
})

test('legacy guest jobs cannot start or advance by request or webhook; existing results remain read-only',async()=>{
  for(const mode of ['quick','thorough']){
    const f=fixture(),job=f.job(mode)
    await f.init(job);await f.request(`/jobs/${job.id}/start`,job)
    // Simulate a real pre-policy guest job without creating another provider job.
    const row=f.entries.get(`job/${job.id}`).data
    row.ownerKey='guest/'+createHash('sha256').update(job.device).digest('hex')
    const guest={...job,account:null}
    assert.equal((await f.request(`/jobs/${job.id}`,guest,'GET')).status,200)
    for(const action of ['start','advance'])assert.equal((await f.request(`/jobs/${job.id}/${action}`,guest)).data.code,'SIGN_IN_REQUIRED')
    const hook=createHmac('sha256',KEY).update(`mvsep-webhook:${job.id}`).digest('hex')
    assert.equal((await f.request(`/jobs/${job.id}/webhook?hook=${hook}`,null)).status,200)
    assert.equal(f.calls.length,1)
    const recovered=await f.request(`/jobs/${job.id}/recover`,guest,'GET')
    assert.equal(recovered.status,mode==='quick'?200:400)
    if(mode==='quick')assert.equal(recovered.data.stems.length,6)
    assert.equal(f.calls.length,1)
  }
})

test('expired sessions and another account cannot resume paid work or adopt a legacy guest reservation',async()=>{
  const f=fixture({verifyUser:async token=>token==='expired'?null:{id:token}}),job=f.job()
  await f.init(job)
  for(const action of ['start','advance']){
    assert.equal((await f.request(`/jobs/${job.id}/${action}`,job,'POST',null,{'X-Mix-Room-Account':'expired'})).status,401)
    assert.equal((await f.request(`/jobs/${job.id}/${action}`,job,'POST',null,{'X-Mix-Room-Account':'another-user'})).status,404)
    assert.equal((await f.request(`/jobs/${job.id}/${action}`,{...job,account:null})).status,404)
  }
  assert.equal(f.calls.length,0)
  assert.equal((await f.request(`/jobs/${job.id}/start`,job)).status,200)
  assert.equal((await f.request(`/jobs/${job.id}/start`,job)).status,200)
  assert.equal(f.calls.length,1)
})

test('paused Thorough runs new and already-uploaded jobs as a single six-stem Quick job', async () => {
  assert.equal(separationConfig({}).thoroughPaused, true)
  assert.equal(separationConfig({ SEPARATION_THOROUGH_ENABLED: 'true' }).thoroughPaused, false)

  const f = fixture({ thoroughPaused: true }), fresh = f.job('thorough')
  assert.equal((await f.init(fresh)).status, 200)
  assert.equal(f.entries.get(`job/${fresh.id}`).data.mode, 'quick')
  // A repeated create from the same older page still matches the saved job.
  assert.equal((await f.init(fresh)).status, 200)
  await f.request(`/jobs/${fresh.id}/start`, fresh)
  assert.equal((await f.request(`/jobs/${fresh.id}/advance`, fresh)).data.status, 'complete')
  assert.deepEqual(f.calls.map(call => call.stage), ['quick'])

  // A Thorough job uploaded before the pause is submitted as Quick when started.
  const before = fixture(), uploaded = before.job('thorough')
  await before.init(uploaded)
  const paused = fixture({ thoroughPaused: true, durableStore: before.store })
  await paused.request(`/jobs/${uploaded.id}/start`, uploaded)
  assert.deepEqual(paused.calls.map(call => call.stage), ['quick'])
})
