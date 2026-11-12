import { COPY } from '../config/siteCopy.js'
// Keep 10 frames/sec, 2048-sample FFT windows, an 8 kHz frequency ceiling,
// and 35% shared loudness context. Activity windows cover the whole timeline.
import { stereoWidth, measureStereoFrames } from '../room/stereoImage.js'
import { signalActivity, hasStemSignal } from './stemActivity.js'

export const SAMPLE_RATE = 44100
export const MAX_STEM_SECONDS = 15 * 60
const WINDOW = 2048
const HALF = WINDOW / 2
const clamp = value => Math.max(0, Math.min(1, value))
const round = value => Math.round(value * 1000) / 1000

export function makeStemKeys(stems) {
  const used = new Set()
  return stems.map(stem => {
    let base = stem.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'stem'
    if (base === 'hi_hat') base = 'hihat'
    if (!/^[a-z]/.test(base)) base = `stem_${base}`
    let key = base, suffix = 2
    while (used.has(key)) key = `${base}_${suffix++}`
    used.add(key)
    return { key, label: stem.label.trim(), fileName: stem.file.name }
  })
}

function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * 0.95
  const low = Math.floor(position), high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

const reverse = new Uint16Array(WINDOW)
const hann = new Float64Array(WINDOW)
const cos = new Float64Array(HALF), sin = new Float64Array(HALF)
for (let i = 0; i < WINDOW; i++) {
  let value = i, reversed = 0
  for (let bit = 0; bit < 11; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1 }
  reverse[i] = reversed
  hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WINDOW)
  if (i < HALF) { cos[i] = Math.cos(-2 * Math.PI * i / WINDOW); sin[i] = Math.sin(-2 * Math.PI * i / WINDOW) }
}

function fft(real, imaginary) {
  for (let size = 2; size <= WINDOW; size *= 2) {
    const half = size / 2, step = WINDOW / size
    for (let start = 0; start < WINDOW; start += size) {
      for (let j = 0; j < half; j++) {
        const a = start + j, b = a + half, twiddle = j * step
        const re = real[b] * cos[twiddle] - imaginary[b] * sin[twiddle]
        const im = real[b] * sin[twiddle] + imaginary[b] * cos[twiddle]
        real[b] = real[a] - re; imaginary[b] = imaginary[a] - im
        real[a] += re; imaginary[a] += im
      }
    }
  }
}

function frequency(left, right, sampleRate, onProgress) {
  const real = new Float64Array(WINDOW), imaginary = new Float64Array(WINDOW)
  let weighted = 0, total = 0
  const count = 1 + Math.floor(left.length / 512)
  // Measure each channel before combining statistics. A mono sum would erase
  // anti-phase content and put an audible wide sound at the bottom of the room.
  const channels = right === left ? [left] : [left, right]
  for (let channel = 0; channel < channels.length; channel++) {
    for (let frame = 0; frame < count; frame++) {
      const start = frame * 512 - HALF
      let energy = 0
      imaginary.fill(0)
      for (let i = 0; i < WINDOW; i++) {
        const index = start + i
        const sample = index >= 0 && index < left.length ? channels[channel][index] : 0
        energy += sample * sample
        real[reverse[i]] = sample * hann[i]
      }
      if (energy > 0) {
        fft(real, imaginary)
        let magnitudeSum = 0, centroid = 0
        for (let bin = 0; bin <= HALF; bin++) {
          const magnitude = Math.hypot(real[bin], imaginary[bin])
          magnitudeSum += magnitude
          centroid += magnitude * bin * sampleRate / WINDOW
        }
        if (magnitudeSum) weighted += centroid / magnitudeSum * energy
        total += energy
      }
      if (frame % 256 === 0) onProgress?.((channel + frame / count) / channels.length)
    }
  }
  onProgress?.(1)
  return round(total ? Math.min(1, weighted / total / 8000) : 0)
}

function activityWindow(center, length, hop) {
  // A 2048-sample window leaves gaps at 10 Hz for normal audio sample rates.
  // Cover each frame's interval, including the final partial interval, without
  // creating an activity frame at the terminal silence timestamp.
  const size = Math.max(WINDOW, hop), before = Math.floor(size / 2)
  const start = center - before
  const end = center + hop >= length ? Math.max(center + size - before, length) : center + size - before
  return { start: Math.max(0, start), end: Math.min(length, end), size: end - start }
}

export function measureStem(channels, sampleRate, key, onProgress) {
  const left = channels[0], right = channels[1] ?? left
  if (!left?.length || right.length !== left.length) throw new Error(COPY.the_stem_contains_no_usable_audio)
  let sumL = 0, sumR = 0, squareL = 0, squareR = 0, cross = 0
  for (let i = 0; i < left.length; i++) {
    const l = left[i], r = right[i]
    if (!Number.isFinite(l) || !Number.isFinite(r)) throw new Error(COPY.the_stem_contains_invalid_audio_samples)
    sumL += l; sumR += r; squareL += l * l; squareR += r * r; cross += l * r
  }
  const varianceL = squareL / left.length - (sumL / left.length) ** 2
  const varianceR = squareR / left.length - (sumR / left.length) ** 2
  const correlation = varianceL > 0 && varianceR > 0 ? (cross / left.length - sumL * sumR / left.length ** 2) / Math.sqrt(varianceL * varianceR) : 1
  const hop = Math.floor(sampleRate / 10)
  const levels = [], pans = [], times = []
  let peak = 0, panWeighted = 0, energySum = 0
  for (let center = 0; center < left.length; center += hop) {
    const window = activityWindow(center, left.length, hop)
    let l = 0, r = 0
    for (let i = window.start; i < window.end; i++) {
      l += left[i] ** 2; r += right[i] ** 2
    }
    l = Math.sqrt(l / window.size); r = Math.sqrt(r / window.size)
    const level = (l + r) / 2, pan = Math.max(-1, Math.min(1, (r - l) / (r + l + 1e-9)))
    levels.push(level); pans.push(pan); times.push(center / sampleRate)
    peak = Math.max(peak, level)
    panWeighted += pan * level ** 2; energySum += level ** 2
  }
  const stereo = measureStereoFrames(left, right, sampleRate, times)
  const ceiling = percentile95(levels)
  return {
    times, levels, pans, ...stereo, ceiling, active: hasStemSignal(peak, ceiling),
    rms: Math.sqrt((squareL + squareR) / (2 * left.length)),
    freq: frequency(left, right, sampleRate, onProgress), width: round(stereoWidth(varianceL, varianceR, correlation)), correlation: round(correlation),
    pan: round(energySum ? panWeighted / energySum : 0), duration: left.length / sampleRate,
  }
}

export function suppressKickBleed(tom, kick, measurement, sampleRate) {
  measurement.activity = []; measurement.bleed = []
  const hop = Math.floor(sampleRate / 10)
  for (let frame = 0; frame < measurement.times.length; frame++) {
    const center = Math.round(measurement.times[frame] * sampleRate)
    // Compare spill over the same samples that produced this activity level.
    const { start, end } = activityWindow(center, tom.length, hop)
    let bleed = 0
    if (end > start && end <= kick.length) {
      let t = 0, k = 0, dot = 0
      for (let i = start; i < end; i++) { t += tom[i] ** 2; k += kick[i] ** 2; dot += tom[i] * kick[i] }
      if (t > 0 && Math.sqrt(k / (end - start)) >= 10 ** (-45 / 20)) {
        const similarity = clamp(Math.abs(dot) / (Math.sqrt(t * k) + 1e-12))
        if (Math.sqrt(t) / (Math.sqrt(k) + 1e-12) <= 0.5 && similarity >= 0.8) bleed = similarity ** 2
      }
    }
    // Retain the conservative tom gate: above-floor separator residue can
    // still become persistent activity after normalization against itself.
    measurement.activity.push(clamp((measurement.levels[frame] - 0.001) / 0.001) * (1 - bleed))
    measurement.bleed.push(bleed)
  }
}

export function finishAnalysis(stems, title) {
  const reference = Math.max(0, ...stems.filter(stem => stem.measurement.active).map(stem => stem.measurement.ceiling))
  const duration = Math.max(0, ...stems.map(stem => stem.measurement.duration))
  const framesByKey = {}, instruments = []
  for (const { key, label, fileName, measurement: m } of stems) {
    framesByKey[key] = m.times.flatMap((time, index) => {
      if (time >= m.duration) return []
      const level = m.active ? (0.65 * clamp(m.levels[index] / (m.ceiling + 1e-9)) + 0.35 * clamp(m.levels[index] / (reference + 1e-9))) * signalActivity(m.levels[index]) * (m.activity?.[index] ?? 1) : 0
      return [{ t: Math.round(time * 100) / 100, loud: round(level), pan: m.active ? round(m.pans[index]) : 0, width: round(m.widths[index]), correlation: round(m.correlations[index]), ...(m.bleed ? { kickBleed: round(m.bleed[index]) } : {}) }]
    })
    framesByKey[key].push({ t: Math.round(m.duration * 1e6) / 1e6, loud: 0, pan: 0, kickBleed: 0 })
    // Shorter files end in silence in the summed playback. Compare every
    // stem over that same timeline without allocating padded sample arrays.
    const rms = duration > 0 ? m.rms * Math.sqrt(m.duration / duration) : 0
    instruments.push({ key, label, fileName, freq: m.freq, width: m.width, correlation: m.correlation, pan: m.pan, active: m.active, rms })
  }
  return { metadata: { title: title.trim(), processingMode: 'stems', instruments }, framesByKey }
}

export function encodeMixWav(left, right, sampleRate = SAMPLE_RATE, onProgress) {
  let peak = 0
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  const gain = peak > 0.98 ? 0.98 / peak : 1
  const buffer = new ArrayBuffer(44 + left.length * 4), view = new DataView(buffer)
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true)
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, left.length * 4, true)
  for (let i = 0; i < left.length; i++) {
    view.setInt16(44 + i * 4, Math.round(left[i] * gain * 32767), true)
    view.setInt16(46 + i * 4, Math.round(right[i] * gain * 32767), true)
    if (i % 65536 === 0) onProgress?.(i / left.length)
  }
  return buffer
}
