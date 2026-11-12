import { useEffect, useState } from 'react'
import { DEFAULT_VIEW_SETTINGS, normalizeViewSettings, readViewSettings, writeViewSettings } from '../config/viewSettings.js'

export function useViewSettings() {
  const [settings, setSettings] = useState(() => {
    try { return readViewSettings(window.localStorage) }
    catch { return { ...DEFAULT_VIEW_SETTINGS } }
  })
  useEffect(() => {
    try { writeViewSettings(window.localStorage, settings) } catch { /* Optional browser storage. */ }
  }, [settings])
  return {
    settings,
    updateSetting: (key, value) => setSettings(previous => normalizeViewSettings({ ...previous, [key]: value })),
    resetSettings: () => setSettings({ ...DEFAULT_VIEW_SETTINGS }),
    restoreSettings: value => setSettings(normalizeViewSettings(value)),
  }
}
