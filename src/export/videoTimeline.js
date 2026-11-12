import { smoothLoudness } from '../room/audioVisuals.js'
import { PAN_MOTION, panMotionAt, crossedPanJump } from '../room/panMotion.js'

// Match the user's preferred Song 2 reference, including its wide composition.
export const ROOM_VIDEO = Object.freeze({ width: 1246, height: 606, fps: 30, videoBitrate: 8_000_000, audioBitrate: 192_000 })

export function closestAnalysisFrame(frames, time) {
  if (!frames.length) return { loud: 0, pan: 0, kickBleed: 0 }
  let low = 0, high = frames.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (frames[middle].t < time) low = middle + 1
    else high = middle
  }
  const before = frames[Math.max(0, low - 1)], after = frames[low]
  return Math.abs(before.t - time) <= Math.abs(after.t - time) ? before : after
}

// Walk through analysis frames once, rather than search the whole song for
// each of the thousands of video frames.
export function createFrameSampler(frames, panMotion) {
  let index = 0
  let loud = 0
  let pan = 0, width
  let previousTime = -Infinity
  return (time, elapsed) => {
    if (!frames.length) return { loud: 0, kickBleed: 0 }
    const firstFrame = !Number.isFinite(previousTime)
    const seekingBack = time < previousTime
    const seeking = seekingBack || time - previousTime > Math.max(0.5, elapsed * 5)
    const panJump = crossedPanJump(panMotion, previousTime, time)
    if (seekingBack) { index = 0; loud = 0; width = undefined }
    previousTime = time
    while (index + 1 < frames.length && frames[index + 1].t <= time) index++
    const next = frames[index + 1]
    const closest = next && Math.abs(next.t - time) < Math.abs(frames[index].t - time) ? next : frames[index]
    loud = smoothLoudness(loud, closest.loud, Math.min(0.1, elapsed))
    const response = 1 - Math.exp(-Math.max(0, Math.min(0.1, elapsed)) / 0.12)
    if (panMotion) {
      const target = panMotionAt(panMotion, time)
      const motionResponse = 1 - Math.exp(-Math.max(0, Math.min(0.1, elapsed)) / PAN_MOTION.responseSeconds)
      pan = !panMotion.enabled || firstFrame || seeking || panJump || Math.abs(target - pan) <= PAN_MOTION.settleTolerance ? target : pan + (target - pan) * motionResponse
    } else {
      pan = seekingBack ? closest.pan ?? 0 : pan + ((closest.pan ?? 0) - pan) * response
    }
    if (Number.isFinite(closest.width)) width = width === undefined ? closest.width : width + (closest.width - width) * response
    return { loud, pan, ...(width !== undefined ? { width } : {}), kickBleed: closest.kickBleed ?? 0 }
  }
}

export function getExportSize() {
  return { width: ROOM_VIDEO.width, height: ROOM_VIDEO.height }
}

export function videoFilename(title, extension) {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'mix-room'
  return `${name}-mix-room.${extension}`
}
