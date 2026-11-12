import { mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { capture, verifyCapture, roomFor, treeBytes, oldestRemovable, fail, TAG, WARNING } from './core.mjs'
import { command, configuration, settings, mount, secret, secretNames, readState, saveState, alert, email } from './macos.mjs'
import { sources } from './sources.mjs'

const operation = process.argv[2] || 'status'
let config, state, locked = false, phase = 'configuration'
const lock = path.join(settings, 'running.lock')
const emit = value => console.log(JSON.stringify(value))
async function acquire() {
  try { await mkdir(lock, { mode: 0o700 }); locked = true }
  catch {
    const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8').catch(() => '{}'))
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 2) throw fail('BACKUP_LOCK_NEEDS_REVIEW')
    try { process.kill(owner.pid, 0); throw fail('BACKUP_ALREADY_RUNNING') }
    catch (error) {
      if (error.code !== 'ESRCH') throw error
      await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 }); locked = true
    }
  }
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }), { mode: 0o600 })
}

async function cleanStage(folder, allowed) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name), info = await lstat(file)
    if (info.isSymbolicLink()) throw fail('SYMLINK_IN_BACKUP')
    if (info.isDirectory()) await cleanStage(file, allowed)
    else if (!allowed.has(file)) await rm(file)
  }
}

export function launchAgent(node, script) {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>click.mixroom.backup</string><key>ProgramArguments</key><array><string>${escape(node)}</string><string>${escape(script)}</string><string>watch</string></array><key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/><key>Nice</key><integer>10</integer></dict></plist>\n`
}

async function main() {
  if (operation === 'prepare') {
    await mkdir(settings, { recursive: true, mode: 0o700 })
    await writeFile(path.join(settings, 'config.json'), await readFile(new URL('./config.example.json', import.meta.url)), { mode: 0o600, flag: 'wx' })
    emit({ status: 'fill_private_configuration', path: path.join(settings, 'config.json') }); return
  }
  if (operation === 'secret') {
    const name = process.argv[3]
    if (!secretNames.includes(name) || !process.stdin.isTTY) throw fail('USE_PRIVATE_TERMINAL_SECRET_PROMPT')
    // No secret is supplied in a shell argument or written to the repository.
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['add-generic-password', '-U', '-a', os.userInfo().username, '-s', 'mix-room.backup.v1.' + name, '-w'], { stdio: 'inherit' })
      child.on('error', () => reject(fail('KEYCHAIN_SAVE_FAILED')))
      child.on('close', code => code === 0 ? resolve() : reject(fail('KEYCHAIN_SAVE_FAILED')))
    }); return
  }
  state = await readState()
  if (operation === 'status') { emit(state.lastSuccess ? state : { status: 'not_configured', ...state }); return }
  config = await configuration()
  if (operation === 'test-alert') {
    await email(config, 'Mix Room backup test', 'This is the requested backup-alert test. No account data is included.')
    state.alertTested = new Date().toISOString(); await saveState(state)
    emit({ status: 'alert_sent_check_your_inbox' }); return
  }
  if (operation === 'install') {
    if (!state.lastSuccess || !state.lastFileVerification || !state.alertTested) throw fail('FIRST_BACKUP_AND_ALERT_TEST_REQUIRED')
    const file = path.join(os.homedir(), 'Library/LaunchAgents/click.mixroom.backup.plist')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, launchAgent(process.execPath, fileURLToPath(import.meta.url)), { mode: 0o600, flag: 'wx' })
    await command('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { code: 'SCHEDULE_INSTALL_FAILED' })
    emit({ status: 'daily_backup_and_hourly_watch_installed', loginRequired: true }); return
  }
  if (!['init', 'run', 'watch', 'verify'].includes(operation)) throw fail('UNKNOWN_BACKUP_COMMAND')
  if (operation === 'watch' && Date.now() - Date.parse(state.lastSuccess || 0) < 23 * 3600000 && !state.error) {
    emit({ status: 'recent_backup_ok' }); return
  }
  await acquire()
  phase = 'encrypted_volume'; await mount(config, operation === 'init')
  const data = path.join(config.volume, 'data'), repository = path.join(data, 'restic')
  const folder = path.join(data, 'capture'), verification = path.join(data, 'verification')
  await mkdir(data, { recursive: true, mode: 0o700 })
  if ((await lstat(data)).isSymbolicLink()) throw fail('SYMLINK_IN_BACKUP')
  await treeBytes(data)
  const resticEnv = { RESTIC_PASSWORD: await secret('restic'), RESTIC_CACHE_DIR: path.join(data, 'cache'), TMPDIR: path.join(data, 'tmp') }
  await mkdir(resticEnv.TMPDIR, { recursive: true, mode: 0o700 })
  const restic = args => command(config.restic, ['--repo', repository, ...args], { env: resticEnv, code: 'RESTIC_FAILED', timeout: 1800000 })
  if (operation === 'init') {
    try { await lstat(repository); throw fail('REPOSITORY_ALREADY_EXISTS') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await restic(['init']); emit({ status: 'encrypted_repository_initialized' }); return
  }
  const snapshots = async () => JSON.parse(await restic(['snapshots', '--json', '--tag', TAG]))
  const removeOld = async id => {
    await restic(['forget', id]); await restic(['prune', '--max-repack-size', '0']); await restic(['check'])
  }
  const reserve = async bytes => {
    try { await roomFor(config.volume, bytes); return } catch (e) { if (e.code !== 'BACKUP_SPACE_LIMIT') throw e }
    for (const old of oldestRemovable(await snapshots())) {
      await removeOld(old.id)
      try { await roomFor(config.volume, bytes); return } catch (e) { if (e.code !== 'BACKUP_SPACE_LIMIT') throw e }
    }
    throw fail('BACKUP_SPACE_LIMIT')
  }
  const verify = async id => {
    await rm(verification, { recursive: true, force: true })
    try {
      await restic(['restore', id + ':' + folder, '--target', verification, '--verify'])
      const manifest = await verifyCapture(verification)
      await command(config.pgRestore, ['--list', path.join(verification, 'database.dump')], { code: 'DATABASE_ARCHIVE_INVALID' })
      return manifest
    } finally { await rm(verification, { recursive: true, force: true }) }
  }
  if (operation === 'verify') {
    const good = (await snapshots()).filter(s => s.tags?.includes('file-verified')).sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0]
    if (!good) throw fail('NO_VERIFIED_BACKUP')
    await roomFor(config.volume, good.summary?.total_bytes_processed || 0)
    phase = 'restore_verification'; await verify(good.id)
    state.lastFileVerification = new Date().toISOString(); await saveState(state)
    emit({ status: 'files_restored_and_verified', databaseRestoreStillRequiresIsolatedTest: true }); return
  }
  phase = 'capture'
  await rm(verification, { recursive: true, force: true })
  const privateValues = Object.fromEntries(await Promise.all(['database', 'r2Access', 'r2Secret', 'netlify'].map(async key => [key, await secret(key)])))
  const remote = sources(config, privateValues, command)
  const previous = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8').catch(() => 'null'))
  const manifest = await capture({ folder, ...remote, reserve, previous })
  await cleanStage(folder, new Set([path.join(folder, 'manifest.json'), ...manifest.files.map(f => path.join(folder, f.path))]))
  await verifyCapture(folder)
  await reserve(manifest.files.reduce((sum, file) => sum + file.bytes, 0) * 2 + 64_000_000)
  const runTag = 'run-' + randomUUID()
  phase = 'incremental_backup'
  const result = await restic(['backup', folder, '--json', '--host', 'mix-room-backup', '--tag', TAG, '--tag', 'candidate', '--tag', runTag])
  const summary = result.trim().split('\n').map(line => JSON.parse(line)).find(value => value.message_type === 'summary')
  if (!/^[a-f0-9]{8,64}$/.test(summary?.snapshot_id || '')) throw fail('BACKUP_SNAPSHOT_MISSING')
  phase = 'restore_verification'; await verify(summary.snapshot_id)
  await restic(['tag', '--add', 'file-verified', '--remove', 'candidate', summary.snapshot_id])
  const saved = (await snapshots()).find(s => s.tags?.includes(runTag) && s.tags.includes('file-verified'))
  if (!saved) throw fail('BACKUP_NOT_VERIFIED')
  state.lastSuccess = new Date().toISOString(); state.lastFileVerification = state.lastSuccess
  state.snapshot = saved.id; state.error = null; state.phase = 'complete'
  await saveState(state)
  phase = 'retention'
  const cutoff = Date.now() - 30 * 86400000
  for (const old of oldestRemovable(await snapshots())) if (Date.parse(old.time) < cutoff) await removeOld(old.id)
  const used = await treeBytes(data)
  if (used >= WARNING) { await alert(config, state, 'STORAGE_ABOVE_40_GB'); await saveState(state) }
  emit({ status: 'backup_and_file_restore_verified', bytesUsed: used, files: manifest.files.length,
    databaseRestoreStillRequiresIsolatedTest: true })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  try { await main() }
  catch (error) {
    const code = /^[A-Z_0-9]{1,64}$/.test(error.code || '') ? error.code : 'BACKUP_FAILED'
    emit({ status: 'needs_attention', code, phase })
    if (operation !== 'status' && code !== 'BACKUP_ALREADY_RUNNING') {
      state ||= await readState()
      state.error = code; state.phase = phase
      if (config) await alert(config, state, code).catch(() => { state.alertDeliveryFailed = true })
      await saveState(state)
    }
    process.exitCode = 1
  } finally { if (locked) await rm(lock, { recursive: true, force: true }) }
}
