import test from 'node:test'
import assert from 'node:assert/strict'
import { accountError, createAccountSession, EMAIL_CHANGE_VERIFICATION_MS } from './accountSession.js'

const user = { id: 'account-1', email: 'listener@example.com' }
const ok = data => ({ data, error: null })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function setup(overrides = {}, options = {}) {
  let onChange
  let unsubscribed = false
  const auth = {
    onAuthStateChange: callback => { onChange = callback; return { data: { subscription: { unsubscribe: () => { unsubscribed = true } } } } },
    getSession: async () => ok({ session: null }), getUser: async () => ok({ user }),
    signInWithPassword: async () => ok({ user, session: { user } }),
    signUp: async () => ok({ user, session: null }), resend: async () => ok({}), signOut: async () => ok({}),
    signInWithOtp: async () => ok({}), verifyOtp: async () => ok({ user, session: { user } }),
    ...overrides,
  }
  const session = createAccountSession(auth, { redirectTo: 'http://localhost:5173/', ...options })
  return { session, auth, emit: (event, value) => onChange(event, value), unsubscribed: () => unsubscribed }
}

async function verifyEmailForChange(session) {
  assert.equal(await session.requestEmailVerification(), true)
  assert.equal(await session.verifyCurrentEmail('123456'), true)
}

test('restores a session after server verification, exposing identity without tokens', async () => {
  const { session } = setup({ getSession: async () => ok({ session: { user, access_token: 'private' } }) })
  assert.equal(session.getSnapshot().status, 'checking')
  await session.start()
  assert.equal(session.getSnapshot().status, 'signed-in')
  assert.deepEqual(session.getSnapshot().user, user)
  assert.equal(JSON.stringify(session.getSnapshot()).includes('private'), false)
})

test('an offline session check permits retry without exposing stale identity', async () => {
  let online = false
  const { session } = setup({ getSession: async () => { if (!online) throw new TypeError('network'); return ok({ session: { user } }) } })
  await session.start()
  assert.equal(session.getSnapshot().status, 'error')
  assert.equal(session.getSnapshot().user, null)
  online = true
  await session.start()
  assert.equal(session.getSnapshot().status, 'signed-in')
})

test('a revoked session returns to guest with recovery feedback', async () => {
  const { session } = setup({ getSession: async () => ({ error: { code: 'refresh_token_not_found' } }) })
  await session.start()
  assert.equal(session.getSnapshot().status, 'guest')
  assert.match(session.getSnapshot().error, /session ended/)
})

test('cross-tab sign-out wins over an earlier in-flight restoration', async () => {
  const verification = deferred()
  const { session, emit } = setup({ getSession: async () => ok({ session: { user } }), getUser: () => verification.promise })
  const ready = session.start()
  await Promise.resolve()
  emit('SIGNED_OUT', null)
  verification.resolve(ok({ user }))
  await ready
  assert.equal(session.getSnapshot().status, 'guest')
})

test('one shared lock prevents repeat requests across dialog close/reopen', async () => {
  const request = deferred()
  let count = 0
  const { session } = setup({ signInWithPassword: args => { count++; assert.equal(args.email, user.email); assert.equal(args.password, '  untouched password  '); return request.promise } })
  await session.start()
  const attempt = session.signIn(` ${user.email} `, '  untouched password  ')
  assert.equal(await session.signIn(user.email, 'another'), false)
  assert.equal(await session.signOut(), false)
  assert.equal(count, 1)
  request.resolve(ok({ user }))
  assert.equal(await attempt, true)
  assert.equal(session.getSnapshot().status, 'signed-in')
  assert.equal(session.getSnapshot().pending, null)
})

test('signup waits for email confirmation; resend observes cooldown and redirect', async () => {
  let time = 1000
  let sent = 0
  const { session } = setup({
    signUp: async args => { assert.equal(args.options.emailRedirectTo, 'http://localhost:5173/'); return ok({ user, session: null }) },
    resend: async args => { sent++; assert.equal(args.type, 'signup'); assert.equal(args.options.emailRedirectTo, 'http://localhost:5173/'); return ok({}) },
  }, { now: () => time })
  await session.start()
  await session.signUp(user.email, 'example password')
  assert.equal(session.getSnapshot().status, 'guest')
  assert.equal(session.getSnapshot().confirmationEmail, user.email)
  assert.equal(await session.resend(user.email), false)
  time += 61000
  assert.equal(await session.resend(user.email), true)
  assert.equal(sent, 1)
})

test('duplicate signup uses neutral check-email feedback', async () => {
  const { session } = setup({ signUp: async () => ({ error: { code: 'user_already_exists' } }) })
  await session.start()
  assert.equal(await session.signUp(user.email, 'example password'), true)
  assert.match(session.getSnapshot().message, /If this address can be registered/)
  assert.equal(session.getSnapshot().error, '')
})

test('sign-out is scoped to this browser; failure retains identity', async () => {
  let failing = true
  const { session } = setup({ signOut: async args => { assert.deepEqual(args, { scope: 'local' }); return failing ? { error: new TypeError('network') } : ok({}) } })
  await session.start()
  await session.signIn(user.email, 'password')
  assert.equal(await session.signOut(), false)
  assert.equal(session.getSnapshot().status, 'signed-in')
  failing = false
  assert.equal(await session.signOut(), true)
  assert.equal(session.getSnapshot().user, null)
})

test('callback errors are safe, cleaned, and offer a new confirmation', async () => {
  let cleaned = false
  const { session } = setup({}, { callback: { present: true, failed: true }, cleanCallback: () => { cleaned = true } })
  await session.start()
  assert.equal(cleaned, true)
  assert.match(session.getSnapshot().error, /expired or has already been used/)
  assert.match(session.getSnapshot().error, /Try signing in/)
})

test('a used link never blocks an existing verified session', async () => {
  const { session } = setup({ getSession: async () => ok({ session: { user } }) }, { callback: { present: true, failed: true } })
  await session.start()
  assert.equal(session.getSnapshot().status, 'signed-in')
  assert.equal(session.getSnapshot().error, '')
  assert.match(session.getSnapshot().message, /signed in/)
})

test('a consumed callback error does not reappear after a later session check', async () => {
  const { session } = setup({}, { callback: { present: true, failed: true } })
  await session.start()
  assert.match(session.getSnapshot().error, /already been used/)
  await session.signIn(user.email, 'original password')
  await session.start()
  assert.equal(session.getSnapshot().error, '')
})

test('a successful resend with no email sent offers sign-in without claiming delivery', async () => {
  // Supabase returns {} for an already-confirmed email without sending mail.
  const { session } = setup({ resend: async () => ok({}) })
  await session.start()
  assert.equal(await session.resend(user.email), true)
  assert.match(session.getSnapshot().message, /Request accepted/)
  assert.match(session.getSnapshot().message, /try signing in instead/)
  assert.doesNotMatch(session.getSnapshot().message, /Email sent|email was sent/)
  await session.signIn(user.email, 'original password')
  assert.equal(session.getSnapshot().status, 'signed-in')
})

test('email sending limits show the provider failure and never a sent-email message', async () => {
  const { session } = setup({ resend: async () => ({ error: { code: 'over_email_send_rate_limit', status: 429 } }) })
  await session.start()
  assert.equal(await session.resend(user.email), false)
  assert.match(session.getSnapshot().error, /email sending limit/)
  assert.equal(session.getSnapshot().message, '')
  assert.equal(session.getSnapshot().pending, null)
  assert.equal(session.getSnapshot().confirmationEmail, '')
  assert.equal(await session.resend(user.email), false)
})

test('auth events synchronize identity and subscriptions can be released', async () => {
  const { session, emit, unsubscribed } = setup()
  let updates = 0
  const unsubscribe = session.subscribe(() => { updates++ })
  await session.start()
  emit('SIGNED_IN', { user })
  assert.equal(session.getSnapshot().status, 'signed-in')
  emit('SIGNED_OUT', null)
  assert.equal(session.getSnapshot().user, null)
  assert.ok(updates > 0)
  unsubscribe()
  session.dispose()
  assert.equal(unsubscribed(), true)
})

test('unconfigured clients remain usable as guests; raw provider errors stay private', async () => {
  const session = createAccountSession(null)
  assert.equal(session.getSnapshot().status, 'unavailable')
  assert.equal(await session.signIn('anything', 'password'), false)
  assert.equal(accountError({ message: 'private token contents' }).includes('private'), false)
})

test('password reset requests are neutral, use the app return URL, and respect cooldown', async () => {
  let calls = 0
  const { session } = setup({ resetPasswordForEmail: async (email, options) => { calls++; assert.equal(email, user.email); assert.equal(options.redirectTo, 'http://localhost:5173/'); return ok({}) } })
  await session.start()
  assert.equal(await session.requestPasswordReset(` ${user.email} `), true)
  assert.equal(session.getSnapshot().resetEmail, user.email)
  assert.match(session.getSnapshot().message, /If this address has an account/)
  assert.equal(await session.requestPasswordReset(user.email), false)
  assert.equal(calls, 1)
})

test('recovery accepts a new password only with a recovery session and retains errors for retry', async () => {
  let calls = 0
  const { session, emit } = setup({ updateUser: async args => { calls++; assert.equal(args.password, '  a new strong password  '); return ok({ user }) } })
  await session.start()
  assert.equal(await session.updatePassword('anything long enough'), false)
  emit('PASSWORD_RECOVERY', { user })
  assert.equal(session.getSnapshot().passwordRecovery, true)
  assert.equal(await session.updatePassword('short'), false)
  assert.equal(calls, 0)
  assert.equal(await session.updatePassword('  a new strong password  '), true)
  assert.equal(calls, 1)
  assert.equal(session.getSnapshot().passwordRecovery, false)
})

test('access tokens cannot be requested for an account that has changed', async () => {
  const { session, emit } = setup({ getSession: async () => ok({ session: { user, access_token: 'private' } }) })
  await session.start()
  assert.equal(await session.getAccessToken(user.id), 'private')
  await assert.rejects(session.getAccessToken('another-account'), /account changed/)
  emit('SIGNED_OUT', null)
  await assert.rejects(session.getAccessToken(user.id), /Sign in/)
})

test('a token read racing an account switch cannot return the next account token', async () => {
  let slow = false
  const pending = deferred()
  const { session, emit } = setup({ getSession: async () => slow ? pending.promise : ok({ session: { user, access_token: 'original-token' } }) })
  await session.start(); slow = true
  const request = session.getAccessToken(user.id)
  const other = { id: 'other-account', email: 'other@example.com' }
  emit('SIGNED_IN', { user: other })
  pending.resolve(ok({ session: { user: other, access_token: 'different-private-token' } }))
  await assert.rejects(request, /account changed/)
})

test('initialization is shared and operations wait until the session check finishes', async () => {
  const pending = deferred(); let checks = 0, requests = 0
  const { session } = setup({ getSession: () => { checks++; return pending.promise }, signInWithPassword: async () => { requests++; return ok({ user }) } })
  const first = session.start(), second = session.start()
  assert.equal(first, second)
  assert.equal(await session.signIn(user.email, 'password'), false)
  pending.resolve(ok({ session: null })); await first
  assert.equal(checks, 1); assert.equal(requests, 0)
})

test('invalid credentials, unconfirmed email, and network failure leave login retryable', async () => {
  for (const error of [{ code: 'invalid_credentials' }, { code: 'email_not_confirmed' }, new TypeError('private provider diagnostic')]) {
    let fail = true
    const { session } = setup({ signInWithPassword: async () => fail ? { error } : ok({ user }) })
    await session.start()
    assert.equal(await session.signIn(user.email, 'password'), false)
    assert.equal(session.getSnapshot().status, 'guest')
    assert.equal(session.getSnapshot().pending, null)
    assert.ok(session.getSnapshot().error)
    assert.equal(session.getSnapshot().errorCode, error.code ?? '')
    assert.doesNotMatch(session.getSnapshot().error, /private provider/)
    fail = false
    assert.equal(await session.signIn(user.email, 'password'), true)
    assert.equal(session.getSnapshot().error, '')
    assert.equal(session.getSnapshot().errorCode, '')
  }
})

test('signup preserves password spaces, trims email, and exposes neither password nor session token', async () => {
  const password = '  Mix room café 🔐  '
  const { session } = setup({ signUp: async args => {
    assert.equal(args.email, user.email); assert.equal(args.password, password)
    return ok({ user, session: { user, access_token: 'secret-access-token' } })
  } })
  await session.start(); await session.signUp(` ${user.email} `, password)
  assert.equal(session.getSnapshot().status, 'signed-in')
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()), /secret-access-token|Mix room café/)
})

test('obfuscated duplicate signup has the same feedback as a new unconfirmed signup', async () => {
  const snapshots = []
  for (const value of [ok({ user, session: null }), ok({ user: { ...user, identities: [] }, session: null }), { error: { code: 'user_already_exists' } }]) {
    const { session } = setup({ signUp: async () => value })
    await session.start(); await session.signUp(user.email, 'a long password')
    snapshots.push(session.getSnapshot())
  }
  for (const result of snapshots) {
    assert.equal(result.status, 'guest'); assert.equal(result.user, null)
    assert.equal(result.message, snapshots[0].message)
  }
})

test('all email actions share a cooldown, including provider failures', async () => {
  let time = 1000, calls = 0
  const { session } = setup({ resetPasswordForEmail: async () => { calls++; return { error: { status: 429 } } }, resend: async () => { calls++; return ok({}) } }, { now: () => time })
  await session.start()
  assert.equal(await session.requestPasswordReset(user.email), false)
  assert.equal(await session.resend(user.email), false)
  assert.equal(calls, 1)
  time += 60001
  assert.equal(await session.resend(user.email), true)
  assert.equal(calls, 2)
})

test('password reset success does not sign in or expose whether the email exists', async () => {
  const results = []
  for (const email of [user.email, 'unknown@example.com']) {
    const { session } = setup({ resetPasswordForEmail: async () => ok({}) })
    await session.start(); await session.requestPasswordReset(email)
    assert.equal(session.getSnapshot().status, 'guest')
    assert.equal(session.getSnapshot().user, null)
    results.push(session.getSnapshot().message)
  }
  assert.equal(results[0], results[1])
})

test('ordinary sign-in cannot update a password through the recovery action', async () => {
  let calls = 0
  const { session } = setup({ updateUser: async () => { calls++; return ok({ user }) } })
  await session.start(); await session.signIn(user.email, 'a long password')
  assert.equal(await session.updatePassword('another long password'), false)
  assert.equal(calls, 0)
})

test('recovery update failures keep the recovery form retryable and prevent duplicate updates', async () => {
  const pending = deferred(); let calls = 0
  const { session, emit } = setup({ updateUser: () => { calls++; return calls === 1 ? pending.promise : ok({ user }) } })
  await session.start(); emit('PASSWORD_RECOVERY', { user })
  const first = session.updatePassword('new long password')
  assert.equal(await session.updatePassword('new long password'), false)
  pending.resolve({ error: { code: 'same_password' } })
  assert.equal(await first, false)
  assert.equal(session.getSnapshot().passwordRecovery, true)
  assert.match(session.getSnapshot().error, /different/)
  assert.equal(await session.updatePassword('a different password'), true)
  assert.equal(session.getSnapshot().passwordRecovery, false)
})

test('expired recovery callbacks cannot turn an ordinary stored session into a recovery session', async () => {
  let updates = 0
  const { session } = setup({ getSession: async () => ok({ session: { user } }), updateUser: async () => { updates++; return ok({ user }) } }, { callback: { present: true, failed: true, recovery: true } })
  await session.start()
  assert.equal(session.getSnapshot().passwordRecovery, false)
  assert.equal(await session.updatePassword('another long password'), false)
  assert.equal(updates, 0)
})

test('account switch exits recovery instead of offering a password change for another user', async () => {
  const { session, emit } = setup()
  await session.start(); emit('PASSWORD_RECOVERY', { user })
  emit('SIGNED_IN', { user: { id: 'another-user', email: 'another@example.com' } })
  assert.equal(session.getSnapshot().passwordRecovery, false)
})

test('sign-out in another tab wins over a delayed login response', async () => {
  const pending = deferred()
  const { session, emit } = setup({ signInWithPassword: () => pending.promise })
  await session.start()
  const request = session.signIn(user.email, 'a long password')
  emit('SIGNED_OUT', null)
  pending.resolve(ok({ user, session: { user } }))
  await request
  assert.equal(session.getSnapshot().status, 'guest')
  assert.equal(session.getSnapshot().user, null)
})

test('late password-update completion does not claim sign-in after cross-tab sign-out', async () => {
  const pending = deferred()
  const { session, emit } = setup({ updateUser: () => pending.promise })
  await session.start(); emit('PASSWORD_RECOVERY', { user })
  const request = session.updatePassword('a new long password')
  emit('SIGNED_OUT', null); pending.resolve(ok({ user })); await request
  assert.equal(session.getSnapshot().status, 'guest')
  assert.doesNotMatch(session.getSnapshot().message, /You’re signed in/)
})

test('error mappings cover rate limits, invalid links, timeout, and unknown errors without raw details', () => {
  for (const code of ['weak_password', 'same_password', 'email_address_invalid', 'validation_failed', 'email_address_not_authorized', 'over_email_send_rate_limit', 'over_request_rate_limit', 'otp_expired', 'flow_state_expired', 'flow_state_not_found', 'unknown']) {
    const result = accountError({ code, message: 'raw confidential details' })
    assert.ok(result); assert.doesNotMatch(result, /confidential/)
  }
  for (const name of ['AbortError', 'TimeoutError', 'AuthRetryableFetchError']) assert.match(accountError({ name }), /connect/)
})

test('a recovery-looking URL alone cannot enable password changes on a stored login', async () => {
  const { session } = setup({ getSession: async () => ok({ session: { user } }) }, { callback: { present: true, recovery: true } })
  await session.start()
  assert.equal(session.getSnapshot().passwordRecovery, false)
})

test('verified recovery events survive refresh-token events for the same account', async () => {
  const { session, emit } = setup()
  await session.start(); emit('PASSWORD_RECOVERY', { user }); emit('TOKEN_REFRESHED', { user })
  assert.equal(session.getSnapshot().passwordRecovery, true)
})

test('a late login error cannot overwrite another tab signing out', async () => {
  const pending = deferred()
  const { session, emit } = setup({ signInWithPassword: () => pending.promise })
  await session.start()
  const request = session.signIn(user.email, 'a long password')
  emit('SIGNED_OUT', null); pending.resolve({ error: { code: 'invalid_credentials' } })
  assert.equal(await request, false)
  assert.equal(session.getSnapshot().error, '')
  assert.match(session.getSnapshot().message, /signed out/)
})

test('a delayed signup cannot display the previous account email after an account switch', async () => {
  const pending = deferred()
  const { session, emit } = setup({ signUp: () => pending.promise })
  await session.start()
  const request = session.signUp(user.email, 'a long password')
  emit('SIGNED_IN', { user }); emit('SIGNED_IN', { user: { id: 'other', email: 'other@example.com' } })
  pending.resolve(ok({ user, session: null })); assert.equal(await request, false)
  assert.equal(session.getSnapshot().confirmationEmail, '')
  assert.equal(session.getSnapshot().user.id, 'other')
})

test('sign-out completion cannot erase the next account signed in by another tab', async () => {
  const pending = deferred()
  const { session, emit } = setup({ signOut: () => pending.promise })
  await session.start(); emit('SIGNED_IN', { user })
  const request = session.signOut()
  emit('SIGNED_IN', { user: { id: 'next-account', email: 'next@example.com' } })
  pending.resolve(ok({})); assert.equal(await request, false)
  assert.equal(session.getSnapshot().user.id, 'next-account')
})

test('sign-out failure reconciles an SDK-cleared local session without restoring identity', async () => {
  const { session, emit } = setup({ signOut: async () => { emit('SIGNED_OUT', null); return { error: new TypeError('network') } } })
  await session.start(); await session.signIn(user.email, 'a long password')
  assert.equal(await session.signOut(), false)
  assert.equal(session.getSnapshot().status, 'guest')
  assert.equal(session.getSnapshot().user, null)
  assert.match(session.getSnapshot().error, /server sign-out could not be confirmed/)
  assert.equal(session.getSnapshot().message, '')
})

test('email settings keep the current identity while confirmation is pending, and survive reload', async () => {
  let updated
  const { session, emit } = setup({ updateUser: async (attrs, options) => { updated = { attrs, options }; return ok({ user: { ...user, new_email: attrs.email } }) } })
  await session.start(); emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  assert.equal(await session.changeEmail(' next@example.com '), true)
  assert.deepEqual(updated, { attrs: { email: 'next@example.com' }, options: { emailRedirectTo: 'http://localhost:5173/' } })
  assert.equal(session.getSnapshot().user.email, user.email)
  assert.equal(session.getSnapshot().pendingEmail, 'next@example.com')
  emit('USER_UPDATED', { user: { ...user, email: 'next@example.com' } })
  assert.equal(session.getSnapshot().pendingEmail, '')
  assert.equal(session.getSnapshot().user.email, 'next@example.com')
  const restored = setup({ getSession: async () => ok({ session: { user } }), getUser: async () => ok({ user: { ...user, new_email: 'pending@example.com' } }) })
  await restored.session.start()
  assert.equal(restored.session.getSnapshot().pendingEmail, 'pending@example.com')
})

test('email settings validate before sending and handle immediate provider confirmation', async () => {
  let calls = 0
  const { session, emit } = setup({ updateUser: async attrs => { calls++; return ok({ user: { ...user, email: attrs.email } }) } })
  await session.start()
  assert.equal(await session.changeEmail('next@example.com'), false)
  emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  for (const value of ['', 'bad-email', user.email.toUpperCase()]) assert.equal(await session.changeEmail(value), false)
  assert.equal(calls, 0)
  assert.equal(await session.changeEmail('next@example.com'), true)
  assert.equal(session.getSnapshot().pendingEmail, '')
  assert.match(session.getSnapshot().message, /has been updated/)
})

test('email changes preserve pending identity on provider failure and ignore late account-switch results', async () => {
  const deferredUpdate = deferred()
  const { session, emit } = setup({ updateUser: () => deferredUpdate.promise })
  await session.start(); emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  const pending = session.changeEmail('next@example.com')
  assert.equal(await session.changeEmail('second@example.com'), false)
  emit('SIGNED_IN', { user: { id: 'other-account', email: 'other@example.com' } })
  deferredUpdate.resolve(ok({ user: { ...user, new_email: 'next@example.com' } }))
  assert.equal(await pending, false)
  assert.equal(session.getSnapshot().pendingEmail, '')
  assert.equal(session.getSnapshot().user.id, 'other-account')
})

test('signed-in password settings validate, preserve spaces, and never expose credentials', async () => {
  let attrs
  const { session, emit } = setup({ updateUser: async value => { attrs = value; return ok({ user }) } })
  await session.start()
  assert.equal(await session.changePassword('long new password', { currentPassword: 'old password' }), false)
  emit('SIGNED_IN', { user })
  assert.equal(await session.changePassword('short', { currentPassword: 'old' }), false)
  assert.equal(await session.changePassword('long new password'), false)
  assert.equal(await session.changePassword('long new password', { currentPassword: 'long new password' }), false)
  assert.equal(attrs, undefined)
  assert.equal(await session.changePassword('  long new password  ', { currentPassword: '  old password  ', nonce: ' 123456 ' }), true)
  assert.deepEqual(attrs, { password: '  long new password  ', current_password: '  old password  ', nonce: '123456' })
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()), /old password|long new password|123456/)
  assert.match(session.getSnapshot().message, /password has been updated/)
})

test('password verification uses a cooldown, retries invalid nonce, and can finish after reauthentication', async () => {
  let clock = 1000, sent = 0, changes = 0
  const { session, emit } = setup({ reauthenticate: async () => { sent++; return ok({}) }, updateUser: async attrs => { changes++; return attrs.nonce === '654321' ? ok({ user }) : { error: { code: changes === 1 ? 'reauthentication_needed' : 'reauthentication_not_valid' } } } }, { now: () => clock })
  await session.start(); emit('SIGNED_IN', { user })
  assert.equal(await session.changePassword('long new password', { currentPassword: 'current password' }), false)
  assert.equal(session.getSnapshot().errorCode, 'reauthentication_needed')
  assert.equal(await session.requestReauthentication(), true)
  assert.equal(session.getSnapshot().reauthenticationSent, true)
  assert.equal(await session.requestReauthentication(), false)
  clock += 61000
  assert.equal(await session.requestReauthentication(), true)
  assert.equal(sent, 2)
  assert.equal(await session.changePassword('long new password', { currentPassword: 'current password', nonce: '111111' }), false)
  assert.equal(session.getSnapshot().errorCode, 'reauthentication_not_valid')
  assert.equal(await session.changePassword('long new password', { currentPassword: 'current password', nonce: '654321' }), true)
  assert.equal(session.getSnapshot().reauthenticationSent, false)
})

test('settings operations refuse recovery sessions and late completions cannot override sign-out', async () => {
  const pending = deferred()
  const { session, emit } = setup({ updateUser: () => pending.promise })
  await session.start(); emit('PASSWORD_RECOVERY', { user })
  assert.equal(await session.changeEmail('next@example.com'), false)
  assert.equal(await session.changePassword('long new password', { currentPassword: 'current password' }), false)
  assert.equal(await session.requestReauthentication(), false)
  emit('SIGNED_OUT', null); emit('SIGNED_IN', { user })
  const update = session.changePassword('long new password', { currentPassword: 'current password' })
  emit('SIGNED_OUT', null); pending.resolve(ok({ user }))
  assert.equal(await update, false)
  assert.equal(session.getSnapshot().user, null)
  assert.doesNotMatch(session.getSnapshot().message, /password has been updated/)
})

test('expired settings sessions clear identity and return a safe sign-in message', async () => {
  const { session, emit } = setup({ updateUser: async () => ({ error: { code: 'session_not_found', status: 401 } }) })
  await session.start(); emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  assert.equal(await session.changeEmail('next@example.com'), false)
  assert.equal(session.getSnapshot().status, 'guest')
  assert.equal(session.getSnapshot().pendingEmail, '')
  assert.match(session.getSnapshot().error, /session ended/)
})

test('provider rejection preserves pending email and recognizes current-password errors', async () => {
  let code = 'email_exists'
  const { session, emit } = setup({ updateUser: async () => ({ error: { code, status: 400 } }) })
  await session.start(); emit('SIGNED_IN', { user: { ...user, new_email: 'pending@example.com' } })
  await verifyEmailForChange(session)
  assert.equal(await session.changeEmail('taken@example.com'), false)
  assert.equal(session.getSnapshot().pendingEmail, 'pending@example.com')
  assert.equal(session.getSnapshot().user.email, user.email)
  for (code of ['current_password_required', 'current_password_invalid', 'current_password_mismatch']) {
    assert.equal(await session.changePassword('long new password', { currentPassword: 'current password' }), false)
    assert.match(session.getSnapshot().error, /current password/)
    assert.equal(session.getSnapshot().status, 'signed-in')
  }
})

test('failed verification requests keep cooldown and sign-out clears verification state', async () => {
  let clock = 1000, offline = true
  const { session, emit } = setup({ reauthenticate: async () => { if (offline) throw new TypeError('network'); return ok({}) } }, { now: () => clock })
  await session.start(); emit('SIGNED_IN', { user })
  assert.equal(await session.requestReauthentication(), false)
  assert.equal(session.getSnapshot().reauthenticationSent, false)
  assert.equal(await session.requestReauthentication(), false)
  clock += 61000; offline = false
  assert.equal(await session.requestReauthentication(), true)
  assert.equal(await session.signOut(), true)
  assert.equal(session.getSnapshot().reauthenticationSent, false)
  assert.equal(session.getSnapshot().reauthenticateAt, 0)
})

test('SDK AuthSessionMissingError is treated as expiry even without the original API code', async () => {
  const { session, emit } = setup({ updateUser: async () => ({ error: { name: 'AuthSessionMissingError', status: 400 } }) })
  await session.start(); emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  assert.equal(await session.changeEmail('next@example.com'), false)
  assert.equal(session.getSnapshot().status, 'guest')
  assert.match(session.getSnapshot().error, /session ended/)
})

test('a confirmed login alone cannot change email; verification targets only its current inbox', async () => {
  let request, verified, changes = 0
  const { session, emit } = setup({
    signInWithOtp: async args => { request = args; return ok({}) },
    verifyOtp: async args => { verified = args; return ok({ user, session: { user } }) },
    updateUser: async attrs => { changes++; return ok({ user: { ...user, new_email: attrs.email } }) },
  })
  await session.start()
  assert.equal(await session.requestEmailVerification(), false)
  emit('SIGNED_IN', { user })
  assert.equal(await session.changeEmail('next@example.com'), false)
  assert.equal(changes, 0)
  assert.match(session.getSnapshot().error, /Verify your current email/)
  assert.equal(await session.verifyCurrentEmail('123456'), false)
  assert.equal(await session.requestEmailVerification('attacker@example.com'), true)
  assert.deepEqual(request, { email: user.email, options: { shouldCreateUser: false } })
  assert.equal(await session.changeEmail('next@example.com'), false)
  // A rejected direct change clears the pending challenge; start a fresh one.
  assert.equal(verified, undefined)
})

test('valid OTP unlocks one email change and neither OTP nor tokens enter public account state', async () => {
  let attrs
  const { session, emit } = setup({
    verifyOtp: async args => { assert.deepEqual(args, { email: user.email, token: '123456', type: 'email' }); return ok({ user, session: { user, access_token: 'private-verification-token' } }) },
    updateUser: async value => { attrs = value; return ok({ user: { ...user, new_email: value.email } }) },
  })
  await session.start(); emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  assert.ok(session.getSnapshot().emailVerifiedUntil > Date.now())
  assert.equal(await session.changeEmail('next@example.com'), true)
  assert.deepEqual(attrs, { email: 'next@example.com' })
  assert.match(session.getSnapshot().message, /Check your new inbox/)
  assert.doesNotMatch(session.getSnapshot().message, /current inbox|both inboxes/)
  assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  assert.equal(await session.changeEmail('another@example.com'), false)
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()), /123456|private-verification-token/)
})

test('invalid and expired OTPs keep the signed-in identity and cannot unlock the email form', async () => {
  let attempts = 0
  const { session, emit } = setup({ verifyOtp: async () => { attempts++; return { error: { code: 'otp_expired', status: 403 } } } })
  await session.start(); emit('SIGNED_IN', { user })
  await session.requestEmailVerification()
  assert.equal(await session.verifyCurrentEmail('bad'), false)
  assert.equal(attempts, 0)
  assert.equal(await session.verifyCurrentEmail('111111'), false)
  assert.equal(session.getSnapshot().status, 'signed-in')
  assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  assert.equal(session.getSnapshot().emailVerificationSent, true)
  assert.match(session.getSnapshot().error, /code is invalid or has expired/)
})

test('verification requests share cooldown and locking, including sending failures', async () => {
  let clock = 1000, sent = 0, offline = true
  const { session, emit } = setup({ signInWithOtp: async () => { sent++; if (offline) throw new TypeError('network'); return ok({}) } }, { now: () => clock })
  await session.start(); emit('SIGNED_IN', { user })
  assert.equal(await session.requestEmailVerification(), false)
  assert.equal(await session.requestEmailVerification(), false)
  assert.equal(await session.requestPasswordReset(user.email), false)
  assert.equal(session.getSnapshot().emailVerificationSent, false)
  assert.equal(sent, 1)
  clock += 61000; offline = false
  assert.equal(await session.requestEmailVerification(), true)
  assert.equal(sent, 2)
})

test('email verification expires, is cleared on closing Account, and is never restored from a session', async () => {
  let clock = 1000
  const { session, emit } = setup({}, { now: () => clock })
  await session.start(); emit('SIGNED_IN', { user })
  await verifyEmailForChange(session)
  clock += EMAIL_CHANGE_VERIFICATION_MS
  assert.equal(await session.changeEmail('next@example.com'), false)
  await verifyEmailForChange(session)
  session.clearEmailVerification()
  assert.equal(await session.changeEmail('next@example.com'), false)
  const restored = setup({ getSession: async () => ok({ session: { user } }) })
  await restored.session.start()
  assert.equal(restored.session.getSnapshot().emailVerifiedUntil, 0)
  assert.equal(await restored.session.changeEmail('next@example.com'), false)
})

test('closing the page invalidates delayed send and verify completions', async () => {
  for (const step of ['send', 'verify']) {
    const gate = deferred()
    const { session, emit } = setup(step === 'send' ? { signInWithOtp: () => gate.promise } : { verifyOtp: () => gate.promise })
    await session.start(); emit('SIGNED_IN', { user })
    if (step === 'verify') await session.requestEmailVerification()
    const pending = step === 'send' ? session.requestEmailVerification() : session.verifyCurrentEmail('123456')
    session.clearEmailVerification()
    gate.resolve(ok(step === 'send' ? {} : { user, session: { user } }))
    assert.equal(await pending, false)
    assert.equal(session.getSnapshot().emailVerificationSent, false)
    assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  }
})

test('an isolated OTP verifier cannot replace an account switched in another tab', async () => {
  const gate = deferred(), signedOut = []
  const verifier = { signInWithOtp: async () => ok({}), verifyOtp: () => gate.promise, signOut: async options => { signedOut.push(options); return ok({}) } }
  const { session, emit } = setup({}, { emailVerifier: verifier })
  await session.start(); emit('SIGNED_IN', { user })
  await session.requestEmailVerification()
  const pending = session.verifyCurrentEmail('123456')
  emit('SIGNED_IN', { user: { id: 'other', email: 'other@example.com' } })
  gate.resolve(ok({ user, session: { user } }))
  assert.equal(await pending, false)
  assert.equal(session.getSnapshot().user.id, 'other')
  assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  assert.deepEqual(signedOut, [{ scope: 'local' }])
})

test('OTP response identity must match the signed-in account and its current email', async () => {
  for (const incorrect of [{ ...user, id: 'other' }, { ...user, email: 'other@example.com' }]) {
    const { session, emit } = setup({ verifyOtp: async () => ok({ user: incorrect, session: { user: incorrect } }) })
    await session.start(); emit('SIGNED_IN', { user })
    await session.requestEmailVerification()
    assert.equal(await session.verifyCurrentEmail('123456'), false)
    assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
  }
})

test('sign-out, actual email changes, and recovery clear verification; a token refresh retains it', async () => {
  for (const [event, next] of [['SIGNED_OUT', null], ['USER_UPDATED', { user: { ...user, email: 'new@example.com' } }], ['PASSWORD_RECOVERY', { user }]]) {
    const { session, emit } = setup()
    await session.start(); emit('SIGNED_IN', { user })
    await verifyEmailForChange(session)
    const until = session.getSnapshot().emailVerifiedUntil
    emit('TOKEN_REFRESHED', { user })
    assert.equal(session.getSnapshot().emailVerifiedUntil, until)
    emit(event, next)
    assert.equal(session.getSnapshot().emailVerifiedUntil, 0)
    assert.equal(await session.changeEmail('next@example.com'), false)
  }
})
