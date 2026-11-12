import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

export const TUTORIAL_INSPECTORS = ['instruments', 'editor', 'settings']

// One real panel stays mounted throughout the tour. A new chapter recommends a
// panel, but cannot hide an input or pop-up that the visitor is still using.
export function useTutorialInspector(tutorial) {
  const [manual, setManual] = useState(null)
  const [focused, setFocused] = useState(null)
  // A manual detour belongs to this visit, not every future seek back into
  // the same cue object. Focused controls still take precedence below.
  useEffect(() => {
    if (!tutorial.active) return
    const focus = event => {
      if (event.target.closest('.mix-room__room-style-menu')) return
      setFocused(event.target.closest('[data-guide-panel]')?.dataset.guidePanel ?? null)
    }
    const blur = () => queueMicrotask(() => focus({target:document.activeElement}))
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', blur)
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur) }
  }, [tutorial.active])
  const recommended = tutorial.cue?.panel ?? null
  const chosen = manual?.visit === tutorial.visit ? manual.panel : recommended
  const panel = tutorial.active ? focused || chosen : null
  useLayoutEffect(() => {
    if (!tutorial.active || !panel) return
    let scheduled
    const wrapper = document.querySelector(`[data-guide-panel="${panel}"]`)
    const ensureVisible = () => {
      const active = document.activeElement
      const focusedInput = active?.closest('[data-guide-panel]') === wrapper ? active : null
      const selector = { instruments: '.mix-room__instrument-options input', editor: '#editor-instrument-guitar', settings: '#room-style' }[panel]
      const target = focusedInput || wrapper?.querySelector(selector)
      if (!target) return
      // Scroll only the ordinary panel's own existing body/fieldset. This
      // opens real controls without a fake click or automatic focus change.
      for (let parent = target.parentElement; parent && parent !== wrapper; parent = parent.parentElement) {
        if (!['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) continue
        const box = target.getBoundingClientRect(), clip = parent.getBoundingClientRect()
        if (box.bottom > clip.bottom - 6) parent.scrollTop += box.bottom - clip.bottom + 6
        else if (box.top < clip.top + 6) parent.scrollTop -= clip.top + 6 - box.top
      }
    }
    scheduled = requestAnimationFrame(ensureVisible)
    const observer = new ResizeObserver(() => { cancelAnimationFrame(scheduled); scheduled = requestAnimationFrame(ensureVisible) })
    const caption = document.querySelector('.mix-room__tutorial-caption')
    if (caption) observer.observe(caption)
    return () => { observer.disconnect(); cancelAnimationFrame(scheduled) }
  }, [tutorial.active, tutorial.visit, panel])

  const choose = useCallback(panel => { setFocused(null); setManual({ visit: tutorial.visit, panel }) }, [tutorial.visit])
  return {
    panel, recommended,
    deferred: tutorial.active && panel !== recommended && Boolean(recommended),
    choose,
  }
}
