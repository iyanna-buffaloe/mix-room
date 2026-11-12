import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DEMO_TUTORIAL_CUES,INITIAL_TUTORIAL,tutorialCueAt,tutorialReducer} from './demoTutorial.js'
test('section boundaries follow the revised clock, with the explicit Volume45 override',()=>{
 for(const cue of DEMO_TUTORIAL_CUES){assert.equal(tutorialCueAt(cue.start),cue);if(Number.isFinite(cue.end)){assert.equal(tutorialCueAt(cue.end-.001),cue);assert.notEqual(tutorialCueAt(cue.end),cue)}}
 assert.equal(tutorialCueAt(44.99).chapter,'Frequency');assert.equal(tutorialCueAt(45).chapter,'Volume')
 assert.deepEqual(tutorialCueAt(53).targets,['bass','lead_vocals']);assert.equal(tutorialCueAt(165).veil,false)
 assert.ok(DEMO_TUTORIAL_CUES.every(cue=>!/[0-9]|seconds?/.test(cue.copy + (cue.compactCopy ?? ''))))
})
test('pause/buffering reuse cue state and explicit backward seeking returns from the ending',()=>{
 let state=tutorialReducer(INITIAL_TUTORIAL,{type:'start'});state=tutorialReducer(state,{type:'time',time:53});assert.equal(tutorialReducer(state,{type:'time',time:53}),state)
 state=tutorialReducer(state,{type:'time',time:250});assert.equal(state.cue.id,'ending');assert.equal(state.active,true)
 assert.equal(tutorialReducer(state,{type:'time',time:12}).cue.id,'frequency')
})
test('Skip remains unguided until explicit Replay',()=>{
 const stopped=tutorialReducer(tutorialReducer(INITIAL_TUTORIAL,{type:'start'}),{type:'stop'})
 assert.equal(tutorialReducer(stopped,{type:'time',time:45}),stopped);assert.equal(tutorialReducer(stopped,{type:'start'}).cue.start,0)
})
test('denied and late play results preserve the existing recovery/latch',()=>{
 const started=tutorialReducer(INITIAL_TUTORIAL,{type:'start'}),blocked=tutorialReducer(started,{type:'blocked'})
 assert.equal(blocked.active,true);assert.equal(tutorialReducer(blocked,{type:'playing'}).playbackBlocked,false);assert.equal(tutorialReducer(INITIAL_TUTORIAL,{type:'blocked'}),INITIAL_TUTORIAL)
})
