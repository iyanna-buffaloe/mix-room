import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const creditDigest = value => createHash('sha256').update(value).digest('hex')

// Only the disposable identities' allowance keys are visible to the deployed
// app. Jobs, cancellation flags and monthly slots stay in a unique QA prefix.
// No store listing, existing account or real monthly quota is accessible here.
export function creditProbeScope({ runId, accountIds, devices, jobIds }) {
  assert.match(runId, /^[a-f0-9-]{36}$/)
  const allowanceKeys = new Set()
  for (const id of accountIds) for (let slot = 0; slot < 3; slot++) allowanceKeys.add(`credits/account/${creditDigest(id)}/${slot}`)
  for (const device of devices) {
    assert.match(device, /^[a-f0-9]{64}$/)
    const hash = creditDigest(device)
    allowanceKeys.add(`credits/guest/${hash}/0`)
    allowanceKeys.add(`stem-trial/guest/${hash}`)
    for (let slot = 0; slot < 3; slot++) allowanceKeys.add(`credits/${hash}/${slot}`)
  }
  const jobs = new Set(jobIds)
  const prefix = `qa-credit-check/${runId}/`
  const keyFor = key => {
    if (allowanceKeys.has(key)) return key
    const job = key.match(/^(job|cancel)\/([a-f0-9-]{36})$/)
    if (job && jobs.has(job[2]) || /^quota\/\d{4}-\d{2}\/\d{1,2}$/.test(key)) return prefix + key
    throw new Error('Credit probe refused an unrelated key')
  }
  return { allowanceKeys, keyFor, prefix, owns: key => allowanceKeys.has(key) || key.startsWith(prefix) }
}

export function createCreditProbeStore(raw, scope, touched) {
  return {
    getWithMetadata: (key, options) => raw.getWithMetadata(scope.keyFor(key), options),
    setJSON: (key, value, options) => {
      const mapped = scope.keyFor(key)
      touched.add(mapped) // Includes ambiguous writes that need cleanup too.
      return raw.setJSON(mapped, value, options)
    },
  }
}
