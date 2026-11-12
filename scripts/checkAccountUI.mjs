import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

// Disposable account fixtures: never load local environment files or call a real provider.
const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(process.env.MIX_ROOM_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-account-ui'), new Date().toISOString().replaceAll(':', '-'))
const snapshot = path.join(out, 'source')
await fs.mkdir(snapshot, { recursive: true })
await fs.mkdir(path.join(out, 'tmp'))
await fs.mkdir(path.join(out, 'empty-env'))
process.env.TMPDIR = path.join(out, 'tmp')
for (const name of ['src', 'shared', 'public', 'auth', 'index.html']) await fs.cp(path.join(root, name), path.join(snapshot, name), { recursive: true })
await fs.symlink(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'))
async function hashes() {
  const values = {}
  for (const file of ['src/components/AccountAccess.jsx', 'src/components/AccountAccess.css', 'src/components/AccountPage.jsx', 'src/components/AccountPage.css', 'src/App.css', 'src/App.jsx', 'scripts/checkAccountUI.mjs']) values[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')
  return values
}
const results = { hashes: await hashes(), checks: [], errors: [], externalHosts: [], requests: [] }
const before = process.argv.includes('--reproduce')
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7)
const authOrigin = 'https://fixture.supabase.co'
const authHeaders = { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'listener@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, email_confirmed_at: '2026-11-02T12:00:00Z', created_at: '2026-10-19T12:00:00Z', identities: [] }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.Zml4dHVyZQ`
const session = () => ({ access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user })
const audio = Buffer.alloc(44 + 8000 * 120 * 2)
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40)
const preview = await createServer({ root: snapshot, configFile: false, envDir: path.join(out, 'empty-env'), cacheDir: path.join(out, 'vite'), plugins: [react()], logLevel: 'error', define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(authOrigin), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('sb_publishable_fixture') }, server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [snapshot, path.join(root, 'node_modules')] } } })
let browser, page
await preview.listen()
const origin = preview.resolvedUrls.local[0].replace(/\/$/, '')
async function fixture(viewport, signedIn = true, suffix = '') {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' })
  const state = { codeRequired: false, passwordError: '', emailError: '', pendingEmail: '', counts: {} }
  await context.addInitScript(({ session, signedIn }) => {
    if (signedIn) localStorage.setItem('sb-fixture-auth-token', JSON.stringify(session))
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('Fixture CSS fullscreen'))
    const realNow = Date.now; window.fixtureClock = 0; Date.now = () => realNow() + window.fixtureClock
  }, { session: session(), signedIn })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin) {
      if (/\.(wav|mp3|ogg|flac)$/.test(url.pathname)) return route.fulfill({ contentType: 'audio/wav', body: audio })
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (req.method() !== 'GET') throw new Error('No app writes are allowed in this fixture')
      return route.fulfill({ json: url.pathname.endsWith('/separation/config') ? { available: false, maxSeconds: 360 } : url.pathname.endsWith('/credits') ? { scope: signedIn ? 'account' : 'guest', remaining: 3, stemsRemaining: 1 } : { available: true, mixes: [], limit: 3 } })
    }
    if (url.origin !== authOrigin) { results.externalHosts.push(url.hostname); return route.abort() }
    const endpoint = url.pathname.replace('/auth/v1', '')
    state.counts[endpoint] = (state.counts[endpoint] || 0) + 1
    results.requests.push({ endpoint, method: req.method() }) // Never retain bodies, passwords or codes.
    const body = req.postDataJSON()
    let code = ''
    if (endpoint === '/user' && req.method() === 'PUT') {
      if (body.password) code = state.passwordError || (state.codeRequired && body.nonce !== '654321' ? body.nonce ? 'reauthentication_not_valid' : 'reauthentication_needed' : '')
      if (body.email) { code = state.emailError; if (!code) state.pendingEmail = body.email }
    }
    if (endpoint === '/verify' && body.token !== '123456') code = 'otp_expired'
    if (code) return route.fulfill({ status: 400, headers: authHeaders, json: { code, msg: 'Fixture rejection' } })
    return route.fulfill({ headers: authHeaders, json: endpoint === '/user' ? { ...user, ...(state.pendingEmail ? { new_email: state.pendingEmail } : {}) } : endpoint === '/token' || endpoint === '/verify' ? session() : endpoint === '/signup' ? { user: { ...user, email_confirmed_at: null }, session: null } : {} })
  })
  page = await context.newPage(); page.setDefaultTimeout(12000)
  page.on('pageerror', error => results.errors.push(error.message))
  await page.goto(origin + suffix)
  await page.getByRole('button', { name: signedIn ? 'Account' : 'Sign in', exact: true }).waitFor()
  return { context, state }
}
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
const shot = name => page.screenshot({ path: path.join(out, name + '.png'), mask: [page.locator('input[autocomplete="one-time-code"]')] })
async function go(view) {
  if (view === 'account') { await page.getByRole('button', { name: 'Account', exact: true }).click(); return page.locator('.account-page').waitFor() }
  const names = { playing: 'Now playing', processing: 'Upload tracks', settings: 'Preferences' }
  const tab = page.getByRole('tab', { name: names[view], exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    if (view === 'settings' && !await page.locator('#workspace-mobile-settings').isVisible()) await page.getByRole('button', { name: 'Room tools', exact: true }).click()
    await page.locator(`#workspace-mobile-${view}`).click()
  }
  await settle()
}
async function loadDemo() {
  await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
  await page.locator('audio[src]').waitFor({ state: 'attached' })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('audio').currentTime > .1)
  await page.evaluate(() => { window.fixtureAudio = document.querySelector('audio') })
}
const fillPassword = async (confirm = 'new password fixture') => {
  await page.getByLabel('Current password', { exact: true }).fill('current password fixture')
  await page.getByLabel('New password', { exact: true }).fill('new password fixture')
  await page.getByLabel('Confirm new password', { exact: true }).fill(confirm)
}
const passwordSubmit = () => page.getByRole('form', { name: 'Change password', exact: true }).getByRole('button', { name: 'Change password', exact: true })
const scrollState = () => page.locator('.account-page').evaluate(el => ({ page: el.scrollTop, body: el.querySelector('.account-page__body').scrollTop }))
async function visibleNotice(text, role = 'status') {
  const notice = page.locator('.account-page').getByRole(role).filter({ hasText: text })
  await notice.waitFor(); await settle()
  return notice.evaluate(el => {
    const box = el.getBoundingClientRect(); let top = 0, bottom = innerHeight
    for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p), b = p.getBoundingClientRect(); if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom) } }
    return { visible: box.top >= top - 1 && box.bottom <= bottom + 1, outsideBody: !el.closest('.account-page__body'), inHeader: !!el.closest('.account-page__header'), height: box.height }
  })
}
async function submitNotice(text, role = 'status', action = () => passwordSubmit().click()) {
  await passwordSubmit().scrollIntoViewIfNeeded()
  const previous = await scrollState()
  await action()
  const notice = await visibleNotice(text, role)
  const next = await scrollState()
  return { notice, previous, next }
}
async function check(name, fn) {
  if (only && !new RegExp(only, 'i').test(name)) return
  try { const details = await fn(); results.checks.push({ name, passed: true, details }) }
  catch (error) { await shot(name.replace(/[^a-z0-9]/gi, '-') + '-failure').catch(() => {}); results.checks.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message) }
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }, { width: 844, height: 390 }]) {
    await check(`signup ${viewport.width}`, async () => {
      const f = await fixture(viewport, false)
      try {
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await page.getByRole('button', { name: 'Create account', exact: true }).click()
        const confirmation = page.getByLabel('Confirm password', { exact: true })
        if (before) { const observed = { hasConfirmation: await confirmation.count() > 0, promotionalCopy: await page.locator('.account-dialog__benefits').count() > 0 }; assert.deepEqual(observed, { hasConfirmation: false, promotionalCopy: true }); await shot(`signup-before-${viewport.width}`); return observed }
        assert.equal(await page.locator('.account-dialog__benefits').count(), 0)
        await page.getByLabel('Email', { exact: true }).fill(user.email)
        const password = page.getByLabel('Password', { exact: true }), submit = page.getByRole('button', { name: 'Create account', exact: true })
        assert.equal(await submit.isDisabled(), true)
        await password.fill('  signup fixture password  '); await confirmation.fill('mismatch fixture')
        assert.equal(await confirmation.getAttribute('autocomplete'), 'new-password')
        assert.equal(await confirmation.getAttribute('type'), 'password')
        assert.equal(await confirmation.getAttribute('aria-invalid'), 'true')
        await page.getByText('Passwords do not match.', { exact: true }).waitFor()
        assert.equal(await submit.isDisabled(), true)
        await page.locator('.account-dialog form').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
        assert.equal(f.state.counts['/signup'] || 0, 0, 'Mismatch never reaches Auth, including an alternate submit path')
        await confirmation.fill('  signup fixture password  ')
        assert.equal(await submit.isEnabled(), true)
        await shot(`signup-after-${viewport.width}`)
        await submit.click(); await page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
        assert.equal(f.state.counts['/signup'], 1)
        await page.getByRole('button', { name: 'Back to sign in', exact: true }).click()
        assert.equal(await confirmation.count(), 0)
        assert.ok(await password.inputValue() === '', 'Password is cleared')
        await page.evaluate(() => { window.fixtureClock += 61000 })
        await page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
        assert.equal(await password.count(), 0); assert.equal(await confirmation.count(), 0)
        await page.waitForFunction(() => !document.querySelector('.account-dialog button[type=submit]').disabled)
        await page.getByRole('button', { name: 'Send reset link', exact: true }).click()
        await page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
        return { matchedSignupRequests: 1, mismatchRequests: 0, confirmationCleared: true, forgotFlow: true }
      } finally { await f.context.close() }
    })
    await check(`account notices ${viewport.width}`, async () => {
      const f = await fixture(viewport)
      try {
        await loadDemo(); await go('account')
        await fillPassword('different fixture')
        const mismatch = await submitNotice('do not match', 'alert')
        await shot(`mismatch-${before ? 'before' : 'after'}-${viewport.width}`)
        if (!before) { assert.ok(mismatch.notice.visible && mismatch.notice.inHeader && mismatch.notice.outsideBody); assert.ok(mismatch.next.body >= mismatch.previous.body - 2, 'Errors must not scroll the form upward') }
        await fillPassword()
        const success = await submitNotice('Your password has been updated.')
        await shot(`success-${before ? 'before' : 'after'}-${viewport.width}`)
        if (before) { assert.equal(mismatch.notice.outsideBody, false); assert.equal(success.notice.outsideBody, false); return { mismatch, success } }
        assert.ok(success.notice.visible && success.notice.inHeader && success.notice.outsideBody)
        assert.ok(success.next.body >= success.previous.body - 2, 'Success must not scroll the form upward')
        for (const label of ['Current password', 'New password', 'Confirm new password']) assert.ok(await page.getByLabel(label, { exact: true }).inputValue() === '', 'Secret field is cleared')
        f.state.passwordError = 'current_password_invalid'; await fillPassword()
        const currentPasswordError = await submitNotice('current password is incorrect', 'alert')
        assert.ok(currentPasswordError.notice.visible && currentPasswordError.notice.inHeader)
        f.state.passwordError = ''
        f.state.codeRequired = true; await fillPassword(); await passwordSubmit().click()
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click()
        const requested = await visibleNotice('Verification code requested.')
        assert.ok(requested.visible && requested.inHeader)
        await page.getByLabel('Verification code', { exact: true }).fill('111111')
        const invalid = await submitNotice('invalid or expired', 'alert')
        assert.ok(invalid.notice.visible && invalid.notice.outsideBody && invalid.notice.inHeader)
        assert.ok(invalid.next.body >= invalid.previous.body - 2, 'Invalid codes must not scroll the form upward')
        assert.equal(await page.getByRole('alert').evaluate(el => el === document.activeElement), true)
        await shot(`invalid-code-after-${viewport.width}`)
        f.state.codeRequired = false
        await page.getByLabel('Verification code', { exact: true }).fill('654321'); await passwordSubmit().click()
        await page.getByText('Your password has been updated.', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Verify email', exact: true }).click()
        const emailSent = await visibleNotice('Check your current email inbox')
        assert.ok(emailSent.visible && emailSent.inHeader)
        await page.getByLabel('Email verification code', { exact: true }).fill('111111')
        await page.getByRole('button', { name: 'Confirm code', exact: true }).click()
        const emailInvalid = await visibleNotice('code is invalid or has expired', 'alert'); assert.ok(emailInvalid.visible && emailInvalid.inHeader)
        await page.getByLabel('Email verification code', { exact: true }).fill('123456'); await page.getByRole('button', { name: 'Confirm code', exact: true }).click()
        f.state.emailError = 'email_exists'
        await page.getByLabel('New email address', { exact: true }).fill('taken@example.com')
        await page.getByRole('button', { name: 'Change email address', exact: true }).click()
        const emailRejected = await visibleNotice('can’t be used', 'alert'); assert.ok(emailRejected.visible && emailRejected.inHeader)
        f.state.emailError = ''
        await page.getByLabel('New email address', { exact: true }).fill('next@example.com')
        await page.getByRole('button', { name: 'Change email address', exact: true }).click()
        const emailChange = await visibleNotice('Check your new inbox'); assert.ok(emailChange.visible && emailChange.inHeader)
        await shot(`email-pending-after-${viewport.width}`)
        await page.getByRole('button', { name: 'Sign out', exact: true }).scrollIntoViewIfNeeded()
        const bodySize = await page.locator('.account-page__body').evaluate(el => el.clientHeight)
        assert.ok(bodySize >= 46, 'Header feedback leaves room for a complete account control')
        assert.equal(await page.evaluate(() => document.querySelector('audio') === window.fixtureAudio && !window.fixtureAudio.paused), true)
        return { mismatch, success, currentPasswordError, invalid, requested, emailSent, emailInvalid, emailRejected, emailChange, bodySize, audioPreserved: true }
      } finally { await f.context.close() }
    })
  }
  if (!before) for (const viewport of [{ width: 390, height: 700 }, { width: 844, height: 390 }]) await check(`larger account text ${viewport.width}`, async () => {
    const f = await fixture(viewport)
    try {
      await loadDemo(); await go('account')
      await page.locator('.account-page').evaluate(el => {
        const sizes = [el, ...el.querySelectorAll('*')].map(node => [node, parseFloat(getComputedStyle(node).fontSize)])
        for (const [node, size] of sizes) node.style.setProperty('font-size', `${size * 2}px`, 'important')
      })
      for (const control of [page.getByLabel('Current password', { exact: true }), page.getByLabel('New password', { exact: true }), page.getByLabel('Confirm new password', { exact: true }), page.getByRole('button', { name: 'Sign out', exact: true })]) {
        await control.scrollIntoViewIfNeeded()
        assert.ok(await control.evaluate(el => {
          const box = el.getBoundingClientRect(), body = el.closest('.account-page__body').getBoundingClientRect()
          return box.top >= body.top - 1 && box.bottom <= body.bottom + 1
        }), 'Enlarged controls fit in the form scroll area')
      }
      await shot(`larger-text-${viewport.width}`)
      return { controlsReachable: true, limitation: 'Computed-font stress only; native zoom remains a device check.' }
    } finally { await f.context.close() }
  })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 700 }]) await check(`preview ${viewport.width}`, async () => {
    const f = await fixture(viewport)
    try {
      await loadDemo(); const ordinary = await page.locator('.mix-room__canvas').boundingBox()
      const room = () => page.locator('.mix-room__canvas').evaluate(el => { const b = el.getBoundingClientRect(); return { width: b.width, height: b.height, visibility: getComputedStyle(el).visibility } })
      await go('processing'); const upload = await room(); await shot(`upload-${before ? 'before' : 'after'}-${viewport.width}`)
      await go('account'); await settle(); const account = await room(); await shot(`account-${before ? 'before' : 'after'}-${viewport.width}`)
      if (!before) {
        assert.ok(Math.abs(account.width - upload.width) < 1 && Math.abs(account.height - upload.height) < 1, 'Account and Upload room dimensions match')
        assert.equal(account.visibility, upload.visibility)
        if (account.visibility === 'visible') { const panel = await page.locator('.account-page').boundingBox(), canvas = await page.locator('.mix-room__canvas').boundingBox(); assert.ok(panel.x + panel.width <= canvas.x) }
        await page.getByRole('button', { name: 'Close account page', exact: true }).click(); await go('playing'); await settle()
        assert.deepEqual(await page.locator('.mix-room__canvas').boundingBox(), ordinary)
        await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click(); await page.locator('.mix-room--fullscreen').waitFor()
        await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await page.locator('.mix-room--fullscreen').waitFor({ state: 'detached' }); await settle()
        assert.deepEqual(await page.locator('.mix-room__canvas').boundingBox(), ordinary)
        assert.equal(await page.evaluate(() => document.querySelector('audio') === window.fixtureAudio && document.querySelectorAll('audio').length === 1 && !window.fixtureAudio.paused), true)
      }
      return { upload, account, ordinaryRestored: !before, audioPreserved: !before }
    } finally { await f.context.close() }
  })
} finally {
  await browser?.close(); await preview.close()
  results.changedDuringRun = Object.entries(await hashes()).filter(([key, value]) => results.hashes[key] !== value).map(([key]) => key)
  results.passed = results.checks.filter(c => c.passed).length; results.failed = results.checks.filter(c => !c.passed).length
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ out, passed: results.passed, failed: results.failed, errors: results.errors.length, externalHosts: results.externalHosts }))
  if (results.failed || results.errors.length || results.externalHosts.length || results.changedDuringRun.length) process.exitCode = 1
}
