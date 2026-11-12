import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIEW_SETTINGS, VIEW_SETTINGS_KEY, normalizeViewSettings, readViewSettings, writeViewSettings } from './viewSettings.js'

test('invalid or missing preferences restore the original display behavior', () => {
  for (const value of [null, undefined, [], 'bad', { activitySensitivity: NaN, labelScale: Infinity, panEnabled: 'false', loop: 1 }]) {
    assert.deepEqual(normalizeViewSettings(value), DEFAULT_VIEW_SETTINGS)
  }
})

test('saved preferences retain choices and bound sliders without accepting retired or unknown fields', () => {
  assert.deepEqual(normalizeViewSettings({ activitySensitivity: 8, labelScale: -5, showLabels: false, panEnabled: false, loop: true, hideInactive: false, apiKey: 'discard' }), {
    roomStyle: 'light', depthTransparency: true, activitySensitivity: 2, labelScale: 0.8, showLabels: false, panEnabled: false, loop: true,
  })
  assert.equal(normalizeViewSettings({ activitySensitivity: 0 }).activitySensitivity, 0.5)
  assert.equal(normalizeViewSettings({ labelScale: 10 }).labelScale, 1.3)
})

test('preferences round-trip and blocked or malformed storage leaves defaults usable', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const settings = { ...DEFAULT_VIEW_SETTINGS, activitySensitivity: 1.5, labelScale: 1.15, loop: true, panEnabled: false }
  writeViewSettings(storage, settings)
  assert.deepEqual(readViewSettings(storage), settings)
  values.set(VIEW_SETTINGS_KEY, '{broken')
  assert.deepEqual(readViewSettings(storage), DEFAULT_VIEW_SETTINGS)
  const blocked = { getItem() { throw new Error('Blocked') }, setItem() { throw new Error('Full') } }
  assert.deepEqual(readViewSettings(blocked), DEFAULT_VIEW_SETTINGS)
  assert.doesNotThrow(() => writeViewSettings(blocked, settings))
})

test('room styles persist and unknown styles fall back to light', () => {
  for (const roomStyle of ['light', 'dark', 'traditional']) {
    const values = new Map()
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
    writeViewSettings(storage, { ...DEFAULT_VIEW_SETTINGS, roomStyle })
    assert.equal(readViewSettings(storage).roomStyle, roomStyle)
  }
  assert.equal(normalizeViewSettings({ roomStyle: 'unknown' }).roomStyle, 'light')
})
