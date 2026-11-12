// Revision3 uses the newly trimmed media clock. Only Volume45 is an
// explicit fixed boundary; the other existing sections shift with the cut.
export const DEMO_TUTORIAL_END = 165
export const DEMO_TUTORIAL_CUES = [
  {start:0,end:12,id:'intro',chapter:'Meet the room',targets:['drums'],veil:true,copy:'Each shape is a part of the song. Watch the drums light up when they play.',compactCopy:'Each shape is a part. Drums light up as they play.'},
  {start:12,end:45,id:'frequency',chapter:'Frequency',targets:['drums','bass'],veil:true,copy:'Deeper sounds sit lower. Brighter sounds sit higher. Compare the bass with the drums above it.',compactCopy:'Low bass. Brighter drums.'},
  {start:45,end:53,id:'volume',chapter:'Volume',targets:['guitar','lead_vocals'],veil:true,copy:'The louder guitar sits closer. The quieter voice sits farther back. Depth compares their overall levels.',compactCopy:'Overall, the louder guitar sits closer. The quieter voice sits farther back.'},
  {start:53,end:110,id:'panning',chapter:'Panning',targets:['bass','lead_vocals'],veil:true,copy:'The voice sits farther left than the bass because it is panned left. The shapes follow the sound.',compactCopy:'The voice sits farther left than the bass because it is panned left.'},
  {start:110,end:128,id:'visibility',chapter:'Visible instruments',targets:[],panel:'instruments',veil:true,copy:'Use Visible instruments to hide or show shapes. Their sound keeps playing.'},
  {start:128,end:145,id:'editor',chapter:'Editor',targets:[],panel:'editor',veil:true,copy:'Change an Instrument name, then choose Apply names to update its label.'},
  {start:145,end:165,id:'preferences',chapter:'Preferences',targets:[],panel:'settings',veil:true,copy:'Room style changes colours. Label size makes instrument names larger or smaller.'},
  {start:165,end:Infinity,id:'ending',chapter:'Your turn',targets:[],veil:false,upload:true,replay:true,copy:'Upload your own music, or play this song and guide again.'},
]

export function tutorialCueAt(time) {
  if (!Number.isFinite(time) || time < 0) return null
  return DEMO_TUTORIAL_CUES.find(cue => time >= cue.start && time < cue.end) ?? null
}

export const INITIAL_TUTORIAL = { active: false, cue: null, playbackBlocked: false, visit: 0 }
export function tutorialReducer(state, action) {
  if (action.type === 'start') return { active: true, cue: tutorialCueAt(0), playbackBlocked: false, visit: state.visit + 1 }
  if (action.type === 'stop') return state.active ? { ...INITIAL_TUTORIAL, visit: state.visit } : state
  if (!state.active) return state
  if (action.type === 'time') {
    const cue = tutorialCueAt(action.time)
    if (!cue) return INITIAL_TUTORIAL
    return cue === state.cue ? state : { ...state, cue, visit: state.visit + 1 }
  }
  if (action.type === 'blocked') return { ...state, playbackBlocked: true }
  if (action.type === 'playing' && state.playbackBlocked) return { ...state, playbackBlocked: false }
  return state
}
