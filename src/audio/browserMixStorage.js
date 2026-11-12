import { COPY } from '../config/siteCopy.js'
const DATABASE = 'mix-room-browser-mixes'
const STORE = 'mixes'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(COPY.close_other_mix_room_tabs_and_try_saving_again))
  })
}

export function isStoredMix(record) {
  return record?.version === 1 && typeof record.id === 'string' && record.audioBlob instanceof Blob && record.audioBlob.size > 44 &&
    Array.isArray(record.metadata?.instruments) && record.metadata.instruments.length > 0 &&
    record.metadata.instruments.every(instrument => typeof instrument.key === 'string' && Array.isArray(record.framesByKey?.[instrument.key]))
}

export async function loadBrowserMix() {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get('current')
      transaction.oncomplete = () => resolve(isStoredMix(request.result) ? request.result : null)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error(COPY.could_not_restore_this_mix))
    })
  } finally { db.close() }
}

export async function saveBrowserMix(record, { signal } = {}) {
  signal?.throwIfAborted()
  const db = await openDatabase()
  try {
    signal?.throwIfAborted()
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const abort = () => { try { transaction.abort() } catch { /* Already committed. */ } }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      signal?.addEventListener('abort', abort, { once: true })
      transaction.objectStore(STORE).put(record, 'current')
      transaction.oncomplete = () => { cleanup(); resolve() }
      transaction.onabort = () => { cleanup(); reject(signal?.aborted ? new DOMException(COPY.processing_cancelled, 'AbortError') : transaction.error ?? new Error(COPY.could_not_save_this_mix)) }
      transaction.onerror = () => { /* The abort handler reports the failure. */ }
    })
  } finally { db.close() }
}

// Migration only: a user must explicitly choose to remove an existing copy.
// Compare its identity so another older tab cannot have its new mix erased.
export async function deleteLegacyBrowserMix(expectedId) {
  const db = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = store.get('current')
      request.onsuccess = () => {
        if (request.result && request.result.id !== expectedId) { transaction.abort(); return }
        store.delete('current')
      }
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(new Error('The local mix changed in another tab. Refresh before deleting it.'))
      transaction.onerror = () => reject(transaction.error)
    })
  } finally { db.close() }
}

export function renameMix(record, title, instruments) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new Error(COPY.give_your_song_a_title_of_1_120_characters)
  if (!Array.isArray(instruments)) throw new Error(COPY.the_instrument_list_is_missing)
  const labels = new Map()
  for (const instrument of instruments) {
    if (!instrument || typeof instrument.label !== 'string' || !instrument.label.trim() || instrument.label.trim().length > 60 || labels.has(instrument.key)) throw new Error(COPY.give_each_instrument_a_name_of_1_60_characters)
    labels.set(instrument.key, instrument.label.trim())
  }
  if (labels.size !== record.metadata.instruments.length || record.metadata.instruments.some(instrument => !labels.has(instrument.key))) throw new Error(COPY.the_instrument_list_does_not_match_this_mix)
  return { ...record, metadata: {
    ...record.metadata, title: title.trim(),
    instruments: record.metadata.instruments.map(instrument => ({ ...instrument, label: labels.get(instrument.key) })),
  } }
}
