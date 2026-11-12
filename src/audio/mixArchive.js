import { MAX_MIX_BYTES, MAX_MANIFEST_BYTES, MIX_ARCHIVE_MAGIC, MIX_ARCHIVE_TYPE, mixName } from '../../shared/savedMix.js'
import { isStoredMix } from './browserMixStorage.js'
import { normalizeViewSettings } from '../config/viewSettings.js'

export function createMixArchive(record, view = {}) {
  if (!isStoredMix(record)) throw new Error('This mix is incomplete. Keep the current tab open and try again.')
  const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, metadata: record.metadata, framesByKey: record.framesByKey,
    audioType: record.audioBlob.type || 'audio/wav', view: { settings: normalizeViewSettings(view.settings), visibility: view.visibility ?? {} } }))
  if (manifest.byteLength > MAX_MANIFEST_BYTES) throw new Error('This mix has too much analysis data to save.')
  const header = new Uint8Array(12)
  header.set(new TextEncoder().encode(MIX_ARCHIVE_MAGIC))
  new DataView(header.buffer).setUint32(8, manifest.byteLength, true)
  const blob = new Blob([header, manifest, record.audioBlob], { type: MIX_ARCHIVE_TYPE })
  if (blob.size > MAX_MIX_BYTES) throw new Error('This mix exceeds the 160 MiB saving limit. Download a backup or use a shorter track.')
  return blob
}

export async function readMixArchive(blob) {
  if (!(blob instanceof Blob) || blob.size > MAX_MIX_BYTES || blob.size < 57) throw new Error('This Mix Room backup is empty or too large.')
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const length = new DataView(header.buffer).getUint32(8, true)
  if (new TextDecoder().decode(header.slice(0, 8)) !== MIX_ARCHIVE_MAGIC || length > MAX_MANIFEST_BYTES || length < 2 || 12 + length + 44 >= blob.size) throw new Error('This file is not a complete Mix Room backup.')
  let manifest
  try { manifest = JSON.parse(await blob.slice(12, 12 + length).text()) } catch { throw new Error('The backup analysis could not be read.') }
  const metadata = manifest.metadata
  if (manifest.version !== 1 || typeof metadata?.title !== 'string' || !Array.isArray(metadata.instruments) || metadata.instruments.length > 32) throw new Error('The backup uses an unsupported mix format.')
  mixName(metadata.title)
  const keys = new Set()
  if ((metadata.artist != null && typeof metadata.artist !== 'string') || (metadata.processingMode != null && typeof metadata.processingMode !== 'string') || (metadata.duration != null && (!Number.isFinite(metadata.duration) || metadata.duration < 0))) throw new Error('The backup contains invalid song information.')
  for (const instrument of metadata.instruments) {
    if (!instrument || !/^[a-z0-9_-]{1,120}$/i.test(instrument.key) || ['__proto__', 'constructor', 'prototype'].includes(instrument.key) || keys.has(instrument.key) ||
      (instrument.label != null && (typeof instrument.label !== 'string' || !instrument.label.trim() || instrument.label.length > 60)) || !Number.isFinite(instrument.freq) ||
      (instrument.fileName != null && typeof instrument.fileName !== 'string') ||
      ['pan', 'width', 'rms', 'correlation'].some(key => instrument[key] != null && !Number.isFinite(instrument[key]))) throw new Error('The backup contains invalid instrument information.')
    keys.add(instrument.key)
    const frames = manifest.framesByKey?.[instrument.key]
    if (!Array.isArray(frames) || frames.some(frame => !frame || !Number.isFinite(frame.t) || frame.t < 0 || !Number.isFinite(frame.loud) || !Number.isFinite(frame.pan) ||
      ['width', 'correlation', 'kickBleed'].some(key => frame[key] != null && !Number.isFinite(frame[key])))) throw new Error('The backup contains invalid instrument analysis.')
  }
  const audioType = typeof manifest.audioType === 'string' && /^audio\/[a-z0-9.+-]{1,50}$/i.test(manifest.audioType) ? manifest.audioType : 'audio/wav'
  const record = { version: 1, id: crypto.randomUUID(), metadata, framesByKey: manifest.framesByKey, audioBlob: blob.slice(12 + length, blob.size, audioType) }
  if (!isStoredMix(record)) throw new Error('The backup is missing audio or instrument analysis.')
  const visibility = Object.fromEntries(metadata.instruments.map(instrument => [instrument.key, manifest.view?.visibility?.[instrument.key] !== false]))
  return { record, view: { settings: normalizeViewSettings(manifest.view?.settings), visibility } }
}

export function downloadMixBackup(record, view) {
  const blob = createMixArchive(record, view)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${(record.metadata.title || 'mix').replace(/[^\p{L}\p{N} _.-]/gu, '_')}.mixroom`
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
