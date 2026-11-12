import test from 'node:test'
import assert from 'node:assert/strict'
import { localSeparationConfig } from './localPreview.js'

test('an absent local API produces a quiet design-preview configuration', async () => {
  const headers = {}, response = { setHeader: (k, v) => { headers[k] = v }, end(body) { this.body = JSON.parse(body) } }
  await localSeparationConfig({ fetcher: async () => { throw new Error('ECONNREFUSED') } })({ method: 'GET', url: '/api/separation/config' }, response, () => assert.fail('availability should not reach the failing proxy'))
  assert.equal(response.statusCode, 200); assert.equal(response.body.available, false); assert.equal(response.body.localPreview, true)
  assert.equal(headers['Cache-Control'], 'no-store')
})

test('a running local API is forwarded and job requests retain their normal proxy', async () => {
  const response = { setHeader() {}, end(body) { this.body = JSON.parse(body) } }
  const middleware = localSeparationConfig({ fetcher: async () => Response.json({ available: true, maxSeconds: 360, monthlyJobs: 10, ignored: 'never forwarded' }) })
  await middleware({ method: 'GET', url: '/api/separation/config' }, response, () => assert.fail('configuration should be handled'))
  assert.deepEqual(response.body, { available: true, maxSeconds: 360, monthlyJobs: 10 })
  let forwarded = false
  await middleware({ method: 'POST', url: '/api/separation/jobs' }, response, () => { forwarded = true })
  assert.equal(forwarded, true)
})
