import { COPY } from '../config/siteCopy.js'

export const BROWSER_CREDIT_KEY = 'mix-room-song-credit-device'

export function browserCreditToken(storage, random = globalThis.crypto) {
  try {
    storage ??= globalThis.localStorage
    const existing = storage.getItem(BROWSER_CREDIT_KEY)
    if (/^[a-f0-9]{64}$/.test(existing ?? '')) return existing
    const token = [...random.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('')
    storage.setItem(BROWSER_CREDIT_KEY, token)
    return token
  } catch {
    throw Object.assign(new Error(COPY.song_credit_storage_unavailable), { code: 'CREDIT_STORAGE_UNAVAILABLE', beforeSubmission: true })
  }
}
