import { createRoot } from 'react-dom/client'
import { createClient } from '@supabase/supabase-js'
import { accountConfig } from './accountConfig.js'
import { consumeEmailLink, createEmailLinkSession } from './emailLink.js'
import EmailLanding from './EmailLanding.jsx'
import './emailLanding.css'

const link = consumeEmailLink(window.location, window.history)
const config = accountConfig({ VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY })
const client = config ? createClient(config.url, config.key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'mix-room-email-link' },
  global: { fetch: (input, options = {}) => fetch(input, { ...options, signal: AbortSignal.timeout(20000), referrerPolicy: 'no-referrer' }) },
}) : null
const session = createEmailLinkSession(client?.auth, link)
window.addEventListener('pagehide', () => session.dispose(), { once: true })
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload() })
window.addEventListener('hashchange', () => { session.dispose(); window.location.reload() })
createRoot(document.getElementById('root')).render(<EmailLanding session={session} />)
