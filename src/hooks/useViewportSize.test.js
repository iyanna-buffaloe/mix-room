import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVisibleViewport } from './useViewportSize.js'

test('a phone keyboard reduces available height without changing portrait layout', () => {
  const size = getVisibleViewport({ innerWidth: 390, innerHeight: 844, visualViewport: { height: 350.4, offsetTop: 72.2, scale: 1 } })
  assert.equal(size.height, 350)
  assert.equal(size.offsetTop, 72)
  assert.equal(size.portrait, true)
  assert.equal(size.keyboard, true)
})

test('pinch zoom retains the layout and does not look like a keyboard opening', () => {
  const size = getVisibleViewport({ innerWidth: 390, innerHeight: 844, visualViewport: { height: 422, offsetTop: 200, scale: 2 } })
  assert.equal(size.height, 844)
  assert.equal(size.offsetTop, 0)
  assert.equal(size.keyboard, false)
})

test('ordinary browser chrome does not hide playback as if a keyboard were open', () => {
  assert.equal(getVisibleViewport({ innerWidth: 390, innerHeight: 844, visualViewport: { height: 790, scale: 1 } }).keyboard, false)
})

test('layout dimensions work without VisualViewport and after landscape rotation', () => {
  const size = getVisibleViewport({ innerWidth: 932, innerHeight: 430 })
  assert.equal(size.height, 430)
  assert.equal(size.offsetTop, 0)
  assert.equal(size.portrait, false)
  assert.equal(size.keyboard, false)
})
