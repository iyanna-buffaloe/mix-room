import { createClient } from '@supabase/supabase-js'

export function createUserVerifier(env, { fetcher = fetch } = {}) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  // Identity validation needs no administrative key when a public key exists.
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY
  if (!url || !key) return null
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, options = {}) => fetcher(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }) } })
  return async token => {
    const { data, error } = await client.auth.getUser(token)
    if (error && (!error.status || error.status >= 500)) throw error
    if (error || !data.user?.email_confirmed_at || data.user.is_anonymous) return null
    return { id: data.user.id }
  }
}
