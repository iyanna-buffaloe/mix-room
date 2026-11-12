import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

// Explicit opt-in: only this run's disposable account. generateLink does not
// send SMTP. Never log provider responses, credentials or token-bearing URLs.
if (!process.argv.includes('--live')) throw new Error('Use --live for disposable-account browser checks. No email is sent.')
const env = process.env
const origin = 'https://friday-integration--mixingvisualizer.netlify.app'
assert.ok(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SECRET_KEY, 'Private test configuration required')
const artifacts = env.MIX_ROOM_EMAIL_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-email-page-live')
await mkdir(artifacts, { recursive: true })
const authOrigin = new URL(env.VITE_SUPABASE_URL).origin
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }) } }
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY, options)
const independent = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, options)
const check = response => { if(response.error)throw Object.assign(new Error('Provider request failed'),{providerCode:response.error.code,providerStatus:response.error.status});return response.data }
const results = [], forbidden = [], responses = []
let browser, id, phase = 'Draft landing response and security headers', cleanup = false, failed = false
const pass = () => { results.push({ check: phase, passed: true }); console.log('PASS '+phase) }
try {
  const response = await fetch(origin+'/auth/confirm/')
  assert.equal(response.status, 200)
  assert.match(await response.text(), /email-title|email-|Account access/)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  pass()
  phase = 'Create one disposable unconfirmed account without SMTP'
  const email = `mix-room-landing-${randomUUID()}@example.com`
  const password = randomBytes(32).toString('base64url'), nextPassword = randomBytes(32).toString('base64url')
  id = check(await admin.auth.admin.createUser({ email, password, email_confirm: false, user_metadata: { purpose: 'disposable-branded-link-check' } })).user.id
  pass()
  const generated = async type => {
    const data = check(await admin.auth.admin.generateLink({ type, email, ...(type==='signup'?{password}:{}), options:{redirectTo:origin+'/'} }))
    assert.equal(data.user.id, id)
    assert.ok(/^(?:[a-f0-9]{56}|[a-f0-9]{64})$/i.test(data.properties.hashed_token), 'Unsupported generated proof format')
    return data.properties.hashed_token
  }
  phase='Launch isolated hosted-link browser'
  browser = await chromium.launch({ channel:'chrome', headless:true })
  const context = await browser.newContext({ viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce' })
  await context.addInitScript(()=>{if(location.protocol==='https:'){localStorage.setItem('existing-account-marker','preserve');sessionStorage.setItem('existing-draft-marker','preserve')}})
  await context.route('**/*', route => {
    const request=route.request(), url=new URL(request.url())
    if (url.origin===authOrigin) {
      assert.equal(request.headers().referer, undefined)
      assert.ok(['/auth/v1/verify','/auth/v1/user','/auth/v1/logout'].includes(url.pathname), 'Only required Auth operations are allowed')
      assert.ok(['GET','POST','PUT'].includes(request.method()))
      return route.continue()
    }
    if (url.origin===origin && request.method()==='GET' && !url.pathname.startsWith('/api/') && !/\.(wav|mp3|m4a)$/i.test(url.pathname)) return route.continue()
    forbidden.push({ host:url.hostname,method:request.method() });return route.abort()
  })
  const page=await context.newPage();page.setDefaultTimeout(30000)
  page.on('response', r=>{const url=new URL(r.url());if(url.origin===authOrigin)responses.push({path:url.pathname,method:r.request().method(),status:r.status()})})
  const visit=async(type,proof)=>{
    const template=await readFile(new URL(`../supabase/templates/prepared/${type==='signup'?'confirmation':'recovery'}-branded.html`,import.meta.url),'utf8')
    const targets=[...template.matchAll(/href="([^"]*TokenHash[^"]*)"/g)].map(([,href])=>href.replaceAll('{{ .SiteURL }}',origin+'/').replaceAll('{{ .TokenHash }}',proof).replaceAll('&amp;','&'))
    assert.equal(targets.length,3)
    assert.ok(targets.every(href=>href===targets[0]),'Button and fallback template links must agree')
    const target=new URL(targets[0]);assert.equal(target.origin,origin);assert.equal(target.pathname,'/auth/confirm/');assert.equal(target.searchParams.size,0)
    await page.goto('about:blank')
    await page.goto(target.href)
    await page.getByRole('heading',{level:1}).waitFor()
    await page.waitForFunction(()=>location.hash===''&&location.search==='')
    assert.equal((await page.locator('body').textContent()).includes(proof),false)
  }
  phase='Generate signup proof without sending SMTP'
  const signup=await generated('signup')
  phase='Opening a real confirmation leaves the account unconfirmed until the button is pressed'
  await visit('signup',signup)
  assert.equal(responses.filter(r=>r.path.endsWith('/verify')).length,0)
  assert.ok(!check(await admin.auth.admin.getUserById(id)).user.email_confirmed_at)
  pass()
  phase='Explicit hosted confirmation verifies a real token and preserves the existing browser session markers'
  await page.getByRole('button',{name:'Confirm email',exact:true}).click()
  await page.getByRole('heading',{name:'Email confirmed',exact:true}).waitFor()
  assert.ok(check(await admin.auth.admin.getUserById(id)).user.email_confirmed_at)
  assert.equal(responses.filter(r=>r.path.endsWith('/verify')).length,1)
  await page.screenshot({path:path.join(artifacts,'live-confirmation-success.png'),fullPage:true})
  pass()
  phase='A consumed real confirmation produces a safe retry screen'
  await visit('signup',signup)
  await page.getByRole('button',{name:'Confirm email',exact:true}).click()
  await page.getByRole('heading',{name:'Let’s get you back in',exact:true}).waitFor()
  pass()
  phase='Hosted recovery verifies a real generated token and updates the password without an old-password prompt'
  const recovery=await generated('recovery')
  const before=responses.filter(r=>r.path.endsWith('/verify')).length
  await visit('recovery',recovery)
  assert.equal(responses.filter(r=>r.path.endsWith('/verify')).length,before)
  await page.getByLabel('New password',{exact:true}).fill(nextPassword)
  await page.getByLabel('Confirm new password',{exact:true}).fill(nextPassword)
  await page.getByRole('button',{name:'Update password',exact:true}).click()
  await page.getByRole('heading',{name:'Password updated',exact:true}).waitFor()
  assert.equal(responses.filter(r=>r.path.endsWith('/verify')).length,before+1)
  assert.equal(responses.filter(r=>r.method==='PUT').length,1)
  await page.screenshot({path:path.join(artifacts,'live-recovery-success.png'),fullPage:true})
  pass()
  phase='Old password fails, new password signs in, and the consumed recovery cannot reopen a reset form'
  assert.equal((await independent.auth.signInWithPassword({email,password})).error?.code,'invalid_credentials')
  assert.equal(check(await independent.auth.signInWithPassword({email,password:nextPassword})).user.id,id)
  await visit('recovery',recovery)
  await page.getByLabel('New password',{exact:true}).fill(randomBytes(32).toString('base64url'))
  await page.getByLabel('Confirm new password',{exact:true}).fill(await page.getByLabel('New password',{exact:true}).inputValue())
  await page.getByRole('button',{name:'Update password',exact:true}).click()
  await page.getByRole('heading',{name:'Let’s get you back in',exact:true}).waitFor()
  assert.equal(responses.filter(r=>r.method==='PUT').length,1)
  assert.equal(await page.evaluate(()=>localStorage.getItem('existing-account-marker')),'preserve')
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('existing-draft-marker')),'preserve')
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),['existing-account-marker'])
  assert.deepEqual(forbidden,[])
  pass()
} catch(error) {
  failed=true;results.push({check:phase,passed:false})
  console.error('FAIL '+phase+'. Private provider data and link credentials omitted.')
  console.error(JSON.stringify({type:error.name,code:/^[a-z_]+$/.test(error.providerCode||'')?error.providerCode:undefined,status:error.providerStatus,assertion:error.code==='ERR_ASSERTION'?error.message.split('\n')[0].slice(0,160):undefined}))
} finally {
  await browser?.close()
  if(id){try{cleanup=!(await admin.auth.admin.deleteUser(id)).error}catch{cleanup=false}}else cleanup=true
  console.log(cleanup?'PASS disposable-account cleanup':'FAIL disposable-account cleanup')
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({checkedAt:new Date().toISOString(),origin,realProvider:true,emailsSent:0,existingAccountsChanged:0,providerSettingsChanged:0,results,responses,forbidden,cleanup},null,2)+'\n')
}
if(failed||!cleanup)process.exitCode=1
