import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeInstruments } from './instrumentSetup.js'

const demoDirectory = new URL('../demo/nin-1000000/', import.meta.url)
const metadata = JSON.parse(readFileSync(new URL('instrument_meta.json', demoDirectory)))
const frames = Object.fromEntries(metadata.instruments.map(instrument => [
  instrument.key, JSON.parse(readFileSync(new URL(`${instrument.key}_frames.json`, demoDirectory))),
]))
const getFrames = key => frames[key]

test('NIN presentation adjusts only four labels when the caller selects the demo overrides', () => {
  const generic = makeInstruments(metadata, getFrames)
  const demo = makeInstruments(metadata, getFrames, metadata.presentation.labels)
  assert.equal(demo.length, 15)
  assert.deepEqual(demo.filter(instrument => instrument.labelScale !== 1).map(instrument => instrument.key), [
    'guitar', 'guitar_2', 'lead_vocals', 'backing_vocals',
  ])
  assert.ok(generic.every(instrument => instrument.labelScale === 1))
  assert.deepEqual(demo.filter(instrument => instrument.panMotion.enabled).map(instrument => instrument.key), [
    'guitar_2', 'rozz_2', 'lead_vocals',
  ])
  for (let index = 0; index < demo.length; index++) {
    assert.deepEqual({ ...demo[index], labelScale: 1 }, generic[index])
  }
  const vocals = demo.find(instrument => instrument.key === 'lead_vocals')
  assert.equal(vocals.width, 0.001)
  assert.equal(vocals.panMotion.enabled, true)
  assert.equal(vocals.label, 'LEAD\nVOCALS')
  assert.equal(vocals.displayName, 'Lead vocals')
})

test('optional label wrapping preserves generic names, shape and motion', () => {
  const generic = makeInstruments(metadata, getFrames)
  const customized = makeInstruments(metadata, getFrames, { guitar: { text: 'GUITAR 1', scale: 0.9 } })
  const guitar = customized.find(instrument => instrument.key === 'guitar')
  assert.equal(guitar.label, 'GUITAR 1')
  assert.equal(guitar.labelScale, 0.9)
  assert.equal(guitar.displayName, 'Guitar 1')
  assert.deepEqual(customized.filter(instrument => instrument.key !== 'guitar'), generic.filter(instrument => instrument.key !== 'guitar'))
  assert.equal(metadata.instruments.find(instrument => instrument.key === 'guitar').label, 'Guitar 1')
})

test('Demon Seed keeps its original drum stem and its own vocal presentation on one trimmed timeline', () => {
  const directory = new URL('../demo/nin-demon-seed/', import.meta.url)
  const song = JSON.parse(readFileSync(new URL('instrument_meta.json', directory)))
  const analysis = Object.fromEntries(song.instruments.map(instrument => [
    instrument.key, JSON.parse(readFileSync(new URL(`${instrument.key}_frames.json`, directory))),
  ]))
  const generic = makeInstruments(song, key => analysis[key])
  const demo = makeInstruments(song, key => analysis[key], song.presentation.labels)
  assert.equal(song.title, 'Demon Seed')
  assert.equal(demo.length, 13)
  assert.equal(demo.filter(instrument => instrument.key === 'drums').length, 1)
  assert.equal(demo.filter(instrument => ['kick', 'snare', 'toms', 'hihat', 'ride', 'crash'].includes(instrument.key)).length, 0)
  assert.deepEqual(demo.filter(instrument => instrument.labelScale !== 1).map(instrument => instrument.key), [
    'lead_vocals', 'backing_vocals', 'backing_vocals_2',
  ])
  assert.ok(generic.every(instrument => instrument.labelScale === 1))
  assert.equal(demo.find(instrument => instrument.key === 'guitar').labelScale, 1)
  assert.equal(demo.find(instrument => instrument.key === 'keys').panMotion.enabled, false)
  assert.equal(demo.find(instrument => instrument.key === 'keys').panMotion.range, 0.527)
  assert.equal(demo.find(instrument => instrument.key === 'drums').panMotion.enabled, false)
  for (const frames of Object.values(analysis)) {
    assert.equal(frames[0].t, 0)
    assert.ok(Math.abs(frames.at(-1).t - song.duration) < 1e-6)
    assert.equal(frames.at(-1).loud, 0)
    assert.ok(frames.every((frame, index) => Object.values(frame).every(Number.isFinite) && (!index || frame.t > frames[index - 1].t)))
  }
})
