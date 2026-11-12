import { useEffect, useState } from 'react'
import { createFrameSampler } from '../export/videoTimeline.js'

// ============================================================
// LIVE AUDIO FRAME SAMPLING
// ============================================================
//
// Read the song's current time and find the audio measurements that make the
// bubbles move. This also works when seeking while paused. A new set of audio
// measurements starts fresh; making a video pauses this loop because the
// recorder chooses its own moments in the song.

export function useAudioFrame(audioRef, frames, enabled = true, panMotion) {
  const [frame, setFrame] = useState({ loud: 0, pan: 0, kickBleed: 0 })

  useEffect(() => {
    if (!enabled) return
    let raf
    let previousTime = performance.now()
    const sample = createFrameSampler(frames, panMotion)

    const update = (now) => {
      // After a background tab resumes, limit the jump so bubbles do not suddenly leap.
      const elapsed = Math.min(Math.max((now - previousTime) / 1000, 0), 0.1)
      previousTime = now
      if (audioRef.current && frames.length) {
        const t = audioRef.current.currentTime
        setFrame(sample(t, elapsed))
      }
      raf = requestAnimationFrame(update)
    }
    raf = requestAnimationFrame(update)

    // Stop the old loop when its audio data changes or this part of the app closes.
    return () => cancelAnimationFrame(raf)
  }, [audioRef, frames, enabled, panMotion])

  return frame
}
