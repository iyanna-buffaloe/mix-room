import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { createSeparationService } from '../server/separation/service.js'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createMixService } from '../server/mixes/service.js'
import { createMixArchive, readMixArchive } from '../src/audio/mixArchive.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = process.env.MIX_ROOM_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-browser-checks')
await mkdir(artifacts, { recursive: true })
const preview = await createServer({ configFile: path.join(root, 'vite.config.js'), logLevel: 'error', cacheDir: path.join(artifacts, 'vite'), server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false }, define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://fixture.supabase.co'), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('sb_publishable_fixture') } })
await preview.listen()
const origin = preview.resolvedUrls.local[0].replace(/\/$/, '')
const db = new PGlite()
const owner = '11111111-1111-4111-8111-111111111111'
const user = { id: owner, email: 'test@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, email_confirmed_at: new Date().toISOString(), identities: [], created_at: new Date().toISOString() }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })}.dGVzdA`
const audio = new Uint8Array(44144)
const header = new DataView(audio.buffer)
const str = (at, text) => { for (let n=0;n<text.length;n++) audio[at+n] = text.charCodeAt(n) }
str(0,'RIFF'); header.setUint32(4,audio.length-8,true); str(8,'WAVE');str(12,'fmt ');header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);header.setUint32(24,22050,true);header.setUint32(28,44100,true);header.setUint16(32,2,true);header.setUint16(34,16,true);str(36,'data');header.setUint32(40,audio.length-44,true)
const meta = JSON.parse(await readFile(root+'src/demo/nin-demon-seed/instrument_meta.json','utf8'))
meta.title='Older mix';meta.duration=1;meta.processingMode='stems';meta.instruments=meta.instruments.slice(0,2)
const frames = Object.fromEntries(meta.instruments.map(inst=>[inst.key,[{t:0,pan:0,loud:.5}]]))
const archive = createMixArchive({version:1,id:crypto.randomUUID(),metadata:meta,framesByKey:frames,audioBlob:new Blob([audio],{type:'audio/wav'})},{settings:{roomStyle:'dark'},visibility:{[meta.instruments[0].key]:false}})
const base64 = Buffer.from(await archive.arrayBuffer()).toString('base64')
const objects = new Map()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${owner}');`)
await db.exec(await readFile(root+'supabase/migrations/20261019184955_create_private_mix_library.sql','utf8'))
await db.exec('set role service_role')
const one = async (sql, params) => (await db.query(sql,params)).rows[0] || null
const repository = {
 verifyToken: async t => t===token ? {id:owner}:null,
 list: async id => (await db.query('select * from saved_mixes where owner_id=$1 order by updated_at desc',[id])).rows,
 get: (id,mix)=>one('select * from saved_mixes where owner_id=$1 and id=$2',[id,mix]),
 getUpload:(id,upload)=>one('select * from mix_uploads where owner_id=$1 and id=$2',[id,upload]),
 beginUpload:r=>one('select * from reserve_mix_upload($1,$2,$3,$4,$5,$6)',[r.owner_id,r.id,r.mix_id,r.name,r.bytes,r.expected_revision]),
 commit:(id,upload,bytes)=>one('select * from commit_saved_mix($1,$2,$3)',[id,upload,bytes]),
 rename:(id,row,name)=>one('update saved_mixes set name=$3, revision=revision+1,updated_at=now() where owner_id=$1 and id=$2 and revision=$4 returning *',[id,row.id,name,row.revision]),
 delete:(id,row)=>one('delete from saved_mixes where owner_id=$1 and id=$2 and revision=$3 returning id',[id,row.id,row.revision]),
}
const storage={
 uploadUrl: async key=>'https://r2.example/'+key,downloadUrl:async key=>'https://r2.example/'+key,
 inspect:async key=>{const data=objects.get(key);if(!data)throw Error('missing');return{bytes:data.length,header:new Uint8Array(data.slice(0,12))}},
 copy:async(from,to)=>{if(!objects.has(from))throw Error('missing');objects.set(to,objects.get(from))},remove:async key=>objects.delete(key),
}
const service=createMixService({config:{available:true,limit:3,maxMixBytes:167772160,maxAccountBytes:503316480},repository,storage})
let browser
try{
browser=await chromium.launch({ ...(process.env.MIX_ROOM_BROWSER_EXECUTABLE ? { executablePath: process.env.MIX_ROOM_BROWSER_EXECUTABLE } : { channel: process.env.MIX_ROOM_BROWSER_CHANNEL || 'chrome' }), headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl'] })
 const context=await browser.newContext({viewport:{width:1440,height:950},reducedMotion:'reduce'})
 const errors=[]
 await context.route('https://**',route=>{errors.push('Unexpected external host: '+new URL(route.request().url()).hostname);return route.abort()})
 const credits = new Map(); let etag = 0; let allowanceOverride = null
 const allowanceService = createSeparationService({ config: { available: false, maxSeconds: 360, monthlyJobs: 10 }, apiKey: '', verifyUser: async value => value === token ? { id: owner } : null, store: { getWithMetadata: async key => credits.get(key) || null, setJSON: async (key,data,options={}) => { const current=credits.get(key); if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false }; const next={data:structuredClone(data),etag:String(++etag)};credits.set(key,next);return {modified:true,etag:next.etag} } } })
 await context.route('**/api/separation/**',async route=>{const req=route.request();const response=await allowanceService(new Request(req.url(),{method:req.method(),headers:req.headers(),...(!['GET','HEAD'].includes(req.method())?{body:req.postData()||''}:{})}));const body=await response.text();await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:allowanceOverride && new URL(req.url()).pathname.endsWith('/credits') ? JSON.stringify({...JSON.parse(body),...allowanceOverride}) : body})})
 await context.route('https://fixture.supabase.co/auth/v1/**',async route=>{
  const url=route.request().url();let data={}
  if(url.includes('/user'))data=user
  if(url.includes('/token'))data={access_token:token,refresh_token:'fake-refresh',expires_in:3600,token_type:'bearer',user}
  await route.fulfill({status:200,contentType:'application/json',headers:{'X-Supabase-Api-Version':'2024-01-01','Access-Control-Expose-Headers':'X-Supabase-Api-Version'},body:JSON.stringify(data)})
 })
 await context.route('**/api/mixes{,/**}',async route=>{
  const req=route.request();const response=await service(new Request(req.url(),{method:req.method(),headers:req.headers(),...(!['GET','HEAD'].includes(req.method())?{body:req.postData()||''}:{})}))
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
 })
 await context.route('https://r2.example/**',async route=>{
  const req=route.request(),key=new URL(req.url()).pathname.slice(1)
  assert.equal(req.headers().authorization,undefined)
  if(req.method()==='PUT'){objects.set(key,req.postDataBuffer());await route.fulfill({status:200,body:''})}
  else await route.fulfill({status:objects.has(key)?200:404,contentType:'application/octet-stream',body:objects.get(key)||Buffer.from('missing')})
 })
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept())
 const resize=async viewport=>{await page.setViewportSize(viewport);await page.waitForFunction(height=>Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--room-visible-height'))-height)<2,viewport.height);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
 await page.goto(origin+'/')
 await page.getByRole('heading',{name:'Welcome to Mix Room'}).waitFor()
 assert.equal(await page.getByRole('button',{name:'Open a mix backup',exact:true}).count(),0)
 assert.equal(await page.locator('.mix-room__track-title h2').count(),0)
 assert.equal(await page.getByRole('button',{name:'My mixes',exact:true}).count(),0)
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 await page.getByRole('region',{name:'My mixes',exact:true}).getByRole('button',{name:'Sign in to view mixes',exact:true}).waitFor()
 assert.equal(await page.locator('.account-dialog--access').isVisible(),false)
 const guestLibrary=page.getByRole('region',{name:'My mixes',exact:true})
 for(const viewport of [{width:1440,height:950},{width:390,height:844},{width:844,height:390}]){
  await resize(viewport)
  const body=await guestLibrary.locator('.mix-library__body').boundingBox()
  const action=await guestLibrary.getByRole('button',{name:'Sign in to view mixes',exact:true}).boundingBox()
  await page.screenshot({path:path.join(artifacts,`guest-mixes-${viewport.width}.png`)})
  assert.ok(Math.abs(action.x+action.width/2-body.x-body.width/2)<8,'guest sign-in is horizontally centered')
  assert.ok(Math.abs(action.y+action.height/2-body.y-body.height/2)<8,`guest sign-in is vertically centered at ${viewport.width}: ${JSON.stringify({body,action})}`)
 }
 await resize({width:1440,height:950})
 await page.getByRole('region',{name:'My mixes',exact:true}).getByRole('button',{name:'Sign in to view mixes',exact:true}).click()
 const libraryLogin=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Sign in',exact:true})})
 await libraryLogin.getByLabel('Email',{exact:true}).fill(user.email)
 await libraryLogin.getByLabel('Password',{exact:true}).fill('test password long')
 await libraryLogin.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('region',{name:'My mixes',exact:true}).getByRole('heading',{name:'No saved mixes',exact:true}).waitFor()
 assert.equal(await page.getByRole('dialog').count(),0,'library sign-in does not open Save mix')
 await page.locator('.account-access').click()
 await page.keyboard.press('Escape')
 assert.equal(await page.getByRole('region',{name:'My mixes',exact:true}).isVisible(),true,'closing Account keeps the library open')
 await page.locator('.account-access').click()
 await page.getByRole('region',{name:'Account',exact:true}).getByRole('button',{name:'Sign out',exact:true}).click()
 await page.getByRole('heading',{name:'Welcome to Mix Room'}).waitFor()
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 await page.getByRole('button',{name:'Close mix library',exact:true}).click()
 console.log('PASS My mixes has its own tab; guest sign-in opens the library, and Account dismisses independently')
 // Mode selection is a local preference even while processing is unavailable.
 // Starting a job still requires service availability, credits and a file.
 await page.getByRole('tab',{name:'Upload tracks',exact:true}).click()
 await page.getByRole('button',{name:'Audio file',exact:true}).click()
 const allowance=page.locator('#processing-allowance')
 await page.getByText('Sign in for three one-time audio-file credits. Your selected file stays in this tab.',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Stems',exact:true}).click()
 assert.equal(await allowance.textContent(),'1 stem analysis remaining')
 await page.getByRole('button',{name:'Audio file',exact:true}).click()
 assert.equal(await allowance.textContent(),'Sign in for three one-time audio-file credits. Your selected file stays in this tab.')
 await page.screenshot({path:path.join(artifacts,'upload-audio-desktop.png')})
 for(const viewport of [{width:390,height:844},{width:844,height:390}]){
  await resize(viewport)
  for(const [tab,expected] of [['Audio file','Sign in for three one-time audio-file credits. Your selected file stays in this tab.'],['Stems','1 stem analysis remaining']]){
   await page.getByRole('button',{name:tab,exact:true}).click()
   assert.equal(await allowance.textContent(),expected)
   assert.equal(await page.locator('.mix-room__processing-section').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true)
   await page.screenshot({path:path.join(artifacts,`upload-${tab==='Stems'?'stems':'audio'}-${viewport.width}.png`)})
  }
 }
 await resize({width:1440,height:950})
 await page.getByRole('button',{name:'Audio file',exact:true}).click()
 // Thorough is paused, so the panel describes the single six-stem mode.
 assert.equal(await page.locator('input[name="processing-mode"]').count(),0)
 assert.equal(await page.getByText('6-stem separation',{exact:true}).isVisible(),true)
 assert.equal(await page.locator('.mix-room__upload-button').isDisabled(),true)
 console.log('PASS The six-stem mode is described while processing is unavailable')
 for(const stemsRemaining of [1,0]){
  allowanceOverride={remaining:0,stemsRemaining}
  await page.reload()
  await page.getByRole('heading',{name:'Welcome to Mix Room'}).waitFor()
  await page.getByRole('tab',{name:'Upload tracks',exact:true}).click()
  await page.getByText('Sign in for three one-time audio-file credits. Your selected file stays in this tab.',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Audio file',exact:true}).getAttribute('aria-pressed'),'true')
  assert.equal(await page.locator('.mix-room__upload-button').isDisabled(),true)
  await page.getByRole('button',{name:'Stems',exact:true}).click()
  assert.equal(await allowance.textContent(),stemsRemaining===1?'1 stem analysis remaining':'0 stem analyses remaining')
 }
 allowanceOverride=null
 console.log('PASS tab-specific guest analysis counts, exhausted counts, and mobile layouts')
 await page.evaluate(async value=>{const {readMixArchive}=await import('/src/audio/mixArchive.js');const {saveBrowserMix}=await import('/src/audio/browserMixStorage.js');const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));const {record}=await readMixArchive(new Blob([bytes]));await saveBrowserMix(record)},base64)
 await page.reload()
 await page.getByText('An older mix is stored in this browser').waitFor()
 assert.equal(await quick.isChecked(),true)
 assert.equal(await page.locator('audio').getAttribute('src'),null)
 await page.getByRole('button',{name:'Open for this visit',exact:true}).click()
 await page.getByRole('heading',{name:'Older mix',exact:true}).waitFor()
 await page.getByRole('button',{name:'EDITOR',exact:true}).click()
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).fill('Edited draft title')
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Instrument name',{exact:true}).first().fill('Edited instrument')
 await page.getByRole('button',{name:'Save mix',exact:true}).click()
 await page.getByRole('button',{name:'Sign in to save',exact:true}).click()
 let account=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Sign in',exact:true})})
 await account.getByLabel('Email',{exact:true}).fill(user.email);await account.getByLabel('Password',{exact:true}).fill('test password long')
 await account.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.locator('.account-access').filter({hasText:'Account'}).waitFor()
 console.log('PASS guest opening, legacy opt-in, sign-in preserves draft and returns to explicit Save')
 let library=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
 await library.getByText(/0 of 3 saved/).waitFor()
 assert.equal(await library.getByLabel('Mix name',{exact:true}).inputValue(),'Edited draft title')
 await library.getByLabel('Mix name',{exact:true}).fill('Saved original')
 await library.getByRole('button',{name:'Save mix',exact:true}).click()
 await library.waitFor({state:'hidden'})
 const saveAction=page.locator('.mix-room__top-actions > button').first()
 await page.getByRole('button',{name:'Saved',exact:true}).waitFor()
 assert.equal(await saveAction.isDisabled(),true,'a successful save disables the action')
 assert.equal(await page.getByText('Mix saved to your account.',{exact:true}).count(),0)
 await page.getByRole('tab',{name:'Upload tracks',exact:true}).click()
 await page.getByRole('button',{name:'Audio file',exact:true}).click()
 await page.getByText('3 audio file analyses remaining',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Stems',exact:true}).click()
 assert.equal(await allowance.textContent(),'Unlimited stem analysis')
 console.log('PASS account audio count and unlimited stem analysis')
 assert.equal((await repository.list(owner)).length,1)
 const stored=(await repository.list(owner))[0]
 assert.equal((await readMixArchive(new Blob([objects.get(stored.object_key)]))).record.metadata.instruments[0].label,'Edited instrument')
 await page.reload()
 await page.getByRole('heading',{name:'Welcome to Mix Room'}).waitFor()
 await page.getByRole('button',{name:'My mixes',exact:true}).click()
 library=page.getByRole('region',{name:'My mixes',exact:true})
 await library.getByRole('button',{name:'Open Saved original',exact:true}).click()
 await page.getByRole('heading',{name:'Saved original',exact:true,level:2}).waitFor()
 assert.equal(await page.getByText('Saved in your account',{exact:true}).count(),0)
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})))
 await page.getByRole('heading',{name:'Welcome to Mix Room',exact:true}).waitFor()
 assert.equal(await page.locator('audio').getAttribute('src'),null)
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 library=page.getByRole('region',{name:'My mixes',exact:true})
 await library.getByRole('button',{name:'Open Saved original',exact:true}).click()
 await page.getByRole('heading',{name:'Saved original',exact:true,level:2}).waitFor()
 assert.equal(await page.getByText('Saved in your account',{exact:true}).count(),0)
 console.log('PASS save, refresh/BFCache clears active mix, private reopen restores saved state')
 for(const viewport of [{width:1440,height:950},{width:390,height:844},{width:844,height:390}]){
  await resize(viewport)
  assert.equal(await saveAction.getAttribute('aria-label'),'Saved')
  assert.equal(await saveAction.isDisabled(),true)
  assert.equal(await saveAction.locator('small').textContent(),'Saved')
  assert.equal(await saveAction.locator('small').evaluate(el=>getComputedStyle(el).textTransform),'uppercase')
  assert.equal(await saveAction.evaluate(el=>Number(getComputedStyle(el).opacity)),.5)
  await page.screenshot({path:path.join(artifacts,`saved-button-${viewport.width}.png`)})
 }
 await resize({width:1440,height:950})
 await page.getByRole('button',{name:'EDITOR',exact:true}).click()
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).fill('Unsaved title edit')
 await page.waitForFunction(()=>document.querySelector('.mix-room__top-actions > button')?.getAttribute('aria-label')==='Save mix')
 assert.equal(await saveAction.isEnabled(),true,'pending name edits enable saving')
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).fill('Saved original')
 await page.waitForFunction(()=>document.querySelector('.mix-room__top-actions > button')?.disabled)
 assert.equal(await saveAction.getAttribute('aria-label'),'Saved','reverting pending names restores Saved')
 await page.getByRole('tab',{name:'Visible instruments',exact:true}).click()
 await page.locator('.mix-room__instrument-options input').first().uncheck()
 assert.equal(await saveAction.isEnabled(),true,'visibility edits enable saving')
 assert.equal(await saveAction.getAttribute('aria-label'),'Save mix')
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 await page.getByRole('button',{name:'Open Saved original',exact:true}).click()
 await page.getByRole('button',{name:'Discard changes and continue',exact:true}).click()
 await page.getByRole('heading',{name:'Saved original',exact:true,level:2}).waitFor()
 await page.getByRole('button',{name:'Saved',exact:true}).waitFor()
 assert.equal(await saveAction.isDisabled(),true,'reopening the saved version restores Saved')
 assert.equal(await saveAction.getAttribute('aria-label'),'Saved')
 console.log('PASS Saved is dimmed and disabled across desktop/mobile; pending names and visibility edits enable Save mix')
 // A different device may change the saved version while this draft is open.
 // Refreshing must give a usable save choice without silently overwriting it.
 await page.getByRole('button',{name:'EDITOR',exact:true}).click()
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).fill('Conflict draft')
 const beforeConflict=(await repository.list(owner)).find(row=>row.name==='Saved original')
 await repository.rename(owner,beforeConflict,'Other device version')
 await page.getByRole('button',{name:'Save mix',exact:true}).click()
 library=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
 await library.getByText(/1 of 3 saved/).waitFor()
 await library.getByRole('button',{name:'Save mix',exact:true}).click()
 await library.getByRole('alert').waitFor()
 assert.equal(await library.getByLabel('Save to',{exact:true}).inputValue(),'new','conflicts leave a fresh explicit choice instead of a stale update')
 assert.equal(await library.getByRole('option',{name:/Update/}).count(),0,'stale Update cannot be selected again')
 assert.equal((await repository.get(owner,beforeConflict.id)).name,'Other device version','a conflict preserves the other device version')
 assert.equal(await library.getByLabel('Mix name',{exact:true}).inputValue(),'Conflict draft','current edits survive the conflict')
 for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390}]){
  await resize(viewport)
  assert.equal(await library.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'recovery controls fit the phone dialog')
  await library.getByRole('button',{name:'Save mix',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(artifacts,`save-conflict-${viewport.width}.png`)})
 }
 await resize({width:1440,height:950})
 await library.getByRole('button',{name:'Save mix',exact:true}).click()
 await library.waitFor({state:'hidden'})
 const recovered=(await repository.list(owner)).find(row=>row.name==='Conflict draft')
 assert.ok(recovered && recovered.id!==beforeConflict.id,'explicit Save as new preserves both versions')
 await repository.delete(owner,recovered);await storage.remove(recovered.object_key)
 const changed=await repository.get(owner,beforeConflict.id)
 await repository.rename(owner,changed,'Saved original')
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 library=page.getByRole('region',{name:'My mixes',exact:true})
 await library.getByRole('button',{name:'Open Saved original',exact:true}).click()
 await page.getByRole('heading',{name:'Saved original',exact:true,level:2}).waitFor()
 console.log('PASS conflicting device edits preserve both versions and allow explicit Save as new')
 for(let n=2;n<=3;n++){
  await page.locator('input[aria-label="Choose a Mix Room backup"]').setInputFiles({name:'track.mixroom',mimeType:'application/octet-stream',buffer:Buffer.from(base64,'base64')})
  await page.getByRole('heading',{name:'Older mix',exact:true}).waitFor()
  await page.getByRole('button',{name:'Save mix',exact:true}).click()
  library=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
  await library.getByText(new RegExp(`${n-1} of 3 saved`)).waitFor()
  await library.getByLabel('Mix name',{exact:true}).fill(`Saved ${n}`)
  await library.getByRole('button',{name:'Save mix',exact:true}).click()
  await library.waitFor({state:'hidden'})
 }
 await page.locator('input[aria-label="Choose a Mix Room backup"]').setInputFiles({name:'track.mixroom',mimeType:'application/octet-stream',buffer:Buffer.from(base64,'base64')})
 await page.getByRole('heading',{name:'Older mix',exact:true}).waitFor()
 await page.getByRole('button',{name:'Save mix',exact:true}).click()
 library=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
 await library.getByText(/3 of 3 saved/).waitFor()
 const first=(await repository.list(owner)).find(row=>row.name==='Saved original')
 await library.getByLabel('Save to',{exact:true}).selectOption('replace:'+first.id)
 await library.getByLabel('Mix name',{exact:true}).fill('Replacement')
 await library.getByRole('button',{name:'Replace selected mix…',exact:true}).click()
 await library.waitFor({state:'hidden'})
 assert.equal((await repository.list(owner)).length,3)
 assert.equal((await repository.get(owner,first.id)).revision,first.revision+1)
 console.log('PASS three-mix capacity and confirmed replacement keep stable identity')
 await page.locator('.account-access').click()
 assert.equal(await page.getByRole('dialog').getByRole('button',{name:'My mixes',exact:true}).count(),0)
 await page.screenshot({path:path.join(artifacts,'account-desktop.png')})
 await page.getByRole('button',{name:'Close account page',exact:true}).click()
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 library=page.getByRole('region',{name:'My mixes',exact:true})
 await library.getByRole('button',{name:'Rename Replacement',exact:true}).click()
 await library.getByLabel('New name',{exact:true}).fill('Renamed mix')
 await library.getByRole('button',{name:'Rename mix',exact:true}).click()
 await library.getByRole('heading',{name:'Renamed mix',exact:true}).waitFor()
 await library.getByRole('button',{name:'Delete Saved 2',exact:true}).click()
 await library.getByText(/2 of 3 saved/).waitFor()
 await page.screenshot({path:path.join(artifacts,'my-mixes-desktop.png')})
 for(const viewport of [{width:390,height:844},{width:844,height:390},{width:320,height:568}]){
  await resize(viewport)
  assert.equal(await library.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true)
  await page.getByRole('button',{name:'Close mix library',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(artifacts,`my-mixes-${viewport.width}.png`)})
 }
 await resize({width:1440,height:950})
 await library.getByRole('button',{name:'Close mix library',exact:true}).click()
 // Saving pending names before opening another saved mix must finish the first
 // save and then open the selected mix with fresh form state, even for copies.
 await page.getByRole('button',{name:'EDITOR',exact:true}).click()
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).fill('Pending title')
 await page.locator('.mix-room__content-overlay--editor').getByLabel('Instrument name',{exact:true}).first().fill('Pending instrument')
 await page.getByRole('tab',{name:'My mixes',exact:true}).click()
 library=page.getByRole('region',{name:'My mixes',exact:true})
 await library.getByRole('button',{name:'Open Saved 3',exact:true}).click()
 await page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Keep your changes?',exact:true})}).getByRole('button',{name:'Save and continue',exact:true}).click()
 library=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
 await library.getByLabel('Mix name',{exact:true}).fill('Saved before switch')
 await library.getByRole('button',{name:'Save mix',exact:true}).click()
 await page.getByRole('heading',{name:'Saved 3',exact:true}).waitFor()
 await page.getByRole('button',{name:'EDITOR',exact:true}).click()
 assert.equal(await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).inputValue(),'Saved 3')
 assert.equal(await page.locator('.mix-room__content-overlay--editor').getByLabel('Instrument name',{exact:true}).first().inputValue(),meta.instruments[0].label)
 assert.equal((await repository.list(owner)).length,2)
 console.log('PASS save-before-open resumes the selected mix and clears staged form names')
 // Imported draft must be guarded on sign-out. Cancel keeps it and the session.
 await page.locator('input[aria-label="Choose a Mix Room backup"]').setInputFiles({name:'track.mixroom',mimeType:'application/octet-stream',buffer:Buffer.from(base64,'base64')})
 await page.getByRole('heading',{name:'Older mix',exact:true}).waitFor()
 await page.locator('.account-access').click();account=page.getByRole('region',{name:'Account',exact:true})
 await account.getByRole('button',{name:'Sign out',exact:true}).click()
 let guard=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Keep your changes?',exact:true})})
 await guard.getByRole('button',{name:'Cancel',exact:true}).click()
 assert.equal(await account.isVisible(),true)
 await account.getByRole('button',{name:'Sign out',exact:true}).click()
 await guard.getByRole('button',{name:'Save and continue',exact:true}).click()
 library=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
 await library.getByText(/2 of 3 saved/).waitFor()
 await library.getByLabel('Mix name',{exact:true}).fill('Before sign out')
 await library.getByRole('button',{name:'Save mix',exact:true}).click()
 await page.getByRole('heading',{name:'Welcome to Mix Room'}).waitFor()
 assert.equal(await page.locator('audio').getAttribute('src'),null)
 console.log('PASS rename/delete, unsaved-cancel, sign-out clears private playback')
 assert.deepEqual(errors,[])
 await page.screenshot({path:path.join(artifacts,'workspace-desktop.png')})
 for(const viewport of [{width:390,height:844},{width:844,height:390}]){await resize(viewport);await page.screenshot({path:path.join(artifacts,`opening-${viewport.width}.png`)});await page.getByRole('button',{name:'Play tutorial',exact:true}).click();await page.getByRole('heading',{name:'Demon Seed',exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'Welcome to Mix Room'}).waitFor()}
 console.log('PASS desktop and phone opening/demo; all data and Auth confined to isolated fixtures')
}finally{await browser?.close();await db.close();await preview.close()}
