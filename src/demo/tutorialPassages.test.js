import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildTutorialPassages, inTutorialPassage } from './tutorialPassages.js'
const frames = key => JSON.parse(readFileSync(new URL(`./nin-demon-seed/${key}_frames.json`, import.meta.url)))

test('passages start at real activity, bridge brief rests and end before a later entrance', () => {
  const passages = buildTutorialPassages([{t:0,loud:0},{t:1,loud:.5},{t:1.1,loud:0},{t:2.2,loud:.5},{t:6,loud:.6}])
  assert.deepEqual(passages, [{start:1,end:2.3},{start:6,end:6.1}])
  assert.equal(inTutorialPassage(passages,.99), false)
  assert.equal(inTutorialPassage(passages,1.8), true)
  assert.equal(inTutorialPassage(passages,2.3), false)
  assert.equal(inTutorialPassage(passages,5), false)
})
test('the bundled drum/voice entrances are never spotlighted early, and guitar is gone by the observed departure', () => {
  const drums = buildTutorialPassages(frames('drums')), voice = buildTutorialPassages(frames('lead_vocals')), guitar = buildTutorialPassages(frames('guitar'))
  assert.equal(drums[0].start,.7)
  assert.equal(voice[0].start,44.6)
  assert.equal(inTutorialPassage(drums,0),false)
  assert.equal(inTutorialPassage(voice,44),false)
  assert.equal(inTutorialPassage(voice,45),true)
  assert.equal(inTutorialPassage(guitar,77),true)
  assert.equal(inTutorialPassage(guitar,79),false)
  assert.equal(inTutorialPassage(guitar,88),true)
})
test('real vocal rests stay inside passage envelopes rather than following frame visibility', () => {
  const data = frames('lead_vocals'), passages = buildTutorialPassages(data)
  assert.ok(data.some(frame => frame.t > 45 && frame.t < 53 && frame.loud <= .08 && inTutorialPassage(passages,frame.t)))
})
