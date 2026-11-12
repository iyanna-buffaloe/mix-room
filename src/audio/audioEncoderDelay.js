import { COPY } from '../config/siteCopy.js'
// AAC encoders can prepend priming samples without reporting the delay in
// their timestamps. Measure this browser's encoder with a short impulse so
// the MP4 edit list can keep the song aligned with the animation.
export async function measureAacDelay(sampleRate, numberOfChannels, signal) {
  if (!globalThis.AudioDecoder) return 0
  const impulseFrame = Math.round(sampleRate * 0.1)
  const length = Math.round(sampleRate * 0.25)
  const data = new Float32Array(length * numberOfChannels)
  for (let channel = 0; channel < numberOfChannels; channel++) data[channel * length + impulseFrame] = 0.8
  let peak = 0
  let peakTime = 0
  let failure
  let configured = false
  const decoder = new AudioDecoder({
    output: decoded => {
      try {
        const plane = new Float32Array(decoded.numberOfFrames)
        decoded.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
        for (let index = 0; index < plane.length; index++) {
          if (Math.abs(plane[index]) > peak) {
            peak = Math.abs(plane[index])
            peakTime = decoded.timestamp / 1e6 + index / decoded.sampleRate
          }
        }
      } finally { decoded.close() }
    },
    error: error => { failure = error },
  })
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      try {
        if (!configured) {
          const config = { ...metadata.decoderConfig }
          const description = config.description ? new Uint8Array(config.description) : null
          // Work around WebKit's missing/invalid AAC AudioSpecificConfig.
          if (!description || description.length < 2 || description[0] >> 3 === 0) {
            const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
            const frequency = rates.indexOf(sampleRate)
            if (frequency < 0) throw new Error(COPY.unsupported_aac_sample_rate)
            config.description = new Uint8Array([(2 << 3) | (frequency >> 1), ((frequency & 1) << 7) | (numberOfChannels << 3)])
          }
          decoder.configure(config)
          configured = true
        }
        decoder.decode(chunk)
      } catch (error) { failure = error }
    },
    error: error => { failure = error },
  })
  try {
    encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 192_000 })
    const sample = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: length, numberOfChannels, timestamp: 0, data })
    try { encoder.encode(sample) } finally { sample.close() }
    await encoder.flush()
    if (failure) throw failure
    await decoder.flush()
    if (failure) throw failure
    signal?.throwIfAborted()
    if (!peak) throw new Error(COPY.could_not_verify_the_audio_encoder_timing)
    return Math.max(0, Math.round((peakTime - impulseFrame / sampleRate) * sampleRate)) / sampleRate
  } finally {
    if (encoder.state !== 'closed') encoder.close()
    if (decoder.state !== 'closed') decoder.close()
  }
}
