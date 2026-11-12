import test from 'node:test'
import assert from 'node:assert/strict'
import { runAnalysisProcess } from './analysisProcess.js'

for (const stubborn of [false, true]) {
  test(`cancel stops a real analysis process${stubborn ? ' that ignores the initial signal' : ''}`, async () => {
    const controller = new AbortController()
    let ready, pid
    const started = new Promise(resolve => { ready = resolve })
    const code = `
      ${stubborn ? "process.on('SIGINT', () => {});" : ''}
      console.log('MIX_ROOM_PROGRESS ' + JSON.stringify({percent: 10, message: String(process.pid)}));
      setInterval(() => {}, 1000);
    `
    const task = runAnalysisProcess(process.execPath, ['-e', code], {
      signal: controller.signal, killAfterMs: 100,
      onProgress: (percent, message) => { pid = Number(message); ready() },
    })
    const stopped = assert.rejects(task)
    await started
    controller.abort()
    await stopped
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  })
}

test('an already cancelled job never starts an analysis process', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runAnalysisProcess(process.execPath, ['-e', 'throw Error("must not run")'], { signal: controller.signal }), { name: 'AbortError' })
})

test('cancellation also stops a descendant holding the analysis output stream open', async () => {
  const controller = new AbortController()
  let ready, descendantPid
  const started = new Promise(resolve => { ready = resolve })
  const code = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); console.log('MIX_ROOM_PROGRESS ' + JSON.stringify({percent: 10, message: String(process.pid)})); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
    setInterval(() => {}, 1000);
  `
  const task = runAnalysisProcess(process.execPath, ['-e', code], {
    signal: controller.signal, killAfterMs: 100,
    onProgress: (percent, message) => { descendantPid = Number(message); ready() },
  })
  const stopped = assert.rejects(task, { name: 'AbortError' })
  await started
  controller.abort()
  await stopped
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' })
})
