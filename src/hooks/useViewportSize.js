import { useEffect, useState } from 'react'

export function getVisibleViewport(view = window) {
  const visual = view.visualViewport
  // Pinch zoom should magnify the interface, not rearrange it as a tiny form.
  const unzoomed = visual && Math.abs(visual.scale - 1) < 0.001
  const height = Math.round(unzoomed && visual.height > 0 ? visual.height : view.innerHeight)
  return {
    width: view.innerWidth,
    height,
    offsetTop: Math.round(unzoomed && Number.isFinite(visual.offsetTop) ? Math.max(0, visual.offsetTop) : 0),
    portrait: view.innerWidth < view.innerHeight,
    keyboard: Boolean(unzoomed && view.innerHeight - height > 120),
  }
}

export function useViewportSize() {
  const [size, setSize] = useState(getVisibleViewport)
  useEffect(() => {
    const root = document.documentElement
    const previous = root.style.getPropertyValue('--room-visible-height')
    const previousTop = root.style.getPropertyValue('--room-visible-top')
    let scheduled
    const update = () => {
      const next = getVisibleViewport()
      root.style.setProperty('--room-visible-height', `${next.height}px`)
      root.style.setProperty('--room-visible-top', `${next.offsetTop}px`)
      setSize(value => Object.keys(next).every(key => value[key] === next[key]) ? value : next)
    }
    const schedule = () => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      cancelAnimationFrame(scheduled)
      if (previous) root.style.setProperty('--room-visible-height', previous)
      else root.style.removeProperty('--room-visible-height')
      if (previousTop) root.style.setProperty('--room-visible-top', previousTop)
      else root.style.removeProperty('--room-visible-top')
    }
  }, [])
  return size
}
