export const UPLOAD_SAMPLE_RATE = 44100
export const UPLOAD_BYTES_PER_FRAME = 8

// A canonical float32 WAV preserves decoded sample values and lets the server
// verify duration from a small header before any paid separation is started.
export function encodeSeparationWav(left, right = left, onProgress = () => {}) {
  const buffer = new ArrayBuffer(44 + left.length * UPLOAD_BYTES_PER_FRAME)
  const view = new DataView(buffer)
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true)
  view.setUint32(24, UPLOAD_SAMPLE_RATE, true); view.setUint32(28, UPLOAD_SAMPLE_RATE * 8, true)
  view.setUint16(32, 8, true); view.setUint16(34, 32, true); text(36, 'data'); view.setUint32(40, left.length * 8, true)
  for (let i = 0; i < left.length; i++) {
    view.setFloat32(44 + i * 8, left[i], true); view.setFloat32(48 + i * 8, right[i], true)
    if (i % 262144 === 0) onProgress(i / left.length)
  }
  return buffer
}

export function validateSeparationWav(header, size, maxSeconds) {
  if (header.byteLength < 44) throw new Error('The uploaded audio is incomplete.')
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const text = (offset, length) => String.fromCharCode(...header.subarray(offset, offset + length))
  const dataBytes = view.getUint32(40, true)
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || text(36, 4) !== 'data' ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 3 || view.getUint16(22, true) !== 2 ||
      view.getUint32(24, true) !== UPLOAD_SAMPLE_RATE || view.getUint32(28, true) !== UPLOAD_SAMPLE_RATE * 8 ||
      view.getUint16(32, true) !== 8 || view.getUint16(34, true) !== 32 ||
      view.getUint32(4, true) !== size - 8 || dataBytes !== size - 44 || dataBytes % 8 || !dataBytes) {
    throw new Error('The uploaded audio is invalid. Please select the file again.')
  }
  const seconds = dataBytes / (UPLOAD_SAMPLE_RATE * 8)
  if (seconds > maxSeconds) throw new Error(`Songs must be no longer than ${maxSeconds / 60} minutes.`)
  return seconds
}
