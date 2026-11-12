import './DemoTutorial.css'
import { useEffect, useLayoutEffect, useRef } from 'react'

export default function DemoTutorial({ tutorial, onUpload, onReplay, inspector, view }) {
  const cue = tutorial.cue
  const captionRef = useRef(null)
  useEffect(() => {
    if (!cue) return
    const selectors = cue.panel === 'instruments' ? ['#workspace-tab-instruments', '#workspace-mobile-instruments']
      : cue.panel === 'editor' ? ['#workspace-tab-editor', '#workspace-mobile-editor']
        : cue.panel === 'settings' ? ['#workspace-tab-settings', '#workspace-mobile-settings'] : []
    const nodes = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
    nodes.forEach(node => node.setAttribute('data-tutorial-control', 'true'))
    return () => nodes.forEach(node => node.removeAttribute('data-tutorial-control'))
  }, [cue])
  useLayoutEffect(() => {
    const caption = captionRef.current
    if (!caption) return
    const root = caption.closest('.mix-room')
    const update = () => {
      root.style.setProperty('--tutorial-caption-height', `${caption.offsetHeight}px`)
      const panel = root.querySelector(`[data-guide-panel="${inspector.panel}"] > :not([hidden])`)
      const a = caption.getBoundingClientRect(), b = panel?.getBoundingClientRect()
      const overlaps = b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      root.dataset.captionOverPanel = overlaps ? 'true' : 'false'
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(caption)
    observer.observe(caption.parentElement)
    return () => { observer.disconnect(); delete root.dataset.captionOverPanel; root.style.removeProperty('--tutorial-caption-height') }
  }, [cue, inspector.panel, inspector.deferred, view])
  if (!cue) return null
  return <section ref={captionRef} className="mix-room__tutorial-caption" aria-label="Demo tutorial" data-cue={cue.start} data-section={cue.id}>
    <div className="mix-room__tutorial-copy"><h2>{cue.chapter}</h2><p>
      <span className={cue.compactCopy ? 'mix-room__tutorial-full-copy' : undefined}>{cue.copy}</span>
      {cue.compactCopy && <span className="mix-room__tutorial-compact-copy">{cue.compactCopy}</span>}
    </p></div>
    {tutorial.playbackBlocked && <p className="mix-room__tutorial-play-hint">Press Play to start the tutorial.</p>}
    {inspector.deferred && <p className="mix-room__tutorial-deferred">Your controls are still open. <button type="button" onClick={() => inspector.choose(inspector.recommended)}>Show {cue.chapter} controls</button></p>}
    {cue.upload && <div className="mix-room__tutorial-actions">
      <button id="tutorial-upload-action" type="button" onClick={onUpload}>Upload tracks</button>
      <button type="button" onClick={onReplay}>Replay demo</button>
    </div>}
    <span className="account-announcement" role="status" aria-live="polite" aria-atomic="true">{cue.copy}</span>
  </section>
}
