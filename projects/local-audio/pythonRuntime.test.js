import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { getPythonCommand } from './pythonRuntime.js'

test('server and scripts prefer the project virtual environment on either platform', () => {
  for (const platform of ['win32', 'darwin']) {
    const root = path.resolve('fixture project')
    const expected = path.join(root, '.venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
    assert.equal(getPythonCommand({ root, platform, env: {}, exists: candidate => candidate === expected }), expected)
  }
})

test('an explicit Python path takes precedence, including paths containing spaces', () => {
  assert.equal(getPythonCommand({ platform: 'win32', env: { MIX_ROOM_PYTHON: 'C:\\Python Tools\\python.exe' }, exists: () => true }), 'C:\\Python Tools\\python.exe')
})

test('without a project environment use the platform Python executable', () => {
  assert.equal(getPythonCommand({ platform: 'win32', env: {}, exists: () => false }), 'python')
  assert.equal(getPythonCommand({ platform: 'linux', env: {}, exists: () => false }), 'python3')
})
