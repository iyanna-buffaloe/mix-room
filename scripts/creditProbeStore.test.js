import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { creditProbeScope, creditDigest, createCreditProbeStore } from './fixtures/creditProbeStore.mjs'

const fixture = () => {
  const account = randomUUID(), device = 'a'.repeat(64), job = randomUUID()
  return { account, device, job, scope: creditProbeScope({ runId: randomUUID(), accountIds: [account], devices: [device], jobIds: [job] }) }
}
test('live credit probe keeps monthly slots and jobs outside the app namespace', () => {
  const { scope, job } = fixture()
  assert.equal(scope.keyFor('quota/2026-10/0'), scope.prefix+'quota/2026-10/0')
  assert.equal(scope.keyFor('job/'+job), scope.prefix+'job/'+job)
  assert.equal(scope.keyFor('cancel/'+job), scope.prefix+'cancel/'+job)
  assert.throws(() => scope.keyFor('job/'+randomUUID()), /unrelated/)
})
test('live credit probe refuses unrelated users, guest devices and arbitrary keys', () => {
  const { scope, account } = fixture()
  const own = `credits/account/${creditDigest(account)}/0`
  assert.equal(scope.keyFor(own), own)
  for (const key of [`credits/account/${creditDigest(randomUUID())}/0`, 'credits/guest/'+creditDigest('another-device')+'/0', 'stem-trial/account/unknown', 'anything']) {
    assert.throws(() => scope.keyFor(key), /unrelated/)
  }
  assert.equal(scope.owns('quota/2026-10/0'), false)
  assert.equal(scope.owns('saved/private.mixroom'), false)
})
test('live credit probe tracks ambiguous writes and cannot dispatch an unrelated write', async () => {
  const { scope, account } = fixture(), touched = new Set(), calls = []
  const raw = { setJSON: async key => { calls.push(key); throw new Error('response lost') } }
  const probe = createCreditProbeStore(raw, scope, touched)
  const own = `credits/account/${creditDigest(account)}/0`
  await assert.rejects(probe.setJSON(own, {}, { onlyIfNew: true }), /response lost/)
  assert.deepEqual([...touched], [own])
  assert.throws(() => probe.setJSON('quota/private/0', {}), /unrelated/)
  assert.equal(calls.length, 1)
})
