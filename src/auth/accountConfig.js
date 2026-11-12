export function accountConfig(env = {}) {
  const url = env.VITE_SUPABASE_URL?.trim()
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  // Accept only modern public keys; a secret/administrator key must never
  // become a browser client, even when accidentally put in a public variable.
  if (!url || !key?.startsWith('sb_publishable_')) return null
  try {
    const parsed = new URL(url)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return null
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null
    return { url: parsed.origin, key }
  } catch { return null }
}

// Called by Vite before transforming browser modules, so a misnamed server
// credential fails the build instead of merely being rejected after exposure.
export function assertPublicAccountEnvironment(env = {}) {
  const allowed = new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'])
  for (const name of Object.keys(env)) {
    if (name.startsWith('VITE_') && !allowed.has(name)) throw new Error(`Unsupported browser variable ${name}. Keep server credentials in unprefixed server-only variables.`)
  }
  const url = env.VITE_SUPABASE_URL?.trim(), key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if ((url || key) && !accountConfig(env)) throw new Error('Configure a valid public Supabase URL and modern publishable key. Secret and service_role keys must never be browser variables.')
}

const callbackKeys = ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type', 'code', 'error', 'error_code', 'error_description']

export function accountCallback(href) {
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.slice(1))
  const present = ['access_token', 'code', 'error', 'error_code'].some(key => hash.has(key) || url.searchParams.has(key))
  const failed = ['error', 'error_code'].some(key => hash.has(key) || url.searchParams.has(key))
  if (present) {
    for (const key of callbackKeys) { hash.delete(key); url.searchParams.delete(key) }
    url.hash = hash.size ? hash.toString() : ''
  }
  const recovery = new URLSearchParams(new URL(href).hash.slice(1)).get('type') === 'recovery'
  return { present, failed, cleanUrl: url.pathname + url.search + url.hash, ...(recovery ? { recovery: true } : {}) }
}
