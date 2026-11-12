import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanupMixUploads } from './cleanup.js'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
test('cleanup is dry by default and never removes the referenced saved version', async () => {
  const removed = [], deleted = [], now = Date.now()
  const uploads = [1, 2].map(n => ({ id: id(n), owner_id: id(3), mix_id: id(4), expires_at: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString() }))
  const repository = { expiredUploads: async () => uploads, get: async () => ({ object_id: id(2) }), deleteUpload: async (...args) => deleted.push(args) }
  const storage = { remove: async key => removed.push(key) }
  assert.equal((await cleanupMixUploads({ repository, storage, now })).orphaned, 1)
  assert.equal(removed.length, 0)
  const result = await cleanupMixUploads({ repository, storage, now, apply: true })
  assert.equal(result.failed, 0)
  assert.ok(removed.includes(`saved/${id(3)}/${id(1)}.mixroom`))
  assert.ok(!removed.includes(`saved/${id(3)}/${id(2)}.mixroom`))
  assert.equal(deleted.length, 2)
})
test('cleanup rejects malformed identities and leaves failed work for a later run', async () => {
  let deleted = false
  const repository = { expiredUploads: async () => [{ id: '../../bad', owner_id: id(1), mix_id: id(2) }, { id: id(3), owner_id: id(1), mix_id: id(2) }], get: async () => null, deleteUpload: async () => { deleted = true } }
  const result = await cleanupMixUploads({ repository, storage: { remove: async () => { throw new Error('offline') } }, apply: true })
  assert.equal(result.failed, 2); assert.equal(deleted, false)
})

test('cleanup cannot remove any objects when a saved-reference lookup is unavailable', async () => {
  const removed = [], deleted = []
  const repository = {
    expiredUploads: async () => [{ id: id(1), owner_id: id(2), mix_id: id(3) }],
    get: async () => { throw new Error('database unavailable') },
    deleteUpload: async (...args) => deleted.push(args),
  }
  const result = await cleanupMixUploads({ repository, storage: { remove: async key => removed.push(key) }, apply: true })
  assert.equal(result.failed, 1)
  assert.deepEqual(removed, [])
  assert.deepEqual(deleted, [])
})
