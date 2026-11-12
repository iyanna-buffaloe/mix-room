import { useEffect, useRef } from 'react'

const IDLE_DELAY = 2500

// ============================================================
// FULLSCREEN TRANSPORT VISIBILITY
// ============================================================
//
// Show the fullscreen buttons when the user interacts, then hide them after
// a quiet moment. Keep them visible during a drag, and let Tab bring them back.
// Hidden buttons must not receive keyboard input or be read by a screen reader.
// Stop watching for input when this fullscreen control bar is removed.

export default function FullscreenControls({ surfaceRef, children }) {
  const controlsRef = useRef(null)

  useEffect(() => {
    const surface = surfaceRef.current
    const controls = controlsRef.current
    if (!surface || !controls) return
    let timer, focusFrame, pointerHeld = false

    // Tell the page whether to show the bar. Also keep hidden buttons out of
    // keyboard navigation and screen readers, rather than just making them invisible.
    const visible = show => {
      controls.dataset.visible = String(show)
      controls.inert = !show
      controls.setAttribute('aria-hidden', String(!show))
      surface.dataset.controlsVisible = String(show)
    }

    // Restart the wait before hiding. Close any volume popup and move keyboard
    // selection off the bar first, so neither is left on invisible controls.
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Wait until a held drag ends before hiding its controls.
        if (pointerHeld) {
          schedule()
          return
        }
        controls.querySelectorAll(':popover-open').forEach(popup => popup.hidePopover())
        if (controls.contains(document.activeElement)) surface.focus({ preventScroll: true })
        visible(false)
      }, IDLE_DELAY)
    }
    const reveal = () => {
      visible(true);
      schedule()
    }

    const pointerMove = reveal
    const pointerDown = () => {
      pointerHeld = true;
      reveal()
    }

    // Notice when a drag ends anywhere on the page, even outside the control bar.
    const pointerUp = () => {
      pointerHeld = false;
      schedule()
    }

    // When Tab reveals a hidden bar, wait for its buttons to appear before
    // selecting one. Shift+Tab starts at the last button instead of the first.
    const keyboard = event => {
      const wasHidden = controls.inert
      reveal()
      const usingGuide = event.target.closest('.mix-room__ordinary-panels, .mix-room__tutorial-caption, .mix-room__tutorial-skip, .mix-room__room-style-menu')
      if (wasHidden && event.key === 'Tab' && !usingGuide) {
        event.preventDefault()
        focusFrame = requestAnimationFrame(() => {
          const inputs = [...controls.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
            .filter(el => el.getClientRects().length)
          const next = event.shiftKey ? inputs.at(-1) : inputs[0]
          next?.focus({ preventScroll: true })
        })
      }
    }

    // Using the volume popup keeps the bar awake; closing it restarts the wait.
    const toggle = event => {
      if (!event.target.matches('[popover]')) return
      if (event.newState === 'open') reveal()
      else schedule()
    }

    surface.addEventListener('pointermove', pointerMove, { passive: true })
    surface.addEventListener('pointerdown', pointerDown, { capture: true, passive: true })
    surface.addEventListener('toggle', toggle, true)
    controls.addEventListener('input', reveal)
    controls.addEventListener('focusout', schedule)
    document.addEventListener('pointerup', pointerUp, true)
    document.addEventListener('pointercancel', pointerUp, true)
    document.addEventListener('keydown', keyboard, true)
    reveal()

    // Stop timers and input watchers on exit, so they cannot change a control
    // bar that has already been removed from the page.
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(focusFrame)
      delete surface.dataset.controlsVisible
      surface.removeEventListener('pointermove', pointerMove)
      surface.removeEventListener('pointerdown', pointerDown, true)
      surface.removeEventListener('toggle', toggle, true)
      controls.removeEventListener('input', reveal)
      controls.removeEventListener('focusout', schedule)
      document.removeEventListener('pointerup', pointerUp, true)
      document.removeEventListener('pointercancel', pointerUp, true)
      document.removeEventListener('keydown', keyboard, true)
    }
  }, [surfaceRef])

  return <div ref={controlsRef} className="mix-room__fullscreen-controls" data-visible="true" role="group" aria-label="Fullscreen controls">{children}</div>
}
