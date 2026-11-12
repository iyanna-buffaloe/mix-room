import test from 'node:test'
import assert from 'node:assert/strict'
import { createMixArchive, readMixArchive } from './mixArchive.js'

const record = () => ({ version: 1, id: crypto.randomUUID(), audioBlob: new Blob([new Uint8Array(100)], { type: 'audio/wav' }), metadata: { title: 'Night drive', instruments: [{ key: 'guitar', label: 'Guitar', freq: .5 }] }, framesByKey: { guitar: [{ t: 0, loud: .5, pan: -.2 }] } })
test('saved archive restores audio, frames, names, and normalized view state', async () => {
  const source = record(), view = { settings: { roomStyle: 'dark', labelScale: 1.2 }, visibility: { guitar: false, unknown: true } }
  const decoded = await readMixArchive(createMixArchive(source, view))
  assert.deepEqual(decoded.record.metadata, source.metadata)
  assert.deepEqual(decoded.record.framesByKey, source.framesByKey)
  assert.deepEqual(await decoded.record.audioBlob.arrayBuffer(), await source.audioBlob.arrayBuffer())
  assert.equal(decoded.record.audioBlob.type, 'audio/wav')
  assert.equal(decoded.view.settings.roomStyle, 'dark')
  assert.deepEqual(decoded.view.visibility, { guitar: false })
  assert.notEqual(decoded.record.id, source.id)
})
test('truncated audio, invalid headers, and unsupported manifests are rejected', async () => {
  const archive = createMixArchive(record())
  await assert.rejects(readMixArchive(archive.slice(0, 20)), /empty|complete/)
  const wrong = new Uint8Array(await archive.arrayBuffer()); wrong[0] = 0
  await assert.rejects(readMixArchive(new Blob([wrong])), /complete/)
  const source = record(); source.metadata.title = ''
  await assert.rejects(readMixArchive(createMixArchive(source)), /name/)
  assert.throws(() => createMixArchive({ ...source, audioBlob: null }), /incomplete/)
})

test('malformed backup labels and frame values cannot enter the room renderer', async () => {
  for (const edit of [source => { source.metadata.instruments[0].label = {} }, source => { source.framesByKey.guitar[0].pan = null }, source => { source.metadata.instruments.push({ ...source.metadata.instruments[0] }) }]) {
    const source = record(); edit(source)
    await assert.rejects(readMixArchive(createMixArchive(source)), /invalid instrument/)
  }
})
