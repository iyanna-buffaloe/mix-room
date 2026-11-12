import { createMixService, savedMixConfig } from '../../server/mixes/service.js'
import { createMixRepository } from '../../server/mixes/repository.js'
import { createSavedMixStorage } from '../../server/mixes/storage.js'
import { createOperationLogger } from '../../server/operationEvents.js'

let service
export default request => {
  if (!service) {
    const config = savedMixConfig(process.env)
    service = createMixService({ config, report: createOperationLogger(), repository: config.available ? createMixRepository(process.env) : null,
      storage: config.available ? createSavedMixStorage(process.env) : null })
  }
  return service(request)
}
export const config = {
  path: ['/api/mixes', '/api/mixes/config', '/api/mixes/uploads', '/api/mixes/commit', '/api/mixes/:id'],
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: 'ip' },
}
