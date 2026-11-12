import { createPortal } from 'react-dom'
import { COPY, formatCopy } from '../config/siteCopy.js'
import { useEffect, useId, useRef, useState } from 'react'

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--'
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function VolumeIcon({ muted }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4 6 8H3v8h3l5 4Z" />
    {muted ? <path d="m16 9 5 6 M21 9l-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14" /></>}
  </svg>
}

// A native popover lives in the top layer, outside its ancestors' transforms.
// Place its bottom-center above the trigger in room coordinates, then project
// that anchor and the room's axes back into the physical viewport.
function placeVolumePopup(trigger, popup) {
  if (!trigger || !popup) return
  const stage = trigger.closest('.mix-room__canvas-content')
  const stageStyle = stage && getComputedStyle(stage)
  const bounds = stage?.getBoundingClientRect() || { x: 0, y: 0, width: innerWidth, height: innerHeight }
  const width = stage?.offsetWidth || innerWidth, height = stage?.offsetHeight || innerHeight
  const axes = new DOMMatrix(stageStyle?.transform || undefined)
  // The bounds already include translation; only rotate/scale relative points.
  axes.e = 0; axes.f = 0
  const rect = trigger.getBoundingClientRect()
  const center = new DOMPoint(rect.x + rect.width / 2 - bounds.x - bounds.width / 2, rect.y + rect.height / 2 - bounds.y - bounds.height / 2).matrixTransform(axes.inverse())
  const triggerHeight = Math.abs(axes.b) * rect.width + Math.abs(axes.a) * rect.height
  const inset = edge => parseFloat(stageStyle?.getPropertyValue(`--fullscreen-controls-safe-${edge}`)) || 0
  const anchor = new DOMPoint(
    Math.max(inset('left') + 40, Math.min(center.x + width / 2, width - inset('right') - 40)) - width / 2,
    center.y - triggerHeight / 2 - 8,
  ).matrixTransform(axes)
  popup.style.left = `${bounds.x + bounds.width / 2 + anchor.x}px`
  popup.style.top = `${bounds.y + bounds.height / 2 + anchor.y}px`
  popup.style.bottom = 'auto'
  popup.style.transform = `matrix(${axes.a}, ${axes.b}, ${axes.c}, ${axes.d}, 0, 0) translate(-50%, -100%)`
  popup.style.setProperty('--volume-slider-height', `${Math.min(120, Math.max(40, center.y + height / 2 - triggerHeight / 2 - inset('top') - 78))}px`)
}

export default function AudioPlayer({ audioRef, src, playing, onPlayingChange, onTogglePlayback, onSeek, disabled, loop = false, controlsHost = null }) {
  const [timeline, setTimeline] = useState({ time: 0, duration: NaN })
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const volumeId = useId()
  const volumePopup = useRef(null)
  const volumeButton = useRef(null)
  const volumeSlider = useRef(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  useEffect(() => { volumePopup.current?.hidePopover() }, [src, disabled, controlsHost])
  useEffect(() => {
    const close = () => volumePopup.current?.hidePopover()
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [])
  const [failed, setFailed] = useState(false)
  const updateTimeline = event => {
    const audio = event.currentTarget
    setTimeline({ time: audio.currentTime || 0, duration: Number.isFinite(audio.duration) ? audio.duration : NaN })
  }
  const resetTimeline = event => {
    setTimeline({ time: 0, duration: NaN })
    setFailed(false)
    onPlayingChange(!event.currentTarget.paused)
  }
  const canSeek = Number.isFinite(timeline.duration) && timeline.duration > 0 && !failed
  const time = canSeek ? Math.min(timeline.time, timeline.duration) : 0
  const silent = muted || volume === 0

  const controls = (
    <div className="mix-room__audio mix-room__custom-player" role="group" aria-label={COPY.audio_player}>
      <button type="button" className="mix-room__play-button" disabled={disabled || failed} onClick={onTogglePlayback} aria-label={playing ? COPY.pause : COPY.play} title={playing ? COPY.pause : COPY.play}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {playing ? <path d="M6 5h4v14H6z M14 5h4v14h-4z" /> : <path d="m8 4 12 8-12 8Z" />}
        </svg>
      </button>
      <div className="mix-room__player-timeline">
        <div className="mix-room__player-times">
          <span>{failed ? <span role="status">{COPY.audio_unavailable}</span> : formatTime(time)}</span>
          <span>{formatTime(timeline.duration)}</span>
        </div>
        <input type="range" className="mix-room__player-range" aria-label={COPY.seek} aria-valuetext={formatCopy(COPY.of, { value1: formatTime(time), value2: formatTime(timeline.duration) })}
          min="0" max={canSeek ? timeline.duration : 1} step="0.1" value={time} disabled={disabled || !canSeek}
          style={{ '--range-progress': `${canSeek ? time / timeline.duration * 100 : 0}%` }}
          onChange={event => {
            const audio = audioRef.current
            if (!audio || !canSeek) return
            audio.currentTime = Number(event.target.value)
            onSeek?.(audio.currentTime)
            setTimeline(previous => ({ ...previous, time: audio.currentTime }))
          }}
        />
      </div>
      <div className="mix-room__player-volume" onKeyDown={event => {
        if (event.key === 'Escape' && volumeOpen) {
          event.preventDefault()
          event.stopPropagation()
          volumePopup.current?.hidePopover()
          volumeButton.current?.focus({ preventScroll: true })
        }
      }}>
        <button ref={volumeButton} type="button" className="mix-room__volume-button" aria-label={COPY.volume} title={COPY.volume}
          popoverTarget={volumeId} aria-controls={volumeId} aria-expanded={volumeOpen} disabled={disabled}
          onClick={event => placeVolumePopup(event.currentTarget, volumePopup.current)}><VolumeIcon muted={silent} /></button>
        <div id={volumeId} ref={volumePopup} popover="auto" className="mix-room__volume-popup" role="group" aria-label="Volume control"
          onToggle={event => {
            const open = event.newState === 'open'
            setVolumeOpen(open)
            if (open) { placeVolumePopup(volumeButton.current, volumePopup.current); volumeSlider.current?.focus({ preventScroll: true }) }
          }}>
          <div className="mix-room__volume-heading"><span>{COPY.volume}</span><output>{Math.round((muted ? 0 : volume) * 100)}%</output></div>
          <input ref={volumeSlider} type="range" className="mix-room__player-range" aria-label={COPY.volume} aria-orientation="vertical" aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
            min="0" max="1" step="0.01" value={muted ? 0 : volume} disabled={disabled}
            style={{ '--range-progress': `${(muted ? 0 : volume) * 100}%` }}
            onChange={event => {
              const audio = audioRef.current
              if (!audio) return
              audio.volume = Number(event.target.value)
              audio.muted = false
            }}
          />
        </div>
      </div>
    </div>
  )
  return <>
    <audio
      ref={audioRef} src={src} preload="metadata" hidden loop={loop}
      onPlay={() => { if (disabled) audioRef.current?.pause(); else onPlayingChange(true) }}
      onPause={() => onPlayingChange(false)}
      onEnded={() => onPlayingChange(false)}
      onEmptied={resetTimeline} onLoadStart={resetTimeline}
      onLoadedMetadata={updateTimeline} onDurationChange={updateTimeline} onTimeUpdate={updateTimeline}
      onVolumeChange={event => {
        const audio = event.currentTarget
        setVolume(audio.volume)
        setMuted(audio.muted)
      }}
      onError={() => { setFailed(true); onPlayingChange(false) }}
    />
    {controlsHost ? createPortal(controls, controlsHost) : controls}
  </>
}
