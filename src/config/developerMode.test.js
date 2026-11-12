import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeveloperMode } from './developerMode.js'

test('production defaults to public mode and explicit query flags override local development', () => {
  assert.equal(isDeveloperMode(''), false)
  assert.equal(isDeveloperMode('?dev=1'), true)
  assert.equal(isDeveloperMode('?dev=0', true), false)
  assert.equal(isDeveloperMode('', true), true)
  assert.equal(isDeveloperMode('?dev=unexpected'), false)
  assert.equal(isDeveloperMode('?song=test&dev=1'), true)
})
