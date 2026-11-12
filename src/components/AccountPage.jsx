import { useEffect, useRef, useState } from 'react'
import { getAccountConnection } from '../auth/supabase.js'
import './AccountPage.css'

function PasswordInput({ id, description, visible, onToggle, ...inputProps }) {
  const action = `${visible ? 'Hide' : 'Show'} ${description}`
  return <div className="account-page__password-input">
    <input {...inputProps} id={id} type={visible ? 'text' : 'password'} />
    <button type="button" className="account-page__reveal" disabled={inputProps.disabled} aria-label={action} title={action} aria-controls={id} aria-pressed={visible} onClick={onToggle}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
        {!visible && <path d="m3 3 18 18" />}
      </svg>
    </button>
  </div>
}

export default function AccountPage({ account, credits, disabled, onClose, onMixes, onBeforeSignOut, onAfterSignOut }) {
  const [{ session }] = useState(getAccountConnection)
  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [nonce, setNonce] = useState('')
  const [visiblePasswords, setVisiblePasswords] = useState({})
  const [localError, setLocalError] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [tick, setTick] = useState(Date.now)
  const heading = useRef(null), errorSummary = useRef(null), signingOut = useRef(false), emailCodeInput = useRef(null), newEmailInput = useRef(null)
  const waiting = Boolean(disabled || account.pending || leaving)
  const error = localError || account.error
  const notice = account.message === 'You’re signed in.' ? '' : account.message
  const needsCode = account.reauthenticationSent || ['reauthentication_needed', 'reauthentication_not_valid'].includes(account.errorCode)
  const cooldown = Math.max(0, Math.ceil((account.reauthenticateAt - tick) / 1000))
  const emailCooldown = Math.max(0, Math.ceil((account.resendAt - tick) / 1000))
  const emailVerified = account.emailVerifiedUntil > tick
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { if (error) errorSummary.current?.focus({ preventScroll: true }) }, [error])
  useEffect(() => {
    if (!account.reauthenticateAt && !account.resendAt && !account.emailVerifiedUntil) return
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [account.reauthenticateAt, account.resendAt, account.emailVerifiedUntil])
  useEffect(() => () => session.clearEmailVerification(), [session])
  useEffect(() => { if (emailVerified) newEmailInput.current?.focus(); else if (account.emailVerificationSent) emailCodeInput.current?.focus() }, [emailVerified, account.emailVerificationSent])
  const edit = setter => event => { setter(event.target.value); setLocalError(''); if (account.error || account.message) session.clearFeedback() }
  const clearPasswords = () => { setCurrentPassword(''); setPassword(''); setConfirmation(''); setNonce(''); setVisiblePasswords({}) }
  const togglePassword = key => setVisiblePasswords(previous => ({ ...previous, [key]: !previous[key] }))
  const changeEmail = async event => {
    event.preventDefault()
    if (waiting) return
    setLocalError('')
    if (await session.changeEmail(email)) setEmail('')
  }
  const verifyEmail = async event => {
    event.preventDefault()
    if (waiting) return
    setLocalError('')
    if (await session.verifyCurrentEmail(emailCode)) { setEmailCode(''); setEmail(''); setTick(Date.now()) }
  }
  const changePassword = async event => {
    event.preventDefault()
    if (waiting) return
    if (password !== confirmation) { setLocalError('The new passwords do not match.'); return }
    setLocalError('')
    if (await session.changePassword(password, { currentPassword, nonce })) clearPasswords()
  }
  const signOut = async () => {
    if (waiting || signingOut.current) return
    signingOut.current = true; setLeaving(true)
    try {
      if (onBeforeSignOut && !await onBeforeSignOut()) return
      if (await session.signOut()) { clearPasswords(); onAfterSignOut?.() }
    } finally { signingOut.current = false; setLeaving(false) }
  }
  return <section className="account-page" aria-labelledby="account-page-title">
    <header className="account-page__header"><div><p className="account-page__eyebrow">YOUR WORKSPACE</p><h2 id="account-page-title" ref={heading} tabIndex={-1}>Account</h2></div>
      <div className="account-page__feedback" aria-live="polite">
        {notice && !account.pendingEmail && <p className="account-page__success" role="status">{notice}</p>}
        {error && <div className="account-page__error" ref={errorSummary} tabIndex={-1} role="alert"><p>{error}</p></div>}
        {!error && account.pendingEmail && <p className="account-page__pending" role="status"><strong>Awaiting confirmation</strong>{' · '}<span>{account.pendingEmail}</span>{'. '}{notice || 'Keep using your current address until you confirm the new address.'}</p>}
      </div>
      <button className="account-page__close" type="button" onClick={onClose} aria-label="Close account page"><span>Close account</span><span aria-hidden="true">×</span></button></header>
    <div className="account-page__body">
      <div className="account-page__identity"><div><span>Signed in as</span><strong>{account.user.email}</strong></div></div>
      <section className="account-page__section" aria-labelledby="account-usage-title"><div className="account-page__section-heading"><h3 id="account-usage-title">Your Mix Room</h3><button type="button" className="account-page__text-button" onClick={onMixes}>My mixes →</button></div>
        <div className="account-page__metrics"><div><strong>{credits?.scope === 'account' ? credits.remaining : '—'}</strong><span>Audio analyses remaining</span><small>One-time account credits</small></div><div><strong>Unlimited</strong><span>Stem analyses</span><small>Account allowance</small></div></div>
      </section>
      <section className="account-page__section" aria-labelledby="account-email-title"><h3 id="account-email-title">Email address</h3>
        {!emailVerified && <>
          <p className="account-page__description">Verify your current email before changing your address.</p>
          {!account.emailVerificationSent ? <button className="account-page__primary" type="button" disabled={waiting || emailCooldown > 0} onClick={() => { setEmailCode(''); setLocalError(''); session.requestEmailVerification() }}>{account.pending === 'email-verify-send' ? 'Sending code…' : 'Verify email'}</button>
            : <form onSubmit={verifyEmail} aria-label="Verify current email">
              <p className="account-page__help">Enter the code sent to {account.user.email}.</p>
              <label htmlFor="settings-email-code">Email verification code</label><input ref={emailCodeInput} id="settings-email-code" name="email-verification-code" type="text" inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={10} value={emailCode} onChange={edit(setEmailCode)} disabled={waiting} />
              <button className="account-page__primary" type="submit" disabled={waiting}>{account.pending === 'email-verify-code' ? 'Verifying…' : 'Confirm code'}</button>
              <button className="account-page__text-button" type="button" disabled={waiting || emailCooldown > 0} onClick={() => { setEmailCode(''); session.requestEmailVerification() }}>{emailCooldown > 0 ? `Resend code in ${emailCooldown}s` : 'Resend code'}</button>
            </form>}
          {!account.emailVerificationSent && emailCooldown > 0 && <p className="account-page__help" role="status">You can request another code in {emailCooldown}s.</p>}
          {account.pending === 'change-email' && <p className="account-page__help" role="status">Requesting change…</p>}
        </>}
        {emailVerified && <form onSubmit={changeEmail} aria-label="Change email address"><label htmlFor="settings-email">New email address</label><input ref={newEmailInput} id="settings-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} placeholder="you@example.com" value={email} onChange={edit(setEmail)} disabled={waiting} />
          <p className="account-page__help">Current email verified. This form locks again after five minutes or when you close Account.</p>
          <button className="account-page__primary" type="submit" disabled={waiting}>{account.pending === 'change-email' ? 'Requesting change…' : 'Change email address'}</button>
        </form>}
      </section>
      <section className="account-page__section" aria-labelledby="account-password-title"><h3 id="account-password-title">Password</h3><p className="account-page__description">Choose a unique password with at least 12 characters.</p>
        <form onSubmit={changePassword} aria-label="Change password">
          <label htmlFor="settings-current-password">Current password</label><PasswordInput id="settings-current-password" description="current password" visible={Boolean(visiblePasswords.current)} onToggle={() => togglePassword('current')} name="current-password" autoComplete="current-password" required value={currentPassword} onChange={edit(setCurrentPassword)} disabled={waiting} />
          <div className="account-page__password-grid"><div><label htmlFor="settings-password">New password</label><PasswordInput id="settings-password" description="new password" visible={Boolean(visiblePasswords.new)} onToggle={() => togglePassword('new')} name="new-password" autoComplete="new-password" required minLength={12} value={password} onChange={edit(setPassword)} disabled={waiting} /></div><div><label htmlFor="settings-confirm-password">Confirm new password</label><PasswordInput id="settings-confirm-password" description="password confirmation" visible={Boolean(visiblePasswords.confirmation)} onToggle={() => togglePassword('confirmation')} name="confirm-password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={edit(setConfirmation)} disabled={waiting} /></div></div>
          {needsCode && <div className="account-page__verification"><p>Confirm it’s you with a code sent to your account email.</p><button className="account-page__secondary" type="button" disabled={waiting || cooldown > 0} onClick={() => session.requestReauthentication()}>{account.pending === 'reauthenticate' ? 'Requesting code…' : cooldown > 0 ? `Request another code in ${cooldown}s` : account.reauthenticationSent ? 'Request another code' : 'Send verification code'}</button><label htmlFor="settings-code">Verification code</label><input id="settings-code" name="verification-code" type="text" inputMode="numeric" autoComplete="one-time-code" required value={nonce} onChange={edit(setNonce)} disabled={waiting} /></div>}
          <button className="account-page__primary" type="submit" disabled={waiting}>{account.pending === 'change-password' ? 'Changing password…' : 'Change password'}</button>
        </form>
      </section>
      <footer className="account-page__sign-out"><button className="account-page__secondary" type="button" disabled={waiting} onClick={signOut}>{account.pending === 'sign-out' ? 'Signing out…' : leaving ? 'Waiting for your changes…' : 'Sign out'}</button></footer>
    </div>
  </section>
}
