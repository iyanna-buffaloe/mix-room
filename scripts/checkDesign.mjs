import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import react from '@vitejs/plugin-react'
import { createMixArchive } from '../src/audio/mixArchive.js'
import { buildTutorialPassages, inTutorialPassage } from '../src/demo/tutorialPassages.js'
import { ROOM_COMPACT_QUERY } from '../src/room/roomViewport.js'

// Full-app checks use disposable browser profiles, synthetic audio, and fixture
// services. No real account, saved mix, provider job, or processing credit is used.
const root = fileURLToPath(new URL('../', import.meta.url))
const reviewOnly = process.argv.includes('--review-only')
const tutorialOnly = process.argv.includes('--tutorial-only')
const reviewProfiles = {
  narrow: { width: 320, height: 568, touch: true },
  reference: { width: 393, height: 852, touch: true },
  landscape: { width: 844, height: 390, touch: true },
  desktop: { width: 1440, height: 900, touch: false },
}
const reviewJourneys = ['welcome', 'workspace', 'account']
// Validate selections before creating files, starting a server or opening a browser.
if (!reviewOnly && process.argv.some(value => value.startsWith('--review-'))) throw new Error('Use npm run review for --review-* selections.')
if (reviewOnly && process.argv.includes('--help')) {
  console.log('npm run review [-- --review-profile=narrow|reference|landscape|desktop --review-journey=welcome|workspace|account --review-image=reference:workspace]\nRepeat profile/journey flags to select several. Defaults: all four profiles and three journeys. Screenshots: first failure only unless one image is explicitly selected. Local fixtures only; no live account or processing calls.')
  process.exit(0)
}
const selection = (flag, choices) => {
  const values = process.argv.filter(value => value.startsWith(`${flag}=`)).map(value => value.slice(flag.length + 1))
  for (const value of values) assert.ok(choices.includes(value), `Unknown ${flag}: ${value}. Choose ${choices.join(', ')}.`)
  return values.length ? [...new Set(values)] : choices
}
const selectedTutorialProfiles = tutorialOnly ? selection('--tutorial-profile', Object.keys(reviewProfiles)) : []
const selectedProfiles = reviewOnly ? selection('--review-profile', Object.keys(reviewProfiles)) : []
const selectedJourneys = reviewOnly ? selection('--review-journey', reviewJourneys) : []
const selectedImages = process.argv.filter(value => value.startsWith('--review-image=')).map(value => value.slice('--review-image='.length))
if (reviewOnly) {
  for (const arg of process.argv.slice(2)) assert.ok(arg === '--review-only' || /^--review-(profile|journey|image)=/.test(arg), `Unsupported review option: ${arg}`)
  assert.ok(selectedImages.length <= 1, 'Choose at most one review image; failures retain at most one additional image.')
  for (const image of selectedImages) assert.ok(selectedProfiles.some(profile => selectedJourneys.some(journey => image === `${profile}:${journey}`)), 'The review image must name a selected profile:journey.')
}
const reviewBase = process.env.MIX_ROOM_DESIGN_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-review')
const artifacts = reviewOnly ? path.join(reviewBase, new Date().toISOString().replaceAll(':', '-') + `-${process.pid}`) : process.env.MIX_ROOM_DESIGN_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-design-checks')
await mkdir(artifacts, { recursive: true })
const preview = await createServer({
  ...((reviewOnly || tutorialOnly) ? { root: tutorialOnly && process.env.MIX_ROOM_TUTORIAL_BUILD || root, configFile: false, envDir: false, envPrefix: '__MIX_ROOM_REVIEW_UNUSED_', plugins: [react()] } : { configFile: path.join(root, 'vite.config.js') }),
  logLevel: 'error', cacheDir: reviewOnly ? path.join(reviewBase, '.vite-cache') : path.join(artifacts, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false }, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://fixture.supabase.co'),
  'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('sb_publishable_fixture'),
} })
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'design@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, email_confirmed_at: '2026-10-21T12:00:00Z', created_at: '2026-10-21T12:00:00Z', identities: [] }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.Zml4dHVyZQ`
const fullscreenOnly = process.argv.includes('--fullscreen-only')
const guestOnly = process.argv.includes('--guest-only')
const editorOnly = process.argv.includes('--editor-only')
const roomStyleOnly = process.argv.includes('--room-style-only')
const interactionMatch = process.argv.find(value => value.startsWith('--interaction-match='))?.slice('--interaction-match='.length)
const interactionsOnly = tutorialOnly || reviewOnly || interactionMatch || editorOnly || fullscreenOnly || guestOnly || roomStyleOnly || process.argv.includes('--interactions-only')
const results = [], errors = [], leaks = [], requests = []
const blockedWrites = []
const labels = { playing: 'Now playing', instruments: 'Visible instruments', processing: 'Upload tracks', mixes: 'My mixes', about: 'How it works', settings: 'Preferences' }
const desktopSizes = [[320, 568], [350, 740], [351, 741], [390, 844], [599, 647], [600, 647], [601, 647], [694, 647], [835, 647], [889, 647], [900, 647], [901, 647], [1024, 480], [1100, 720], [1101, 720], [1199, 800], [1200, 800], [1440, 900], [1499, 900], [1500, 900], [1920, 1080]]
const touchSizes = [[320, 568], [390, 844], [600, 740], [601, 740], [844, 390], [844, 400], [844, 401], [844, 560], [844, 561], [390, 600], [390, 601], [390, 740], [390, 741], [1100, 768], [1101, 768]]
const slug = value => value.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
let browser, origin, page

async function check(name, fn) {
  if (roomStyleOnly && !name.includes('room style and About navigation')) return
  const exportSetup = interactionMatch?.includes('real short video export') && name.includes('upload modes, stem naming, and actual browser analysis')
  if (interactionMatch && !name.includes(interactionMatch) && !name.startsWith('no external services') && !exportSetup) return
  try {
    await fn()
    if (reviewOnly && selectedImages.includes(name)) await page.screenshot({ path: path.join(artifacts, `${slug(name)}-selected.png`) })
    results.push({ name, passed: true })
    if (tutorialOnly) console.log(`Checked ${name}`)
    return true
  }
  catch (error) {
    let screenshot
    if ((!reviewOnly && !tutorialOnly) || !results.some(result => result.screenshot)) {
      const target = path.join(artifacts, `${slug(name)}-failure.png`)
      if (await page?.screenshot({ path: target, timeout: 5000 }).then(() => true).catch(() => false)) screenshot = target
    }
    results.push({ name, passed: false, error: error.message, screenshot })
    console.error(`FAIL ${name}: ${error.message}`)
    await page?.keyboard.press('Escape').catch(() => {})
    return false
  }
}

async function fixture({ touch = false, signedIn = true, fallbackFullscreen = false, reducedMotion = 'reduce', viewport = { width: 1440, height: 900 }, denyPlayback = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, reducedMotion, serviceWorkers: 'block', acceptDownloads: true })
  if (signedIn) await context.addInitScript(value => localStorage.setItem('sb-fixture-auth-token', JSON.stringify(value)), { access_token: token, refresh_token: 'fixture-refresh', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, token_type: 'bearer', user })
  if (denyPlayback) await context.addInitScript(behavior => {
    window.fixturePlayDenied = behavior
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () { return window.fixturePlayDenied ? Promise.reject(new DOMException('Fixture playback rejection', window.fixturePlayDenied === 'abort' ? 'AbortError' : 'NotAllowedError')) : play.call(this) }
  }, denyPlayback)
  if (fallbackFullscreen) await context.addInitScript(() => { HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('Fixture: native fullscreen unavailable')) })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === origin) {
      if ((reviewOnly || tutorialOnly) && (!['GET', 'HEAD'].includes(req.method()) || (url.pathname.startsWith('/api/') && !['/api/separation/config', '/api/separation/credits', '/api/mixes/config', '/api/mixes'].includes(url.pathname)))) {
        blockedWrites.push({ path: url.pathname, method: req.method() })
        return route.abort()
      }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      requests.push({ path: url.pathname, method: req.method() })
      if (url.pathname === '/api/separation/jobs' && req.method() === 'POST') return route.fulfill({ status: 503, json: { error: 'Fixture processing outage', code: 'SERVICE_UNAVAILABLE' } })
      const body = url.pathname === '/api/separation/config' ? { available: !(reviewOnly || tutorialOnly), maxSeconds: 360, monthlyJobs: 10 }
        : url.pathname === '/api/separation/credits' ? { scope: signedIn ? 'account' : 'guest', remaining: signedIn ? 3 : 0, stemsRemaining: signedIn ? null : 1 }
          : url.pathname === '/api/mixes/config' ? { available: true, limit: 3, maxMixBytes: 167772160, maxAccountBytes: 503316480 }
            : url.pathname === '/api/mixes' ? { mixes: [], limit: 3 } : {}
      return route.fulfill({ json: body })
    }
    if (url.origin === 'https://fixture.supabase.co') {
      if ((reviewOnly || tutorialOnly) && (req.method() !== 'GET' || url.pathname !== '/auth/v1/user')) {
        blockedWrites.push({ path: url.pathname, method: req.method() })
        return route.abort()
      }
      return route.fulfill({ json: url.pathname.endsWith('/user') ? user : { access_token: token, refresh_token: 'fixture-refresh', expires_in: 86400, token_type: 'bearer', user }, headers: { 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Expose-Headers': 'X-Supabase-Api-Version' } })
    }
    leaks.push(url.hostname)
    return route.abort()
  })
  const nextPage = await context.newPage()
  nextPage.setDefaultTimeout(15000)
  nextPage.on('pageerror', error => errors.push(error.message))
  nextPage.on('dialog', dialog => { errors.push(`Unexpected dialog: ${dialog.message()}`); dialog.dismiss() })
  await nextPage.goto(origin)
  await nextPage.getByRole('button', { name: signedIn ? 'Account' : 'Sign in', exact: true }).waitFor()
  return { context, page: nextPage }
}

const view = () => page.locator('.mix-room').getAttribute('data-view')
const compact = () => page.evaluate(query => matchMedia(query).matches, ROOM_COMPACT_QUERY)
// Exercise the app's real history-restore reset between independent scenarios.
// Clearing through that handler also releases draft guards and staged editor
// state left by preceding checks; it does not bypass production save protection.
async function resetWorkspace() {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  await page.getByRole('heading', { name: 'Welcome to Mix Room', exact: true }).waitFor()
}
async function go(target) {
  if (await view() === target) return
  if (target === 'account') { await page.locator('.account-access').click(); return }
  if (await compact()) {
    if (['instruments', 'about', 'settings'].includes(target) && !await page.locator(`#workspace-mobile-${target}`).isVisible()) {
      await page.getByRole('button', { name: 'Room tools', exact: true }).click()
    }
    await page.locator(`#workspace-mobile-${target}`).click()
  } else if (['editor', 'demo'].includes(target)) {
    await page.locator(`#workspace-tab-${target}`).click()
  } else {
    await page.getByRole('tab', { name: labels[target], exact: true }).click()
  }
  assert.equal(await view(), target)

}

async function size(width, height) {
  await page.setViewportSize({ width, height })
  await page.waitForFunction(({ height, query }) => {
    const nav = matchMedia(query).matches ? '.mix-room__mobile-navigation' : '[aria-label="Workspace"]'
    return Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--room-visible-height')) - height) <= 1 && Boolean(document.querySelector(nav))
  }, { height, query: ROOM_COMPACT_QUERY })
}

async function contained(selector, host = '#room-workspace') {
  const info = await page.locator(selector).evaluate((el, host) => {
    const rect = el.getBoundingClientRect(), outer = document.querySelector(host).getBoundingClientRect()
    return { rect: rect.toJSON(), host: outer.toJSON(), overflow: el.scrollWidth - el.clientWidth }
  }, host)
  assert.ok(info.rect.width > 0 && info.rect.height > 0, `${selector} is collapsed`)
  for (const edge of ['left', 'top']) assert.ok(info.rect[edge] >= info.host[edge] - 2, `${selector} ${edge} outside workspace: ${JSON.stringify(info)}`)
  for (const edge of ['right', 'bottom']) assert.ok(info.rect[edge] <= info.host[edge] + 2, `${selector} ${edge} outside workspace: ${JSON.stringify(info)}`)
  assert.ok(info.overflow <= 2, `${selector} has horizontal overflow ${info.overflow}`)
}

async function reachable(locator) {
  await locator.scrollIntoViewIfNeeded()
  assert.ok(await locator.evaluate(el => {
    const r = el.getBoundingClientRect(), point = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return r.width > 0 && r.height > 0 && (el === point || el.contains(point))
  }), `Control is covered or clipped: ${await locator.getAttribute('aria-label') || await locator.textContent()}`)
}

async function frame() {
  const values = await page.evaluate(() => {
    const app = document.querySelector('.mix-room'), nav = document.querySelector('[aria-label="Workspace"]'), pager = document.querySelector('.mix-room__mobile-navigation'), controls = document.querySelector('.mix-room__controls')
    const title = document.querySelector('.mix-room__track-title').getBoundingClientRect(), player = document.querySelector('.mix-room__audio').getBoundingClientRect()
    return { compact: matchMedia('(max-width: 600px), (pointer: coarse) and (max-width: 1100px)').matches, nav: nav?.getAttribute('aria-orientation'), tabs: Boolean(nav), destinations: Boolean(pager), overflow: Math.max(document.documentElement.scrollWidth - innerWidth, app.scrollWidth - app.clientWidth, controls.scrollWidth - controls.clientWidth), workspaceScroll: document.querySelector('#room-workspace').scrollTop, accountInsideHeader: (() => { const a = document.querySelector('.account-access').getBoundingClientRect(), h = document.querySelector('.mix-room__masthead').getBoundingClientRect(); return a.top >= h.top && a.bottom <= h.bottom + 1 && a.left >= h.left && a.right <= h.right })(), title: title.width, player: player.width }
  })
  assert.ok(values.overflow <= 2, `Frame overflows: ${JSON.stringify(values)}`)
  const actionSizes = await page.locator('.mix-room__top-actions > button').evaluateAll(elements => elements.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })))
  for (const action of actionSizes) { assert.ok(Math.abs(action.width - actionSizes[0].width) < 1); assert.ok(Math.abs(action.height - actionSizes[0].height) < 1) }
  assert.equal(values.accountInsideHeader, true, 'Account stays inside the header at every size')
  await reachable(page.locator('.account-access'))
  assert.equal(await page.locator('.mix-room__top-actions button').nth(0).locator('small').textContent(), 'Save mix')
  assert.equal(await page.locator('.mix-room__top-actions button').nth(1).locator('small').textContent(), values.compact ? 'Download' : 'Download video')
  assert.equal(values.workspaceScroll, 0, 'Focus must not scroll the fixed workspace under the header')
  assert.equal(values.nav, values.compact ? undefined : 'vertical')
  assert.equal(values.tabs, !values.compact)
  assert.equal(values.destinations, values.compact)
  if (!values.compact) assert.ok(values.player > values.title, `Player is narrower than title: ${JSON.stringify(values)}`)
  await reachable(page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }))
}

async function geometry(target) {
  await go(target)
  await page.waitForFunction(target => document.querySelector('.mix-room').dataset.view === target, target)
  await frame()
  if (target === 'playing') {
    await contained('.mix-room__canvas')
    await volumePopupCheck()
    await page.waitForFunction(() => {
      const host = document.querySelector('.mix-room__canvas-content'), viewport = document.querySelector('.mix-room__viewport'), canvas = document.querySelector('.mix-room__canvas canvas')
      return canvas && Math.abs(host.clientWidth - viewport.clientWidth) < 2 && Math.abs(host.clientHeight - viewport.clientHeight) < 2 && Math.abs(canvas.clientWidth - viewport.clientWidth) < 2 && Math.abs(canvas.clientHeight - viewport.clientHeight) < 2
    }, null, { timeout: 8000 })
    if (await compact()) await reachable(page.locator('#workspace-mobile-editor'))
  } else if (target === 'instruments') {
    await contained('.mix-room__sidebar')
    await reachable(page.getByRole('button', { name: 'Close instrument options', exact: true }))
    await reachable(page.getByRole('checkbox', { name: 'See through front layers', exact: true }))
  } else if (target === 'processing') {
    await contained('.mix-room__processing-section')
    for (const mode of ['Audio file', 'Stems']) {
      await page.getByRole('button', { name: mode, exact: true }).click()
      await reachable(page.getByRole('button', { name: mode === 'Audio file' ? 'Choose file' : 'Choose stem files', exact: true }))
      if (mode === 'Audio file') await reachable(page.getByRole('button', { name: 'Analyze audio file', exact: true }))
      if (!await compact()) {
        const scrolling = await page.locator('.mix-room__processing-section').evaluate(el => [...el.querySelectorAll('*'), el].filter(node => {
          const style = getComputedStyle(node)
          return node.getClientRects().length && ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 2
        }).map(node => node.className))
        assert.deepEqual(scrolling, [], `Empty desktop ${mode} form must fit without an internal scrollbar`)
      }
    }
  } else if (target === 'account') {
    await contained('.account-page')
    await reachable(page.getByRole('button', { name: 'Close account page', exact: true }))
    await reachable(page.getByRole('button', { name: 'Sign out', exact: true }))
  } else if (target === 'mixes') {
    await contained('.mix-library-panel')
    await reachable(page.getByRole('button', { name: 'Close mix library', exact: true }))
    await reachable(page.getByRole('button', { name: 'Upload track', exact: true }))
  } else {
    await contained(`.mix-room__content-overlay--${target}`)
    await reachable(page.locator(`.mix-room__content-overlay--${target} .mix-room__overlay-close`))
  }
}

async function volumePopupCheck() {
  const speaker = page.getByRole('button', { name: 'Volume', exact: true })
  const slider = page.getByRole('slider', { name: 'Volume', exact: true })
  assert.equal(await slider.isVisible(), false)
  await reachable(speaker)
  await speaker.click()
  await slider.waitFor({ state: 'visible' })
  await contained('.mix-room__volume-popup', 'html')
  await reachable(slider)
  await slider.fill('0.35')
  await page.waitForFunction(() => Math.abs(document.querySelector('audio').volume - .35) < .001)
  assert.equal(await slider.getAttribute('aria-orientation'), 'vertical')
  const sliderBounds = await slider.boundingBox()
  assert.ok(sliderBounds.height > sliderBounds.width, 'Volume slider is vertical')
  await slider.press('ArrowUp')
  assert.ok(await page.locator('audio').evaluate(el => el.volume) > .35)
  await slider.press('Escape')
  await slider.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('.mix-room__volume-button').getAttribute('aria-expanded') === 'false')
  assert.equal(await speaker.getAttribute('aria-expanded'), 'false')
}

function wav(frequency = 220, seconds = 1) {
  const samples = Math.round(22050 * seconds), bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(22050, 24); bytes.writeUInt32LE(44100, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let n = 0; n < samples; n++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * n / 22050) * 4000), 44 + n * 2)
  return bytes
}
const audioFile = name => ({ name, mimeType: 'audio/wav', buffer: wav(name.includes('bass') ? 110 : 440) })

async function interactions(profile, viewport) {
  const f = await fixture({ touch: profile === 'touch', viewport, fallbackFullscreen: true })
  page = f.page
  await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
  const name = suffix => `${profile} ${viewport.width}×${viewport.height} ${suffix}`
  await check(name('play, seek, pause, and audio retained across overlays'), async () => {
    const src = await page.locator('audio').getAttribute('src')
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .1)
    await go('instruments')
    assert.equal(await page.locator('audio').getAttribute('src'), src)
    assert.equal(await page.locator('audio').evaluate(el => el.paused), false)
    await page.getByRole('slider', { name: 'Seek', exact: true }).fill('30')
    assert.ok(await page.locator('audio').evaluate(el => el.currentTime) >= 29)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('slider', { name: 'Seek', exact: true }).fill('15')
    assert.equal(await page.locator('audio').evaluate(el => el.paused), true)
    assert.ok(await page.locator('audio').evaluate(el => Math.abs(el.currentTime - 15)) < 1)
  })
  await check(name('volume popup, mute at zero, and outside dismissal'), async () => {
    await go('playing')
    await volumePopupCheck()
    const speaker = page.getByRole('button', { name: 'Volume', exact: true })
    const slider = page.getByRole('slider', { name: 'Volume', exact: true })
    await speaker.click()
    await slider.fill('0')
    await page.waitForFunction(() => document.querySelector('audio').volume === 0)
    await speaker.click()
    await slider.waitFor({ state: 'hidden' })
    await speaker.click()
    await slider.fill('0.6')
    await page.locator('.mix-room__brand').click()
    await slider.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('audio').evaluate(el => el.volume), .6)
    await page.screenshot({ path: path.join(artifacts, `${profile}-${viewport.width}-toolbar.png`) })
  })
  await check(name('instrument visibility and transparency'), async () => {
    await go('instruments')
    const first = page.locator('.mix-room__instrument-options input').first()
    await first.uncheck(); assert.equal(await first.isChecked(), false)
    await go('settings'); await go('instruments')
    assert.equal(await first.isChecked(), false, 'Visibility survives panel changes')
    await first.check(); assert.equal(await first.isChecked(), true)
    const last = page.locator('.mix-room__instrument-options input').last()
    await reachable(last); await last.uncheck(); await last.check()
    const transparency = page.getByRole('checkbox', { name: 'See through front layers', exact: true })
    await transparency.uncheck(); await transparency.check()
  })
  await check(name('display settings, label dependency, loop, and reset'), async () => {
    await go('settings')
    const sensitivity = page.getByLabel('Activity sensitivity', { exact: true })
    const before = Number(await sensitivity.inputValue())
    await sensitivity.press('ArrowRight')
    assert.ok(Number(await sensitivity.inputValue()) > before)
    await page.getByRole('checkbox', { name: 'Show labels', exact: true }).uncheck()
    assert.equal(await page.getByLabel('Label size', { exact: true }).isDisabled(), true)
    await page.getByRole('checkbox', { name: 'Show labels', exact: true }).check()
    assert.equal(await page.getByLabel('Label size', { exact: true }).isEnabled(), true)
    await page.getByRole('checkbox', { name: 'Loop song', exact: true }).check()
    assert.equal(await page.locator('audio').evaluate(el => el.loop), true)
    const panning = page.getByRole('checkbox', { name: /^Enable panning/ })
    await panning.uncheck(); assert.equal(await panning.isChecked(), false)
    await panning.check(); assert.equal(await panning.isChecked(), true)
    const labelSize = page.getByLabel('Label size', { exact: true })
    const labelBefore = Number(await labelSize.inputValue())
    await labelSize.press('ArrowRight')
    assert.ok(Number(await labelSize.inputValue()) > labelBefore)
    await page.getByRole('button', { name: 'Reset view', exact: true }).click()
    assert.equal(await sensitivity.inputValue(), '1')
  })
  await check(name('Editor names and DEMO credits action'), async () => {
    const audioSource = await page.locator('audio').getAttribute('src')
    await go('editor')
    const editor = page.locator('.mix-room__content-overlay--editor')
    assert.ok(await editor.getByLabel('Instrument name', { exact: true }).count() > 5)
    const title = editor.getByLabel('Song title', { exact: true })
    const original = await title.inputValue()
    await title.fill('Temporary editor title')
    await go('processing')
    assert.equal(await page.locator('.mix-room__processing-section').getByRole('button', { name: 'Apply names', exact: true }).count(), 0)
    await go('editor')
    assert.equal(await title.inputValue(), 'Temporary editor title')
    await title.fill(original)
    await reachable(editor.getByLabel('Instrument name', { exact: true }).last())
    await go('demo')
    const demo = page.locator('.mix-room__content-overlay--demo')
    assert.equal(await demo.getByRole('heading', { name: 'Demon Seed', exact: true }).count(), 1)
    assert.equal(await demo.getByText('Nine Inch Nails', { exact: true }).count(), 1)
    assert.equal(await demo.getByRole('heading', { name: 'Credits & rights', exact: true }).count(), 1)
    assert.equal(await demo.getByText('Nine Inch Nails · Trent Reznor · The Slip (2008).', { exact: true }).count(), 1)
    assert.equal(await demo.getByRole('link', { name: 'Stem source and archive notices', exact: true }).getAttribute('href'), 'https://archive.org/details/NineInchNails-TheSlipMulti-trackStems')
    assert.equal(await demo.getByRole('link', { name: 'CC BY-NC-SA 3.0 US', exact: true }).getAttribute('href'), 'https://creativecommons.org/licenses/by-nc-sa/3.0/us/')
    assert.equal(await demo.getByText(/Mix Room removed 2.727 seconds/).count(), 0)
    assert.equal(await demo.getByText(/synchronized video derivatives with attribution/).count(), 1)
    assert.equal(await demo.locator('.mix-room__demo-instruments').count(), 0)
    assert.equal(await demo.getByText(/Nice Shoes|Steve Lacy|pending verification/).count(), 0)
    await contained('.mix-room__content-overlay--demo')
    await reachable(demo.getByRole('link', { name: 'CC BY-NC-SA 3.0 US', exact: true }))
    await page.getByRole('button', { name: 'Open demo', exact: true }).click()
    assert.equal(await view(), 'playing')
    await page.getByRole('heading', { name: 'Demon Seed', exact: true }).waitFor()
    assert.equal(await page.locator('audio').getAttribute('src'), audioSource)
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .1)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
  })
  await check(name('room style and About navigation'), async () => {
    assert.equal(await page.getByRole('tab', { name: 'Room style', exact: true }).count(), 0)
    await go('settings')
    assert.equal(await page.getByRole('tab', { name: 'DEMO', exact: true }).count(), 0)
    assert.equal(await page.locator('.mix-room__utility-tabs [role="tab"][aria-label="How it works"]').count(), 1)
    const styles = page.getByRole('button', { name: /^Room style / })
    await styles.click()
    assert.equal(await page.getByRole('listbox', { name: 'Room style', exact: true }).locator('.mix-room__style-swatch').count(), 3)
    for (const option of await page.getByRole('option').all()) await reachable(option)
    await page.screenshot({ path: path.join(artifacts, `${profile}-${viewport.width}-room-style-menu.png`) })
    await page.getByRole('option', { name: 'Dark', exact: true }).click()
    assert.equal(await styles.textContent(), 'Dark')
    await styles.press('ArrowDown')
    await page.getByRole('option', { name: 'Dark', exact: true }).press('End')
    await page.getByRole('option', { name: 'Traditional', exact: true }).press('Enter')
    assert.equal(await styles.textContent(), 'Traditional')
    await styles.click()
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('listbox', { name: 'Room style', exact: true }).count(), 0)
    assert.equal(await view(), 'settings')
    await reachable(styles)
    await go('about')
    if (await compact()) {
      const first = await page.locator('.mix-room__about-mobile h3').textContent()
      await page.getByRole('button', { name: 'Next information card', exact: true }).click()
      assert.notEqual(await page.locator('.mix-room__about-mobile h3').textContent(), first)
    } else assert.equal(await page.locator('.mix-room__room-guide > div').count(), 5)
    await page.keyboard.press('Escape')
    assert.equal(await view(), 'playing')
  })
  await check(name('project links and keyboard navigation'), async () => {
    const github = page.getByRole('button', { name: 'Mix Room on GitHub', exact: true })
    if (await compact()) {
      assert.equal(await github.count(), 0)
      const tools = page.getByRole('button', { name: 'Room tools', exact: true })
      if (await tools.isVisible()) {
        await tools.click()
        await reachable(page.locator('#workspace-mobile-instruments'))
        await page.keyboard.press('Escape')
        assert.equal(await tools.getAttribute('aria-expanded'), 'false')
      } else {
        const destinations = page.locator('.mix-room__mobile-navigation > button')
        assert.equal(await destinations.count(), 6)
        for (const destination of await destinations.all()) await reachable(destination)
      }
    } else {
      await github.click()
      await contained('.mix-room__content-overlay--github')
      const links = await page.locator('.mix-room__project-links a').evaluateAll(elements => elements.map(el => ({ href: el.href, target: el.target, rel: el.rel })))
      assert.equal(links.length, 3)
      for (const link of links) { assert.match(link.href, /^https:\/\/github\.com\//); assert.equal(link.target, '_blank'); assert.match(link.rel, /noopener/) }
      await page.keyboard.press('Escape')
      assert.equal(await view(), 'playing')
      await page.getByRole('tab', { name: 'Now playing', exact: true }).press('ArrowDown')
      assert.equal(await view(), 'instruments')
      await page.getByRole('tab', { name: 'Visible instruments', exact: true }).press('Home')
      assert.equal(await view(), 'playing')
    }
  })
  await check(name('fullscreen fallback, player, rotation, and exit'), async () => {
    await go('playing')
    const src = await page.locator('audio').getAttribute('src')
    await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.locator('.mix-room--fullscreen').waitFor()
    assert.equal(await page.locator('audio').count(), 1)
    assert.equal(await page.locator('audio').getAttribute('src'), src)
    await reachable(page.locator('.mix-room__fullscreen-player').getByRole('button', { name: 'Play', exact: true }))
    await volumePopupCheck()
    assert.ok(await page.locator('.mix-room--fullscreen').count(), 'Closing volume keeps fullscreen open')
    if (await compact()) {
      const rotate = page.getByRole('button', { name: /Switch to (landscape|portrait) view/ })
      const before = await page.locator('.mix-room__canvas').getAttribute('data-fullscreen-orientation')
      await rotate.click()
      assert.notEqual(await page.locator('.mix-room__canvas').getAttribute('data-fullscreen-orientation'), before)
    }
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
    await page.locator('.mix-room--fullscreen').waitFor({ state: 'detached' })
    await frame()
  })
  await check(name('smart naming learns each filename batch and updates the mix title'), async () => {
    await go('processing')
    await page.getByRole('button', { name: 'Stems', exact: true }).click()
    const panel = page.locator('.mix-room__stems-view')
    const title = panel.getByLabel('Song title', { exact: true })
    const inputs = panel.getByLabel('Instrument name', { exact: true })
    const cases = [
      { files: ['Night Drive - 01 - Bass.wav', 'Night Drive - 02 - Drums.wav'], title: 'Night Drive', names: ['Bass', 'Drums'] },
      { files: ['01_Bass_Blue Hour.wav', '02_Gtr_Blue Hour.wav'], title: 'Blue Hour', names: ['Bass', 'Guitar'] },
      { files: ['01 - After Rain - BassDI.wav', '02 - After Rain - BassMic.wav'], title: 'After Rain', names: ['Bass DI', 'Bass mic'] },
      { files: ['Summer Rain - Guzheng.wav', 'Summer Rain - Theremin.wav'], title: 'Summer Rain', names: ['Guzheng', 'Theremin'] },
      { files: ['Unidentified.wav'], title: 'Manual title', names: ['Bowls'], manual: true },
    ]
    const jobsBefore = requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length
    for (const batch of cases) {
      while (await panel.locator('.mix-room__stem-remove').count()) await panel.locator('.mix-room__stem-remove').first().click()
      // Intentionally not decodable: Smart rename must only inspect filenames.
      await panel.locator('input[aria-label="Add stem files"]').setInputFiles(batch.files.map(filename => ({ name: filename, mimeType: 'audio/wav', buffer: Buffer.from('filename-only fixture') })))
      await title.fill('Manual title')
      if (batch.manual) await inputs.first().fill('Bowls')
      for (let repeat = 0; repeat < 2; repeat++) {
        await panel.getByRole('button', { name: 'Smart rename', exact: true }).click()
        assert.equal(await title.inputValue(), batch.title)
        assert.deepEqual(await inputs.evaluateAll(elements => elements.map(el => el.value)), batch.names)
      }
    }
    assert.equal(requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length, jobsBefore)
    while (await panel.locator('.mix-room__stem-remove').count()) await panel.locator('.mix-room__stem-remove').first().click()
  })
  await check(name('Editor smart naming stages title and instruments from stored filenames'), async () => {
    const metadata = JSON.parse(await readFile(path.join(root, 'src/demo/nin-demon-seed/instrument_meta.json'), 'utf8'))
    const jobsBefore = requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length
    const cases = [
      { files: ['Night Drive - 01 - Bass.wav', 'Night Drive - 02 - Gtr.wav', null], title: 'Night Drive', names: ['Bass', 'Guitar', 'Manual 3'] },
      { files: ['Unidentified.wav', null, null], title: 'Manual title', names: ['Manual 1', 'Manual 2', 'Manual 3'] },
      { files: [null, null, null], title: 'Manual title', names: ['Manual 1', 'Manual 2', 'Manual 3'], disabled: true },
    ]
    for (const batch of cases) {
      await resetWorkspace()
      const meta = { ...metadata, title: 'Manual title', duration: 1, instruments: metadata.instruments.slice(0, 3).map((instrument, index) => ({ ...instrument, fileName: batch.files[index], label: `Manual ${index + 1}` })) }
      const archive = createMixArchive({ version: 1, id: crypto.randomUUID(), metadata: meta, framesByKey: Object.fromEntries(meta.instruments.map(instrument => [instrument.key, [{ t: 0, pan: 0, loud: .5 }]])), audioBlob: new Blob([wav()], { type: 'audio/wav' }) })
      await page.locator('input[aria-label="Choose a Mix Room backup"]').setInputFiles({ name: 'smart-naming.mixroom', mimeType: 'application/octet-stream', buffer: Buffer.from(await archive.arrayBuffer()) })
      await page.locator('.mix-room__track-title h2').filter({ hasText: meta.title }).waitFor()
      const source = await page.locator('audio').getAttribute('src')
      await go('editor')
      const editor = page.locator('.mix-room__content-overlay--editor')
      const smart = editor.getByRole('button', { name: 'Smart rename', exact: true })
      const apply = editor.getByRole('button', { name: 'Apply names', exact: true })
      assert.equal(await smart.isDisabled(), Boolean(batch.disabled))
      if (batch.disabled) continue
      // Missing or unrecognized filenames must preserve in-progress manual edits.
      await editor.getByLabel('Instrument name', { exact: true }).last().fill('Custom part')
      const expectedNames = [...batch.names.slice(0, -1), 'Custom part']
      for (let repeat = 0; repeat < 2; repeat++) {
        await reachable(smart)
        await smart.click()
        assert.equal(await editor.getByLabel('Song title', { exact: true }).inputValue(), batch.title)
        assert.deepEqual(await editor.getByLabel('Instrument name', { exact: true }).evaluateAll(elements => elements.map(el => el.value)), expectedNames)
      }
      assert.equal(await page.locator('.mix-room__track-title h2').textContent(), meta.title, 'Suggestions wait for Apply names')
      await go('instruments')
      await go('editor')
      assert.equal(await editor.getByLabel('Song title', { exact: true }).inputValue(), batch.title, 'Suggestions survive tab changes')
      await reachable(apply)
      await apply.click()
      await page.waitForFunction(() => !document.querySelector('.mix-room__editor-fields').disabled && document.querySelector('.mix-room__editor-actions button[type="submit"]').disabled)
      assert.equal(await page.locator('.mix-room__track-title h2').textContent(), batch.title)
      assert.deepEqual(await editor.getByLabel('Instrument name', { exact: true }).evaluateAll(elements => elements.map(el => el.value)), expectedNames)
      assert.equal(await page.locator('audio').getAttribute('src'), source, 'Renaming preserves the loaded audio')
      await contained('.mix-room__editor-actions')
    }
    assert.equal(requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length, jobsBefore, 'Smart rename does not submit processing jobs')
  })
  await check(name('upload modes, stem naming, and actual browser analysis'), async () => {
    // Editor scenarios intentionally leave an unsaved draft. Start this upload
    // scenario fresh so it cannot wait behind the previous draft's leave guard.
    await resetWorkspace()
    await go('processing')
    await page.getByRole('button', { name: 'Audio file', exact: true }).click()
    await page.locator('input[aria-label="Choose audio file"]').setInputFiles(audioFile('design-song.wav'))
    assert.equal(await page.locator('#selected-filename').textContent(), 'design-song.wav')
    // Thorough is paused: the panel describes one six-stem mode, no radios.
    assert.equal(await page.locator('input[name="processing-mode"]').count(), 0)
    await page.getByText('6-stem separation', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stems', exact: true }).click()
    assert.equal(await page.locator('#processing-allowance').textContent(), 'Unlimited stem analysis')
    await page.locator('input[aria-label="Add stem files"]').setInputFiles([audioFile('01_bass.wav'), audioFile('02_guitar.wav'), audioFile('03_other.wav')])
    await page.locator('.mix-room__stem-remove').last().click()
    assert.equal(await page.locator('.mix-room__stems-view').getByLabel('Instrument name', { exact: true }).count(), 2)
    await page.getByRole('button', { name: 'Smart rename', exact: true }).click()
    assert.match(await page.locator('.mix-room__stems-view').getByLabel('Instrument name', { exact: true }).first().inputValue(), /bass/i)
    await page.locator('.mix-room__stems-view').getByLabel('Song title', { exact: true }).fill('Design fixture')
    await page.getByRole('button', { name: 'Analyze stems', exact: true }).click()
    await page.getByRole('heading', { name: 'Design fixture', exact: true }).waitFor({ timeout: 20000 })
    await page.locator('.mix-room[data-progress="false"]').waitFor({ timeout: 20000 })
    assert.ok(await page.locator('audio').evaluate(el => el.duration) > .9)
    const source = await page.locator('audio').getAttribute('src')
    await go('editor')
    const editor = page.locator('.mix-room__content-overlay--editor')
    assert.equal(await editor.getByLabel('Song title', { exact: true }).inputValue(), 'Design fixture')
    assert.equal(await editor.getByLabel('Instrument name', { exact: true }).count(), 2)
    await editor.getByLabel('Instrument name', { exact: true }).first().fill('Edited bass')
    await editor.getByRole('button', { name: 'Apply names', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.mix-room__editor-fields').disabled)
    assert.equal(await page.locator('audio').getAttribute('src'), source)
    await go('processing')
    await reachable(page.getByRole('button', { name: 'Choose stem files', exact: true }))
  })
  await check(name('real short video export and saved-mix dialog'), async () => {
    assert.ok(await page.locator('audio').evaluate(el => el.duration > 0 && el.duration <= 3), 'Use the short synthetic fixture, never the full demo')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.getByRole('button', { name: 'Download room video', exact: true }).click()])
    assert.match(download.suggestedFilename(), /\.(mp4|webm)$/)
    const output = path.join(artifacts, `${profile}-fixture-${download.suggestedFilename()}`)
    await download.saveAs(output)
    assert.ok((await stat(output)).size > 1000)
    const videoSize = await page.evaluate(async base64 => {
      const video = document.createElement('video')
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes]))
      try {
        await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Export could not be decoded')); video.src = url })
        return { width: video.videoWidth, height: video.videoHeight }
      } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
    }, (await readFile(output)).toString('base64'))
    assert.deepEqual(videoSize, { width: 1246, height: 606 })
    await frame()
    await page.getByRole('button', { name: 'Save mix', exact: true }).click()
    await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Save mix', exact: true }) }).waitFor()
    await page.waitForFunction(() => document.querySelector('#saved-mix-name')?.value === 'Design fixture')
    assert.equal(await page.getByLabel('Mix name', { exact: true }).inputValue(), 'Design fixture')
    await page.getByRole('button', { name: 'Close mix library', exact: true }).click()
  })
  console.log(`Completed ${profile} interactions at ${viewport.width}×${viewport.height}`)
  await f.context.close()
}

async function fullscreenChecks() {
  const scenarios = [
    { label: 'desktop', viewport: { width: 1065, height: 647 }, fallbackFullscreen: true, reducedMotion: 'no-preference' },
    { label: 'narrow desktop', viewport: { width: 601, height: 647 }, fallbackFullscreen: true },
    { label: 'small touch', viewport: { width: 320, height: 568 }, touch: true, fallbackFullscreen: true },
    { label: 'portrait touch', viewport: { width: 390, height: 844 }, touch: true, fallbackFullscreen: true },
    { label: 'landscape touch', viewport: { width: 844, height: 390 }, touch: true, fallbackFullscreen: true },
    { label: 'native fullscreen', viewport: { width: 1065, height: 647 } },
  ]
  const selected = process.argv.filter(value => value.startsWith('--fullscreen-case=')).map(value => value.slice('--fullscreen-case='.length))
  for (const scenario of scenarios.filter(value => !selected.length || selected.includes(value.label))) {
    const f = await fixture(scenario); page = f.page
    await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
    await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.locator('.mix-room--fullscreen').waitFor()
    if (!scenario.fallbackFullscreen) await page.waitForFunction(() => document.fullscreenElement !== null)
    const controls = page.locator('.mix-room__fullscreen-controls')
    const show = async () => {
      if (scenario.touch) await page.touchscreen.tap(20, 100)
      else await page.mouse.move(20, 100)
      await page.waitForFunction(() => document.querySelector('.mix-room__fullscreen-controls')?.dataset.visible === 'true')
    }
    const hidden = () => page.waitForFunction(() => {
      const el = document.querySelector('.mix-room__fullscreen-controls')
      return el?.dataset.visible === 'false' && getComputedStyle(el).opacity === '0' && getComputedStyle(el).visibility === 'hidden'
    }, null, { timeout: 6500 })
    const centered = async ({ left = 0, right = 0, bottom = 10 } = {}) => {
      // Compare the transport with the room's viewing axes. A physical-screen
      // bottom bar is wrong when the user turns the room sideways on iOS.
      const geometry = await controls.evaluate(el => {
        const stage = document.querySelector('.mix-room__canvas-content')
        const s = stage.getBoundingClientRect(), c = el.getBoundingClientRect()
        const matrix = new DOMMatrix(getComputedStyle(stage).transform)
        const point = new DOMPoint(c.x + c.width / 2 - s.x - s.width / 2, c.y + c.height / 2 - s.y - s.height / 2).matrixTransform(matrix.inverse())
        const center = button => { const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
        const play = center(el.querySelector('.mix-room__play-button'))
        const exit = center(el.querySelector('.mix-room__exit-fullscreen'))
        return { x: point.x + stage.offsetWidth / 2, y: point.y + stage.offsetHeight / 2, width: el.offsetWidth, height: el.offsetHeight,
          stageWidth: stage.offsetWidth, stageHeight: stage.offsetHeight, crossAxis: matrix.a * (exit.y - play.y) - matrix.b * (exit.x - play.x),
          aligned: Math.abs(c.width - Math.abs(matrix.a) * el.offsetWidth - Math.abs(matrix.c) * el.offsetHeight) < 2
            && Math.abs(c.height - Math.abs(matrix.b) * el.offsetWidth - Math.abs(matrix.d) * el.offsetHeight) < 2 }
      })
      assert.equal(geometry.aligned, true, `Player must rotate with the room: ${JSON.stringify(geometry)}`)
      assert.ok(Math.abs(geometry.x - geometry.stageWidth / 2) < 2, `Player must be centered along the room: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.x - geometry.width / 2 >= 0 && geometry.x + geometry.width / 2 <= geometry.stageWidth + 1)
      assert.ok(geometry.y + geometry.height / 2 <= geometry.stageHeight && geometry.stageHeight - geometry.y - geometry.height / 2 >= 10)
      assert.ok(geometry.x - geometry.width / 2 >= left - 1, `Player must clear the room's left safe area: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.stageWidth - geometry.x - geometry.width / 2 >= right - 1, `Player must clear the room's right safe area: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.stageHeight - geometry.y - geometry.height / 2 >= bottom - 1, `Player must clear the room's bottom safe area: ${JSON.stringify(geometry)}`)
    }
    await check(`${scenario.label}: centered controls and idle playback`, async () => {
      await show(); await centered()
      await page.getByRole('button', { name: 'Play', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('audio').currentTime > .1)
      const time = await page.locator('audio').evaluate(el => el.currentTime)
      await hidden()
      assert.equal(await controls.evaluate(el => el.inert), true)
      assert.equal(await controls.getAttribute('aria-hidden'), 'true')
      assert.equal(await controls.evaluate(el => getComputedStyle(el).pointerEvents), 'none')
      assert.equal(await page.locator('audio').evaluate(el => el.paused), false)
      assert.ok(await page.locator('audio').evaluate(el => el.currentTime) > time)
      await page.screenshot({ path: path.join(artifacts, `${slug(scenario.label)}-fullscreen-idle.png`) })
    })
    await check(`${scenario.label}: pointer or touch wakes controls`, async () => {
      await show(); await centered()
      await reachable(page.getByRole('button', { name: 'Pause', exact: true }))
      await page.screenshot({ path: path.join(artifacts, `${slug(scenario.label)}-fullscreen-controls.png`) })
    })
    await check(`${scenario.label}: volume activity resets idle and popup closes on inactivity`, async () => {
      await show()
      await page.getByRole('button', { name: 'Volume', exact: true }).click()
      const slider = page.getByRole('slider', { name: 'Volume', exact: true })
      await slider.waitFor({ state: 'visible' })
      await page.waitForTimeout(1400)
      await reachable(slider)
      await slider.fill('0.4')
      await page.waitForTimeout(1400)
      assert.equal(await controls.getAttribute('data-visible'), 'true')
      assert.equal(await page.locator('audio').evaluate(el => el.volume), .4)
      await hidden()
      await slider.waitFor({ state: 'hidden' })
    })
    await check(`${scenario.label}: keyboard wakes controls and resets idle`, async () => {
      await page.keyboard.press('Tab')
      await page.waitForFunction(() => document.querySelector('.mix-room__fullscreen-controls')?.dataset.visible === 'true')
      await page.waitForFunction(() => document.querySelector('.mix-room__fullscreen-controls')?.contains(document.activeElement))
      assert.equal(await controls.evaluate(el => el.contains(document.activeElement)), true)
      await page.waitForTimeout(1400)
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(1400)
      assert.equal(await controls.getAttribute('data-visible'), 'true')
      await hidden()
    })
    if (scenario.label === 'desktop') await check('desktop: dragging holds controls and activity resets the timer', async () => {
      await show()
      const slider = await page.getByRole('slider', { name: 'Seek', exact: true }).boundingBox()
      await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(2900)
      assert.equal(await controls.getAttribute('data-visible'), 'true')
      await page.mouse.up()
      await page.waitForTimeout(1400)
      await page.mouse.move(25, 110)
      await page.waitForTimeout(1400)
      assert.equal(await controls.getAttribute('data-visible'), 'true')
      await hidden()
    })
    if (scenario.touch) await check(`${scenario.label}: rotation keeps controls aligned with the room`, async () => {
      await show()
      const before = await page.locator('.mix-room__canvas').getAttribute('data-fullscreen-orientation')
      await page.getByRole('button', { name: /Switch to (landscape|portrait) view/ }).click()
      assert.notEqual(await page.locator('.mix-room__canvas').getAttribute('data-fullscreen-orientation'), before)
      await centered()
      await reachable(page.getByRole('button', { name: 'Pause', exact: true }))
      await reachable(page.getByRole('slider', { name: 'Seek', exact: true }))
      await reachable(page.getByRole('button', { name: 'Exit fullscreen', exact: true }))
      await page.screenshot({ path: path.join(artifacts, `${slug(scenario.label)}-rotated-controls.png`) })
      // Hardware rotation can happen after the software view rotation. Then
      // rotate the view the other way, covering both quarter-turn directions.
      await page.setViewportSize({ width: scenario.viewport.height, height: scenario.viewport.width })
      await show(); await centered()
      await page.getByRole('button', { name: /Switch to (landscape|portrait) view/ }).click()
      await centered()
      await page.setViewportSize(scenario.viewport)
      await show(); await centered()
    })
    await check(`${scenario.label}: volume popup follows room axes and closes on orientation changes`, async () => {
      const popup = page.locator('.mix-room__volume-popup:popover-open')
      const audioSource = await page.locator('audio').getAttribute('src')
      await show()
      if (await page.locator('audio').evaluate(el => el.paused)) await page.getByRole('button', { name: 'Play', exact: true }).click()
      const inspectPopup = async label => {
        await show()
        await page.getByRole('button', { name: 'Volume', exact: true }).click()
        await popup.waitFor()
        const geometry = await popup.evaluate(el => {
          const stage = document.querySelector('.mix-room__canvas-content'), s = stage.getBoundingClientRect()
          const axes = new DOMMatrix(getComputedStyle(stage).transform), popupAxes = new DOMMatrix(getComputedStyle(el).transform)
          const localBounds = rect => {
            const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]]
              .map(([x, y]) => new DOMPoint(x - s.x - s.width / 2, y - s.y - s.height / 2).matrixTransform(axes.inverse()))
            return { left: Math.min(...corners.map(p => p.x)), right: Math.max(...corners.map(p => p.x)), top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)) }
          }
          const p = el.getBoundingClientRect(), trigger = document.querySelector('.mix-room__volume-button').getBoundingClientRect()
          return { aligned: ['a', 'b', 'c', 'd'].every(key => Math.abs(axes[key] - popupAxes[key]) < .001),
            gap: localBounds(trigger).top - localBounds(p).bottom,
            inside: p.left >= 0 && p.top >= 0 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1 }
        })
        assert.equal(geometry.aligned, true, `Volume popup must share the room's axes: ${JSON.stringify(geometry)}`)
        assert.ok(Math.abs(geometry.gap - 8) < 2, `Volume popup must open above its trigger in room coordinates: ${JSON.stringify(geometry)}`)
        assert.equal(geometry.inside, true, 'Volume popup must fit the physical viewport')
        const slider = popup.getByRole('slider', { name: 'Volume', exact: true })
        await reachable(slider); await slider.fill('0.4'); await slider.press('ArrowUp')
        assert.ok(await page.locator('audio').evaluate(el => el.volume) > .4)
        await slider.fill('0.4')
        assert.equal(await page.locator('audio').getAttribute('src'), audioSource)
        assert.equal(await page.locator('audio').count(), 1)
        assert.equal(await page.locator('audio').evaluate(el => el.paused), false)
        await page.screenshot({ path: path.join(artifacts, `${slug(scenario.label)}-${label}-volume.png`) })
      }
      await inspectPopup('initial')
      if (scenario.touch) {
        for (let turn = 0; turn < 2; turn++) {
          await page.getByRole('button', { name: /Switch to (landscape|portrait) view/ }).click()
          await popup.waitFor({ state: 'hidden' })
          await inspectPopup(`software-turn-${turn + 1}`)
          await page.setViewportSize(turn === 0 ? { width: scenario.viewport.height, height: scenario.viewport.width } : scenario.viewport)
          await popup.waitFor({ state: 'hidden' })
          await inspectPopup(`physical-turn-${turn + 1}`)
        }
      } else {
        await page.setViewportSize({ width: scenario.viewport.width + 20, height: scenario.viewport.height })
        await popup.waitFor({ state: 'hidden' })
        await inspectPopup('resized')
        await page.setViewportSize(scenario.viewport)
        await popup.waitFor({ state: 'hidden' })
        await inspectPopup('restored')
      }
      await page.keyboard.press('Escape')
      await popup.waitFor({ state: 'hidden' })
      assert.equal(await page.locator('.mix-room--fullscreen').count(), 1, 'Escape closes volume without exiting fullscreen')
      await show(); await page.getByRole('button', { name: 'Volume', exact: true }).click()
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await page.locator('.mix-room--fullscreen').waitFor({ state: 'detached' })
      await popup.waitFor({ state: 'hidden' })
      if (!scenario.touch) {
        // The same AudioPlayer also serves the ordinary desktop footer.
        await page.getByRole('button', { name: 'Volume', exact: true }).click()
        await popup.waitFor()
        const normal = await popup.evaluate(el => {
          const r = el.getBoundingClientRect(), trigger = document.querySelector('.mix-room__volume-button').getBoundingClientRect()
          const axes = new DOMMatrix(getComputedStyle(el).transform)
          return { width: r.width, gap: trigger.top - r.bottom, upright: axes.a === 1 && axes.b === 0 && axes.c === 0 && axes.d === 1,
            inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 }
        })
        assert.equal(normal.upright, true); assert.equal(normal.inside, true)
        assert.ok(Math.abs(normal.width - 64) < 1 && Math.abs(normal.gap - 8) < 2, JSON.stringify(normal))
        await reachable(popup.getByRole('slider', { name: 'Volume', exact: true }))
        await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' })
      }
      await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
      await controls.waitFor({ state: 'visible' })
      assert.equal(await page.locator('.mix-room__volume-popup:popover-open').count(), 0)
      assert.equal(await page.locator('audio').getAttribute('src'), audioSource)
    })
    if (scenario.touch) await check(`${scenario.label}: unequal safe-area insets stay clear in both room orientations`, async () => {
      // Browser emulation reports zero env() insets. Inject room-relative
      // values to exercise asymmetric cutouts without claiming device coverage.
      const stage = page.locator('.mix-room__canvas-content')
      try {
        for (let turn = 0; turn < 2; turn++) {
          for (const insets of [{ left: 72, right: 0, bottom: 34 }, { left: 0, right: 72, bottom: 34 }]) {
            await stage.evaluate((el, values) => {
              for (const edge of ['left', 'right', 'bottom']) el.style.setProperty(`--fullscreen-controls-safe-${edge}`, `${values[edge]}px`)
            }, insets)
            await show(); await centered(insets)
            await reachable(page.getByRole('slider', { name: 'Seek', exact: true }))
            await reachable(page.getByRole('button', { name: 'Exit fullscreen', exact: true }))
          }
          await page.getByRole('button', { name: /Switch to (landscape|portrait) view/ }).click()
        }
        // Rapid software turns resize the React/Three viewport asynchronously.
        // Capture the settled room rather than an intermediate letterboxed frame.
        await page.waitForFunction(() => {
          const stage = document.querySelector('.mix-room__canvas-content'), viewport = stage.querySelector('.mix-room__viewport')
          return Math.abs(stage.clientWidth - viewport.clientWidth) < 2 && Math.abs(stage.clientHeight - viewport.clientHeight) < 2
        })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
        await page.screenshot({ path: path.join(artifacts, `${slug(scenario.label)}-asymmetric-insets.png`) })
      } finally {
        await stage.evaluate(el => { for (const edge of ['left', 'right', 'bottom']) el.style.removeProperty(`--fullscreen-controls-safe-${edge}`) })
      }
    })
    await check(`${scenario.label}: exit and reentry clean up idle state`, async () => {
      await show()
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await page.locator('.mix-room--fullscreen').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.mix-room__canvas').getAttribute('data-controls-visible'), null)
      assert.equal(await page.locator('audio').count(), 1)
      assert.equal(await page.locator('audio').evaluate(el => el.volume), .4)
      await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
      await controls.waitFor({ state: 'visible' })
      assert.equal(await controls.getAttribute('data-visible'), 'true')
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await page.locator('.mix-room--fullscreen').waitFor({ state: 'detached' })
    })
    console.log(`Completed fullscreen ${scenario.label}`)
    await f.context.close()
  }
}

async function editorChecks() {
  const metadata = JSON.parse(await readFile(path.join(root, 'src/demo/nin-demon-seed/instrument_meta.json'), 'utf8'))
  for (const signedIn of [false, true]) for (const touch of [false, true]) {
    const profile = `${signedIn ? 'account' : 'guest'} ${touch ? 'touch' : 'desktop'}`
    const sizes = touch ? touchSizes : desktopSizes
    const f = await fixture({ signedIn, touch }); page = f.page
    const editor = page.locator('.mix-room__content-overlay--editor')
    for (const [width, height] of sizes) await check(`${profile} ${width}×${height} welcome and empty Editor`, async () => {
      await size(width, height)
      await contained('.mix-room__opening')
      await page.getByRole('heading', { name: 'Welcome to Mix Room', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'MIX DATA', exact: true }).count(), 0)
      assert.equal(await page.locator('.mix-room__opening-actions').first().getByRole('button').count(), 2)
      for (const name of ['Play tutorial', 'Upload track']) await reachable(page.getByRole('button', { name, exact: true }))
      if (signedIn) {
        const libraryLink = page.locator('.mix-room__opening-library')
        await reachable(libraryLink)
        const styles = await libraryLink.evaluate(el => ({ border: getComputedStyle(el).borderTopWidth, background: getComputedStyle(el).backgroundColor, underline: getComputedStyle(el.firstElementChild).textDecorationLine, below: el.getBoundingClientRect().top >= el.previousElementSibling.getBoundingClientRect().bottom }))
        assert.deepEqual(styles, { border: '0px', background: 'rgba(0, 0, 0, 0)', underline: 'underline', below: true })
      }
      if (signedIn && [390, 1440].includes(width)) await page.screenshot({ path: path.join(artifacts, `welcome-${touch ? 'touch' : 'desktop'}-${width}.png`) })
      await go('editor')
      await contained('.mix-room__content-overlay--editor')
      await editor.getByText('No mix loaded', { exact: true }).waitFor()
      await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    })
    if (signedIn) await check(`${profile} welcome library link`, async () => {
      await page.locator('.mix-room__opening-library').click()
      assert.equal(await view(), 'mixes')
      await page.getByRole('button', { name: 'Close mix library', exact: true }).click()
    })
    await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
    await go('editor')
    if (signedIn) for (const [width, height] of sizes) await check(`${profile} ${width}×${height} loaded Editor`, async () => {
      await size(width, height)
      await contained('.mix-room__content-overlay--editor')
      await reachable(editor.getByRole('button', { name: 'Close editor', exact: true }))
      await reachable(editor.getByLabel('Song title', { exact: true }))
      await reachable(editor.getByLabel('Instrument name', { exact: true }).last())
      await reachable(editor.getByRole('button', { name: 'Apply names', exact: true }))
      if ([390, 694, 1440].includes(width)) {
        await editor.getByLabel('Song title', { exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(artifacts, `editor-${touch ? 'touch' : 'desktop'}-${width}.png`) })
      }
    })
    await check(`${profile} Editor rename, tab persistence, validation, and upload separation`, async () => {
      const title = editor.getByLabel('Song title', { exact: true })
      const instrument = editor.getByLabel('Instrument name', { exact: true }).first()
      await title.fill('Edited demo')
      await instrument.fill('Renamed bass')
      await go('processing')
      await page.getByRole('button', { name: 'Stems', exact: true }).click()
      const upload = page.locator('.mix-room__processing-section')
      await reachable(upload.getByRole('button', { name: 'Choose stem files', exact: true }))
      assert.equal(await upload.getByRole('button', { name: 'Apply names', exact: true }).count(), 0)
      assert.equal(await upload.getByLabel('Instrument name', { exact: true }).count(), 0)
      assert.equal(await upload.getByRole('button', { name: 'Back to current mix', exact: true }).count(), 0)
      await go('editor')
      assert.equal(await title.inputValue(), 'Edited demo')
      assert.equal(await instrument.inputValue(), 'Renamed bass')
      await title.fill(' ')
      assert.equal(await editor.getByRole('button', { name: 'Apply names', exact: true }).isDisabled(), true)
      await title.fill('Edited demo')
      await editor.getByRole('button', { name: 'Apply names', exact: true }).click()
      await page.locator('.mix-room__track-title h2').filter({ hasText: 'Edited demo' }).waitFor()
      await page.waitForFunction(() => !document.querySelector('.mix-room__editor-fields').disabled)
      assert.equal(await editor.getByRole('button', { name: 'Apply names', exact: true }).isDisabled(), true)
      await go('instruments')
      await page.getByRole('checkbox', { name: 'Renamed bass', exact: true }).waitFor()
    })
    if (signedIn) for (const mode of ['quick', 'thorough', 'stems']) await check(`${profile} ${mode} mix is editable`, async () => {
      await resetWorkspace()
      const meta = { ...metadata, title: `${mode} fixture`, duration: 1, processingMode: mode, instruments: metadata.instruments.slice(0, 2) }
      const archive = createMixArchive({ version: 1, id: crypto.randomUUID(), metadata: meta, framesByKey: Object.fromEntries(meta.instruments.map(instrument => [instrument.key, [{ t: 0, pan: 0, loud: .5 }]])), audioBlob: new Blob([wav()], { type: 'audio/wav' }) })
      await page.locator('input[aria-label="Choose a Mix Room backup"]').setInputFiles({ name: `${mode}.mixroom`, mimeType: 'application/octet-stream', buffer: Buffer.from(await archive.arrayBuffer()) })
      await page.locator('.mix-room__track-title h2').filter({ hasText: meta.title }).waitFor()
      const source = await page.locator('audio').getAttribute('src')
      await go('editor')
      await editor.getByLabel('Song title', { exact: true }).fill(`${mode} renamed`)
      await editor.getByLabel('Instrument name', { exact: true }).first().fill(`${mode} bass`)
      await editor.getByRole('button', { name: 'Apply names', exact: true }).click()
      await page.locator('.mix-room__track-title h2').filter({ hasText: `${mode} renamed` }).waitFor()
      assert.equal(await page.locator('audio').getAttribute('src'), source, 'Renaming preserves the audio')
      assert.equal(await editor.getByLabel('Instrument name', { exact: true }).first().inputValue(), `${mode} bass`)
    })
    console.log(`Completed ${profile} welcome and Editor checks`)
    await f.context.close()
  }
}

// A small review before a human walkthrough. Reuse the same disposable fixtures,
// actual page controls and reachability checks as the targeted design suites.
async function reviewSurface(touch) {
  const issues = await page.evaluate(touch => {
    const issues = []
    if (document.documentElement.scrollWidth > innerWidth + 2) issues.push('page has horizontal overflow')
    for (const el of document.querySelectorAll('.mix-room__tab-label, .mix-room__mobile-navigation button, .mix-room__overlay-header h2')) {
      if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 2) issues.push(`clipped text: ${el.textContent.trim()}`)
    }
    if (touch) for (const el of document.querySelectorAll('button:not(:disabled), input:not([type="file"]):not([type="hidden"]):not([type="range"]):not(:disabled)')) {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect()
      if (!el.getClientRects().length || style.visibility === 'hidden' || style.opacity === '0') continue
      const target = el.matches('[type="checkbox"], [type="radio"]') ? el.closest('label') ?? el : el
      const box = target.getBoundingClientRect()
      if (rect.width && rect.height && (box.width < 24 || box.height < 24)) issues.push(`small touch target: ${el.getAttribute('aria-label') || el.textContent.trim() || el.type}`)
    }
    return issues
  }, touch)
  assert.deepEqual(issues, [], issues.join('; '))
}

async function reviewRoomLabels() {
  // Read the existing scene through its owning React ref; no app/test hook or
  // production source change. Check projected bounds, leaving visual taste to Design.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas')
    const key = canvas && Object.keys(canvas).find(key => key.startsWith('__reactFiber'))
    for (let fiber = key && canvas[key]; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const state = hook.memoizedState?.current
        if (state?.gl?.domElement !== canvas || !state.scene) continue
        let ready = 0
        state.scene.traverse(object => { if (object.text && object.textRenderInfo?.blockBounds) ready++ })
        return ready > 0
      }
    }
    return false
  })
  const labels = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), key = Object.keys(canvas).find(key => key.startsWith('__reactFiber'))
    let state
    for (let fiber = canvas[key]; fiber && !state; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      if (hook.memoizedState?.current?.gl?.domElement === canvas) { state = hook.memoizedState.current; break }
    }
    const labels = []
    state.scene.updateMatrixWorld(true)
    state.scene.traverse(object => {
      if (!object.text || !object.textRenderInfo?.blockBounds) return
      for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return
      const [left, bottom, right, top] = object.textRenderInfo.blockBounds
      const points = [[left, bottom], [left, top], [right, bottom], [right, top]].map(([x, y]) => {
        const point = object.position.clone().set(x, y, 0)
        object.localToWorld(point).project(state.camera)
        return { x: (point.x + 1) * canvas.clientWidth / 2, y: (1 - point.y) * canvas.clientHeight / 2 }
      })
      labels.push({ text: object.text, left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) })
    })
    return { labels, width: canvas.clientWidth, height: canvas.clientHeight }
  })
  assert.ok(labels.labels.length, 'No visible instrument labels after seeking into the demo')
  for (const label of labels.labels) assert.ok(Number.isFinite(label.left + label.top + label.right + label.bottom) && label.right > label.left && label.bottom > label.top && label.left >= -2 && label.top >= -2 && label.right <= labels.width + 2 && label.bottom <= labels.height + 2, `Label outside room: ${JSON.stringify(label)}`)
}

async function reviewChecks() {
  for (const profile of selectedProfiles) {
    const { touch, ...viewport } = reviewProfiles[profile]
    if (selectedJourneys.includes('welcome')) {
      const f = await fixture({ touch, viewport, signedIn: false }); page = f.page
      try {
        await check(`${profile}:welcome`, async () => {
          await page.locator('#opening-room-title').waitFor()
          assert.ok((await page.locator('#opening-room-title').textContent()).trim(), 'Welcome heading has no text')
          await contained('.mix-room__opening')
          await reachable(page.getByRole('button', { name: 'Play tutorial', exact: true }))
          await reachable(page.getByRole('button', { name: 'Upload track', exact: true }))
          await reviewSurface(touch)
          const opener = page.locator('.mix-room__guest-signup')
          await reachable(opener); await opener.click()
          const dialog = page.getByRole('dialog')
          await dialog.getByRole('heading', { name: 'Create account', exact: true }).waitFor()
          const email = dialog.getByLabel('Email', { exact: true })
          await email.waitFor(); await reachable(email)
          await page.waitForFunction(() => document.activeElement?.getAttribute('autocomplete') === 'email')
          for (const label of ['Password', 'Confirm password']) await reachable(dialog.getByLabel(label, { exact: true }))
          await reviewSurface(touch)
          await page.keyboard.press('Escape')
          await dialog.waitFor({ state: 'hidden' })
          assert.ok(await opener.evaluate(el => el === document.activeElement), 'Signup must return focus to its opener')
        })
      } finally { await f.context.close() }
    }
    if (!selectedJourneys.some(journey => journey !== 'welcome')) continue
    const f = await fixture({ touch, viewport }); page = f.page
    try {
      if (selectedJourneys.includes('workspace')) await check(`${profile}:workspace`, async () => {
        await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
        await page.getByRole('button', { name: 'Skip tutorial', exact: true }).click()
        if (await page.getByRole('button', { name: 'Play', exact: true }).isVisible()) await page.getByRole('button', { name: 'Play', exact: true }).click()
        await page.waitForFunction(() => document.querySelector('audio').currentTime > .1)
        await page.evaluate(() => { window.reviewAudio = document.querySelector('audio') })
        await page.getByRole('slider', { name: 'Seek', exact: true }).fill('30')
        for (const target of ['instruments', 'processing', 'mixes', 'settings', 'about', 'editor', 'demo', 'playing']) {
          await go(target)
          await reviewSurface(touch)
          assert.ok(await page.evaluate(() => document.querySelector('audio') === window.reviewAudio && !window.reviewAudio.paused), `Playback restarted in ${target}`)
          if (target === 'instruments') await reachable(page.locator('.mix-room__instrument-options input').last())
          else if (target === 'processing') await reachable(page.getByRole('button', { name: 'Choose file', exact: true }))
          else if (target === 'settings') await reachable(page.getByLabel('Label size', { exact: true }))
          else if (target === 'editor') await reachable(page.getByLabel('Instrument name', { exact: true }).last())
        }
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await page.getByRole('slider', { name: 'Seek', exact: true }).fill('30')
        await reviewRoomLabels()
        assert.ok(await page.locator('audio').evaluate(el => el.paused && Math.abs(el.currentTime - 30) < 1), 'Paused seeking changed playback state')
      })
      if (selectedJourneys.includes('account')) await check(`${profile}:account`, async () => {
        await go('account')
        await contained('.account-page')
        for (const label of ['Close account page', 'Sign out']) await reachable(page.getByRole('button', { name: label, exact: true }))
        await reviewSurface(touch)
        await page.getByRole('button', { name: 'Close account page', exact: true }).click()
        assert.notEqual(await view(), 'account')
      })
    } finally { await f.context.close() }
  }
}

async function tutorialChecks() {
  const caption = () => page.locator('.mix-room__tutorial-caption')
  const seek = async (time, id) => {
    await page.locator('audio').evaluate((audio,time) => { audio.currentTime=time; audio.dispatchEvent(new Event('seeking')) },time)
    if(id)await page.waitForFunction(id=>document.querySelector('.mix-room__tutorial-caption')?.dataset.section===id,id)
  }
  const shapePath = key => page.locator(`[data-tutorial-target="${key}"] [data-part="shape"]`)
  const hole = async (key,active) => { await page.waitForFunction(({key,active})=>Boolean(document.querySelector(`[data-tutorial-target="${key}"] [data-part="shape"]`)?.getAttribute('d'))===active,{key,active}) }
  const fit = async () => {
    await contained('.mix-room__tutorial-caption', (await page.locator('.mix-room--fullscreen').count()) ? '.mix-room__canvas-content' : '#room-workspace')
    await reachable(page.getByRole('button',{name:'Skip tutorial',exact:true}))
    if (await view() === 'playing') await contained('.mix-room__tutorial-skip', '.mix-room__canvas')
    assert.equal(await page.locator('.mix-room__tutorial-companion').count(),0)
  }
  const voiceFrames=JSON.parse(await readFile(path.join(root,'src/demo/nin-demon-seed/lead_vocals_frames.json'),'utf8'))
  const passages=buildTutorialPassages(voiceFrames)
  const rest=voiceFrames.find(f=>f.t>45&&f.t<53&&f.loud<=.08&&inTutorialPassage(passages,f.t)).t
  for(const name of selectedTutorialProfiles){
    const{touch,...viewport}=reviewProfiles[name]
    const f=await fixture({touch,viewport,signedIn:false,fallbackFullscreen:true});page=f.page
    try {await check(`tutorial ${name}: revision3 overlay, passages, ordinary panels and ending`,async()=>{
      const before=await page.locator('.mix-room__canvas').boundingBox()
      await page.getByRole('button',{name:'Play tutorial',exact:true}).click()
      await page.waitForFunction(()=>!document.querySelector('audio').paused)
      await page.getByRole('button',{name:'Pause',exact:true}).click()
      await page.evaluate(()=>{window.r3Audio=document.querySelector('audio');window.r3Canvas=document.querySelector('canvas')})
      const after=await page.locator('.mix-room__canvas').boundingBox()
      assert.ok(Math.abs(before.width-after.width)<1&&Math.abs(before.height-after.height)<1,`Guide changed original room: ${JSON.stringify({before,after})}`)
      if(name==='reference')assert.ok(Math.abs(after.width-359)<1&&Math.abs(after.height-224.375)<1,JSON.stringify(after))
      await seek(0,'intro');await hole('drums',false);await fit()
      assert.equal(await page.locator('.mix-room__tutorial-veil').evaluate(el=>getComputedStyle(el).opacity),'1')
      await seek(.8);await hole('drums',true)
      await seek(12,'frequency');assert.equal(await caption().locator('h2').textContent(),'Frequency');await hole('bass',true)
      assert.ok(await page.evaluate(() => {
        const caption = document.querySelector('.mix-room__tutorial-caption').getBoundingClientRect()
        const veil = document.querySelector('.mix-room__tutorial-veil')
        const matrix = veil.getScreenCTM()
        return [...veil.querySelectorAll('[data-part="shape"], [data-part="label"]')].every(path => {
          if (!path.getAttribute('d')) return true
          const bounds = path.getBBox()
          const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
            [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]]
            .map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix))
          return caption.right <= Math.min(...corners.map(point => point.x))
            || caption.left >= Math.max(...corners.map(point => point.x))
            || caption.bottom <= Math.min(...corners.map(point => point.y))
            || caption.top >= Math.max(...corners.map(point => point.y))
        })
      }), 'Frequency caption covers a highlighted instrument or label')
      await seek(44,'frequency');assert.equal(await shapePath('lead_vocals').count(),0)
      await seek(45,'volume');assert.equal(await caption().locator('h2').textContent(),'Volume');await hole('lead_vocals',true);await hole('guitar',true)
      await seek(rest);await hole('lead_vocals',true)
      await seek(53,'panning');await hole('bass',true);await hole('lead_vocals',true)
      const centers=await page.evaluate(()=>Object.fromEntries(['bass','lead_vocals'].map(key=>{const b=document.querySelector(`[data-tutorial-target="${key}"] [data-part="shape"]`).getBBox();return[key,b.x+b.width/2]})))
      assert.ok(centers.lead_vocals<centers.bass)
      await seek(79,'panning');assert.equal(await shapePath('guitar').count(),0)
      if(name==='landscape'){await size(667,375);await fit()}
      await seek(110,'visibility');await page.waitForFunction(()=>document.querySelector('.mix-room').dataset.view==='instruments')
      assert.equal(await page.locator('.mix-room__instrument-options input:checked').count(),13)
      await fit()
      await seek(128,'editor');await page.waitForFunction(()=>document.querySelector('.mix-room').dataset.view==='editor')
      const field=page.locator('#editor-instrument-guitar')
      assert.equal(await field.count(),1);await field.fill('Conference guitar');await field.evaluate(el=>{window.r3Field=el})
      await seek(145,'preferences')
      assert.equal(await view(),'editor','A focused real field must not be replaced by an automatic panel change')
      await page.waitForFunction(()=>{const el=document.querySelector('#editor-instrument-guitar'),r=el.getBoundingClientRect();return el===window.r3Field&&el===document.activeElement&&el.value==='Conference guitar'&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el})
      await caption().getByRole('button',{name:'Show Preferences controls',exact:true}).click()
      await page.waitForFunction(()=>document.querySelector('.mix-room').dataset.view==='settings')
      assert.equal(await page.locator('#room-style').count(),1);assert.equal(await page.locator('#instrument-label-size').count(),1)
      const originalStyle=await page.locator('#room-style-current').textContent(),scale=await page.locator('#instrument-label-size').inputValue()
      assert.equal(await field.inputValue(),'Conference guitar')
      await reachable(page.getByRole('button',{name:'Reset view',exact:true}));await reachable(page.locator('#room-style'));await page.locator('#room-style').click();await page.keyboard.press('Escape')
      assert.equal(await page.locator('#room-style-current').textContent(),originalStyle);assert.equal(await page.locator('#instrument-label-size').inputValue(),scale)
      // Explicitly close the existing panel; guidance/music stay armed.
      await page.getByRole('button',{name:'Close settings',exact:true}).click()
      await page.waitForFunction(()=>document.querySelector('.mix-room').dataset.view==='playing')
      await seek(165,'ending');await fit()
      assert.equal(await page.locator('.mix-room__tutorial-veil').evaluate(el=>getComputedStyle(el).opacity),'0')
      for(const label of ['Upload tracks','Replay demo'])await reachable(caption().getByRole('button',{name:label,exact:true}))
      await seek(250,'ending');assert.equal(await caption().getByRole('button',{name:'Replay demo',exact:true}).count(),1)
      await page.locator('.mix-room__top-actions').getByRole('button',{name:'Enter fullscreen',exact:true}).click();await page.locator('.mix-room--fullscreen').waitFor()
      if(touch)await page.getByRole('button',{name:/Switch to (landscape|portrait) view/}).click()
      await fit();for(const label of ['Upload tracks','Replay demo'])await reachable(caption().getByRole('button',{name:label,exact:true}))
      await page.waitForTimeout(2200);assert.equal(await page.getByRole('button',{name:'Skip tutorial',exact:true}).isVisible(),true)
      await page.locator('.mix-room__canvas').dispatchEvent('pointermove');await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await page.locator('.mix-room--fullscreen').waitFor({state:'hidden'})
      await page.locator('audio').evaluate(audio=>audio.currentTime=165)
      const previous=await page.locator('audio').evaluate(audio=>({time:audio.currentTime,paused:audio.paused}))
      await page.getByRole('button',{name:'Skip tutorial',exact:true}).click()
      assert.deepEqual(await page.locator('audio').evaluate(audio=>({time:audio.currentTime,paused:audio.paused})),previous)
      await seek(45);assert.equal(await caption().count(),0)
      assert.ok(await page.locator('audio').evaluate(audio=>audio===window.r3Audio));assert.ok(await page.locator('canvas').evaluate(canvas=>canvas===window.r3Canvas))
      await go('processing');await go('playing');assert.equal(await caption().count(),0)
    })}finally{await f.context.close()}
  }
  const native=await fixture({signedIn:false,touch:true,viewport:{width:393,height:852}});page=native.page
  try{await check('tutorial: native fullscreen opens the original inspector and Replay restarts guide',async()=>{
    await page.getByRole('button',{name:'Play tutorial',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).click()
    await seek(53,'panning');await page.locator('.mix-room__top-actions').getByRole('button',{name:'Enter fullscreen',exact:true}).click();await page.locator('.mix-room--fullscreen').waitFor()
    assert.ok(await page.evaluate(()=>Boolean(document.fullscreenElement)), 'This case requires the actual native Chrome fullscreen path')
    await seek(110,'visibility');
    try { await page.locator('.mix-room--fullscreen').waitFor({state:'hidden',timeout:4000}) }
    catch(error){console.error('NATIVE EXIT STATE',await page.evaluate(()=>({native:Boolean(document.fullscreenElement),canvas:document.querySelector('.mix-room__canvas')?.className,exitDisabled:document.querySelector('.mix-room__exit-fullscreen')?.disabled})));throw error}
    await page.waitForFunction(()=>document.querySelector('.mix-room').dataset.view==='instruments')
    await reachable(page.getByRole('button',{name:'Skip tutorial',exact:true}));assert.equal(await page.locator('.mix-room__instrument-options').count(),1)
    await page.locator('.mix-room__sidebar .mix-room__overlay-close').click();await seek(165,'ending')
    await caption().getByRole('button',{name:'Replay demo',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mix-room__tutorial-caption')?.dataset.section==='intro'&&!document.querySelector('audio').paused&&document.querySelector('audio').currentTime<2)
  })}finally{await native.context.close()}
  const f=await fixture({signedIn:false,touch:true,viewport:{width:393,height:852},denyPlayback:true});page=f.page
  try{await check('tutorial: revision3 denied playback and ordinary account exit',async()=>{
    await page.getByRole('button',{name:'Play tutorial',exact:true}).click();await caption().getByText('Press Play to start the tutorial.',{exact:true}).waitFor()
    await hole('drums',false);await page.evaluate(()=>{window.fixturePlayDenied=false});await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForFunction(()=>document.querySelector('audio').currentTime>.8)
    await hole('drums',true);await page.locator('.account-access').click();await page.getByRole('dialog').waitFor();await caption().waitFor({state:'hidden'})
  })}finally{await f.context.close()}
}

async function reviewSourceIdentity() {
  const digest = createHash('sha256')
  let files = 0
  const visit = async relative => {
    const full = path.join(root, relative), info = await stat(full)
    if (info.isDirectory()) {
      for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() || entry.isFile()) await visit(path.join(relative, entry.name))
      }
    } else {
      const bytes = await readFile(full)
      digest.update(relative + '\0' + createHash('sha256').update(bytes).digest('hex') + '\n'); files++
    }
  }
  for (const entry of ['src', 'shared', 'public', 'auth', 'index.html', 'package.json', 'scripts/checkDesign.mjs']) await visit(entry)
  return { sha256: digest.digest('hex'), files }
}

let reviewSource
try {
  if (reviewOnly || tutorialOnly) reviewSource = await reviewSourceIdentity()
  await preview.listen()
  origin = preview.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ channel: process.env.MIX_ROOM_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] })
  if (reviewOnly) await reviewChecks()
  if (tutorialOnly) await tutorialChecks()
  if (fullscreenOnly) await fullscreenChecks()
  if (editorOnly) await editorChecks()
  for (const [profile, sizes] of interactionsOnly ? [] : [['desktop', desktopSizes], ['touch', touchSizes]]) {
    const f = await fixture({ touch: profile === 'touch' }); page = f.page
    await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
    for (const [width, height] of sizes) {
      await size(width, height)
      for (const target of ['playing', 'instruments', 'processing', 'mixes', 'about', 'settings', 'editor', 'demo', 'account']) {
        await check(`${profile} ${width}×${height} ${target}`, () => geometry(target))
        if ((profile === 'desktop' && width === 599 && target === 'editor') || (profile === 'desktop' && width === 694 && target === 'processing') || (profile === 'touch' && width === 390 && height === 844 && target === 'playing')) await page.screenshot({ path: path.join(artifacts, `${profile}-${width}-${height}-${target}.png`) })
        if (target === 'instruments' && [694, 889, 901, 1440].includes(width)) await page.screenshot({ path: path.join(artifacts, `${profile}-${width}-instruments.png`) })
      }
      console.log(`Checked ${profile} ${width}×${height}`)
    }
    console.log(`Completed ${profile} geometry: ${sizes.length} viewports × 9 features`)
    await f.context.close()
  }
  for (const [profile, viewport] of (tutorialOnly || reviewOnly || guestOnly || fullscreenOnly || editorOnly) ? [] : roomStyleOnly ? [['desktop', { width: 1150, height: 984 }], ['touch', { width: 390, height: 844 }], ['touch', { width: 844, height: 390 }]] : [['desktop', { width: 694, height: 647 }], ['desktop', { width: 1101, height: 720 }], ['touch', { width: 390, height: 844 }], ['touch', { width: 844, height: 390 }]]) await interactions(profile, viewport)
  if (!tutorialOnly && !reviewOnly && !fullscreenOnly && !roomStyleOnly && !editorOnly && !interactionMatch) {
  for (const signedIn of [false, true]) for (const touch of [false, true]) for (const failureType of ['preparation', 'service']) {
    const profile = touch ? 'touch' : 'desktop'
    const f = await fixture({ signedIn, touch, viewport: touch ? { width: 390, height: 844 } : { width: 694, height: 647 } }); page = f.page
    await check(`${signedIn ? 'account' : 'guest'} first upload ${failureType} error and retry on ${profile}`, async () => {
      // Record every DOM transition, including short-lived overlapping overlays.
      await page.evaluate(() => {
        window.uploadOverlayOverlaps = []
        new MutationObserver(() => {
          if (document.querySelector('.mix-room__opening') && document.querySelector('.mix-room__loading')) window.uploadOverlayOverlaps.push(true)
        }).observe(document.querySelector('#root'), { childList: true, subtree: true })
      })
      await go('processing')
      await page.getByRole('button', { name: 'Audio file', exact: true }).click()
      await page.waitForFunction(expected => document.querySelector('#processing-allowance')?.textContent === expected, signedIn ? '3 audio file analyses remaining' : 'Sign in for three one-time audio-file credits. Your selected file stays in this tab.')
      await page.getByRole('button', { name: 'Stems', exact: true }).click()
      assert.equal(await page.locator('#processing-allowance').textContent(), signedIn ? 'Unlimited stem analysis' : '1 stem analysis remaining')
      await page.getByRole('button', { name: 'Audio file', exact: true }).click()
      const file = failureType === 'preparation'
        ? { name: 'unreadable-first-track.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('Invalid audio fixture') }
        : audioFile('outage-test.wav')
      await page.locator('input[aria-label="Choose audio file"]').setInputFiles(file)
      const jobsBefore = requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length
      if (!signedIn) {
        await page.getByRole('button', { name: 'Sign in to separate', exact: true }).click()
        await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Sign in', exact: true }) }).waitFor()
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('#selected-filename').textContent(), file.name)
        assert.equal(requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length, jobsBefore)
        return
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.getByRole('button', { name: 'Analyze audio file', exact: true }).click()
        const failureDialog = page.getByRole('alertdialog', { name: 'Processing stopped', exact: true })
        await failureDialog.waitFor()
        assert.equal(await page.locator('.mix-room__opening').count(), 0)
        assert.equal(await page.locator('.mix-room__loading').count(), 1, 'Only the error overlay is mounted')
        assert.equal(await failureDialog.locator('h2').textContent(), file.name)
        await contained('.mix-room__failure')
        await reachable(failureDialog.getByRole('button', { name: 'Close', exact: true }))
        if (!signedIn && !touch && failureType === 'service' && attempt === 0) {
          for (const [width, height] of [[694, 647], [599, 647], [390, 844], [844, 390], [1440, 900]]) {
            await size(width, height)
            await contained('.mix-room__failure')
            await reachable(failureDialog.getByRole('button', { name: 'Close', exact: true }))
          }
          await page.screenshot({ path: path.join(artifacts, 'guest-processing-outage.png') })
        }
        if (!signedIn && failureType === 'preparation' && attempt === 0) await page.screenshot({ path: path.join(artifacts, `first-upload-error-${profile}.png`) })
        if (attempt === 0) await failureDialog.getByRole('button', { name: 'Close', exact: true }).click()
        else await page.keyboard.press('Escape')
        await page.waitForFunction(() => document.querySelector('.mix-room')?.dataset.view === 'processing')
        assert.equal(await failureDialog.count(), 0)
        assert.equal(await page.locator('.mix-room__opening').count(), 0)
        assert.equal(await page.locator('#selected-filename').textContent(), file.name, 'Close retains the selected file')
        const analyze = page.getByRole('button', { name: 'Analyze audio file', exact: true })
        assert.equal(await analyze.isEnabled(), true)
        await reachable(analyze)
        await reachable(page.getByRole('button', { name: 'Change file', exact: true }))
        await reachable(page.locator('.mix-room__processing-error button').first())
        if (!signedIn && failureType === 'preparation' && attempt === 0) await page.screenshot({ path: path.join(artifacts, `first-upload-retry-${profile}.png`) })
      }
      const submitted = requests.filter(req => req.path === '/api/separation/jobs' && req.method === 'POST').length - jobsBefore
      assert.equal(submitted, failureType === 'preparation' ? 0 : 2, 'Retry follows the correct preparation/submission path')
      assert.deepEqual(await page.evaluate(() => window.uploadOverlayOverlaps), [], 'Opening never overlaps progress or errors')
    })
    await f.context.close()
  }
  const native = await fixture(); page = native.page
  await check('native fullscreen and exit preserve room layout', async () => {
    await page.getByRole('button', { name: 'Play tutorial', exact: true }).click()
    await page.locator('.mix-room__top-actions').getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.waitForFunction(() => document.fullscreenElement !== null)
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
    await page.waitForFunction(() => document.fullscreenElement === null)
    await frame()
  })
  await native.context.close()
  }
  await check('no external services, runtime errors, or real account writes', async () => { assert.deepEqual(leaks, []); assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, []); assert.ok(!requests.some(req => req.path.includes('change-email'))) })
  if (reviewOnly || tutorialOnly) await check('local source unchanged during review', async () => { assert.deepEqual(await reviewSourceIdentity(), reviewSource) })
} catch (error) {
  results.push({ name: 'suite setup or teardown', passed: false, error: error.stack || error.message })
  console.error(error)
} finally {
  const report = { checkedAt: new Date().toISOString(), browser: browser?.version(), desktopSizes, touchSizes, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results, errors, leaks, realAccountChanges: 0, realProviderJobs: 0, artifacts }
  if (tutorialOnly) report.tutorial = { profiles: selectedTutorialProfiles, candidate: process.env.MIX_ROOM_TUTORIAL_BUILD || 'current local source', source: reviewSource, environmentFilesLoaded: false, blockedWrites }
  if (reviewOnly) {
    delete report.desktopSizes; delete report.touchSizes
    report.review = { profiles: selectedProfiles.map(name => ({ name, ...reviewProfiles[name] })), journeys: selectedJourneys, source: reviewSource, candidate: 'current local source served by isolated Vite; no hosted candidate tested', node: process.version, environmentFilesLoaded: false, mocked: ['account identity/session', 'account and processing configuration', 'empty private library'], blockedWrites, gaps: ['Native phone keyboard, safe areas, rotation/fullscreen, zoom and screen readers need separate evidence.', 'Projected label bounds and control geometry do not certify visual polish, text contrast or a complete accessibility audit.', 'Signup opens only; no account is created, no email sent, and no save/upload/provider job runs.', 'Final Design judgment and any material-risk targeted suites still apply.'] }
  }
  await writeFile(path.join(artifacts, reviewOnly ? 'result.json' : tutorialOnly ? 'results-tutorial.json' : interactionMatch ? 'results-interaction-filter.json' : editorOnly ? 'results-editor.json' : fullscreenOnly ? 'results-fullscreen.json' : guestOnly ? 'results-guest.json' : roomStyleOnly ? 'results-room-style.json' : interactionsOnly ? 'results-interactions.json' : 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, artifacts }, null, 2))
  await browser?.close(); await preview.close()
  if (report.failed) process.exitCode = 1
}
