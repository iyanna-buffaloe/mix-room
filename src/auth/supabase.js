import { createClient } from '@supabase/supabase-js'
import { accountCallback, accountConfig } from './accountConfig.js'
import { createAccountSession } from './accountSession.js'

let connection
export function getAccountConnection() {
  if (connection) return connection
  const config = accountConfig({ VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY })
  const callback = accountCallback(window.location.href)
  const timedFetch = (input, options = {}) => fetch(input, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  })
  const client = config ? createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    global: { fetch: timedFetch },
  }) : null
  const emailVerifier = config ? createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'mix-room-current-email-verification' },
    global: { fetch: timedFetch },
  }).auth : null
  connection = {
    callback,
    localConfirmation: ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname),
    session: createAccountSession(client?.auth, {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      callback,
      emailVerifier,
      cleanCallback: () => { if (callback.present) window.history.replaceState(window.history.state, '', callback.cleanUrl) },
    }),
  }
  return connection
}
