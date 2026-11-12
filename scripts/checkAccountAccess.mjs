import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = process.env.MIX_ROOM_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-auth-checks')
const authHost = 'https://fixture.supabase.co'
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'listener@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, email_confirmed_at: '2026-10-19T12:00:00Z', created_at: '2026-10-19T12:00:00Z', identities: [] }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.dGVzdA`
const sessionData = () => ({ access_token: token, refresh_token: 'fixture-refresh-token', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, token_type: 'bearer', user })
const recoveryHash = () => `#access_token=${token}&refresh_token=fixture-refresh-token&expires_in=86400&token_type=bearer&type=recovery`
const dialog = page => page.getByRole('dialog')
const finishRecovery = async page => {
  await page.getByRole('heading', { name: 'Password updated', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Back to the room', exact: true }).click()
  await dialog(page).waitFor({ state: 'hidden' })
}
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const results = []
const engine = process.env.MIX_ROOM_BROWSER_ENGINE || 'chromium'

// Only fixture Auth can leave localhost. Every browser context is disposable;
// real project configuration, browser profiles, and inboxes are never used.
async function fixture(browser, origin, { handler, storedSession = false, viewport } = {}) {
  const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 850 }, serviceWorkers: 'block' })
  const requests = [], errors = [], leaks = []
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin) return route.continue()
    if (url.origin !== authHost) { leaks.push(url.hostname); return route.abort() }
    const record = { path: url.pathname.replace('/auth/v1', ''), method: request.method(), body: request.postDataJSON(), query: Object.fromEntries(url.searchParams) }
    requests.push(record)
    const custom = handler ? await handler(record) : undefined
    if (custom?.abort) return route.abort('failed')
    const body = custom?.body ?? (record.path === '/user' ? user : record.path === '/token' ? sessionData() : record.path === '/signup' ? { user: { ...user, email_confirmed_at: null }, session: null } : {})
    await route.fulfill({ status: custom?.status || 200, contentType: 'application/json', headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' }, body: JSON.stringify(body) })
  })
  if (storedSession) await context.addInitScript(value => localStorage.setItem('sb-fixture-auth-token', JSON.stringify(value)), storedSession === true ? sessionData() : storedSession)
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  const visit = async (suffix = '') => { await page.goto(`${origin}/__auth-test/${suffix}`); await page.getByRole('heading', { name: 'Account test workspace' }).waitFor() }
  const open = async () => { await page.locator('.account-access').click(); await dialog(page).waitFor() }
  const fillLogin = async (password = '  a long fixture password  ') => { await page.getByLabel('Email', { exact: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).fill(password); const confirmation = page.getByLabel('Confirm password', { exact: true }); if (await confirmation.count()) await confirmation.fill(password) }
  return { context, page, requests, errors, leaks, visit, open, fillLogin }
}

await test('account browser suite (isolated Auth fixtures)', { timeout: 240000 }, async t => {
  await mkdir(artifacts, { recursive: true })
  let browser, preview
  try {
    preview = await createServer({ configFile: path.join(root, 'vite.config.js'), logLevel: 'error',
      define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(authHost), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('sb_publishable_fixture') },
      cacheDir: path.join(artifacts, `vite-${engine}`),
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
      plugins: [{ name: 'isolated-account-test-page', configureServer(server) { server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__auth-test/')) return next()
        const html = await server.transformIndexHtml('/__auth-test/', '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account checks</title></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/accountHarness.jsx"></script></body></html>')
        response.setHeader('Content-Type', 'text/html'); response.end(html)
      }) } }],
    })
    await preview.listen()
    const origin = preview.resolvedUrls.local[0].replace(/\/$/, '')
    const browserType = { chromium, firefox, webkit }[engine]
    if (!browserType) throw new Error('MIX_ROOM_BROWSER_ENGINE must be chromium, firefox, or webkit')
    browser = await browserType.launch({ ...(process.env.MIX_ROOM_BROWSER_EXECUTABLE ? { executablePath: process.env.MIX_ROOM_BROWSER_EXECUTABLE } : engine === 'chromium' ? { channel: process.env.MIX_ROOM_BROWSER_CHANNEL || 'chrome' } : {}), headless: true })
    const scenario = async (id, name, options, action) => {
      if (process.env.MIX_ROOM_AUTH_CASES && !process.env.MIX_ROOM_AUTH_CASES.split(',').includes(id)) return
      await t.test(`${id}: ${name}`, { timeout: 25000 }, async () => {
        const f = await fixture(browser, origin, options)
        try {
          await action(f)
          assert.deepEqual(f.errors, [], 'no uncaught browser errors')
          assert.deepEqual(f.leaks, [], 'no requests outside localhost and fake Auth')
          results.push({ id, name, status: 'passed' })
        } catch (error) {
          results.push({ id, name, status: 'failed' })
          await f.page.screenshot({ path: path.join(artifacts, `${id}-${engine}-failure.png`), fullPage: true }).catch(() => {})
          throw error
        } finally { await f.context.close() }
      })
    }

    await scenario('L01', 'empty/invalid login is blocked before any request', {}, async f => {
      await f.visit(); await f.open()
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).evaluate(el => el.validity.valueMissing), true)
      await f.page.getByLabel('Email', { exact: true }).fill('not-an-email')
      await f.page.getByLabel('Password', { exact: true }).fill('password')
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).evaluate(el => el.validity.typeMismatch), true)
      assert.equal(f.requests.length, 0)
    })
    await scenario('L02', 'successful login, password spaces, refresh, and browser-scoped logout', {}, async f => {
      await f.visit(); await f.open(); await f.fillLogin()
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await dialog(f.page).waitFor({ state: 'hidden' })
      assert.equal(f.requests.find(r => r.path === '/token').body.password, '  a long fixture password  ')
      assert.equal(await f.page.locator('.account-access').textContent(), 'Account')
      await f.page.reload(); await f.page.getByLabel('Session status').getByText('signed-in', { exact: true }).waitFor()
      await f.open(); await f.page.getByText(user.email, { exact: true }).waitFor()
      await dialog(f.page).getByRole('button', { name: 'Sign out', exact: true }).click()
      await dialog(f.page).waitFor({ state: 'hidden' })
      assert.equal(f.requests.find(r => r.path === '/logout').query.scope, 'local')
      assert.equal(await f.page.locator('.account-access').textContent(), 'Sign in')
      await f.open(); assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '')
      assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), '')
    })
    for (const [id, code, text] of [['L03', 'invalid_credentials', 'Email or password is incorrect.'], ['L04', 'email_not_confirmed', 'Confirm your email before signing in.']]) {
      await scenario(id, `login handles ${code} without losing input`, { handler: r => r.path === '/token' ? { status: 400, body: { code, msg: 'private provider details' } } : undefined }, async f => {
        await f.visit(); await f.open(); await f.fillLogin()
        await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
        await f.page.getByRole('alert').filter({ hasText: text }).waitFor()
        assert.equal(await f.page.getByRole('alert').evaluate(el => el === document.activeElement), true)
        assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), user.email)
        assert.equal(await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true)
        assert.equal((await f.page.textContent('body')).includes('private provider details'), false)
      })
    }
    await scenario('L05', 'network failure can retry; closing/reopening cannot double-submit', {}, async f => {
      let phase = 'network'; const pending = defer(); let tokenRequests = 0
      // Last registered routes take priority; keep all other fixture isolation.
      await f.context.route(`${authHost}/auth/v1/token**`, async route => {
        tokenRequests++
        if (phase === 'network') return route.abort('failed')
        await pending.promise
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionData()) })
      })
      await f.visit(); await f.open(); await f.fillLogin()
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: "Couldn't connect" }).waitFor()
      phase = 'pending'
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await f.page.getByRole('button', { name: 'Signing in…', exact: true }).waitFor()
      await f.page.getByRole('button', { name: 'Close account panel' }).click(); await f.open()
      assert.equal(await f.page.getByRole('button', { name: 'Signing in…', exact: true }).isDisabled(), true)
      const before = tokenRequests
      await f.page.getByLabel('Email', { exact: true }).press('Enter')
      assert.equal(tokenRequests, before)
      pending.resolve(); await f.page.locator('.account-access').filter({ hasText: 'Account' }).waitFor()
      await dialog(f.page).waitFor({ state: 'hidden' })
      assert.equal(await f.page.locator('.account-access').textContent(), 'Account')
    })
    await scenario('L06', 'keyboard focus stays in modal; show/hide and Escape work', {}, async f => {
      await f.visit(); await f.open(); await f.fillLogin('keyboard password')
      assert.equal(await f.page.getByLabel('Password', { exact: true }).getAttribute('autocomplete'), 'current-password')
      await f.page.getByRole('button', { name: 'Show password', exact: true }).click()
      assert.equal(await f.page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text')
      await f.page.getByRole('button', { name: 'Hide password', exact: true }).click()
      for (let n = 0; n < 14; n++) { await f.page.keyboard.press('Tab'); assert.equal(await dialog(f.page).evaluate(el => el.contains(document.activeElement)), true) }
      for (let n = 0; n < 14; n++) { await f.page.keyboard.press('Shift+Tab'); assert.equal(await dialog(f.page).evaluate(el => el.contains(document.activeElement)), true) }
      await f.page.keyboard.press('Escape'); await dialog(f.page).waitFor({ state: 'hidden' })
      assert.equal(await f.page.locator('.account-access').evaluate(el => el === document.activeElement), true)
      await f.open(); assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '')
    })
    await scenario('L07', 'two tabs synchronize login/logout; another browser stays independent', {}, async f => {
      await f.visit()
      const other = await f.context.newPage(); await other.goto(`${origin}/__auth-test/`)
      await f.open(); await f.fillLogin(); await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await other.locator('.account-access').filter({ hasText: 'Account' }).waitFor()
      const separate = await fixture(browser, origin)
      try { await separate.visit(); assert.equal(await separate.page.locator('.account-access').textContent(), 'Sign in') } finally { await separate.context.close() }
      await other.locator('.account-access').click(); await dialog(other).getByRole('button', { name: 'Sign out', exact: true }).click()
      await f.page.locator('.account-access').filter({ hasText: 'Sign in' }).waitFor()
    })
    await scenario('L08', 'stored session verification failure hides identity and offers retry', { storedSession: true, handler: r => r.path === '/user' ? { status: 401, body: { code: 'bad_jwt', msg: 'fixture revoked session' } } : undefined }, async f => {
      await f.visit(); await f.page.getByLabel('Session status').getByText('guest', { exact: true }).waitFor(); await f.open()
      assert.equal((await dialog(f.page).textContent()).includes(user.email), false)
      await f.page.getByRole('alert').filter({ hasText: 'session ended' }).waitFor()
    })
    await scenario('L09', 'login rate limits show a safe error and unlock the form', { handler: r => r.path === '/token' ? { status: 429, body: { code: 'over_request_rate_limit', msg: 'raw provider text' } } : undefined }, async f => {
      await f.visit(); await f.open(); await f.fillLogin()
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: 'Too many attempts' }).waitFor()
      assert.equal(await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true)
    })
    let online = false
    await scenario('L10', 'offline session verification hides identity and retries after reconnection', { storedSession: true, handler: r => r.path === '/user' && !online ? { abort: true } : undefined }, async f => {
      await f.visit(); await f.page.getByLabel('Session status').getByText('error', { exact: true }).waitFor(); await f.open()
      assert.equal((await dialog(f.page).textContent()).includes(user.email), false)
      online = true
      await f.page.getByRole('button', { name: 'Try again', exact: true }).click()
      await f.page.getByRole('heading', { name: 'Account', exact: true }).waitFor()
      await f.page.getByText(user.email, { exact: true }).waitFor()
    })
    let failLogout = true
    await scenario('L11', 'failed server sign-out reconciles the SDK-cleared local session', { storedSession: true, handler: r => r.path === '/logout' && failLogout ? { status: 503, body: { msg: 'fixture unavailable' } } : undefined }, async f => {
      await f.visit(); await f.page.locator('.account-access').filter({ hasText: 'Account' }).waitFor(); await f.open()
      await f.page.getByRole('button', { name: 'Sign out', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: 'server sign-out could not be confirmed' }).waitFor()
      assert.equal(await f.page.locator('.account-access').textContent(), 'Sign in')
      failLogout = false
      await f.fillLogin(); await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await dialog(f.page).waitFor({ state: 'hidden' }); await f.open()
      await f.page.getByRole('button', { name: 'Sign out', exact: true }).click(); await dialog(f.page).waitFor({ state: 'hidden' })
      assert.equal(await f.page.locator('.account-access').textContent(), 'Sign in')
    })
    const shortSession = () => ({ ...sessionData(), expires_in: 240, expires_at: Math.floor(Date.now() / 1000) + 240 })
    await scenario('L12', 'automatic token refresh keeps the same account signed in', { storedSession: shortSession() }, async f => {
      await f.page.clock.install(); await f.visit()
      await f.page.locator('.account-access').filter({ hasText: 'Account' }).waitFor()
      const refreshed = f.page.waitForResponse(response => response.url().includes('/token?grant_type=refresh_token'))
      await f.page.clock.fastForward(240001); await refreshed
      assert.equal(f.requests.find(r => r.query.grant_type === 'refresh_token').body.refresh_token, 'fixture-refresh-token')
      assert.equal(await f.page.locator('.account-access').textContent(), 'Account')
    })
    await scenario('L13', 'revoked refresh token returns the browser to signed-out state', { storedSession: shortSession(), handler: r => r.query.grant_type === 'refresh_token' ? { status: 400, body: { code: 'refresh_token_not_found', msg: 'fixture revoked refresh' } } : undefined }, async f => {
      await f.page.clock.install(); await f.visit()
      await f.page.locator('.account-access').filter({ hasText: 'Account' }).waitFor()
      await f.page.clock.fastForward(240001)
      await f.page.locator('.account-access').filter({ hasText: 'Sign in' }).waitFor()
      await f.open(); assert.equal((await dialog(f.page).textContent()).includes(user.email), false)
    })
    await scenario('L14', 'blocked browser storage allows this visit to sign in without crashing', {}, async f => {
      await f.context.addInitScript(() => {
        for (const name of ['getItem', 'setItem', 'removeItem']) Object.defineProperty(Storage.prototype, name, { value: () => { throw new DOMException('Fixture storage denied', 'SecurityError') } })
      })
      await f.visit(); await f.open(); await f.fillLogin()
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await f.page.locator('.account-access').filter({ hasText: 'Account' }).waitFor()
      await f.page.reload(); await f.page.locator('.account-access').filter({ hasText: 'Sign in' }).waitFor()
    })

    await scenario('S01', 'signup validates email and the 12-character boundary', {}, async f => {
      await f.visit(); await f.open(); await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByLabel('Password', { exact: true }).fill('12345678901')
      await f.page.getByLabel('Confirm password', { exact: true }).fill('12345678901')
      assert.equal(await f.page.getByRole('button', { name: 'Create account', exact: true }).isDisabled(), true)
      assert.equal(f.requests.length, 0)
      await f.page.getByLabel('Password', { exact: true }).fill('123456789012')
      await f.page.getByLabel('Confirm password', { exact: true }).fill('123456789012')
      assert.equal(await f.page.getByLabel('Password', { exact: true }).getAttribute('autocomplete'), 'new-password')
      await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
      await f.page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
      assert.equal(await f.page.locator('.account-access').textContent(), 'Sign in')
      assert.equal(f.requests.find(r => r.path === '/signup').query.redirect_to, `${origin}/`)
      assert.equal(await f.page.getByRole('button', { name: /Resend email in/ }).isDisabled(), true)
      await f.page.getByRole('button', { name: 'Back to sign in', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), user.email)
      assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '')
    })
    await scenario('S02', 'duplicate signup is neutral and cannot sign in an unconfirmed user', { handler: r => r.path === '/signup' ? { status: 422, body: { code: 'user_already_exists', msg: 'private duplicate diagnostic' } } : undefined }, async f => {
      await f.visit(); await f.open(); await f.page.getByRole('button', { name: 'Create account', exact: true }).click(); await f.fillLogin()
      await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
      await f.page.getByText(/If this address can be registered/).waitFor()
      assert.equal(await f.page.getByRole('alert').count(), 0)
      assert.equal(await f.page.locator('.account-access').textContent(), 'Sign in')
    })
    await scenario('S03', 'provider rejects weak password without a false check-email result', { handler: r => r.path === '/signup' ? { status: 422, body: { code: 'weak_password', msg: 'fixture weak password' } } : undefined }, async f => {
      await f.visit(); await f.open(); await f.page.getByRole('button', { name: 'Create account', exact: true }).click(); await f.fillLogin()
      await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: 'stronger password' }).waitFor()
      assert.equal(await f.page.getByRole('heading', { name: 'Check your email', exact: true }).count(), 0)
    })
    await scenario('S04', 'confirmation resend uses email-only form, cooldown, and sending-limit feedback', { handler: r => r.path === '/resend' ? { status: 429, body: { code: 'over_email_send_rate_limit', msg: 'fixture cap' } } : undefined }, async f => {
      await f.page.clock.install(); await f.visit('#error=access_denied&error_code=otp_expired')
      await f.page.getByRole('button', { name: 'Request a new confirmation link', exact: true }).click()
      assert.equal(await f.page.getByLabel('Password', { exact: true }).count(), 0)
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByRole('button', { name: 'Send confirmation link', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: 'email sending limit' }).waitFor()
      assert.equal(await f.page.getByRole('button', { name: 'Send confirmation link', exact: true }).isDisabled(), true)
      await f.page.clock.fastForward(61000)
      // Timer callbacks can finish before React commits the enabled state in WebKit.
      await f.page.locator('button:not([disabled])').filter({ hasText: /^Send confirmation link$/ }).waitFor()
      assert.equal(await f.page.getByRole('button', { name: 'Send confirmation link', exact: true }).isEnabled(), true)
      assert.equal(f.requests.filter(r => r.path === '/resend').length, 1)
    })
    await scenario('S05', 'valid confirmation callback signs in and removes tokens from the address', {}, async f => {
      await f.visit(recoveryHash().replace('type=recovery', 'type=signup'))
      await f.page.getByRole('heading', { name: 'Account', exact: true }).waitFor()
      assert.equal(await f.page.getByRole('heading', { name: 'Choose a new password', exact: true }).count(), 0)
      assert.equal(new URL(f.page.url()).hash, '')
    })
    await scenario('S06', 'used confirmation link offers sign-in without showing raw URL errors', {}, async f => {
      await f.visit('#error=access_denied&error_code=otp_expired&error_description=private-link-details')
      await f.page.getByRole('alert').filter({ hasText: 'already been used' }).waitFor()
      assert.equal(new URL(f.page.url()).hash, '')
      assert.equal((await f.page.textContent('body')).includes('private-link-details'), false)
    })
    const signupReply = defer()
    await scenario('S07', 'pending signup blocks repeated submit and completes after the dialog closes', { handler: async r => { if (r.path === '/signup') await signupReply.promise } }, async f => {
      await f.visit(); await f.open(); await f.page.getByRole('button', { name: 'Create account', exact: true }).click(); await f.fillLogin()
      await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
      await f.page.getByRole('button', { name: 'Creating account…', exact: true }).waitFor()
      await dialog(f.page).locator('form').evaluate(form => form.requestSubmit())
      await f.page.getByRole('button', { name: 'Close account panel' }).click()
      signupReply.resolve()
      await f.page.locator('.account-announcement').getByText(/If this address can be registered/).waitFor()
      assert.equal(await dialog(f.page).isVisible(), false)
      assert.equal(f.requests.filter(r => r.path === '/signup').length, 1)
      await f.open(); await f.page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
    })
    await scenario('S08', 'accepted resend never promises delivery and shares the reset-email cooldown', {}, async f => {
      await f.page.clock.install(); await f.visit('#error=access_denied&error_code=otp_expired')
      await f.page.getByRole('button', { name: 'Request a new confirmation link', exact: true }).click()
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByRole('button', { name: 'Send confirmation link', exact: true }).click()
      await f.page.getByText(/If this address still needs confirmation/).waitFor()
      assert.equal((await dialog(f.page).textContent()).includes('Email sent'), false)
      await f.page.getByRole('button', { name: 'Back to sign in', exact: true }).click()
      await f.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
      assert.equal(await f.page.getByRole('button', { name: 'Send reset link', exact: true }).isDisabled(), true)
      assert.equal(f.requests.filter(r => r.path === '/recover').length, 0)
    })

    await scenario('P01', 'forgot password is email-only, validates input, and stays signed out', {}, async f => {
      await f.visit(); await f.open(); await f.fillLogin()
      await f.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
      assert.equal(await f.page.getByLabel('Password', { exact: true }).count(), 0)
      await f.page.getByLabel('Email', { exact: true }).fill('invalid')
      await f.page.getByRole('button', { name: 'Send reset link', exact: true }).click()
      assert.equal(f.requests.length, 0)
      await f.page.getByLabel('Email', { exact: true }).fill('unknown@example.com')
      await f.page.getByRole('button', { name: 'Send reset link', exact: true }).click()
      await f.page.getByText(/If this address has an account/).waitFor()
      assert.equal(f.requests.find(r => r.path === '/recover').query.redirect_to, `${origin}/`)
      assert.equal(await f.page.locator('.account-access').textContent(), 'Sign in')
      await f.page.getByRole('button', { name: 'Back to sign in', exact: true }).click()
      assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '')
    })
    await scenario('P02', 'reset email failure shows retry feedback and respects cooldown', { handler: r => r.path === '/recover' ? { status: 429, body: { code: 'over_email_send_rate_limit', msg: 'fixture limit' } } : undefined }, async f => {
      await f.page.clock.install(); await f.visit(); await f.open()
      await f.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByRole('button', { name: 'Send reset link', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: 'email sending limit' }).waitFor()
      assert.equal(await f.page.getByRole('heading', { name: 'Check your email', exact: true }).count(), 0)
      await f.page.clock.fastForward(61000)
      assert.equal(await f.page.getByRole('button', { name: 'Send reset link', exact: true }).isEnabled(), true)
    })
    await scenario('P03', 'valid recovery requires a new password, validates length, updates once, and cleans URL', {}, async f => {
      await f.visit(recoveryHash())
      await f.page.getByRole('heading', { name: 'Choose a new password', exact: true }).waitFor()
      assert.equal(new URL(f.page.url()).hash, '')
      await f.page.getByRole('button', { name: 'Show password', exact: true }).click()
      assert.equal(await f.page.getByLabel('New password', { exact: true }).getAttribute('type'), 'text')
      await f.page.getByRole('button', { name: 'Hide password', exact: true }).click()
      await f.page.getByLabel('New password', { exact: true }).fill('short')
      await f.page.getByRole('button', { name: 'Update password', exact: true }).click()
      assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0)
      await f.page.getByLabel('New password', { exact: true }).fill('  a new fixture password  ')
      await f.page.getByRole('button', { name: 'Update password', exact: true }).click()
      await finishRecovery(f.page)
      assert.equal(f.requests.filter(r => r.path === '/user' && r.method === 'PUT').length, 1)
      assert.equal(f.requests.find(r => r.method === 'PUT').body.password, '  a new fixture password  ')
      await f.open(); await f.page.getByRole('heading', { name: 'Account', exact: true }).waitFor()
      assert.equal(await f.page.getByLabel('New password', { exact: true }).count(), 0)
    })
    await scenario('P04', 'rejected new password retains recovery and permits a corrected retry', { handler: r => r.path === '/user' && r.method === 'PUT' && r.body.password === 'same password again' ? { status: 422, body: { code: 'same_password', msg: 'fixture same password' } } : undefined }, async f => {
      await f.visit(recoveryHash()); await f.page.getByLabel('New password', { exact: true }).fill('same password again')
      await f.page.getByRole('button', { name: 'Update password', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: 'different from' }).waitFor()
      await f.page.getByLabel('New password', { exact: true }).fill('corrected new password')
      await f.page.getByRole('button', { name: 'Update password', exact: true }).click()
      await finishRecovery(f.page)
    })
    await scenario('P05', 'expired recovery has a reset-email path and no update form', {}, async f => {
      await f.visit('#error=access_denied&error_code=otp_expired&type=recovery')
      await f.page.getByRole('heading', { name: 'Reset password', exact: true }).waitFor()
      await f.page.getByRole('alert').filter({ hasText: 'password reset link has expired' }).waitFor()
      assert.equal(await f.page.getByLabel('New password', { exact: true }).count(), 0)
      assert.equal(new URL(f.page.url()).hash, '')
    })
    await scenario('P06', 'expired reset cannot enable recovery using an ordinary stored login', { storedSession: true }, async f => {
      await f.visit('#error=access_denied&error_code=otp_expired&type=recovery')
      await f.page.getByRole('heading', { name: 'Reset password', exact: true }).waitFor()
      await f.page.getByLabel('Session status').getByText('signed-in', { exact: true }).waitFor()
      assert.equal(await f.page.getByLabel('New password', { exact: true }).count(), 0)
      assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0)
    })
    const resetReply = defer()
    await scenario('P07', 'pending reset request cannot be duplicated across dialog reopen', { handler: async r => { if (r.path === '/recover') await resetReply.promise } }, async f => {
      await f.visit(); await f.open(); await f.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByRole('button', { name: 'Send reset link', exact: true }).click()
      await f.page.getByRole('button', { name: 'Sending link…', exact: true }).waitFor()
      await f.page.getByRole('button', { name: 'Close account panel' }).click(); await f.open()
      assert.equal(await f.page.getByRole('button', { name: 'Sending link…', exact: true }).isDisabled(), true)
      await dialog(f.page).locator('form').evaluate(form => form.requestSubmit())
      resetReply.resolve(); await f.page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
      assert.equal(f.requests.filter(r => r.path === '/recover').length, 1)
    })
    const updateReply = defer(); let networkFailure = true
    await scenario('P08', 'network failure preserves recovery; pending password update blocks duplicates', { handler: async r => {
      if (r.path !== '/user' || r.method !== 'PUT') return
      if (networkFailure) return { abort: true }
      await updateReply.promise
    } }, async f => {
      await f.visit(recoveryHash()); await f.page.getByLabel('New password', { exact: true }).fill('new fixture password')
      await f.page.getByRole('button', { name: 'Update password', exact: true }).click()
      await f.page.getByRole('alert').filter({ hasText: "Couldn't connect" }).waitFor()
      networkFailure = false
      await f.page.getByRole('button', { name: 'Update password', exact: true }).click()
      await f.page.getByRole('button', { name: 'Updating password…', exact: true }).waitFor()
      assert.equal(await f.page.getByRole('button', { name: 'Updating password…', exact: true }).isDisabled(), true)
      await dialog(f.page).locator('form').evaluate(form => form.requestSubmit())
      updateReply.resolve(); await finishRecovery(f.page)
      assert.equal(f.requests.filter(r => r.method === 'PUT').length, 2)
    })
    await scenario('P09', 'closing recovery clears the entered password and show/hide state', {}, async f => {
      await f.visit(recoveryHash()); await f.page.getByLabel('New password', { exact: true }).fill('never retain this value')
      await f.page.getByRole('button', { name: 'Show password', exact: true }).click()
      await f.page.keyboard.press('Escape'); await dialog(f.page).waitFor({ state: 'hidden' }); await f.open()
      assert.equal(await f.page.getByLabel('New password', { exact: true }).inputValue(), '')
      assert.equal(await f.page.getByLabel('New password', { exact: true }).getAttribute('type'), 'password')
    })
    await scenario('UX01', 'sign-in has no unrelated verification controls; signup and reset preserve email', {}, async f => {
      await f.visit(); await f.open()
      assert.equal(await dialog(f.page).getByRole('button', { name: /confirmation|verify|resend/i }).count(), 0)
      await f.page.screenshot({ path: path.join(artifacts, 'sign-in-desktop.png') })
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByLabel('Password', { exact: true }).fill('discarded password')
      await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), user.email)
      assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '')
      await f.page.screenshot({ path: path.join(artifacts, 'sign-up-desktop.png') })
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await f.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), user.email)
      await f.page.screenshot({ path: path.join(artifacts, 'reset-request-desktop.png') })
    })
    await scenario('UX02', 'unconfirmed login offers contextual verification and keeps entered email', { handler: r => r.path === '/token' ? { status: 400, body: { code: 'email_not_confirmed' } } : undefined }, async f => {
      await f.visit(); await f.open(); await f.fillLogin()
      await dialog(f.page).getByRole('button', { name: 'Sign in', exact: true }).click()
      await f.page.getByRole('button', { name: 'Verify email', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), user.email)
      assert.equal(await f.page.getByLabel('Password', { exact: true }).count(), 0)
      await f.page.getByRole('button', { name: 'Send confirmation link', exact: true }).click()
      await f.page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
      await f.page.screenshot({ path: path.join(artifacts, 'confirmation-desktop.png') })
      assert.equal(await f.page.getByText(/For this local preview/).isVisible(), false)
      await f.page.getByRole('button', { name: 'Change email', exact: true }).click()
      assert.equal(await f.page.getByLabel('Email', { exact: true }).inputValue(), user.email)
      assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '')
    })
    await scenario('UX03', 'reset-email resend requests recovery, never signup confirmation', {}, async f => {
      await f.page.clock.install(); await f.visit(); await f.open()
      await f.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
      await f.page.getByLabel('Email', { exact: true }).fill(user.email)
      await f.page.getByRole('button', { name: 'Send reset link', exact: true }).click()
      await f.page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor()
      await f.page.clock.fastForward(61000)
      await f.page.getByRole('button', { name: 'Resend email', exact: true }).click()
      await f.page.getByRole('button', { name: /Resend email in/ }).waitFor()
      assert.equal(f.requests.filter(r => r.path === '/recover').length, 2)
      assert.equal(f.requests.filter(r => r.path === '/resend').length, 0)
    })
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await scenario(`UX${viewport.width}`, `phone ${viewport.width}×${viewport.height}: sign-in and signup fit the viewport`, { viewport }, async f => {
        await f.visit(); await f.open()
        for (const screen of ['sign-in', 'sign-up']) {
          if (screen === 'sign-up') await f.page.getByRole('button', { name: 'Create account', exact: true }).click()
          const primary = dialog(f.page).getByRole('button', { name: screen === 'sign-up' ? 'Create account' : 'Sign in', exact: true })
          await primary.scrollIntoViewIfNeeded()
          assert.equal(await dialog(f.page).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
          const bounds = await dialog(f.page).boundingBox()
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1)
          await f.page.screenshot({ path: path.join(artifacts, `${screen}-${viewport.width}.png`) })
        }
      })
    }
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await scenario(`A${viewport.width}`, `phone ${viewport.width}×${viewport.height}: recovery controls remain reachable`, { viewport }, async f => {
        await f.visit(recoveryHash()); await f.page.getByLabel('New password', { exact: true }).waitFor()
        await f.page.getByLabel('New password', { exact: true }).fill('phone fixture password')
        await f.page.getByRole('button', { name: 'Update password', exact: true }).scrollIntoViewIfNeeded()
        assert.equal(await dialog(f.page).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
        await f.page.screenshot({ path: path.join(artifacts, `recovery-${viewport.width}-${engine}.png`) })
        await f.page.getByRole('button', { name: 'Update password', exact: true }).click(); await finishRecovery(f.page)
      })
    }
  } finally {
    await writeFile(path.join(artifacts, `results-${engine}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), engine, environment: 'isolated fake Auth; no live emails or passwords', cases: results }, null, 2))
    await browser?.close(); await preview?.close()
  }
})
