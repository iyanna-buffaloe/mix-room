import { COPY, formatCopy } from '../config/siteCopy.js'
const MAX_BYTES = 300 * 1024 * 1024
const problem = (message, code, extra = {}) => Object.assign(new Error(message), { code, recoverable: true, ...extra })

function pause(milliseconds, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// Retry reads only. Never repeat an upload or a paid provider submission.
export async function downloadAudio(url, signal, name, { expectedBytes = 0, fetcher = fetch, idleMilliseconds = 45000, retryMilliseconds = 1000, onRetry = () => {} } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const stop = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', stop, { once: true })
    let timer, reader, timedOut = false
    const renew = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, idleMilliseconds)
    }
    try {
      renew()
      const response = await fetcher(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!response.ok) throw problem(formatCopy(COPY.could_not_download_http_your_separated_stems_are_still_saved_in_mvsep, { value1: name, value2: response.status }), 'DOWNLOAD_HTTP', { status: response.status, retryable: [404, 408, 429, 500, 502, 503, 504].includes(response.status) })
      const declared = Number(response.headers.get('Content-Length'))
      if (declared > MAX_BYTES || expectedBytes > MAX_BYTES) throw problem(formatCopy(COPY.is_too_large_for_browser_analysis, { value1: name }), 'DOWNLOAD_SIZE', { retryable: false })
      if (!response.body) throw problem(formatCopy(COPY.the_download_of_was_empty, { value1: name }), 'DOWNLOAD_EMPTY')
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        renew()
        size += value.byteLength
        if (size > MAX_BYTES) throw problem(formatCopy(COPY.is_too_large_for_browser_analysis, { value1: name }), 'DOWNLOAD_SIZE', { retryable: false })
        chunks.push(value)
      }
      if (size < 44 || (expectedBytes > 0 && size !== expectedBytes) || (declared > 0 && size !== declared)) throw problem(formatCopy(COPY.the_download_of_was_incomplete_your_mvsep_separation_does_not_need_to_, { value1: name }), 'DOWNLOAD_INCOMPLETE')
      return new File(chunks, name, { type: response.headers.get('Content-Type') || 'audio/wav' })
    } catch (cause) {
      signal?.throwIfAborted()
      const failure = cause.code?.startsWith?.('DOWNLOAD_') ? cause : problem(timedOut ? formatCopy(COPY.downloading_stopped_responding_retry_loading_the_result_when_your_conn, { value1: name }) : formatCopy(COPY.the_download_of_was_interrupted_or_blocked_by_the_browser_retry_loadin, { value1: name }), timedOut ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_NETWORK')
      if (attempt === 2 || failure.retryable === false) throw failure
      onRetry({ name, attempt: attempt + 1, code: failure.code })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      // Cancelling a broken stream can hang too; do not await cleanup.
      if (reader) { reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    await pause(retryMilliseconds * (attempt + 1), signal)
  }
}
