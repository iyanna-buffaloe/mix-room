const confirmationLinkHelp = 'This link has expired or has already been used. Your email may already be confirmed. Try signing in, or request a new confirmation link.'
const emailVerificationRequired = 'Verify your current email address before changing it.'
export const EMAIL_CHANGE_VERIFICATION_MS = 5 * 60 * 1000

export function accountError(error) {
  if (error?.code === 'email_verification_invalid') return 'That verification code is invalid or has expired. Try again or request a new code.'
  if (error?.code === 'invalid_credentials') return 'Email or password is incorrect.'
  if (error?.code === 'email_not_confirmed') return 'Confirm your email before signing in.'
  if (error?.code === 'weak_password') return 'Choose a stronger password with at least 12 characters.'
  if (error?.code === 'same_password') return 'Choose a password different from your current password.'
  if (error?.code === 'current_password_required') return 'Enter your current password.'
  if (['current_password_invalid', 'current_password_mismatch'].includes(error?.code)) return 'Your current password is incorrect.'
  if (error?.code === 'reauthentication_needed') return 'Verify it’s you with a code before changing your password.'
  if (error?.code === 'reauthentication_not_valid') return 'That verification code is invalid or expired. Request a new code and try again.'
  if (['email_exists', 'user_already_exists'].includes(error?.code)) return 'That email address can’t be used. Try another address.'
  if (error?.code === 'email_address_invalid' || error?.code === 'validation_failed') return 'Check your email address and try again.'
  if (error?.code === 'over_email_send_rate_limit') return 'The email sending limit has been reached. Please wait before requesting another email.'
  if (error?.code === 'email_address_not_authorized') return 'Confirmation email cannot be delivered to this address right now. Try signing in if you already confirmed your email.'
  if (error?.status === 429 || /rate_limit/.test(error?.code ?? '')) return 'Too many attempts. Please wait before trying again.'
  if (['otp_expired', 'flow_state_expired', 'flow_state_not_found'].includes(error?.code)) return confirmationLinkHelp
  if (error?.status === 0 || error instanceof TypeError || ['AbortError', 'TimeoutError', 'AuthRetryableFetchError'].includes(error?.name)) return "Couldn't connect. Check your connection and try again."
  return "Couldn't complete that request. Please try again."
}

const endedSession = error => error?.name === 'AuthSessionMissingError' || ['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found'].includes(error?.code) || error?.status === 401 || error?.status === 403

// One controller per page keeps the request lock alive when the dialog closes.
// It exposes identity only; session tokens remain managed by the Supabase SDK.
export function createAccountSession(auth, { redirectTo, callback = {}, cleanCallback = () => {}, now = Date.now, emailVerifier = auth } = {}) {
  let state = { status: auth ? 'checking' : 'unavailable', user: null, pending: null, error: '', errorCode: '', message: '', confirmationEmail: '', resetEmail: '', passwordRecovery: false, resendAt: 0, pendingEmail: '', reauthenticationSent: false, reauthenticateAt: 0, emailVerificationSent: false, emailVerifiedUntil: 0 }
  let initialization = null
  let subscription = null
  let revision = 0
  let accountBoundary = 0
  let callbackPending = Boolean(callback.present || callback.failed)
  let emailProof = null, emailVerificationGeneration = 0
  const listeners = new Set()
  const patch = value => { state = { ...state, ...value }; for (const listener of listeners) listener() }
  const identity = user => ({ status: user ? 'signed-in' : 'guest', user: user ? { id: user.id, email: user.email } : null, pendingEmail: user?.new_email || '' })
  const check = result => { if (result.error) throw result.error; return result.data }
  const invalidateEmailVerification = () => {
    emailProof = null; emailVerificationGeneration++
    return { emailVerificationSent: false, emailVerifiedUntil: 0 }
  }
  const clearEmailVerification = () => {
    const active = emailProof || state.emailVerificationSent || state.pending?.startsWith('email-verify')
    patch({ ...invalidateEmailVerification(), ...(active ? { message: '', error: '', errorCode: '' } : {}) })
  }

  const start = () => {
    if (!auth) { cleanCallback(); return null }
    if (initialization || state.pending) return initialization
    patch({ status: 'checking', error: '', errorCode: '' })
    if (!subscription) {
      subscription = auth.onAuthStateChange((event, session) => {
        if (event === 'INITIAL_SESSION') return
        revision++
        const sameUser = state.user?.id === session?.user?.id
        const sameEmail = state.user?.email?.toLowerCase() === session?.user?.email?.toLowerCase()
        if (event === 'SIGNED_OUT' || (state.user && !sameUser)) accountBoundary++
        // Never await an auth method inside this SDK callback (it holds a lock).
        patch({ ...identity(session?.user), ...((session?.user || event === 'SIGNED_OUT') ? { confirmationEmail: '', resetEmail: '' } : {}), passwordRecovery: event === 'PASSWORD_RECOVERY' && Boolean(session?.user) ? true : event === 'SIGNED_OUT' || !sameUser ? false : state.passwordRecovery,
          ...(!sameUser ? { reauthenticationSent: false, reauthenticateAt: 0 } : {}),
          ...(!sameUser || !sameEmail || event === 'PASSWORD_RECOVERY' || event === 'SIGNED_OUT' ? invalidateEmailVerification() : {}),
          error: '', errorCode: '', message: event === 'SIGNED_OUT' ? 'You’re signed out.' : '' })
      }).data.subscription
    }
    const startedAt = revision
    initialization = (async () => {
      try {
        const session = check(await auth.getSession()).session
        const user = session ? check(await auth.getUser()).user : null
        if (revision === startedAt) patch(identity(user))
        if (callbackPending) {
          if (state.user && callback.failed && callback.recovery) patch({ passwordRecovery: false, error: 'This password reset link has expired or has already been used. Request a new password reset email.', errorCode: 'recovery_link_invalid' })
          else if (state.user) patch({ message: state.passwordRecovery ? 'Choose a new password to finish recovery.' : 'You’re signed in.', error: '' })
          else if (callback.failed) patch({ error: callback.recovery ? 'This password reset link has expired or has already been used. Request a new password reset email.' : confirmationLinkHelp, errorCode: callback.recovery ? 'recovery_link_invalid' : 'confirmation_link_invalid' })
          else patch({ message: 'Sign in to continue after confirming your email.' })
        }
      } catch (error) {
        if (revision === startedAt) patch({ status: endedSession(error) ? 'guest' : 'error', user: null, error: endedSession(error) ? 'Your session ended. Sign in again.' : accountError(error), errorCode: error?.code ?? '' })
      } finally {
        callbackPending = false
        cleanCallback()
        initialization = null
      }
    })()
    return initialization
  }

  const run = async (operation, action) => {
    if (!auth || state.pending || state.status === 'checking') return false
    const boundary = accountBoundary
    const current = () => boundary === accountBoundary
    patch({ pending: operation, error: '', errorCode: '', message: '' })
    try { return await action(current) !== false }
    catch (error) {
      if (current()) {
        if (endedSession(error) && state.status === 'signed-in') {
          accountBoundary++; revision++
          patch({ ...identity(null), ...invalidateEmailVerification(), passwordRecovery: false, reauthenticationSent: false, reauthenticateAt: 0, error: 'Your session ended. Sign in again.', errorCode: error?.code ?? '' })
        } else patch({ error: accountError(error), errorCode: error?.code ?? '' })
      }
      return false
    }
    finally { patch({ pending: null }) }
  }

  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start,
    clearFeedback: () => patch({ error: '', errorCode: '', message: '', confirmationEmail: '', resetEmail: '' }),
    clearEmailVerification,
    requestEmailVerification: () => {
      if (state.status !== 'signed-in' || state.passwordRecovery || state.resendAt > now()) return Promise.resolve(false)
      return run('email-verify-send', async current => {
        const email = state.user.email
        const reset = invalidateEmailVerification(), generation = emailVerificationGeneration
        patch({ ...reset, resendAt: now() + 60000 })
        // Only the signed-in account's current inbox can unlock this form.
        // Do not create accounts or overwrite their metadata through this call.
        check(await emailVerifier.signInWithOtp({ email, options: { shouldCreateUser: false } }))
        if (!current() || generation !== emailVerificationGeneration) return false
        patch({ emailVerificationSent: true, message: 'Check your current email inbox for a verification code.' })
      })
    },
    verifyCurrentEmail: value => {
      if (state.status !== 'signed-in' || state.passwordRecovery || !state.emailVerificationSent) return Promise.resolve(false)
      const token = typeof value === 'string' ? value.trim() : ''
      if (!/^\d{6,10}$/.test(token)) { patch({ error: 'Enter the verification code from your email.', errorCode: 'email_verification_invalid' }); return Promise.resolve(false) }
      return run('email-verify-code', async current => {
        const expected = { id: state.user.id, email: state.user.email.toLowerCase() }, generation = emailVerificationGeneration
        let data
        try { data = check(await emailVerifier.verifyOtp({ email: state.user.email, token, type: 'email' })) }
        catch (error) {
          // An invalid OTP may use HTTP 403; it must not sign out the existing
          // valid account or be mistaken for an expired account session.
          if (['otp_expired', 'otp_disabled'].includes(error?.code)) throw Object.assign(new Error('Invalid verification code'), { code: 'email_verification_invalid' })
          throw error
        }
        finally {
          // The isolated verifier must not replace the active browser login,
          // including when its response arrives after an account switch.
          if (emailVerifier !== auth) await emailVerifier.signOut({ scope: 'local' }).catch(() => {})
        }
        if (!current() || generation !== emailVerificationGeneration) return false
        if (data.user?.id !== expected.id || data.user?.email?.toLowerCase() !== expected.email || data.session?.user?.id !== expected.id) {
          patch({ ...invalidateEmailVerification(), error: 'Your account changed. Verify your current email again.', errorCode: 'email_verification_invalid' })
          return false
        }
        const until = now() + EMAIL_CHANGE_VERIFICATION_MS
        emailProof = { ...expected, until }
        patch({ emailVerificationSent: false, emailVerifiedUntil: until, message: 'Email verified. You can now enter your new email address.' })
      })
    },
    changeEmail: email => {
      if (state.status !== 'signed-in' || state.passwordRecovery) return Promise.resolve(false)
      if (!emailProof || emailProof.id !== state.user.id || emailProof.email !== state.user.email.toLowerCase() || emailProof.until <= now()) {
        patch({ ...invalidateEmailVerification(), error: emailVerificationRequired, errorCode: 'email_verification_required' })
        return Promise.resolve(false)
      }
      const address = typeof email === 'string' ? email.trim() : ''
      if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { patch({ error: 'Enter a valid email address.', errorCode: '' }); return Promise.resolve(false) }
      if (address.toLowerCase() === state.user.email?.toLowerCase()) { patch({ error: 'Enter a different email address.', errorCode: '' }); return Promise.resolve(false) }
      return run('change-email', async current => {
        const data = check(await auth.updateUser({ email: address }, { emailRedirectTo: redirectTo }))
        if (!current()) return false
        const changed = data.user?.email?.toLowerCase() === address.toLowerCase()
        patch({ ...invalidateEmailVerification(), ...(data.user ? identity(data.user) : {}), pendingEmail: changed ? '' : data.user?.new_email || address,
          message: changed ? 'Your email address has been updated.' : 'Check your new inbox for a confirmation email. Your sign-in address stays the same until you confirm the new address.' })
      })
    },
    changePassword: (password, { currentPassword, nonce } = {}) => {
      if (state.status !== 'signed-in' || state.passwordRecovery) return Promise.resolve(false)
      if (!currentPassword) { patch({ error: 'Enter your current password.', errorCode: '' }); return Promise.resolve(false) }
      if (typeof password !== 'string' || password.length < 12) { patch({ error: 'Use at least 12 characters.', errorCode: '' }); return Promise.resolve(false) }
      if (password === currentPassword) { patch({ error: 'Choose a password different from your current password.', errorCode: '' }); return Promise.resolve(false) }
      return run('change-password', async current => {
        check(await auth.updateUser({ password, current_password: currentPassword, ...(nonce?.trim() ? { nonce: nonce.trim() } : {}) }))
        if (!current()) return false
        patch({ reauthenticationSent: false, message: 'Your password has been updated.' })
      })
    },
    requestReauthentication: () => {
      if (state.status !== 'signed-in' || state.passwordRecovery || state.reauthenticateAt > now()) return Promise.resolve(false)
      return run('reauthenticate', async current => {
        patch({ reauthenticateAt: now() + 60000 })
        check(await auth.reauthenticate())
        if (!current()) return false
        patch({ reauthenticationSent: true, message: 'Verification code requested. Check your email, then enter the code below.' })
      })
    },
    getAccessToken: async expectedUserId => {
      if (!auth || state.status !== 'signed-in') throw new Error('Sign in to continue.')
      const requestedUserId = expectedUserId ?? state.user.id
      if (state.user?.id !== requestedUserId) throw new Error('Your account changed. Sign in again.')
      const data = check(await auth.getSession())
      if (!data.session || state.user?.id !== requestedUserId || data.session.user?.id !== requestedUserId) throw new Error('Your account changed. Sign in again.')
      if (typeof data.session.access_token !== 'string' || !data.session.access_token) throw new Error('Your session is unavailable. Sign in again.')
      return data.session.access_token
    },
    requestPasswordReset: email => {
      if (state.resendAt > now()) return Promise.resolve(false)
      return run('reset-email', async current => {
        const address = email.trim()
        patch({ resendAt: now() + 60000 })
        check(await auth.resetPasswordForEmail(address, { redirectTo }))
        if (!current()) return false
        patch({ resetEmail: address, confirmationEmail: '', message: 'If this address has an account, a password reset link will arrive. Check your inbox and spam folder.' })
      })
    },
    updatePassword: password => {
      if (!state.passwordRecovery || state.status !== 'signed-in') return Promise.resolve(false)
      if (typeof password !== 'string' || password.length < 12) { patch({ error: 'Use at least 12 characters.' }); return Promise.resolve(false) }
      return run('update-password', async current => {
        check(await auth.updateUser({ password }))
        if (!current()) return false
        patch({ passwordRecovery: false, resetEmail: '', message: 'Password updated. You’re signed in.' })
      })
    },
    signIn: (email, password) => run('sign-in', async current => {
      const data = check(await auth.signInWithPassword({ email: email.trim(), password }))
      if (!current()) return false
      revision++
      patch({ ...identity(data.user), confirmationEmail: '', resetEmail: '', message: 'You’re signed in.' })
    }),
    signUp: (email, password) => run('sign-up', async current => {
      const address = email.trim()
      let data
      try { data = check(await auth.signUp({ email: address, password, options: { emailRedirectTo: redirectTo } })) }
      catch (error) { if (error?.code !== 'user_already_exists') throw error; data = {} }
      if (!current()) return false
      revision++
      patch({ ...(data.session ? identity(data.user) : {}), confirmationEmail: data.session ? '' : address, resendAt: now() + 60000,
        message: data.session ? 'You’re signed in.' : 'If this address can be registered, a confirmation link will arrive. Open it to verify your email.' })
    }),
    resend: email => {
      if (state.resendAt > now()) return Promise.resolve(false)
      return run('resend', async current => {
        const address = email.trim()
        // Start the cooldown even on failure to avoid repeated email requests.
        patch({ resendAt: now() + 60000 })
        check(await auth.resend({ type: 'signup', email: address, options: { emailRedirectTo: redirectTo } }))
        if (!current()) return false
        patch({ confirmationEmail: address, message: 'Request accepted. If this address still needs confirmation, a new link will arrive. If already confirmed, try signing in instead.' })
      })
    },
    signOut: () => run('sign-out', async () => {
      const previousUser = state.user?.id
      const result = await auth.signOut({ scope: 'local' })
      if (state.user && state.user.id !== previousUser) return false
      // The SDK can remove its local session even when remote revocation fails.
      // Report the actual local state without restoring a cached identity.
      if (result.error && state.status === 'guest') {
        patch({ error: 'You’re signed out in this browser, but server sign-out could not be confirmed. Check your connection.', message: '' })
        return false
      }
      check(result)
      revision++
      patch({ ...identity(null), ...invalidateEmailVerification(), confirmationEmail: '', resetEmail: '', passwordRecovery: false, reauthenticationSent: false, reauthenticateAt: 0, message: 'You’re signed out.' })
    }),
    dispose: () => { subscription?.unsubscribe(); subscription = null; listeners.clear() },
  }
}
