import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createMixArchive } from '../src/audio/mixArchive.js'
import { encodeSeparationWav } from '../shared/separationAudio.js'

// Local fixtures only. Real encoder quality is covered separately by checkDesign.
const root=fileURLToPath(new URL('../',import.meta.url))
const artifacts=process.env.MIX_ROOM_BROWSER_ARTIFACTS||path.join(os.tmpdir(),'mix-room-protected-actions')
await mkdir(artifacts,{recursive:true})
const server=await createServer({configFile:path.join(root,'vite.config.js'),logLevel:'error',cacheDir:path.join(artifacts,'vite'),server:{host:'127.0.0.1',port:0,hmr:false},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://fixture.supabase.co'),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_fixture')}})
await server.listen()
const origin=server.resolvedUrls.local[0].replace(/\/$/,'')
const user={id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.com',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},email_confirmed_at:'2026-10-26T12:00:00Z',created_at:'2026-10-26T12:00:00Z',identities:[]}
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url')
const token=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:user.id,aud:'authenticated',exp:Math.floor(Date.now()/1000)+86400})}.Zml4dHVyZQ`
const session={access_token:token,refresh_token:'fixture-refresh',expires_in:86400,token_type:'bearer',user}
const wav=Buffer.from(encodeSeparationWav(new Float32Array(44100*2)))
const archive=Buffer.from(await createMixArchive({version:1,id:randomUUID(),metadata:{title:'Protected scratch mix',duration:2,processingMode:'stems',instruments:[{key:'tone',label:'Edited tone',freq:.4,pan:0,width:.2,active:true}]},framesByKey:{tone:[{t:0,loud:.5,pan:0},{t:2,loud:.5,pan:0}]},audioBlob:new Blob([wav],{type:'audio/wav'})},{settings:{roomStyle:'dark'},visibility:{tone:true}}).arrayBuffer())
const results=[], leaks=[]
let browser
const pass=name=>{results.push({name,passed:true});console.log('PASS '+name)}
try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--mute-audio']})
  for(const viewport of [{width:1440,height:950},{width:390,height:844}]){
    const context=await browser.newContext({viewport,reducedMotion:'reduce',serviceWorkers:'block'})
    const requests=[],errors=[]
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url())
      if(url.origin===origin){
        if(url.pathname==='/src/hooks/useVideoDownload.js'){
          const response=await route.fetch(),body=await response.text(),marker='const downloadVideo = async () => {'
          assert.ok(body.includes(marker),'Export test seam must match the source')
          return route.fulfill({response,body:body.replace(marker,marker+' window.__fixtureExports=(window.__fixtureExports||0)+1; await new Promise(resolve=>setTimeout(resolve,200)); return;')})
        }
        if(!url.pathname.startsWith('/api/'))return route.continue()
        requests.push({path:url.pathname,method:req.method()})
        const signedIn=Boolean(req.headers()['x-mix-room-account'])
        const body=url.pathname==='/api/separation/config'?{available:true,maxSeconds:360,monthlyJobs:25}
          // This scenario exercises a guest whose one audio trial is exhausted.
          :url.pathname==='/api/separation/credits'?{scope:signedIn?'account':'guest',limit:signedIn?3:1,remaining:signedIn?3:0,stemsRemaining:signedIn?null:1}
            :url.pathname==='/api/mixes/config'?{available:false,limit:3}:{}
        if(req.method()!=='GET'&&url.pathname.startsWith('/api/mixes'))throw new Error('Sign-in/download must never save')
        return route.fulfill({json:body})
      }
      if(url.origin==='https://fixture.supabase.co'){
        if(url.pathname.endsWith('/token')&&req.postDataJSON()?.password==='incorrect password')return route.fulfill({status:400,json:{code:'invalid_credentials',msg:'Invalid login credentials'}})
        if(url.pathname.endsWith('/signup'))return route.fulfill({json:{user:{...user,email_confirmed_at:undefined},session:null}})
        return route.fulfill({json:url.pathname.endsWith('/user')?user:url.pathname.endsWith('/logout')?{}:session,headers:{'X-Supabase-Api-Version':'2024-01-01'}})
      }
      leaks.push(url.hostname);return route.abort()
    })
    const page=await context.newPage();page.setDefaultTimeout(20000)
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept())
    await page.goto(origin)
    await page.getByRole('heading',{name:'Welcome to Mix Room',exact:true}).waitFor()
    await page.getByLabel('Choose a Mix Room backup',{exact:true}).setInputFiles({name:'scratch.mixroom',mimeType:'application/octet-stream',buffer:archive})
    await page.getByRole('heading',{name:'Protected scratch mix',exact:true}).waitFor()
    const audio=await page.locator('audio').getAttribute('src')
    const download=page.getByRole('button',{name:'Sign in to download',exact:true})
    await page.screenshot({path:path.join(artifacts,`guest-${viewport.width}.png`)})
    await download.click()
    const dialog=page.locator('.account-dialog--access')
    await dialog.waitFor();await page.keyboard.press('Escape')
    assert.equal(await page.locator('audio').getAttribute('src'),audio)
    assert.equal(await page.evaluate(()=>window.__fixtureExports||0),0)
    if(viewport.width>600)await page.getByRole('tab',{name:'Upload tracks',exact:true}).click()
    else await page.getByRole('button',{name:'Upload tracks',exact:true}).click()
    await page.getByLabel('Choose audio file',{exact:true}).setInputFiles({name:'Selected song.wav',mimeType:'audio/wav',buffer:wav})
    await page.getByRole('button',{name:'Sign in for more analyses',exact:true}).click()
    await dialog.getByLabel('Email',{exact:true}).fill(user.email)
    await dialog.getByLabel('Password',{exact:true}).fill('incorrect password')
    await dialog.getByRole('button',{name:'Sign in',exact:true}).click()
    await dialog.getByRole('alert').waitFor()
    assert.equal(requests.some(r=>r.path.includes('/jobs')),false)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('#selected-filename').textContent(),'Selected song.wav')
    assert.equal(await page.locator('audio').getAttribute('src'),audio)
    pass(`Guest cancellation and failed login retain the selected file and edited mix at ${viewport.width}px`)
    await page.getByRole('button',{name:'Sign in for more analyses',exact:true}).click()
    await dialog.getByLabel('Email',{exact:true}).fill(user.email)
    await dialog.getByLabel('Password',{exact:true}).fill('correct fixture password')
    await dialog.getByRole('button',{name:'Sign in',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('.account-dialog--access')?.open)
    await page.getByRole('button',{name:'Analyze audio file',exact:true}).waitFor()
    assert.equal(await page.locator('#selected-filename').textContent(),'Selected song.wav')
    assert.equal(await page.locator('audio').getAttribute('src'),audio)
    assert.equal(requests.some(r=>r.path.includes('/jobs')),false,'Login returns to Upload, never starts paid work automatically')
    await page.waitForFunction(()=>document.activeElement?.id==='song-upload-submit')
    pass(`Upload returns to the explicit action without spending credits at ${viewport.width}px`)
    await page.locator('#video-download').evaluate(el=>{el.click();el.click()})
    await page.waitForFunction(()=>window.__fixtureExports===1)
    await page.waitForFunction(()=>!document.querySelector('#video-download')?.disabled)
    assert.equal(await page.evaluate(()=>window.__fixtureExports),1)
    assert.equal(requests.some(r=>r.path.startsWith('/api/mixes')&&r.method!=='GET'),false)
    assert.equal(await page.locator('audio').getAttribute('src'),audio)
    await page.screenshot({path:path.join(artifacts,`signed-in-${viewport.width}.png`)})
    pass(`Signed-in download starts once with cloud storage unavailable and no save at ${viewport.width}px`)
    // Sign out in a separate tab, leaving this guest-origin scratch mix intact.
    const other=await context.newPage();await other.goto(origin+'/auth/confirm/')
    await other.evaluate(async()=>{const {getAccountConnection}=await import('/src/auth/supabase.js');const s=getAccountConnection().session;await s.start();await s.signOut()})
    await download.waitFor()
    await download.click()
    await dialog.getByRole('button',{name:'Create account',exact:true}).click()
    await dialog.getByLabel('Email',{exact:true}).fill(user.email)
    await dialog.getByLabel('Password',{exact:true}).fill('new signup fixture password')
    await dialog.getByRole('button',{name:'Create account',exact:true}).click()
    await dialog.getByRole('button',{name:'Back to sign in',exact:true}).waitFor()
    await other.evaluate(async()=>{const {getAccountConnection}=await import('/src/auth/supabase.js');await getAccountConnection().session.signIn('fixture@example.com','correct fixture password')})
    await page.waitForFunction(()=>!document.querySelector('.account-dialog--access')?.open)
    await page.getByRole('button',{name:'Download room video',exact:true}).waitFor()
    assert.equal(await page.locator('audio').getAttribute('src'),audio)
    assert.equal(await page.evaluate(()=>window.__fixtureExports),1,'Other-tab confirmation/login cannot auto-export')
    await page.waitForFunction(()=>document.activeElement?.id==='video-download')
    pass(`Signup followed by another-tab sign-in restores the same download action at ${viewport.width}px`)
    assert.deepEqual(errors,[])
    await context.close()
  }
  assert.deepEqual(leaks,[])
}catch(error){
  for(const context of browser?.contexts()||[])await context.pages()[0]?.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{})
  throw error
}finally{
  await browser?.close();await server.close()
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({fixtureOnly:true,realEmails:0,realPaidJobs:0,encoderMocked:true,results,leaks},null,2)+'\n')
}
