import { savedMixConfig } from '../../server/mixes/service.js'
import { createMixRepository } from '../../server/mixes/repository.js'
import { createSavedMixStorage } from '../../server/mixes/storage.js'
import { cleanupMixUploads } from '../../server/mixes/cleanup.js'

export default async () => {
  if (!savedMixConfig(process.env).available) return
  const result = await cleanupMixUploads({ repository: createMixRepository(process.env), storage: createSavedMixStorage(process.env), apply: true, maxRows: 50, maxMilliseconds: 20000 })
  console.log('Saved-mix upload cleanup:', JSON.stringify(result))
}
export const config = { schedule: '@hourly' }
