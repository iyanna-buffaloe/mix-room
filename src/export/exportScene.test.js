import test from 'node:test'
import assert from 'node:assert/strict'
import { PerspectiveCamera } from 'three'
import { prepareExportScene } from './exportScene.js'

test('export has one camera and drawing buffer across desktop, phone, fullscreen and resize', () => {
  for (const [width, height, dpr] of [[390, 844, 3], [1440, 900, 1], [1920, 1080, 2]]) {
    let ratio = dpr
    const original = new PerspectiveCamera(45, width / height)
    original.position.set(0, -.5, 14)
    const frames = []
    const current = { size: { width, height }, viewport: { dpr } }
    const gl = {
      domElement: { width: width * dpr, height: height * dpr },
      getPixelRatio: () => ratio,
      setPixelRatio: value => { ratio = value },
      setSize(w, h, css) { assert.equal(css, false); this.domElement.width = w * ratio; this.domElement.height = h * ratio },
      render: (scene, camera) => frames.push({ camera, width: gl.domElement.width, height: gl.domElement.height, context: scene.userData.mixRoomExport }),
    }
    const state = { gl, scene: { userData: {} }, camera: original, get: () => current, advance() {} }
    const exported = prepareExportScene(state)
    exported.render(0)
    // A real browser resize during asynchronous encoding must not affect output.
    gl.domElement.width = 200; gl.domElement.height = 400
    current.size = { width: 800, height: 450 }; current.viewport.dpr = 2
    exported.render(1 / 30)
    for (const frame of frames) {
      assert.deepEqual([frame.width, frame.height], [1246, 606])
      assert.equal(frame.camera.aspect, 1246 / 606)
      assert.deepEqual(frame.camera.position.toArray(), [0, 0, 8])
      assert.equal(frame.context.camera, frame.camera)
    }
    assert.equal(state.camera, original)
    assert.deepEqual(original.position.toArray(), [0, -.5, 14])
    exported.restore()
    assert.deepEqual(gl.domElement, { width: 1600, height: 900 })
    assert.equal(ratio, 2)
    assert.equal(state.scene.userData.mixRoomExport, undefined)
  }
})
