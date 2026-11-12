import { COPY, formatCopy } from '../config/siteCopy.js'
import { measureStem, finishAnalysis, suppressKickBleed, encodeMixWav, SAMPLE_RATE } from '../audio/stemAnalysis.js'

let stems = [], mixLeft = new Float32Array(0), mixRight = new Float32Array(0)
const drums = {}

self.onmessage = ({ data }) => {
  const progress = (percent, message) => self.postMessage({ type: 'progress', percent, message })
  try {
    if (data.type === 'stem') {
      const { descriptor, channels, index, total } = data
      const measurement = measureStem(channels, SAMPLE_RATE, descriptor.key, fraction => progress(5 + 75 * (index + 0.2 + 0.8 * fraction) / total, formatCopy(COPY.analyzing, { value1: descriptor.label })))
      const [left, right = left] = channels
      if (data.mixAudio !== false && left.length > mixLeft.length) {
        const nextLeft = new Float32Array(left.length), nextRight = new Float32Array(left.length)
        nextLeft.set(mixLeft); nextRight.set(mixRight)
        mixLeft = nextLeft; mixRight = nextRight
      }
      if (data.mixAudio !== false) for (let i = 0; i < left.length; i++) { mixLeft[i] += left[i]; mixRight[i] += right[i] }
      if (descriptor.key === 'kick' || descriptor.key === 'toms') {
        const mono = new Float32Array(left.length)
        for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2
        drums[descriptor.key] = mono
      }
      stems.push({ ...descriptor, measurement })
      self.postMessage({ type: 'stem-ready' })
    } else if (data.type === 'finish') {
      if (drums.toms && drums.kick) suppressKickBleed(drums.toms, drums.kick, stems.find(stem => stem.key === 'toms').measurement, SAMPLE_RATE)
      progress(82, COPY.building_your_room)
      const result = finishAnalysis(stems, data.title)
      const wav = data.mixAudio === false ? null : encodeMixWav(mixLeft, mixRight, SAMPLE_RATE, fraction => progress(85 + 10 * fraction, COPY.preparing_playback))
      self.postMessage({ type: 'complete', ...result, wav }, wav ? [wav] : [])
      stems = []; mixLeft = mixRight = null
      delete drums.kick; delete drums.toms
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || COPY.could_not_analyze_the_stems })
  }
}
