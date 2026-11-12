import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { chromium, firefox, webkit } from 'playwright'

// Production files, disposable browser profiles and intercepted Auth only.
const root = fileURLToPath(new URL('../',import.meta.url)), dist = path.join(root,'dist')
const engine = process.env.MIX_ROOM_BROWSER_ENGINE || 'chromium'
const artifacts = process.env.MIX_ROOM_EMAIL_ARTIFACTS || path.join(os.tmpdir(),'mix-room-email-page',engine)
const authOrigin = new URL(process.env.VITE_SUPABASE_URL).origin
const tokenHash = 'a'.repeat(56)
const user = { id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.com',email_confirmed_at:'2026-10-24T12:00:00Z',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{} }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:user.id,aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600})}.Zml4dHVyZQ`
const session = { access_token:jwt,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user }
const policy = (await readFile(path.join(dist,'_headers'),'utf8')).split('\n').filter(line=>/^  \S/.test(line)).map(line=>{const at=line.indexOf(':');return[line.slice(0,at).trim(),line.slice(at+1).trim()]})
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.ttf':'font/ttf'}
const observedHTTP=[], results=[], errors=[], leaks=[]
// WebKit's screenshot utility injects an inline stylesheet. Keep strict CSP
// checks active there; capture the visual evidence in Chromium/Firefox.
const screenshot = (page, options) => engine === 'webkit' ? Promise.resolve() : page.screenshot({...options,caret:'initial'})
await mkdir(artifacts,{recursive:true})
const server = createServer(async(req,res)=>{
  try {
    observedHTTP.push(req.url)
    let name=decodeURIComponent(new URL(req.url,'http://fixture.invalid').pathname)
    if(name.endsWith('/'))name+='index.html'
    const file=path.resolve(dist,'.'+name)
    assert.ok(file.startsWith(dist+path.sep))
    const data=await readFile(file)
    if(name.startsWith('/auth/confirm/'))for(const [key,value]of policy)res.setHeader(key,value)
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data)
  }catch{res.statusCode=404;res.end('Not found')}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin='http://127.0.0.1:'+server.address().port
let browser
async function scenario(label,run,{handler,viewport={width:1100,height:800}}={}) {
  const context=await browser.newContext({viewport,serviceWorkers:'block',reducedMotion:'reduce'})
  const requests=[], localErrors=[]
  await context.addInitScript(()=>{if(location.protocol==='http:'){localStorage.setItem('sb-existing-account-auth-token','existing account must remain');sessionStorage.setItem('mix-room-unsaved-marker','existing draft must remain')}})
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url())
    if(url.origin===origin)return route.continue()
    if(url.origin!==authOrigin){leaks.push(url.hostname);return route.abort()}
    const item={path:url.pathname.replace('/auth/v1',''),method:req.method(),body:req.postDataJSON()}
    requests.push(item)
    assert.equal(req.headers().referer,undefined,'Auth requests do not include URL referrers')
    const override=await handler?.(item,requests)
    if(override?.abort)return route.abort()
    return route.fulfill({status:override?.status||200,headers:{'X-Supabase-Api-Version':'2024-01-01'},json:override?.body??(item.path==='/verify'?session:item.path==='/user'?user:{})})
  })
  const page=await context.newPage();page.setDefaultTimeout(12000)
  page.on('pageerror',error=>localErrors.push(error.message))
  page.on('console',entry=>{if(entry.type()==='error'&&/Content Security Policy|violates.*policy|Refused to (load|execute|connect)/i.test(entry.text()))localErrors.push(entry.text())})
  const visit=async(kind='signup',hash=tokenHash,extra='')=>{
    await page.goto('about:blank')
    const response=await page.goto(`${origin}/auth/confirm/#type=${kind}&token_hash=${hash}${extra}`)
    await page.getByRole('heading',{level:1}).waitFor()
    await page.waitForFunction(()=>document.activeElement?.id==='email-title')
    assert.equal(new URL(page.url()).hash,'');assert.equal(new URL(page.url()).search,'')
    assert.equal(response.headers()['referrer-policy'],'no-referrer')
    assert.equal(response.headers()['cache-control'],'no-store')
    assert.match(response.headers()['content-security-policy'],/script-src 'self'/)
  }
  try {
    await run({page,requests,visit})
    assert.equal(await page.evaluate(()=>localStorage.getItem('sb-existing-account-auth-token')),'existing account must remain')
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('mix-room-unsaved-marker')),'existing draft must remain')
    assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),['sb-existing-account-auth-token'],'The isolated client does not persist new credentials')
    assert.deepEqual(localErrors,[])
    results.push({check:label,passed:true});console.log('PASS '+label)
  }catch(error){results.push({check:label,passed:false});await screenshot(page,{path:path.join(artifacts,'failure.png'),fullPage:true});throw error}
  finally{errors.push(...localErrors);await context.close()}
}
try {
  browser=await ({chromium,firefox,webkit}[engine]).launch({...(engine==='chromium'?{channel:'chrome'}:{}),headless:true})
  await scenario('Opening and reload never consume a token; proof is removed before interaction',async({page,requests,visit})=>{
    await visit();assert.equal(requests.length,0)
    assert.equal((await page.locator('body').textContent()).includes(tokenHash),false)
    await screenshot(page,{path:path.join(artifacts,'confirmation-desktop.png')})
    await page.reload();await page.getByRole('heading',{name:'Let’s get you back in',exact:true}).waitFor();assert.equal(requests.length,0)
  })
  await scenario('Explicit confirmation is verified once and leaves the existing account/draft untouched',async({page,requests,visit})=>{
    await visit();await page.keyboard.press('Tab')
    await page.getByRole('button',{name:'Confirm email',exact:true}).click()
    await page.getByRole('heading',{name:'Email confirmed',exact:true}).waitFor()
    assert.equal(requests.filter(r=>r.path==='/verify').length,1)
    assert.equal(requests.find(r=>r.path==='/verify').body.type,'signup')
    assert.equal(await page.getByRole('link',{name:/Open Mix Room/}).getAttribute('href'),'/')
    await screenshot(page,{path:path.join(artifacts,'confirmation-success.png')})
  })
  await scenario('A second link opened in the same tab replaces the previous flow without consuming either token',async({page,requests,visit})=>{
    await visit()
    await page.goto(`${origin}/auth/confirm/#type=recovery&token_hash=${'b'.repeat(64)}`)
    await page.getByRole('heading',{name:'Choose a new password',exact:true}).waitFor()
    await page.waitForFunction(()=>location.hash==='')
    assert.equal(requests.length,0)
  })
  await scenario('Recovery validates matching passwords before consuming a link, then updates once',async({page,requests,visit})=>{
    await visit('recovery');assert.equal(requests.length,0)
    await page.getByLabel('New password',{exact:true}).fill('long new fixture password')
    await page.getByLabel('Confirm new password',{exact:true}).fill('different fixture password')
    await page.getByRole('button',{name:'Update password',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'do not match'}).waitFor();assert.equal(requests.length,0)
    await page.getByLabel('Confirm new password',{exact:true}).fill('long new fixture password')
    await page.getByRole('button',{name:'Show passwords',exact:true}).click()
    assert.equal(await page.getByLabel('New password',{exact:true}).getAttribute('type'),'text')
    await page.getByRole('button',{name:'Update password',exact:true}).click()
    await page.getByRole('heading',{name:'Password updated',exact:true}).waitFor()
    assert.equal(requests.filter(r=>r.path==='/verify').length,1)
    assert.equal(requests.find(r=>r.path==='/verify').body.type,'recovery')
    assert.equal(requests.filter(r=>r.method==='PUT').length,1)
    assert.equal(await page.locator('input').count(),0)
  })
  await scenario('Invalid and unsupported links cannot expose recovery or raw provider errors',async({page,requests,visit})=>{
    await visit('recovery','short');assert.equal(await page.locator('input').count(),0);assert.equal(requests.length,0)
    await visit('magiclink');assert.equal(requests.length,0)
    await visit('signup',tokenHash,'&redirect_to=https://attacker.invalid');assert.equal(requests.length,0)
    await visit();await page.getByRole('button',{name:'Confirm email',exact:true}).click()
    await page.getByRole('heading',{name:'Let’s get you back in',exact:true}).waitFor()
    assert.equal((await page.locator('body').textContent()).includes('private-provider-detail'),false)
  },{handler:item=>item.path==='/verify'?{status:403,body:{code:'otp_expired',msg:'private-provider-detail'}}:undefined})
  let checks=0
  await scenario('Retry after a lost identity check does not verify the single-use link twice',async({page,requests,visit})=>{
    await visit();await page.getByRole('button',{name:'Confirm email',exact:true}).click()
    await page.getByRole('alert').waitFor()
    await page.getByRole('button',{name:'Confirm email',exact:true}).click()
    await page.getByRole('heading',{name:'Email confirmed',exact:true}).waitFor()
    assert.equal(requests.filter(r=>r.path==='/verify').length,1)
  },{handler:item=>item.path==='/user'&&item.method==='GET'&&++checks===1?{abort:true}:undefined})
  for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390}]) {
    await scenario(`Keyboard and recovery layout at ${viewport.width}×${viewport.height}`,async({page,requests,visit})=>{
      await visit('recovery');await page.keyboard.press('Tab')
      assert.equal(await page.getByLabel('New password',{exact:true}).evaluate(el=>document.activeElement===el),true)
      await page.getByRole('button',{name:'Update password',exact:true}).scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      const fits=await page.getByRole('button',{name:'Update password',exact:true}).evaluate(el=>{const box=el.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight+1})
      assert.ok(fits)
      await screenshot(page,{path:path.join(artifacts,`recovery-${viewport.width}.png`),fullPage:true})
      assert.equal(requests.length,0)
    },{viewport})
  }
  assert.ok(observedHTTP.every(url=>!url.includes(tokenHash)),'Fragment proofs never reach the HTTP server')
  assert.ok(observedHTTP.every(url=>!/[.]wav|[.]mp3|three|mediabunny/i.test(url)),'Account links do not load audio or the room bundle')
  assert.deepEqual(leaks,[])
  const main=await fetch(origin+'/').then(r=>r.text())
  assert.match(main,/<title>Mix Room<\/title>/)
  const asset=main.match(/src="([^"]+[.]js)"/)?.[1];assert.ok(asset)
  assert.ok((await stat(path.join(dist,asset))).size>0)
} finally {
  await browser?.close();await new Promise(resolve=>server.close(resolve))
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({engine,productionBuild:true,realAuthRequests:0,realEmailsSent:0,results,errors,leaks},null,2)+'\n')
}
