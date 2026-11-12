import { ROOM_STYLES } from '../room/roomStyles.js'
import { PROJECT_LINKS } from '../config/projectInfo.js'
import { COPY, formatCopy, PROJECT_UPDATES } from '../config/siteCopy.js'
import { THOROUGH_AVAILABLE } from '../config/features.js'
import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

function StyleSwatch({ palette }) {
  return <span className="mix-room__style-swatch" style={{ background: `linear-gradient(${palette.wall} 0% 60%, ${palette.floorBack} 60%, ${palette.floorFront})`, borderColor: palette.grid }} aria-hidden="true" />
}

function RoomStylePicker({ value, onChange, disabled }) {
  const entries = Object.entries(ROOM_STYLES)
  const selected = Math.max(0, entries.findIndex(([key]) => key === value))
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(selected)
  const [placement, setPlacement] = useState({})
  const root = useRef(null), trigger = useRef(null), menu = useRef(null), options = useRef([])
  const contains = target => root.current?.contains(target) || menu.current?.contains(target)
  useEffect(() => {
    if (!open) return
    const close = event => { if (!root.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false) }
    const reposition = () => setOpen(false)
    document.addEventListener('pointerdown', close)
    window.addEventListener('resize', reposition)
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', reposition) }
  }, [open])
  useEffect(() => { if (open) options.current[focused]?.focus({ preventScroll: true }) }, [open, focused])
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  const show = index => {
    const rect = trigger.current.getBoundingClientRect()
    const height = Math.min(160, window.innerHeight - 16)
    setPlacement({ left: Math.min(rect.left, window.innerWidth - rect.width - 8), top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - height - 8)), width: rect.width, maxHeight: height })
    setFocused(index); setOpen(true)
  }
  const keyboard = event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      show(event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : !open ? selected : (focused + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length)
    }
  }
  return <div className="mix-room__style-select" ref={root} onKeyDown={keyboard} onBlur={event => { if (!contains(event.relatedTarget)) setOpen(false) }}>
    <button id="room-style" ref={trigger} type="button" className="mix-room__style-trigger" disabled={disabled} aria-labelledby="room-style-label room-style-current" aria-haspopup="listbox" aria-controls="room-style-options" aria-expanded={open} onClick={() => { if (open) close(); else show(selected) }}>
      <span id="room-style-current">{COPY[entries[selected][0]]}</span><StyleSwatch palette={entries[selected][1]} />
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && createPortal(<div ref={menu} id="room-style-options" className="mix-room__room-style-menu" style={placement} role="listbox" aria-labelledby="room-style-label">
      {entries.map(([key, palette], index) => <button ref={element => { options.current[index] = element }} type="button" role="option" disabled={disabled} aria-selected={key === value} tabIndex={index === focused ? 0 : -1} key={key} onFocus={() => setFocused(index)} onClick={() => { onChange(key); close() }}>
        <span>{COPY[key]}</span><StyleSwatch palette={palette} /><span className="mix-room__style-check" aria-hidden="true">{key === value ? '✓' : ''}</span>
      </button>)}
    </div>, document.body)}
  </div>
}

function ExternalLink({ href, children }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7" /></svg><span className="mix-room__sr-only">{COPY.opens_in_a_new_tab}</span></a>
}

function MobilePager({ label, index, count, onPrevious, onNext, previousLabel, nextLabel, disabled = false, children }) {
  const position = formatCopy(COPY.of, { value1: index + 1, value2: count })
  return <section className="mix-room__mobile-pager" role="region" aria-roledescription="carousel" aria-label={label}>
    <div className="mix-room__mobile-pager-card" role="group" aria-roledescription="slide" aria-label={position} aria-live="polite" aria-atomic="true">
      <div className="mix-room__mobile-pager-content">{children}</div>
    </div>
    <div className="mix-room__mobile-pager-controls">
      <button type="button" onClick={onPrevious} disabled={disabled} aria-label={previousLabel}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /><path d="M20 12H8" /></svg>
      </button>
      <span aria-hidden="true">{position}</span>
      <button type="button" onClick={onNext} disabled={disabled} aria-label={nextLabel}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /><path d="M4 12h12" /></svg>
      </button>
    </div>
  </section>
}

const MOBILE_ABOUT_PAGES = [
  { title: COPY.a_visual_map_of_your_mix, body: COPY.mobile_visual_map },
  { title: COPY.left_right, body: COPY.mobile_left_right },
  { title: COPY.height, body: COPY.mobile_height },
  { title: COPY.depth, body: COPY.mobile_depth },
  { title: COPY.oval_width, body: COPY.mobile_oval_width },
  { title: COPY.visibility, body: COPY.mobile_visibility },
  { title: COPY.bring_in_your_music, body: COPY.mobile_bring_music },
  { title: COPY.your_files, body: COPY.mobile_your_files },
  { title: COPY.made_with, links: true },
]

function About() {
  return <>
    <div className="mix-room__about-desktop">
      <p className="mix-room__overlay-intro">{COPY.see_how_the_parts_of_a_song_share_the_stereo_field_music_room_turns_your_stems_i}</p>
      <section className="mix-room__overlay-section">
        <h3>{COPY.read_the_room}</h3>
        <dl className="mix-room__room-guide">
          <div><dt>{COPY.left_right}</dt><dd>{COPY.the_stem_s_stereo_position_only_sustained_substantial_pan_changes_move_an_instru}</dd></div>
          <div><dt>{COPY.height}</dt><dd>{COPY.lower_frequency_sounds_sit_lower_brighter_sounds_sit_higher}</dd></div>
          <div><dt>{COPY.depth}</dt><dd>{COPY.louder_parts_sit_closer_to_the_front_of_the_room}</dd></div>
          <div><dt>{COPY.oval_width}</dt><dd>{COPY.an_estimate_of_stereo_spread_each_shape_stays_steady_throughout_the_song}</dd></div>
          <div><dt>{COPY.visibility}</dt><dd>{COPY.instruments_appear_when_active_visible_instruments_lets_you_choose_which_parts_t}</dd></div>
        </dl>
        <p className="mix-room__overlay-note">{COPY.positions_and_widths_are_listening_guides_the_layout_adds_spacing_between_overla}</p>
      </section>
      <section className="mix-room__overlay-section">
        <h3>{COPY.bring_in_your_music}</h3>
        <p><strong>{COPY.stems}</strong> {COPY.add_files_that_start_at_the_same_point_in_the_song_name_each_instrument_then_cho}</p>
        <p><strong>{COPY.audio_file}</strong> {THOROUGH_AVAILABLE ? COPY.choose_quick_for_six_instruments_including_guitar_and_piano_or_thorough_for_indi : COPY.your_song_is_separated_into_six_stems}</p>
      </section>
      <section className="mix-room__overlay-section">
        <h3>{COPY.your_files}</h3>
        <p>{COPY.stem_analysis_and_video_export_happen_in_your_browser_your_latest_finished_mix_i}</p>
        <p>{COPY.audio_file_separation_uploads_your_song_through_temporary_cloud_storage_to_mvsep}</p>
      </section>
      <section className="mix-room__overlay-section">
        <h3>{COPY.made_with}</h3>
        <div className="mix-room__credit-links">
          <ExternalLink href="https://react.dev/">{COPY.react}</ExternalLink>
          <ExternalLink href="https://threejs.org/">{COPY.three_js}</ExternalLink>
          <ExternalLink href="https://github.com/pmndrs/react-three-fiber">{COPY.react_three_fiber}</ExternalLink>
          <ExternalLink href="https://github.com/pmndrs/drei">{COPY.drei}</ExternalLink>
          <ExternalLink href="https://mediabunny.dev/">{COPY.mediabunny}</ExternalLink>
          <ExternalLink href="https://mvsep.com/">{COPY.mvsep}</ExternalLink>
          <ExternalLink href="https://developers.cloudflare.com/r2/">{COPY.cloudflare_r2}</ExternalLink>
          <ExternalLink href="/fonts/Jura-OFL.txt">{COPY.jura}</ExternalLink>
          <ExternalLink href="/fonts/Arimo-OFL.txt">{COPY.arimo}</ExternalLink>
        </div>
      </section>
    </div>
    <MobileAbout />
  </>
}

function MobileAbout() {
  const [page, setPage] = useState(0)
  const current = MOBILE_ABOUT_PAGES[page]
  const changePage = direction => setPage(index => (index + direction + MOBILE_ABOUT_PAGES.length) % MOBILE_ABOUT_PAGES.length)
  return <div className="mix-room__about-mobile">
    <MobilePager label={COPY.about_music_room} index={page} count={MOBILE_ABOUT_PAGES.length} onPrevious={() => changePage(-1)} onNext={() => changePage(1)} previousLabel={COPY.previous_information} nextLabel={COPY.next_information}>
      <h3>{current.title}</h3>
      {current.body && <p>{current.body}</p>}
      {current.links && <div className="mix-room__credit-links">
        <ExternalLink href="https://react.dev/">{COPY.react}</ExternalLink>
        <ExternalLink href="https://threejs.org/">{COPY.three_js}</ExternalLink>
        <ExternalLink href="https://github.com/pmndrs/react-three-fiber">{COPY.react_three_fiber}</ExternalLink>
        <ExternalLink href="https://github.com/pmndrs/drei">{COPY.drei}</ExternalLink>
        <ExternalLink href="https://mediabunny.dev/">{COPY.mediabunny}</ExternalLink>
        <ExternalLink href="https://mvsep.com/">{COPY.mvsep}</ExternalLink>
        <ExternalLink href="https://developers.cloudflare.com/r2/">{COPY.cloudflare_r2}</ExternalLink>
        <ExternalLink href="/fonts/Jura-OFL.txt">{COPY.jura}</ExternalLink>
        <ExternalLink href="/fonts/Arimo-OFL.txt">{COPY.arimo}</ExternalLink>
      </div>}
    </MobilePager>
  </div>
}

function GitHub() {
  return <>
    <p className="mix-room__overlay-intro">{COPY.github_intro}</p>
    <div className="mix-room__project-links">
      <ExternalLink href={PROJECT_LINKS.source}>{COPY.view_source}</ExternalLink>
      <ExternalLink href={PROJECT_LINKS.issues}>{COPY.report_issue}</ExternalLink>
      <ExternalLink href={PROJECT_LINKS.changes}>{COPY.commit_history}</ExternalLink>
    </div>
    <p className="mix-room__overlay-note">{COPY.issue_help}</p>
    <section className="mix-room__overlay-section">
      <h3>{COPY.recent_changes}</h3>
      <ul className="mix-room__project-updates">{PROJECT_UPDATES.map(update => <li key={update.title}><strong>{update.title}</strong><p>{update.description}</p></li>)}</ul>
    </section>
  </>
}

export default function WorkspaceOverlay({ hidden, guided = false, view, onClose, settings, updateSetting, onResetView, onLoadDemo, onReplayTutorial, onRestoreMix, isDemo, hasSavedMix, disabled, demoTitle, demoArtist, demoCredits }) {
  const [notice, setNotice] = useState('')
  if (!['about', 'settings', 'demo', 'github'].includes(view)) return null
  const title = { about: COPY.about_music_room, settings: COPY.preferences, demo: COPY.demo_mode, github: COPY.music_room_on_github }[view]
  const change = (key, value) => { setNotice(''); updateSetting(key, value) }
  const roomStyleControl = (
          <div key="room-style" className="mix-room__setting mix-room__setting--room-style">
            <label id="room-style-label" htmlFor="room-style">{COPY.room_style}</label>
            <RoomStylePicker value={settings.roomStyle} onChange={value => change('roomStyle', value)} disabled={disabled} />
          </div>
  )
  const labelControls = (
          <div key="labels" className="mix-room__setting mix-room__setting--labels">
            <label className="mix-room__setting-toggle"><input type="checkbox" checked={settings.showLabels} onChange={event => change('showLabels', event.target.checked)} /><span><strong>{COPY.show_instrument_labels}</strong></span></label>
            <div>
              <div className="mix-room__setting-heading"><label htmlFor="instrument-label-size">{COPY.label_size}</label><output htmlFor="instrument-label-size">{Math.round(settings.labelScale * 100)}%</output></div>
              <input id="instrument-label-size" className="mix-room__player-range" type="range" min="0.8" max="1.3" step="0.05" value={settings.labelScale} disabled={!settings.showLabels} aria-valuetext={formatCopy(COPY.percent, { value1: Math.round(settings.labelScale * 100) })} style={{ '--range-progress': `${(settings.labelScale - 0.8) / 0.5 * 100}%` }} onChange={event => change('labelScale', Number(event.target.value))} />
            </div>
          </div>
  )
  const otherControls = <Fragment key="other-settings">
          <div className="mix-room__setting mix-room__setting--sensitivity">
            <div className="mix-room__setting-heading"><label htmlFor="activity-sensitivity">{COPY.activity_sensitivity}</label><output htmlFor="activity-sensitivity">{settings.activitySensitivity === 1 ? COPY.normal : `${settings.activitySensitivity.toFixed(2)}×`}</output></div>
            <input id="activity-sensitivity" className="mix-room__player-range" type="range" min="0.5" max="2" step="0.05" value={settings.activitySensitivity} aria-valuetext={formatCopy(COPY.times_normal_sensitivity, { value1: settings.activitySensitivity.toFixed(2) })} style={{ '--range-progress': `${(settings.activitySensitivity - 0.5) / 1.5 * 100}%` }} onChange={event => change('activitySensitivity', Number(event.target.value))} />
            <p>{COPY.higher_sensitivity_reveals_quieter_parts_sooner_lower_sensitivity_keeps_the_focu}</p>
          </div>
          <label className="mix-room__setting-toggle"><input type="checkbox" checked={settings.panEnabled} onChange={event => change('panEnabled', event.target.checked)} /><span><strong>{COPY.enable_panning}</strong><small>{COPY.follow_sustained_pan_changes_turn_off_to_keep_every_instrument_s_position_fixed}</small></span></label>
          <label className="mix-room__setting-toggle"><input type="checkbox" checked={settings.loop} onChange={event => change('loop', event.target.checked)} /><span><strong>{COPY.loop_song}</strong></span></label>
  </Fragment>
  return <section hidden={hidden} className={`mix-room__toolbar mix-room__content-overlay mix-room__content-overlay--${view}`} aria-labelledby={view === 'settings' ? 'workspace-settings-title' : 'workspace-overlay-title'}>
    <header className="mix-room__overlay-header">
      <h2 id={view === 'settings' ? 'workspace-settings-title' : 'workspace-overlay-title'}>{title}</h2>
      <button type="button" className="mix-room__overlay-close" onClick={onClose} aria-label={formatCopy(COPY.close_2, { value1: view })} title={COPY.close_esc}>×</button>
    </header>
    <div className="mix-room__overlay-body">
      {view === 'about' && <About />}
      {view === 'github' && <GitHub />}
      {view === 'demo' && <>
        <div className="mix-room__demo-song">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" /><path d="M6 6 8 8 M16 16l2 2" /></svg>
          <div><h3>{demoTitle}</h3>{demoArtist && <p>{demoArtist}</p>}</div>
        </div>
        <section className="mix-room__overlay-section">
          <h3>{COPY.credits_and_rights}</h3>
          {demoCredits?.attribution && <p>{demoCredits.attribution}</p>}
          {demoCredits?.recordingNotice && <p>{demoCredits.recordingNotice}</p>}
          {demoCredits?.sourceUrl && <p><a href={demoCredits.sourceUrl} target="_blank" rel="noopener noreferrer">{demoCredits.sourceLabel ?? COPY.release_credits}</a></p>}
          {demoCredits?.licenseUrl && <p><a href={demoCredits.licenseUrl} target="_blank" rel="noopener noreferrer">{demoCredits.licenseLabel}</a></p>}
          {demoCredits?.permissionNotice && <p>{demoCredits.permissionNotice}</p>}
          {demoCredits?.noticeUrl && <p><a href={demoCredits.noticeUrl} target="_blank" rel="noopener noreferrer">{COPY.full_demo_notices}</a></p>}
        </section>
        {isDemo && <p className="mix-room__demo-status" role="status">{COPY.demo_loaded}</p>}
      </>}
      {view === 'settings' && <>
        <fieldset className="mix-room__settings-fields" aria-label={COPY.display_and_playback_settings} disabled={disabled}>
          {[roomStyleControl, ...(guided ? [labelControls, otherControls] : [otherControls, labelControls])]}
        </fieldset>
        {notice && <p className="mix-room__settings-notice" role="status">{notice}</p>}
      </>}
    </div>
    {view === 'settings' && <footer className="mix-room__settings-actions">
      <button type="button" disabled={disabled} onClick={() => { onResetView(); setNotice(COPY.view_reset_to_defaults_your_current_mix_is_still_loaded) }}>{COPY.reset_view}</button>
    </footer>}
    {view === 'demo' && <footer className="mix-room__demo-actions">
      <button type="button" disabled={disabled} onClick={onLoadDemo}>{isDemo ? COPY.open_demo : COPY.load_demo}</button>
      {isDemo && <button type="button" disabled={disabled} onClick={onReplayTutorial}>Replay demo</button>}
      {hasSavedMix && <button type="button" disabled={disabled} onClick={onRestoreMix}>{COPY.return_to_saved_mix}</button>}
    </footer>}
  </section>
}
