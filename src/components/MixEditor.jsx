import { useEffect, useRef, useState } from 'react'
import { COPY } from '../config/siteCopy.js'
import { suggestStemMix } from '../audio/suggestStemName.js'

export default function MixEditor({ hidden, guided = false, currentMix, hasContent, disabled, savingNames, onSaveNames, onClose, onEditStateChange, registerNameCommit }) {
  const [editedTitle, setEditedTitle] = useState(null)
  const [editedNames, setEditedNames] = useState({})
  const currentTitle = editedTitle ?? currentMix.title ?? ''
  const currentNames = currentMix.instruments.map(instrument => ({
    ...instrument, label: editedNames[instrument.key] ?? instrument.label ?? instrument.key.replaceAll('_', ' '),
  }))
  const namesChanged = hasContent && (currentTitle.trim() !== currentMix.title || currentNames.some((instrument, index) => instrument.label.trim() !== (currentMix.instruments[index].label ?? instrument.key.replaceAll('_', ' '))))
  const valid = currentTitle.trim() && currentNames.every(instrument => instrument.label.trim())
  const namedFiles = currentMix.instruments.filter(instrument => typeof instrument.fileName === 'string' && instrument.fileName.trim())
  const smartRename = () => {
    const suggestions = suggestStemMix(namedFiles.map(instrument => instrument.fileName))
    if (suggestions.title) setEditedTitle(suggestions.title)
    setEditedNames(previous => {
      const next = { ...previous }
      namedFiles.forEach((instrument, index) => {
        if (suggestions.labels[index]) next[instrument.key] = suggestions.labels[index]
      })
      return next
    })
  }
  const commit = useRef(null)
  useEffect(() => {
    commit.current = async () => {
      if (!namesChanged) return true
      if (!valid) { alert('Enter a song title and a name for each instrument before saving.'); return false }
      if (await onSaveNames(currentTitle, currentNames.map(({ key, label }) => ({ key, label }))) === false) return false
      setEditedTitle(null)
      setEditedNames({})
      return true
    }
  })
  // Stay mounted between tabs so staged names also participate in Save mix and
  // the navigation guard; the mix identity resets them when another mix opens.
  useEffect(() => {
    registerNameCommit?.(() => commit.current?.())
    return () => { registerNameCommit?.(null); onEditStateChange?.(false) }
  }, [registerNameCommit, onEditStateChange])
  useEffect(() => { onEditStateChange?.(Boolean(namesChanged)) }, [namesChanged, onEditStateChange])

  const renderName = instrument => (<div key={instrument.key} className="mix-room__stem-field">
              <label htmlFor={`editor-instrument-${instrument.key}`}>{COPY.instrument_name}</label>
              <input id={`editor-instrument-${instrument.key}`} type="text" value={instrument.label} maxLength={60} required aria-describedby={instrument.fileName ? `editor-filename-${instrument.key}` : undefined} onChange={event => setEditedNames(previous => ({ ...previous, [instrument.key]: event.target.value }))} />
              {instrument.fileName && <small id={`editor-filename-${instrument.key}`} className="mix-room__stem-filename" title={instrument.fileName}>{instrument.fileName}</small>}
            </div>)
  const nameActions = (
          <div key="apply-names" className="mix-room__editor-actions">
            <button type="button" className="mix-room__stem-smart-rename" disabled={disabled || !namedFiles.length} onClick={smartRename} title={COPY.name_instruments_using_filename_keywords}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m3 18 3 3L19 8l-3-3Z M14 7l3 3 M6 2v4 M4 4h4 M20 12v6 M17 15h6" />
              </svg>
              <span>{COPY.smart_rename}</span>
            </button>
            <button type="submit" disabled={disabled || !valid || !namesChanged}>{savingNames ? COPY.saving : COPY.save_names}</button>
          </div>
  )

  return <section hidden={hidden} className="mix-room__toolbar mix-room__content-overlay mix-room__content-overlay--editor" aria-labelledby="mix-editor-title">
    <header className="mix-room__overlay-header">
      <h2 id="mix-editor-title">{COPY.editor_title}</h2>
      <button type="button" className="mix-room__overlay-close" onClick={onClose} aria-label="Close editor" title={COPY.close_esc}>×</button>
    </header>
    <div className="mix-room__overlay-body">
      {hasContent ? <form onSubmit={event => { event.preventDefault(); if (!disabled && valid) commit.current?.() }}>
        <fieldset className="mix-room__editor-fields" disabled={disabled}>
          {guided && currentNames.filter(instrument => instrument.key === 'guitar').map(renderName)}
          {guided && nameActions}
          <div className="mix-room__stem-field">
            <label htmlFor="editor-song-title">{COPY.song_title}</label>
            <input id="editor-song-title" type="text" value={currentTitle} maxLength={120} required onChange={event => setEditedTitle(event.target.value)} />
          </div>
          <div className="mix-room__editor-instruments">
            {currentNames.filter(instrument => !guided || instrument.key !== 'guitar').map(renderName)}
          </div>
          {!guided && nameActions}
        </fieldset>
      </form> : <p className="mix-room__editor-empty">No mix loaded</p>}
    </div>
  </section>
}
