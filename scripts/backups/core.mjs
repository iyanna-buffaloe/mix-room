import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, lstat, statfs, unlink, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import path from 'node:path'
import { MAX_MIX_BYTES, isUUID } from '../../shared/savedMix.js'

export const LIMIT = 50_000_000_000
export const WARNING = 40_000_000_000
export const TAG = 'mix-room-backup-v1'
export const fail = code => Object.assign(new Error(code), { code })
export const sha = data => createHash('sha256').update(data).digest('hex')
export async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const part of createReadStream(file)) hash.update(part)
  return hash.digest('hex')
}

export function validateConfig(c) {
  if (c?.version !== 1 || !c.volume?.startsWith('/Volumes/') || !path.isAbsolute(c.image || '') ||
      !/^[a-z0-9]{20}$/.test(c.project || '') || !isUUID(c.siteID) ||
      !/^[a-f0-9]{32}$/.test(c.r2Account || '') || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.savedBucket || '') ||
      !/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(c.databaseHost || '') ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.alertTo || '') ||
      !/^[^\r\n]+<[^\s@]+@[^\s@]+\.[^\s@]+>$/.test(c.alertFrom || '')) throw fail('CONFIG_INCOMPLETE')
  if (path.dirname(c.volume) !== '/Volumes' || path.basename(c.volume).includes('..') || !c.image.startsWith('/Volumes/')) throw fail('UNSAFE_DESTINATION')
  return c
}

export function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > 100000) throw fail('INVALID_MIX_MANIFEST')
  const ids = new Set(), objects = new Set()
  return rows.map(row => {
    const key = `saved/${row.owner_id}/${row.object_id}.mixroom`
    if (![row.id, row.owner_id, row.object_id].every(isUUID) || row.object_key !== key ||
        !Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) < 57 || Number(row.bytes) > MAX_MIX_BYTES ||
        ids.has(row.id) || objects.has(key)) throw fail('INVALID_MIX_MANIFEST')
    ids.add(row.id); objects.add(key)
    return { ...row, bytes: Number(row.bytes) }
  })
}

export function creditKey(key) {
  // Only the application's one store is read. No source-upload links or MVSEP requests are followed.
  return typeof key === 'string' && key.length < 512 && !key.includes('..') && /^(credits|quota|job|stem-trial)\/[a-zA-Z0-9_/-]+$/.test(key)
}

export async function treeBytes(root) {
  let size = 0
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name), info = await lstat(file)
    if (info.isSymbolicLink()) throw fail('SYMLINK_IN_BACKUP')
    size += info.isDirectory() ? await treeBytes(file) : info.size
  }
  return size
}

export function checkBudget({ used, additional, free, limit = LIMIT }) {
  if (![used, additional, free].every(n => Number.isFinite(n) && n >= 0) ||
      used + additional > limit || additional + 256_000_000 > free) throw fail('BACKUP_SPACE_LIMIT')
}

export async function roomFor(volume, additional) {
  const used = await treeBytes(path.join(volume, 'data')), fs = await statfs(volume)
  checkBudget({ used, additional, free: fs.bavail * fs.bsize })
  return used
}

export function oldestRemovable(snapshots) {
  const good = snapshots.filter(s => s.tags?.includes(TAG) && s.tags.includes('file-verified'))
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
  // Never offer the newest verified restore point for deletion, even under pressure.
  return good.slice(1).reverse()
}

async function privateJSON(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

export async function capture({ folder, database, objects, credits, reserve = async () => {}, previous = null, now = () => new Date().toISOString() }) {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if ((await lstat(folder)).isSymbolicLink()) throw fail('SYMLINK_IN_BACKUP')
  await treeBytes(folder)
  const startedAt = now(), snapshot = await database.open()
  let rows
  try {
    rows = validateRows(snapshot.rows)
    // Reserve for a complete staged copy, encrypted copy and restore verification.
    await reserve(rows.reduce((sum, r) => sum + r.bytes, 0) * 3 + 256_000_000)
    const firstCredits = await credits.read()
    await snapshot.dump(path.join(folder, 'database.dump'))
    await snapshot.roles(path.join(folder, 'roles.sql'))
    await privateJSON(path.join(folder, 'mixes.json'), rows)
    const files = []
    for (const row of rows) {
      const file = path.join(folder, row.object_key)
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const old = previous?.files?.find(f => f.path === row.object_key)
      const existing = await lstat(file).catch(() => null)
      let reusable = false
      if (old && existing?.isFile() && existing.size === row.bytes && await hashFile(file) === old.sha256) {
        const head = await objects.head(row.object_key)
        reusable = head.bytes === row.bytes && head.etag === old.etag
      }
      let etag = old?.etag
      if (!reusable) {
        const head = await objects.head(row.object_key)
        if (head.bytes !== row.bytes || !head.etag) throw fail('SAVED_AUDIO_CHANGED')
        etag = head.etag
        const body = await objects.get(row.object_key, etag)
        let bytes = 0
        const limit = new Transform({ transform(chunk, _encoding, done) {
          bytes += chunk.length
          done(bytes > row.bytes ? fail('SAVED_AUDIO_SIZE') : null, chunk)
        } })
        const partial = file + '.partial'
        try {
          await pipeline(body, limit, createWriteStream(partial, { mode: 0o600, flags: 'w' }))
          if (bytes !== row.bytes) throw fail('SAVED_AUDIO_SIZE')
          const { rename } = await import('node:fs/promises')
          await rename(partial, file)
        } finally { await unlink(partial).catch(() => {}) }
      }
      files.push({ path: row.object_key, bytes: row.bytes, etag, sha256: await hashFile(file) })
    }
    const lastCredits = await credits.read()
    if (sha(JSON.stringify(firstCredits)) !== sha(JSON.stringify(lastCredits))) throw fail('CREDITS_CHANGED_RETRY')
    await privateJSON(path.join(folder, 'credits.json'), lastCredits)
    for (const file of ['database.dump', 'roles.sql', 'mixes.json', 'credits.json']) {
      const info = await lstat(path.join(folder, file))
      if (!info.isFile() || info.size > 1_000_000_000) throw fail('INVALID_DATABASE_EXPORT')
      files.push({ path: file, bytes: info.size, sha256: await hashFile(path.join(folder, file)) })
    }
    const manifest = { version: 1, id: randomUUID(), startedAt, completedAt: now(), files,
      restorePaidProcessing: 'DISABLED until jobs and credit state are reconciled',
      sessionPolicy: 'Restored users must sign in again; sessions and refresh tokens are excluded',
      databaseScope: ['public', 'auth', 'supabase_migrations'],
      limitation: 'Cross-service capture window; not an atomic snapshot of every provider or service configuration' }
    await privateJSON(path.join(folder, 'manifest.json'), manifest)
    return manifest
  } finally { await snapshot.close() }
}

export async function verifyCapture(folder) {
  if ((await lstat(folder)).isSymbolicLink()) throw fail('SYMLINK_IN_BACKUP')
  await treeBytes(folder)
  const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !isUUID(manifest.id)) throw fail('INVALID_BACKUP_MANIFEST')
  const names = new Set()
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !['database.dump', 'roles.sql', 'mixes.json', 'credits.json'].includes(file.path) &&
        !/^saved\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.mixroom$/i.test(file.path) || names.has(file.path)) throw fail('INVALID_BACKUP_PATH')
    names.add(file.path)
    const destination = path.join(folder, file.path), info = await lstat(destination)
    if (!info.isFile() || info.size !== file.bytes || await hashFile(destination) !== file.sha256) throw fail('BACKUP_CHECKSUM_FAILED')
  }
  if (!['database.dump', 'roles.sql', 'mixes.json', 'credits.json'].every(name => names.has(name))) throw fail('INCOMPLETE_BACKUP')
  const rows = validateRows(JSON.parse(await readFile(path.join(folder, 'mixes.json'), 'utf8')))
  if (rows.some(row => !names.has(row.object_key) || manifest.files.find(f => f.path === row.object_key).bytes !== row.bytes) || names.size !== rows.length + 4) throw fail('INCOMPLETE_BACKUP')
  return manifest
}
