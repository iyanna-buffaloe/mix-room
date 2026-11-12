import { spawn } from 'node:child_process'
import { createProgressParser } from './processingProgress.js'

export async function runAnalysisProcess(command, args, { cwd, signal, onProgress, killAfterMs = 3000 } = {}) {
  signal?.throwIfAborted()
  const child = spawn(command, args, {
    cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let closed = false
  let forceStop
  let spawnError
  child.once('error', error => { spawnError = error })
  let stderr = ''
  const exited = new Promise(resolve => child.once('close', (code, exitSignal) => {
    closed = true
    resolve({ code, exitSignal })
  }))
  const kill = name => {
    if (closed || !child.pid) return
    try {
      if (process.platform === 'win32') {
        // Windows signals terminate only the parent; stop FFmpeg descendants too.
        const stopper = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        stopper.once('error', () => { if (!closed) child.kill('SIGKILL') })
        stopper.once('exit', code => { if (code !== 0 && !closed) child.kill('SIGKILL') })
      } else process.kill(-child.pid, name) // Include FFmpeg or other descendants.
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const cancel = () => {
    kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT')
    // GPU work may delay Python's signal handler; force-stop if it doesn't exit.
    forceStop = setTimeout(() => kill('SIGKILL'), killAfterMs)
    forceStop.unref()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const parse = createProgressParser(onProgress ?? (() => {}))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', data => { process.stdout.write(data); parse(data) })
  child.stderr.on('data', data => {
    process.stderr.write(data)
    stderr = (stderr + data).slice(-10000)
  })
  try {
    const { code, exitSignal } = await exited
    signal?.throwIfAborted()
    if (spawnError) throw spawnError
    if (code !== 0) throw new Error(`Analysis exited with ${exitSignal ?? code}${stderr ? `: ${stderr}` : ''}`)
  } finally {
    // Never release the upload slot while the Python process is still alive.
    await exited
    clearTimeout(forceStop)
    signal?.removeEventListener('abort', cancel)
  }
}
