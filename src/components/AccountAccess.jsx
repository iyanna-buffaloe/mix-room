import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import { getAccountConnection } from '../auth/supabase.js'
import './AccountAccess.css'

const titles = {
  'sign-in': 'Sign in', 'sign-up': 'Create account', forgot: 'Reset password',
  verify: 'Verify your email', 'verify-sent': 'Check your email', 'reset-sent': 'Check your email',
  'new-password': 'Choose a new password', 'password-updated': 'Password updated',
  'link-invalid': 'Let’s get you back in', account: 'Account', checking: 'One moment…',
  unavailable: 'Accounts are unavailable', error: 'Let’s reconnect',
}

function AccountIcon({ kind = 'person' }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'mail' ? <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>
      : kind === 'check' ? <path d="m5 12 4 4L19 6" />
        : <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>}
  </svg>
}

function focusInvoker(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest('[hidden], [inert]') || element.matches(':disabled') || !element.getClientRects().length || getComputedStyle(element).visibility !== 'visible') return false
  element.focus({ preventScroll: true })
  return document.activeElement === element
}

export default function AccountAccess({ hidden = false, disabled = false, onBeforeSignOut, onAfterSignOut, credits, openRequest, onDismiss, onOpenAccount, accountPageOpen = false, viewport }) {
  const [{ session, callback, localConfirmation }] = useState(getAccountConnection)
  const account = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [open, setOpen] = useState(callback.present)
  const [mode, setMode] = useState(callback.failed ? callback.recovery ? 'forgot' : 'link-invalid' : 'sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [tick, setTick] = useState(() => Date.now())
  const [leaving, setLeaving] = useState(false)
  const [confirmationNotice, setConfirmationNotice] = useState(callback.present && !callback.failed && !callback.recovery)
  const dialog = useRef(null), opener = useRef(null), returnFocus = useRef(null), errorSummary = useRef(null), heading = useRef(null)
  const opened = useRef(open), previousUser = useRef(null), signOutGuard = useRef(false)
  const focusModeTab = useRef(false)
  const waiting = Boolean(account.pending) || account.status === 'checking' || leaving
  const signedIn = account.status === 'signed-in'
  const cooldown = Math.max(0, Math.ceil((account.resendAt - tick) / 1000))
  const screen = ['checking', 'unavailable', 'error'].includes(account.status) ? account.status
    : account.passwordRecovery ? 'new-password'
      : mode === 'password-updated' && signedIn ? mode
        : mode === 'forgot' ? account.resetEmail ? 'reset-sent' : 'forgot'
          : signedIn ? 'account'
            : account.confirmationEmail ? 'verify-sent' : mode
  const emailScreen = ['verify-sent', 'reset-sent'].includes(screen)
  const address = account.confirmationEmail || account.resetEmail || email
  const isForm = ['sign-in', 'sign-up', 'forgot', 'verify', 'new-password'].includes(screen)
  const emailOnly = ['forgot', 'verify'].includes(screen)
  const passwordMismatch = screen === 'sign-up' && confirmation.length > 0 && password !== confirmation
  const signupIncomplete = screen === 'sign-up' && (password.length < 12 || password !== confirmation)

  useEffect(() => { session.start() }, [session])
  useEffect(() => { if (account.passwordRecovery) { setPassword(''); setConfirmation(''); setShowPassword(false); setOpen(true) } }, [account.passwordRecovery])
  useEffect(() => {
    if (previousUser.current && previousUser.current !== account.user?.id) {
      setEmail(''); setPassword(''); setConfirmation(''); setShowPassword(false); setMode('sign-in')
    }
    previousUser.current = account.user?.id ?? null
  }, [account.user?.id])
  useEffect(() => {
    if (openRequest) {
      if (!dialog.current.open) returnFocus.current = openRequest.returnFocusTo ?? document.activeElement
      session.clearFeedback(); setMode(openRequest.mode || 'sign-in'); setPassword(''); setConfirmation(''); setShowPassword(false); setOpen(true)
    }
  }, [openRequest, session])
  useEffect(() => {
    if (!open || !account.resendAt) return
    setTick(Date.now())
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, account.resendAt])
  useEffect(() => {
    opened.current = open
    if (open && !dialog.current.open) {
      returnFocus.current ??= document.activeElement
      dialog.current.showModal()
    }
    if (!open && dialog.current.open) {
      dialog.current.close()
      // Return to the control that opened this dialog, unless it is no longer usable.
      if (!focusInvoker(returnFocus.current)) focusInvoker(opener.current)
      returnFocus.current = null
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const target = focusModeTab.current ? dialog.current.querySelector('[role="tab"][aria-selected="true"]') : dialog.current.querySelector('input:not(:disabled)') || heading.current
    focusModeTab.current = false
    target?.focus({ preventScroll: true })
  }, [open, screen])
  useEffect(() => {
    if (!open) return
    const panel = dialog.current
    let scheduled
    const revealField = () => {
      const field = document.activeElement
      if (panel.contains(field) && field.matches('input')) field.scrollIntoView({ block: 'nearest' })
    }
    // Let the browser finish its caret scroll before revealing the whole input.
    const revealAfterFocus = () => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(revealField)
    }
    revealField()
    panel.addEventListener('focusin', revealAfterFocus)
    return () => {
      cancelAnimationFrame(scheduled)
      panel.removeEventListener('focusin', revealAfterFocus)
    }
  }, [open, screen, viewport?.height, viewport?.offsetTop])
  useEffect(() => { if (open && account.error) errorSummary.current?.focus() }, [open, account.error])
  useEffect(() => {
    if (open && screen === 'account' && callback.present && !callback.failed && !callback.recovery && onOpenAccount) {
      setOpen(false); setConfirmationNotice(false); onOpenAccount()
    }
  }, [open, screen, callback.present, callback.failed, callback.recovery, onOpenAccount])

  const clearPassword = () => { setPassword(''); setConfirmation(''); setShowPassword(false) }
  const close = () => { setOpen(false); clearPassword(); setConfirmationNotice(false); onDismiss?.(session.getSnapshot().status) }
  const closeAfterSignIn = useEffectEvent(close)
  // Another tab may finish signup/confirmation. Return to this tab's pending
  // action without saving the mix or automatically starting paid/export work.
  useEffect(() => {
    if (open && signedIn && openRequest?.intent && !account.passwordRecovery) closeAfterSignIn()
  }, [open, signedIn, openRequest?.intent, account.passwordRecovery])
  const changeMode = next => { setEmail(address); session.clearFeedback(); clearPassword(); setMode(next) }
  const changeTab = event => {
    const next = { ArrowLeft: 'sign-in', ArrowRight: 'sign-up', Home: 'sign-in', End: 'sign-up' }[event.key]
    if (!next) return
    event.preventDefault()
    if (next === screen) return
    focusModeTab.current = true
    changeMode(next)
  }
  const keepFocusInDialog = event => {
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus()
    }
  }
  const submit = async event => {
    event.preventDefault()
    if (waiting || signupIncomplete) return
    const success = await (screen === 'new-password' ? session.updatePassword(password)
      : screen === 'forgot' ? session.requestPasswordReset(email)
        : screen === 'verify' ? session.resend(email)
          : screen === 'sign-up' ? session.signUp(email, password) : session.signIn(email, password))
    if (!success) return
    clearPassword()
    if (screen === 'new-password') setMode('password-updated')
    else if (session.getSnapshot().status === 'signed-in') close()
  }
  const signOut = async () => {
    if (waiting || signOutGuard.current) return
    signOutGuard.current = true; setLeaving(true)
    try {
      if (onBeforeSignOut && !await onBeforeSignOut()) return
      if (await session.signOut()) { setEmail(''); setMode('sign-in'); onAfterSignOut?.(); close() }
    } finally { signOutGuard.current = false; setLeaving(false) }
  }
  const editEmail = event => { setEmail(event.target.value); if (account.error) session.clearFeedback() }
  const editPassword = event => { setPassword(event.target.value); if (account.error) session.clearFeedback() }
  const resend = () => screen === 'reset-sent' ? session.requestPasswordReset(address) : session.resend(address)
  const primaryLabel = screen === 'sign-up' ? 'Create account' : screen === 'forgot' ? 'Send reset link' : screen === 'verify' ? 'Send confirmation link' : screen === 'new-password' ? 'Update password' : 'Sign in'
  const pendingLabel = account.pending === 'sign-up' ? 'Creating account…' : account.pending === 'sign-in' ? 'Signing in…' : account.pending === 'update-password' ? 'Updating password…' : 'Sending link…'
  const description = screen === 'verify' ? 'Enter the email you used to create your account.' : ''

  return <>
    <button id="workspace-tab-account" ref={opener} className="account-access" type="button" hidden={hidden} disabled={disabled} title={disabled ? 'Finish or cancel processing before opening your account.' : undefined} aria-haspopup={signedIn && onOpenAccount ? undefined : 'dialog'} aria-controls={signedIn && onOpenAccount ? 'room-workspace' : undefined} onClick={event => { if (signedIn && onOpenAccount) { onOpenAccount(); return }; returnFocus.current = event.currentTarget; if (mode === 'password-updated') setMode('sign-in'); setOpen(true) }}>
      <AccountIcon />{signedIn ? 'Account' : account.status === 'checking' ? 'Checking account…' : 'Sign in'}
    </button>
    <span className="account-announcement" role="status">{!open && !accountPageOpen && account.message}</span>
    <dialog ref={dialog} className="account-dialog account-dialog--access" aria-labelledby="account-title" onKeyDown={keepFocusInDialog} onCancel={event => { event.preventDefault(); close() }} onClose={() => { if (opened.current && !dialog.current.open) close() }}>
      <header className="account-dialog__brand-row"><span className="account-dialog__brand"><span aria-hidden="true"><img src="/branding/mix-room-mark.png" alt="" width="256" height="256" /></span> MIX ROOM</span>
        {open && ['sign-in', 'sign-up'].includes(screen) && <div className="account-dialog__tabs" role="tablist" aria-label="Account access">
          {['sign-in', 'sign-up'].map(tab => <button key={tab} id={`account-mode-${tab}`} type="button" role="tab" aria-selected={screen === tab} aria-controls="account-dialog-body" tabIndex={screen === tab ? 0 : -1} disabled={waiting} onClick={() => changeMode(tab)} onKeyDown={changeTab}>{titles[tab]}</button>)}
        </div>}
        <button className="account-dialog__close" type="button" onClick={close} aria-label="Close account panel">×</button></header>
      {open && <><div id="account-dialog-body" className="account-dialog__content" data-screen={screen} role={['sign-in', 'sign-up'].includes(screen) ? 'tabpanel' : undefined} aria-labelledby={['sign-in', 'sign-up'].includes(screen) ? `account-mode-${screen}` : undefined}>
        {(emailScreen || screen === 'password-updated') && <div className="account-dialog__symbol"><AccountIcon kind={emailScreen ? 'mail' : 'check'} /></div>}
        <div className="account-dialog__intro"><h2 ref={heading} tabIndex={-1} id="account-title">{titles[screen]}</h2>{description && <p>{description}</p>}{openRequest?.intent && <p>Your mix and selected file stay in this tab while you sign in. Keep this tab open; an unsaved mix is lost if you reload or close it. Saving to your account is optional.</p>}</div>
        {account.error && <div ref={errorSummary} tabIndex={-1} className="account-dialog__error" role="alert" id="account-error"><p>{account.error}</p>
          {screen === 'sign-in' && account.errorCode === 'email_not_confirmed' && <button className="account-dialog__link" type="button" onClick={() => changeMode('verify')}>Verify email</button>}
        </div>}

        {screen === 'checking' && <p className="account-dialog__muted" role="status">{callback.present ? 'Finishing your account check…' : 'Checking your account…'}</p>}
        {screen === 'unavailable' && <><p className="account-dialog__muted">Please try again later. You can keep exploring the room.</p><button className="account-dialog__primary" type="button" onClick={close}>Back to the room</button></>}
        {screen === 'error' && <button className="account-dialog__primary" type="button" onClick={() => session.start()}>Try again</button>}
        {screen === 'link-invalid' && <div className="account-dialog__actions"><button className="account-dialog__primary" type="button" onClick={() => changeMode('sign-in')}>Back to sign in</button><button className="account-dialog__link" type="button" onClick={() => changeMode('verify')}>Request a new confirmation link</button></div>}

        {isForm && <form id="account-access-form" onSubmit={submit} aria-busy={waiting}>
          {screen !== 'new-password' && <div className="account-dialog__field"><label htmlFor="account-email">Email</label><input id="account-email" name="email" type="email" required autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" value={email} disabled={waiting} aria-describedby={account.error ? 'account-error' : undefined} onChange={editEmail} /></div>}
          {!emailOnly && <div className="account-dialog__field">
            <div className="account-dialog__label-row"><label htmlFor={screen === 'new-password' ? 'account-new-password' : 'account-password'}>{screen === 'new-password' ? 'New password' : 'Password'}</label>{screen === 'sign-in' && <button className="account-dialog__link" type="button" disabled={waiting} onClick={() => changeMode('forgot')}>Forgot password?</button>}</div>
            <div className="account-dialog__password-field"><input id={screen === 'new-password' ? 'account-new-password' : 'account-password'} name="password" type={showPassword ? 'text' : 'password'} required minLength={screen === 'sign-in' ? undefined : 12} aria-describedby={screen === 'sign-in' ? account.error ? 'account-error' : undefined : 'account-password-help'} autoComplete={screen === 'sign-in' ? 'current-password' : 'new-password'} value={password} disabled={waiting} onChange={editPassword} />
              <button type="button" className="account-dialog__reveal" disabled={waiting} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-controls={screen === 'sign-up' ? 'account-password account-confirm-password' : screen === 'new-password' ? 'account-new-password' : 'account-password'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>{screen !== 'sign-in' && <small id="account-password-help">At least 12 characters.</small>}
          </div>}
          {screen === 'sign-up' && <div className="account-dialog__field">
            <label htmlFor="account-confirm-password">Confirm password</label>
            <input id="account-confirm-password" name="confirm-password" type={showPassword ? 'text' : 'password'} required minLength={12} autoComplete="new-password" value={confirmation} disabled={waiting} aria-invalid={passwordMismatch || undefined} aria-describedby={passwordMismatch ? 'account-confirm-password-help' : undefined} onChange={event => { setConfirmation(event.target.value); if (account.error) session.clearFeedback() }} />
            {passwordMismatch && <small id="account-confirm-password-help" className="account-dialog__password-mismatch" role="status">Passwords do not match.</small>}
          </div>}
          {emailOnly && cooldown > 0 && <small role="status">You can request another link in {cooldown}s.</small>}
        </form>}

        {emailScreen && <><p className="account-dialog__muted" role="status">{account.message}</p><div className="account-dialog__address"><span>Email address</span><strong>{address}</strong></div>
          <button className="account-dialog__primary" type="button" disabled={waiting} onClick={() => changeMode('sign-in')}>Back to sign in</button>
          <div className="account-dialog__email-actions"><button className="account-dialog__link" type="button" disabled={waiting || cooldown > 0} onClick={resend}>{account.pending === 'resend' || account.pending === 'reset-email' ? 'Sending…' : cooldown > 0 ? `Resend email in ${cooldown}s` : 'Resend email'}</button><button className="account-dialog__link" type="button" disabled={waiting} onClick={() => changeMode(screen === 'reset-sent' ? 'forgot' : 'sign-up')}>Change email</button></div>
          <details className="account-dialog__help"><summary>Can’t find the email?</summary><p>Check spam or promotions, and allow a minute for delivery. {screen === 'verify-sent' ? 'Already verified? Sign in with your email and password.' : 'Use the most recent reset link to choose a new password.'}</p>{localConfirmation && <p>For this local preview, open the link on this computer. Keep the tab with your unsaved mix open.</p>}</details>
        </>}
        {screen === 'password-updated' && <><p className="account-dialog__muted" role="status">Password updated. You’re signed in.</p><button className="account-dialog__primary" type="button" onClick={() => { setMode('sign-in'); close() }}>Back to the room</button></>}
        {screen === 'account' && <>
          {confirmationNotice && <p className="account-dialog__success" role="status">Your email is confirmed. You’re signed in.</p>}
          <div className="account-dialog__identity"><span className="account-dialog__avatar"><AccountIcon /></span><div><small>Signed in as</small><strong>{account.user.email}</strong></div></div>
          {credits?.scope === 'account' && <div className="account-dialog__allowance"><strong>{credits.remaining}<span> / 3</span></strong><div><span>Audio file analyses remaining</span><small>Unlimited stem analysis</small></div></div>}
          <div className="account-dialog__sign-out"><button className="account-dialog__secondary" type="button" disabled={waiting} onClick={signOut}>{account.pending === 'sign-out' ? 'Signing out…' : leaving ? 'Waiting for your changes…' : 'Sign out'}</button></div>
        </>}
      </div>
        {isForm && <div className="account-dialog__form-actions"><button form="account-access-form" className="account-dialog__primary" type="submit" disabled={waiting || signupIncomplete || (emailOnly && cooldown > 0)}>{waiting ? pendingLabel : primaryLabel}</button></div>}
        {['sign-in', 'sign-up', 'forgot', 'verify'].includes(screen) && <footer className="account-dialog__footer" data-screen={screen}>
          {screen === 'sign-in' ? <button className="account-dialog__link" type="button" disabled={waiting} onClick={() => changeMode('sign-up')}>Create account</button> : <button className="account-dialog__link" type="button" disabled={waiting} onClick={() => changeMode('sign-in')}>{screen === 'sign-up' ? 'Sign in' : 'Back to sign in'}</button>}
        </footer>}
      </>}
    </dialog>
  </>
}
