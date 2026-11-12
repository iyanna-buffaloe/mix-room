import { COPY } from '../config/siteCopy.js'
import { useEffect, useRef, useState } from 'react'
import { processingFailureReport, publicProcessingFailureMessage } from '../separation/processingFailure.js'

export function ProcessingFailure({ failure, onRetry, onClose, developerMode = false }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const panel = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.scrollIntoView({ block: 'center' })
    panel.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected && !previous.disabled) previous.focus({ preventScroll: true }) }
  }, [])
  const canRetry = Boolean(failure.job || failure.reference)
  return <div className="mix-room__loading mix-room__failure" role="alertdialog" aria-label={COPY.processing_stopped}>
    <div ref={panel} className="mix-room__loading-content" tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }}>
      <p className="mix-room__loading-eyebrow">{COPY.processing_stopped}</p>
      <h2 className="mix-room__loading-title">{failure.name}</h2>
      <p className="mix-room__loading-stage">{developerMode ? failure.message : publicProcessingFailureMessage(failure)}</p>
      {developerMode && <p className="mix-room__failure-step">{COPY.last_step} {failure.step} ({Math.floor(failure.percent ?? 0)}%)</p>}
      {developerMode && !!failure.providerJobs?.some(job => job.hash) && <div className="mix-room__failure-links">{failure.providerJobs.filter(job => job.hash).map(job => <a key={job.stage} href={`https://mvsep.com/result/${encodeURIComponent(job.hash)}`} target="_blank" rel="noreferrer">{COPY.view} {job.stage === 'quick' || job.stage === 'instruments' ? 'instruments' : job.stage} {COPY.in_mvsep}</a>)}</div>}
      <div className="mix-room__failure-actions">
        {canRetry && <button type="button" className="mix-room__loading-cancel" onClick={onRetry}>{developerMode ? COPY.retry_loading_no_credits : COPY.try_loading_again}</button>}
        {developerMode && <button type="button" className="mix-room__loading-cancel" onClick={async () => { try { await navigator.clipboard.writeText(processingFailureReport(failure)); setCopied(true); setCopyFailed(false) } catch { setCopyFailed(true) } }}>{copied ? COPY.copied : COPY.copy_error_details}</button>}
        <button type="button" className="mix-room__loading-cancel" onClick={onClose}>{COPY.close}</button>
      </div>
      {developerMode && copyFailed && <p className="mix-room__failure-step">{COPY.copy_was_unavailable_open_error_details_below_to_select_the_report}</p>}
      {developerMode && <details className="mix-room__failure-details"><summary>{COPY.error_details}</summary><pre>{processingFailureReport(failure)}</pre></details>}
    </div>
  </div>
}
