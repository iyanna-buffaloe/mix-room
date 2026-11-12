import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { getAccountConnection } from '../auth/supabase.js'
import { createMixClient } from '../library/mixClient.js'
import { createMixArchive, readMixArchive, downloadMixBackup } from '../audio/mixArchive.js'
import './MixWorkspace.css'

export default function MixLibrary({ mode, account, draft, view, requestLeave, onOpened, onSaved, onClose, onShow, onSignIn, onUpload, onBusy }) {
  const owner = account.status === 'signed-in' ? account.user.id : null
  const client = useMemo(() => createMixClient({ getAccessToken: () => getAccountConnection().session.getAccessToken(owner) }), [owner])
  const [library, setLibrary] = useState({ owner: null, rows: [] })
  const [available, setAvailable] = useState(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('new')
  const [conflictedMix, setConflictedMix] = useState(null)
  const [rename, setRename] = useState(null)
  const dialog = useRef(null), active = useRef(null), attempt = useRef(null), errorBox = useRef(null)
  const rows = library.owner === owner ? library.rows : []
  const busy = Boolean(working)
  const embedded = mode === 'list'
  useEffect(() => {
    const stop = () => active.current?.abort()
    const resume = event => { if (event.persisted) stop() }
    window.addEventListener('pagehide', stop)
    window.addEventListener('pageshow', resume)
    return () => { window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', resume); stop() }
  }, [])
  const refresh = useCallback(async signal => {
    const result = await client.list(signal)
    if (!signal?.aborted) setLibrary({ owner, rows: result.mixes })
  }, [client, owner])
  const initializeForm = useEffectEvent(() => { setError(''); setRename(null); setConflictedMix(null); setLoading(Boolean(owner)); setAvailable(null); setName(draft.record?.metadata.title || 'My mix'); setTarget(draft.saved ? 'update' : 'new') })
  useEffect(() => {
    if (!mode) { dialog.current?.close?.(); return }
    const returnFocus = document.activeElement
    if (!embedded && !dialog.current.open) dialog.current.showModal()
    if (embedded) dialog.current.querySelector('#mix-library-title')?.focus({ preventScroll: true })
    initializeForm()
    if (!owner) return
    const controller = new AbortController()
    client.config(controller.signal).then(async config => {
      if (controller.signal.aborted) return
      setAvailable(config.available)
      if (config.available) await refresh(controller.signal)
    }).catch(() => { if (!controller.signal.aborted) setError('Your library could not be reached. Keep this tab open and try again.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); if (!embedded) returnFocus?.focus?.({ preventScroll: true }) }
  }, [mode, owner, client, refresh, embedded])
  useEffect(() => { if (error) errorBox.current?.focus() }, [error])
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false) }, [busy, onBusy])

  const perform = async (message, action) => {
    if (active.current) return
    const controller = new AbortController(); active.current = controller; setWorking(message); setError('')
    try { await action(controller.signal) }
    catch (failure) { if (!controller.signal.aborted) setError(failure.message || 'The library request failed. Please try again.') }
    finally { if (active.current === controller) { active.current = null; setWorking('') } }
  }
  const close = () => { active.current?.abort(); onClose() }
  const save = event => {
    event.preventDefault()
    if (!draft.record || !owner || available !== true || loading) return
    let row = target === 'update' ? draft.saved : target.startsWith('replace:') ? rows.find(value => value.id === target.slice(8)) : null
    if (target.startsWith('replace:') && (!row || !window.confirm(`Replace “${row.name}” with this mix? The previous saved version will be removed after this save succeeds.`))) return
    if (target === 'new' && rows.length >= 3) { setError('Choose a named mix to replace, or cancel. Your draft stays open.'); return }
    perform('Preparing save…', async signal => {
      const snapshot = draft.snapshot()
      const key = JSON.stringify([owner, snapshot.revision, target, name.trim(), row?.revision])
      if (attempt.current?.key !== key) attempt.current = { key, uploadId: crypto.randomUUID(), mixId: row?.id ?? crypto.randomUUID(), expectedRevision: row?.revision, name: name.trim(), revision: snapshot.revision,
        archive: createMixArchive({ ...snapshot.record, metadata: { ...snapshot.record.metadata, title: name.trim() } }, view) }
      const current = attempt.current
      let result
      try { result = await client.save(current.archive, current, { signal, onStage: setWorking }) }
      catch (failure) {
        if (failure.code === 'MIX_CHANGED') {
          attempt.current = null
          setConflictedMix(row?.id)
          setTarget('new')
          await refresh(signal).catch(() => {})
          signal.throwIfAborted()
          throw new Error('This mix changed in another tab or device. Your draft is safe. Save it as a new mix, or choose a mix to replace.')
        }
        throw failure
      }
      signal.throwIfAborted()
      draft.markSaved(result, owner, current.revision)
      attempt.current = null
      active.current = null; setWorking('')
      onSaved(result)
    })
  }
  const open = async row => {
    if (!await requestLeave()) return
    onShow()
    return perform('Opening mix…', async signal => {
    signal.throwIfAborted()
    const downloaded = await client.open(row.id, signal)
    const decoded = await readMixArchive(downloaded.archive)
    signal.throwIfAborted()
    decoded.record.metadata.title = downloaded.mix.name
    onOpened(decoded, downloaded.mix, owner)
    })
  }
  const Panel = embedded ? 'section' : 'dialog'
  return <Panel ref={dialog} className={embedded ? `mix-room__toolbar mix-room__content-overlay mix-library-panel${!owner ? ' mix-library-panel--guest' : ''}${owner && available && !loading && rows.length === 0 ? ' mix-library-panel--empty' : ''}` : 'account-dialog mix-library'} aria-labelledby="mix-library-title" onCancel={event => { event.preventDefault(); close() }}>
    <header className={embedded ? 'mix-room__overlay-header' : 'account-dialog__header'}><h2 id="mix-library-title" tabIndex={-1}>{mode === 'save' ? 'Save mix' : 'My mixes'}</h2><button type="button" className={embedded ? 'mix-room__overlay-close' : undefined} onClick={close} aria-label="Close mix library">×</button></header>
    {mode && <div className={embedded ? 'mix-room__overlay-body mix-library__body' : 'account-dialog__body'}>
      {error && <p ref={errorBox} tabIndex={-1} role="alert" className="account-dialog__error">{error}</p>}
      {account.status === 'checking' ? <p role="status">Checking your account…</p> : !owner ? <div className="mix-library__empty"><button type="button" onClick={onSignIn}>{mode === 'save' ? 'Sign in to save' : 'Sign in to view mixes'}</button></div>
        : loading ? <p role="status">Loading your library…</p>
        : available === false ? <p role="status">Mix saving is unavailable right now. Keep this tab open, or download a backup. Your draft has not been saved to your account.</p>
        : available && <>
          <p>{rows.length} of 3 saved{mode === 'save' ? ' · Up to 160 MiB per mix' : ''}</p>
          {mode === 'save' && draft.record ? <form onSubmit={save}>
            <label htmlFor="saved-mix-name">Mix name</label><input id="saved-mix-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} disabled={busy} />
            <label htmlFor="save-mix-target">Save to</label><select id="save-mix-target" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
              <option value="new" disabled={rows.length >= 3}>Save as a new mix{rows.length >= 3 ? ' — library full' : ''}</option>
              {draft.saved && conflictedMix !== draft.saved.id && rows.some(row => row.id === draft.saved.id) && <option value="update">Update “{draft.saved.name}”</option>}
              {rows.map(row => <option key={row.id} value={`replace:${row.id}`}>Replace “{row.name}”</option>)}
            </select>
            <button type="submit" disabled={busy || !name.trim()}>{busy ? working : target.startsWith('replace:') ? 'Replace selected mix…' : 'Save mix'}</button>
          </form> : <>
            {rows.length === 0 && <div className="mix-library__empty"><h3>No saved mixes</h3>{onUpload && <button type="button" onClick={onUpload}>Upload track</button>}</div>}
            <div className="mix-library__cards">{rows.map(row => <article className="mix-library__card" key={row.id}>
              <h3>{row.name}</h3><small>Saved {new Date(row.updatedAt).toLocaleDateString()} · {(row.bytes / 1048576).toFixed(1)} MiB</small>
              <button type="button" className="mix-library__open" aria-label={`Open ${row.name}`} disabled={busy} onClick={() => open(row)}>Open mix</button>
              <div className="mix-library__card-actions">
              {rename?.id === row.id ? <form onSubmit={event => { event.preventDefault(); perform('Renaming mix…', async signal => { const updated = await client.rename(row, rename.name.trim(), signal); signal.throwIfAborted(); draft.renamedSaved(updated.mix); await refresh(signal); setRename(null) }) }}>
                <label htmlFor="rename-saved-mix">New name</label><input id="rename-saved-mix" required maxLength={120} value={rename.name} onChange={event => setRename({ ...rename, name: event.target.value })} disabled={busy} />
                <button type="submit" disabled={busy}>Rename mix</button><button type="button" disabled={busy} onClick={() => setRename(null)}>Cancel rename</button>
              </form> : <button type="button" aria-label={`Rename ${row.name}`} disabled={busy} onClick={() => setRename({ id: row.id, name: row.name })}>Rename</button>}
              <button type="button" aria-label={`Delete ${row.name}`} disabled={busy} onClick={() => { if (window.confirm(`Delete “${row.name}” from your account?`)) perform('Deleting mix…', async signal => { await client.delete(row, signal); signal.throwIfAborted(); draft.deletedSaved(row.id); await refresh(signal) }) }}>Delete</button>
              </div>
            </article>)}</div>
          </>}
        </>}
      {draft.record && <button type="button" disabled={busy} onClick={() => { try { downloadMixBackup(draft.record, view) } catch (failure) { setError(failure.message) } }}>Download mix backup</button>}
      {error && owner && <button type="button" disabled={busy} onClick={() => perform('Refreshing library…', refresh)}>Refresh library</button>}
      {busy && <p role="status">{working}</p>}
    </div>}
  </Panel>
}
