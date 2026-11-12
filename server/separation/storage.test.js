import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createR2Storage, createLocalStore } from './storage.js'

test('R2 signed uploads bind file length and expire without exposing the secret key or an empty-body checksum', async () => {
  const storage = createR2Storage({ R2_ACCOUNT_ID: 'test-account', R2_ACCESS_KEY_ID: 'public-access-id', R2_SECRET_ACCESS_KEY: 'private-signing-secret', R2_BUCKET_NAME: 'private-bucket' })
  const upload = new URL(await storage.uploadUrl('mix-room/uploads/job/source.wav', 1024))
  assert.equal(upload.searchParams.get('X-Amz-Expires'), '900')
  assert.ok(upload.searchParams.get('X-Amz-SignedHeaders').includes('content-length'))
  assert.ok(!upload.toString().includes('private-signing-secret'))
  assert.ok(![...upload.searchParams.keys()].some(key => key.includes('checksum')))
  const source = new URL(await storage.sourceUrl('mix-room/uploads/job/source.wav'))
  assert.equal(source.searchParams.get('X-Amz-Expires'), '86400')
})

test('local durable state survives reopening and conditional writes serialize competing updates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-room-separation-state-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = createLocalStore(root)
  const results = await Promise.all([store.setJSON('job/id', { value: 1 }, { onlyIfNew: true }), store.setJSON('job/id', { value: 2 }, { onlyIfNew: true })])
  assert.equal(results.filter(result => result.modified).length, 1)
  const original = await store.getWithMetadata('job/id')
  const updates = await Promise.all([3, 4].map(value => store.setJSON('job/id', { value }, { onlyIfMatch: original.etag })))
  assert.equal(updates.filter(result => result.modified).length, 1)
  assert.equal((await createLocalStore(root).getWithMetadata('job/id')).data.value, 3)
  const [file] = await fs.readdir(root)
  assert.equal((await fs.stat(path.join(root, file))).mode & 0o777, 0o600)
})
