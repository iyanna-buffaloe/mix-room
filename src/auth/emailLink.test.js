import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeEmailLink, createEmailLinkSession } from './emailLink.js'

const tokenHash = 'a'.repeat(64)

test('real provider 56-character email hashes are accepted without weakening parameter validation',()=>{
  const proof='b'.repeat(56)
  for(const kind of ['signup','recovery'])assert.deepEqual(consumeEmailLink({href:`https://mixroom.click/auth/confirm/#type=${kind}&token_hash=${proof}`},{replaceState:()=>{}}),{kind,tokenHash:proof})
  for(const length of [32,55,57,63,65,256])assert.equal(consumeEmailLink({href:`https://mixroom.click/auth/confirm/#type=signup&token_hash=${'b'.repeat(length)}`},{replaceState:()=>{}}).tokenHash,null)
})
const user = { id: 'temporary-user', email_confirmed_at: '2026-10-24T12:00:00Z' }
const ok = data => ({ data, error: null })
function setup(kind = 'recovery', overrides = {}) {
  const calls = []
  const auth = {
    verifyOtp: async input => { calls.push(['verify',input]); return ok({ user,session:{user} }) },
    getUser: async () => ok({ user }),
    updateUser: async input => { calls.push(['update',input]); return ok({user}) },
    signOut: async input => { calls.push(['signout',input]); return ok({}) },
    ...overrides,
  }
  return { session:createEmailLinkSession(auth,{kind,tokenHash}), calls }
}
test('branded link capture accepts only one supported fragment proof and removes all URL parameters', () => {
  let cleaned
  assert.deepEqual(consumeEmailLink({href:`https://mixroom.click/auth/confirm/#type=recovery&token_hash=${tokenHash}`},{replaceState:(_,__,url)=>{cleaned=url}}),{kind:'recovery',tokenHash})
  assert.equal(cleaned,'/auth/confirm/')
  for(const tail of [`?token_hash=${tokenHash}&type=recovery`,`#type=signup&token_hash=${tokenHash}&redirect_to=https://attacker.invalid`,`#type=magiclink&token_hash=${tokenHash}`,`#type=recovery&type=signup&token_hash=${tokenHash}`,`#type=signup&token_hash=${tokenHash}&token_hash=${tokenHash}`,'#type=recovery&token_hash=short','']) {
    assert.equal(consumeEmailLink({href:'https://mixroom.click/auth/confirm/'+tail},{replaceState:()=>{}}).tokenHash,null)
  }
})
test('opening a branded link makes no auth request, exposes no proof, and cannot update a password', async () => {
  const {session,calls}=setup()
  assert.equal(session.getSnapshot().phase,'ready');assert.deepEqual(calls,[])
  assert.equal(JSON.stringify(session.getSnapshot()).includes(tokenHash),false)
  assert.equal(await session.updatePassword('long new password','long new password'),false)
  assert.deepEqual(calls,[])
})
test('signup confirmation cannot become a recovery grant and releases its isolated session', async () => {
  const {session,calls}=setup('signup')
  assert.equal(await session.verify(),true);assert.equal(session.getSnapshot().phase,'confirmed')
  assert.equal(await session.updatePassword('long new password','long new password'),false)
  assert.equal(calls.filter(([kind])=>kind==='verify').length,1)
  assert.deepEqual(calls.at(-1),['signout',{scope:'local'}])
})
test('recovery requires a verified matching identity; mismatched or unconfirmed results fail closed', async () => {
  for(const value of [{...user,id:'different'}, {...user,email_confirmed_at:null}]) {
    const {session,calls}=setup('recovery',{getUser:async()=>ok({user:value})})
    assert.equal(await session.verify(),false);assert.equal(session.getSnapshot().phase,'invalid')
    assert.equal(await session.updatePassword('long new password','long new password'),false)
    assert.equal(calls.some(([kind])=>kind==='update'),false)
  }
})
test('verified recovery validates fields, updates once and clears its grant after success', async () => {
  const {session,calls}=setup()
  await session.verify()
  assert.equal(await session.updatePassword('short','short'),false)
  assert.equal(await session.updatePassword('long new password','other new password'),false)
  assert.equal(await session.updatePassword('long new password','long new password'),true)
  assert.equal(session.getSnapshot().phase,'updated')
  assert.equal(await session.updatePassword('another password','another password'),false)
  assert.deepEqual(calls.filter(([kind])=>kind==='update'),[['update',{password:'long new password'}]])
  assert.equal(JSON.stringify(session.getSnapshot()).includes('long new password'),false)
})
test('network retry after verification does not consume the same email token again', async () => {
  let checks=0
  const {session,calls}=setup('recovery',{getUser:async()=>{if(++checks===1)throw new TypeError('network');return ok({user})}})
  assert.equal(await session.verify(),false);assert.equal(session.getSnapshot().phase,'ready')
  assert.equal(await session.verify(),true);assert.equal(session.getSnapshot().phase,'reset')
  assert.equal(calls.filter(([kind])=>kind==='verify').length,1)
})
test('double clicks cannot verify twice; closing during verification cannot expose a late reset form', async () => {
  let resolve
  const pending=new Promise(done=>{resolve=done})
  const {session,calls}=setup('recovery',{verifyOtp:async()=>{calls.push(['verify']);return pending}})
  const first=session.verify();assert.equal(await session.verify(),false)
  session.dispose();resolve(ok({user,session:{user}}))
  assert.equal(await first,false)
  assert.notEqual(session.getSnapshot().phase,'reset')
  assert.ok(calls.some(([kind])=>kind==='signout'))
})
test('an expired recovery or changed user prevents writes; transient update errors allow correction', async () => {
  const {session,calls}=setup('recovery',{updateUser:async()=>({error:{code:'weak_password'}})})
  await session.verify();assert.equal(await session.updatePassword('long new password','long new password'),false)
  assert.equal(session.getSnapshot().phase,'reset');assert.match(session.getSnapshot().error,/stronger/)
  const ended=setup('recovery',{updateUser:async()=>({error:{status:401,code:'session_not_found'}})})
  await ended.session.verify();assert.equal(await ended.session.updatePassword('long new password','long new password'),false)
  assert.equal(ended.session.getSnapshot().phase,'invalid')
  assert.equal(await ended.session.updatePassword('long new password','long new password'),false)
  assert.equal(calls.filter(([kind])=>kind==='verify').length,1)
})
test('a changed identity after verification cannot change either account password', async () => {
  let checks=0
  const {session,calls}=setup('recovery',{getUser:async()=>ok({user:++checks===1?user:{...user,id:'another-user'}})})
  await session.verify()
  assert.equal(await session.updatePassword('long new password','long new password'),false)
  assert.equal(session.getSnapshot().phase,'invalid')
  assert.equal(calls.some(([kind])=>kind==='update'),false)
})
