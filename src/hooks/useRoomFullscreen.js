import { useEffect, useRef, useState } from 'react'
import { COPY } from '../config/siteCopy.js'
import { ROOM_COMPACT_QUERY } from '../room/roomViewport.js'
import { fullscreenElement, requestRoomFullscreen, exitRoomFullscreen } from '../room/fullscreen.js'

// ============================================================
// FULLSCREEN LIFECYCLE
// ============================================================
//
// Enter and leave fullscreen, whether the browser supports true fullscreen or
// the app has to fill the page instead. Reuse the same room and audio. On exit,
// restore scrolling, screen rotation and the button selected by the keyboard.

export function useRoomFullscreen(canvasContainerRef) {
  const fullscreenButtonRef = useRef(null)
  const exitFullscreenButtonRef = useRef(null)

  // Move the player buttons here in fullscreen, but leave the song itself in
  // the normal player so playback does not restart.
  const [fullscreenPlayerHost, setFullscreenPlayerHost] = useState(null)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [expandedCanvas, setExpandedCanvas] = useState(false)
  const [fullscreenExiting, setFullscreenExiting] = useState(false)
  const [fullscreenOrientation, setFullscreenOrientation] = useState('portrait')

  // The browser may take time to enter fullscreen or refuse it. Treat a room
  // filling the page as fullscreen too, so its controls work in either case.
  const isFullscreen = nativeFullscreen || expandedCanvas

  // Listen to the browser for actual fullscreen changes, including its own
  // Escape action. Safari uses a second event name for the same job.
  useEffect(() => {
    const syncFullscreen = () => {
      const active = fullscreenElement() === canvasContainerRef.current
      setNativeFullscreen(active)
      if (active) setExpandedCanvas(false)
      if (!active) setFullscreenExiting(false)
    }
    document.addEventListener('fullscreenchange', syncFullscreen)
    document.addEventListener('webkitfullscreenchange', syncFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      document.removeEventListener('webkitfullscreenchange', syncFullscreen)
    }
  }, [canvasContainerRef])

  // When filling the page instead of true fullscreen, stop page scrolling and
  // handle Escape ourselves. Put the previous scrolling setting back on exit.
  useEffect(() => {
    if (!expandedCanvas) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleEscape = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        exitFullscreenButtonRef.current?.click()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleEscape)
    }
  }, [expandedCanvas])

  // Select the Exit button for keyboard users on entry, then return to the
  // toolbar's fullscreen button on exit.
  useEffect(() => {
    if (!isFullscreen) return
    exitFullscreenButtonRef.current?.focus({ preventScroll: true })
    return () => fullscreenButtonRef.current?.focus({ preventScroll: true })
  }, [isFullscreen])

  // If the phone let us lock its screen rotation, release that lock on exit.
  // It is also fine if the phone never offered that option.
  useEffect(() => {
    if (!isFullscreen || !window.matchMedia(ROOM_COMPACT_QUERY).matches) return
    const orientation = window.screen.orientation
    return () => {
      try { orientation?.unlock?.() } catch { /* The room can still turn within the page. */ }
    }
  }, [isFullscreen])

  // ============================================================
  // ENTER, ROTATE AND LEAVE FULLSCREEN
  // ============================================================
  //
  // Start the room in the phone's current direction and close any typing keyboard.
  // Fill the page immediately while asking the browser for true fullscreen.
  // The rotation button can turn the room even if the phone cannot lock its screen.
  // Wait for the closing animation before leaving, unless reduced motion is enabled.

  const enterFullscreen = async () => {
    setFullscreenOrientation(window.matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait')

    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur()
    const container = canvasContainerRef.current

    // Show the larger room now, even if the browser later refuses true fullscreen.
    setExpandedCanvas(true)
    await requestRoomFullscreen(container)
  }

  const rotateFullscreen = async () => {
    const next = fullscreenOrientation === 'portrait' ? 'landscape' : 'portrait'
    setFullscreenOrientation(next)
    try {
      await window.screen.orientation?.lock?.(next)
    } catch {
      // If the browser cannot lock the screen, turn the room within the page instead.
    }
  }

  const exitFullscreen = async () => {
    // Ignore a second Exit click while the first one is still closing the room.
    if (fullscreenExiting) return
    setFullscreenExiting(true)
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await new Promise(resolve => window.setTimeout(resolve, 620))
    }
    if (fullscreenElement() === canvasContainerRef.current) {
      try {
        await exitRoomFullscreen()
      } catch (error) {
        console.error(COPY.unable_to_exit_fullscreen, error)
      }
    }
    // An immediate programmatic exit can beat the queued native-entry event.
    // Always clear the optimistic fallback flag as well as the native request.
    setExpandedCanvas(false)
    setFullscreenExiting(false)
  }

  return {
    fullscreenButtonRef, exitFullscreenButtonRef,
    fullscreenPlayerHost, setFullscreenPlayerHost,
    expandedCanvas, fullscreenExiting, fullscreenOrientation, isFullscreen,
    enterFullscreen, rotateFullscreen, exitFullscreen
  }
}
