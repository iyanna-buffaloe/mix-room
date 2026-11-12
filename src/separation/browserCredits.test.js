import test from 'node:test'
import assert from 'node:assert/strict'
import { browserCreditToken, BROWSER_CREDIT_KEY } from './browserCredits.js'

test('one browser identity persists across requests and malformed values are replaced', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  let calls = 0
  const random = { getRandomValues: bytes => { calls++; return bytes.fill(13) } }
  assert.equal(browserCreditToken(storage, random), '0d'.repeat(32))
  assert.equal(browserCreditToken(storage, random), '0d'.repeat(32))
  assert.equal(calls, 1)
  values.set(BROWSER_CREDIT_KEY, 'invalid')
  browserCreditToken(storage, random)
  assert.equal(calls, 2)
})

test('unavailable persistent storage prevents an untracked new separation', () => {
  const storage = { getItem() { throw new Error('blocked') } }
  assert.throws(() => browserCreditToken(storage), { code: 'CREDIT_STORAGE_UNAVAILABLE', beforeSubmission: true })
})
