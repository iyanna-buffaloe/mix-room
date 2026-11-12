import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, stat, lstat, statfs } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fail, validateConfig, LIMIT } from './core.mjs'

export const settings = path.join(os.homedir(), 'Library/Application Support/Mix Room Backups')
export const secretNames = ['image', 'restic', 'database', 'r2Access', 'r2Secret', 'netlify', 'resend']
export function command(executable, args, { env = {}, input, code = 'BACKUP_TOOL_FAILED', timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout })
    const chunks = []; let bytes = 0
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 20_000_000) child.kill(); else chunks.push(chunk) })
    // Never send arbitrary provider/process errors to logs or email: they may contain private values.
    child.stderr.resume()
    child.on('error', () => reject(fail(code)))
    child.on('close', status => status === 0 && bytes <= 20_000_000 ? resolve(Buffer.concat(chunks).toString()) : reject(fail(code)))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export const secret = name => {
  if (!secretNames.includes(name)) throw fail('UNKNOWN_SECRET')
  return command('/usr/bin/security', ['find-generic-password', '-a', os.userInfo().username, '-s', 'mix-room.backup.v1.' + name, '-w'], { code: 'KEYCHAIN_' + name.toUpperCase() }).then(text => text.trimEnd())
}

export async function configuration() {
  const file = path.join(settings, 'config.json'), info = await stat(file)
  if (info.uid !== process.getuid() || info.mode & 0o077) throw fail('CONFIG_PERMISSIONS')
  return validateConfig(JSON.parse(await readFile(file, 'utf8')))
}

export async function saveState(value) {
  await mkdir(settings, { recursive: true, mode: 0o700 })
  const file = path.join(settings, 'status.json'), temporary = file + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, file)
}
export const readState = async () => JSON.parse(await readFile(path.join(settings, 'status.json'), 'utf8').catch(() => '{}'))

async function plist(text) {
  return JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: text, code: 'IMAGE_INFORMATION_FAILED' }))
}

export async function mount(config, initialize = false) {
  // imageinfo can open an interactive password prompt; isencrypted reads the outer header.
  const encrypted = await command('/usr/bin/hdiutil', ['isencrypted', config.image], { code: 'BACKUP_DRIVE_MISSING', timeout: 20000 })
  if (!/^encrypted:\s+YES$/m.test(encrypted)) throw fail('BACKUP_IMAGE_NOT_ENCRYPTED')
  let images = await plist(await command('/usr/bin/hdiutil', ['info', '-plist']))
  const match = all => all.images?.find(image => path.resolve(image['image-path']) === path.resolve(config.image))
  if (!match(images)) {
    await command('/usr/bin/hdiutil', ['attach', config.image, '-stdinpass', '-nobrowse', '-mountpoint', config.volume], { input: await secret('image') + '\0', code: 'BACKUP_IMAGE_LOCKED' })
    images = await plist(await command('/usr/bin/hdiutil', ['info', '-plist']))
  }
  if (!match(images)?.['system-entities']?.some(entity => entity['mount-point'] === config.volume)) throw fail('WRONG_BACKUP_VOLUME')
  const volume = await lstat(config.volume), parent = await stat('/Volumes')
  if (!volume.isDirectory() || volume.isSymbolicLink() || volume.dev === parent.dev) throw fail('BACKUP_DRIVE_MISSING')
  const capacity = await statfs(config.volume)
  if (capacity.blocks * capacity.bsize > LIMIT) throw fail('BACKUP_IMAGE_TOO_LARGE')
  // Dedicated image only: no fallback folder is created on the internal disk.
  const marker = path.join(config.volume, '.mix-room-backups')
  const known = await readFile(marker, 'utf8').catch(() => null)
  if (known === null && initialize) await writeFile(marker, `${config.project}\n${config.siteID}\n`, { mode: 0o600, flag: 'wx' })
  else if (known !== `${config.project}\n${config.siteID}\n`) throw fail('BACKUP_VOLUME_NOT_INITIALIZED')
}

export async function email(config, subject, text) {
  const response = await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { Authorization: 'Bearer ' + await secret('resend'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.alertFrom, to: [config.alertTo], subject, text }), signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw fail('BACKUP_ALERT_FAILED')
}

export async function alert(config, state, code, force = false) {
  const key = code + ':' + new Date().toISOString().slice(0, 10)
  if (!force && state.lastAlert === key) return
  await email(config, 'Mix Room backup needs attention', `The Mac backup needs attention.\nStatus: ${code}\nLast successful copy: ${state.lastSuccess || 'none'}\nOpen the backup setup guide and run npm run backup:status on the Mac.\nNo user data or credentials are included in this notice.`)
  state.lastAlert = key
}
