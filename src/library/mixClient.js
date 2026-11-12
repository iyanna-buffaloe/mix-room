import { MAX_MIX_BYTES, MIX_ARCHIVE_TYPE } from '../../shared/savedMix.js'

export function createMixClient({ getAccessToken, fetcher = fetch }) {
  const request = async (path = '', { method = 'GET', body, signal, public: anonymous = false } = {}) => {
    const token = anonymous ? null : await getAccessToken()
    let response
    try {
      response = await fetcher(`/api/mixes${path}`, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), cache: 'no-store',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { signal?.throwIfAborted(); throw new Error('The mix library could not be reached. Keep this tab open and try again.') }
    let value
    try { value = await response.json() } catch { throw new Error('The mix library could not be reached. Keep this tab open and try again.') }
    if (!response.ok) throw Object.assign(new Error(value.error || 'The library request failed.'), { code: value.code, status: response.status })
    return value
  }
  const storageURL = value => {
    try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href } catch { /* Show a safe message without signed link details. */ }
    throw new Error('The storage link is unavailable. Try again.')
  }
  return {
    config: signal => request('/config', { signal, public: true }),
    list: signal => request('', { signal }),
    async save(archive, attempt, { signal, onStage = () => {} } = {}) {
      try {
        signal?.throwIfAborted()
        if (!attempt.uploaded) {
          onStage('Preparing upload…')
          const prepared = await request('/uploads', { method: 'POST', signal, body: { uploadId: attempt.uploadId, mixId: attempt.mixId, name: attempt.name, bytes: archive.size, expectedRevision: attempt.expectedRevision ?? null } })
          onStage('Uploading mix…')
          let uploaded
          try { uploaded = await fetcher(storageURL(prepared.uploadUrl), { method: 'PUT', credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000), headers: { 'Content-Type': MIX_ARCHIVE_TYPE }, body: archive }) }
          catch { signal?.throwIfAborted(); throw new Error('The mix upload was interrupted. Keep this tab open and retry, or download a backup.') }
          if (!uploaded.ok) throw new Error('The mix upload failed. Your draft and previous saved version are safe. Try again.')
          attempt.uploaded = true
        }
        onStage('Finishing save…')
        return (await request('/commit', { method: 'POST', signal, body: { uploadId: attempt.uploadId } })).mix
      } catch (error) {
        // An explicit expiry/missing-upload response proves this attempt cannot
        // commit. A network error is ambiguous: keep its ID for idempotent retry.
        if (['UPLOAD_EXPIRED', 'UPLOAD_NOT_FOUND'].includes(error.code)) {
          attempt.uploadId = crypto.randomUUID()
          attempt.uploaded = false
        }
        throw error
      }
    },
    async open(id, signal) {
      const value = await request(`/${id}`, { signal })
      if (!Number.isSafeInteger(value.mix.bytes) || value.mix.bytes > MAX_MIX_BYTES) throw new Error('This saved mix exceeds the download limit.')
      const response = await fetcher(storageURL(value.downloadUrl), { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) })
      if (!response.ok || !response.body) throw new Error('This mix could not be downloaded. Please try again.')
      const reader = response.body.getReader(); const parts = []; let bytes = 0
      try {
        for (;;) { const { value: part, done } = await reader.read(); if (done) break; bytes += part.byteLength; if (bytes > MAX_MIX_BYTES || bytes > value.mix.bytes) { await reader.cancel(); throw new Error('The saved mix download is too large.') } parts.push(part) }
      } finally { reader.releaseLock() }
      if (bytes !== value.mix.bytes) throw new Error('The saved mix download was interrupted. Please try again.')
      return { mix: value.mix, archive: new Blob(parts, { type: MIX_ARCHIVE_TYPE }) }
    },
    rename: (row, name, signal) => request(`/${row.id}`, { method: 'PATCH', body: { revision: row.revision, name }, signal }),
    delete: (row, signal) => request(`/${row.id}`, { method: 'DELETE', body: { revision: row.revision }, signal }),
  }
}
