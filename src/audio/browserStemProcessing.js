import { COPY, formatCopy } from '../config/siteCopy.js'
import { makeStemKeys, SAMPLE_RATE, MAX_STEM_SECONDS } from './stemAnalysis.js'

export function validateStemUpload(stems, title) {
  if (!Array.isArray(stems) || !stems.length || stems.length > 32) throw new Error(COPY.choose_between_1_and_32_stems)
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new Error(COPY.give_your_song_a_title_of_1_120_characters)
  for (const stem of stems) {
    if (!stem.file || typeof stem.label !== 'string' || !stem.label.trim() || stem.label.trim().length > 60) throw new Error(COPY.give_each_stem_an_instrument_name_of_1_60_characters)
    if (stem.file.size > 300 * 1024 * 1024) throw new Error(formatCopy(COPY.is_too_large_for_browser_processing_please_use_a_smaller_audio_file, { value1: stem.file.name }))
  }
}

export async function processBrowserStems(stems, title, { signal, mixAudio = true, onProgress = () => {} } = {}) {
  validateStemUpload(stems, title)
  signal?.throwIfAborted()
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineContext || !window.Worker) throw new Error(COPY.stem_analysis_is_unavailable_in_this_browser_please_try_a_current_version_of_chr)
  const decoder = new OfflineContext(2, 1, SAMPLE_RATE)
  const worker = new Worker(new URL('../workers/stemAnalysis.worker.js', import.meta.url), { type: 'module' })
  let pending, rejectAbort, stopped = false, idleTimer
  const cancelled = new Promise((_, reject) => { rejectAbort = reject })
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      const error = Object.assign(new Error(COPY.audio_analysis_stopped_responding_retry_loading_the_existing_result_in_a_current), { code: 'ANALYSIS_TIMEOUT' })
      worker.terminate(); pending?.reject(error); pending = null; rejectAbort(error)
    }, 120000)
  }
  // The race observes rejection while the browser's native decoder finishes.
  const cancel = () => {
    const error = new DOMException(COPY.processing_cancelled, 'AbortError')
    worker.terminate()
    pending?.reject(error)
    pending = null
    rejectAbort(error)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  worker.onmessage = ({ data }) => {
    if (signal?.aborted) return
    armIdle()
    if (data.type === 'progress') onProgress({ percent: data.percent, message: data.message })
    else if (pending) {
      const next = pending; pending = null
      if (data.type === 'error') next.reject(new Error(data.message))
      else next.resolve(data)
    }
  }
  worker.onerror = event => {
    event.preventDefault()
    const error = Object.assign(new Error(COPY.the_audio_analysis_worker_stopped_retry_loading_the_existing_stems_the_song_does), { code: 'WORKER_FAILED' })
    pending?.reject(error); pending = null
    rejectAbort(error)
  }
  const request = (data, transfers = []) => new Promise((resolve, reject) => {
    pending = { resolve, reject }
    armIdle()
    worker.postMessage(data, transfers)
  })
  const run = async () => {
    const descriptors = makeStemKeys(stems)
    for (let index = 0; index < stems.length; index++) {
      signal?.throwIfAborted()
      if (stopped) throw new DOMException(COPY.processing_stopped, 'AbortError')
      if (stems[index].loadFile) onProgress({ percent: 5 + 75 * index / stems.length, message: formatCopy(COPY.downloading, { value1: descriptors[index].label }) })
      const file = stems[index].loadFile ? await stems[index].loadFile() : stems[index].file
      signal?.throwIfAborted()
      onProgress({ percent: 5 + 75 * index / stems.length, message: formatCopy(COPY.reading, { value1: file.name }) })
      let decoded
      armIdle()
      try { decoded = await decoder.decodeAudioData(await file.arrayBuffer()) } catch {
        signal?.throwIfAborted()
        throw Object.assign(new Error(formatCopy(COPY.could_not_decode_the_download_finished_but_this_browser_could_not_read, { value1: file.name })), { code: 'AUDIO_DECODE' })
      }
      signal?.throwIfAborted()
      if (stopped) throw new DOMException(COPY.processing_stopped, 'AbortError')
      if (!decoded.length || decoded.duration > MAX_STEM_SECONDS) throw new Error(formatCopy(COPY.must_contain_audio_and_be_no_longer_than_15_minutes_for_browser_proces, { value1: file.name }))
      if (decoded.numberOfChannels > 2) throw new Error(formatCopy(COPY.has_more_than_two_channels_please_export_a_mono_or_stereo_stem, { value1: file.name }))
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => new Float32Array(decoded.getChannelData(channel)))
      decoded = null
      await request({ type: 'stem', descriptor: descriptors[index], channels, index, total: stems.length, mixAudio }, channels.map(channel => channel.buffer))
      clearTimeout(idleTimer)
    }
    return request({ type: 'finish', title: title.trim(), mixAudio })
  }
  try {
    const result = await Promise.race([run(), cancelled])
    signal?.throwIfAborted()
    return { metadata: result.metadata, framesByKey: result.framesByKey, audioBlob: result.wav ? new Blob([result.wav], { type: 'audio/wav' }) : null }
  } finally {
    stopped = true
    clearTimeout(idleTimer)
    worker.terminate()
    signal?.removeEventListener('abort', cancel)
  }
}
