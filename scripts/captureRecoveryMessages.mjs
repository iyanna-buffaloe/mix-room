import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { mkdir,writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createMixArchive } from '../src/audio/mixArchive.js'
import { encodeSeparationWav } from '../shared/separationAudio.js'
import { createMixService } from '../server/mixes/service.js'

// Generates actual product messages with disposable browser/API/storage fixtures.
// No test hook is shipped in the website and no real service is contacted.
const root=fileURLToPath(new URL('../',import.meta.url))
const artifacts=process.env.MIX_ROOM_REVIEW_ARTIFACTS||path.join(os.tmpdir(),'mix-room-recovery-review')
await mkdir(artifacts,{recursive:true})
const server=await createServer({configFile:path.join(root,'vite.config.js'),cacheDir:path.join(artifacts,'vite'),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://fixture.supabase.co'),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_fixture')}})
await server.listen()
const origin=server.resolvedUrls.local[0].replace(/\/$/,'')
const owner=randomUUID(), user={id:owner,email:'review@example.com',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},email_confirmed_at:'2026-10-26T12:00:00Z'}
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url')
const jwt=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:owner,aud:'authenticated',exp:Math.floor(Date.now()/1000)+86400})}.Zml4dHVyZQ`
const session={access_token:jwt,refresh_token:'fixture-refresh',expires_in:86400,expires_at:Math.floor(Date.now()/1000)+86400,token_type:'bearer',user}
const archive=createMixArchive({version:1,id:randomUUID(),metadata:{title:'Review mix',duration:1,processingMode:'stems',instruments:[{key:'guitar',label:'Guitar',freq:.4,pan:.2,width:.3}]},framesByKey:{guitar:[{t:0,loud:.5,pan:.2},{t:1,loud:.5,pan:.2}]},audioBlob:new Blob([encodeSeparationWav(new Float32Array(44100))],{type:'audio/wav'})})
const archiveBytes=Buffer.from(await archive.arrayBuffer())
const scenarios=[['interrupted','Interrupted file upload'],['rejected','File storage rejects the upload'],['unavailable','Saving is unavailable'],['expired','Session expired while saving'],['conflict','Another device changed the saved mix']]
const results=[],leaks=[]
let browser
try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--mute-audio']})
  for(const [kind,title]of scenarios){
    let inject=false
    const config={available:true,limit:3,maxMixBytes:167772160,maxAccountBytes:503316480}
    const object=randomUUID(), row={id:randomUUID(),owner_id:owner,object_id:object,object_key:`saved/${owner}/${object}.mixroom`,name:'Review mix',bytes:archive.size,revision:1,updated_at:new Date().toISOString()}
    const original={...row}
    const repository={verifyToken:async token=>token===jwt&&!(inject&&kind==='expired')?{id:owner}:null,list:async()=>[{...row}],get:async(_owner,id)=>id===row.id?{...row}:null,beginUpload:async value=>({...value,expires_at:new Date(Date.now()+900000).toISOString()})}
    const storage={downloadUrl:async key=>'https://r2.fixture/'+key,uploadUrl:async key=>'https://r2.fixture/'+key}
    const service=createMixService({config,repository,storage})
    const context=await browser.newContext({viewport:{width:1150,height:984},reducedMotion:'reduce',serviceWorkers:'block'})
    await context.addInitScript(value=>localStorage.setItem('sb-fixture-auth-token',JSON.stringify(value)),session)
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url())
      if(url.origin===origin){
        if(url.pathname.startsWith('/api/mixes')){
          if(inject&&kind==='unavailable')config.available=false
          const response=await service(new Request(req.url(),{method:req.method(),headers:req.headers(),...(!['GET','HEAD'].includes(req.method())?{body:req.postData()||''}:{})}))
          return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()})
        }
        if(url.pathname.startsWith('/api/separation/'))return route.fulfill({json:url.pathname.endsWith('/config')?{available:false,maxSeconds:360}:{scope:'account',remaining:3,stemsRemaining:null}})
        return route.continue()
      }
      if(url.origin==='https://fixture.supabase.co')return route.fulfill({json:url.pathname.endsWith('/user')?user:session,headers:{'X-Supabase-Api-Version':'2024-01-01'}})
      if(url.origin==='https://r2.fixture'){
        if(req.method()==='GET')return route.fulfill({contentType:'application/octet-stream',body:archiveBytes})
        if(inject&&kind==='interrupted')return route.abort()
        if(inject&&kind==='rejected')return route.fulfill({status:503,body:'Fixture storage rejection'})
        throw Error('Unexpected fixture storage write')
      }
      leaks.push(url.hostname);return route.abort()
    })
    const page=await context.newPage();page.setDefaultTimeout(20000)
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto(origin)
    await page.getByRole('button',{name:'My mixes',exact:true}).click()
    await page.getByRole('button',{name:'Open Review mix',exact:true}).click()
    await page.getByRole('heading',{name:'Review mix',exact:true,level:2}).waitFor()
    await page.getByRole('button',{name:'EDITOR',exact:true}).click()
    await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title',{exact:true}).fill('My current edits')
    inject=kind==='unavailable'
    await page.getByRole('button',{name:'Save mix',exact:true}).click()
    const dialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Save mix',exact:true})})
    if(kind==='unavailable')await dialog.getByRole('status').filter({hasText:'Mix saving is unavailable'}).waitFor()
    else{
      await dialog.getByText(/1 of 3 saved/).waitFor()
      inject=true
      if(kind==='conflict'){row.revision=2;row.name='Other device version'}
      await dialog.getByRole('button',{name:'Save mix',exact:true}).click()
      await dialog.getByRole('alert').waitFor()
    }
    const message=await dialog.locator(kind==='unavailable'?'[role="status"]':'[role="alert"]').filter({hasText:kind==='unavailable'?'Mix saving is unavailable':/.+/}).textContent()
    assert.ok(message?.trim())
    if(kind!=='conflict')assert.deepEqual(row,original,'The previous saved fixture stays intact')
    assert.deepEqual(errors,[])
    const file=`${kind}.png`
    await page.screenshot({path:path.join(artifacts,file)})
    results.push({kind,title,file,message:message.trim(),simulated:true});console.log('CAPTURED '+title)
    await context.close()
  }
  assert.deepEqual(leaks,[])
}finally{
  await browser?.close();await server.close()
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({fixtureOnly:true,realAccounts:0,emails:0,paidJobs:0,results,leaks},null,2)+'\n')
}
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')
await writeFile(path.join(artifacts,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mix Room — Message review</title><style>:root{--bg:#07111e;--panel:#10273c;--text:#eaf3f8;--muted:#b2c6d3;--accent:#a6e5ef;--border:#58798e;color-scheme:dark;font:18px/1.5 Arial,sans-serif;background:var(--bg);color:var(--text)}body{max-width:1150px;margin:auto;padding:24px}nav{display:flex;flex-wrap:wrap;gap:12px;position:sticky;top:0;background:var(--bg);padding:12px 0}a{color:var(--accent)}article{margin:32px 0;padding:20px;background:var(--panel);border:1px solid var(--border);border-radius:10px;scroll-margin-top:80px}p{color:var(--muted)}img{display:block;width:100%;height:auto;border:1px solid var(--border)}blockquote{margin:16px 0;padding:16px;border-left:3px solid var(--accent);font-size:20px}</style><h1>Recovery messages to review</h1><p>These are actual app screens captured with simulated failures and synthetic data. No service outage, account or credit was used. Comment on the screenshot or the message underneath it; include the case number.</p><nav>${results.map((r,i)=>`<a href="#${r.kind}">${i+1}. ${escape(r.title)}</a>`).join('')}</nav>${results.map((r,i)=>`<article id="${r.kind}"><h2>${i+1}. ${escape(r.title)}</h2><a href="${r.file}">Open full screenshot</a><img src="${r.file}" alt="Actual Mix Room screen for ${escape(r.title)}"><blockquote>${escape(r.message)}</blockquote></article>`).join('')}</html>`)
