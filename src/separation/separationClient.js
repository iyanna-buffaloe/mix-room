import { browserCreditToken } from './browserCredits.js'
import { COPY, formatCopy } from '../config/siteCopy.js'
import { processBrowserStems } from '../audio/browserStemProcessing.js'
import { UPLOAD_SAMPLE_RATE } from '../../shared/separationAudio.js'
import { downloadAudio } from '../audio/audioDownload.js'

const API = '/api/separation'
const SESSION = 'mix-room-mvsep-job'
const MAX_FILE_BYTES = 300 * 1024 * 1024
let accountTokenProvider = async () => null
export function setSeparationAccountProvider(provider) { accountTokenProvider = provider }
export function getSeparationAccountToken() { return accountTokenProvider() }
const abortError = () => new DOMException(COPY.processing_cancelled, 'AbortError')
const recovering = message => Object.assign(new Error(message), { recoverable: true })

export function savedSeparationJob() {
  try {
    const job = JSON.parse(sessionStorage.getItem(SESSION))
    return job && /^[a-f0-9-]{36}$/.test(job.id) && /^[a-f0-9]{64}$/.test(job.token) && typeof job.name === 'string' && ['quick', 'thorough'].includes(job.mode) ? job : null
  } catch { return null }
}
export function rememberSeparation(job) { try { sessionStorage.setItem(SESSION, JSON.stringify(job)) } catch { /* Optional recovery. */ } }
export function forgetSeparation() { try { sessionStorage.removeItem(SESSION) } catch { /* Optional recovery. */ } }

export async function separationRequest(path, job, { method = 'GET', body, signal, fetcher = fetch, deviceToken, accountToken } = {}) {
  const userToken = path === '/config' ? null : accountToken !== undefined ? accountToken : await accountTokenProvider()
  const device = deviceToken ?? (!userToken && /^\/(credits|jobs|stems)(?:\/|$)/.test(path) ? browserCreditToken() : null)
  let response
  try {
    response = await fetcher(`${API}${path}`, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), cache: 'no-store', headers: { ...(device ? { 'X-Mix-Room-Device': device } : {}), ...(userToken ? { 'X-Mix-Room-Account': userToken } : {}), ...(job ? { Authorization: `Bearer ${job.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  } catch {
    signal?.throwIfAborted()
    throw recovering(COPY.could_not_reach_the_separation_service_your_saved_job_can_resume_when_you_reload)
  }
  let result
  try { result = await response.json() } catch { throw recovering(COPY.the_separation_service_did_not_respond_correctly_please_reload_to_resume_your_sa) }
  if (!response.ok) {
    const failure = Object.assign(new Error(result.error || COPY.the_separation_request_failed), { status: response.status, code: result.code })
    if (response.status >= 500 || response.status === 409) failure.recoverable = true
    throw failure
  }
  return result
}

export async function prepareSeparationAudio(file, maxSeconds, { signal, onProgress }) {
  signal.throwIfAborted()
  if (file.size > MAX_FILE_BYTES) throw new Error(COPY.this_audio_file_is_too_large_please_choose_a_file_under_300_mb)
  const Decoder = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!Decoder || !window.Worker) throw new Error(COPY.audio_processing_is_unavailable_in_this_browser_please_try_a_current_browser)
  onProgress({ percent: 0, message: COPY.reading_your_song })
  let audio
  try { audio = await new Decoder(2, 1, UPLOAD_SAMPLE_RATE).decodeAudioData(await file.arrayBuffer()) } catch {
    signal.throwIfAborted()
    throw new Error(COPY.could_not_read_this_song_please_try_a_wav_mp3_or_another_format_supported_by_you)
  }
  signal.throwIfAborted()
  if (!audio.length || audio.duration > maxSeconds) throw new Error(formatCopy(COPY.choose_a_song_no_longer_than_minutes, { value1: maxSeconds / 60 }))
  if (audio.numberOfChannels > 2) throw new Error(COPY.please_choose_a_mono_or_stereo_audio_file)
  const left = new Float32Array(audio.getChannelData(0))
  const right = audio.numberOfChannels === 2 ? new Float32Array(audio.getChannelData(1)) : left
  audio = null
  const worker = new Worker(new URL('../workers/prepareSeparation.worker.js', import.meta.url), { type: 'module' })
  let cancel
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => { worker.terminate(); reject(abortError()) }
      signal.addEventListener('abort', cancel, { once: true })
      worker.onmessage = ({ data }) => {
        if (signal.aborted) return
        if (data.type === 'progress') onProgress({ percent: data.fraction * 3, message: COPY.preparing_your_song })
        else if (data.type === 'ready') resolve(new Blob([data.wav], { type: 'audio/wav' }))
        else reject(new Error(data.message || COPY.could_not_prepare_the_audio))
      }
      worker.onerror = event => { event.preventDefault(); reject(new Error(COPY.could_not_prepare_the_audio_please_try_again)) }
      worker.postMessage({ left, right }, right === left ? [left.buffer] : [left.buffer, right.buffer])
    })
  } finally { worker.terminate(); signal.removeEventListener('abort', cancel) }
}

export function uploadAudio(url, audio, signal, onProgress) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const cancel = () => request.abort()
    const finish = failure => { signal.removeEventListener('abort', cancel); if (failure) reject(failure); else resolve() }
    request.open('PUT', url)
    request.timeout = 10 * 60 * 1000
    request.setRequestHeader('Content-Type', 'audio/wav')
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress({ percent: 3 + 5 * event.loaded / event.total, message: COPY.uploading_your_song }) }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return finish()
      const advice = request.status === 403
        ? COPY.check_the_r2_access_credentials_and_their_permission_to_write_to_this_bucket
        : request.status === 404
          ? COPY.check_that_r2_bucket_name_matches_the_bucket_in_cloudflare
          : COPY.check_the_r2_storage_setup_and_try_again
      finish(new Error(formatCopy(COPY.storage_rejected_the_audio_upload_http, { value1: request.status, value2: advice })))
    }
    request.onerror = () => finish(new Error(COPY.the_browser_could_not_upload_to_r2_check_that_the_bucket_cors_policy_allows_this))
    request.ontimeout = () => finish(new Error(COPY.the_audio_upload_timed_out_after_10_minutes_check_your_connection_and_try_a_smal))
    request.onabort = () => finish(abortError())
    signal.addEventListener('abort', cancel, { once: true })
    request.send(audio)
  })
}

function delay(milliseconds, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve() }, milliseconds)
    signal.addEventListener('abort', cancelled, { once: true })
  })
}

export async function analyzeSeparationResult(state, job, { signal, onProgress, sourceAudio }) {
  if (!Array.isArray(state.stems) || !state.stems.length || state.stems.length > 32 || !state.sourceUrl) throw new Error(COPY.the_separation_service_returned_incomplete_results)
  const stems = state.stems.map(stem => ({ label: stem.label, file: { name: stem.name, size: stem.size }, loadFile: () => downloadAudio(stem.url, signal, stem.name, { expectedBytes: stem.size, onRetry: () => onProgress({ percent: 70, message: formatCopy(COPY.reconnecting_to_download, { value1: stem.label }) }) }) }))
  const result = await processBrowserStems(stems, job.name.replace(/\.[^/.]+$/, '').slice(0, 120), {
    signal, mixAudio: false, onProgress: value => onProgress({ ...value, percent: 70 + value.percent * 0.26 }),
  })
  onProgress({ percent: 97, message: COPY.preparing_original_song_playback })
  if (sourceAudio) result.audioBlob = sourceAudio
  else {
    // MVSEP keeps its own copy of the exact uploaded song. Prefer that on
    // refresh; it avoids a second dependency on bucket CORS and signed URLs.
    const urls = [...new Set([state.originalUrl, state.sourceUrl].filter(Boolean))]
    let failure
    for (const url of urls) {
      try { result.audioBlob = await downloadAudio(url, signal, 'original song.wav'); break } catch (error) { signal.throwIfAborted(); failure = error }
    }
    if (!result.audioBlob) throw failure
  }
  result.metadata.separationProvider = 'mvsep'
  result.metadata.separationMode = job.mode
  return result
}

export function mvsepResultHash(reference) {
  let hash = reference.trim()
  if (/^https?:\/\//i.test(hash)) {
    let url
    try { url = new URL(hash) } catch { throw new Error(COPY.enter_a_valid_mvsep_result_link_or_job_hash) }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'mvsep.com' || url.hostname.endsWith('.mvsep.com')) || !url.pathname.startsWith('/result/')) throw new Error(COPY.enter_an_https_mvsep_result_page_link_or_its_job_hash)
    hash = url.pathname.slice('/result/'.length).replace(/\/$/, '')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,499}$/.test(hash)) throw new Error(COPY.enter_a_valid_mvsep_result_link_or_job_hash)
  return hash
}

export async function loadExistingSeparation(reference, { signal, onProgress, name = 'MVSEP mix.wav' }) {
  const hash = mvsepResultHash(reference)
  onProgress({ percent: 8, message: COPY.reading_your_completed_mvsep_result })
  const state = await separationRequest(`/results?hash=${encodeURIComponent(hash)}`, null, { signal })
  return analyzeSeparationResult(state, { name, mode: 'existing' }, { signal, onProgress })
}

export async function recoverSeparation(job, { signal, onProgress }) {
  onProgress({ percent: 8, message: COPY.reading_your_existing_mvsep_result_no_new_separation })
  const state = await separationRequest(`/jobs/${job.id}/recover`, job, { signal })
  return analyzeSeparationResult(state, job, { signal, onProgress })
}

export async function runSeparation({ file, mode, existingJob, signal, onProgress, onJob, ownerId, onState = () => {} }) {
  let job = existingJob
  let sourceAudio
  if (!job) {
    const configuration = await separationRequest('/config', null, { signal })
    if (!configuration.available) throw new Error(COPY.audio_file_separation_is_not_configured_yet_you_can_still_upload_stems)
    const audio = await prepareSeparationAudio(file, configuration.maxSeconds, { signal, onProgress })
    sourceAudio = audio
    job = { id: crypto.randomUUID(), token: [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join(''), name: file.name, mode, ...(ownerId ? { ownerId } : {}) }
    onJob(job)
    try {
      const upload = await separationRequest('/jobs', job, { method: 'POST', body: { id: job.id, name: job.name, mode, size: audio.size }, signal })
      await uploadAudio(upload.uploadUrl, audio, signal, onProgress)
    } catch (failure) {
      failure.beforeSubmission = true
      if (!signal.aborted) await separationRequest(`/jobs/${job.id}/cancel`, job, { method: 'POST' }).catch(() => {})
      throw failure
    }
  }
  let state = await separationRequest(`/jobs/${job.id}`, job, { signal })
  if (state.status === 'uploading') {
    state = await separationRequest(`/jobs/${job.id}/start`, job, { method: 'POST', signal })
  }
  const deadline = Date.now() + 2 * 60 * 60 * 1000
  let failures = 0
  while (true) {
    signal.throwIfAborted()
    onState(state)
    if (state.status === 'failed') throw Object.assign(new Error(state.message || COPY.separation_failed), { code: 'SEPARATION_FAILED', beforeSubmission: state.phase === 'uploading' && !state.providerJobs?.length })
    if (state.status === 'cancelled') throw abortError()
    onProgress({ percent: state.percent ?? 8, message: state.message })
    if (state.status === 'complete') return analyzeSeparationResult(state, job, { signal, onProgress, sourceAudio })
    if (Date.now() > deadline) throw recovering(COPY.this_separation_is_taking_longer_than_expected_reload_later_to_resume_its_saved_)
    await delay(4000, signal)
    try {
      state = await separationRequest(`/jobs/${job.id}/${state.status === 'uploading' ? 'start' : 'advance'}`, job, { method: 'POST', signal })
      failures = 0
    } catch (failure) {
      signal.throwIfAborted()
      if (!failure.recoverable || ++failures >= 5) throw failure
      onProgress({ percent: state.percent ?? 8, message: COPY.waiting_to_reconnect_to_the_separation_service })
    }
  }
}
