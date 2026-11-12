import { useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { Color } from 'three'
import { fitRoomViewport, fullscreenRoomFov, roomCameraPosition, ROOM_COMPACT_QUERY, ROOM_VIEW } from './roomViewport.js'


export function RoomViewport({ containerRef, contained = false, fill = false, children }) {
  const [size, setSize] = useState({ width: 0, height: 0, compact: false })
  const scheduled = useRef(null)
  useEffect(() => {
    const container = containerRef.current
    const mobile = window.matchMedia(ROOM_COMPACT_QUERY)
    const update = (width, height) => {
      const compact = contained || mobile.matches
      const next = { ...(compact && !fill ? fitRoomViewport(width, height) : { width, height }), compact }
      setSize(previous => previous.compact === next.compact && Math.abs(previous.width - next.width) < 0.1 && Math.abs(previous.height - next.height) < 0.1 ? previous : next)
    }
    const measure = () => {
      const style = getComputedStyle(container)
      update(container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
    }
    measure()
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(scheduled.current)
      scheduled.current = requestAnimationFrame(() => update(entry.contentRect.width, entry.contentRect.height))
    })
    observer.observe(container)
    mobile.addEventListener('change', measure)
    return () => { observer.disconnect(); mobile.removeEventListener('change', measure); cancelAnimationFrame(scheduled.current) }
  }, [containerRef, contained, fill])
  return <div className="mix-room__viewport" style={{ width: size.width || '100%', height: size.height || '100%' }}>{children}</div>
}

export function RoomCamera({ fit = false, fullscreenLandscape = false }) {
  const { camera, size, invalidate } = useThree()
  useEffect(() => {
    const aspect = size.width / size.height || ROOM_VIEW.aspect
    camera.position.set(...(fullscreenLandscape ? roomCameraPosition() : fit ? roomCameraPosition(aspect) : [0, 0, 8]))
    camera.fov = fullscreenLandscape ? fullscreenRoomFov(aspect) : ROOM_VIEW.fov
    camera.lookAt(0, fit ? ROOM_VIEW.centerY : 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [camera, size.width, size.height, invalidate, fit, fullscreenLandscape])
  return null
}

// CSS is also the source of the rendered/exported background. Observe palette
// edits so Vite's stylesheet refresh changes the room without replacing audio.
export function RoomBackground({ color: background }) {
  const { scene, gl, invalidate } = useThree()
  useEffect(() => {
    let scheduled
    const apply = () => {
      const cssColor = background || getComputedStyle(gl.domElement).getPropertyValue('--canvas-background').trim()
      if (!cssColor) return
      const color = new Color(cssColor)
      if (scene.background?.isColor && scene.background.equals(color)) return
      scene.background = color
      invalidate()
    }
    const schedule = () => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(apply)
    }
    apply()
    const observer = new MutationObserver(schedule)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => { observer.disconnect(); cancelAnimationFrame(scheduled) }
  }, [scene, gl, invalidate, background])
  return null
}
