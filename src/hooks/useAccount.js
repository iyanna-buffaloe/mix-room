import { useEffect, useState, useSyncExternalStore } from 'react'
import { getAccountConnection } from '../auth/supabase.js'
import { setSeparationAccountProvider } from '../separation/separationClient.js'
export function useAccount() {
  const [{ session }] = useState(getAccountConnection)
  const account = useSyncExternalStore(session.subscribe, session.getSnapshot)
  useEffect(() => {
    setSeparationAccountProvider(() => {
      const current = session.getSnapshot()
      if (current.status === 'signed-in') return session.getAccessToken(current.user.id)
      if (['checking', 'error'].includes(current.status)) throw new Error('Your account could not be checked. Retry your account before processing.')
      return null
    })
    session.start()
  }, [session])
  return account
}
