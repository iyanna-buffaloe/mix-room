const operations=new Set(['mix_read','mix_upload','mix_commit','mix_rename','mix_delete','separation_request','separation_transition','paid_submission'])
const codes=new Set(['MIX_SERVICE_FAILED','MIX_CHANGED','STORAGE_LIMIT','MIX_LIMIT','MONTHLY_LIMIT_REACHED','SONG_CREDITS_EXHAUSTED','STEM_TRIAL_EXHAUSTED','SERVICE_UNAVAILABLE'])

// Fixed, low-cardinality fields only. Never accept request objects, exception
// messages/stacks, account IDs, filenames, JWTs, provider hashes or signed URLs.
export function createOperationLogger(write=console.info){
  return entry=>{
    if(!['mixes','separation'].includes(entry?.service)||!operations.has(entry.operation)||!Number.isInteger(entry.status)||entry.status<100||entry.status>599)return
    const event={event:'mix-room.operation',service:entry.service,operation:entry.operation,status:entry.status}
    if(codes.has(entry.code))event.code=entry.code
    if(['quick','thorough'].includes(entry.mode))event.mode=entry.mode
    if(['quick','instruments','drums','vocals'].includes(entry.stage))event.stage=entry.stage
    if(['attempted','accepted','unconfirmed','failed'].includes(entry.outcome))event.outcome=entry.outcome
    try{write(JSON.stringify(event))?.catch?.(()=>{})}catch{/* Logging must not break a save or cause paid retries. */}
  }
}

export function reportOperation(report,entry){try{report(entry)?.catch?.(()=>{})}catch{/* Best effort, never retry the underlying operation. */}}
