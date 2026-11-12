import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

// Generates a link in memory instead of sending email. Changes and deletes
// only the disposable account created here; no real inbox or account is used.
if (!process.argv.includes('--live')) throw new Error('Use --live for the disposable new-email confirmation check.')
const env = process.env
assert.ok(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SECRET_KEY, 'Private live-check configuration is required')
const artifacts = env.MIX_ROOM_AUTH_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-new-email-check')
await mkdir(artifacts, { recursive: true })
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }) } }
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY, options)
const auth = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, options).auth
const check = result => { assert.ok(!result.error, 'Provider operation failed; private response omitted'); return result.data }
const results = []
let id, cleanup = false, failed = false
try {
  const email = `mix-room-old-${randomUUID()}@example.com`, newEmail = `mix-room-new-${randomUUID()}@example.com`
  const password = randomBytes(32).toString('base64url')
  id = check(await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: 'disposable-new-email-check' } })).user.id
  const generated = check(await admin.auth.admin.generateLink({ type: 'email_change_new', email, newEmail, options: { redirectTo: 'https://friday-integration--mixingvisualizer.netlify.app/' } }))
  assert.equal(generated.user.id, id)
  // The admin response's generic hashed_token can be keyed to the old email;
  // the action link carries the actual new-address verification token.
  const verificationURL = new URL(generated.properties.action_link)
  assert.equal(verificationURL.origin, new URL(env.VITE_SUPABASE_URL).origin)
  const tokenHash = verificationURL.searchParams.get('token')
  assert.ok(tokenHash)
  assert.equal(check(await admin.auth.admin.getUserById(id)).user.email, email)
  results.push({ check: 'The original sign-in email stays active before new-address confirmation', passed: true })
  const confirmed = check(await auth.verifyOtp({ token_hash: tokenHash, type: 'email_change' }))
  assert.equal(confirmed.user.id, id)
  assert.equal(confirmed.user.email, newEmail)
  assert.equal(check(await admin.auth.admin.getUserById(id)).user.email, newEmail)
  results.push({ check: 'New-address confirmation alone completes the change without an old-address link', passed: true })
  assert.equal((await auth.signInWithPassword({ email, password })).error?.code, 'invalid_credentials')
  assert.equal(check(await auth.signInWithPassword({ email: newEmail, password })).user.id, id)
  results.push({ check: 'The new email signs in with the same account ID; the old email no longer signs in', passed: true })
  assert.ok((await auth.verifyOtp({ token_hash: tokenHash, type: 'email_change' })).error)
  results.push({ check: 'The used confirmation cannot be replayed', passed: true })
} catch {
  failed = true
  results.push({ check: 'New-address-only confirmation flow', passed: false })
} finally {
  try { cleanup = !id || !(await admin.auth.admin.deleteUser(id)).error } catch { cleanup = false }
  await writeFile(path.join(artifacts, 'new-email-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), realProvider: true, smtpDeliveryTested: false, generatedLinksOnly: true, emailsSent: 0, existingAccountsChanged: 0, results, cleanup }, null, 2)+'\n')
  console.log(JSON.stringify({ results, cleanup }))
}
if (failed || !cleanup) process.exitCode = 1
