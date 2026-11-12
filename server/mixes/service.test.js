import test from 'node:test'
import assert from 'node:assert/strict'
import { createMixService, savedMixConfig } from './service.js'
import { createMixArchive } from '../../src/audio/mixArchive.js'

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
function setup() {
  const rows = new Map(), uploads = new Map(), objects = new Map(), calls = []
  let failCommit = false
  const repository = {
    verifyToken: async token => token === 'valid' ? { id: owner } : token === 'other' ? { id: other } : null,
    list: async id => [...rows.values()].filter(row => row.owner_id === id),
    get: async (id, mix) => rows.get(mix)?.owner_id === id ? rows.get(mix) : null,
    getUpload: async (id, upload) => uploads.get(upload)?.owner_id === id ? uploads.get(upload) : null,
    beginUpload: async row => { if (!uploads.has(row.id)) uploads.set(row.id, { ...row, expires_at: new Date(Date.now() + 900000).toISOString() }); return uploads.get(row.id) },
    commit: async (id, uploadId, bytes) => {
      if (failCommit) throw new Error('database secret')
      const upload = uploads.get(uploadId), old = rows.get(upload.mix_id)
      if (old?.object_id === uploadId) return old
      if (upload.committed_at || (upload.expected_revision != null && old?.revision !== upload.expected_revision)) throw new Error('MIX_CHANGED')
      if (!old && (await repository.list(id)).length >= 3) throw new Error('MIX_LIMIT')
      const row = { id: upload.mix_id, owner_id: id, name: upload.name, object_id: uploadId, object_key: `saved/${id}/${uploadId}.mixroom`, bytes, revision: (old?.revision ?? 0) + 1, updated_at: new Date().toISOString() }
      rows.set(row.id, row); upload.committed_at = new Date().toISOString(); return row
    },
    rename: async (id, row, name) => { const next = { ...row, name, revision: row.revision + 1 }; rows.set(row.id, next); return next },
    delete: async (id, row) => rows.delete(row.id),
  }
  const storage = {
    uploadUrl: async key => { calls.push(['upload', key]); return `https://storage.example/${key}` },
    downloadUrl: async key => `https://storage.example/${key}`,
    inspect: async key => { const blob = objects.get(key); if (!blob) throw new Error('missing file'); return { bytes: blob.size, header: new Uint8Array(await blob.slice(0, 12).arrayBuffer()) } },
    copy: async (from, to) => { calls.push(['copy', from, to]); if (!objects.has(from)) throw new Error('copy failed'); objects.set(to, objects.get(from)) },
    remove: async key => { calls.push(['remove', key]); objects.delete(key) },
  }
  const config = { available: true, limit: 3 }
  const service = createMixService({ config, repository, storage })
  const request = async (path = '', method = 'GET', body, token = 'valid', headers = {}) => {
    const response = await service(new Request(`https://mix.example/api/mixes${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return { status: response.status, body: await response.json() }
  }
  const record = { version: 1, id: crypto.randomUUID(), audioBlob: new Blob([new Uint8Array(100)]), metadata: { title: 'Original', instruments: [{ key: 'guitar', label: 'Guitar' }] }, framesByKey: { guitar: [] } }
  const archive = createMixArchive(record)
  const prepare = async (mixId = crypto.randomUUID(), expectedRevision = null, name = 'Night drive') => {
    const uploadId = crypto.randomUUID(), payload = { uploadId, mixId, expectedRevision, name, bytes: archive.size }
    const response = await request('/uploads', 'POST', payload)
    if (response.status === 200) objects.set(`incoming/${owner}/${uploadId}.mixroom`, archive)
    return { uploadId, mixId, payload, response }
  }
  return { request, prepare, rows, uploads, objects, calls, archive, service, storage, repository, fail: value => { failCommit = value } }
}

test('configuration fails closed and never returns server credentials', async () => {
  assert.equal(savedMixConfig({}).available, false)
  const env = { VITE_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'private-secret', R2_ACCOUNT_ID: 'private', R2_ACCESS_KEY_ID: 'private', R2_SECRET_ACCESS_KEY: 'private', R2_SAVED_MIXES_BUCKET_NAME: 'durable' }
  const config = savedMixConfig(env)
  assert.equal(config.available, true); assert.equal(JSON.stringify(config).includes('private'), false)
  const service = createMixService({ config: savedMixConfig({}) })
  assert.equal((await service(new Request('https://mix.example/api/mixes'))).status, 503)
})
test('authentication, owner isolation, same-origin writes, and safe validation protect the library', async () => {
  const env = setup()
  assert.equal((await env.request('', 'GET', null, 'invalid')).status, 401)
  const prepared = await env.prepare()
  await env.request('/commit', 'POST', { uploadId: prepared.uploadId })
  assert.equal((await env.request('', 'GET', null, 'other')).body.mixes.length, 0)
  assert.equal((await env.request(`/${prepared.mixId}`, 'GET', null, 'other')).status, 404)
  assert.equal((await env.request('/commit', 'POST', { uploadId: prepared.uploadId }, 'other')).status, 404)
  assert.equal((await env.request(`/${prepared.mixId}`, 'DELETE', { revision: 1 }, 'valid', { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await env.request('/uploads', 'POST', { ...prepared.payload, uploadId: crypto.randomUUID(), name: ' ' })).status, 400)
  assert.equal((await env.request('/uploads', 'POST', { ...prepared.payload, bytes: 167772161 })).status, 400)
})
test('a successful commit is durable, idempotent, private, and downloadable without another processing job', async () => {
  const env = setup(), prepared = await env.prepare()
  const first = await env.request('/commit', 'POST', { uploadId: prepared.uploadId })
  assert.equal(first.status, 200)
  assert.equal(first.body.mix.revision, 1)
  const again = await env.request('/commit', 'POST', { uploadId: prepared.uploadId })
  assert.deepEqual(again.body.mix, first.body.mix)
  assert.equal(env.rows.size, 1)
  assert.equal(env.calls.filter(call => call[0] === 'copy').length, 1)
  assert.equal(env.objects.has(`saved/${owner}/${prepared.uploadId}.mixroom`), true)
  const opened = await env.request(`/${prepared.mixId}`)
  assert.equal(opened.status, 200); assert.ok(opened.body.downloadUrl.startsWith('https://'))
  assert.equal(JSON.stringify(first.body).includes('owner_id'), false)
})
test('failed replacement preserves the old file and draft; retry commits before old-file deletion', async () => {
  const env = setup(), original = await env.prepare()
  await env.request('/commit', 'POST', { uploadId: original.uploadId })
  const replacement = await env.prepare(original.mixId, 1, 'New version')
  env.fail(true)
  const failed = await env.request('/commit', 'POST', { uploadId: replacement.uploadId })
  assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed).includes('database secret'), false)
  assert.equal(env.rows.get(original.mixId).revision, 1)
  assert.equal(env.objects.has(`saved/${owner}/${original.uploadId}.mixroom`), true)
  env.fail(false)
  const saved = await env.request('/commit', 'POST', { uploadId: replacement.uploadId })
  assert.equal(saved.body.mix.revision, 2)
  assert.equal(env.objects.has(`saved/${owner}/${original.uploadId}.mixroom`), false)
})
test('corrupted uploads and stale updates cannot overwrite a saved mix', async () => {
  const env = setup(), first = await env.prepare()
  env.objects.set(`incoming/${owner}/${first.uploadId}.mixroom`, new Blob([new Uint8Array(env.archive.size)]))
  assert.equal((await env.request('/commit', 'POST', { uploadId: first.uploadId })).status, 400)
  assert.equal(env.rows.size, 0)
  env.objects.set(`incoming/${owner}/${first.uploadId}.mixroom`, env.archive)
  await env.request('/commit', 'POST', { uploadId: first.uploadId })
  await env.request(`/${first.mixId}`, 'PATCH', { revision: 1, name: 'Renamed' })
  assert.equal((await env.request(`/${first.mixId}`, 'DELETE', { revision: 1 })).status, 409)
  assert.equal((await env.prepare(first.mixId, 1)).response.status, 409)
  assert.equal(env.rows.get(first.mixId).name, 'Renamed')
})
test('a full library rejects a fourth mix; deletion frees a place', async () => {
  const env = setup()
  for (let n = 0; n < 3; n++) { const prepared = await env.prepare(); await env.request('/commit', 'POST', { uploadId: prepared.uploadId }) }
  assert.equal((await env.prepare()).response.status, 409)
  const row = [...env.rows.values()][0]
  assert.equal((await env.request(`/${row.id}`, 'DELETE', { revision: row.revision })).status, 200)
  assert.equal((await env.prepare()).response.status, 200)
})

test('storage outages during replacement keep the saved version and allow retry', async () => {
  const env = setup(), first = await env.prepare()
  await env.request('/commit', 'POST', { uploadId: first.uploadId })
  const replacement = await env.prepare(first.mixId, 1, 'Recovered version')
  const copy = env.storage.copy
  env.storage.copy = async () => { throw new Error('private storage outage') }
  const failed = await env.request('/commit', 'POST', { uploadId: replacement.uploadId })
  assert.equal(failed.status, 503)
  assert.doesNotMatch(JSON.stringify(failed), /private storage/)
  assert.equal(env.rows.get(first.mixId).revision, 1)
  assert.equal(env.objects.has(`saved/${owner}/${first.uploadId}.mixroom`), true)
  env.storage.copy = copy
  assert.equal((await env.request('/commit', 'POST', { uploadId: replacement.uploadId })).body.mix.revision, 2)
})

test('a committed replacement with a lost database response is recovered without another revision', async () => {
  const env = setup(), first = await env.prepare()
  await env.request('/commit', 'POST', { uploadId: first.uploadId })
  const replacement = await env.prepare(first.mixId, 1, 'Once only')
  const commit = env.repository.commit
  env.repository.commit = async (...args) => { await commit(...args); throw new Error('response lost') }
  assert.equal((await env.request('/commit', 'POST', { uploadId: replacement.uploadId })).status, 503)
  assert.equal(env.rows.get(first.mixId).revision, 2)
  const retried = await env.request('/commit', 'POST', { uploadId: replacement.uploadId })
  assert.equal(retried.status, 200)
  assert.equal(retried.body.mix.revision, 2)
  assert.equal(env.rows.size, 1)
  assert.equal(env.objects.has(`saved/${owner}/${replacement.uploadId}.mixroom`), true)
})

test('explicit expired and missing uploads are distinguishable from ambiguous service failures', async () => {
  const env = setup(), pending = await env.prepare()
  env.uploads.get(pending.uploadId).expires_at = new Date(Date.now() - 1).toISOString()
  const expired = await env.request('/commit', 'POST', { uploadId: pending.uploadId })
  assert.equal(expired.body.code, 'UPLOAD_EXPIRED')
  assert.equal(env.rows.size, 0)
  env.uploads.delete(pending.uploadId)
  const missing = await env.request('/commit', 'POST', { uploadId: pending.uploadId })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'UPLOAD_NOT_FOUND')
})
