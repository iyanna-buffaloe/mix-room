import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
let failed = false
for (const engine of ['chromium', 'firefox', 'webkit']) {
  console.log(`\nAccount browser checks: ${engine}`)
  const result = spawnSync(process.execPath, ['--test', 'scripts/checkAccountAccess.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, MIX_ROOM_BROWSER_ENGINE: engine },
  })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) failed = true
}
if (failed) process.exitCode = 1
