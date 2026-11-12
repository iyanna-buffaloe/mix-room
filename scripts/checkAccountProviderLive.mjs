import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createAccountSession } from '../src/auth/accountSession.js'

// Only this run's disposable account is changed. Administrative generated
// links exercise real confirmation/recovery without sending SMTP messages.
if (!process.argv.includes('--live')) throw new Error('Use --live for the disposable real-provider account check. No email is sent.')
const env = process.env
assert.ok(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SECRET_KEY, 'Real account-test configuration is required')
const origin = new URL(env.MIX_ROOM_LIVE_ORIGIN || 'https://mixroom.click').origin
assert.ok(['https://mixroom.click', 'https://mixingvisualizer.netlify.app', 'https://friday-integration--mixingvisualizer.netlify.app'].includes(origin), 'Use a known Mix Room HTTPS origin')
const artifacts = env.MIX_ROOM_AUTH_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-account-provider-check')
await mkdir(artifacts, { recursive: true })
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }) } }
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY, options)
const primary = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, options)
const independent = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, options)
const check = result => { if (result.error) throw Object.assign(new Error('Provider check failed'), { code: result.error.code }); return result.data }
const results = []
const observed = []
let id, controller, browser, phase = 'Create a disposable unconfirmed account', failed = false, cleanup = false
const pass = () => { results.push({ check: phase, passed: true }); console.log('PASS '+phase) }
const generated = async (type, email, password) => {
  const data = check(await admin.auth.admin.generateLink({ type, email, ...(password ? { password } : {}), options: { redirectTo: origin+'/' } }))
  assert.equal(data.user.id, id)
  assert.equal(new URL(data.properties.action_link).searchParams.get('redirect_to'), origin+'/')
  return data.properties.hashed_token
}
try {
  const email = `mix-room-friday-${randomUUID()}@example.com`
  const password = randomBytes(32).toString('base64url')
  const nextPassword = randomBytes(32).toString('base64url')
  const recoveredPassword = randomBytes(32).toString('base64url')
  id = check(await admin.auth.admin.createUser({ email, password, email_confirm: false, user_metadata: { purpose: 'disposable-friday-account-check' } })).user.id
  controller = createAccountSession(primary.auth, { redirectTo: origin+'/' })
  await controller.start()
  phase = 'Unconfirmed account cannot sign in'
  const unconfirmed = await primary.auth.signInWithPassword({ email, password })
  assert.equal(unconfirmed.error?.code, 'email_not_confirmed')
  assert.equal(controller.getSnapshot().status, 'guest')
  pass()

  phase = 'Generated signup confirmation uses the allowed public return URL and confirms the account'
  const signup = await generated('signup', email, password)
  check(await primary.auth.verifyOtp({ token_hash: signup, type: 'signup' }))
  assert.equal(controller.getSnapshot().user.id, id)
  assert.equal(controller.getSnapshot().passwordRecovery, false)
  pass()

  phase = 'Used confirmation is rejected without enabling password recovery'
  assert.ok((await primary.auth.verifyOtp({ token_hash: signup, type: 'signup' })).error)
  assert.equal(controller.getSnapshot().passwordRecovery, false)
  pass()

  // Signup confirmation proves inbox ownership and can exempt that temporary
  // session from an old-password prompt. Test settings from an ordinary login.
  check(await primary.auth.signOut({ scope: 'local' }))
  check(await primary.auth.signInWithPassword({ email, password }))
  phase = 'Server requires a current password and rejects passwords shorter than twelve characters'
  const missingCurrent = await primary.auth.updateUser({ password: nextPassword })
  observed.push({ check: 'missing_current_password', accepted: !missingCurrent.error, code: missingCurrent.error?.code, status: missingCurrent.error?.status })
  assert.equal(missingCurrent.error?.code, 'current_password_required')
  const short = await primary.auth.updateUser({ password: randomBytes(8).toString('base64url').slice(0,11), current_password: password })
  observed.push({ check: 'short_password', accepted: !short.error, code: short.error?.code, status: short.error?.status })
  assert.equal(short.error?.code, 'weak_password')
  pass()

  phase = 'Wrong current password preserves the valid login and permits correction'
  assert.equal(await controller.changePassword(nextPassword, { currentPassword: 'incorrect-current-password' }), false)
  assert.equal(controller.getSnapshot().status, 'signed-in')
  assert.ok(['current_password_invalid', 'current_password_mismatch'].includes(controller.getSnapshot().errorCode))
  pass()

  phase = 'Correct current password updates once; old password fails and new password signs in'
  assert.equal(await controller.changePassword(nextPassword, { currentPassword: password }), true)
  assert.equal((await independent.auth.signInWithPassword({ email, password })).error?.code, 'invalid_credentials')
  assert.equal(check(await independent.auth.signInWithPassword({ email, password: nextPassword })).user.id, id)
  pass()

  phase = 'Ordinary sign-in cannot use the recovery-only password update'
  assert.equal(await controller.updatePassword(recoveredPassword), false)
  pass()

  phase = 'Generated recovery uses the public return URL and enables the recovery form'
  const recovery = await generated('recovery', email)
  check(await primary.auth.signOut({ scope: 'local' }))
  check(await primary.auth.verifyOtp({ token_hash: recovery, type: 'recovery' }))
  assert.equal(controller.getSnapshot().passwordRecovery, true)
  assert.equal(controller.getSnapshot().user.id, id)
  pass()

  phase = 'Recovery changes the password without an old-password prompt; final sign-in works'
  assert.equal(await controller.updatePassword(recoveredPassword), true)
  assert.equal(controller.getSnapshot().passwordRecovery, false)
  assert.equal((await independent.auth.signInWithPassword({ email, password: nextPassword })).error?.code, 'invalid_credentials')
  assert.equal(check(await independent.auth.signInWithPassword({ email, password: recoveredPassword })).user.id, id)
  pass()

  phase = 'Used and invalid recovery links cannot re-enable password recovery'
  assert.ok((await primary.auth.verifyOtp({ token_hash: recovery, type: 'recovery' })).error)
  assert.ok((await primary.auth.verifyOtp({ token_hash: randomBytes(32).toString('hex'), type: 'recovery' })).error)
  assert.equal(controller.getSnapshot().passwordRecovery, false)
  assert.equal(await controller.updatePassword(nextPassword), false)
  pass()

  if (process.argv.includes('--browser')) {
    phase = 'Actual hosted recovery redirect opens the reset form and removes URL credentials'
    const { chromium } = await import('playwright')
    const reset = check(await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: origin+'/' } }))
    assert.equal(reset.user.id, id)
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--mute-audio'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    // No processing submissions or allowance consumption in account tests.
    await context.route('**/api/separation/**', route => route.fulfill({ json: route.request().url().endsWith('/config') ? { available:false,maxSeconds:360 } : { remaining:3,stemsRemaining:null,scope:'account' } }))
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on('response',async response=>{
      if(response.request().method()==='PUT' && new URL(response.url()).pathname==='/auth/v1/user'){
        const body=await response.json().catch(()=>null)
        observed.push({check:'hosted_password_update',status:response.status(),...(typeof body?.code==='string' && /^[a-z_]+$/.test(body.code)?{code:body.code}:{})})
      }
    })
    await page.goto(reset.properties.action_link)
    await page.getByRole('heading',{name:'Choose a new password',exact:true}).waitFor()
    const location = new URL(page.url())
    assert.equal(location.origin,origin)
    assert.equal(location.hash,'')
    assert.equal(location.search,'')
    pass()

    phase = 'Actual hosted recovery form updates the disposable password and final sign-in succeeds'
    const browserPassword = randomBytes(32).toString('base64url')
    await page.getByLabel('New password',{exact:true}).fill(browserPassword)
    await page.getByRole('button',{name:'Update password',exact:true}).click()
    await page.getByRole('heading',{name:'Password updated',exact:true}).waitFor()
    assert.equal(check(await independent.auth.signInWithPassword({email,password:browserPassword})).user.id,id)
    await page.getByRole('button',{name:'Back to the room',exact:true}).click()
    pass()

    phase = 'Hosted Verify email accepts a real OTP without replacing the active browser login'
    const otp = check(await admin.auth.admin.generateLink({type:'magiclink',email}))
    assert.equal(otp.user.id,id)
    // The send request alone is a fixture: generation replaces SMTP delivery.
    // The entered code, /verify call, app gate and isolated-session logout are real.
    await context.route(env.VITE_SUPABASE_URL+'/auth/v1/otp', route => route.fulfill({json:{},headers:{'X-Supabase-Api-Version':'2024-01-01'}}))
    await page.getByRole('button',{name:'Account',exact:true}).click()
    const account = page.getByRole('region',{name:'Account',exact:true})
    assert.equal(await account.getByLabel('New email address',{exact:true}).count(),0)
    await account.getByRole('button',{name:'Verify email',exact:true}).click()
    await account.getByLabel('Email verification code',{exact:true}).fill(otp.properties.email_otp)
    await account.getByRole('button',{name:'Confirm code',exact:true}).click()
    await account.getByLabel('New email address',{exact:true}).waitFor()
    await page.getByRole('button',{name:'Close account page',exact:true}).click()
    await page.getByRole('button',{name:'Account',exact:true}).click()
    await account.getByRole('button',{name:'Verify email',exact:true}).waitFor()
    assert.equal(await account.getByLabel('New email address',{exact:true}).count(),0)
    await page.screenshot({path:path.join(artifacts,'hosted-account.png')})
    pass()
  }
} catch (error) {
  failed = true
  const code = /^[a-z_]+$/.test(error.code || '') ? error.code : null
  results.push({ check: phase, passed: false, ...(code ? { code } : {}) })
  console.error(`FAIL ${phase}${code ? ' ('+code+')' : ''}. Credentials, links and provider responses omitted.`)
  const page=browser?.contexts()[0]?.pages()[0]
  if(page){
    await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{})
    observed.push({check:'failure_screen',headings:await page.getByRole('heading').allTextContents().catch(()=>[])})
  }
} finally {
  await browser?.close().catch(()=>{})
  controller?.dispose()
  if (id) { try { cleanup = !(await admin.auth.admin.deleteUser(id)).error } catch { cleanup = false } }
  else cleanup = true
  console.log(cleanup ? 'PASS disposable-account cleanup' : 'FAIL disposable-account cleanup')
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({ checkedAt:new Date().toISOString(), origin, realProvider:true, browserFlows:process.argv.includes('--browser'), otpSendReplacedWithGeneratedCode:process.argv.includes('--browser'), smtpDeliveryTested:false, emailsSent:0, existingAccountsChanged:0, results, observed, cleanup },null,2)+'\n')
}
if (failed || !cleanup) process.exitCode=1
