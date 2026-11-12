import test from 'node:test'
import assert from 'node:assert/strict'
import { fullscreenElement, requestRoomFullscreen, exitRoomFullscreen } from './fullscreen.js'

test('standard fullscreen requests hide browser navigation from the original click', async () => {
  let called = false
  const element = { requestFullscreen(options) { called = true; assert.equal(this, element); assert.deepEqual(options, { navigationUI: 'hide' }); return Promise.resolve() } }
  const result = requestRoomFullscreen(element)
  assert.ok(called)
  assert.ok(await result)
  assert.equal(fullscreenElement({ fullscreenElement: element }), element)
  let exited = false
  await exitRoomFullscreen({ exitFullscreen() { exited = true } })
  assert.ok(exited)
})

test('Safari prefixed entry, state, and exit work when standard fullscreen is absent', async () => {
  let entered = false, exited = false
  const element = { webkitRequestFullscreen() { entered = true; assert.equal(this, element) } }
  assert.ok(await requestRoomFullscreen(element))
  assert.ok(entered)
  assert.equal(fullscreenElement({ webkitFullscreenElement: element }), element)
  await exitRoomFullscreen({ webkitExitFullscreen() { exited = true } })
  assert.ok(exited)
})

test('unsupported or denied fullscreen falls back without an unhandled rejection', async () => {
  for (const element of [null, {}, { requestFullscreen: () => Promise.reject(new Error('Denied')) }, { webkitRequestFullscreen() { throw new Error('Denied') } }]) {
    assert.equal(await requestRoomFullscreen(element), false)
  }
  assert.equal(fullscreenElement({}), null)
})
