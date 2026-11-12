import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPythonCommand } from './pythonRuntime.js'
import { runAnalysisProcess } from './analysisProcess.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
try {
  await runAnalysisProcess(getPythonCommand(), ['-X', 'faulthandler', '-u', ...process.argv.slice(2)], {
    cwd: path.resolve(root), signal: controller.signal,
  })
} catch (error) {
  console.error(controller.signal.aborted ? 'Cancelled.' : error.message)
  process.exitCode = controller.signal.aborted ? 130 : 1
}
