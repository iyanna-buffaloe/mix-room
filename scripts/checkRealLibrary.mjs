import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createMixService, savedMixConfig } from '../server/mixes/service.js'
import { createMixRepository } from '../server/mixes/repository.js'
import { createSavedMixStorage } from '../server/mixes/storage.js'
import { createR2Storage } from '../server/separation/storage.js'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createMixClient } from '../src/library/mixClient.js'
import { createMixArchive, readMixArchive } from '../src/audio/mixArchive.js'
import { MIX_ARCHIVE_TYPE } from '../shared/savedMix.js'
import { disposableMixScope } from './fixtures/disposableMixScope.mjs'

// Explicitly opt in. Creates only two disposable confirmed test accounts and
// quiet synthetic audio; finally removes their objects/accounts. Never calls
// separation, signup-email, or any existing user's library. Credentials, session
// tokens and signed URLs stay in memory and are never included in the report.
if (!process.argv.includes('--live')) throw new Error('This check uses real services. Run with --live to create and remove disposable test accounts.')
const env = process.env, config = savedMixConfig(env)
assert.ok(config.available && env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Real saved-mix configuration is required')
assert.equal(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.VITE_SUPABASE_URL, 'Browser and server must use the same project')
const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = env.MIX_ROOM_LIBRARY_ARTIFACTS || path.join(os.tmpdir(), 'mix-room-real-library-check')
await mkdir(artifacts, { recursive: true })
const authOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
const network = (input, options = {}) => fetch(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: authOptions, global: { fetch: network } })
const scope = disposableMixScope()
const repository = scope.repository(createMixRepository(env)), storage = scope.storage(createSavedMixStorage(env))
const hosted = process.argv.includes('--hosted')
const retention = process.argv.includes('--retention')
assert.ok(!retention || env.R2_BUCKET_NAME && env.R2_BUCKET_NAME !== env.R2_SAVED_MIXES_BUCKET_NAME, 'Retention checks require a distinct temporary upload bucket')
const currentBuild = process.argv.includes('--current-build')
assert.ok(!currentBuild || hosted, '--current-build checks the current frontend against the real hosted backend')
const origin = hosted ? new URL(env.MIX_ROOM_LIVE_ORIGIN || 'https://mixroom.click').origin : 'http://127.0.0.1:5173'
assert.ok(!hosted || ['https://mixroom.click', 'https://mixingvisualizer.netlify.app', 'https://friday-integration--mixingvisualizer.netlify.app'].includes(origin), 'Use a known Mix Room HTTPS origin for hosted checks')
const service = createMixService({ config, repository, storage })
let nextHostedRequest = 0
let lastHostedResponse = null
const paceHostedRequest = async () => {
  const delay = Math.max(0, nextHostedRequest - Date.now())
  nextHostedRequest = Math.max(nextHostedRequest, Date.now()) + 1100
  if (delay) await new Promise(resolve => setTimeout(resolve, delay))
}
const dispatch = async request => {
  if (!hosted) return service(request)
  await paceHostedRequest()
  const response = await network(request)
  const data = await response.clone().json().catch(() => null)
  lastHostedResponse = { method: request.method, status: response.status, path: new URL(request.url).pathname.replace(/[a-f0-9-]{36}/g, ':id'), ...(typeof data?.code === 'string' && /^[A-Z_]+$/.test(data.code) ? { code: data.code } : {}) }
  return response
}
const checkStorageTarget = input => {
  if (!hosted) return
  const url = new URL(input)
  const bucket = env.R2_SAVED_MIXES_BUCKET_NAME
  const endpoint = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const pathStyle = url.hostname === endpoint && url.pathname.startsWith(`/${bucket}/`)
  const virtualHost = url.hostname === `${bucket}.${endpoint}`
  assert.ok(pathStyle || virtualHost, 'Hosted storage must match the configured cleanup account and bucket')
  const key = pathStyle ? url.pathname.slice(bucket.length+1) : url.pathname
  assert.ok(users.includes(key.split('/')[2]), 'Hosted objects must belong to a disposable account from this run')
  scope.object(key.replace(/^\//, ''))
}
const users = [], uploads = [], results = [], browserErrors = []
let browser, preview, phase = 'configuration', failure = false, cleanupFailed = false
let temporarySourceKey, temporaryClient
const removeTemporarySource = async () => {
  if (temporarySourceKey) await temporaryClient.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: temporarySourceKey }), { abortSignal: AbortSignal.timeout(30000) })
}
const pass = label => { phase = label; results.push({ check: label, passed: true }); console.log(`PASS ${label}`) }
const begin = label => { phase = label }
const digest = async blob => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')
const unwrap = result => { assert.ok(!result.error, `Provider request failed in ${phase}`); return result.data }

function audioRecord(title, frequency = 440) {
  const rate = 22050, count = rate * 3, wav = new Uint8Array(44 + count * 2), header = new DataView(wav.buffer)
  const str = (at, text) => { for (let n = 0; n < text.length; n++) wav[at + n] = text.charCodeAt(n) }
  str(0, 'RIFF'); header.setUint32(4, wav.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); header.setUint32(16, 16, true)
  header.setUint16(20, 1, true); header.setUint16(22, 1, true); header.setUint32(24, rate, true); header.setUint32(28, rate * 2, true)
  header.setUint16(32, 2, true); header.setUint16(34, 16, true); str(36, 'data'); header.setUint32(40, count * 2, true)
  for (let n = 0; n < count; n++) header.setInt16(44 + n * 2, Math.round(Math.sin(n * 2 * Math.PI * frequency / rate) * 500), true)
  return { version: 1, id: randomUUID(), metadata: { title, duration: 3, processingMode: 'stems', instruments: [{ key: 'tone', label: 'Test tone', freq: frequency, pan: 0, width: 0, rms: .05, fileName: 'synthetic.wav' }] },
    framesByKey: { tone: Array.from({ length: 61 }, (_, n) => ({ t: n / 20, loud: .5, pan: 0, width: 0 })) }, audioBlob: new Blob([wav], { type: 'audio/wav' }) }
}
async function api(session, route = '', method = 'GET', body) {
  return dispatch(new Request(origin + '/api/mixes' + route, { method, headers: { ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
function clientFor(session) {
  return createMixClient({ getAccessToken: async () => session.access_token, fetcher: (input, options) => {
    if (input.startsWith('/api/mixes')) return dispatch(new Request(origin + input, options))
    checkStorageTarget(input)
    return network(input, options)
  } })
}
function attempt(owner, name, row) {
  const value = { uploadId: randomUUID(), mixId: row?.id ?? randomUUID(), name, expectedRevision: row?.revision ?? null }
  scope.registerUpload(owner, value.uploadId)
  uploads.push({ owner, id: value.uploadId }); return value
}
async function identity() {
  const email = `mix-room-check-${randomUUID()}@example.com`, password = randomBytes(32).toString('base64url')
  const created = unwrap(await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: 'disposable-library-check' } })).user
  users.push(created.id)
  scope.registerCreatedAccount(created.id)
  const auth = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: authOptions, global: { fetch: network } })
  const session = unwrap(await auth.auth.signInWithPassword({ email, password })).session
  return { id: created.id, session, auth, email, password, client: clientFor(session) }
}
async function browserPage(session) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  const key = `sb-${new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  await context.addInitScript(({ key, session }) => {
    // One initial seed, so reload after sign-out cannot restore the old login.
    if (!sessionStorage.getItem('library-check-seeded')) { localStorage.setItem(key, JSON.stringify(session)); sessionStorage.setItem('library-check-seeded', 'yes') }
  }, { key, session })
  if (currentBuild) await context.route(origin+'/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.startsWith('/api/')) { await route.fallback(); return }
    const folder = path.join(root, 'dist')
    const file = path.resolve(folder, '.'+(pathname === '/' ? '/index.html' : pathname))
    if (!file.startsWith(folder+path.sep) || !(await stat(file).catch(()=>null))?.isFile()) { await route.fallback(); return }
    await route.fulfill({ path: file })
  })
  await context.route('**/api/separation/**', route => route.fulfill({ json: route.request().url().endsWith('/config') ? { available: false, maxSeconds: 360 } : { remaining: 0, stemsRemaining: null, scope: 'account' } }))
  if (hosted) await context.route('https://*.r2.cloudflarestorage.com/**', route => {
    checkStorageTarget(route.request().url())
    return route.continue()
  })
  await context.route('**/api/mixes{,/**}', async route => {
    const req = route.request(), body = req.postData()
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/uploads')) {
      const value = JSON.parse(body), bearer = req.headers().authorization
      const owner = users.find(id => session.user.id === id && bearer === `Bearer ${session.access_token}`)
      assert.ok(owner, 'Only the disposable owner may create browser uploads'); scope.registerUpload(owner, value.uploadId); uploads.push({ owner, id: value.uploadId })
    }
    if (hosted) { await paceHostedRequest(); await route.continue(); return }
    const response = await service(new Request(req.url(), { method: req.method(), headers: req.headers(), ...(!['GET', 'HEAD'].includes(req.method()) ? { body: body || '' } : {}) }))
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  const page = await context.newPage(); page.setDefaultTimeout(30000)
  page.on('pageerror', () => browserErrors.push(phase)); page.on('dialog', dialog => dialog.accept())
  const navigation = await page.goto(origin)
  assert.ok(navigation.ok(), 'The hosted page must load successfully')
  await page.getByRole('button', { name: 'Account', exact: true }).waitFor()
  return { context, page }
}
async function openMix(page, name) {
  await page.getByRole('tab', { name: 'My mixes', exact: true }).click()
  const library = page.getByRole('region', { name: 'My mixes', exact: true })
  await library.getByRole('button', { name: `Open ${name}`, exact: true }).click()
  await page.getByRole('heading', { name, exact: true, level: 2 }).waitFor()
}
const saveDialog = page => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Save mix', exact: true }) })

try {
  begin('Create two isolated real accounts')
  const a = await identity(), b = await identity()
  const secondAuth = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: authOptions, global: { fetch: network } })
  const secondSession = unwrap(await secondAuth.auth.signInWithPassword({ email: a.email, password: a.password })).session
  assert.equal((await a.client.list()).mixes.length, 0); assert.equal((await b.client.list()).mixes.length, 0)
  pass(phase)

  begin('Real save, idempotent commit, and byte-for-byte reopen')
  const original = createMixArchive(audioRecord('Wednesday original')), originalHash = await digest(original)
  const initialAttempt = attempt(a.id, 'Wednesday original')
  let primary = await a.client.save(original, initialAttempt)
  assert.equal((await a.client.save(original, initialAttempt)).revision, primary.revision)
  assert.equal(await digest((await a.client.open(primary.id)).archive), originalHash)
  pass(phase)

  if (retention) {
    begin('Saved playback stays independent after its disposable temporary source is removed')
    temporaryClient = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } })
    temporarySourceKey = `mix-room/uploads/${randomUUID()}/source.wav`
    const source = audioRecord('Disposable temporary source').audioBlob
    const temporaryStorage = createR2Storage(env)
    const uploaded = await network(await temporaryStorage.uploadUrl(temporarySourceKey, source.size), { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: source })
    assert.ok(uploaded.ok, 'Disposable source upload must succeed')
    assert.equal((await temporaryStorage.inspect(temporarySourceKey)).size, source.size)
    await removeTemporarySource()
    await assert.rejects(temporaryStorage.inspect(temporarySourceKey))
    assert.equal(await digest((await a.client.open(primary.id)).archive), originalHash)
    pass(phase)
  }

  begin('Real rename preserves audio; update replaces the saved bytes')
  primary = (await a.client.rename(primary, 'Wednesday renamed')).mix
  assert.equal(await digest((await a.client.open(primary.id)).archive), originalHash)
  const updated = createMixArchive(audioRecord('Wednesday updated', 660)), updatedHash = await digest(updated)
  primary = await a.client.save(updated, attempt(a.id, 'Wednesday updated', primary))
  assert.equal(primary.revision, 3); assert.equal(await digest((await a.client.open(primary.id)).archive), updatedHash)
  pass(phase)

  begin('Real three-mix capacity and replacement at capacity')
  const slot2 = await a.client.save(original, attempt(a.id, 'Wednesday slot two'))
  const slot3 = await a.client.save(original, attempt(a.id, 'Wednesday slot three'))
  await assert.rejects(a.client.save(original, attempt(a.id, 'Forbidden fourth')), { code: 'MIX_LIMIT', status: 409 })
  const replaced = await a.client.save(updated, attempt(a.id, 'Wednesday replacement', slot2))
  assert.equal(replaced.id, slot2.id); assert.equal(replaced.revision, 2); assert.equal((await a.client.list()).mixes.length, 3)
  assert.equal(await digest((await a.client.open(replaced.id)).archive), updatedHash)
  pass(phase)

  begin('Real invalid upload and stale update preserve the previous saved copy')
  const damaged = new Uint8Array(await updated.arrayBuffer()); damaged[0] = 0
  const failedAttempt = attempt(a.id, 'Rejected broken copy', primary)
  await assert.rejects(a.client.save(new Blob([damaged], { type: MIX_ARCHIVE_TYPE }), failedAttempt), { code: 'UPLOAD_SIZE', status: 400 })
  await assert.rejects(a.client.save(original, attempt(a.id, 'Stale update', { ...primary, revision: 2 })), { code: 'MIX_CHANGED', status: 409 })
  assert.equal(await digest((await a.client.open(primary.id)).archive), updatedHash)
  assert.equal((await repository.get(a.id, primary.id)).revision, 3)
  pass(phase)

  begin('A second real account cannot list, open, rename, delete, update, or commit the first account’s mix')
  assert.equal((await b.client.list()).mixes.length, 0)
  for (const [route, method, body] of [[`/${primary.id}`, 'GET'], [`/${primary.id}`, 'PATCH', { revision: 3, name: 'Denied' }], [`/${primary.id}`, 'DELETE', { revision: 3 }], ['/commit', 'POST', { uploadId: failedAttempt.uploadId }]]) assert.equal((await api(b.session, route, method, body)).status, 404)
  await assert.rejects(b.client.save(original, attempt(b.id, 'Denied update', primary)), { code: 'MIX_CHANGED', status: 409 })
  assert.equal((await api(null)).status, 401)
  assert.equal(await digest((await a.client.open(primary.id)).archive), updatedHash)
  pass(phase)

  begin('Database RLS, protected RPCs, and unsigned private storage deny direct access')
  const query = unwrap(await b.auth.from('saved_mixes').select('id').eq('owner_id', a.id)); assert.equal(query.length, 0)
  assert.ok((await b.auth.from('mix_uploads').select('id')).error)
  assert.ok((await b.auth.rpc('reserve_mix_upload', { p_owner: a.id, p_upload: randomUUID(), p_mix: randomUUID(), p_name: 'Denied direct RPC', p_bytes: original.size, p_expected: null })).error)
  const signed = await (await api(a.session, `/${primary.id}`)).json(), unsigned = new URL(signed.downloadUrl); unsigned.search = ''
  assert.ok((await network(unsigned)).status >= 400)
  pass(phase)

  begin('Real delete removes the entry and saved object')
  const deletedKey = (await repository.get(a.id, slot3.id)).object_key
  await a.client.delete(slot3)
  assert.equal((await a.client.list()).mixes.length, 2); assert.equal((await api(a.session, `/${slot3.id}`)).status, 404)
  await assert.rejects(storage.inspect(deletedKey))
  pass(phase)

  begin('Browser setup with real authentication and R2')
  if (!hosted) {
    try { assert.ok((await network(origin)).ok) }
    catch {
      preview = await createServer({ configFile: path.join(root, 'vite.config.js'), logLevel: 'error', cacheDir: path.join(artifacts, 'vite'), server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false } }); await preview.listen()
    }
  }
  browser = await chromium.launch({ channel: process.env.MIX_ROOM_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--mute-audio'] })
  const first = await browserPage(a.session), second = await browserPage(secondSession), page = first.page
  await openMix(page, primary.name)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('audio').currentTime > .2)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  assert.equal(await page.getByText('Saved in your account', { exact: true }).count(), 0)
  pass('Real browser reopen and private audio playback')

  begin('Real browser interrupted save keeps current edits and the previous committed mix')
  await page.getByRole('button', { name: 'EDITOR', exact: true }).click()
  begin('Interrupted save: edit title')
  await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title', { exact: true }).fill('Draft survives interrupted save')
  await page.getByRole('button', { name: 'Apply names', exact: true }).click()
  await page.getByRole('heading', { name: 'Draft survives interrupted save', exact: true }).waitFor()
  begin('Interrupted save: open Save mix form')
  await page.getByRole('button', { name: 'Save mix', exact: true }).click()
  const dialog = saveDialog(page)
  await dialog.getByText(/2 of 3 saved/).waitFor()
  let blocked = 0
  const interrupt = route => { if (route.request().method() === 'PUT' && blocked++ === 0) return route.abort(); return route.continue() }
  await first.context.route('https://*.r2.cloudflarestorage.com/**', interrupt)
  begin('Interrupted save: block R2 PUT and wait for feedback')
  await dialog.getByRole('button', { name: 'Save mix', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  begin('Interrupted save: verify draft, playback and previous bytes')
  assert.equal(blocked, 1)
  assert.equal(await page.locator('.mix-room__track-title h2').textContent(), 'Draft survives interrupted save')
  assert.ok((await page.locator('audio').getAttribute('src')).startsWith('blob:'))
  assert.equal(await digest((await a.client.open(primary.id)).archive), updatedHash)
  await first.context.unroute('https://*.r2.cloudflarestorage.com/**', interrupt)
  await page.getByRole('button', { name: 'Close mix library', exact: true }).click()
  pass('Real browser interrupted save keeps current edits and the previous committed mix')

  begin('Real browser reload discards an unsaved draft and reopens the previous saved version')
  await page.reload()
  await page.getByRole('button', { name: 'Account', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Welcome to Mix Room', exact: true }).waitFor()
  assert.equal(await page.locator('audio').getAttribute('src'), null)
  await openMix(page, primary.name)
  pass(phase)

  begin('Real browser save retries successfully through R2 CORS')
  await page.getByRole('button', { name: 'EDITOR', exact: true }).click()
  await page.locator('.mix-room__content-overlay--editor').getByLabel('Song title', { exact: true }).fill('Wednesday browser saved')
  await page.getByRole('button', { name: 'Apply names', exact: true }).click()
  await page.getByRole('heading', { name: 'Wednesday browser saved', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Save mix', exact: true }).click()
  await dialog.getByText(/2 of 3 saved/).waitFor(); await dialog.getByRole('button', { name: 'Save mix', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  primary = (await a.client.list()).mixes.find(row => row.id === primary.id)
  assert.equal(primary.name, 'Wednesday browser saved'); assert.equal(primary.revision, 4)
  assert.equal((await readMixArchive((await a.client.open(primary.id)).archive)).record.metadata.title, primary.name)
  pass(phase)

  begin('An independent real login can reopen the mix after the first browser signs out')
  await openMix(second.page, primary.name)
  begin('Independent login: sign out the first browser')
  await page.locator('.account-access').click(); await page.getByRole('region', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('heading', { name: 'Welcome to Mix Room', exact: true }).waitFor()
  assert.equal(await page.locator('audio').getAttribute('src'), null)
  assert.equal(await page.getByRole('heading', { name: primary.name, exact: true }).count(), 0)
  begin('Independent login: reload the signed-out browser')
  await page.reload(); await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  begin('Independent login: reload the independent signed-in browser')
  await second.page.reload(); await second.page.getByRole('button', { name: 'Account', exact: true }).waitFor()
  begin('Independent login: reopen from the independent browser')
  await openMix(second.page, primary.name)
  pass('An independent real login can reopen the mix after the first browser signs out')

  if (!hosted) {
    begin('An older local mix survives explicit opening, reload, and sign-out')
    const legacy = createMixArchive(audioRecord('Wednesday older browser copy'))
    await second.page.evaluate(async base64 => {
      const { readMixArchive } = await import('/src/audio/mixArchive.js'), { saveBrowserMix } = await import('/src/audio/browserMixStorage.js')
      const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0))
      await saveBrowserMix((await readMixArchive(new Blob([bytes]))).record)
    }, Buffer.from(await legacy.arrayBuffer()).toString('base64'))
    await second.page.reload(); await second.page.getByRole('button', { name: 'Account', exact: true }).waitFor()
    await second.page.getByRole('button', { name: 'Open for this visit', exact: true }).click()
    await second.page.getByRole('heading', { name: 'Wednesday older browser copy', exact: true }).waitFor()
    await second.page.reload(); await second.page.getByRole('button', { name: 'Account', exact: true }).waitFor()
    assert.equal(await second.page.locator('audio').getAttribute('src'), null)
    await second.page.getByRole('button', { name: 'Open for this visit', exact: true }).waitFor()
    await second.page.locator('.account-access').click(); await second.page.getByRole('region', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
    await second.page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    const legacyTitle = await second.page.evaluate(async () => (await (await import('/src/audio/browserMixStorage.js')).loadBrowserMix())?.metadata.title)
    assert.equal(legacyTitle, 'Wednesday older browser copy')
    pass(phase)
  }
  assert.deepEqual(browserErrors, [])
} catch (error) {
  const safeDetail = error.name === 'TimeoutError' ? error.message.split('\n')[0] : error.code === 'ERR_ASSERTION' ? 'A verification assertion failed' : error.name
  failure = true; results.push({ check: phase, passed: false }); console.error(`FAIL ${phase}. Provider responses, credentials and signed URLs are deliberately omitted.`)
  console.error(safeDetail)
  if (hosted) console.error(JSON.stringify(lastHostedResponse))
  for (const [index, context] of (browser?.contexts() || []).entries()) {
    await context.pages()[0]?.screenshot({ path: path.join(artifacts, index ? `failure-browser-${index+1}.png` : 'failure.png') }).catch(() => {})
  }
} finally {
  await browser?.close().catch(() => {}); await preview?.close().catch(() => {})
  await removeTemporarySource().catch(() => { cleanupFailed = true })
  for (const { owner, id } of uploads) {
    assert.ok(users.includes(owner))
    for (const prefix of ['incoming', 'saved']) await storage.remove(`${prefix}/${owner}/${id}.mixroom`).catch(() => { cleanupFailed = true })
  }
  for (const id of users) {
    try {
      // Accounts are exclusively the UUIDs returned by this run's createUser.
      scope.owner(id)
      const deleted = await admin.auth.admin.deleteUser(id); if (deleted.error) cleanupFailed = true
    } catch { cleanupFailed = true }
  }
  console.log(cleanupFailed ? 'FAIL disposable test cleanup; rerun cleanup before closing this check' : `PASS cleanup: ${users.length} disposable accounts and all tracked test objects removed`)
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ time: new Date().toISOString(), realServices: true, hosted, origin, frontendSource: currentBuild ? 'current local production build served at the real hosted origin; API/Auth/R2 are unmodified' : hosted ? 'actual deployed website' : 'local Vite app', physicalSecondDevice: false, temporarySourceRemovalCheck: retention, paidSeparationJobs: 0, results, cleanup: !cleanupFailed }, null, 2) + '\n')
}
if (failure || cleanupFailed) process.exitCode = 1
