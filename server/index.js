import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalStore, createR2Storage } from './separation/storage.js'
import { createMVSEPClient } from './separation/mvsep.js'
import { createSeparationService, separationConfig } from './separation/service.js'
import { createMixService, savedMixConfig } from './mixes/service.js'
import { createMixRepository } from './mixes/repository.js'
import { createSavedMixStorage } from './mixes/storage.js'
import { createUserVerifier } from './auth/verifyUser.js'
import { createOperationLogger } from './operationEvents.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function createSeparationApp(env = process.env) {
  const app = express(), config = separationConfig(env)
  const mixConfig = savedMixConfig(env)
  const mixes = createMixService({ config: mixConfig, report: createOperationLogger(), repository: mixConfig.available ? createMixRepository(env) : null,
    storage: mixConfig.available ? createSavedMixStorage(env) : null, allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'] })
  app.use('/api/mixes', express.text({ type: '*/*', limit: '4kb' }), async (req, res) => {
    const request = new Request(`http://${req.headers.host}${req.originalUrl}`, { method: req.method, headers: req.headers,
      ...(['POST', 'PATCH', 'DELETE'].includes(req.method) ? { body: req.body || '' } : {}) })
    const response = await mixes(request)
    res.status(response.status); response.headers.forEach((value, key) => res.setHeader(key, value)); res.send(await response.text())
  })
  const service = createSeparationService({
    config, apiKey: env.MVSEP_API_KEY ?? '',
    report: createOperationLogger(),
    verifyUser: createUserVerifier(env),
    store: createLocalStore(path.join(ROOT, '.separation-state')),
    storage: config.available ? createR2Storage(env) : null,
    provider: config.available ? createMVSEPClient(env.MVSEP_API_KEY) : null,
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  })
  app.use('/api/separation', express.text({ type: '*/*', limit: '4kb' }), async (req, res) => {
    const request = new Request(`http://${req.headers.host}${req.originalUrl}`, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: req.body || '' } : {}) })
    const response = await service(request)
    res.status(response.status)
    response.headers.forEach((value, key) => res.setHeader(key, value))
    res.send(await response.text())
  })
  return app
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createSeparationApp().listen(3001, '127.0.0.1', () => console.log('MVSEP control server running on http://127.0.0.1:3001'))
}
