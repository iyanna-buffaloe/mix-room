import test from 'node:test'
import assert from 'node:assert/strict'
import { Group, PerspectiveCamera, SphereGeometry, Vector3 } from 'three'
import { createFixedLabelLayout } from './fixedLabelLayout.js'

function fixture(panPosition = 0) {
  const scene = new Group()
  const camera = new PerspectiveCamera(50, 1.6, 0.1, 100)
  camera.position.set(0, 0, 8)
  const entries = ['bass', 'guitar', 'toms'].map((key, i) => {
    const parent = new Group(), anchor = new Group()
    scene.add(parent); parent.add(anchor)
    parent.position.set(panPosition, i * 0.5 - 0.5, -i)
    const label = key.toUpperCase(), fontSize = 0.32
    return [key, { anchor, centerWorld: parent.position.clone(), layoutCenterWorld: new Vector3(0, parent.position.y, parent.position.z), referencePanBias: 0,
      label, fontSize, radiusX: 2, radiusY: 0.8, panBias: 0,
      text: { fillOpacity: 1, textRenderInfo: { parameters: { text: label, fontSize }, blockBounds: [-0.5, -0.18, 0.5, 0.18] } },
      note: key === 'toms' ? { visible: false } : null }]
  })
  const positions = () => entries.map(([, entry]) => entry.anchor.getWorldPosition(new Vector3()).toArray())
  return { entries, camera, positions }
}

function assertPositions(actual, expected) {
  actual.forEach((point, i) => point.forEach((value, axis) => assert.ok(Math.abs(value - expected[i][axis]) < 1e-12)))
}

function planeOffsets({ entries, camera }) {
  const eye = camera.getWorldPosition(new Vector3())
  return entries.map(([, entry]) => {
    const point = entry.anchor.getWorldPosition(new Vector3())
    return eye.clone().lerp(point, (entry.centerWorld.z - eye.z) / (point.z - eye.z)).sub(entry.centerWorld).toArray()
  })
}

test('each label stays within its own ball through hard pan changes, fading and reappearing', () => {
  const { entries, camera, positions } = fixture()
  const apply = createFixedLabelLayout()
  assert.equal(apply(entries, camera, 960, 600), true)
  for (const pan of [-4, 4, 0, 2, -2]) {
    for (const [, entry] of entries) {
      entry.anchor.parent.position.x = pan
      entry.centerWorld.x = pan
      entry.anchor.parent.visible = pan !== 0
      entry.text.fillOpacity = pan > 0 ? 1 : 0
      entry.panBias = Math.sign(pan)
      if (entry.note) entry.note.visible = pan > 0
    }
    apply(entries, camera, 960, 600)
    positions().forEach((position, index) => {
      const entry = entries[index][1]
      assert.ok(Math.abs(position[0] - pan) < entry.radiusX)
      assert.ok(Math.abs(position[1] - entry.centerWorld.y) < entry.radiusY)
      if (pan) assert.equal(Math.sign(position[0] - pan), Math.sign(pan))
    })
  }
})

test('initial placement is independent of the playback pan when the mix is opened', () => {
  const left = fixture(-4), right = fixture(4)
  createFixedLabelLayout()(left.entries, left.camera, 960, 600)
  createFixedLabelLayout()(right.entries, right.camera, 960, 600)
  assertPositions(planeOffsets(left), planeOffsets(right))
})

test('a gliding label moves continuously while settled neighboring labels remain fixed', () => {
  const { entries, camera, positions } = fixture()
  const apply = createFixedLabelLayout()
  apply(entries, camera, 960, 600)
  const original = positions(), moving = entries[1][1]
  let previous = -Infinity
  for (let index = 0; index <= 40; index++) {
    const pan = -1 + index / 20
    moving.anchor.parent.position.x = pan * 3
    moving.centerWorld.x = pan * 3
    moving.panBias = pan
    apply(entries, camera, 960, 600)
    const current = positions()
    assert.ok(current[1][0] >= previous)
    if (Number.isFinite(previous)) assert.ok(current[1][0] - previous < .3)
    previous = current[1][0]
    assertPositions([current[0], current[2]], [original[0], original[2]])
  }
  const settled = positions()
  for (let index = 0; index < 20; index++) apply(entries, camera, 960, 600)
  assertPositions(positions(), settled)
})

test('waits for matching measured text before displaying the first placement', () => {
  const { entries, camera } = fixture()
  const apply = createFixedLabelLayout(), info = entries[1][1].text.textRenderInfo
  entries[1][1].text.textRenderInfo = null
  assert.equal(apply(entries, camera, 960, 600), false)
  entries[1][1].text.textRenderInfo = { ...info, parameters: { ...info.parameters, text: 'OLD NAME' } }
  assert.equal(apply(entries, camera, 960, 600), false)
  entries[1][1].text.textRenderInfo = { ...info, parameters: { ...info.parameters, fontSize: 0.4 } }
  assert.equal(apply(entries, camera, 960, 600), false)
  entries[1][1].text.textRenderInfo = info
  assert.equal(apply(entries, camera, 960, 600), true)
})

test('font edits and viewport changes preserve neighbors’ reserved placements and settle exactly', () => {
  const f = fixture(), { entries, camera, positions } = f
  const apply = createFixedLabelLayout()
  apply(entries, camera, 960, 600)
  const original = planeOffsets(f)
  entries[1][1].label = 'ELECTRIC GUITAR'
  entries[1][1].text.textRenderInfo = null
  entries[1][1].fontSize = 0.416
  camera.aspect = 0.5
  camera.position.z = 12
  camera.updateProjectionMatrix()
  assert.equal(apply(entries, camera, 390, 780), true)
  const offsets = planeOffsets(f)
  assertPositions([offsets[0], offsets[2]], [original[0], original[2]])
  const settled = positions()
  apply(entries, camera, 390, 780)
  assertPositions(positions(), settled)
})

test('an off-center wide guitar label fits inside the projected oval, including its corners', () => {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const geometry = new SphereGeometry(1, 64, 32), vertices = geometry.getAttribute('position')
  for (const side of [-1, 1]) {
    const f = fixture(side * 3.2), entry = f.entries[1][1]
    entry.panBias = side; entry.radiusX = 2.6
    entry.text.textRenderInfo.blockBounds = [-.9, -.2, .9, .2]
    createFixedLabelLayout()(f.entries, f.camera, 1246, 606)
    const points = Array.from({ length: vertices.count }, (_, index) => new Vector3().fromBufferAttribute(vertices, index).multiply(new Vector3(entry.radiusX, entry.radiusY, entry.radiusY)).add(entry.centerWorld).project(f.camera)).sort((a, b) => a.x - b.x || a.y - b.y)
    const hull = []
    for (const point of points) { while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop(); hull.push(point) }
    const lower = hull.length
    for (const point of points.toReversed()) { while (hull.length > lower && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop(); hull.push(point) }
    hull.pop()
    for (const x of [-.9, .9]) for (const y of [-.2, .2]) {
      const corner = entry.anchor.localToWorld(new Vector3(x, y, 0)).project(f.camera)
      for (let index = 0; index < hull.length; index++) assert.ok(cross(hull[index], hull[(index + 1) % hull.length], corner) >= -1e-8, 'Text corner escaped the actual projected oval')
    }
  }
  geometry.dispose()
})

test('a new mix gets a fresh plan, with room reserved for notes even when silent', () => {
  const before = fixture(), after = fixture()
  after.entries[2][1].note.visible = true
  createFixedLabelLayout()(before.entries, before.camera, 960, 600)
  createFixedLabelLayout()(after.entries, after.camera, 960, 600)
  assertPositions(before.positions(), after.positions())
  after.entries[1][1].centerWorld.x = 3
  createFixedLabelLayout()(after.entries, after.camera, 960, 600)
  assert.ok(Math.abs(before.positions()[1][0] - after.positions()[1][0]) > 1)
})
