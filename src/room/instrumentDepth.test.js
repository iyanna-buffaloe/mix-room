import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutInstrumentDepth, DEPTH_LAYOUT } from './instrumentDepth.js'

const instrument = (key, avgLoudness, extra = {}) => ({ key, avgLoudness, baseX: 0, baseY: 0, baseZ: 1, pan: 0, width: 0, radius: 0.8, ...extra })

test('relative depth uses more of the room while retaining loudness order and measured data', () => {
  const source = [instrument('quiet', 0.1), instrument('medium', 0.2), instrument('loud', 0.4)]
  const placed = layoutInstrumentDepth(source)
  assert.equal(placed[0].baseZ, DEPTH_LAYOUT.back)
  assert.equal(placed[2].baseZ, DEPTH_LAYOUT.front)
  assert.ok(placed[0].baseZ < placed[1].baseZ && placed[1].baseZ < placed[2].baseZ)
  assert.deepEqual(placed.map(({ baseZ, ...rest }) => rest), source.map(({ baseZ, ...rest }) => rest))
  assert.ok(source.every(item => item.baseZ === 1))
})

test('coincident equal-level instruments separate in depth deterministically', () => {
  const source = ['ride', 'hihat', 'crash'].map(key => instrument(key, 0.2))
  const placed = layoutInstrumentDepth(source)
  const depths = placed.map(item => item.baseZ).sort((a, b) => a - b)
  assert.ok(depths[1] - depths[0] >= 1.6)
  assert.ok(depths[2] - depths[1] >= 1.6)
  const reverse = layoutInstrumentDepth([...source].reverse())
  for (const item of placed) assert.equal(item.baseZ, reverse.find(other => other.key === item.key).baseZ)
})

test('crowded and missing-level mixes remain finite, bounded, and ordered', () => {
  const source = Array.from({ length: 32 }, (_, i) => instrument(`part-${i}`, i / 100))
  const placed = layoutInstrumentDepth(source)
  assert.ok(placed.every(item => Number.isFinite(item.baseZ) && item.baseZ >= DEPTH_LAYOUT.back && item.baseZ <= DEPTH_LAYOUT.front))
  assert.ok(placed.every((item, i) => !i || item.baseZ >= placed[i - 1].baseZ))
  assert.deepEqual(layoutInstrumentDepth([]), [])
  assert.equal(layoutInstrumentDepth([instrument('single', NaN)])[0].baseZ, 0)
})


test('spacing accounts for heights and pan positions clamped by the room', () => {
  const placed = layoutInstrumentDepth([
    instrument('a', 0.2, { baseY: 2, baseX: 10 }),
    instrument('b', 0.2, { baseY: 7, baseX: 20 }),
  ])
  assert.ok(Math.abs(placed[0].baseZ - placed[1].baseZ) >= 1.6)
})

test('scaling every stem equally retains the relative depth layout', () => {
  const source = [instrument('a', 0.1), instrument('b', 0.2), instrument('c', 0.4)]
  const original = layoutInstrumentDepth(source)
  const scaled = layoutInstrumentDepth(source.map(item => ({ ...item, avgLoudness: item.avgLoudness * 2 })))
  assert.deepEqual(original.map(item => item.baseZ), scaled.map(item => item.baseZ))
})

test('measured RMS keeps a weak residual behind music even when its normalized activity is higher', () => {
  const placed = layoutInstrumentDepth([
    instrument('residual', .65, { rms: .0006 }),
    instrument('guitar', .55, { rms: .04 }),
    instrument('vocals', .3, { rms: .03 }),
  ])
  const depth = key => placed.find(i => i.key === key).baseZ
  assert.ok(depth('residual') < depth('vocals'))
  assert.ok(depth('vocals') < depth('guitar'))
  const scaled = layoutInstrumentDepth(placed.map(i => ({ ...i, rms: i.rms * .5 })))
  assert.deepEqual(placed.map(i => i.baseZ), scaled.map(i => i.baseZ))
})

test('partial legacy metadata uses one consistent fallback instead of mixing RMS and percentages', () => {
  const parts = [instrument('a', .2, { rms: .001 }), instrument('b', .4)]
  const placed = layoutInstrumentDepth(parts)
  const legacy = layoutInstrumentDepth(parts.map(({ rms: _rms, ...rest }) => rest))
  assert.deepEqual(placed.map(i => i.baseZ), legacy.map(i => i.baseZ))
})
