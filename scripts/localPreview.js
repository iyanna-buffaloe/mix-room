// A CSS-only Vite session should not flood the terminal with proxy errors.
// Only the read-only availability check is handled here; jobs still use the
// normal proxy and require the real local API.
export function localSeparationConfig({ fetcher = fetch } = {}) {
  return async (request, response, next) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (request.method !== 'GET' || !['/api/separation/config', '/api/mixes/config'].includes(pathname)) return next()
    let configuration
    try {
      const upstream = await fetcher(`http://127.0.0.1:3001${pathname}`, { signal: AbortSignal.timeout(1000) })
      const value = await upstream.json()
      if (!upstream.ok || typeof value.available !== 'boolean') throw new Error('Local API unavailable')
      configuration = pathname === '/api/mixes/config' ? { available: value.available, limit: value.limit, maxMixBytes: value.maxMixBytes, maxAccountBytes: value.maxAccountBytes } : { available: value.available, maxSeconds: value.maxSeconds, monthlyJobs: value.monthlyJobs }
    } catch {
      configuration = pathname === '/api/mixes/config' ? { available: false, limit: 3, maxMixBytes: 167772160, maxAccountBytes: 503316480 } : { available: false, maxSeconds: 360, monthlyJobs: 10, localPreview: true }
    }
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    response.end(JSON.stringify(configuration))
  }
}
