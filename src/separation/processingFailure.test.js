import test from 'node:test'
import assert from 'node:assert/strict'
import { processingFailureReport, rememberProcessingFailure, savedProcessingFailure, forgetProcessingFailure, publicProcessingFailureMessage } from './processingFailure.js'

test('recovery survives refresh but copied reports omit tokens and signed URLs', t => {
  const original = globalThis.sessionStorage, values = new Map()
  t.after(() => { globalThis.sessionStorage = original })
  globalThis.sessionStorage = { setItem: (k, v) => values.set(k, v), getItem: k => values.get(k), removeItem: k => values.delete(k) }
  const failure = { name: 'My song.wav', message: 'Unable to read https://storage.invalid/?secret=private-url Bearer private-bearer', job: { id: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), mode: 'quick', name: 'My song.wav' }, providerJobs: [{ stage: 'quick', hash: 'existing-job.wav' }] }
  rememberProcessingFailure(failure)
  assert.deepEqual(savedProcessingFailure(), failure)
  const report = processingFailureReport(failure)
  for (const secret of [failure.job.token, 'private-url', 'private-bearer']) assert.ok(!report.includes(secret))
  assert.ok(report.includes('existing-job.wav'))
  forgetProcessingFailure(); assert.equal(savedProcessingFailure(), null)
})

test('public errors keep useful constraints but omit provider messages and developer instructions', () => {
  const failure = { message: 'MVSEP returned an incomplete vocals stem set. Missing: lead_vocals. Job private-job.', job: { id: 'private-job' } }
  const message = publicProcessingFailureMessage(failure)
  assert.ok(message.includes('loading your song'))
  for (const detail of ['MVSEP', 'lead_vocals', 'private-job']) assert.ok(!message.includes(detail))
  assert.match(processingFailureReport(failure), /incomplete vocals stem set/)
  assert.equal(publicProcessingFailureMessage({ message: 'Choose a song no longer than 6 minutes.' }), 'Please choose a song no longer than 6 minutes.')
  assert.match(publicProcessingFailureMessage({ message: 'This audio file is too large. Choose a file under 300 MB.' }), /under 300 MB/)
  assert.ok(!publicProcessingFailureMessage({ message: 'R2 permissions invalid; secret server configuration', httpStatus: 503 }).includes('R2'))
})

test('monthly allowance, short rate limits, and outages have distinct public messages', () => {
  const expected = 'The site’s monthly song processing limit has been reached. You can still upload your own stems.'
  assert.equal(publicProcessingFailureMessage({ httpStatus: 429, code: 'MONTHLY_LIMIT_REACHED' }), expected)
  // Saved failures and an older deployed API have no structured error code.
  assert.equal(publicProcessingFailureMessage({ httpStatus: 429, message: 'This month’s separation allowance has been reached. You can still upload your own stems.' }), expected)
  assert.match(publicProcessingFailureMessage({ httpStatus: 429, message: 'Too many requests' }), /wait a minute/)
  assert.match(publicProcessingFailureMessage({ httpStatus: 503 }), /temporarily unavailable/)
  assert.equal(JSON.parse(processingFailureReport({ code: 'MONTHLY_LIMIT_REACHED', httpStatus: 429 })).code, 'MONTHLY_LIMIT_REACHED')
})
