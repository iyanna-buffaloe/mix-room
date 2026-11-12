import { getStore } from '@netlify/blobs'
import { createMVSEPClient } from '../../server/separation/mvsep.js'
import { createR2Storage } from '../../server/separation/storage.js'
import { createSeparationService, separationConfig } from '../../server/separation/service.js'
import { createUserVerifier } from '../../server/auth/verifyUser.js'
import { createOperationLogger } from '../../server/operationEvents.js'

export default async request => {
  const env = process.env, config = separationConfig(env)
  // Configuration can be checked before credentials exist. Nothing sensitive
  // is returned, and missing configuration never submits a paid request.
  const service = createSeparationService({
    config, apiKey: env.MVSEP_API_KEY ?? '',
    report: createOperationLogger(),
    store: getStore({ name: 'mix-room-separation', consistency: 'strong' }),
    verifyUser: createUserVerifier(env),
    storage: config.available ? createR2Storage(env) : null,
    provider: config.available ? createMVSEPClient(env.MVSEP_API_KEY) : null,
    webhookBase: new URL(request.url).origin,
  })
  return service(request)
}

export const config = {
  path: ['/api/separation/config', '/api/separation/credits', '/api/separation/stems/:action', '/api/separation/results', '/api/separation/jobs', '/api/separation/jobs/:id', '/api/separation/jobs/:id/:action'],
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: 'ip' },
}
