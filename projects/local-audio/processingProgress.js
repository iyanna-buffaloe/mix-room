const PREFIX = 'MIX_ROOM_PROGRESS '

export function createProgressParser(onProgress) {
  let pending = ''
  return chunk => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop().slice(-4096)
    for (const line of lines) {
      if (!line.startsWith(PREFIX)) continue
      try {
        const progress = JSON.parse(line.slice(PREFIX.length))
        if (Number.isFinite(progress.percent) && typeof progress.message === 'string') {
          onProgress(progress.percent, progress.message)
        }
      } catch {
        // Other terminal output must not interrupt processing.
      }
    }
  }
}
