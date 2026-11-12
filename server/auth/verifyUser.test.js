import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserVerifier } from './verifyUser.js'

const env={SUPABASE_URL:'https://fixture.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_never_needed_for_identity'}
const user={id:'11111111-1111-4111-8111-111111111111',email_confirmed_at:'2026-10-26T12:00:00Z'}
test('server identity checks use the public key and validate the supplied token with bounded requests',async()=>{
  const calls=[]
  const verify=createUserVerifier(env,{fetcher:async(url,options)=>{calls.push({url,options});return Response.json(user)}})
  assert.deepEqual(await verify('fixture-session-token'),{id:user.id})
  const headers=new Headers(calls[0].options.headers)
  assert.equal(headers.get('apikey'),env.VITE_SUPABASE_PUBLISHABLE_KEY)
  assert.equal(headers.get('Authorization'),'Bearer fixture-session-token')
  assert.ok(calls[0].options.signal)
})
test('unconfirmed, anonymous and expired accounts cannot become verified paid identities',async()=>{
  for(const body of [{...user,email_confirmed_at:null},{...user,is_anonymous:true},{code:'bad_jwt',msg:'expired'}]){
    const verify=createUserVerifier(env,{fetcher:async()=>Response.json(body,{status:body.code?401:200})})
    assert.equal(await verify('fixture-token'),null)
  }
})
test('identity provider outages fail closed rather than falling back to a guest',async()=>{
  const verify=createUserVerifier(env,{fetcher:async()=>Response.json({msg:'unavailable'},{status:503})})
  await assert.rejects(verify('fixture-token'))
  assert.equal(createUserVerifier({}),null)
})
