// Dev-only browser-test entry. Production continues to use index.html/App.jsx.
import React from 'react'
import { createRoot } from 'react-dom/client'
import AccountAccess from '../../src/components/AccountAccess.jsx'
import { useAccount } from '../../src/hooks/useAccount.js'
import '../../src/index.css'

export default function AccountHarness() {
  const account = useAccount()
  return <main>
    <h1>Account test workspace</h1>
    <button type="button">Outside dialog</button>
    <output aria-label="Session status">{account.status}</output>
    <AccountAccess />
  </main>
}
createRoot(document.getElementById('root')).render(<AccountHarness />)
