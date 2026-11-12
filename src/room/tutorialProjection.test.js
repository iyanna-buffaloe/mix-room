import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PerspectiveCamera, Object3D, Vector3 } from 'three'
import { projectTutorialTarget, tutorialCaptionPosition } from './tutorialProjection.js'

function fixture() {
  const camera = new PerspectiveCamera(90, 1, .1, 100)
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const text = new Object3D()
  text.position.set(1.5, .8, .4); text.updateMatrixWorld(true)
  text.textRenderInfo = { blockBounds: [-.4, -.15, .4, .15] }
  const entry = { visible: true, centerWorld: new Vector3(), radiusX: 1, radiusY: 1, text, showLabel: false, anchor: { visible: true } }
  return { camera, entry }
}

test('opening uses the perspective silhouette, with correct resize and moving-center projection', () => {
  const { camera, entry } = fixture()
  const target = projectTutorialTarget(entry, camera, 200, 200)
  const radius = 100 / Math.sqrt(24)
  assert.ok(Math.abs(target.bounds.left - (100 - radius)) < .01)
  assert.ok(Math.abs(target.bounds.right - (100 + radius)) < .01)
  const resized = projectTutorialTarget(entry, camera, 400, 400)
  assert.ok(Math.abs(resized.bounds.right - target.bounds.right * 2) < .01)
  entry.centerWorld.x = -1
  assert.ok(projectTutorialTarget(entry, camera, 200, 200).bounds.left < target.bounds.left)
})

test('label opening follows the actual text transform and preserves silent shape geometry while respecting hidden labels', () => {
  const { camera, entry } = fixture()
  entry.showLabel = true
  const shown = projectTutorialTarget(entry, camera, 200, 200)
  assert.ok(shown.label.startsWith('M'))
  entry.text.position.x += 1
  const moved = projectTutorialTarget(entry, camera, 200, 200)
  assert.notEqual(moved.label, shown.label)
  assert.ok(moved.bounds.right > shown.bounds.right)
  entry.anchor.visible = false
  assert.equal(projectTutorialTarget(entry, camera, 200, 200).label, '')
  entry.visible = false
  assert.ok(projectTutorialTarget(entry, camera, 200, 200).shape.startsWith('M'))
  entry.anchor.visible = true
  assert.ok(projectTutorialTarget(entry, camera, 200, 200).label.startsWith('M'))
})

test('caption chooses clear room space while leaving the bottom transport area free', () => {
  const position = tutorialCaptionPosition([{ left: 0, top: 0, right: 300, bottom: 200 }], 800, 400, 280, 140)
  assert.deepEqual(position, [508, 12])
  assert.ok(position[1] + 140 <= 300)
})
