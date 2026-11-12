import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { validateSeparationWav, UPLOAD_SAMPLE_RATE } from '../../shared/separationAudio.js'
import { STAGES, readStemFiles, readCompletedSeparation, isMVSEPUrl } from './mvsep.js'
import { reportOperation } from '../operationEvents.js'
import { isUUID } from '../../shared/savedMix.js'

const TTL = 24 * 60 * 60 * 1000
const digest = value => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const error = (message, status = 400, code) => Object.assign(new Error(message), { publicMessage: message, status, code })
const terminal = job => ['complete', 'failed', 'cancelled'].includes(job.status)
// Saved Quick stages without a model used four-stem Demucs4 HT. New stages
// record their model so a six-stem result must include guitar and piano.
const readStageFiles = (files, { stage, model }) => readStemFiles(files, stage, { legacyQuick: stage === 'quick' && (model ?? '20') === '20' })

export function separationConfig(env) {
  const required = ['MVSEP_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
  const maxSeconds = Number(env.SEPARATION_MAX_SECONDS ?? 360)
  const monthlyJobs = Number(env.SEPARATION_MONTHLY_JOBS ?? 10)
  const valid = Number.isInteger(maxSeconds) && maxSeconds > 0 && maxSeconds <= 900 && Number.isInteger(monthlyJobs) && monthlyJobs > 0 && monthlyJobs <= 100
  const testConfigured = env.SEPARATION_TEST_ACCOUNT_ID !== undefined || env.SEPARATION_TEST_JOB_ID !== undefined
  return {
    available: env.SEPARATION_ENABLED !== 'false' && valid && required.every(name => Boolean(env[name]?.trim())),
    maxSeconds: valid ? maxSeconds : 360,
    monthlyJobs: valid ? monthlyJobs : 10,
    // Thorough chains MVSEP jobs by passing a stem's mvsep.com URL back as the
    // next input. Since November 12, 2026 MVSEP rejects that download as a
    // "Blocked internal address", so new jobs run as six-stem Quick unless this
    // is explicitly re-enabled after chained inputs are re-hosted.
    thoroughPaused: env.SEPARATION_THOROUGH_ENABLED !== 'true',
    ...(testConfigured ? { testScope: { accountId: env.SEPARATION_TEST_ACCOUNT_ID, jobId: env.SEPARATION_TEST_JOB_ID } } : {}),
  }
}

export function createSeparationService({ store, storage, provider, config, apiKey, now = Date.now, allowedOrigins = [], webhookBase, verifyUser, report = () => {} }) {
  const get = key => store.getWithMetadata(key, { type: 'json', consistency: 'strong' })
  const set = (key, data, options) => store.setJSON(key, data, options)
  const jobKey = id => `job/${id}`
  const hookToken = id => createHmac('sha256', apiKey).update(`mvsep-webhook:${id}`).digest('hex')

  function checkTestScope(ownerKey, id, mode) {
    if (config.testScope === undefined) return
    const scope = config.testScope
    if (!isUUID(scope?.accountId) || !isUUID(scope?.jobId)) throw error('The preview test is not configured completely.', 503, 'TEST_SCOPE_INVALID')
    if (ownerKey !== `account/${digest(scope.accountId.toLowerCase())}` || id !== scope.jobId.toLowerCase() || mode !== 'quick') {
      throw error('This preview test is limited to its approved account and Quick job.', 403, 'TEST_SCOPE_DENIED')
    }
  }

  async function reserveQuota(id) {
    const month = new Date(now()).toISOString().slice(0, 7)
    for (let slot = 0; slot < config.monthlyJobs; slot++) {
      const key = `quota/${month}/${slot}`, previous = await get(key)
      if (previous && !previous.data.available && (previous.data.charged || previous.data.expires > now())) continue
      const result = await set(key, { jobId: id, charged: false, expires: now() + 30 * 60 * 1000 }, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true })
      if (result.modified) return key
    }
    throw error('This month’s separation allowance has been reached. You can still upload your own stems.', 429, 'MONTHLY_LIMIT_REACHED')
  }

  async function actor(request) {
    const accountToken = request.headers.get('X-Mix-Room-Account')
    if (accountToken) {
      if (!verifyUser) throw error('Accounts are unavailable for processing. Try again later.', 503)
      const user = await verifyUser(accountToken)
      if (!user) throw error('Your session ended. Sign in again.', 401, 'SIGN_IN_REQUIRED')
      return { key: `account/${digest(user.id)}`, limit: 3, scope: 'account' }
    }
    const device = request.headers.get('X-Mix-Room-Device')
    if (!/^[a-f0-9]{64}$/.test(device ?? '')) throw error('Guest processing could not be identified.', 403)
    return { key: `guest/${digest(device)}`, legacy: digest(device), limit: 1, scope: 'guest' }
  }
  const occupied = entry => entry && !entry.data.available && (entry.data.charged || entry.data.expires > now())
  async function usedCredits(identity) {
    const entries = await Promise.all(Array.from({ length: identity.limit }, (_, slot) => get(`credits/${identity.key}/${slot}`)))
    if (identity.legacy) {
      const legacy = await Promise.all([0, 1, 2].map(slot => get(`credits/${identity.legacy}/${slot}`)))
      if (legacy.some(occupied)) return identity.limit
    }
    return entries.filter(occupied).length
  }
  async function reserveDeviceCredit(id, identity) {
    if (await usedCredits(identity) >= identity.limit) throw error(identity.scope === 'account' ? 'Your three one-time audio credits have been used. Stem analysis is unlimited.' : 'Your guest audio trial has been used. Create an account for three audio credits.', 429, 'SONG_CREDITS_EXHAUSTED')
    for (let slot = 0; slot < identity.limit; slot++) {
      const key = `credits/${identity.key}/${slot}`, previous = await get(key)
      if (occupied(previous)) continue
      const result = await set(key, { jobId: id, charged: false, expires: now() + 30 * 60 * 1000 }, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true })
      if (result.modified) return key
    }
    throw error('Your processing allowance is in use. Finish the existing job before trying again.', 429, 'SONG_CREDITS_EXHAUSTED')
  }
  async function stemTrial(request, action) {
    const identity = await actor(request)
    if (request.method !== 'POST') throw error('Method not allowed.', 405)
    if (![new URL(request.url).origin, ...allowedOrigins].includes(request.headers.get('Origin'))) throw error('This request must come from Mix Room.', 403)
    const text = await request.text()
    if (text.length > 256) throw error('This request is too large.')
    let body
    try { body = JSON.parse(text) } catch { throw error('Invalid stem request.') }
    if (!/^[a-f0-9-]{36}$/.test(body.id ?? '')) throw error('Invalid stem request.')
    if (identity.scope === 'account') return { unlimited: true }
    const key = `stem-trial/${identity.key}`, previous = await get(key)
    if (action === 'reserve') {
      if (occupied(previous) && previous.data.jobId !== body.id) throw error('Your guest stem trial has been used or is currently running. Sign in for unlimited stem analysis.', 429, 'STEM_TRIAL_EXHAUSTED')
      if (previous?.data.jobId === body.id && previous.data.charged) return { reserved: true, completed: true }
      if (previous?.data.jobId === body.id && !previous.data.available && previous.data.expires > now()) return { reserved: true }
      const result = await set(key, { jobId: body.id, charged: false, expires: now() + 30 * 60 * 1000 }, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true })
      if (!result.modified) throw error('Your guest stem trial is in use in another tab. Try again later.', 409, 'STEM_TRIAL_EXHAUSTED')
      return { reserved: true }
    }
    if (!previous || previous.data.jobId !== body.id) throw error('This analysis reservation is no longer available.', 409)
    if (action === 'release') {
      if (!previous.data.charged) await set(key, { ...previous.data, available: true }, { onlyIfMatch: previous.etag })
      return { released: !previous.data.charged }
    }
    if (!previous.data.charged) {
      if (previous.data.available || previous.data.expires <= now()) throw error('This stem trial expired. Start a new analysis.', 409)
      const result = await set(key, { ...previous.data, charged: true }, { onlyIfMatch: previous.etag })
      if (!result.modified) throw error('Your stem trial changed in another tab.', 409)
    }
    return { completed: true }
  }

  async function quota(job, charged) {
    const keys = [job.quotaKey, job.deviceCreditKey].filter(Boolean)
    const entries = await Promise.all(keys.map(get))
    // Check every reservation before charging either one. A slow/abandoned
    // upload must not revive a credit that has already returned to the user.
    if (charged && entries.some(entry => !entry || entry.data.jobId !== job.id || (!entry.data.charged && (entry.data.available || entry.data.expires <= now())))) {
      throw error('This upload reservation expired. Please select the file again.', 410)
    }
    for (const [index, key] of keys.entries()) {
      const entry = entries[index]
      if (entry?.data.jobId !== job.id) {
        if (charged) throw error('This upload reservation expired. Please select the file again.', 410)
        continue
      }
      if (entry.data.charged) continue
      const result = await set(key, { ...entry.data, charged, available: !charged }, { onlyIfMatch: entry.etag })
      if (!result.modified && charged) throw error('The upload reservation changed. Please try again.', 409)
    }
  }

  async function readJob(id, token, identity) {
    const entry = await get(jobKey(id))
    if (!entry || !equal(entry.data.tokenDigest, digest(token))) throw error('Separation job not found.', 404)
    if (identity && (entry.data.ownerKey ? entry.data.ownerKey !== identity.key : !identity.legacy || !entry.data.deviceCreditKey?.startsWith(`credits/${identity.legacy}/`))) throw error('Separation job not found.', 404)
    if (entry.data.expires < now()) throw error('This separation expired. Please upload the song again.', 410)
    return entry.data
  }

  async function publicJob(job) {
    const state = { id: job.id, status: job.status, phase: job.phase, percent: job.percent, message: job.message, name: job.name, mode: job.mode,
      providerJobs: job.stages.map(({ stage, hash, providerStatus }) => ({ stage, hash: hash.startsWith('remote:') ? null : hash, status: providerStatus })),
    }
    if (job.status === 'complete') Object.assign(state, { stems: job.outputs, sourceUrl: await storage.sourceUrl(job.sourceKey), originalUrl: job.stages[0]?.originalUrl })
    return state
  }

  async function cancelled(job) { return Boolean(await get(`cancel/${job.id}`)) }
  async function markCancelled(job) {
    const latest = job.stages.at(-1)
    if (latest?.hash) await provider.cancel(latest.hash).catch(() => {})
    else if (job.phase !== 'submitting') await quota(job, false)
    Object.assign(job, { status: 'cancelled', phase: 'cancelled', message: 'Processing cancelled. Work already started may still use credits.' })
  }

  // Conditional leases prevent overlapping polls and webhooks from submitting
  // the same paid stage twice, including across independent function instances.
  async function mutate(id, operation) {
    const entry = await get(jobKey(id)), job = entry.data
    if (terminal(job) || job.phase === 'initializing' || (job.lock?.until > now())) return publicJob(job)
    const lock = { owner: randomUUID(), until: now() + 55000 }
    const locked = await set(jobKey(id), { ...job, lock }, { onlyIfMatch: entry.etag })
    if (!locked.modified) return publicJob((await get(jobKey(id))).data)
    job.lock = lock
    const commit = async () => {
      const current = await get(jobKey(id))
      if (current.data.lock?.owner !== lock.owner) throw error('This job is being updated. Please wait.', 409)
      const saved = await set(jobKey(id), job, { onlyIfMatch: current.etag })
      if (!saved.modified) throw error('This job is being updated. Please wait.', 409)
    }
    try {
      if (await cancelled(job)) await markCancelled(job)
      else if (job.phase === 'submitting') {
        Object.assign(job, { status: 'failed', message: 'A previous MVSEP submission could not be confirmed. Check your MVSEP history before starting another separation.' })
      } else await operation(job, commit)
    } catch (failure) {
      reportOperation(report, { service: 'separation', operation: 'separation_transition', status: failure.status ?? 503, mode: job.mode, outcome: job.phase === 'submitting' ? 'unconfirmed' : 'failed' })
      if (job.phase === 'submitting') {
        Object.assign(job, { status: 'failed', message: failure.message.startsWith('MVSEP') ? failure.message : 'The MVSEP submission could not be confirmed. Check your separation history before retrying.' })
      } else if (failure.publicMessage) {
        Object.assign(job, { status: 'failed', message: failure.publicMessage })
        if (!job.stages.length) await quota(job, false)
      } else throw error('The separation service is temporarily unavailable. Your job is saved; try again shortly.', 503)
    } finally {
      delete job.lock
      await commit()
    }
    return publicJob(job)
  }

  async function submit(job, stage, sourceUrl, commit) {
    checkTestScope(job.ownerKey, job.id, job.mode)
    // Only newly reserved guest trials may submit. Old guest jobs stay read-only,
    // including webhook-driven stages; their historical credits are not upgraded.
    const guestTrial = job.guestAudioAllowance === 1 && /^guest\/[a-f0-9]{64}$/.test(job.ownerKey ?? '') && job.deviceCreditKey === `credits/${job.ownerKey}/0`
    if (!job.ownerKey?.startsWith('account/') && !guestTrial) throw error('Sign in to separate an audio file.', 401, 'SIGN_IN_REQUIRED')
    if (await cancelled(job)) { await markCancelled(job); return }
    await quota(job, true)
    Object.assign(job, { phase: 'submitting', status: 'processing', message: `${STAGES[stage].name} · submitting to MVSEP` })
    await commit()
    // An interrupted POST is deliberately never retried automatically: the
    // provider may have accepted it even if its response was lost.
    const webhook = webhookBase ? `${webhookBase}/api/separation/jobs/${job.id}/webhook?hook=${hookToken(job.id)}` : undefined
    reportOperation(report, { service: 'separation', operation: 'paid_submission', status: 202, mode: job.mode, stage, outcome: 'attempted' })
    const hash = await provider.create(stage, sourceUrl, webhook)
    reportOperation(report, { service: 'separation', operation: 'paid_submission', status: 200, mode: job.mode, stage, outcome: 'accepted' })
    job.stages.push({ stage, model: STAGES[stage].sep_type, hash, submittedAt: now() })
    Object.assign(job, { phase: 'remote', message: `${STAGES[stage].name} · queued` })
    if (await cancelled(job)) await markCancelled(job)
  }

  async function advance(job, commit) {
    if (job.phase !== 'remote') return
    const current = job.stages.at(-1), result = await provider.get(current.hash)
    current.providerStatus = result.status
    if (result.data?.resolvedHash) current.hash = result.data.resolvedHash
    if (result.status === 'not_found') {
      current.missingSince ??= now()
      if (now() - current.missingSince < 120000) {
        job.message = `${STAGES[current.stage].name} · waiting for MVSEP to confirm the job`
        return
      }
      throw error('MVSEP has not returned this job yet. Its submission will not be repeated. Check its status in your MVSEP history or retry loading the existing result.', 502)
    }
    delete current.missingSince
    if (result.status === 'failed') throw error('MVSEP reported a failed separation. Check the job in your MVSEP account; the submission will not be repeated.', 502)
    if (result.status !== 'done') {
      const part = job.mode === 'quick' ? 0 : job.stages.length - 1
      job.percent = Math.max(job.percent, 10 + part * 20 + (result.status === 'waiting' ? 0 : 10))
      const queue = Number(result.data?.current_order)
      job.message = `${STAGES[current.stage].name} · ${result.status === 'waiting' ? `queued${queue > 0 ? ` (${queue})` : ''}` : 'processing'}`
      return
    }
    try { current.files = readStageFiles(result.data?.files, current) } catch (failure) { throw error(failure.message, 502) }
    if (isMVSEPUrl(result.data?.input_file?.url)) current.originalUrl = result.data.input_file.url
    await commit()
    if (job.mode === 'thorough' && current.stage === 'instruments') {
      job.percent = Math.max(job.percent, 30)
      return submit(job, 'drums', current.files.find(file => file.key === 'drums').url, commit)
    }
    if (job.mode === 'thorough' && current.stage === 'drums') {
      job.percent = Math.max(job.percent, 50)
      return submit(job, 'vocals', job.stages[0].files.find(file => file.key === 'vocals').url, commit)
    }
    job.outputs = job.mode === 'quick' ? current.files : [...job.stages[0].files.filter(file => !['drums', 'vocals'].includes(file.key)), ...job.stages[1].files, ...current.files]
    Object.assign(job, { status: 'complete', phase: 'complete', percent: 70, message: 'Stems ready · preparing browser analysis' })
  }

  return async request => {
    const url = new URL(request.url), route = url.pathname.match(/^\/api\/separation\/jobs(?:\/([a-f0-9-]{36})(?:\/(start|advance|cancel|webhook|recover))?)?$/)
    const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
    try {
      if (url.pathname === '/api/separation/config' && request.method === 'GET') return reply({ available: config.available, maxSeconds: config.maxSeconds, monthlyJobs: config.monthlyJobs })
      if (url.pathname === '/api/separation/credits') {
        if (request.method !== 'GET') throw error('Method not allowed.', 405)
        const identity = await actor(request)
        if (!store) throw error('Processing allowances are unavailable. Try again later.', 503)
        const used = await usedCredits(identity)
        const stem = identity.scope === 'guest' ? await get(`stem-trial/${identity.key}`) : null
        return reply({ scope: identity.scope, limit: identity.limit, remaining: identity.limit - used, stemsRemaining: identity.scope === 'account' ? null : occupied(stem) ? 0 : 1 })
      }
      const stemRoute = url.pathname.match(/^\/api\/separation\/stems\/(reserve|complete|release)$/)
      if (stemRoute) {
        if (!store) throw error('Stem analysis allowances are unavailable. Try again later.', 503)
        return reply(await stemTrial(request, stemRoute[1]))
      }
      if (url.pathname === '/api/separation/results') {
        if (request.method !== 'GET') throw error('Method not allowed.', 405)
        if (!config.available) throw error('MVSEP results are not configured yet.', 503)
        const hash = url.searchParams.get('hash') ?? ''
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,499}$/.test(hash)) throw error('Enter a valid MVSEP result link or job hash.')
        // Recovery only reads an existing result. It cannot submit, cancel,
        // reserve quota, or advance another paid stage.
        let result = await provider.get(hash)
        if (result.data?.resolvedHash) result = await provider.get(result.data.resolvedHash)
        try { return reply(readCompletedSeparation(result)) } catch (failure) { throw error(failure.message) }
      }
      if (!route) throw error('Endpoint not found.', 404)
      if (!config.available) throw error('Audio file separation is not configured yet. You can still upload stems.', 503)
      const [, id, action] = route
      if (action === 'webhook') {
        if (request.method !== 'POST' || !equal(url.searchParams.get('hook'), hookToken(id))) throw error('Not authorized.', 403)
        const entry = await get(jobKey(id))
        if (!entry || entry.data.expires < now()) throw error('Separation job not found.', 404)
        await mutate(id, advance)
        return reply({ received: true })
      }
      if (request.method === 'POST' && ![url.origin, ...allowedOrigins].includes(request.headers.get('Origin'))) throw error('This request must come from Mix Room.', 403)
      const identity = await actor(request)
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
      if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw error('Not authorized.', 403)
      if (!id) {
        if (request.method !== 'POST') throw error('Method not allowed.', 405)
        const text = await request.text()
        if (text.length > 4096) throw error('Upload request is too large.')
        let body
        try { body = JSON.parse(text) } catch { throw error('Invalid upload request.') }
        // An older open page may still ask for Thorough. Run it as Quick before
        // any allowance is reserved so the visitor still gets a usable result.
        if (config.thoroughPaused && body?.mode === 'thorough') body.mode = 'quick'
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.id ?? '') || !['quick', 'thorough'].includes(body.mode) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180 || !Number.isInteger(body.size) || body.size <= 44 || body.size > 44 + config.maxSeconds * UPLOAD_SAMPLE_RATE * 8) throw error('Choose a valid audio file within the song-duration limit.')
        checkTestScope(identity.key, body.id, body.mode)
        const job = { id: body.id, name: body.name.trim(), mode: body.mode, size: body.size, tokenDigest: digest(token), ownerKey: identity.key, ...(identity.scope === 'guest' ? { guestAudioAllowance: 1 } : {}), created: now(), expires: now() + TTL, sourceKey: `mix-room/uploads/${body.id}/source.wav`, status: 'uploading', phase: 'initializing', percent: 3, message: 'Uploading song', stages: [] }
        const added = await set(jobKey(job.id), job, { onlyIfNew: true })
        if (added.modified) {
          try { job.quotaKey = await reserveQuota(job.id); job.deviceCreditKey = await reserveDeviceCredit(job.id, identity); job.phase = 'uploading' } catch (failure) { await quota(job, false); job.status = 'failed'; job.message = failure.publicMessage; await set(jobKey(job.id), job, { onlyIfMatch: added.etag }); throw failure }
          const ready = await set(jobKey(job.id), job, { onlyIfMatch: added.etag })
          if (!ready.modified) throw error('This upload changed. Please resume its saved job.', 409)
          if (await cancelled(job)) {
            await quota(job, false)
            Object.assign(job, { status: 'cancelled', phase: 'cancelled', message: 'Processing cancelled' })
            await set(jobKey(job.id), job, { onlyIfMatch: ready.etag })
          }
        } else {
          const existing = await readJob(job.id, token, identity)
          if (existing.phase !== 'uploading' || existing.size !== body.size || existing.mode !== body.mode || existing.name !== body.name.trim()) throw error('This upload has already started or changed. Resume its saved job.', 409)
        }
        return reply({ id: job.id, uploadUrl: await storage.uploadUrl(job.sourceKey, job.size) })
      }
      const job = await readJob(id, token, identity)
      if (action === 'start' && request.method === 'POST') checkTestScope(job.ownerKey, job.id, job.mode)
      if (request.method === 'POST' && ['start', 'advance'].includes(action) && identity.scope === 'guest' && job.guestAudioAllowance !== 1) throw error('Sign in to separate an audio file.', 401, 'SIGN_IN_REQUIRED')
      if (!action && request.method === 'GET') return reply(await publicJob(job))
      if (action === 'recover') {
        if (request.method !== 'GET') throw error('Method not allowed.', 405)
        if (!job.stages.length) throw error('There is no confirmed MVSEP job to load. Check your MVSEP history and use its completed result link.')
        // Read-only recovery works even if an earlier poll marked the job
        // failed. It never calls submit or advances an unpaid Thorough stage.
        const stages = await Promise.all(job.stages.map(async stage => {
          let result = await provider.get(stage.hash)
          if (result.data?.resolvedHash) result = await provider.get(result.data.resolvedHash)
          if (result.status !== 'done') throw error('The existing MVSEP job is not ready to load. Wait for it to complete, then retry loading. No new separation was submitted.', 409)
          let files
          try { files = readStageFiles(result.data?.files, stage) } catch (failure) { throw error(failure.message) }
          return { ...stage, files, originalUrl: isMVSEPUrl(result.data?.input_file?.url) ? result.data.input_file.url : stage.originalUrl }
        }))
        if (job.mode === 'thorough' && stages.length !== 3) throw error('Thorough processing stopped before every stage was submitted. You can load its completed six-stem result using the MVSEP link below; retrying here will not spend more credits.')
        const stems = job.mode === 'quick' ? stages[0].files : [...stages[0].files.filter(file => !['drums', 'vocals'].includes(file.key)), ...stages[1].files, ...stages[2].files]
        return reply({ status: 'complete', stems, sourceUrl: await storage.sourceUrl(job.sourceKey), originalUrl: stages[0].originalUrl })
      }
      if (request.method !== 'POST') throw error('Method not allowed.', 405)
      if (action === 'cancel') {
        if (terminal(job)) return reply(await publicJob(job))
        await set(`cancel/${id}`, { at: now() }, { onlyIfNew: true })
        // The flag is durable before acknowledging cancellation. A concurrent
        // submit checks it on both sides of the paid request and stops chaining.
        if (!job.lock || job.lock.until < now()) await mutate(id, async () => {})
        return reply({ status: 'cancelled', message: 'Processing cancelled. Work already started may still use credits.' })
      }
      if (action === 'start') return reply(await mutate(id, async (current, commit) => {
        if (current.phase !== 'uploading') return
        if (config.thoroughPaused && current.mode === 'thorough') current.mode = 'quick'
        let audio
        try { audio = await storage.inspect(current.sourceKey) } catch { throw error('The audio upload could not be verified. Please upload it again.') }
        if (audio.size !== current.size) throw error('The audio upload is incomplete. Please upload it again.')
        try { current.seconds = validateSeparationWav(audio.header, audio.size, config.maxSeconds) } catch (failure) { throw error(failure.message) }
        await submit(current, current.mode === 'quick' ? 'quick' : 'instruments', await storage.sourceUrl(current.sourceKey), commit)
      }))
      if (action === 'advance') return reply(await mutate(id, advance))
      throw error('Endpoint not found.', 404)
    } catch (failure) {
      if ((failure.status ?? 503) >= 500 || ['MONTHLY_LIMIT_REACHED','SONG_CREDITS_EXHAUSTED'].includes(failure.code)) reportOperation(report, { service: 'separation', operation: 'separation_request', status: failure.status ?? 503, code: failure.code ?? 'SERVICE_UNAVAILABLE' })
      return reply({ error: failure.publicMessage ?? 'The separation service is temporarily unavailable. Please try again shortly.', ...(failure.publicMessage && failure.code ? { code: failure.code } : {}) }, failure.status ?? 503)
    }
  }
}
