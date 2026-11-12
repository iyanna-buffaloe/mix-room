import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { runSeparation, separationRequest, uploadAudio, mvsepResultHash, loadExistingSeparation, recoverSeparation } from './separationClient.js'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
before(() => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'd'.repeat(64), setItem() {} } }))
after(() => { if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage })

test('a refreshed completed upload resumes its existing job instead of initiating another paid job', async t => {
  const original = globalThis.fetch, calls = []
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method })
    return Response.json(url.endsWith('/start') ? { status: 'failed', percent: 8, message: 'Fixture stops before a paid request' } : { status: 'uploading', percent: 3 })
  }
  const job = { id: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), mode: 'quick', name: 'song.wav' }
  await assert.rejects(runSeparation({ existingJob: job, signal: new AbortController().signal, onProgress: () => {} }), /Fixture stops/)
  assert.deepEqual(calls.map(call => [call.url.split('/').pop(), call.method]), [[job.id, 'GET'], ['start', 'POST']])
})

test('temporary service errors retain recovery information while invalid jobs carry their HTTP status', async () => {
  await assert.rejects(separationRequest('/jobs/id', null, { fetcher: async () => Response.json({ error: 'temporarily offline' }, { status: 503 }) }), failure => failure.recoverable && failure.status === 503)
  await assert.rejects(separationRequest('/jobs/id', null, { fetcher: async () => Response.json({ error: 'not found' }, { status: 404 }) }), failure => !failure.recoverable && failure.status === 404)
})

test('monthly allowance errors preserve their reason for public wording and diagnostics', async () => {
  await assert.rejects(separationRequest('/jobs', null, {
    fetcher: async () => Response.json({ error: 'This month’s separation allowance has been reached.', code: 'MONTHLY_LIMIT_REACHED' }, { status: 429 }),
  }), failure => failure.status === 429 && failure.code === 'MONTHLY_LIMIT_REACHED' && !failure.recoverable)
})

test('raw failure details are retained for diagnostics without flashing in the progress overlay', async t => {
  const original = globalThis.fetch, progress = [], states = []
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => Response.json({ status: 'failed', message: 'MVSEP private diagnostic', percent: 60 })
  const job = { id: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), name: 'song.wav', mode: 'quick' }
  await assert.rejects(runSeparation({ existingJob: job, signal: new AbortController().signal, onProgress: value => progress.push(value), onState: value => states.push(value) }), /private diagnostic/)
  assert.equal(progress.length, 0); assert.equal(states[0].message, 'MVSEP private diagnostic')
})

test('retrying a failed job only reads its existing result and never invokes start or advance', async t => {
  const original = globalThis.fetch, calls = []
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, options) => { calls.push({ url, method: options.method }); return Response.json({ error: 'existing job is not ready' }, { status: 409 }) }
  const job = { id: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), name: 'existing.wav', mode: 'quick' }
  await assert.rejects(recoverSeparation(job, { signal: new AbortController().signal, onProgress: () => {} }), /not ready/)
  assert.deepEqual(calls, [{ url: `/api/separation/jobs/${job.id}/recover`, method: 'GET' }])
})

test('existing result recovery accepts MVSEP links and hashes and only reads results', async t => {
  const hash = '20261012151531-072e2331ad-source.wav'
  assert.equal(mvsepResultHash(`https://www.mvsep.com/result/${hash}`), hash)
  assert.equal(mvsepResultHash(` ${hash} `), hash)
  for (const invalid of ['https://mvsep.com.attacker.test/result/a', 'https://user:password@mvsep.com/result/a', 'http://mvsep.com/result/a', 'https://mvsep.com/api/separation/create', '../path']) assert.throws(() => mvsepResultHash(invalid))
  const original = globalThis.fetch, calls = []
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, options) => { calls.push({ url, method: options.method }); return Response.json({ error: 'Fixture stops before analysis' }, { status: 400 }) }
  await assert.rejects(loadExistingSeparation(hash, { signal: new AbortController().signal, onProgress: () => {} }), /Fixture stops/)
  assert.deepEqual(calls, [{ url: `/api/separation/results?hash=${hash}`, method: 'GET' }])
})

test('R2 upload failures distinguish browser blocking, timeout, and storage rejection without revealing signed URLs', async t => {
  const original = globalThis.XMLHttpRequest
  t.after(() => { globalThis.XMLHttpRequest = original })
  let failure, status
  globalThis.XMLHttpRequest = class {
    upload = {}
    open() {}
    setRequestHeader() {}
    send() { this.status = status; queueMicrotask(() => this[failure]()) }
  }
  for (const [event, httpStatus, expected] of [
    ['onerror', 0, /CORS policy/],
    ['ontimeout', 0, /timed out after 10 minutes/],
    ['onload', 403, /HTTP 403.*access credentials/],
    ['onload', 404, /HTTP 404.*R2_BUCKET_NAME/],
    ['onload', 500, /HTTP 500.*storage setup/],
  ]) {
    failure = event; status = httpStatus
    await assert.rejects(uploadAudio('https://storage.invalid/?secret=signed-token', new Blob(), new AbortController().signal, () => {}), error => expected.test(error.message) && !error.message.includes('signed-token'))
  }
  failure = 'onload'; status = 200
  await uploadAudio('https://storage.invalid/', new Blob(), new AbortController().signal, () => {})
})

test('account JWTs and job capabilities use different headers; storage requests never receive either', async () => {
  let captured
  const job = { token: 'capability-secret' }
  await separationRequest('/jobs/id', job, { accountToken: 'account-jwt', fetcher: async (_url, options) => { captured = options.headers; return Response.json({}) } })
  assert.equal(captured.Authorization, 'Bearer capability-secret')
  assert.equal(captured['X-Mix-Room-Account'], 'account-jwt')
  assert.equal(captured['X-Mix-Room-Device'], undefined)
})
