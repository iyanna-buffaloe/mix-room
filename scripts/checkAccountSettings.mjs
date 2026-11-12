import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = process.env.MIX_ROOM_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-account-settings')
await mkdir(artifacts, { recursive: true })
const authOrigin = 'https://fixture.supabase.co'
const authHeaders = { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }
const initialUser = { id: '11111111-1111-4111-8111-111111111111', email: 'listener@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, email_confirmed_at: '2026-10-19T12:00:00Z', created_at: '2026-10-19T12:00:00Z', identities: [] }
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: initialUser.id, aud: 'authenticated', exp: Math.floor(Date.now()/1000)+86400 })}.dGVzdA`
let user = { ...initialUser }, providerError = '', emailSendError = '', requireCode = false, heldUpdate = null
const requests = [], errors = [], leaks = [], passed = []
const server = await createServer({ configFile: path.join(root, 'vite.config.js'), logLevel: 'error', cacheDir: path.join(artifacts, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false }, define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(authOrigin), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('sb_publishable_fixture') } })
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ channel: process.env.MIX_ROOM_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await context.addInitScript(value => {
    localStorage.setItem('sb-fixture-auth-token', JSON.stringify(value))
    const realNow = Date.now; window.fixtureEmailClockOffset = 0
    Date.now = () => realNow() + window.fixtureEmailClockOffset
  }, { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now()/1000)+86400, user })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin) {
      if (!url.pathname.startsWith('/api/')) return route.continue()
      let body = url.pathname.endsWith('/config') ? { available: false, maxSeconds: 360 } : url.pathname.includes('/mixes') ? { mixes: [], limit: 3, maxMixBytes: 167772160, maxAccountBytes: 503316480 } : { scope: 'account', remaining: 3, stemsRemaining: null }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    }
    if (url.origin !== authOrigin) { leaks.push(url.hostname); return route.abort() }
    const body = req.postDataJSON(), record = { method: req.method(), path: url.pathname.replace('/auth/v1', ''), body }
    requests.push(record)
    if (record.path === '/otp' && emailSendError) return route.fulfill({ status: 429, headers: authHeaders, json: { code: emailSendError, msg: 'Fixture send limit' } })
    if (record.path === '/verify') {
      if (body.token !== '123456') return route.fulfill({ status: 403, headers: authHeaders, json: { code: 'otp_expired', msg: 'Fixture invalid code' } })
      return route.fulfill({ headers: authHeaders, json: { access_token: token, refresh_token: 'verification-refresh', token_type: 'bearer', expires_in: 86400, user } })
    }
    if (record.path === '/user' && req.method() === 'PUT') {
      if (heldUpdate) { const gate = heldUpdate; heldUpdate = null; await gate }
      if (providerError) return route.fulfill({ status: providerError === 'session_not_found' ? 401 : 400, contentType: 'application/json', headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }, body: JSON.stringify({ code: providerError, msg: 'Fixture failure' }) })
      if (body.password) {
        if (body.current_password !== 'current password fixture') return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }, body: JSON.stringify({ code: 'current_password_invalid', msg: 'Fixture failure' }) })
        if (requireCode && body.nonce !== '654321') return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }, body: JSON.stringify({ code: body.nonce ? 'reauthentication_not_valid' : 'reauthentication_needed', msg: 'Fixture failure' }) })
      }
      if (body.email) user = { ...user, new_email: body.email }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }, body: JSON.stringify(record.path === '/user' ? user : {}) })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  const section = () => page.getByRole('region', { name: 'Account', exact: true })
  const open = async () => { await page.getByRole('button', { name: 'Account', exact: true }).click(); await section().waitFor() }
  const passwordForm = () => page.getByRole('form', { name: 'Change password', exact: true })
  const advanceEmailClock = async (milliseconds = 61000) => { await page.evaluate(value => { window.fixtureEmailClockOffset += value }, milliseconds) }
  const verifyEmail = async () => {
    await advanceEmailClock()
    await page.getByRole('button', { name: 'Verify email', exact: true }).click()
    await page.getByLabel('Email verification code', { exact: true }).fill('123456')
    await page.getByRole('button', { name: 'Confirm code', exact: true }).click()
    await page.getByLabel('New email address', { exact: true }).waitFor()
  }
  const fillPassword = async (confirm = 'new password fixture', current = 'current password fixture') => {
    await page.getByLabel('Current password', { exact: true }).fill(current)
    await page.getByLabel('New password', { exact: true }).fill('new password fixture')
    await page.getByLabel('Confirm new password', { exact: true }).fill(confirm)
  }
  await page.goto(origin)
  await page.getByRole('button', { name: 'Account', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
  await page.locator('audio[src]').waitFor({ state: 'attached' })
  const audio = await page.locator('audio').getAttribute('src')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 2)
  await open()
  assert.equal(await page.getByRole('dialog').count(), 0)
  const panel = await section().boundingBox(), room = await page.locator('.mix-room__canvas').boundingBox()
  assert.ok(panel.x + panel.width <= room.x, 'account left, live room right without overlap')
  assert.ok(room.width >= 250 && room.width < 700)
  assert.equal(await page.locator('audio').getAttribute('src'), audio)
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.mix-room__canvas canvas')
    const rect = canvas.getBoundingClientRect()
    return Math.abs(canvas.width / devicePixelRatio - rect.width) < 3 && Math.abs(canvas.height / devicePixelRatio - rect.height) < 3
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
  assert.equal(await page.locator('audio').evaluate(el => el.paused), false)
  await page.screenshot({ path: path.join(artifacts, 'account-desktop.png') })
  passed.push('Desktop account page and real room canvas share the workspace; audio source retained')
  const emailForm = page.getByRole('form', { name: 'Change email address', exact: true })
  const updates = () => requests.filter(r => r.method === 'PUT')
  assert.equal(await page.getByLabel('New email address', { exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Verify email', exact: true }).waitFor()
  emailSendError = 'over_email_send_rate_limit'
  await page.getByRole('button', { name: 'Verify email', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'email sending limit' }).waitFor()
  assert.equal(await page.getByLabel('Email verification code', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('New email address', { exact: true }).count(), 0)
  emailSendError = ''; await advanceEmailClock()
  await page.getByRole('button', { name: 'Verify email', exact: true }).click()
  await page.getByLabel('Email verification code', { exact: true }).fill('111111')
  assert.equal(requests.filter(r => r.path === '/otp').at(-1).body.email, initialUser.email)
  assert.equal(requests.filter(r => r.path === '/otp').at(-1).body.create_user, false)
  await page.getByRole('button', { name: 'Confirm code', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'code is invalid or has expired' }).waitFor()
  assert.equal(await page.getByLabel('New email address', { exact: true }).count(), 0)
  assert.equal(await page.locator('.account-page__identity strong').innerText(), initialUser.email)
  await page.getByLabel('Email verification code', { exact: true }).fill('123456')
  await page.getByRole('button', { name: 'Confirm code', exact: true }).click()
  await page.getByLabel('New email address', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Email verification code', { exact: true }).count(), 0)
  assert.equal(await page.locator('.account-page__identity strong').innerText(), initialUser.email)
  assert.ok(requests.some(r => r.path === '/logout'), 'Temporary OTP session was revoked without signing out the active account')
  passed.push('New-address field is locked until a current-inbox OTP succeeds; send limits/wrong codes keep the valid login')
  await advanceEmailClock(300001)
  await page.getByLabel('New email address', { exact: true }).waitFor({ state: 'detached' })
  await verifyEmail()
  await page.getByRole('button', { name: 'Close account page', exact: true }).click(); await open()
  assert.equal(await page.getByLabel('New email address', { exact: true }).count(), 0)
  await verifyEmail()
  passed.push('Email verification expires after five minutes and resets on close/reopen')
  const count = updates().length
  await page.getByLabel('New email address', { exact: true }).fill('not-an-email')
  await emailForm.getByRole('button', { name: 'Change email address', exact: true }).click()
  assert.equal(updates().length, count)
  await page.getByLabel('New email address', { exact: true }).fill('next@example.com')
  await emailForm.getByRole('button', { name: 'Change email address', exact: true }).click()
  await page.getByText('Awaiting confirmation', { exact: true }).waitFor()
  assert.equal(updates().at(-1).body.email, 'next@example.com')
  assert.equal(await page.locator('.account-page__identity strong').innerText(), initialUser.email)
  await page.reload(); await open()
  await page.locator('.account-page__pending').getByText('next@example.com', { exact: true }).waitFor()
  passed.push('Email validation, provider request, old identity during confirmation, pending address after reload')
  providerError = 'email_exists'
  await verifyEmail()
  await page.getByLabel('New email address', { exact: true }).fill('taken@example.com')
  await emailForm.getByRole('button', { name: 'Change email address', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'can’t be used' }).waitFor()
  assert.equal(await page.locator('.account-page__identity strong').innerText(), initialUser.email)
  providerError = ''
  passed.push('Provider rejection leaves the existing identity and pending address intact')
  const passwordFields = [
    ['Current password', 'current password'], ['New password', 'new password'], ['Confirm new password', 'password confirmation'],
  ]
  await fillPassword()
  const beforeReveal = updates().length
  assert.equal(await page.getByRole('button', { name: 'Show passwords', exact: true }).count(), 0)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 744, height: 647 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    for (const [label, description] of passwordFields) {
      const field = page.getByLabel(label, { exact: true })
      const before = await field.inputValue()
      const reveal = page.getByRole('button', { name: `Show ${description}`, exact: true })
      await reveal.click()
      assert.equal(await field.getAttribute('type'), 'text')
      assert.equal(await page.getByRole('button', { name: `Hide ${description}`, exact: true }).getAttribute('aria-pressed'), 'true')
      for (const [other] of passwordFields) if (other !== label) assert.equal(await page.getByLabel(other, { exact: true }).getAttribute('type'), 'password')
      await page.getByRole('button', { name: `Hide ${description}`, exact: true }).press('Enter')
      assert.equal(await field.getAttribute('type'), 'password')
      assert.equal(await field.inputValue(), before)
    }
    assert.equal(await section().evaluate(el => el.scrollWidth > el.clientWidth), false)
    if (viewport.width === 744) {
      await page.locator('.account-page__body').evaluate(el => {
        const label = document.getElementById('settings-current-password').parentElement.previousElementSibling
        el.scrollTop += label.getBoundingClientRect().top - el.getBoundingClientRect().top - 14
      })
      await page.screenshot({ path: path.join(artifacts, 'account-password-eyes.png') })
    }
  }
  assert.equal(updates().length, beforeReveal, 'Visibility buttons never submit the password form')
  await page.setViewportSize({ width: 1440, height: 1000 })
  passed.push('Independent password eye buttons, keyboard toggles, preserved values, and responsive fields at five sizes')
  await fillPassword('mismatched fixture')
  const beforeMismatch = updates().length
  await passwordForm().getByRole('button', { name: 'Change password', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'do not match' }).waitFor()
  assert.equal(updates().length, beforeMismatch)
  await fillPassword('new password fixture', 'wrong current fixture')
  await passwordForm().getByRole('button', { name: 'Change password', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor()
  await fillPassword()
  await page.getByRole('button', { name: 'Show new password', exact: true }).click()
  await passwordForm().getByRole('button', { name: 'Change password', exact: true }).click()
  await section().getByText('Your password has been updated.', { exact: true }).waitFor()
  for (const label of ['Current password', 'New password', 'Confirm new password']) { assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), ''); assert.equal(await page.getByLabel(label, { exact: true }).getAttribute('type'), 'password') }
  passed.push('Password mismatch and wrong-current rejection; success clears all password fields')
  requireCode = true
  await fillPassword()
  await passwordForm().getByRole('button', { name: 'Change password', exact: true }).click()
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click()
  await section().getByText('Verification code requested. Check your email, then enter the code below.', { exact: true }).waitFor()
  await page.getByLabel('Verification code', { exact: true }).fill('111111')
  await passwordForm().getByRole('button', { name: 'Change password', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'invalid or expired' }).waitFor()
  await page.getByLabel('Verification code', { exact: true }).fill('654321')
  await passwordForm().getByRole('button', { name: 'Change password', exact: true }).click()
  await section().getByText('Your password has been updated.', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Verification code', { exact: true }).count(), 0)
  passed.push('Reauthentication code request, wrong code rejection, and nonce-confirmed password change')
  await fillPassword()
  for (const [, description] of passwordFields) await page.getByRole('button', { name: `Show ${description}`, exact: true }).click()
  await page.keyboard.press('Escape')
  await section().waitFor({ state: 'hidden' })
  await open()
  assert.equal(await page.getByLabel('Current password', { exact: true }).inputValue(), '')
  for (const [label] of passwordFields) assert.equal(await page.getByLabel(label, { exact: true }).getAttribute('type'), 'password')
  passed.push('Closing the page clears secrets and restores masked password controls')
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    await page.getByRole('button', { name: 'Sign out', exact: true }).scrollIntoViewIfNeeded()
    assert.equal(await section().evaluate(el => el.scrollWidth > el.clientWidth), false)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.ok(await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible())
    if (viewport.width === 390) { await page.locator('.account-page__body').evaluate(el => { el.scrollTop = 0 }); await page.screenshot({ path: path.join(artifacts, 'account-mobile.png') }) }
  }
  passed.push('Phone portrait, narrow phone, and landscape: no overflow and sign-out remains reachable')
  // Double measured form text without changing the viewport or zooming the
  // canvas. This is a layout stress test; it does not replace native phone zoom.
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    const styles = await section().evaluate(el => {
      const values = [el, ...el.querySelectorAll('*')].map(node => ({ node, style: node.getAttribute('style'), size: parseFloat(getComputedStyle(node).fontSize) }))
      for (const { node, size } of values) node.style.setProperty('font-size', `${size*2}px`, 'important')
      return values.map(({ style }) => style)
    })
    assert.equal(await section().evaluate(el => el.scrollWidth > el.clientWidth+1), false, 'doubled account text must not create horizontal overflow')
    const controls = ['Current password', 'New password', 'Confirm new password'].map(label => page.getByLabel(label, { exact: true }))
    controls.push(page.getByRole('button', { name: 'Sign out', exact: true }))
    for (const control of controls) {
      await control.scrollIntoViewIfNeeded()
      const fullyVisible = await control.evaluate(node => {
        const box = node.getBoundingClientRect()
        let top = 0, bottom = innerHeight
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            const clip = parent.getBoundingClientRect()
            top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
          }
        }
        return box.top >= top-1 && box.bottom <= bottom+1
      })
      if (!fullyVisible) await page.screenshot({ path: path.join(artifacts, `account-large-text-clipped-${viewport.width}.png`) })
      assert.ok(fullyVisible, `Enlarged control must fit within the scroll area at ${viewport.width}×${viewport.height}`)
    }
    await page.screenshot({ path: path.join(artifacts, `account-large-text-${viewport.width}.png`) })
    await section().evaluate((el, saved) => {
      for (const [index, node] of [el, ...el.querySelectorAll('*')].entries()) {
        if (saved[index] == null) node.removeAttribute('style'); else node.setAttribute('style', saved[index])
      }
    }, styles)
  }
  passed.push('Doubled form text keeps account fields and sign-out reachable in narrow portrait and landscape fixtures')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await verifyEmail()
  let releaseUpdate
  heldUpdate = new Promise(resolve => { releaseUpdate = resolve })
  await page.getByLabel('New email address', { exact: true }).fill('waiting@example.com')
  const emailRequest = page.waitForRequest(req => req.method() === 'PUT' && req.postDataJSON()?.email === 'waiting@example.com')
  await emailForm.getByRole('button', { name: 'Change email address', exact: true }).click()
  await emailRequest
  await page.getByRole('button', { name: 'Close account page', exact: true }).click()
  await open()
  assert.equal(await page.getByLabel('Current password', { exact: true }).isDisabled(), true)
  for (const [, description] of passwordFields) assert.equal(await page.getByRole('button', { name: `Show ${description}`, exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Verify email', exact: true }).isDisabled(), true)
  assert.equal(await page.getByLabel('New email address', { exact: true }).count(), 0)
  releaseUpdate()
  await page.locator('.account-page__pending').getByText('waiting@example.com', { exact: true }).waitFor()
  passed.push('Shared request lock survives account-page close/reopen without duplicate writes')
  providerError = 'session_not_found'
  await verifyEmail()
  await page.getByLabel('New email address', { exact: true }).fill('expired@example.com')
  await emailForm.getByRole('button', { name: 'Change email address', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  assert.equal(await section().count(), 0)
  passed.push('Expired settings session removes the account page and private identity')
  assert.deepEqual(errors, [])
  assert.deepEqual(leaks, [])
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ passed, requests: requests.map(({ method, path }) => ({ method, path })) }, null, 2))
  console.log(JSON.stringify({ passed, artifacts, realAccountChanges: 0 }, null, 2))
} catch (error) {
  console.error('Browser errors:', JSON.stringify(errors))
  const failedPage = browser?.contexts()[0]?.pages()[0]
  if (failedPage) console.error('Failure state:', JSON.stringify(await failedPage.evaluate(async () => {
    const { getAccountConnection } = await import('/src/auth/supabase.js')
    return { snapshot: getAccountConnection().session.getSnapshot(), text: document.body.innerText.slice(0, 1500), scroll: [scrollX, scrollY], app: document.querySelector('.mix-room')?.getBoundingClientRect().toJSON(), url: location.pathname }
  }).catch(() => ({}))))
  if (browser?.contexts()[0]?.pages()[0]) await browser.contexts()[0].pages()[0].screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally { await browser?.close(); await server.close() }
