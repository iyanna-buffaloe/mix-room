import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export default function EmailLanding({ session }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [show, setShow] = useState(false)
  const [validation, setValidation] = useState('')
  const heading = useRef(null), error = useRef(null)
  const recovery = state.kind === 'recovery'
  const busy = ['verifying','saving'].includes(state.phase)
  const reset = recovery && ['ready','verifying','reset','saving'].includes(state.phase)
  const done = ['confirmed','updated'].includes(state.phase)
  const invalid = ['invalid','unavailable'].includes(state.phase)
  const title = state.phase === 'confirmed' ? 'Email confirmed' : state.phase === 'updated' ? 'Password updated'
    : state.phase === 'unavailable' ? 'Please try again later' : state.phase === 'invalid' ? 'Let’s get you back in'
      : reset ? 'Choose a new password' : recovery ? 'Reset your password' : 'Confirm your email'
  const retryURL = recovery ? '/#error=access_denied&error_code=otp_expired&type=recovery' : '/#error=access_denied&error_code=otp_expired'
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [state.phase])
  const feedback = validation || state.error
  useEffect(() => { if (feedback) error.current?.focus() }, [feedback])
  const submit = async event => {
    event.preventDefault()
    if (busy) return
    if (password !== confirmation) { setValidation('The passwords do not match.'); return }
    setValidation('')
    if (state.phase === 'ready' && !await session.verify()) return
    if (await session.updatePassword(password, confirmation)) { setPassword(''); setConfirmation(''); setShow(false) }
  }
  return <main className="email-access">
    <a className="email-access__brand" href="/" aria-label="Mix Room home"><img src="/branding/mix-room-mark.png" alt="" width="48" height="48" /><span>MIX ROOM<small>A NEW PERSPECTIVE ON YOUR SOUND</small></span></a>
    <section className="email-access__card" aria-labelledby="email-title" aria-busy={busy}>
      <div className="email-access__stripe" aria-hidden="true" />
      <div className="email-access__content">
        <p className="email-access__eyebrow">ACCOUNT ACCESS</p>
        <h1 id="email-title" ref={heading} tabIndex={-1}>{title}</h1>
        {feedback && <p ref={error} tabIndex={-1} role="alert" className="email-access__error">{feedback}</p>}
        {done ? <><p role="status">{state.phase === 'updated' ? 'Your new password is ready. Sign in to continue.' : 'Your email is verified. You can now sign in to Mix Room.'}</p><a className="email-access__primary" href="/">Open Mix Room <span aria-hidden="true">→</span></a></>
          : invalid ? <><p>{state.phase === 'unavailable' ? 'Account access is unavailable right now. Please return to Mix Room and try again later.' : 'This link is incomplete, has expired or has already been used. You can sign in or request a new email.'}</p><a className="email-access__primary" href={state.phase === 'unavailable' ? '/' : retryURL}>{recovery && state.phase !== 'unavailable' ? 'Request another reset' : 'Open Mix Room'}</a></>
            : reset ? <><p>Use at least 12 characters.</p><form onSubmit={submit} aria-label="Reset password">
              <label htmlFor="email-new-password">New password</label><input id="email-new-password" type={show ? 'text' : 'password'} required minLength={12} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
              <label htmlFor="email-confirm-password">Confirm new password</label><input id="email-confirm-password" type={show ? 'text' : 'password'} required minLength={12} autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} />
              <button className="email-access__show" type="button" aria-pressed={show} onClick={() => setShow(!show)} disabled={busy}>{show ? 'Hide passwords' : 'Show passwords'}</button>
              <button className="email-access__primary" disabled={busy}>{busy ? 'Updating password…' : 'Update password'}</button>
            </form></>
              : <><p>{recovery ? 'Continue to choose a new password for your Mix Room account.' : 'Finish setting up your Mix Room account by confirming your email address.'}</p><button className="email-access__primary" onClick={() => session.verify()} disabled={busy}>{busy ? 'Checking your link…' : recovery ? 'Continue to reset password' : 'Confirm email'}</button><p className="email-access__hint">{recovery ? 'Keep this page open until you finish.' : 'Only continue if you requested this account.'}</p></>}
      </div>
    </section>
    <footer>Visualize your mix. Find your perspective.</footer>
  </main>
}
