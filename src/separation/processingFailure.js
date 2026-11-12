import { COPY, formatCopy } from '../config/siteCopy.js'
const KEY = 'mix-room-processing-failure'
const safeText = value => String(value ?? '').replace(/https?:\/\/\S+/gi, '[URL omitted]').replace(/Bearer\s+\S+/gi, '[token omitted]').slice(0, 600)

export function rememberProcessingFailure(failure) {
  try { sessionStorage.setItem(KEY, JSON.stringify(failure)) } catch { /* The current-tab error still remains visible. */ }
}
export function forgetProcessingFailure() { try { sessionStorage.removeItem(KEY) } catch { /* Optional recovery storage. */ } }
export function savedProcessingFailure() {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY))
    if (!value || typeof value.message !== 'string' || typeof value.name !== 'string') return null
    if (value.job && (!/^[a-f0-9-]{36}$/.test(value.job.id) || !/^[a-f0-9]{64}$/.test(value.job.token) || !['quick', 'thorough'].includes(value.job.mode))) return null
    return value
  } catch { return null }
}

export function publicProcessingFailureMessage(failure) {
  // Preserve useful file constraints, but never forward provider responses,
  // infrastructure details, job IDs, or developer instructions to this view.
  const duration = failure.message?.match(/^(?:Choose a song|Songs must be) no longer than ([\d.]+) minutes\.$/)
  if (duration) return formatCopy(COPY.please_choose_a_song_no_longer_than_minutes, { value1: duration[1] })
  if (/^This audio file is too large\./.test(failure.message ?? '')) return COPY.this_file_is_too_large_please_choose_a_file_under_300_mb
  if (/^Could not read this song\./.test(failure.message ?? '')) return COPY.we_couldn_t_read_this_audio_file_please_try_a_wav_or_mp3_file
  if (failure.code === 'MONTHLY_LIMIT_REACHED' || /^This month[’']s separation allowance has been reached\./.test(failure.message ?? '')) return 'The site’s monthly song processing limit has been reached. You can still upload your own stems.'
  if (failure.httpStatus === 429) return COPY.too_many_requests_right_now_please_wait_a_minute_and_try_again_you_can_still_upl
  if (failure.httpStatus === 503 && !failure.code?.startsWith('DOWNLOAD_')) return COPY.song_processing_is_temporarily_unavailable_please_try_again_later
  if (failure.job || failure.reference) return COPY.we_couldn_t_finish_loading_your_song_please_try_loading_it_again
  return COPY.we_couldn_t_prepare_this_song_please_check_your_connection_or_try_another_audio_
}

// Deliberately enumerate diagnostic fields: never copy job tokens, signed
// upload/download URLs, credentials, full provider responses, or audio data.
export function processingFailureReport(failure) {
  return JSON.stringify({
    version: 'upload-recovery-v2', time: failure.time,
    song: safeText(failure.name), step: safeText(failure.step), percent: failure.percent,
    error: safeText(failure.message), code: failure.code, httpStatus: failure.httpStatus,
    jobId: failure.job?.id, mode: failure.job?.mode ?? 'existing',
    serviceStatus: failure.serviceStatus, servicePhase: failure.servicePhase,
    providerJobs: failure.providerJobs?.map(job => ({ stage: job.stage, hash: job.hash, status: job.status })),
  }, null, 2)
}
