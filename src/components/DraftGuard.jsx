import { useEffect, useRef } from 'react'
export default function DraftGuard({ open, signedIn, onChoose }) {
  const dialog = useRef(null)
  useEffect(() => {
    if (open && !dialog.current.open) dialog.current.showModal()
    if (!open) dialog.current.close()
  }, [open])
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="unsaved-mix-title" onCancel={event => { event.preventDefault(); onChoose('cancel') }}>
    <header className="account-dialog__header"><h2 id="unsaved-mix-title">Keep your changes?</h2><button type="button" aria-label="Cancel leaving this mix" onClick={() => onChoose('cancel')}>×</button></header>
    <div className="account-dialog__body"><p>This mix has unsaved changes. Leaving it will discard those changes.</p>
      <button type="button" onClick={() => onChoose(signedIn ? 'save' : 'account')}>{signedIn ? 'Save and continue' : 'Sign in to save'}</button>
      <button type="button" onClick={() => onChoose('discard')}>Discard changes and continue</button>
      <button type="button" onClick={() => onChoose('cancel')}>Cancel</button>
    </div>
  </dialog>
}
