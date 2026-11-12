import test from 'node:test'
import assert from 'node:assert/strict'
import { arrangeLabels, ellipsoidFrontDepth, labelPanBias } from './labelLayout.js'

function isInside(label, original) {
  const x = (Math.abs(label.x - original.x) + label.width / 2 + 4) / (original.radiusX * 0.9)
  const y = (Math.abs(label.y - original.y) + label.height / 2 + 4) / (original.radiusY * 0.9)
  return x ** 2 + y ** 2 <= 1.000001
}

test('pan bias sends moderately panned instruments close to their matching edge', () => {
  assert.equal(labelPanBias(0), 0)
  assert.equal(labelPanBias(0.004), 0)
  assert.equal(labelPanBias(0.06), 1)
  assert.equal(labelPanBias(-0.17), -1)
  assert.ok(labelPanBias(0.018) > 0 && labelPanBias(0.018) < 0.5)
})

test('labels stay inside their own instrument while separating a crowded group', () => {
  const originals = [
    { key: 'other', x: 200, y: 120, width: 62, height: 20, radiusX: 150, radiusY: 52, panBias: 1 },
    { key: 'lead', x: 205, y: 120, width: 60, height: 38, radiusX: 82, radiusY: 62, panBias: 0 },
    { key: 'backing', x: 198, y: 122, width: 72, height: 38, radiusX: 90, radiusY: 64, panBias: 0.24 },
  ]
  const placed = arrangeLabels(originals)
  for (const label of placed) assert.ok(isInside(label, originals.find(original => original.key === label.key)))
  assert.ok(placed.find(label => label.key === 'other').x > 280)
  assert.equal(placed.length, originals.length)
  assert.deepEqual(placed, arrangeLabels([...originals].reverse()))
})

test('an impossible collision stays attached to each instrument', () => {
  const labels = ['a', 'b'].map(key => ({ key, x: 100, y: 100, width: 54, height: 20, radiusX: 38, radiusY: 30, panBias: 0 }))
  const placed = arrangeLabels(labels)
  assert.ok(placed.every(label => Math.abs(label.x - 100) <= 7 && Math.abs(label.y - 100) <= 7))
})

test('a label follows the camera-facing surface of its own ellipsoid', () => {
  assert.equal(ellipsoidFrontDepth(0, 0, 2, 1, 0), 1)
  assert.equal(ellipsoidFrontDepth(2, 0, 2, 1, 0), 0)
  assert.equal(ellipsoidFrontDepth(0, 1, 2, 1, 0), 0)
  assert.ok(Math.abs(ellipsoidFrontDepth(1, 0, 2, 1, 0) - Math.sqrt(0.75)) < 1e-12)
})
