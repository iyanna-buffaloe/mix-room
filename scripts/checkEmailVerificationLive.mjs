import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createClient } from '@supabase/supabase-js'
import { createAccountSession } from '../src/auth/accountSession.js'

// Opt-in, real-provider check. Generates an OTP with the administrative API
// instead of sending SMTP mail. Only a newly created disposable account is
// touched. No existing address, password, template, or email setting is changed.
if (!process.argv.includes('--live')) throw new Error('Use --live to create, verify and remove a disposable test account. No emails will be sent.')
const env = process.env
assert.ok(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SECRET_KEY, 'Supabase test configuration is required')
const artifacts = env.MIX_ROOM_AUTH_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-email-verification-live')
await mkdir(artifacts, { recursive: true })
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }) } }
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY, options)
const primary = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, options)
const isolated = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, options)
const check = result => { assert.ok(!result.error, 'Provider request failed'); return result.data }
const results = []
let createdId, session, phase = 'Create a disposable account', failed = false, cleanup = false, code, updateCalls = 0
const pass = label => { results.push({ check: label, passed: true }); console.log(`PASS ${label}`) }
try {
  const email = `mix-room-verify-${randomUUID()}@example.com`, password = randomBytes(32).toString('base64url')
  createdId = check(await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: 'disposable-email-verification-check' } })).user.id
  const loggedIn = check(await primary.auth.signInWithPassword({ email, password })).session
  const adapter = new Proxy(primary.auth, { get(target, name) {
    // A regression must never send change-address email during this check.
    if (name === 'updateUser') return async () => { updateCalls++; throw new Error('Unexpected email update') }
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value
  } })
  session = createAccountSession(adapter, { emailVerifier: {
    async signInWithOtp(value) {
      assert.equal(value.email, email); assert.equal(value.options.shouldCreateUser, false)
      const generated = check(await admin.auth.admin.generateLink({ type: 'magiclink', email }))
      assert.equal(generated.user.id, createdId)
      code = generated.properties.email_otp
      assert.match(code, /^\d{6,10}$/)
      return { data: {}, error: null }
    },
    verifyOtp: value => isolated.auth.verifyOtp(value),
    signOut: value => isolated.auth.signOut(value),
  } })
  await session.start()
  assert.equal(session.getSnapshot().user.id, createdId)
  assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  assert.equal(await session.changeEmail('unused@example.com'), false)
  assert.equal(updateCalls, 0)
  pass('Real confirmed login remains locked until current-email verification')
  phase = 'Generate an OTP without sending an email'
  assert.equal(await session.requestEmailVerification(), true)
  pass(phase)
  phase = 'Reject an invalid real OTP without ending the active login'
  const wrong = `${code[0] === '0' ? '1' : '0'}${code.slice(1)}`
  assert.equal(await session.verifyCurrentEmail(wrong), false)
  assert.equal(session.getSnapshot().status, 'signed-in')
  assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  pass(phase)
  phase = 'Verify the real OTP and revoke its isolated temporary session'
  assert.equal(await session.verifyCurrentEmail(code), true)
  assert.ok(session.getSnapshot().emailVerifiedUntil > Date.now())
  assert.equal(check(await isolated.auth.getSession()).session, null)
  assert.equal(check(await primary.auth.getSession()).session.access_token, loggedIn.access_token)
  assert.equal(check(await primary.auth.getUser()).user.id, createdId)
  pass(phase)
  phase = 'The original login can still refresh after temporary OTP-session logout'
  assert.equal(check(await primary.auth.refreshSession()).user.id, createdId)
  assert.equal(session.getSnapshot().user.id, createdId)
  pass(phase)
  phase = 'Closing verification relocks the form without any address update'
  session.clearEmailVerification()
  assert.equal(await session.changeEmail('unused@example.com'), false)
  assert.equal(updateCalls, 0)
  pass(phase)
} catch {
  failed = true; results.push({ check: phase, passed: false })
  console.error(`FAIL ${phase}. Private provider responses and verification credentials are omitted.`)
} finally {
  session?.dispose()
  if (createdId) {
    try { cleanup = !(await admin.auth.admin.deleteUser(createdId)).error } catch { cleanup = false }
  } else cleanup = true
  console.log(cleanup ? 'PASS disposable-account cleanup' : 'FAIL disposable-account cleanup')
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), realProvider: true, smtpDeliveryTested: false, emailsSent: 0, existingAccountsChanged: 0, results, cleanup }, null, 2) + '\n')
}
if (failed || !cleanup) process.exitCode = 1
