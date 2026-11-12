import test from 'node:test'
import assert from 'node:assert/strict'
import { fitRoomViewport, fullscreenRoomFov, roomCameraPosition, ROOM_VIEW } from './roomViewport.js'
import { PerspectiveCamera, Vector3 } from 'three'

test('the whole composition fits portrait, landscape, tablet, and desktop viewports', () => {
  for (const [width, height] of [[320, 568], [390, 844], [430, 932], [844, 390], [1024, 768], [1440, 900], [400, 250]]) {
    const fitted = fitRoomViewport(width, height)
    assert.ok(fitted.width <= width + 1e-10 && fitted.height <= height + 1e-10)
    assert.ok(Math.abs(fitted.width / fitted.height - ROOM_VIEW.aspect) < 1e-10)
    assert.ok(Math.abs(fitted.width - width) < 1e-10 || Math.abs(fitted.height - height) < 1e-10)
  }
  assert.deepEqual(fitRoomViewport(0, 0), { width: 0, height: 0 })
})

test('the fitted perspective camera contains the entire room bounds at every aspect', () => {
  for (const aspect of [0.5, 1, ROOM_VIEW.aspect, 2.2]) {
    const [, cameraY, cameraZ] = roomCameraPosition(aspect)
    for (const x of [-5, 5]) for (const y of [ROOM_VIEW.bottom, ROOM_VIEW.top]) for (const z of [-5, ROOM_VIEW.front]) {
      const halfHeight = (cameraZ - z) * Math.tan(ROOM_VIEW.fov * Math.PI / 360)
      assert.ok(Math.abs(x) < halfHeight * aspect)
      assert.ok(Math.abs(y - cameraY) < halfHeight)
    }
  }
})

test('landscape fullscreen keeps perspective and horizontal framing as browser chrome and orientation change', () => {
  const positions = [[-5, -3, -5], [5, 2, -5], [-3, 0, 1], [2, 1, -2]]
  let reference
  for (const aspect of [16 / 10, 660 / 393, 844 / 390, 852 / 320, 932 / 430]) {
    const camera = new PerspectiveCamera(fullscreenRoomFov(aspect), aspect, .1, 1000)
    camera.position.set(...roomCameraPosition())
    camera.lookAt(0, ROOM_VIEW.centerY, 0)
    camera.updateMatrixWorld()
    const points = positions.map(position => new Vector3(...position).project(camera))
    if (reference) points.forEach((point, index) => {
      assert.ok(Math.abs(point.x - reference[index].x) < 1e-10)
      // In screen pixels, x/y share one scale: shapes retain their proportions.
      assert.ok(Math.abs(point.y / aspect - reference[index].y / ROOM_VIEW.aspect) < 1e-10)
    })
    else reference = points
  }
  for (const aspect of [undefined, 0, NaN, Infinity]) assert.ok(Math.abs(fullscreenRoomFov(aspect) - ROOM_VIEW.fov) < 1e-10)
})
