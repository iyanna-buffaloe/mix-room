export const MIX_LIMIT = 3
export const MAX_MIX_BYTES = 160 * 1024 * 1024
export const MAX_ACCOUNT_BYTES = MIX_LIMIT * MAX_MIX_BYTES
export const MAX_MANIFEST_BYTES = 24 * 1024 * 1024
export const MIX_ARCHIVE_TYPE = 'application/octet-stream'
export const MIX_ARCHIVE_MAGIC = 'MIXROOM1'
export const isUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export function mixName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('Use a mix name of 1–120 characters.')
  return value.trim()
}
