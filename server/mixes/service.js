import { MIX_LIMIT, MAX_MIX_BYTES, MAX_ACCOUNT_BYTES, MIX_ARCHIVE_MAGIC, MAX_MANIFEST_BYTES, isUUID, mixName } from '../../shared/savedMix.js'
import { reportOperation } from '../operationEvents.js'

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const failure = (message, status = 400, code = 'MIX_REQUEST') => Object.assign(new Error(message), { status, code, public: true })
const nameOf = value => { try { return mixName(value) } catch { throw failure('Use a mix name of 1–120 characters.') } }
const summary = row => ({ id: row.id, name: row.name, bytes: row.bytes, revision: row.revision, updatedAt: row.updated_at })
const incomingKey = (owner, upload) => `incoming/${owner}/${upload}.mixroom`
const savedKey = (owner, upload) => `saved/${owner}/${upload}.mixroom`
const sameUpload = (row, body) => row && row.mix_id === body.mixId && row.name === body.name && row.bytes === body.bytes && (row.expected_revision ?? null) === (body.expectedRevision ?? null)
const databaseFailures = {
  MIX_LIMIT: ['Your library is full. Choose a mix to replace or delete one first.', 409],
  STORAGE_LIMIT: ['Your account storage limit has been reached.', 409],
  MIX_CHANGED: ['This mix changed in another tab or device. Refresh your library before trying again.', 409],
  UPLOAD_EXPIRED: ['This upload has expired. Start a new save.', 409],
  UPLOAD_NOT_FOUND: ['This upload is unavailable. Start a new save.', 404],
  UPLOAD_SIZE: ['The uploaded backup is incomplete. Try saving again.', 400],
  UPLOAD_CHANGED: ['This save request has changed. Start a new save.', 409],
  UPLOAD_LIMIT: ['Finish your other saves or wait 15 minutes before starting another upload.', 429],
  UPLOAD_RATE_LIMIT: ['Too many save attempts. Please try again later.', 429],
}
export function savedMixConfig(env) {
  return { available: Boolean((env.SUPABASE_URL || env.VITE_SUPABASE_URL) && env.SUPABASE_SECRET_KEY && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_SAVED_MIXES_BUCKET_NAME && env.R2_SAVED_MIXES_BUCKET_NAME !== env.R2_BUCKET_NAME), limit: MIX_LIMIT, maxMixBytes: MAX_MIX_BYTES, maxAccountBytes: MAX_ACCOUNT_BYTES }
}
async function json(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw failure('Send this request as JSON.', 415)
  const reader = request.body?.getReader()
  if (!reader) throw failure('The request is empty.')
  let total = 0; const parts = []
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > 4096) { await reader.cancel(); throw failure('This request is too large.', 413) } parts.push(value) }
    const value = JSON.parse(await new Blob(parts).text())
    if (!value || Array.isArray(value) || typeof value !== 'object') throw failure('The request is invalid.')
    return value
  } catch (error) { if (error.public) throw error; throw failure('The request could not be read.') }
  finally { reader.releaseLock() }
}
function validRevision(value) { return Number.isSafeInteger(value) && value > 0 }

export function createMixService({ config, repository, storage, allowedOrigins = [], report = () => {} }) {
  return async request => {
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/mixes\/?/, '').split('/').filter(Boolean)
    try {
      if (request.method === 'GET' && path[0] === 'config') return reply(config)
      if (!config.available) throw failure('Mix saving is unavailable right now. Your draft stays in this tab; you can download a backup.', 503, 'MIXES_UNAVAILABLE')
      const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '')?.[1]
      if (!token) throw failure('Sign in to use My mixes.', 401, 'SIGN_IN_REQUIRED')
      const user = await repository.verifyToken(token)
      if (!user || !isUUID(user.id)) throw failure('Your session ended. Sign in again.', 401, 'SIGN_IN_REQUIRED')
      const owner = user.id
      if (request.method !== 'GET') {
        const origin = request.headers.get('Origin')
        if ((origin && origin !== url.origin && !allowedOrigins.includes(origin)) || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw failure('Open Mix Room directly before changing your library.', 403)
      }
      if (request.method === 'GET' && path.length === 0) return reply({ mixes: (await repository.list(owner)).map(summary), limit: MIX_LIMIT })
      if (request.method === 'POST' && path[0] === 'uploads' && path.length === 1) {
        const body = await json(request)
        if (!isUUID(body.uploadId) || !isUUID(body.mixId) || !Number.isSafeInteger(body.bytes) || body.bytes < 57 || body.bytes > MAX_MIX_BYTES || (body.expectedRevision != null && !validRevision(body.expectedRevision))) throw failure('The save request is invalid or exceeds the 160 MiB limit.')
        body.name = nameOf(body.name)
        const existing = await repository.get(owner, body.mixId)
        if (body.expectedRevision != null && existing?.revision !== body.expectedRevision) throw failure(databaseFailures.MIX_CHANGED[0], 409, 'MIX_CHANGED')
        if (body.expectedRevision == null && existing) throw failure('This mix already exists. Refresh your library before saving again.', 409, 'MIX_CHANGED')
        if (!existing && (await repository.list(owner)).length >= MIX_LIMIT) throw failure(databaseFailures.MIX_LIMIT[0], 409, 'MIX_LIMIT')
        const pending = await repository.beginUpload({ id: body.uploadId, owner_id: owner, mix_id: body.mixId, name: body.name, bytes: body.bytes, expected_revision: body.expectedRevision ?? null })
        if (!sameUpload(pending, body)) throw failure(databaseFailures.UPLOAD_CHANGED[0], 409, 'UPLOAD_CHANGED')
        if (Date.parse(pending.expires_at) <= Date.now()) throw failure(databaseFailures.UPLOAD_EXPIRED[0], 409, 'UPLOAD_EXPIRED')
        return reply({ uploadId: pending.id, uploadUrl: await storage.uploadUrl(incomingKey(owner, pending.id), pending.bytes) })
      }
      if (request.method === 'POST' && path[0] === 'commit' && path.length === 1) {
        const body = await json(request)
        if (!isUUID(body.uploadId)) throw failure('The save request is invalid.')
        const pending = await repository.getUpload(owner, body.uploadId)
        if (!pending) throw failure(databaseFailures.UPLOAD_NOT_FOUND[0], 404, 'UPLOAD_NOT_FOUND')
        const existing = await repository.get(owner, pending.mix_id)
        if (existing?.object_id === pending.id) return reply({ mix: summary(existing) })
        if (pending.committed_at) throw failure(databaseFailures.MIX_CHANGED[0], 409, 'MIX_CHANGED')
        if (Date.parse(pending.expires_at) <= Date.now()) throw failure(databaseFailures.UPLOAD_EXPIRED[0], 409, 'UPLOAD_EXPIRED')
        const from = incomingKey(owner, pending.id), to = savedKey(owner, pending.id)
        const source = await storage.inspect(from)
        const header = source.header
        const manifestBytes = header?.byteLength >= 12 ? new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8, true) : 0
        if (source.bytes !== pending.bytes || !header || new TextDecoder().decode(header.slice(0, 8)) !== MIX_ARCHIVE_MAGIC || manifestBytes < 2 || manifestBytes > MAX_MANIFEST_BYTES || manifestBytes + 56 >= source.bytes) throw failure('The uploaded backup is incomplete. Try saving again.', 400, 'UPLOAD_SIZE')
        await storage.copy(from, to)
        if ((await storage.inspect(to)).bytes !== pending.bytes) throw failure('The backup copy could not be verified. Try saving again.', 503)
        // Never delete the old object before the database commit. On ambiguous
        // database failures retain the new object too, so a retry can reconcile.
        const row = await repository.commit(owner, pending.id, pending.bytes)
        await storage.remove(from).catch(() => {})
        if (existing?.object_key && existing.object_key !== row.object_key) await storage.remove(existing.object_key).catch(() => {})
        return reply({ mix: summary(row) })
      }
      if (!isUUID(path[0]) || path.length > 1) throw failure('This library action was not found.', 404)
      const row = await repository.get(owner, path[0])
      if (!row) throw failure('This mix was not found in your account.', 404)
      if (row.object_key !== savedKey(owner, row.object_id)) throw failure('This saved mix is unavailable.', 503)
      if (request.method === 'GET') return reply({ mix: summary(row), downloadUrl: await storage.downloadUrl(row.object_key) })
      const body = await json(request)
      if (!validRevision(body.revision) || body.revision !== row.revision) throw failure(databaseFailures.MIX_CHANGED[0], 409, 'MIX_CHANGED')
      if (request.method === 'PATCH') {
        const updated = await repository.rename(owner, row, nameOf(body.name))
        if (!updated) throw failure(databaseFailures.MIX_CHANGED[0], 409, 'MIX_CHANGED')
        return reply({ mix: summary(updated) })
      }
      if (request.method === 'DELETE') {
        if (!await repository.delete(owner, row)) throw failure(databaseFailures.MIX_CHANGED[0], 409, 'MIX_CHANGED')
        await storage.remove(row.object_key).catch(() => {})
        return reply({ deleted: true })
      }
      throw failure('This library action is unavailable.', 405)
    } catch (error) {
      const operation = path[0] === 'uploads' ? 'mix_upload' : path[0] === 'commit' ? 'mix_commit' : request.method === 'DELETE' ? 'mix_delete' : request.method === 'PATCH' ? 'mix_rename' : 'mix_read'
      const status = error.public ? error.status : databaseFailures[error.message]?.[1] ?? 503
      const eventCode = error.public ? error.code : databaseFailures[error.message] ? error.message : 'MIX_SERVICE_FAILED'
      if (status >= 500 || ['MIX_CHANGED','STORAGE_LIMIT','MIX_LIMIT'].includes(eventCode)) reportOperation(report, { service: 'mixes', operation, status, code: eventCode })
      if (error.public) return reply({ error: error.message, code: error.code }, error.status)
      const code = Object.keys(databaseFailures).find(value => error.message === value)
      if (code) return reply({ error: databaseFailures[code][0], code }, databaseFailures[code][1])
      return reply({ error: 'Your mix request could not finish. Your draft and previously saved mix have been kept. Try again.', code: 'MIX_SERVICE_FAILED' }, 503)
    }
  }
}
