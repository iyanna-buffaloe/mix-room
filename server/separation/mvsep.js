const BASE = 'https://mvsep.com/api/separation/'
export const STAGES = {
  quick: { name: 'Separating instruments', sep_type: '63', keys: ['bass', 'drums', 'vocals', 'guitar', 'piano', 'other'] },
  instruments: { name: 'Separating instruments', sep_type: '63', keys: ['bass', 'drums', 'vocals', 'guitar', 'piano', 'other'] },
  drums: { name: 'Separating drum parts', sep_type: '37', add_opt1: '1', add_opt2: '1', keys: ['kick', 'snare', 'toms', 'hihat', 'ride', 'crash'] },
  vocals: { name: 'Separating lead and backing vocals', sep_type: '49', add_opt1: '0', add_opt2: '0', keys: ['lead_vocals', 'backing_vocals'] },
}
const LABELS = { hihat: 'Hi-hat', lead_vocals: 'Lead vocals', backing_vocals: 'Backing vocals' }
const LEGACY_QUICK_KEYS = ['bass', 'drums', 'vocals', 'other']
export const isMVSEPUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'mvsep.com' || url.hostname.endsWith('.mvsep.com')) } catch { return false }
}

export function readStemFiles(files, stage, { legacyQuick = false } = {}) {
  if (!Array.isArray(files)) throw new Error('MVSEP did not return stem files.')
  const expected = stage === 'quick' && legacyQuick ? LEGACY_QUICK_KEYS : STAGES[stage].keys, found = new Map()
  for (const file of files) {
    let key = String(file.type ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    key = ({ hh: 'hihat', hi_hat: 'hihat', tom: 'toms', kick_drum: 'kick', snare_drum: 'snare' })[key] ?? key
    if (stage === 'vocals') key = ({ vocals: 'lead_vocals', lead: 'lead_vocals', lead_vocal: 'lead_vocals', leadvocals: 'lead_vocals', vocals_lead: 'lead_vocals', back: 'backing_vocals', back_vocals: 'backing_vocals', backvocals: 'backing_vocals', background_vocals: 'backing_vocals', instrumental: 'backing_vocals', instrum: 'backing_vocals', back_instrum: 'backing_vocals', back_instrumental: 'backing_vocals' })[key] ?? key
    if (!expected.includes(key)) continue
    if (!isMVSEPUrl(file.url) || found.has(key)) throw new Error('MVSEP returned an invalid stem manifest.')
    const bytes = Number(file.bytes)
    found.set(key, { key, label: LABELS[key] ?? key[0].toUpperCase() + key.slice(1), name: `${key}.wav`, url: file.url, size: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 })
  }
  const missing = expected.filter(key => !found.has(key))
  if (missing.length) throw new Error(`MVSEP returned an incomplete ${stage} stem set. Missing: ${missing.map(key => LABELS[key] ?? key).join(', ')}. Please check the existing separation in your MVSEP account.`)
  return expected.map(key => found.get(key))
}

export function readCompletedSeparation(result) {
  if (result.status === 'not_found') throw new Error('This MVSEP result was not found or has expired. Check the result link in your MVSEP history.')
  if (result.status === 'failed') throw new Error('This job failed in MVSEP. Choose a completed result from your history.')
  if (result.status !== 'done') throw new Error('This MVSEP result is not ready. Wait for it to complete in MVSEP before loading it here.')
  const data = result.data
  const algorithm = String(data?.algorithm ?? '')
  if (!/^(Demucs4 HT|BS Roformer SW)\b/.test(algorithm)) throw new Error('Load a completed Demucs4 HT or BS Roformer SW result, or download its files and use the Stems tab.')
  if (!isMVSEPUrl(data.input_file?.url)) throw new Error('MVSEP did not return a valid original-song download.')
  const sixStems = algorithm.startsWith('BS Roformer SW') || (Array.isArray(data.files) && data.files.some(file => String(file.type).toLowerCase() === 'guitar'))
  return { status: 'complete', stems: readStemFiles(data.files, sixStems ? 'instruments' : 'quick', { legacyQuick: !sixStems }), sourceUrl: data.input_file.url }
}

export function createMVSEPClient(apiKey, fetcher = fetch) {
  const request = async (route, { fields, hash, allowMissing = false } = {}) => {
    const url = new URL(route, BASE)
    const options = { signal: AbortSignal.timeout(15000), redirect: 'error' }
    if (fields) {
      const body = new FormData()
      for (const [key, value] of Object.entries({ ...fields, api_token: apiKey })) body.append(key, value)
      Object.assign(options, { method: 'POST', body })
    } else url.searchParams.set('hash', hash)
    let response, data
    try { response = await fetcher(url, options); data = await response.json() } catch {
      throw new Error('MVSEP could not be reached. If a submission was in progress, check your MVSEP history before starting another job.')
    }
    if (allowMissing && (response.ok || response.status === 404) && !data.success) return data
    if (!response.ok || !data.success) {
      const message = response.status === 401 ? 'MVSEP rejected the API key. Check the server configuration.' : 'MVSEP could not complete this request. Check your credit balance and separation history.'
      throw new Error(message)
    }
    return data
  }
  return {
    async create(stage, sourceUrl, webhookUrl) {
      const { keys: _keys, name: _name, ...model } = STAGES[stage]
      const data = await request('create', { fields: { ...model, url: sourceUrl, remote_type: 'direct', output_format: '1', is_demo: '0', ...(webhookUrl ? { webhook_url: webhookUrl } : {}) } })
      if (typeof data.data?.hash !== 'string' || !data.data.hash || data.data.hash.length > 500) throw new Error('MVSEP did not confirm the submission. Check your separation history before retrying.')
      const link = data.data.link ? new URL(data.data.link, BASE) : null
      return link?.pathname.endsWith('/get-remote') ? `remote:${data.data.hash}` : data.data.hash
    },
    async get(hash) {
      // URL imports may first return a remote-download job. Its completion
      // hands off to the actual separation hash; persist that before polling
      // again rather than interpreting download completion as finished stems.
      if (!hash.startsWith('remote:')) {
        const direct = await request('get', { hash, allowMissing: true })
        if (direct.success || direct.status === 'failed') return direct
      }
      const remote = await request('get-remote', { hash: hash.replace(/^remote:/, ''), allowMissing: true })
      if (!remote.success) return { status: remote.status === 'failed' ? 'failed' : 'not_found' }
      if (remote.status === 'done') {
        const resolvedHash = remote.data?.hash
        if (typeof resolvedHash !== 'string' || !resolvedHash || resolvedHash.length > 500) throw new Error('MVSEP did not confirm the imported audio job.')
        return { status: 'waiting', data: { resolvedHash } }
      }
      return remote
    },
    async cancel(hash) {
      if (hash.startsWith('remote:')) {
        const remote = await request('get-remote', { hash: hash.slice(7), allowMissing: true })
        hash = remote.status === 'done' && typeof remote.data?.hash === 'string' ? remote.data.hash : hash.slice(7)
      }
      return request('cancel', { fields: { hash } })
    },
  }
}
