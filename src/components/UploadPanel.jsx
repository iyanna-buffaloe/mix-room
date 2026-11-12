import { COPY, formatCopy } from '../config/siteCopy.js'
import { publicProcessingFailureMessage } from '../separation/processingFailure.js'
import StemUpload from './StemUpload.jsx'
import { THOROUGH_AVAILABLE } from '../config/features.js'

// ============================================================
// UPLOAD CONTROLS
// ============================================================
//
// Show the choices for uploading a song or separate instrument tracks. App
// remembers the chosen file, asks about unsaved work and handles sign-in.
// Hide this panel rather than recreating it, so changing panels keeps the user's
// choices. Song-processing credits and guest stem allowances have separate rules.

export default function UploadPanel({
  hidden, busy, account, songUpload,
  browserMix, uploadView, setUploadView, developerMode,
  processingMode, setProcessingMode, selectedFile, fileInputRef,
  handleFileChange, handleChooseFile, mvsepResultLink, setMVSEPResultLink,
  handleUploadClick, uploading, audioSeparationReady, mixId,
  requestAccount, requestLeave, closeOverlay
}) {
  return (
    <div className="mix-room__toolbar mix-room__toolbar-section mix-room__processing-section" hidden={hidden}>
      <header className="mix-room__overlay-header mix-room__upload-panel-header">
        <h2 id="upload-panel-title" className="mix-room__processing-heading">{COPY.upload_tracks}</h2>
        <button type="button" className="mix-room__overlay-close" onClick={closeOverlay} disabled={busy} aria-label={COPY.close_upload_tracks} title={COPY.close_esc}>×</button>
      </header>

      <fieldset className="mix-room__processing" disabled={busy} aria-labelledby="upload-panel-title">
        <div className="mix-room__processing-header">
          <div className="mix-room__upload-views" data-view={uploadView} role="group" aria-label={COPY.upload_type}>
            <button type="button" aria-pressed={uploadView === 'song'} onClick={() => setUploadView('song')}>{COPY.audio_file_2}</button>
            <button type="button" aria-pressed={uploadView === 'stems'} onClick={() => setUploadView('stems')}>{COPY.stems_2}</button>
          </div>
        </div>

        {/* Show a readable error; keep technical details in developer mode. */}
        {songUpload.failure && <div className="mix-room__processing-error" role="alert"><p className="mix-room__processing-help">{developerMode ? songUpload.uploadError : publicProcessingFailureMessage(songUpload.failure)}</p><button type="button" onClick={songUpload.showFailure}>{developerMode ? COPY.show_error_details : COPY.view_message}</button>{developerMode && <button type="button" onClick={songUpload.clearFailure}>{COPY.clear_saved_error}</button>}</div>}

        {/* A failed check shows only its retry notice, not a stale "Checking…" line. */}
        <p id="processing-allowance" className="mix-room__processing-help mix-room__credit-balance" role="status" hidden={!songUpload.credits && !!songUpload.creditNotice}>{!songUpload.credits ? COPY.checking_analyses : uploadView === 'song'
          ? formatCopy(songUpload.credits.remaining === 1 ? COPY.audio_analysis_remaining : COPY.audio_analyses_remaining, { value1: songUpload.credits.remaining })
          : songUpload.credits.scope === 'account' ? COPY.unlimited_stem_analysis
            : formatCopy(songUpload.credits.stemsRemaining === 1 ? COPY.stem_analysis_remaining : COPY.stem_analyses_remaining, { value1: songUpload.credits.stemsRemaining })}</p>
        {songUpload.creditNotice && <p className="mix-room__credit-notice mix-room__processing-help" role="status">{songUpload.creditNotice} <button type="button" onClick={() => songUpload.refreshCredits()}>{COPY.try_again}</button></p>}
        {songUpload.credits?.scope === 'guest' && uploadView === 'stems' && songUpload.credits.stemsRemaining === 0 && <button type="button" onClick={() => requestAccount(false)}>Sign in</button>}
        {browserMix.notice && <p className="mix-room__processing-help" role="status">{browserMix.notice}</p>}

        {/* Ask about unsaved changes before a resumed job replaces the open mix. */}
        {songUpload.recoveryAvailable && <button type="button" disabled={busy} onClick={async () => { if (await requestLeave()) songUpload.resumePreviousJob() }}>Resume previous processing job</button>}

        <div className="mix-room__song-upload" hidden={uploadView !== 'song'}>
          <div className="mix-room__song-fields">
            {!import.meta.env.DEV && songUpload.available === false && <p className="mix-room__service-notice" role="status">{COPY.song_separation_is_unavailable_right_now} <button type="button" onClick={() => setUploadView('stems')}>{COPY.use_your_own_stems}</button></p>}

            {/* The selected file stays available while the user signs in. */}
            <div className="mix-room__upload-actions">
              <input type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.aif,.aiff" ref={fileInputRef} disabled={busy} className="mix-room__file-input" aria-label={COPY.choose_audio_file} onChange={handleFileChange} />
              <span id="selected-filename" className={`mix-room__filename${!selectedFile ? ' mix-room__filename--empty' : ''}`} aria-live="polite">{selectedFile?.name ?? COPY.choose_a_song_to_get_started}</span>
              <button type="button" className="mix-room__file-picker" onClick={handleChooseFile} disabled={busy} aria-describedby="selected-filename">{selectedFile ? COPY.change_file : COPY.choose_file}</button>
            </div>

            {/* Thorough is paused while MVSEP blocks chained jobs, so the single
                six-stem mode is described rather than offered as a choice. */}
            <h3 className="mix-room__upload-step">{THOROUGH_AVAILABLE ? COPY.separation_detail : COPY.what_you_ll_get}</h3>
            {THOROUGH_AVAILABLE ? (
              <div className="mix-room__processing-options">
                {[
                  { value: 'quick', label: COPY.quick, description: COPY.quick_description },
                  { value: 'thorough', label: COPY.thorough, description: COPY.adds_drum_parts_lead_backing_vocals },
                ].map(mode => (
                  <label key={mode.value} className={`mix-room__processing-option${processingMode === mode.value ? ' mix-room__processing-option--selected' : ''}`}>
                    <input
                      type="radio"
                      name="processing-mode"
                      value={mode.value}
                      checked={processingMode === mode.value}
                      onChange={() => setProcessingMode(mode.value)}
                    />
                    <span>
                      <strong>{mode.label}</strong>
                      <span className="mix-room__processing-description">{mode.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="mix-room__processing-options mix-room__processing-options--single">
                <p className="mix-room__processing-option mix-room__processing-option--info">
                  <span>
                    <strong>{COPY.six_stem_separation}</strong>
                    <span className="mix-room__processing-description">{COPY.six_stem_separation_description}</span>
                  </span>
                </p>
              </div>
            )}

            {developerMode && <details className="mix-room__existing-result">
              <summary>{COPY.use_an_existing_mvsep_result}</summary>
              <p className="mix-room__processing-help">{COPY.load_a_completed_quick_or_six_stem_result_this_uses_no_separation_credits}</p>
              <div className="mix-room__existing-result-fields">
                <label className="mix-room__stem-field">
                  {COPY.mvsep_result_link_or_job_hash}
                  <input type="text" value={mvsepResultLink} onChange={event => setMVSEPResultLink(event.target.value)} maxLength={600} autoCapitalize="none" spellCheck={false} />
                </label>
                <button type="button" disabled={busy || !mvsepResultLink.trim() || songUpload.available !== true} onClick={() => songUpload.loadMVSEPResult(mvsepResultLink, selectedFile?.name)}>{COPY.load_result}</button>
              </div>
            </details>}
          </div>

          <div className="mix-room__upload-submit">
            <button id="song-upload-submit" type="button" className="mix-room__upload-button" onClick={handleUploadClick} disabled={busy || !selectedFile || account.status === 'checking' || (!audioSeparationReady && !(account.status === 'guest' && songUpload.available === true && songUpload.credits?.remaining === 0))} aria-describedby="processing-allowance">
              {uploading ? COPY.processing : account.status === 'guest' && songUpload.credits?.remaining === 0 ? 'Sign in for more analyses' : COPY.upload_visualize}
            </button>
          </div>
        </div>

        <div className="mix-room__stems-view" hidden={uploadView !== 'stems'}>
          {/* Keep the stem form when switching panels; reset it when opening a different mix. */}
          <StemUpload key={mixId} disabled={busy} analysisAllowed={account.status === 'signed-in' || songUpload.credits?.stemsRemaining > 0} onUpload={async (...args) => { if (await requestLeave()) browserMix.analyzeStems(...args) }} />
        </div>
      </fieldset>
    </div>
  )
}
