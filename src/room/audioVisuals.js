import { DEPTH_LAYOUT } from './instrumentDepth.js'
// Lower FULL_ACTIVITY_LEVEL to make bubbles reach full brightness sooner.
export const ACTIVITY_FLOOR = 0.08
export const FULL_ACTIVITY_LEVEL = 0.4
// A narrow fade range makes audible parts fully visible quickly.
const FULL_VISIBILITY_LEVEL = 0.12
const ATTACK_SECONDS = 0.025
const RELEASE_SECONDS = 0.14

function sensitivityMultiplier(options) {
  const value = options?.activitySensitivity
  return Number.isFinite(value) ? Math.max(0.5, Math.min(2, value)) : 1
}

export function getBubbleActivation(loudness, options) {
  const signal = loudness * sensitivityMultiplier(options)
  const level = Math.max(0, Math.min(1,
    (signal - ACTIVITY_FLOOR) / (FULL_ACTIVITY_LEVEL - ACTIVITY_FLOOR),
  ))
  return level * level * (3 - 2 * level)
}

export function getBubbleVisibility(loudness, options) {
  const signal = loudness * sensitivityMultiplier(options)
  const level = Math.max(0, Math.min(1,
    (signal - ACTIVITY_FLOOR) / (FULL_VISIBILITY_LEVEL - ACTIVITY_FLOOR),
  ))
  return level * level * (3 - 2 * level)
}

export function smoothLoudness(current, target, elapsedSeconds) {
  const response = target > current ? ATTACK_SECONDS : RELEASE_SECONDS
  const amount = 1 - Math.exp(-Math.max(0, elapsedSeconds) / response)
  return current + (target - current) * amount
}

// Keep front layers readable while revealing the instruments behind them.
export function depthOpacity(z, options) {
  if (!options?.depthTransparency) return 1
  const fraction = Math.max(0, Math.min(1, (z - DEPTH_LAYOUT.back) / (DEPTH_LAYOUT.front - DEPTH_LAYOUT.back)))
  return 0.94 - 0.56 * fraction
}
