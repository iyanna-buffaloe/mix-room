import test from 'node:test'
import assert from 'node:assert/strict'
import { createMixClient } from './mixClient.js'

test('retrying an ambiguous commit reuses its upload and does not create another mix', async () => {
  const calls = []; let commits = 0
  const client = createMixClient({ getAccessToken: async () => 'private-jwt', fetcher: async (url, options) => {
    calls.push([url, options])
    if (url === '/api/mixes/uploads') return Response.json({ uploadUrl: 'https://storage.example/upload' })
    if (url.startsWith('https://')) return new Response('', { status: 200 })
    if (++commits === 1) throw new TypeError('network')
    return Response.json({ mix: { id: 'same-mix', revision: 1 } })
  } })
  const attempt = { uploadId: crypto.randomUUID(), mixId: crypto.randomUUID(), name: 'Night drive' }, archive = new Blob(['archive'])
  await assert.rejects(client.save(archive, attempt), /could not be reached/)
  assert.equal(attempt.uploaded, true)
  assert.equal((await client.save(archive, attempt)).id, 'same-mix')
  assert.equal(calls.filter(([url]) => url === '/api/mixes/uploads').length, 1)
  assert.equal(calls.filter(([url]) => url.startsWith('https://')).length, 1)
  assert.equal(calls.find(([url]) => url.startsWith('https://'))[1].headers.Authorization, undefined)
})

test('private downloads disable caching and reject incomplete or oversized responses', async () => {
  let declared = 100, actual = 99
  const client = createMixClient({ getAccessToken: async () => 'private-jwt', fetcher: async (url, options) => {
    if (url.startsWith('/api')) { assert.equal(options.headers.Authorization, 'Bearer private-jwt'); return Response.json({ mix: { bytes: declared }, downloadUrl: 'https://storage.example/download' }) }
    assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined)
    return new Response(new Uint8Array(actual))
  } })
  await assert.rejects(client.open('mix'), /interrupted/)
  actual = 101; await assert.rejects(client.open('mix'), /too large/)
  declared = 167772161; await assert.rejects(client.open('mix'), /download limit/)
})

for (const stage of ['preparing', 'committing']) test(`an expired save while ${stage} can retry with a fresh upload without losing the mix identity`, async () => {
  const uploadIds = [], commits = []
  let expired = true, uploads = 0
  const client = createMixClient({ getAccessToken: async () => 'private-jwt', fetcher: async (url, options) => {
    if (url === '/api/mixes/uploads') {
      uploadIds.push(JSON.parse(options.body).uploadId)
      if (expired && stage === 'preparing') return Response.json({ error: 'Start a new save.', code: 'UPLOAD_EXPIRED' }, { status: 409 })
      return Response.json({ uploadUrl: 'https://storage.example/upload' })
    }
    if (url.startsWith('https://')) { uploads++; return new Response('', { status: 200 }) }
    commits.push(JSON.parse(options.body).uploadId)
    if (expired) return Response.json({ error: 'Start a new save.', code: 'UPLOAD_EXPIRED' }, { status: 409 })
    return Response.json({ mix: { id: 'same-mix', revision: 2 } })
  } })
  const initialId = crypto.randomUUID(), mixId = crypto.randomUUID()
  const attempt = { uploadId: initialId, mixId, expectedRevision: 1, name: 'Draft stays open' }
  const archive = new Blob(['unchanged archive'])
  await assert.rejects(client.save(archive, attempt), { code: 'UPLOAD_EXPIRED' })
  assert.notEqual(attempt.uploadId, initialId)
  assert.equal(attempt.uploaded, false)
  assert.equal(attempt.mixId, mixId)
  assert.equal(attempt.expectedRevision, 1)
  expired = false
  assert.equal((await client.save(archive, attempt)).id, 'same-mix')
  assert.equal(uploadIds.length, 2)
  assert.equal(uploads, stage === 'preparing' ? 1 : 2)
  assert.equal(commits.at(-1), attempt.uploadId)
})

test('a session renewed after upload retries only commit with the current token', async () => {
  let token = 'expired-account-token', uploads = 0
  const calls = []
  const client = createMixClient({ getAccessToken: async () => token, fetcher: async (url, options) => {
    calls.push([url, options.headers.Authorization])
    if (url === '/api/mixes/uploads') return Response.json({ uploadUrl: 'https://storage.example/upload' })
    if (url.startsWith('https://')) { uploads++; return new Response('', { status: 200 }) }
    if (token === 'expired-account-token') return Response.json({ error: 'Sign in again.', code: 'SIGN_IN_REQUIRED' }, { status: 401 })
    return Response.json({ mix: { id: 'same-mix', revision: 1 } })
  } })
  const attempt = { uploadId: crypto.randomUUID(), mixId: crypto.randomUUID(), name: 'Keep this draft' }
  const id = attempt.uploadId, archive = new Blob(['archive'])
  await assert.rejects(client.save(archive, attempt), { code: 'SIGN_IN_REQUIRED' })
  token = 'renewed-account-token'
  assert.equal((await client.save(archive, attempt)).revision, 1)
  assert.equal(attempt.uploadId, id)
  assert.equal(uploads, 1)
  assert.equal(calls.at(-1)[1], 'Bearer renewed-account-token')
})
