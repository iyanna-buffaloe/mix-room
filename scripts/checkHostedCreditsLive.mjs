import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getStore } from '@netlify/blobs'
import { createClient } from '@supabase/supabase-js'
import { createSeparationService } from '../server/separation/service.js'
import { createUserVerifier } from '../server/auth/verifyUser.js'
import { STAGES } from '../server/separation/mvsep.js'
import { encodeSeparationWav } from '../shared/separationAudio.js'
import { creditProbeScope, createCreditProbeStore } from './fixtures/creditProbeStore.mjs'

// Opt-in only. Real Auth, Blobs and deployed allowance endpoints; synthetic
// identities and a separator fixture. Never submits a real /jobs request.
const origin = 'https://friday-integration--mixingvisualizer.netlify.app'
const siteID = '91c5baeb-bc47-46e1-baef-fad83adc645d'
const authOrigin = new URL(process.env.VITE_SUPABASE_URL || 'https://configuration.invalid').origin
const blockedHosts = new Set()
const signedBlobOrigins = new Set()
async function network(input, options = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const allowed = url.origin === authOrigin || url.origin === origin || url.hostname === 'api.netlify.com' || signedBlobOrigins.has(url.origin)
  if (!allowed) { blockedHosts.add(url.hostname); throw new Error('Live credit check blocked an unexpected network destination') }
  const response = await fetch(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
  if (url.hostname === 'api.netlify.com' && decodeURIComponent(url.pathname).startsWith(`/api/v1/blobs/${siteID}/site:mix-room-separation/`) && response.ok) {
    const data = await response.clone().json().catch(() => null)
    if (data?.url) {
      const signed = new URL(data.url)
      assert.equal(signed.protocol, 'https:')
      assert.match(signed.hostname, /^[a-z0-9-]*netliblob[a-z0-9-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/)
      assert.ok(signed.searchParams.has('X-Amz-Signature'))
      signedBlobOrigins.add(signed.origin)
    }
  }
  return response
}
const rawStore = () => getStore({ name: 'mix-room-separation', siteID, token: process.env.NETLIFY_AUTH_TOKEN, consistency: 'strong', fetch: network })
const authOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: network } }

async function worker(input) {
  const scope = creditProbeScope(input.scope), touched = new Set()
  let creates = 0
  try {
    const audio = new Uint8Array(encodeSeparationWav(new Float32Array(44100)))
    const service = createSeparationService({
      store: createCreditProbeStore(rawStore(), scope, touched),
      verifyUser: createUserVerifier(process.env),
      config: { available: true, maxSeconds: 360, monthlyJobs: 20 },
      apiKey: 'synthetic-credit-check-only', now: () => Date.now() + (input.offset || 0),
      storage: { uploadUrl: async () => 'https://storage.invalid/fixture-upload', sourceUrl: async () => 'https://storage.invalid/fixture-source', inspect: async () => ({ size: audio.length, header: audio.subarray(0,44) }) },
      provider: {
        create: async stage => { creates++; return `fixture-${stage}` },
        get: async hash => ({ status: 'done', data: { files: STAGES[hash.slice(8)].keys.map(key => ({ type: key, bytes: 2048, url: `https://de2.mvsep.com/storage/processed/fixture-${key}.wav` })) } }),
        cancel: async () => {},
      },
    })
    const response = await service(new Request(origin+'/api/separation'+input.route, { method: input.method || 'GET', headers: { Origin: origin, ...input.headers }, ...(input.body ? { body: JSON.stringify(input.body) } : {}) }))
    return { ok: true, status: response.status, data: await response.json(), creates, touched: [...touched], blockedHosts: [...blockedHosts] }
  } catch { return { ok: false, touched: [...touched], blockedHosts: [...blockedHosts] } }
}

if (process.argv.includes('--worker')) {
  process.once('message', async input => {
    process.send(await worker(input), () => process.disconnect())
  })
} else {
  assert.ok(process.argv.includes('--live'), 'Use --live for disposable hosted-credit checks')
  assert.ok(process.env.NETLIFY_AUTH_TOKEN && process.env.SUPABASE_SECRET_KEY && process.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Existing authorized Netlify and private Auth configuration is required')
  const folder = process.env.MIX_ROOM_CREDIT_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-hosted-credit-check')
  await mkdir(folder, { recursive: true })
  const admin = createClient(authOrigin, process.env.SUPABASE_SECRET_KEY, authOptions)
  const users = [], results = [], touched = new Set()
  const device = randomBytes(32).toString('hex'), otherDevice = randomBytes(32).toString('hex')
  const jobs = Array.from({ length: 12 }, () => ({ id: randomUUID(), token: randomBytes(32).toString('hex') }))
  const runId = randomUUID(), raw = rawStore()
  let scope, phase = 'configuration', failed = false, cleanupFailed = false, creates = 0, processCount = 0, deletedKeys = 0
  const check = result => { assert.ok(!result.error, `Auth operation failed during ${phase}`); return result.data }
  const pass = label => { results.push({ check: label, passed: true }); console.log('PASS '+label) }
  const begin = label => { phase = label }
  const options = (token, guest = device) => ({ 'X-Mix-Room-Device': guest, ...(token ? { 'X-Mix-Room-Account': token } : {}) })
  async function deployed(route, headers = {}, method = 'GET', body) {
    assert.match(route, /^\/(config|credits|stems\/(reserve|complete|release))$/)
    const response = await network(origin+'/api/separation'+route, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  async function identity() {
    const email = `mix-room-credit-${randomUUID()}@example.com`, password = randomBytes(32).toString('base64url')
    const user = check(await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: 'disposable-hosted-credit-check', runId } })).user
    users.push(user.id)
    const auth = createClient(authOrigin, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, authOptions).auth
    const session = check(await auth.signInWithPassword({ email, password })).session
    return { id: user.id, session, auth, email, password }
  }
  async function invoke(route, headers, method = 'GET', body, offset = 0) {
    const input = { scope: { runId, accountIds: users, devices: [device, otherDevice], jobIds: jobs.map(job => job.id) }, route, headers, method, body, offset }
    processCount++
    const result = await new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: [], stdio: ['ignore','ignore','ignore','ipc'] })
      let received = false
      const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated credit worker timed out')) }, 90000)
      child.once('message', value => { received = true; clearTimeout(timer); resolve(value) })
      child.once('error', () => { clearTimeout(timer); reject(new Error('Isolated credit worker could not start')) })
      child.once('exit', () => { clearTimeout(timer); if (!received) reject(new Error('Isolated credit worker exited without a result')) })
      child.send(input)
    })
    for (const key of result.touched || []) { assert.ok(scope.owns(key)); touched.add(key) }
    assert.equal(result.ok, true, 'Isolated credit worker completed safely')
    assert.deepEqual(result.blockedHosts, [], 'No unexpected destination or MVSEP request')
    creates += result.creates
    return result
  }
  const jobHeaders = (job, token, guest = device) => ({ ...options(token, guest), Authorization: 'Bearer '+job.token })
  const init = (job, token, guest = device) => invoke('/jobs', jobHeaders(job,token,guest), 'POST', { id: job.id, mode: 'quick', name: 'Synthetic credit probe.wav', size: 44+44100*8 })
  try {
    assert.equal((await deployed('/config')).data.available, false, 'The actual draft must keep paid separation disabled')
    // Validate CLI access without listing any shared-store records.
    assert.equal(await raw.getWithMetadata(`qa-credit-check/${runId}/preflight`, { type: 'json', consistency: 'strong' }), null)
    const a = await identity(), b = await identity()
    scope = creditProbeScope({ runId, accountIds: users, devices: [device,otherDevice], jobIds: jobs.map(job => job.id) })
    for (const key of scope.allowanceKeys) assert.equal(await raw.getWithMetadata(key, { type: 'json', consistency: 'strong' }), null, 'Every allowance key must be new and disposable')
    // Pre-register deterministic keys so even a killed worker can be cleaned up.
    for (const key of scope.allowanceKeys) touched.add(key)
    for (const job of jobs) for (const type of ['job','cancel']) touched.add(scope.keyFor(`${type}/${job.id}`))
    for (let slot=0; slot<20; slot++) touched.add(scope.keyFor(`quota/${new Date().toISOString().slice(0,7)}/${slot}`))
    begin('Fresh deployed guest and account balances')
    assert.deepEqual((await deployed('/credits',options())).data, { scope:'guest', limit:0, remaining:0, stemsRemaining:1 })
    assert.deepEqual((await deployed('/credits',options(a.session.access_token))).data, { scope:'account', limit:3, remaining:3, stemsRemaining:null })
    pass(phase)

    begin('Real hosted guest stem concurrency, idempotency and consumed-trial persistence')
    const trials = Array.from({ length: 3 }, () => randomUUID())
    const reservations = await Promise.all(trials.map(id => deployed('/stems/reserve',options(),'POST',{id})))
    assert.equal(reservations.filter(r=>r.status===200).length,1)
    const accepted = trials[reservations.findIndex(r=>r.status===200)]
    assert.equal((await deployed('/stems/reserve',options(),'POST',{id:accepted})).status,200)
    assert.equal((await deployed('/stems/complete',options(),'POST',{id:accepted})).status,200)
    assert.equal((await deployed('/stems/complete',options(),'POST',{id:accepted})).status,200)
    assert.equal((await deployed('/stems/release',options(),'POST',{id:accepted})).data.released,false)
    assert.equal((await deployed('/credits',options())).data.stemsRemaining,0)
    assert.equal((await invoke('/credits',options())).data.stemsRemaining,0)
    pass(phase)

    begin('Guest paid work is denied before any durable job reservation')
    assert.equal((await init(jobs[0])).data.code,'SIGN_IN_REQUIRED')
    assert.equal((await invoke(`/jobs/${jobs[0].id}/start`,jobHeaders(jobs[0]),'POST')).data.code,'SIGN_IN_REQUIRED')
    assert.equal((await invoke('/credits',options())).data.remaining,0)
    assert.equal((await invoke('/credits',options(), 'GET',null,32*86400000)).data.remaining,0)
    pass(phase)

    begin('Account lifetime credits survive independent processes, new login and another device')
    for (let n=0; n<3; n++) {
      const job=jobs[n+2]
      assert.equal((await init(job,a.session.access_token)).status,200)
      assert.equal((await invoke(`/jobs/${job.id}/start`,jobHeaders(job,a.session.access_token),'POST')).data.status,'processing')
      assert.equal((await deployed('/credits',options(a.session.access_token))).data.remaining,2-n)
    }
    const renewed=check(await a.auth.refreshSession({refresh_token:a.session.refresh_token})).session
    assert.equal((await deployed('/credits',options(renewed.access_token,otherDevice))).data.remaining,0)
    const independent=createClient(authOrigin,process.env.VITE_SUPABASE_PUBLISHABLE_KEY,authOptions).auth
    const next=check(await independent.signInWithPassword({email:a.email,password:a.password})).session
    assert.equal((await deployed('/credits',options(next.access_token,otherDevice))).data.remaining,0)
    assert.equal((await invoke('/credits',options(next.access_token,otherDevice),'GET',null,32*86400000)).data.remaining,0)
    assert.equal((await deployed('/credits',options(b.session.access_token,otherDevice))).data.remaining,3)
    pass(phase)

    begin('Account stem requests remain unlimited after all audio credits are consumed')
    for (let n=0;n<3;n++) for (const action of ['reserve','complete','release']) {
      const result=await deployed('/stems/'+action,options(next.access_token,otherDevice),'POST',{id:randomUUID()})
      assert.equal(result.status,200);assert.equal(result.data.unlimited,true)
    }
    assert.equal((await deployed('/credits',options(next.access_token))).data.stemsRemaining,null)
    pass(phase)

    begin('Independent processes atomically reserve at most three credits on real Netlify Blobs')
    const race=jobs.slice(5,11)
    const reserved=await Promise.all(race.map((job,n)=>init(job,b.session.access_token,n%2?otherDevice:device)))
    assert.equal(reserved.filter(r=>r.status===200).length,3)
    assert.equal(reserved.filter(r=>r.data.code==='SONG_CREDITS_EXHAUSTED').length,3)
    assert.equal((await deployed('/credits',options(b.session.access_token))).data.remaining,0)
    const acceptedJob=race[reserved.findIndex(r=>r.status===200)]
    const expired=await invoke(`/jobs/${acceptedJob.id}/start`,jobHeaders(acceptedJob,b.session.access_token),'POST',null,31*60000)
    assert.equal(expired.data.status,'failed')
    assert.match(expired.data.message,/reservation expired/)
    assert.equal(expired.creates,0)
    assert.equal((await invoke('/credits',options(b.session.access_token),'GET',null,31*60000)).data.remaining,3)
    pass(phase)
    assert.equal(creates,3,'Only three account-owned in-process fixture submissions occurred')
    assert.deepEqual([...blockedHosts],[])
  } catch {
    failed=true;results.push({check:phase,passed:false});console.error('FAIL '+phase+' (private diagnostics omitted)')
  } finally {
    if(scope) for(const key of touched) {
      try { assert.ok(scope.owns(key)); if(await raw.getWithMetadata(key,{type:'json',consistency:'strong'})){await raw.delete(key);assert.equal(await raw.getWithMetadata(key,{type:'json',consistency:'strong'}),null);deletedKeys++} }
      catch {cleanupFailed=true}
    }
    for(const id of users)try{assert.ok(!(await admin.auth.admin.deleteUser(id)).error)}catch{cleanupFailed=true}
    const report={checkedAt:new Date().toISOString(),origin,realHostedAllowanceEndpoints:true,realNetlifyBlobs:true,independentNodeProcesses:processCount,paidProvider:'fixture only; no MVSEP requests',fixtureProviderSubmissions:creates,realPaidJobs:0,emailsSent:0,globalMonthlyQuotaChanged:false,existingUsersOrMixesAccessed:false,physicalSecondDevice:false,actualFunctionColdStartControlled:false,simulatedTimeAdvanceDays:32,results,blockedHosts:[...blockedHosts],cleanup:{passed:!cleanupFailed,accounts:users.length,blobRecords:deletedKeys}}
    await writeFile(path.join(folder,'results.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,cleanup:!cleanupFailed,independentNodeProcesses:processCount}))
  }
  if(failed||cleanupFailed)process.exitCode=1
}
