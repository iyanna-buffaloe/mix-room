import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgressParser } from './processingProgress.js'

test('progress records survive split stdout chunks and multiple lines', () => {
  const updates = []
  const parse = createProgressParser((percent, message) => updates.push({ percent, message }))
  parse('Loading model\nMIX_ROOM_PRO')
  parse('GRESS {"percent":25,"message":"Separating instruments"}\nMIX_ROOM_PROGRESS {"percent":')
  parse('55,"message":"Drums ready"}\r\n')
  assert.deepEqual(updates, [
    { percent: 25, message: 'Separating instruments' },
    { percent: 55, message: 'Drums ready' },
  ])
})

test('logs and malformed progress do not abort processing', () => {
  const updates = []
  const parse = createProgressParser((percent, message) => updates.push(percent))
  parse('MIX_ROOM_PROGRESS not-json\nMIX_ROOM_PROGRESS {"percent":"25","message":"Invalid"}\n')
  parse('MIX_ROOM_PROGRESS {"percent":null,"message":"Invalid"}\nNormal output\n')
  parse('MIX_ROOM_PROGRESS {"percent":99,"message":"Room ready"}\n')
  assert.deepEqual(updates, [99])
})
