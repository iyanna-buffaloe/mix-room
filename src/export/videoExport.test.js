import test from 'node:test'
import assert from 'node:assert/strict'
import { exportVideo } from './videoExport.js'
import { ROOM_VIDEO, createFrameSampler, getExportSize } from './videoTimeline.js'
import { smoothLoudness } from '../room/audioVisuals.js'

function fixture({ length = 48_050, supported = () => true, failAudio = false, onVideo = () => {} } = {}) {
  const frames = [], samples = [], progress = [], outputs = [], videoOptions = []
  const audioBuffer = {
    length, duration: length / 48_000, sampleRate: 48_000, numberOfChannels: 2,
    getChannelData: channel => new Float32Array(length).fill(channel ? -0.25 : 0.5),
  }
  const library = {
    canEncodeVideo: supported, canEncodeAudio: supported,
    BufferTarget: class { buffer = null },
    Mp4OutputFormat: class {}, WebMOutputFormat: class {},
    Output: class {
      state = 'pending'
      constructor({ target }) { this.target = target; outputs.push(this) }
      addVideoTrack() {}
      addAudioTrack() {}
      async start() { this.state = 'started' }
      async finalize() { this.state = 'finalized'; this.target.buffer = new Uint8Array([1, 2, 3]) }
      async cancel() { this.state = 'canceled' }
    },
    CanvasSource: class {
      constructor(canvas, options) { videoOptions.push(options) }
      async add(time, duration) { frames.push({ time, duration }); onVideo(frames.length) }
    },
    AudioSample: class {
      constructor(options) { Object.assign(this, options); samples.push(this) }
      close() { this.closed = true }
    },
    AudioSampleSource: class {
      async add() { if (failAudio) throw new Error('audio encoding failed') }
    },
  }
  return {
    frames, samples, progress, outputs, audioBuffer, library, videoOptions,
    run: options => exportVideo({
      canvas: { width: 640, height: 360 }, audioBuffer, library, title: 'my/song',
      measureDelay: async () => 0,
      renderFrame: () => {}, onProgress: value => progress.push(value), yieldToUI: async () => {}, ...options,
    }),
  }
}

test('offline export covers the whole song with contiguous stereo audio and explicit video timestamps', async () => {
  const f = fixture()
  const rendered = []
  const result = await f.run({ renderFrame: time => rendered.push(time) })
  assert.equal(f.frames.length, Math.ceil(f.audioBuffer.duration * 30))
  assert.equal(rendered[0], 0)
  assert.equal(rendered.at(-1), (f.frames.length - 1) / 30)
  assert.ok(Math.abs(f.frames.reduce((sum, frame) => sum + frame.duration, 0) - f.audioBuffer.duration) < 1e-10)
  let audioFrames = 0
  for (const sample of f.samples) {
    assert.equal(sample.timestamp, audioFrames / 48_000)
    const perChannel = sample.data.length / 2
    assert.equal(sample.data[0], 0.5)
    assert.equal(sample.data[perChannel], -0.25)
    assert.equal(sample.closed, true)
    audioFrames += perChannel
  }
  assert.equal(audioFrames, f.audioBuffer.length)
  assert.equal(result.filename, 'my_song-mix-room.mp4')
  assert.equal(result.blob.type, 'video/mp4')
  assert.equal(f.outputs[0].state, 'finalized')
  assert.equal(ROOM_VIDEO.fps, 30)
  assert.equal(f.videoOptions[0].bitrate, 8_000_000)
  assert.equal(f.progress.at(-1).percent, 100)
  assert.ok(f.progress.every((value, index) => !index || value.percent >= f.progress[index - 1].percent))
})

test('codec fallback requires both audio and video and produces a matching WebM file', async () => {
  const f = fixture({ supported: codec => codec !== 'aac' })
  const result = await f.run()
  assert.equal(result.blob.type, 'video/webm')
  assert.equal(result.filename, 'my_song-mix-room.webm')
})

test('AAC priming correction shifts packet timestamps while preserving all song samples', async () => {
  const f = fixture()
  await f.run({ measureDelay: async () => 2112 / 48_000 })
  assert.equal(f.samples[0].timestamp, -2112 / 48_000)
  assert.equal(f.samples.reduce((sum, sample) => sum + sample.data.length / 2, 0), f.audioBuffer.length)
})

test('cancelling between frames releases the encoder and never reports completion', async () => {
  const controller = new AbortController()
  const f = fixture({ onVideo: count => { if (count === 3) controller.abort() } })
  await assert.rejects(f.run({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.frames.length, 3)
  assert.equal(f.outputs[0].state, 'canceled')
  assert.ok(f.progress.every(value => value.percent < 100))
})

test('audio failures close the current sample and cancel the video file', async () => {
  const f = fixture({ failAudio: true })
  await assert.rejects(f.run(), /audio encoding failed/)
  assert.equal(f.samples[0].closed, true)
  assert.equal(f.outputs[0].state, 'canceled')
  assert.ok(f.progress.every(value => value.percent < 100))
})

test('unsupported codecs fail before allocating an output', async () => {
  const f = fixture({ supported: () => false })
  await assert.rejects(f.run(), /cannot export video with audio/)
  assert.equal(f.outputs.length, 0)
})

test('analysis sampling keeps earlier ties, matches playback smoothing, and resets for a new pass', () => {
  const frames = [{ t: 0, loud: 0.2 }, { t: 0.1, loud: 0.8, kickBleed: 0.9 }, { t: 0.2, loud: 0 }]
  const sample = createFrameSampler(frames)
  let expected = smoothLoudness(0, 0.2, 1 / 30)
  assert.equal(sample(0.05, 1 / 30).loud, expected)
  expected = smoothLoudness(expected, 0.8, 1 / 30)
  assert.deepEqual(sample(0.11, 1 / 30), { loud: expected, pan: 0, kickBleed: 0.9 })
  expected = smoothLoudness(expected, 0, 1 / 30)
  assert.equal(sample(10, 1 / 30).loud, expected)
  assert.equal(sample(0, 1 / 30).loud, smoothLoudness(0, 0.2, 1 / 30))
  assert.deepEqual(createFrameSampler([])(1, 1 / 30), { loud: 0, kickBleed: 0 })
})

test('export uses the preferred reference resolution for every screen size and DPR', () => {
  for (const [width, height] of [[1600, 1000], [302, 199], [390, 844], [780, 1688], [3840, 2160], [0, 0]]) {
    assert.deepEqual(getExportSize(width, height), { width: 1246, height: 606 })
  }
})
