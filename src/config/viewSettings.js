export const VIEW_SETTINGS_KEY = 'mix-room-view-settings'
export const DEFAULT_VIEW_SETTINGS = Object.freeze({
  activitySensitivity: 1,
  roomStyle: 'light',
  depthTransparency: true,
  panEnabled: true,
  showLabels: true,
  labelScale: 1,
  loop: false,
})

export function normalizeViewSettings(value) {
  const source = value && typeof value === 'object' ? value : {}
  const number = (key, min, max) => Number.isFinite(source[key]) ? Math.max(min, Math.min(max, source[key])) : DEFAULT_VIEW_SETTINGS[key]
  const boolean = key => typeof source[key] === 'boolean' ? source[key] : DEFAULT_VIEW_SETTINGS[key]
  return {
    roomStyle: ['light', 'dark', 'traditional'].includes(source.roomStyle) ? source.roomStyle : DEFAULT_VIEW_SETTINGS.roomStyle,
    activitySensitivity: number('activitySensitivity', 0.5, 2),
    depthTransparency: boolean('depthTransparency'),
    panEnabled: boolean('panEnabled'),
    showLabels: boolean('showLabels'),
    labelScale: number('labelScale', 0.8, 1.3),
    loop: boolean('loop'),
  }
}

export function readViewSettings(storage) {
  try { return normalizeViewSettings(JSON.parse(storage.getItem(VIEW_SETTINGS_KEY))) }
  catch { return { ...DEFAULT_VIEW_SETTINGS } }
}

export function writeViewSettings(storage, settings) {
  try { storage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(normalizeViewSettings(settings))) }
  catch { /* Settings still work for this session when storage is unavailable. */ }
}
