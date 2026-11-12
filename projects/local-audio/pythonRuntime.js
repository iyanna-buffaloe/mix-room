import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export function getPythonCommand({ root = ROOT, platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.MIX_ROOM_PYTHON) return env.MIX_ROOM_PYTHON
  const local = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python')
  return exists(local) ? local : platform === 'win32' ? 'python' : 'python3'
}
