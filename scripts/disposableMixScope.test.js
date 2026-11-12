import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { disposableMixScope } from './fixtures/disposableMixScope.mjs'

test('test storage refuses unrelated owners, uploads, prefixes and traversal before any provider call',()=>{
  const scope=disposableMixScope(), owner=randomUUID(), upload=randomUUID(), calls=[]
  scope.registerCreatedAccount(owner);scope.registerUpload(owner,upload)
  const raw=Object.fromEntries(['remove','inspect','copy','uploadUrl','downloadUrl'].map(method=>[method,(...args)=>calls.push({method,args})]))
  const storage=scope.storage(raw), own=`saved/${owner}/${upload}.mixroom`
  for(const key of [`saved/${randomUUID()}/${upload}.mixroom`,`saved/${owner}/${randomUUID()}.mixroom`,`saved/${owner}/../${upload}.mixroom`,`other/${owner}/${upload}.mixroom`,own+'/extra']){
    for(const method of ['remove','inspect','downloadUrl','uploadUrl'])assert.throws(()=>storage[method](key),/unrelated/)
    assert.throws(()=>storage.copy(own,key),/unrelated/)
    assert.throws(()=>storage.copy(key,own),/unrelated/)
  }
  assert.equal(calls.length,0)
  storage.copy(`incoming/${owner}/${upload}.mixroom`,own);storage.remove(own)
  assert.equal(calls.length,2)
})
test('upload registration and cleanup require a newly registered account and valid upload ID',()=>{
  const scope=disposableMixScope(), owner=randomUUID()
  assert.throws(()=>scope.registerUpload(owner,randomUUID()),/unrelated/)
  assert.throws(()=>scope.registerCreatedAccount('existing@example.com'))
  scope.registerCreatedAccount(owner)
  assert.throws(()=>scope.registerUpload(owner,'../../saved'))
  assert.equal(scope.owner(owner),owner)
  assert.throws(()=>scope.owner(randomUUID()),/unrelated/)
})
test('live test repository blocks global cleanup and unrelated accounts before reaching the database',async()=>{
  const scope=disposableMixScope(), owner=randomUUID(), calls=[]
  scope.registerCreatedAccount(owner)
  const raw={list:id=>calls.push(id),expiredUploads:()=>calls.push('global'),verifyToken:async()=>({id:randomUUID()})}
  const repository=scope.repository(raw)
  assert.throws(()=>repository.list(randomUUID()),/unrelated/)
  assert.throws(()=>repository.expiredUploads(),/unscoped/)
  await assert.rejects(repository.verifyToken('fixture'),/unrelated/)
  assert.deepEqual(calls,[])
  repository.list(owner);assert.deepEqual(calls,[owner])
})
