import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

// Focused fixture checks; this does not certify accessibility or use real accounts.
// Freeze inputs because other specialists may be formatting the working tree.
const root = fileURLToPath(new URL('../', import.meta.url))
const base = process.env.MIX_ROOM_A11Y_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-accessibility')
const out = path.join(base, new Date().toISOString().replaceAll(':', '-'))
const snapshot = path.join(out, 'source')
await fs.mkdir(snapshot, { recursive: true })
await fs.mkdir(path.join(out, 'tmp'))
process.env.TMPDIR = path.join(out, 'tmp')
for (const name of ['src', 'shared', 'public', 'auth', 'index.html', 'package.json']) await fs.cp(path.join(root, name), path.join(snapshot, name), { recursive: true })
await fs.symlink(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'))
await fs.mkdir(path.join(out, 'empty-env'))
async function hashes(folder) {
  const values = {}
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(folder, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(name)
      else values[name] = createHash('sha256').update(await fs.readFile(path.join(folder, name))).digest('hex')
    }
  }
  await walk('src'); await walk('shared')
  return values
}
const sourceHashes = await hashes(snapshot)
const results = { started: new Date().toISOString(), sourceHashes, checks: [], contrast: [], enlarged: [], errors: [], blocked: [], requests: [], limitations: ['Fixture Chrome only; physical devices, native text zoom, inbox delivery and screen-reader review remain open.', 'Doubled computed text is a layout stress probe, not native browser or OS zoom.', 'Contrast uses computed foreground/background colors; gradients are bounded by their stops. Complex backgrounds, canvas text and opacity are not certified.'] }
const preview = await createServer({ configFile: false, root: snapshot, envDir: path.join(out, 'empty-env'), cacheDir: path.join(out, 'vite'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [snapshot, path.join(root, 'node_modules')] } }, define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://fixture.supabase.co'), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('sb_publishable_fixture') } })
await preview.listen()
const origin = preview.resolvedUrls.local[0].replace(/\/$/, '')
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'accessibility@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, email_confirmed_at: '2026-10-28T12:00:00Z', created_at: '2026-10-28T12:00:00Z', identities: [] }
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.Zml4dHVyZQ`
const tabNames = { playing: 'Now playing', instruments: 'Visible instruments', processing: 'Upload tracks', mixes: 'My mixes', settings: 'Preferences', about: 'How it works' }
const slug = text => text.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7)
const selected = name => !only || new RegExp(only, 'i').test(name)
let browser, page
const fixtureAudio = (() => {
  const rate = 8000, count = rate * 30, b = Buffer.alloc(44 + count * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 1000), 44 + i * 2)
  return b
})()
async function fixture({ signedIn = true, viewport = { width: 1440, height: 900 }, touch = false, fallbackFullscreen = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, serviceWorkers: 'block', reducedMotion: 'reduce' })
  if (fallbackFullscreen) await context.addInitScript(() => { HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('Fixture: use CSS fullscreen fallback')) })
  if (signedIn) await context.addInitScript(value => localStorage.setItem('sb-fixture-auth-token', JSON.stringify(value)), { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin) {
      if (/\.(mp3|wav|flac|ogg)$/i.test(url.pathname)) {
        const range = req.headers().range?.match(/^bytes=(\d+)-(\d*)$/)
        const headers = { 'Accept-Ranges': 'bytes' }
        if (range) {
          const start = Number(range[1]), end = Math.min(Number(range[2] || fixtureAudio.length - 1), fixtureAudio.length - 1)
          return route.fulfill({ status: 206, contentType: 'audio/wav', headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${fixtureAudio.length}` }, body: fixtureAudio.subarray(start, end + 1) })
        }
        return route.fulfill({ contentType: 'audio/wav', headers, body: fixtureAudio })
      }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      results.requests.push({ path: url.pathname, method: req.method() })
      if (url.pathname.includes('/jobs')) return route.fulfill({ status: 503, json: { error: 'Paid jobs unavailable in accessibility fixture' } })
      const body = url.pathname.endsWith('/separation/config') ? { available: false, maxSeconds: 360, monthlyJobs: 20 }
        : url.pathname.endsWith('/separation/credits') ? { scope: signedIn ? 'account' : 'guest', remaining: signedIn ? 3 : 0, stemsRemaining: signedIn ? null : 1 }
          : url.pathname.endsWith('/mixes/config') ? { available: true, limit: 3, maxMixBytes: 167772160, maxAccountBytes: 503316480 }
            : url.pathname === '/api/mixes' ? { mixes: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic saved mix for keyboard review', updatedAt: '2026-10-28T12:00:00Z', bytes: 10000 }], limit: 3 } : {}
      return route.fulfill({ json: body })
    }
    if (url.origin === 'https://fixture.supabase.co') return route.fulfill({ status: url.pathname.endsWith('/token') ? 400 : 200, json: url.pathname.endsWith('/user') ? user : { code: 'invalid_credentials', msg: 'Fixture sign-in error. Check your details.' }, headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' } })
    results.blocked.push(url.hostname); return route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(12000)
  page.on('pageerror', error => results.errors.push(error.message))
  await page.goto(origin)
  await page.getByRole('button', { name: signedIn ? 'Account' : 'Sign in', exact: true }).waitFor()
  return context
}
async function check(name, action) {
  if (!selected(name)) return
  try { const details = await action(); results.checks.push({ name, passed: true, details }) }
  catch (error) {
    const screenshot = path.join(out, slug(name) + '-failure.png')
    const state = await page?.evaluate(() => ({
      focus: document.activeElement?.outerHTML.slice(0, 1000),
      audio: [...document.querySelectorAll('audio')].map(el => ({ time: el.currentTime, duration: el.duration, paused: el.paused, volume: el.volume, seekable: Array.from({ length: el.seekable.length }, (_, i) => [el.seekable.start(i), el.seekable.end(i)]), error: el.error?.message })),
      inputs: [...document.querySelectorAll('input[type=range]')].map(el => ({ name: el.getAttribute('aria-label'), value: el.value })),
      controlsVisible: document.querySelector('.mix-room__fullscreen-controls')?.dataset.visible,
      popupOpen: !!document.querySelector('.mix-room__volume-popup:popover-open'),
      nativeEvents: window.fixtureRangeEvents,
    })).catch(() => null)
    await page?.screenshot({ path: screenshot }).catch(() => {})
    results.checks.push({ name, passed: false, error: error.message, state, screenshot }); console.log('FAIL', name, error.message)
  }
}
async function go(view) {
  if (view === 'account') return page.getByRole('button', { name: 'Account', exact: true }).click()
  if (await page.locator('.mix-room').getAttribute('data-view') === view) return
  const mobileNav = await page.locator('.mix-room__mobile-navigation').count()
  if (mobileNav) {
    if (['instruments', 'about', 'settings'].includes(view) && !await page.locator(`#workspace-mobile-${view}`).isVisible()) await page.getByRole('button', { name: 'Room tools', exact: true }).click()
    await page.locator(`#workspace-mobile-${view}`).click()
  } else if (['editor', 'demo'].includes(view)) {
    await page.locator(`#workspace-tab-${view}`).click()
  } else {
    await page.getByRole('tab', { name: tabNames[view], exact: true }).click()
  }
  assert.equal(await page.locator('.mix-room').getAttribute('data-view'), view)
}
async function demo() { await go('demo'); await page.getByRole('button', { name: 'Load demo', exact: true }).click(); await page.getByRole('heading', { name: 'Demon Seed', exact: true }).waitFor() }
async function colors(label) {
  const values = await page.evaluate(() => {
    const selector = 'button,input,label,summary,h2,h3,p,small,a,output,dt,dd'
    return [...document.querySelectorAll(selector)].filter(el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el)
      return r.width && r.height && r.bottom > 0 && r.top < innerHeight && s.visibility === 'visible' && !el.closest('[hidden],[inert]') && !el.matches(':disabled') && !el.closest(':disabled') && (el.value || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
    }).map(el => {
      const s = getComputedStyle(el), ancestors = []
      for (let parent = el; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const generatedBackground = ['::before', '::after'].some(pseudo => {
          const s = getComputedStyle(parent, pseudo)
          return !['none', 'normal'].includes(s.content) && s.display !== 'none' && (s.backgroundImage !== 'none' || !['transparent', 'rgba(0, 0, 0, 0)'].includes(s.backgroundColor))
        })
        ancestors.push({ color: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity, filter: style.filter, generatedBackground })
      }
      return { tag: el.tagName, className: el.className, text: (el.value || el.innerText || el.getAttribute('aria-label') || '').slice(0, 120), color: s.color, size: parseFloat(s.fontSize), weight: s.fontWeight, ancestors }
    })
  })
  results.contrast.push({ label, values })
}
function assessContrast() {
  const rgba = value => { const m = value?.match(/^rgba?\(([^)]+)\)$/); if (!m) return null; const v = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [...v.slice(0, 3), v[3] ?? 1] }
  const blend = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]))
  const luminance = color => color.reduce((sum, c, i) => { const n = c / 255; return sum + [0.2126, 0.7152, 0.0722][i] * (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4) }, 0)
  const assessment = []
  for (const group of results.contrast) for (const entry of group.values) {
    let backgrounds = [[5, 10, 18]], complex = false, effect = false
    for (const ancestor of [...entry.ancestors].reverse()) {
      const base = rgba(ancestor.color)
      if (Number(ancestor.opacity) < .999 || ancestor.filter !== 'none') effect = true
      if (ancestor.generatedBackground) effect = true
      if (base?.[3] === 1) { backgrounds = [base.slice(0, 3)]; complex = false }
      else if (base) backgrounds = backgrounds.map(bg => blend(base, bg))
      if (ancestor.image !== 'none') {
        const stops = ancestor.image.match(/rgba?\([^)]+\)/g)?.map(rgba)
        if (!stops?.length || /url\(/.test(ancestor.image)) complex = true
        else backgrounds = backgrounds.flatMap(bg => stops.map(stop => blend(stop, bg))).slice(0, 32)
      }
    }
    const foreground = rgba(entry.color)
    if (!foreground || complex || effect) { assessment.push({ label: group.label, text: entry.text, status: 'manual-review', reason: 'Complex background or compositing' }); continue }
    const ratios = backgrounds.map(bg => { const a = luminance(blend(foreground, bg)), b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) })
    let minimum = Math.min(...ratios), maximum = Math.max(...ratios)
    const bgLum = backgrounds.map(luminance), fgLum = luminance(foreground.slice(0, 3))
    if (backgrounds.length > 1 && foreground[3] === 1 && fgLum >= Math.min(...bgLum) && fgLum <= Math.max(...bgLum)) minimum = 1
    const threshold = entry.size >= 24 || entry.size >= 18.667 && Number(entry.weight) >= 700 ? 3 : 4.5
    assessment.push({ label: group.label, text: entry.text, className: entry.className, color: entry.color, size: entry.size, threshold, minimum, maximum, status: maximum < threshold ? 'below-threshold' : minimum < threshold ? 'manual-review' : 'meets-color-bound', backgrounds })
  }
  return assessment
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] })
  results.browser = browser.version()
  let context = await fixture()
  await check('desktop tab arrows Home End selection focus and one Tab stop', async () => {
    const tab = page.getByRole('tab', { name: 'Now playing', exact: true }); await tab.focus()
    for (const [key, selected] of [['End', 'settings'], ['ArrowDown', 'playing'], ['ArrowUp', 'settings'], ['Home', 'playing'], ['ArrowRight', 'instruments'], ['ArrowLeft', 'playing']]) {
      await page.keyboard.press(key)
      await page.waitForFunction(view => document.querySelector('.mix-room').dataset.view === view, selected)
      assert.equal(await page.evaluate(() => document.activeElement.id), 'workspace-tab-' + selected)
      assert.equal(await page.locator('[role=tablist] [role=tab][tabindex="0"]').count(), 1)
    }
  })
  await check('Preferences picker keyboard selection Escape and panel return focus', async () => {
    await go('settings'); const picker = page.getByRole('button', { name: /^Room style / }); await picker.focus(); await picker.press('ArrowDown')
    await page.keyboard.press('End'); await page.keyboard.press('Enter')
    assert.equal(await picker.textContent(), 'Traditional')
    assert.equal(await picker.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'workspace-tab-playing')
  })
  await demo()
  await check('Volume keyboard adjustment Escape and opener focus', async () => {
    const button = page.getByRole('button', { name: 'Volume', exact: true }); await button.focus(); await button.press('Enter')
    const slider = page.getByRole('slider', { name: 'Volume', exact: true }); await slider.waitFor()
    await page.waitForFunction(() => document.activeElement?.matches('.mix-room__volume-popup input'))
    assert.equal(await slider.evaluate(el => el === document.activeElement), true)
    await slider.press('ArrowDown'); await slider.press('Escape')
    await slider.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.querySelector('.mix-room__volume-button')?.getAttribute('aria-expanded') === 'false')
    await page.waitForFunction(() => document.activeElement?.matches('.mix-room__volume-button'))
    assert.equal(await button.evaluate(el => el === document.activeElement), true)
    assert.equal(await button.getAttribute('aria-expanded'), 'false')
  })
  await context.close(); context = await fixture({ signedIn: false })
  await check('Sign-in error focus containment and Escape return', async () => {
    const opener = page.getByRole('button', { name: 'Sign in', exact: true }); await opener.focus(); await opener.press('Enter')
    const dialog = page.getByRole('dialog'); await dialog.waitFor()
    assert.equal(await page.getByLabel('Email', { exact: true }).evaluate(el => el === document.activeElement), true)
    await page.getByLabel('Email', { exact: true }).fill('fixture@example.com'); await page.getByLabel('Password', { exact: true }).fill('synthetic password')
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
    await dialog.getByRole('alert').waitFor(); assert.equal(await dialog.getByRole('alert').evaluate(el => el === document.activeElement), true)
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true) }
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true) }
    await colors('guest-sign-in-error')
    await page.keyboard.press('Escape'); assert.equal(await opener.evaluate(el => el === document.activeElement), true)
  })
  await context.close()
  context = await fixture({ viewport: { width: 320, height: 568 }, touch: true, fallbackFullscreen: true })
  await check('final candidate 320px wrapped fullscreen unequal-inset Volume and Seek integration', async () => {
    await demo(); await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .1)
    await page.evaluate(() => { window.fixtureOriginalAudio = document.querySelector('audio') })
    await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.locator('.mix-room--fullscreen').waitFor()
    await page.locator('.mix-room__canvas-content').evaluate(el => { el.style.setProperty('--fullscreen-controls-safe-left', '72px'); el.style.setProperty('--fullscreen-controls-safe-right', '0px'); el.style.setProperty('--fullscreen-controls-safe-bottom', '34px') })
    await page.waitForTimeout(300)
    const show = async () => {
      await page.touchscreen.tap(20, 100)
      await page.waitForFunction(() => document.querySelector('.mix-room__fullscreen-controls')?.dataset.visible === 'true')
    }
    await show()
    const geometry = await page.locator('.mix-room__fullscreen-controls').evaluate(el => {
      const bar = el.getBoundingClientRect(), seek = el.querySelector('[aria-label="Seek"]').getBoundingClientRect(), play = el.querySelector('.mix-room__play-button').getBoundingClientRect(), exit = el.querySelector('.mix-room__exit-fullscreen').getBoundingClientRect()
      return { bar: bar.toJSON(), seek: seek.toJSON(), play: play.toJSON(), exit: exit.toJSON(), wrapped: Math.abs(exit.y + exit.height / 2 - play.y - play.height / 2) > 10 }
    })
    assert.equal(geometry.wrapped, true, 'The constrained transport must exercise its two-row layout')
    assert.ok(geometry.seek.width > 25)
    results.integration = { ...geometry, step: 'wrapped layout confirmed' }
    const reachable = async locator => assert.equal(await locator.evaluate(el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && (hit === el || el.contains(hit)) }), true)
    await reachable(page.getByRole('button', { name: 'Volume', exact: true }))
    await page.getByRole('button', { name: 'Volume', exact: true }).click()
    const slider = page.getByRole('slider', { name: 'Volume', exact: true }); await slider.waitFor()
    await reachable(slider)
    await page.waitForFunction(() => document.activeElement?.matches('.mix-room__volume-popup input'))
    results.integration.step = 'Volume focused; changing through native range keys'
    await page.evaluate(() => {
      window.fixtureRangeEvents = []
      for (const type of ['keydown', 'input', 'change', 'volumechange']) document.addEventListener(type, event => {
        if (!event.target.matches('input[type=range],audio')) return
        window.fixtureRangeEvents.push({ type, key: event.key, value: event.target.value, name: event.target.getAttribute('aria-label'), volume: document.querySelector('audio').volume, defaultPrevented: event.defaultPrevented, time: performance.now() })
      }, true)
    })
    const keyStates = []
    for (const key of ['Home', 'End']) {
      await slider.press(key)
      keyStates.push(await slider.evaluate((el, key) => ({ key, value: el.value, volume: document.querySelector('audio').volume, focused: el === document.activeElement }), key))
      // volumechange is asynchronous; React must reflect it before the next key.
      await page.waitForFunction(expected => document.querySelector('audio').volume === expected && Number(document.querySelector('.mix-room__volume-popup input').value) === expected, key === 'Home' ? 0 : 1)
    }
    results.integration.keyStates = keyStates
    results.integration.nativeEvents = await page.evaluate(() => window.fixtureRangeEvents)
    const volumeBox = await slider.boundingBox()
    await slider.click({ position: { x: volumeBox.width / 2, y: volumeBox.height / 2 } })
    await page.waitForFunction(() => document.querySelector('audio').volume > .2 && document.querySelector('audio').volume < .8)
    const changedVolume = await page.locator('audio').evaluate(el => el.volume)
    results.integration.changedVolume = changedVolume
    results.integration.nativeEvents = await page.evaluate(() => window.fixtureRangeEvents)
    await page.screenshot({ path: path.join(out, 'fullscreen-320-wrapped-volume.png') })
    await page.keyboard.press('Escape'); await slider.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.mix-room--fullscreen').count(), 1)
    await show()
    const seek = page.getByRole('slider', { name: 'Seek', exact: true }); await reachable(seek)
    results.integration.step = 'Seeking through native pointer and keyboard'
    await seek.press('Home'); await seek.press('ArrowRight')
    await show()
    const seekBox = await seek.boundingBox()
    await seek.click({ position: { x: seekBox.width * .6, y: seekBox.height / 2 } })
    results.integration.seekImmediately = await seek.evaluate(el => ({ value: el.value, time: document.querySelector('audio').currentTime }))
    results.integration.nativeEvents = await page.evaluate(() => window.fixtureRangeEvents)
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 15)
    const seekTime = await page.locator('audio').evaluate(el => el.currentTime)
    await page.waitForFunction(time => document.querySelector('audio').currentTime > time + .15, seekTime)
    assert.equal(await page.locator('audio').evaluate(el => el.paused), false)
    results.integration.step = 'keyboard and pointer seeking with advancing playback confirmed'
    await show()
    await page.getByRole('button', { name: 'Volume', exact: true }).click(); await slider.waitFor()
    await page.getByRole('button', { name: /Switch to (landscape|portrait) view/ }).click(); await slider.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
    await page.locator('.mix-room--fullscreen').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.fixtureOriginalAudio === document.querySelector('audio')), true)
    results.integration = { ...results.integration, ...geometry, changedVolume, seekTime, volumeAndSeekPassed: true, pointerSeekPassed: true, playbackAdvancedAfterSeek: true, popupDismissedOnEscapeAndRotation: true, audioElementPreserved: true }
    return results.integration
  })
  await context.close()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    for (const view of ['settings', 'processing', 'editor', 'mixes', 'account', 'about']) {
      if (!selected(`${viewport.width}x${viewport.height} ${view} doubled text and reachable controls`)) continue
      context = await fixture({ viewport })
      await check(`${viewport.width}x${viewport.height} ${view} doubled text and reachable controls`, async () => {
        await demo(); await go(view)
        if (view === 'processing') {
          await page.getByRole('button', { name: 'Stems', exact: true }).click()
          await page.getByLabel('Add stem files', { exact: true }).setInputFiles({ name: 'Fixture bass.wav', mimeType: 'audio/wav', buffer: fixtureAudio })
        }
        if (view === 'mixes') await page.getByRole('button', { name: 'Open Synthetic saved mix for keyboard review', exact: true }).waitFor()
        const panel = page.locator(view === 'account' ? '.account-page' : view === 'mixes' ? '.mix-library-panel' : view === 'processing' ? '.mix-room__processing-section:not([hidden])' : '.mix-room__content-overlay--' + view)
        await panel.waitFor()
        await colors(`${viewport.width}-${view}-normal`)
        await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('body,body *')].filter(n => n instanceof HTMLElement).map(node => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }))
          for (const { node, size } of nodes) node.style.setProperty('font-size', `${size * 2}px`, 'important')
        })
        const controls = panel.locator('button,input,select,textarea,summary,a[href]').filter({ visible: true })
        const observations = []
        for (const control of await controls.all()) {
          if (!await control.isEnabled()) continue
          await control.focus()
          assert.equal(await control.evaluate(el => el === document.activeElement), true, 'Enabled control must accept keyboard focus')
          await control.scrollIntoViewIfNeeded()
          observations.push(await control.evaluate(el => {
            const box = el.getBoundingClientRect(); let left = 0, right = innerWidth, top = 0, bottom = innerHeight
            for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p), r = p.getBoundingClientRect(); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right) } if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom) } }
            const cx = Math.max(left, Math.min(right, box.x + box.width / 2)), cy = Math.max(top, Math.min(bottom, box.y + box.height / 2)), hit = document.elementFromPoint(cx, cy)
            const textRects = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).flatMap(node => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].map(r => r.toJSON()) })
            const textVisible = el.tagName === 'INPUT' && !['range', 'checkbox', 'file'].includes(el.type)
              ? Math.min(box.bottom, bottom) - Math.max(box.top, top) >= parseFloat(getComputedStyle(el).fontSize) * 1.15
              : textRects.every(r => r.left >= left - 2 && r.right <= right + 2 && r.top >= top - 2 && r.bottom <= bottom + 2)
            return { tag: el.tagName, name: el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText, fullyVisible: box.left >= left - 2 && box.right <= right + 2 && box.top >= top - 2 && box.bottom <= bottom + 2, textVisible, textRects, reachable: !!hit && (el === hit || el.contains(hit)), textOverflow: el.tagName !== 'INPUT' && el.scrollWidth > el.clientWidth + 2, box: box.toJSON(), clip: { left, right, top, bottom } }
          }))
        }
        const failures = observations.filter(o => !o.textVisible || !o.reachable || o.textOverflow)
        const scrolling = await panel.evaluate(el => [...el.querySelectorAll('*'), el].filter(node => node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(node).overflowY)).map(node => ({ className: node.className, height: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop })))
        // Tab from the first enabled control to verify ordinary keyboard progression.
        const first = controls.filter({ hasNot: page.locator(':disabled') }).first()
        await first.focus(); await page.keyboard.press('Tab')
        const tabMoved = await first.evaluate(el => el !== document.activeElement)
        assert.equal(tabMoved, true, 'Tab must move off the first panel control')
        results.enlarged.push({ viewport, view, observations, failures, scrolling, tabMoved })
        await page.screenshot({ path: path.join(out, `${viewport.width}-${view}-large-text.png`) })
        assert.equal(failures.length, 0, JSON.stringify(failures.map(o => ({ name: o.name, textVisible: o.textVisible, fullyVisible: o.fullyVisible, reachable: o.reachable, textOverflow: o.textOverflow }))))
      })
      await context.close()
    }
  }
} finally {
  await browser?.close(); await preview.close()
  const current = await hashes(root)
  results.sourceChangesDuringRun = Object.keys(sourceHashes).filter(file => sourceHashes[file] !== current[file])
  results.ended = new Date().toISOString(); results.passed = results.checks.filter(c => c.passed).length; results.failed = results.checks.filter(c => !c.passed).length
  results.contrastAssessment = assessContrast()
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
  await fs.writeFile(path.join(base, 'latest.json'), JSON.stringify({ out, passed: results.passed, failed: results.failed }, null, 2))
  console.log(JSON.stringify({ out, passed: results.passed, failed: results.failed, changedSources: results.sourceChangesDuringRun }))
  if (results.failed || results.sourceChangesDuringRun.length || results.errors.length) process.exitCode = 1
}
