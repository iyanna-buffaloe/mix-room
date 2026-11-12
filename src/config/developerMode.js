// Production stays in the public view unless this page explicitly opts in.
// This controls display only; provider credentials stay on the server.
export function isDeveloperMode(search, localDevelopment = false) {
  const setting = new URLSearchParams(search).get('dev')
  if (setting === '1') return true
  if (setting === '0') return false
  return localDevelopment
}
