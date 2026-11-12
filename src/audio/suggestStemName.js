import { COPY } from '../config/siteCopy.js'
// Canonical aliases are used after detecting this batch's title and name
// fields. Specific instruments and vocal roles come before broad families.
const INSTRUMENT_KEYWORDS = [
  [COPY.backing_vocals, ['background vocals', 'background vocal', 'background vox', 'backing vocals', 'backing vocal', 'backing vox', 'bg vocals', 'bg vocal', 'bg vox', 'vox bg', 'vocals bg', 'bkg vox', 'bkg vocals', 'bkg vocal', 'bk vox', 'b vox', 'bvox', 'bgv', 'bgvs', 'bv', 'bvs', 'harmonies', 'harmony vocals']],
  [COPY.lead_vocals, ['lead vocals', 'lead vocal', 'lead vox', 'vox lead', 'vocals lead', 'ld vox', 'l vox', 'lvox', 'ldv']],
  ['Kick', ['kick', 'kicks', 'kik', 'kck', 'bd', 'bass drum']],
  ['Snare', ['snare', 'snares', 'snr', 'sd']],
  ['Hi-hat', ['hi hat', 'hi hats', 'hihat', 'hihats', 'hh', 'hht', 'hat', 'hats']],
  ['Toms', ['tom', 'toms']],
  ['Crash', ['crash', 'crashes']],
  ['Ride', ['ride']],
  ['Cymbals', ['cymbal', 'cymbals', 'cym', 'cyms']],
  ['Drum loop', ['drum loop', 'drum loops']],
  ['Drums', ['drum', 'drums', 'drm', 'drms', 'drumkit', 'drum kit']],
  ['Bass', ['bass', 'bs', 'subbass', 'sub bass', 'synth bass', 'synthbass']],
  [COPY.acoustic_guitar, ['acoustic guitar', 'acoustic gtr', 'ac guitar', 'ac gtr', 'agtr']],
  [COPY.electric_guitar, ['electric guitar', 'electric gtr', 'elec guitar', 'elec gtr', 'el gtr', 'egtr']],
  ['Guitar', ['guitar', 'guitars', 'gtr', 'gtrs', 'guit']],
  ['Vocals', ['vocals', 'vocal', 'vox', 'voc', 'vocs', 'vx', 'acapella', 'acappella']],
  [COPY.electric_piano, ['electric piano', 'elec piano', 'e piano', 'epiano', 'rhodes', 'wurli', 'wurlitzer']],
  ['Piano', ['piano', 'pno', 'pian']],
  ['Organ', ['organ', 'org']],
  ['Keys', ['keyboard', 'keyboards', 'keys', 'kbd', 'kb']],
  ['Strings', ['string', 'strings', 'str', 'strs', 'violin', 'violins', 'vln', 'viola', 'cello', 'cellos']],
  ['Brass', ['brass', 'brs', 'horn', 'horns', 'hrn']],
  ['Saxophone', ['sax', 'saxophone', 'saxophones']],
  ['Trumpet', ['trumpet', 'trumpets', 'trpt', 'tpt']],
  ['Trombone', ['trombone', 'trombones', 'tbn']],
  ['Flute', ['flute', 'flt']],
  ['Marimba', ['marimba']],
  ['Djembe', ['djembe']],
  ['Cowbell', ['cowbell']],
  ['Overheads', ['overhead', 'overheads', 'oh']],
  ['Room', ['room mic', 'room mics', 'room']],
  ['Loop', ['loop', 'loops']],
  ['Synth', ['synth', 'synths', 'synthesizer', 'syn', 'arp', 'arpeggio', 'pad', 'pads', 'pluck', 'plucks']],
  ['Claps', ['clap', 'claps']],
  ['Shaker', ['shaker', 'shakers', 'shkr']],
  ['Tambourine', ['tambourine', 'tamb', 'tambs']],
  ['Percussion', ['percussion', 'perc', 'prc', 'conga', 'congas', 'bongo', 'bongos', 'cowbell']],
  ['Effects', ['fx', 'sfx', 'effects', 'ambience']],
  ['Other', ['other']],
]

const TECHNICAL = new Set('stem stems track tracks audio export exports exported final full mixdown master print prints render rendered aligned consolidated stereo mono bus denoised toolkit normalized normalised mvsep demucs htdemucs spleeter bit bits bpm hz khz kbps v ver version rev revision'.split(' '))
const QUALIFIERS = new Map(Object.entries({ di: 'DI', mic: 'mic', amp: 'amp', dry: 'dry', wet: 'wet', left: 'L', right: 'R', l: 'L', r: 'R', front: 'front', back: 'back', clean: 'clean', distorted: 'distorted', scratch: 'scratch', overdub: 'overdub', double: 'double', lead: 'lead', backing: 'backing' }))
const ALIAS_WORDS = new Set(INSTRUMENT_KEYWORDS.flatMap(([, aliases]) => aliases.flatMap(alias => alias.split(' '))))
const MATCHERS = INSTRUMENT_KEYWORDS.map(([name, aliases]) => [name, [...aliases].sort((a, b) => b.length - a.length).map(alias => alias.split(' '))])
const number = word => /^\d+(?:\.\d+)*$/.test(word)
const fold = word => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

function filename(filename) {
  if (typeof filename !== 'string') return { text: '', tokens: [] }
  const text = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
  const tokens = [...text.matchAll(/\p{L}+(?:['’]\p{L}+)*|\d+(?:\.\d+)*/gu)]
    .slice(0, 80).map(match => ({ raw: match[0], word: fold(match[0]), start: match.index, end: match.index + match[0].length }))
  return { text, tokens: withoutTechnical(tokens) }
}

function findPhrase(tokens, words) {
  return tokens.findIndex((_, index) => words.every((word, offset) => tokens[index + offset]?.word === word))
}

function instrument(tokens, ignored = new Set()) {
  for (const [name, aliases] of MATCHERS) {
    if (ignored.has(name)) continue
    for (const words of aliases) {
      const index = findPhrase(tokens, words)
      if (index >= 0) return { name, index, length: words.length }
    }
  }
  return null
}

function withoutTechnical(tokens) {
  const result = []
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].word, next = tokens[i + 1]?.word
    if (/^(?:19|20)\d{2}$/.test(word) && /^\d{1,2}$/.test(next ?? '') && /^\d{1,2}$/.test(tokens[i + 2]?.word ?? '')) { i += 2; continue }
    if (number(word) && /^(?:bit|bits|bpm|hz|khz|kbps)$/.test(next ?? '')) { i++; continue }
    if (/^(?:44|48|88|96)$/.test(word) && next === 'k') { i += number(tokens[i + 2]?.word ?? '') ? 2 : 1; continue }
    if (/^(?:v|ver|version|rev|revision|take|tk)$/.test(word) && number(next ?? '')) { i++; continue }
    if (/^(?:bpm|key)$/.test(word) && next) { i++; continue }
    if (/^[a-g](?:b|sharp)?(?:min|maj|minor|major|dim|sus)$/.test(word)) { if (number(next ?? '')) i++; continue }
    if (TECHNICAL.has(word)) continue
    result.push(tokens[i])
  }
  return result
}

function labelTokens(tokens) {
  const cleaned = withoutTechnical(tokens)
  while (cleaned.length && number(cleaned[0].word)) cleaned.shift()
  return cleaned
}

function titleText(record, start, length) {
  const tokens = withoutTechnical(record.tokens.slice(start, start + length))
  if (!tokens.length) return null
  const words = tokens.map(token => token.word)
  // Shared instrument types, routing and export settings are not song titles.
  const descriptive = words.some(word => !number(word) && !ALIAS_WORDS.has(word) && !QUALIFIERS.has(word) && !['acoustic', 'electric', 'elec'].includes(word))
  if (!descriptive) return null
  return record.text.slice(tokens[0].start, tokens.at(-1).end).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function fieldBoundary(record, start, length) {
  const before = start === 0 ? '' : record.text.slice(record.tokens[start - 1].end, record.tokens[start].start)
  const end = start + length
  const after = end === record.tokens.length ? '' : record.text.slice(record.tokens[end - 1].end, record.tokens[end].start)
  const delimiter = /[-–—_|]/
  return (start === 0 || delimiter.test(before)) && (end === record.tokens.length || delimiter.test(after))
}

function nameField(record, tokens, trusted) {
  const fields = [[]]
  for (const token of tokens) {
    const previous = fields.at(-1).at(-1)
    if (previous && /\s[-–—]\s|__+|\|/.test(record.text.slice(previous.end, token.start))) fields.push([])
    fields.at(-1).push(token)
  }
  const modifierField = field => field.length && field.every(token => QUALIFIERS.has(token.word) || ['electric', 'acoustic', 'elec'].includes(token.word) || number(token.word))
  const matched = fields.findLastIndex(field => instrument(labelTokens(field)))
  if (fields.length > 1 && matched >= 0) {
    let start = matched, end = matched
    while (start > 0 && modifierField(fields[start - 1])) start--
    while (end + 1 < fields.length && modifierField(fields[end + 1])) end++
    return labelTokens(fields.slice(start, end + 1).flat())
  }
  const last = labelTokens(fields.at(-1))
  return fields.length > 1 && last.length && trusted ? last : labelTokens(tokens)
}

function stemTokens(record, words) {
  if (!words) return nameField(record, record.tokens, false)
  const start = findPhrase(record.tokens, words)
  const before = labelTokens(record.tokens.slice(0, start))
  const after = labelTokens(record.tokens.slice(start + words.length))
  // In a middle-title pattern, a nonempty trailing field is the instrument
  // slot. This prevents a varying artist/recording prefix from winning just
  // because it happens to contain a word such as "Bass".
  const outside = after.length ? after : before
  return nameField(record, outside, true)
}

function sharedPattern(records) {
  if (records.length < 2 || records.some(record => !record.tokens.length)) return null
  let best = null
  const first = records[0]
  // Learn the shared span from this batch. It may be a prefix, a suffix, or a
  // middle field; delimiters and track-number positions need not be the same.
  for (let start = 0; start < first.tokens.length; start++) {
    for (let length = 1; length <= Math.min(32, first.tokens.length - start); length++) {
      const words = first.tokens.slice(start, start + length).map(token => token.word)
      const locations = records.map(record => findPhrase(record.tokens, words))
      if (locations.some(index => index < 0)) break
      const title = titleText(first, start, length)
      if (!title) continue
      const remaining = records.map(record => stemTokens(record, words))
      if (remaining.some(tokens => !tokens.some(token => !number(token.word)))) continue
      const matches = remaining.map(tokens => instrument(tokens))
      const known = matches.filter(Boolean).length
      const distinct = new Set(matches.filter(Boolean).map(match => match.name)).size
      const boundaries = records.filter((record, index) => fieldBoundary(record, locations[index], length)).length
      const edge = records.filter((record, index) => !labelTokens(record.tokens.slice(0, locations[index])).length || !labelTokens(record.tokens.slice(locations[index] + length)).length).length
      // Recognizable instruments outside a candidate are stronger evidence
      // than a longer common phrase that accidentally swallows "Vox" or "Gtr".
      if (!known && boundaries !== records.length) continue
      const inside = instrument(first.tokens.slice(start, start + length))
      const swallowsFamily = inside && matches.every(match => match?.name === inside.name)
      const score = known / records.length * 100 + distinct * 4 + boundaries / records.length * 20 + edge / records.length * 10 + title.length * 0.15 - (swallowsFamily ? 20 : 0)
      if (!best || score > best.score) best = { title, words, score }
    }
  }
  return best
}

function displayUnknown(tokens) {
  if (!tokens.some(token => !number(token.word))) return null
  const text = tokens.map(token => token.raw).join(' ')
  return (text[0].toUpperCase() + text.slice(1)).slice(0, 60)
}

function detailedName(tokens) {
  const match = instrument(tokens)
  if (!match) return null
  const suffix = tokens.slice(match.index + match.length)
  if (tokens.length === 2 && match.index === 1 && !QUALIFIERS.has(tokens[0].word) && !number(tokens[0].word) && ['Drums', 'Guitar', 'Piano', 'Strings', 'Brass'].includes(match.name)) {
    return { base: match.name, label: displayUnknown(tokens) }
  }
  const modifiers = suffix.filter(token => QUALIFIERS.has(token.word) || number(token.word))
    .map(token => QUALIFIERS.get(token.word) ?? token.word.replace(/^0+(?=\d)/, ''))
  // A leading DI/mic descriptor is useful too; a leading track index is not.
  const prefix = tokens.slice(0, match.index).filter(token => QUALIFIERS.has(token.word))
    .map(token => QUALIFIERS.get(token.word))
  const parts = [...new Set([...prefix, ...modifiers])]
  return { base: match.name, label: [match.name, ...parts].join(' ').slice(0, 60) }
}

export function suggestStemName(name) {
  return instrument(filename(name).tokens)?.name ?? null
}

// This operates on filenames only: no audio, network requests, or uploaded
// contents are needed. Null suggestions leave the user's existing text alone.
export function suggestStemMix(filenames) {
  const records = filenames.map(filename)
  const pattern = sharedPattern(records)
  const tokens = records.map(record => stemTokens(record, pattern?.words))
  const names = tokens.map(parts => detailedName(parts))
  const labels = names.map((name, index) => name?.label ?? (pattern ? displayUnknown(tokens[index]) : null))
  const groups = new Map()
  labels.forEach((label, index) => {
    if (label) groups.set(label, [...(groups.get(label) ?? []), index])
  })
  const occupied = new Set([...groups].filter(([, indices]) => indices.length === 1).map(([label]) => label))
  for (const [label, indices] of groups) {
    if (indices.length < 2) continue
    // Repeated instruments retain their track identifier, or receive a stable
    // ordinal when the filenames supply no distinguishing number or mic role.
    const numbers = indices.map(index => records[index].tokens.find(token => number(token.word))?.word)
    const usable = numbers.every(value => /^\d+$/.test(value ?? '')) && new Set(numbers.map(Number)).size === indices.length
    indices.forEach((index, ordinal) => {
      let part = usable ? Number(numbers[ordinal]) : ordinal + 1
      let suggestion = `${label.slice(0, 52)} ${part}`
      while (occupied.has(suggestion)) suggestion = `${label.slice(0, 52)} ${++part}`
      occupied.add(suggestion)
      labels[index] = suggestion
    })
  }
  return { title: pattern?.title ?? null, labels }
}

export function suggestStemNames(filenames) {
  return suggestStemMix(filenames).labels
}
