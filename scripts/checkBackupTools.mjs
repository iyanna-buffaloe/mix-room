import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { command } from './backups/macos.mjs'
import { capture, verifyCapture, TAG } from './backups/core.mjs'
import { Readable } from 'node:stream'

// Real Restic encryption/deduplication/restore with synthetic data only.
// No remote services, Keychain access, emails or existing backup repositories.
const base = process.env.MIX_ROOM_BACKUP_TEST_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-backup-tools-' + randomUUID())
await mkdir(base, { recursive: true, mode: 0o700 })
const repository = path.join(base, 'repository'), folder = path.join(base, 'capture'), restored = path.join(base, 'restored')
const password = randomBytes(32).toString('base64url')
const env = { RESTIC_PASSWORD: password, RESTIC_CACHE_DIR: path.join(base, 'cache'), TMPDIR: base }
const binary = process.env.RESTIC_BIN || '/opt/homebrew/bin/restic'
const restic = args => command(binary, ['--repo', repository, ...args], { env })
const bytes = randomBytes(2 * 1024 * 1024), owner = randomUUID(), object = randomUUID()
const row = { id: randomUUID(), owner_id: owner, object_id: object, object_key: `saved/${owner}/${object}.mixroom`, bytes: bytes.length }
let remoteReads = 0
const database = { open: async () => ({ rows: [row], dump: file => writeFile(file, 'synthetic-database-placeholder'),
  roles: file => writeFile(file, 'synthetic-roles-placeholder'), close: async () => {} }) }
const objects = { head: async () => ({ bytes: bytes.length, etag: 'fixture-one' }),
  get: async () => { remoteReads++; return Readable.from([bytes]) } }
const credits = { read: async () => [{ key: 'credits/account/fixture/0', data: { charged: true } }] }
const results = []
try {
  await restic(['init'])
  let previous = await capture({ folder, database, objects, credits })
  const summary = text => text.trim().split('\n').map(line => JSON.parse(line)).find(line => line.message_type === 'summary')
  const first = summary(await restic(['backup', folder, '--json', '--tag', TAG]))
  assert.ok(first.snapshot_id)
  const secondManifest = await capture({ folder, database, objects, credits, previous })
  const second = summary(await restic(['backup', folder, '--json', '--tag', TAG]))
  assert.equal(remoteReads, 1)
  assert.ok(second.data_added < bytes.length / 10)
  results.push({ name: 'unchanged audio reuses remote and encrypted data', passed: true, firstAdded: first.data_added, secondAdded: second.data_added })
  await restic(['restore', second.snapshot_id + ':' + folder, '--target', restored, '--verify'])
  const verified = await verifyCapture(restored)
  assert.equal(verified.id, secondManifest.id)
  assert.deepEqual(await readFile(path.join(restored, row.object_key)), bytes)
  results.push({ name: 'actual encrypted Restic snapshot restores exact fixture bytes', passed: true })
  await assert.rejects(command(binary, ['--repo', repository, 'snapshots'], { env: { ...env, RESTIC_PASSWORD: 'deliberately-wrong-fixture-password' } }))
  results.push({ name: 'wrong repository password cannot read snapshots', passed: true })
  const diskBytes = await readFile(path.join(repository, 'config'))
  assert.ok(!diskBytes.includes(Buffer.from('synthetic-database-placeholder')))
  await restic(['forget', first.snapshot_id]); await restic(['prune', '--max-repack-size', '0'])
  await restic(['check', '--read-data'])
  await rm(restored, { recursive: true })
  await restic(['restore', second.snapshot_id + ':' + folder, '--target', restored, '--verify'])
  await verifyCapture(restored)
  results.push({ name: 'pruning an older snapshot preserves a working latest restore', passed: true })
} finally {
  await writeFile(path.join(base, 'results.json'), JSON.stringify({ fixtureOnly: true, remoteServices: 0, emails: 0, results,
    limitation: 'Does not export or restore a real Supabase database; database files here are placeholders.' }, null, 2) + '\n')
  // Test password is ephemeral; preserve the small report, not an unreadable synthetic repository.
  for (const name of ['repository', 'capture', 'restored', 'cache']) await rm(path.join(base, name), { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: results.length, report: path.join(base, 'results.json') }))
