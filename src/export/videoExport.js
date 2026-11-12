import { COPY } from '../config/siteCopy.js'
import { ROOM_VIDEO, videoFilename } from './videoTimeline.js'
import { measureAacDelay } from '../audio/audioEncoderDelay.js'

export function saveVideo(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException(COPY.export_cancelled, 'AbortError')
}

export async function chooseExportFormat(library, canvas, audioBuffer) {
  for (const candidate of [
    { video: 'avc', audio: 'aac', format: 'Mp4OutputFormat', extension: 'mp4', mime: 'video/mp4' },
    { video: 'vp8', audio: 'opus', format: 'WebMOutputFormat', extension: 'webm', mime: 'video/webm' },
  ]) {
    const [video, audio] = await Promise.all([
      library.canEncodeVideo(candidate.video, { width: canvas.width, height: canvas.height, frameRate: ROOM_VIDEO.fps, bitrate: ROOM_VIDEO.videoBitrate }),
      library.canEncodeAudio(candidate.audio, { numberOfChannels: audioBuffer.numberOfChannels, sampleRate: audioBuffer.sampleRate }),
    ])
    if (video && audio) return candidate
  }
  throw new Error(COPY.this_browser_cannot_export_video_with_audio_please_try_a_current_version_of_chro)
}

export async function exportVideo({
  canvas, renderFrame, audioBuffer, title, signal, onProgress = () => {},
  library, measureDelay = measureAacDelay, yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0)),
}) {
  const media = library ?? await import('mediabunny')
  checkCancelled(signal)
  const format = await chooseExportFormat(media, canvas, audioBuffer)
  const audioDelay = format.audio === 'aac'
    ? await measureDelay(audioBuffer.sampleRate, audioBuffer.numberOfChannels, signal) : 0
  checkCancelled(signal)
  const target = new media.BufferTarget()
  const output = new media.Output({ format: new media[format.format](), target })
  const video = new media.CanvasSource(canvas, { codec: format.video, bitrate: ROOM_VIDEO.videoBitrate, latencyMode: 'quality' })
  const audio = new media.AudioSampleSource({ codec: format.audio, bitrate: ROOM_VIDEO.audioBitrate })
  const fps = ROOM_VIDEO.fps
  const duration = audioBuffer.duration
  if (!(duration > 0 && Number.isFinite(duration))) throw new Error(COPY.the_song_has_no_audio_to_export)
  output.addVideoTrack(video, { frameRate: fps })
  output.addAudioTrack(audio)
  let complete = false
  try {
    await output.start()
    const count = Math.ceil(duration * fps)
    let audioStart = 0
    let lastYield = performance.now()
    for (let frame = 0; frame < count; frame++) {
      checkCancelled(signal)
      const time = frame / fps
      renderFrame(time, 1 / fps)
      await video.add(time, Math.min(1 / fps, duration - time))
      checkCancelled(signal)

      // Interleave small audio blocks with video to bound the encoder queues.
      const audioEnd = Math.min(audioBuffer.length, Math.round((frame + 1) * audioBuffer.sampleRate / fps))
      const length = audioEnd - audioStart
      if (length > 0) {
        const samples = new Float32Array(length * audioBuffer.numberOfChannels)
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          samples.set(audioBuffer.getChannelData(channel).subarray(audioStart, audioEnd), channel * length)
        }
        const sample = new media.AudioSample({
          data: samples, format: 'f32-planar', numberOfChannels: audioBuffer.numberOfChannels,
          sampleRate: audioBuffer.sampleRate, timestamp: audioStart / audioBuffer.sampleRate - audioDelay,
        })
        try { await audio.add(sample) } finally { sample.close() }
        audioStart = audioEnd
      }

      // Yield on CPU time instead of waiting for playback or display FPS.
      if (performance.now() - lastYield > 35 || frame === count - 1) {
        onProgress({ percent: 10 + 85 * (frame + 1) / count, message: COPY.exporting_video })
        await yieldToUI()
        lastYield = performance.now()
      }
    }
    checkCancelled(signal)
    onProgress({ percent: 95, message: COPY.finishing_video })
    await output.finalize()
    checkCancelled(signal)
    complete = true
    onProgress({ percent: 100, message: COPY.video_ready })
    return { blob: new Blob([target.buffer], { type: format.mime }), filename: videoFilename(title, format.extension) }
  } finally {
    if (!complete && output.state !== 'finalized') await output.cancel()
  }
}
