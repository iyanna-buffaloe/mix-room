import { useEffect, useReducer, useRef } from 'react'
import { INITIAL_TUTORIAL, tutorialCueAt, tutorialReducer } from '../demo/demoTutorial.js'

export function useDemoTutorial(audioRef, isDemo, workspaceView, busy) {
  const [state, dispatch] = useReducer(tutorialReducer, INITIAL_TUTORIAL)
  const generation = useRef(0)
  const clock = useRef({ previous: 0, holdEnding: false })
  const active = state.active && isDemo && ['playing', 'instruments', 'editor', 'settings'].includes(workspaceView) && !busy
  const stop = () => { generation.current++; dispatch({ type: 'stop' }) }

  // Called directly from the Load/Replay gesture, after the demo audio is mounted.
  const start = () => {
    const audio = audioRef.current
    if (!audio) return
    const run = ++generation.current
    clock.current = { previous: 0, holdEnding: false }
    dispatch({ type: 'start' })
    audio.currentTime = 0
    const blocked = error => {
      if (error?.name === 'NotAllowedError' && generation.current === run) dispatch({ type: 'blocked' })
    }
    try { Promise.resolve(audio.play()).catch(blocked) } catch (error) { blocked(error) }
  }

  useEffect(() => {
    if (state.active && !active) dispatch({ type: 'stop' })
  }, [state.active, active])

  useEffect(() => {
    if (!active) return
    const audio = audioRef.current
    let scheduled
    let previousCue
    const update = () => {
      const time = audio.currentTime
      // Looping the music is independent of explicitly replaying the guide.
      // A real Seek gesture below releases this ending hold, including a
      // deliberate backward seek from the very end of a looping song.
      if (audio.loop && clock.current.previous > audio.duration - .5 && time < .5) clock.current.holdEnding = true
      clock.current.previous = time
      const guideTime = clock.current.holdEnding ? audio.duration : time
      const cue = tutorialCueAt(guideTime)
      if (cue === previousCue) return
      previousCue = cue
      dispatch({ type: 'time', time: guideTime })
    }
    const frame = () => { update(); scheduled = requestAnimationFrame(frame) }
    const playing = () => dispatch({ type: 'playing' })
    // Account and save dialogs keep their ordinary focus behavior and end the guide.
    const modalFocus = event => { if (event.target.closest('dialog[open]')) dispatch({ type: 'stop' }) }
    for (const name of ['seeking', 'seeked', 'timeupdate', 'loadedmetadata']) audio.addEventListener(name, update)
    audio.addEventListener('playing', playing)
    document.addEventListener('focusin', modalFocus)
    scheduled = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(scheduled)
      for (const name of ['seeking', 'seeked', 'timeupdate', 'loadedmetadata']) audio.removeEventListener(name, update)
      audio.removeEventListener('playing', playing)
      document.removeEventListener('focusin', modalFocus)
    }
  }, [active, audioRef])

  const seek = time => { clock.current = { previous: time, holdEnding: false }; dispatch({ type: 'time', time }) }
  return { ...state, active, cue: active ? state.cue : null, start, stop, seek }
}
