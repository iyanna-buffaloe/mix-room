import test from 'node:test'
import assert from 'node:assert/strict'
import { createOperationLogger,reportOperation } from './operationEvents.js'
import { createMixService } from './mixes/service.js'

test('operational logs accept only fixed fields and never raw error or request data',()=>{
  const lines=[],log=createOperationLogger(line=>lines.push(line)),secret='private-secret-and-signed-link'
  log({service:'separation',operation:'paid_submission',status:202,stage:'drums',mode:'thorough',outcome:'attempted',message:secret,token:secret,user:secret,filename:secret,url:secret,code:secret})
  assert.deepEqual(JSON.parse(lines[0]),{event:'mix-room.operation',service:'separation',operation:'paid_submission',status:202,mode:'thorough',stage:'drums',outcome:'attempted'})
  for(const entry of [{service:secret,operation:'mix_read',status:503},{service:'mixes',operation:secret,status:503},{service:'mixes',operation:'mix_read',status:secret}])log(entry)
  assert.equal(lines.length,1);assert.equal(lines.join('').includes(secret),false)
})
test('logging failure cannot interrupt the operation being observed',()=>{
  assert.doesNotThrow(()=>createOperationLogger(()=>{throw Error('offline')})({service:'mixes',operation:'mix_read',status:503}))
  assert.doesNotThrow(()=>reportOperation(()=>{throw Error('offline')},{service:'mixes'}))
})
test('a real service failure emits an actionable safe signal while preserving the generic user response',async()=>{
  const lines=[],service=createMixService({config:{available:true},repository:{verifyToken:async()=>({id:'11111111-1111-4111-8111-111111111111'}),list:async()=>{throw Error('private database connection and credentials')}},storage:{},report:createOperationLogger(line=>lines.push(line))})
  const response=await service(new Request('https://fixture.invalid/api/mixes',{headers:{Authorization:'Bearer private-session'}}))
  assert.equal(response.status,503);assert.equal((await response.json()).code,'MIX_SERVICE_FAILED')
  assert.deepEqual(JSON.parse(lines[0]),{event:'mix-room.operation',service:'mixes',operation:'mix_read',status:503,code:'MIX_SERVICE_FAILED'})
  assert.equal(lines.join('').includes('private'),false)
})
