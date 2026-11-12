import { COPY, formatCopy } from '../config/siteCopy.js'
import { useRef, useState } from 'react'
import { isAudioFile } from '../hooks/useSongUpload.js'
import { suggestStemMix } from '../audio/suggestStemName.js'

const AUDIO_TYPES = 'audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.aif,.aiff,.wma'
const filenameLabel = name => name.replace(/\.[^/.]+$/, '').replaceAll('_', ' ').slice(0, 60)

export default function StemUpload({ disabled, analysisAllowed = true, onUpload }) {
  const [draftTitle, setDraftTitle] = useState(COPY.stem_mix)
  const [stems, setStems] = useState([])
  const picker = useRef(null)
  const replacementPicker = useRef(null)
  const replacing = useRef(null)

  const addFiles = event => {
    const files = Array.from(event.target.files)
    event.target.value = ''
    if (files.some(file => !isAudioFile(file))) return alert(COPY.please_choose_audio_files_for_your_stems)
    if (stems.length + files.length > 32) return alert(COPY.you_can_add_up_to_32_stems_per_mix)
    setStems(previous => [...previous, ...files.map(file => ({
      id: crypto.randomUUID(), file,
      label: filenameLabel(file.name),
    }))])
  }

  const replaceFile = event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    if (!isAudioFile(file)) return alert(COPY.please_choose_an_audio_file)
    setStems(previous => previous.map(stem => stem.id === replacing.current ? { ...stem, file } : stem))
  }

  const smartRename = () => {
    const suggestions = suggestStemMix(stems.map(stem => stem.file.name))
    if (suggestions.title) setDraftTitle(suggestions.title)
    setStems(previous => previous.map((stem, index) => ({
      ...stem, label: suggestions.labels[index] ?? stem.label,
    })))
  }

  return (
    <div className="mix-room__stem-upload">
      <div className="mix-room__stem-field mix-room__stem-title">
        <label htmlFor="stem-song-title">{COPY.song_title}</label>
        <input id="stem-song-title" type="text" value={draftTitle} maxLength={120} disabled={disabled} onChange={event => setDraftTitle(event.target.value)} />
      </div>
      <div className="mix-room__new-stems">
        {stems.length > 0 && <p className="mix-room__processing-help" role="status">{stems.length} {stems.length === 1 ? COPY.stem : COPY.stems_3} {COPY.added}</p>}
        <input ref={picker} type="file" accept={AUDIO_TYPES} multiple disabled={disabled} className="mix-room__file-input" aria-label={COPY.add_stem_files} onChange={addFiles} />
        <input ref={replacementPicker} type="file" accept={AUDIO_TYPES} disabled={disabled} className="mix-room__file-input" aria-label={COPY.replacement_stem_file} onChange={replaceFile} />
        <div className="mix-room__stem-list">
          {!stems.length && <div className="mix-room__empty-stems">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6" /></svg>
            <button type="button" className="mix-room__stem-choose" disabled={disabled} onClick={() => picker.current.click()}>{COPY.choose_stem_files}</button>
            <small>{COPY.aligned_stems}</small>
          </div>}
          {stems.map((stem, index) => (
            <div key={stem.id} className="mix-room__stem-row">
              <div className="mix-room__stem-field mix-room__stem-name">
                <label htmlFor={`stem-name-${stem.id}`}>{COPY.instrument_name}</label>
                <input id={`stem-name-${stem.id}`} type="text" value={stem.label} maxLength={60} disabled={disabled} aria-describedby={`stem-filename-${stem.id}`} onChange={event => setStems(previous => previous.map(item => item.id === stem.id ? { ...item, label: event.target.value } : item))} />
                <small id={`stem-filename-${stem.id}`} className="mix-room__stem-filename" title={stem.file.name}>{stem.file.name}</small>
              </div>
              <button type="button" className="mix-room__stem-replace" disabled={disabled} onClick={() => { replacing.current = stem.id; replacementPicker.current.click() }} aria-label={formatCopy(COPY.replace_file, { value1: index + 1, value2: stem.file.name })} title={formatCopy(COPY.replace, { value1: stem.file.name })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5 M4 17v-5h5 M20 12a8 8 0 0 0-14-5 M4 12a8 8 0 0 0 14 5" /></svg><span>{COPY.re_upload}</span></button>
              <button type="button" className="mix-room__stem-remove" disabled={disabled} aria-label={formatCopy(COPY.remove_file, { value1: index + 1, value2: stem.file.name })} onClick={() => setStems(previous => previous.filter(item => item.id !== stem.id))}>×</button>
            </div>
          ))}
        </div>
        {stems.length > 0 && <div className="mix-room__stem-actions">
          <div className="mix-room__stem-selection-actions">
            <button type="button" className="mix-room__stem-add" disabled={disabled || stems.length >= 32} onClick={() => picker.current.click()} aria-label={COPY.add_more_stems} title={COPY.add_more_stems}><span aria-hidden="true">+</span><span className="mix-room__stem-action-label"> {COPY.add_stems}</span></button>
            <button type="button" className="mix-room__stem-smart-rename" disabled={disabled || !stems.length} onClick={smartRename} aria-label={COPY.smart_rename} title={COPY.name_instruments_using_filename_keywords}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m3 18 3 3L19 8l-3-3Z M14 7l3 3 M6 2v4 M4 4h4 M20 12v6 M17 15h6" />
              </svg>
              <span className="mix-room__stem-action-label">{COPY.smart_rename}</span>
            </button>
          </div>
          <button type="button" className="mix-room__stem-analyze" disabled={disabled || !analysisAllowed || !draftTitle.trim() || !stems.length || stems.some(stem => !stem.label.trim())} onClick={() => onUpload(stems, draftTitle)}>{COPY.analyze_stems}</button>
        </div>}
      </div>
    </div>
  )
}
