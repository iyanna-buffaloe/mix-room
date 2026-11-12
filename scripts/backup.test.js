import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { capture, verifyCapture, validateRows, creditKey, validateConfig, checkBudget, oldestRemovable, TAG } from './backups/core.mjs'
import { launchAgent } from './backups/run.mjs'
import { command } from './backups/macos.mjs'

async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mix-room-backup-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const bytes = randomBytes(4096), owner = randomUUID(), object = randomUUID()
  const row = { id: randomUUID(), owner_id: owner, object_id: object, object_key: `saved/${owner}/${object}.mixroom`, bytes: bytes.length }
  const calls = [], database = { async open() {
    calls.push('snapshot')
    return { rows: [row], dump: file => writeFile(file, 'fixture-db'), roles: file => writeFile(file, 'fixture-roles'), close: async () => { calls.push('closed') } }
  } }
  const objects = { head: async () => ({ bytes: bytes.length, etag: 'one' }), get: async (_key, etag) => {
    assert.equal(etag, 'one'); calls.push('download'); return Readable.from([bytes])
  } }
  const credits = { read: async () => [{ key: 'quota/2026-10/0', data: { charged: true } }] }
  return { folder, bytes, row, calls, database, objects, credits }
}

test('backup pairs a database snapshot, exact audio hashes and stable credit records', async t => {
  const f = await fixture(t)
  const captured = await capture(f), restored = await verifyCapture(f.folder)
  assert.deepEqual(restored, captured)
  assert.equal(restored.files.length, 5)
  assert.deepEqual(f.calls, ['snapshot', 'download', 'closed'])
  assert.match(restored.restorePaidProcessing, /DISABLED/)
})

test('unchanged audio is checked locally and remotely then reused without downloading', async t => {
  const f = await fixture(t), previous = await capture(f)
  f.calls.length = 0
  await capture({ ...f, previous })
  assert.deepEqual(f.calls, ['snapshot', 'closed'])
  await verifyCapture(f.folder)
})

test('a same-size corrupted staged file is downloaded again, and restored corruption is rejected', async t => {
  const f = await fixture(t), previous = await capture(f)
  const audio = path.join(f.folder, f.row.object_key)
  await writeFile(audio, randomBytes(f.bytes.length))
  f.calls.length = 0
  await capture({ ...f, previous })
  assert.ok(f.calls.includes('download'))
  await writeFile(audio, randomBytes(f.bytes.length))
  await assert.rejects(verifyCapture(f.folder), /BACKUP_CHECKSUM_FAILED/)
})

test('missing audio, a short download and overlong download cannot produce a completed backup', async t => {
  for (const kind of ['missing', 'short', 'long']) {
    const f = await fixture(t)
    if (kind === 'missing') f.objects.head = async () => { throw Error('missing') }
    else f.objects.get = async () => Readable.from([Buffer.alloc(f.bytes.length + (kind === 'short' ? -1 : 1))])
    await assert.rejects(capture(f))
    await assert.rejects(readFile(path.join(f.folder, 'manifest.json')))
    assert.equal(f.calls.at(-1), 'closed')
  }
})

test('changing credits or failed database exports reject the new capture and close its transaction', async t => {
  const f = await fixture(t)
  let version = 0
  f.credits.read = async () => [{ key: 'quota/2026-10/0', data: ++version }]
  await assert.rejects(capture(f), /CREDITS_CHANGED_RETRY/)
  assert.equal(f.calls.at(-1), 'closed')
  const g = await fixture(t)
  g.database.open = async () => ({ rows: [g.row], dump: async () => { throw Error('export failed') }, close: async () => { g.calls.push('closed') } })
  await assert.rejects(capture(g), /export failed/)
  assert.equal(g.calls.at(-1), 'closed')
})

test('capacity failure happens before exporting or downloading private data', async t => {
  const f = await fixture(t)
  await assert.rejects(capture({ ...f, reserve: async () => { throw Error('full') } }), /full/)
  assert.deepEqual(f.calls, ['snapshot', 'closed'])
})

test('manifest paths cannot escape to temporary uploads or another owner', async t => {
  const f = await fixture(t)
  for (const key of ['../outside', 'incoming/x', `saved/${randomUUID()}/${f.row.object_id}.mixroom`]) {
    assert.throws(() => validateRows([{ ...f.row, object_key: key }]), /INVALID_MIX_MANIFEST/)
  }
  assert.throws(() => validateRows([f.row, f.row]), /INVALID_MIX_MANIFEST/)
})

test('symlinked staging and restore paths are refused', async t => {
  const f = await fixture(t), outside = path.join(f.folder, 'outside')
  await mkdir(outside); await symlink(outside, path.join(f.folder, 'linked'))
  await assert.rejects(capture(f), /SYMLINK_IN_BACKUP/)
  await assert.rejects(verifyCapture(f.folder), /SYMLINK_IN_BACKUP/)
})

test('hard budget leaves working room and never proposes deleting the newest good snapshot', () => {
  assert.doesNotThrow(() => checkBudget({ used: 39e9, additional: 10e9, free: 11e9 }))
  assert.throws(() => checkBudget({ used: 49e9, additional: 2e9, free: 20e9 }), /SPACE_LIMIT/)
  assert.throws(() => checkBudget({ used: 1e9, additional: 2e9, free: 2e9 }), /SPACE_LIMIT/)
  const snapshots = ['2026-10-01', '2026-10-02', '2026-10-03'].map((time, id) => ({ id, time, tags: [TAG, 'file-verified'] }))
  snapshots.push({ id: 3, time: '2026-10-04', tags: [TAG, 'candidate'] })
  assert.deepEqual(oldestRemovable(snapshots).map(s => s.id), [0, 1])
  assert.deepEqual(oldestRemovable([snapshots[0]]), [])
})

test('credit key allowlist and configuration reject unexpected services or paths', () => {
  assert.ok(creditKey('credits/account/abcdef/0'))
  assert.ok(creditKey('stem-trial/guest/abcdef'))
  for (const key of ['../quota/1', 'private/config', 'job/https://other', '']) assert.equal(creditKey(key), false)
  assert.throws(() => validateConfig({ version: 1, volume: '/private/tmp' }), /CONFIG_INCOMPLETE/)
})

test('scheduler contains no credentials and escapes paths correctly', () => {
  const xml = launchAgent('/path/with &/node', '/repo/a&b/run.mjs')
  assert.match(xml, /with &amp;/)
  assert.match(xml, /3600/)
  assert.doesNotMatch(xml, /PASSWORD|TOKEN|r2Secret/)
})

test('process failures never print captured private stderr or secret command arguments', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'process.stderr.write("private-value");process.exit(1)'], { code: 'SAFE_FAILURE' }), error => error.message === 'SAFE_FAILURE')
})
