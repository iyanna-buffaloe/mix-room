import test from 'node:test'
import assert from 'node:assert/strict'
import { suggestStemName, suggestStemNames, suggestStemMix } from './suggestStemName.js'
import { makeStemKeys } from './stemAnalysis.js'

test('common vocal abbreviations distinguish lead, backing, and general vocals', () => {
  for (const file of ['song_BGV02.wav', 'bv-04.mp3', 'BVOX_1.flac', 'BVox_1.wav', 'BackingVox.wav', 'bg_vox_double.wav', 'backgroundVocals.wav', 'BGV_Vox.wav', 'Vox_BG.wav']) assert.equal(suggestStemName(file), 'Backing vocals', file)
  for (const file of ['LeadVox01.wav', 'lvox-02.wav', 'LVox.wav', 'Vox_Lead.wav']) assert.equal(suggestStemName(file), 'Lead vocals', file)
  for (const file of ['song_vox03.wav', 'VOC_2.wav', 'vocal.wav']) assert.equal(suggestStemName(file), 'Vocals', file)
})

test('instrument abbreviations and common filename separators produce recognizable names', () => {
  const examples = { '01_KCK.wav': 'Kick', 'BD02.wav': 'Kick', 'bass-drum.wav': 'Kick', 'SNR_v3.wav': 'Snare', 'HH02.wav': 'Hi-hat', 'track-TOMS.wav': 'Toms', 'Drms_170.wav': 'Drums', 'bassGtr.wav': 'Bass', 'GTR_L.wav': 'Guitar', 'ac_gtr.wav': 'Acoustic guitar', 'EGTR02.wav': 'Electric guitar', 'PNO-01.wav': 'Piano', 'strings Bmin7.wav': 'Strings', 'PRC02.wav': 'Percussion', 'synthbass.wav': 'Bass', 'SFX 03.wav': 'Effects' }
  for (const [filename, expected] of Object.entries(examples)) assert.equal(suggestStemName(filename), expected, filename)
})

test('unmatched and coincidental partial words return no suggestion', () => {
  for (const file of ['my_custom_track.wav', 'Tomorrow.wav', 'Bassoon.wav', 'organic.wav', 'voxels.wav', 'mysterious texture.wav', '808.wav', '']) assert.equal(suggestStemName(file), null, file)
})

test('smart hi-hat names retain the recognized drum key and unique duplicate keys', () => {
  const keys = makeStemKeys([{ label: suggestStemName('HH02.wav'), file: { name: 'HH02.wav' } }, { label: 'Hihat', file: { name: 'hat.wav' } }])
  assert.deepEqual(keys.map(stem => stem.key), ['hihat', 'hihat_2'])
})

test('the screenshot filenames use each stem name after the shared drum-and-bass title', () => {
  const filenames = [
    '6.26 drum and bass 1-Strings Bmin7.wav',
    '6.26 drum and bass 2-Synth Note Simple Analogue F.wav',
    '6.26 drum and bass 5-Drum and Bass Down 170 bpm.wav',
    '6.26 drum and bass 6-denoised_v4.0_toolkit vocals.wav',
    '6.26 drum and bass Neptune Arp.wav',
  ]
  assert.deepEqual(suggestStemMix(filenames), { title: '6.26 drum and bass', labels: ['Strings', 'Synth 1', 'Drums', 'Vocals', 'Synth 2'] })
})

test('shared instrument words in suffixes or different filename positions are ignored', () => {
  assert.deepEqual(suggestStemNames(['1-strings-song drums.wav', '2-synth-song drums.wav', '3-vox-song drums.wav']), ['Strings', 'Synth', 'Vocals'])
  assert.deepEqual(suggestStemNames(['song drums - strings.wav', 'synth - song drums.wav', 'song drums - vox.wav']), ['Strings', 'Synth', 'Vocals'])
})

test('a shared instrument becomes numbered parts rather than a false song title', () => {
  assert.deepEqual(suggestStemMix(['Drums 1-unknown.wav', 'Drums 2-texture.wav']), { title: null, labels: ['Drums 1', 'Drums 2'] })
  assert.deepEqual(suggestStemMix(['vox01.wav', 'vox02.wav']), { title: null, labels: ['Vocals 1', 'Vocals 2'] })
  assert.deepEqual(suggestStemNames(['BGV01.wav']), ['Backing vocals 1'])
  assert.deepEqual(suggestStemNames([]), [])
})

test('learns a song prefix, suffix, or middle field from each batch', () => {
  for (const files of [
    ['Night Drive - 01 - Bass.wav', 'Night Drive - 02 - Drums.wav', 'Night Drive - 03 - Vocals.wav'],
    ['01_Bass_Night Drive.wav', '02_Drums_Night Drive.wav', '03_Vocals_Night Drive.wav'],
    ['01 - Night Drive - Bass.wav', '02 - Night Drive - Drums.wav', '03 - Night Drive - Vocals.wav'],
    ['01 Night Drive Bass.wav', 'Night_Drive_02_Drums.wav', '03-NightDrive-Vox.wav'],
  ]) assert.deepEqual(suggestStemMix(files), { title: 'Night Drive', labels: ['Bass', 'Drums', 'Vocals'] }, files.join(', '))
})

test('an instrument word in a title does not name every stem after that instrument', () => {
  assert.deepEqual(suggestStemMix(['Lost In Bass - 01 - Gtr.wav', 'Lost In Bass - 02 - Piano.wav']), { title: 'Lost In Bass', labels: ['Guitar', 'Piano'] })
  assert.deepEqual(suggestStemMix(['Piano Dreams__Kick.wav', 'Piano Dreams__Bass.wav']), { title: 'Piano Dreams', labels: ['Kick', 'Bass'] })
  assert.deepEqual(suggestStemMix(['Bass Man - Night Drive - Gtr.wav', 'Drum Man - Night Drive - Piano.wav']), { title: 'Night Drive', labels: ['Guitar', 'Piano'] })
  assert.deepEqual(suggestStemMix(['Bass Man - Night Drive - Guzheng.wav', 'Drum Man - Night Drive - Theremin.wav']), { title: 'Night Drive', labels: ['Guzheng', 'Theremin'] })
})

test('distinguishes a repeated vocal family from the preceding title', () => {
  assert.deepEqual(suggestStemMix(['Night_Drive_Vox_Dry.wav', 'Night_Drive_Vox_Wet.wav']), { title: 'Night Drive', labels: ['Vocals dry', 'Vocals wet'] })
  assert.deepEqual(suggestStemMix(['Night Drive - LeadVox.wav', 'Night Drive - BackingVox.wav']), { title: 'Night Drive', labels: ['Lead vocals', 'Backing vocals'] })
  assert.deepEqual(suggestStemMix(['Night Drive - Vox - Dry.wav', 'Night Drive - Vox - Wet.wav']), { title: 'Night Drive', labels: ['Vocals dry', 'Vocals wet'] })
  assert.deepEqual(suggestStemMix(['Song_SynthPad1.wav', 'Song_SynthPad2.wav']), { title: 'Song', labels: ['Synth 1', 'Synth 2'] })
})

test('uses the changing filename field for instruments outside the keyword dictionary', () => {
  assert.deepEqual(suggestStemMix(['Summer Rain - Guzheng.wav', 'Summer Rain - Theremin.wav']), { title: 'Summer Rain', labels: ['Guzheng', 'Theremin'] })
  assert.deepEqual(suggestStemMix(['Summer_Rain_01_HangDrum.wav', 'Summer_Rain_02_Guzheng.wav']), { title: 'Summer Rain', labels: ['Hang Drum', 'Guzheng'] })
})

test('export versions, sample rates, tempo and dates do not become a mix title or stem number', () => {
  assert.deepEqual(suggestStemMix(['01_Guitar_L_24bit_48k.wav', '02_Guitar_R_24bit_48k.wav']), { title: null, labels: ['Guitar L', 'Guitar R'] })
  assert.deepEqual(suggestStemMix(['2026-10-22_Night_Drive_Bass_120BPM_24bit_44k1_v3.wav', '2026-10-22_Night_Drive_Drums_120BPM_24bit_44k1_v3.wav']), { title: 'Night Drive', labels: ['Bass', 'Drums'] })
  assert.deepEqual(suggestStemMix(['MVSEP_Night_Drive_bass_44100hz.wav', 'MVSEP_Night_Drive_vocals_44100hz.wav']), { title: 'Night Drive', labels: ['Bass', 'Vocals'] })
})

test('retains mic roles and part numbers and disambiguates genuinely repeated names', () => {
  assert.deepEqual(suggestStemMix(['Song__Bass_DI.wav', 'Song__Bass_Mic.wav', 'Song__Synth1.wav', 'Song__Synth2.wav']), { title: 'Song', labels: ['Bass DI', 'Bass mic', 'Synth 1', 'Synth 2'] })
  assert.deepEqual(suggestStemMix(['01_Guitar.wav', '02_Guitar.wav']), { title: null, labels: ['Guitar 1', 'Guitar 2'] })
  assert.deepEqual(suggestStemMix(['Song__Guitar.wav', 'Song__Gtr.wav']), { title: 'Song', labels: ['Guitar 1', 'Guitar 2'] })
  assert.deepEqual(suggestStemMix(['Song - Guitar - L.wav', 'Song - Guitar - R.wav']), { title: 'Song', labels: ['Guitar L', 'Guitar R'] })
  assert.deepEqual(suggestStemMix(['Song - Bass - DI - 1.wav', 'Song - Bass - Mic - 2.wav']), { title: 'Song', labels: ['Bass DI 1', 'Bass mic 2'] })
  const mixed = suggestStemMix(['Song__Guitar.wav', 'Song__Gtr.wav', 'Song__Guitar1.wav'])
  assert.equal(new Set(mixed.labels).size, 3)
  assert.equal(mixed.labels[2], 'Guitar 1')
})

test('leaves uncertain titles and unmatched names alone without a supported batch pattern', () => {
  for (const files of [[], ['01_Bass.wav', '02_Guitar.wav'], ['Electric Guitar.wav', 'Electric Piano.wav'], ['01 Mystery texture.wav', '02 Unknown texture.wav'], ['01_stem_24bit.wav', '02_stem_24bit.wav']]) assert.equal(suggestStemMix(files).title, null)
  assert.deepEqual(suggestStemMix(['Mystery.wav', 'Unidentified.wav']), { title: null, labels: [null, null] })
  assert.deepEqual(suggestStemMix(['Blue Hour - Bass.wav']), { title: null, labels: ['Bass'] })
  assert.deepEqual(suggestStemMix(['', null]), { title: null, labels: [null, null] })
})

test('preserves Unicode titles and learns fields even when the instrument names are not English', () => {
  assert.deepEqual(suggestStemMix(['Été Bleu - Gtr.wav', 'Été Bleu - Bass.wav']), { title: 'Été Bleu', labels: ['Guitar', 'Bass'] })
  assert.deepEqual(suggestStemMix(['夜の海_01_ギター.wav', '夜の海_02_ドラム.wav']), { title: '夜の海', labels: ['ギター', 'ドラム'] })
})

test('only reads basenames, leaves inputs unchanged, and ignores upload ordering', () => {
  const files = ['C:\\Music\\Night Drive - Bass.wav', '/other/Night Drive - Drums.wav']
  const copy = [...files], result = suggestStemMix(files)
  assert.deepEqual(result, { title: 'Night Drive', labels: ['Bass', 'Drums'] })
  assert.deepEqual(files, copy)
  assert.deepEqual(suggestStemMix([...files].reverse()), { title: 'Night Drive', labels: ['Drums', 'Bass'] })
})

test('track numbers never turn separate bass and drum words into a kick alias', () => {
  assert.equal(suggestStemName('bass 5 drum.wav'), 'Drums')
  assert.equal(suggestStemName('bass drum.wav'), 'Kick')
  assert.equal(suggestStemName('BD02.wav'), 'Kick')
})
