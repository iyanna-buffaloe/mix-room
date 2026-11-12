import { COPY } from '../config/siteCopy.js'

// ============================================================
// INSTRUMENT VISIBILITY PANEL
// ============================================================
//
// Show the instrument choices for the open mix. App remembers which ones are
// hidden. The transparency option only changes how bubbles look; it does not
// remove an instrument. Keep these choices fixed while recording a video.

export default function InstrumentVisibilityPanel({
  hidden, instruments, visibleInstruments, setInstrumentVisibility,
  exportingVideo, viewSettings, updateSetting, closeOverlay
}) {
  return (
    <aside className="mix-room__toolbar mix-room__sidebar" hidden={hidden} aria-label={COPY.instrument_visibility}>
      <div className="mix-room__toolbar-section mix-room__instruments-section">
        <header className="mix-room__overlay-header">
          <h2 id="instrument-panel-title">{COPY.visible_instruments}</h2>
          <button type="button" className="mix-room__overlay-close" aria-label={COPY.close_instrument_options} title={COPY.close_instrument_options_esc} onClick={closeOverlay}>×</button>
        </header>

        {/* Lock the instrument choices during recording so the video uses one consistent set. */}
        <fieldset className="mix-room__instruments" disabled={exportingVideo} aria-labelledby="instrument-panel-title">
          <div className="mix-room__instrument-options">
            {instruments.map(inst => (
              <label key={inst.key} className="mix-room__instrument-option">
                <input type="checkbox" checked={visibleInstruments[inst.key] !== false} onChange={e => setInstrumentVisibility(inst.key, e.target.checked)} style={{ '--instrument-color': inst.color }} />
                {inst.displayName}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mix-room__visibility-actions">
          <label className="mix-room__instrument-option">
            <input type="checkbox" checked={viewSettings.depthTransparency} disabled={exportingVideo} onChange={e => updateSetting('depthTransparency', e.target.checked)} />
            {COPY.depth_transparency}
          </label>
        </div>
      </div>
    </aside>
  )
}
