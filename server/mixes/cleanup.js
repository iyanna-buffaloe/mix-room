import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isUUID } from '../../shared/savedMix.js'
import { createMixRepository } from './repository.js'
import { createSavedMixStorage } from './storage.js'
import { savedMixConfig } from './service.js'

// A one-hour buffer beyond upload expiry avoids racing an in-flight copy or
// commit. Referenced durable objects are always kept. Default mode is a dry run.
export async function cleanupMixUploads({ repository, storage, now = Date.now(), apply = false, maxRows = 1000, maxMilliseconds = Infinity }) {
  const deadline = Date.now() + maxMilliseconds
  const uploads = await repository.expiredUploads(new Date(now - 60 * 60 * 1000).toISOString(), maxRows)
  const result = { scanned: 0, referenced: 0, orphaned: 0, failed: 0, applied: apply }
  for (const upload of uploads) {
    if (Date.now() >= deadline) break
    if (!isUUID(upload.id) || !isUUID(upload.owner_id) || !isUUID(upload.mix_id)) { result.failed++; continue }
    result.scanned++
    try {
      const row = await repository.get(upload.owner_id, upload.mix_id)
      const referenced = row?.object_id === upload.id
      result[referenced ? 'referenced' : 'orphaned']++
      if (!apply) continue
      await storage.remove(`incoming/${upload.owner_id}/${upload.id}.mixroom`)
      if (!referenced) await storage.remove(`saved/${upload.owner_id}/${upload.id}.mixroom`)
      if (!upload.committed_at || Date.parse(upload.expires_at) < now - 7 * 24 * 60 * 60 * 1000) await repository.deleteUpload(upload.owner_id, upload.id)
    } catch { result.failed++ }
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!savedMixConfig(process.env).available) {
    console.error('Configure the server-only Supabase and durable R2 settings before running saved-mix cleanup.')
    process.exitCode = 1
  } else {
    const result = await cleanupMixUploads({ repository: createMixRepository(process.env), storage: createSavedMixStorage(process.env), apply: process.argv.includes('--apply') })
    console.log(JSON.stringify(result))
    if (result.failed) process.exitCode = 1
  }
}
