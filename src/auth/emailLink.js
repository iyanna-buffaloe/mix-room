import { accountError } from './accountSession.js'

// New branded links carry their proof in the fragment, never the HTTP query.
// Capture it once, remove it from history, and keep it out of renderable state.
export function consumeEmailLink(location, history) {
  const url = new URL(location.href)
  const params = new URLSearchParams(url.hash.slice(1))
  const kind = params.get('type')
  const tokenHash = params.get('token_hash')
  const valid = !url.search && params.size === 2 && params.getAll('type').length === 1 && params.getAll('token_hash').length === 1 &&
    ['signup', 'recovery'].includes(kind) && /^(?:[a-f0-9]{56}|[a-f0-9]{64})$/i.test(tokenHash || '')
  history.replaceState(null, '', url.pathname)
  return valid ? { kind, tokenHash } : { kind: kind === 'recovery' ? kind : null, tokenHash: null }
}

export function createEmailLinkSession(auth, link) {
  let tokenHash = link.tokenHash, verifiedUser = null, grant = null, disposed = false
  let state = { kind: link.kind, phase: !auth ? 'unavailable' : tokenHash ? 'ready' : 'invalid', error: '' }
  const listeners = new Set()
  const patch = value => { if (!disposed) { state = { ...state, ...value }; for (const listener of listeners) listener() } }
  const check = value => { if (value.error) throw value.error; return value.data }
  const forget = async () => { verifiedUser = null; grant = null; await auth?.signOut({ scope: 'local' }).catch(() => {}) }
  const expired = error => ['otp_expired', 'bad_jwt', 'session_not_found', 'refresh_token_not_found', 'user_not_found'].includes(error?.code) || [401,403].includes(error?.status)
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    async verify() {
      if (disposed || !auth || state.phase !== 'ready' || (!tokenHash && !verifiedUser)) return false
      patch({ phase: 'verifying', error: '' })
      try {
        if (!verifiedUser) {
          const data = check(await auth.verifyOtp({ token_hash: tokenHash, type: link.kind }))
          tokenHash = null
          if (!data.user?.id || data.user.id !== data.session?.user?.id) throw Object.assign(new Error('Invalid verification'), { code: 'otp_expired' })
          verifiedUser = data.user.id
        }
        const user = check(await auth.getUser()).user
        if (!user?.id || !user.email_confirmed_at || user.id !== verifiedUser) {
          throw Object.assign(new Error('Invalid verification'), { code: 'otp_expired' })
        }
        if (disposed) { await forget(); return false }
        if (link.kind === 'recovery') { grant = user.id; patch({ phase: 'reset' }) }
        else { await forget(); patch({ phase: 'confirmed' }) }
        return true
      } catch (error) {
        if (expired(error)) { tokenHash = null; await forget(); patch({ phase: 'invalid', error: '' }) }
        else patch({ phase: 'ready', error: accountError(error) })
        return false
      } finally {
        if (disposed) await forget()
      }
    },
    async updatePassword(password, confirmation) {
      if (disposed || state.phase !== 'reset' || !grant) return false
      if (typeof password !== 'string' || password.length < 12) { patch({ error: 'Use at least 12 characters.' }); return false }
      if (password !== confirmation) { patch({ error: 'The passwords do not match.' }); return false }
      patch({ phase: 'saving', error: '' })
      try {
        const user = check(await auth.getUser()).user
        if (!user?.id || user.id !== grant) throw Object.assign(new Error('Session changed'), { code: 'session_not_found' })
        const data = check(await auth.updateUser({ password }))
        if (data.user?.id !== grant) throw Object.assign(new Error('Session changed'), { code: 'session_not_found' })
        await forget()
        patch({ phase: 'updated' })
        return !disposed
      } catch (error) {
        if (expired(error)) { await forget(); patch({ phase: 'invalid', error: '' }) }
        else patch({ phase: 'reset', error: accountError(error) })
        return false
      }
    },
    dispose() { patch({ phase: 'invalid', error: '' }); disposed = true; tokenHash = null; verifiedUser = null; grant = null; listeners.clear() },
  }
}
