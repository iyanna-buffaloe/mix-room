import test from 'node:test'
import assert from 'node:assert/strict'
import { getBubbleActivation, getBubbleVisibility, smoothLoudness, depthOpacity } from './audioVisuals.js'

test('quiet spill stays dim while moderate hits reach full brightness', () => {
  assert.equal(getBubbleActivation(0.03), 0)
  assert.equal(getBubbleActivation(0.4), 1)
  assert.equal(getBubbleActivation(0.8), 1)
  assert.ok(getBubbleActivation(0.35) > 0.9)
})

test('activation remains bounded and increases with signal', () => {
  const levels = [-1, 0, 0.05, 0.1, 0.2, 0.3, 0.4, 1, 2].map(getBubbleActivation)
  assert.ok(levels.every(level => level >= 0 && level <= 1))
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b))
})

test('short hits respond quickly and decay more gradually', () => {
  const attack = smoothLoudness(0, 1, 0.05)
  const release = smoothLoudness(1, 0, 0.05)
  assert.ok(attack > 0.85)
  assert.ok(release > 0.65)
})

test('animation timing is consistent across display refresh rates', () => {
  for (const target of [0, 1]) {
    const simulate = rate => {
      let level = 1 - target
      for (let i = 0; i < rate / 10; i++) {
        level = smoothLoudness(level, target, 1 / rate)
      }
      return level
    }
    assert.ok(Math.abs(simulate(30) - simulate(60)) < 1e-9)
    assert.ok(Math.abs(simulate(60) - simulate(120)) < 1e-9)
  }
})

test('silent parts disappear and audible parts become fully visible quickly', () => {
  assert.equal(getBubbleVisibility(0), 0)
  assert.equal(getBubbleVisibility(0.03), 0)
  assert.equal(getBubbleVisibility(0.08), 0)
  assert.ok(getBubbleVisibility(0.1) > 0 && getBubbleVisibility(0.1) < 1)
  assert.equal(getBubbleVisibility(0.12), 1)
  assert.equal(getBubbleVisibility(0.4), 1)
})

test('a brief hit appears promptly and its release eventually hides it', () => {
  for (const rate of [30, 60, 120]) {
    let loudness = 0
    for (let frame = 0; frame < rate / 20; frame++) {
      loudness = smoothLoudness(loudness, 0.2, 1 / rate)
    }
    assert.equal(getBubbleVisibility(loudness), 1)
    for (let frame = 0; frame < rate / 2; frame++) {
      loudness = smoothLoudness(loudness, 0, 1 / rate)
    }
    assert.equal(getBubbleVisibility(loudness), 0)
  }
})

test('activity sensitivity reveals quiet parts earlier while silence remains hidden', () => {
  assert.equal(getBubbleVisibility(0.07), 0)
  assert.equal(getBubbleVisibility(0.07, { activitySensitivity: 2 }), 1)
  assert.equal(getBubbleVisibility(0.14, { activitySensitivity: 0.5 }), 0)
  assert.equal(getBubbleActivation(0.2, { activitySensitivity: 2 }), 1)
  for (const activitySensitivity of [0.5, 1, 2]) {
    assert.equal(getBubbleVisibility(0, { activitySensitivity }), 0)
    assert.equal(getBubbleActivation(0, { activitySensitivity }), 0)
  }
})

test('optional depth transparency fades front layers without changing default visibility', () => {
  const options = { depthTransparency: true }
  assert.equal(depthOpacity(1), 1)
  assert.ok(depthOpacity(-4, options) > depthOpacity(-1, options))
  assert.ok(depthOpacity(-1, options) > depthOpacity(2, options))
  assert.equal(getBubbleVisibility(0) * depthOpacity(2, options), 0)
  assert.equal(depthOpacity(99, options), depthOpacity(2, options))
})
