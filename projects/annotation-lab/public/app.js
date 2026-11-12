const $ = selector => document.querySelector(selector)
const cards = new Map()
let profiles = {}
let pendingFiles = []
let ready = false
let uploading = false
let activeAudio
const labels = { genuine: 'Genuine', bleed_absent: 'Bleed / absent', uncertain: 'Uncertain' }

async function api(url, options) {
  const response = await fetch(url, options)
  const body = await response.json()
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return body
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function button(text, action, title) {
  const node = element('button', text)
  node.type = 'button'
  node.addEventListener('click', action)
  if (title) { node.title = title; node.setAttribute('aria-label', title) }
  return node
}

function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = element('a')
  link.href = url; link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function validIntervals(intervals, duration) {
  return intervals.every(({ start, end, label }) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration + .001 && Object.hasOwn(labels, label))
}

function timeText(time) {
  const seconds = Math.max(0, time)
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}

class SongCard {
  constructor(job) {
    this.job = job
    this.node = $('#song-template').content.firstElementChild.cloneNode(true)
    this.node.dataset.id = job.id
    this.find = selector => this.node.querySelector(selector)
    this.audio = this.find('audio')
    this.canvas = this.find('.waveform')
    this.waveforms = new Map()
    this.drafts = new Map()
    this.versions = new Map()
    this.dirty = new Set()
    this.blocked = new Set()
    this.saveTimers = new Map()
    this.pendingSaves = new Map()
    this.sourceGeneration = 0
    this.selection = null
    this.rangeEnd = null
    this.frame = 0
    this.find('h3').textContent = job.filename
    this.find('.cancel-job').onclick = () => this.action('cancel')
    this.find('.retry-job').onclick = () => this.action('retry')
    $('#songs').append(this.node)
    this.update(job)
  }

  async action(action) {
    try { this.update(await api(`/api/jobs/${this.job.id}/${action}`, { method: 'POST' })) }
    catch (error) { this.find('.job-message').textContent = error.message }
  }

  update(job) {
    this.job = job
    this.find('.song-profile').textContent = `${profiles[job.profile]?.label || job.profile}${job.isolated ? ' · isolated input' : ' · full mix'}`
    this.find('.job-status').textContent = job.status === 'done' ? 'Ready' : job.status
    this.find('.job-message').textContent = job.message
    this.find('.job-progress progress').value = job.percent
    this.find('.job-error').textContent = job.error || ''
    this.find('.job-error').hidden = !job.error
    this.find('.cancel-job').hidden = !['queued', 'processing'].includes(job.status)
    this.find('.retry-job').hidden = !['failed', 'cancelled', 'interrupted'].includes(job.status)
    this.find('.job-progress').hidden = job.status === 'done'
    this.find('.song-workspace').hidden = job.status !== 'done'
    if (job.status === 'done' && !this.initialized) this.initialize()
  }

  backupKey(key) { return `music-room-lab:${this.job.id}:${key}` }

  initialize() {
    this.initialized = true
    const bank = this.find('.stem-bank')
    const context = this.find('.context-bank')
    for (const track of this.job.tracks) {
      const node = button(track.label, () => this.choose(track.key))
      node.dataset.track = track.key
      node.setAttribute('aria-pressed', 'false')
      ;(track.annotatable ? bank : context).append(node)
      if (track.annotatable) {
        const saved = this.job.annotations[track.key] || { version: 0, intervals: [] }
        this.drafts.set(track.key, structuredClone(saved.intervals))
        this.versions.set(track.key, saved.version)
        try {
          const backup = JSON.parse(localStorage.getItem(this.backupKey(track.key)))
          if (backup && JSON.stringify(backup.intervals) !== JSON.stringify(saved.intervals)) {
            this.drafts.set(track.key, backup.intervals)
            this.dirty.add(track.key)
            if (backup.version !== saved.version) this.blocked.add(track.key)
          } else localStorage.removeItem(this.backupKey(track.key))
        } catch { /* A malformed browser backup must not hide saved disk labels. */ }
      }
    }
    this.audio.addEventListener('play', () => {
      if (activeAudio && activeAudio !== this.audio) activeAudio.pause()
      activeAudio = this.audio
      this.animate()
    })
    this.audio.addEventListener('pause', () => { cancelAnimationFrame(this.frame); this.draw() })
    this.audio.addEventListener('timeupdate', () => {
      if (this.rangeEnd !== null && this.audio.currentTime >= this.rangeEnd) {
        this.audio.pause(); this.audio.currentTime = this.rangeEnd; this.rangeEnd = null
      }
      this.draw()
    })
    this.audio.addEventListener('seeking', () => this.draw())
    this.audio.addEventListener('error', () => { this.find('.audio-error').textContent = 'Could not play this WAV. Try Chrome, or download the stem to listen locally.' })
    this.find('.zoom').onchange = () => this.draw()
    this.find('.fit-waveform').onchange = () => this.draw()
    this.find('.clear-selection').onclick = () => { this.selection = null; this.rangeEnd = null; this.draw() }
    this.find('.mark-start').onclick = () => this.setDraftTime('start', this.audio.currentTime)
    this.find('.mark-end').onclick = () => this.setDraftTime('end', this.audio.currentTime)
    this.find('.draft-start').oninput = this.find('.draft-end').oninput = () => this.readSelection()
    this.find('.play-selection').onclick = () => {
      this.readSelection()
      if (!this.selection || this.selection.end <= this.selection.start) return this.showIntervalError('Select a passage with an end after its start.')
      this.playRange(this.selection.start, this.selection.end)
    }
    this.find('.interval-form').onsubmit = event => { event.preventDefault(); this.addInterval() }
    this.find('.retry-save').onclick = () => this.flush(this.targetKey)
    this.find('.export-draft').onclick = () => downloadJson(`${this.job.filename}-unsaved-labels.json`, { songId: this.job.id, filename: this.job.filename, annotations: Object.fromEntries(this.drafts), timeUnit: 'seconds' })
    this.bindWaveform()
    this.resize = new ResizeObserver(() => this.draw())
    this.resize.observe(this.canvas)
    const first = this.job.tracks.find(track => track.annotatable)
    this.choose(first.key)
    for (const key of this.dirty) if (!this.blocked.has(key)) this.flush(key)
  }

  async choose(key) {
    const track = this.job.tracks.find(candidate => candidate.key === key)
    if (!track) return
    if (track.annotatable && key !== this.targetKey) {
      this.targetKey = key
      this.selection = null
      this.find('.draft-start').value = 0
      this.find('.draft-end').value = Math.min(10, track.duration).toFixed(2)
      this.find('.draft-start').max = this.find('.draft-end').max = Math.ceil(track.duration * 1000) / 1000
      this.showIntervalError('')
      this.renderTable()
      this.refreshSaveStatus()
      const link = this.find('.download-stem')
      link.href = track.url
      link.download = `${this.job.filename.replace(/\.[^.]+$/, '')}__${key}.wav`
    }
    for (const node of this.node.querySelectorAll('[data-track]')) node.setAttribute('aria-pressed', String(node.dataset.track === key))
    const wasPlaying = !this.audio.paused
    const playhead = this.audio.currentTime || 0
    this.audio.pause()
    this.rangeEnd = null
    this.playbackTrack = track
    this.find('.listening-to').textContent = `Listening: ${track.label}`
    this.find('.annotation-title').textContent = `Labels: ${this.job.tracks.find(candidate => candidate.key === this.targetKey).label}`
    this.find('.audio-stats').textContent = `RMS ${track.rmsDb === null ? '−∞' : track.rmsDb.toFixed(1)} dBFS`
    this.find('.audio-error').textContent = ''
    this.find('.waveform-message').textContent = 'Loading waveform…'
    this.waveform = null
    const generation = ++this.sourceGeneration
    this.audio.onloadedmetadata = () => {
      if (generation !== this.sourceGeneration) return
      this.audio.currentTime = Math.min(playhead, Math.max(0, this.audio.duration - .001))
      this.draw()
      if (wasPlaying) this.audio.play().catch(error => { this.find('.audio-error').textContent = error.message })
    }
    this.audio.src = track.url
    this.audio.load()
    this.draw()
    try {
      let waveform = this.waveforms.get(key)
      if (!waveform) {
        waveform = await api(track.waveformUrl)
        this.waveforms.set(key, waveform)
      }
      if (generation !== this.sourceGeneration) return
      this.waveform = waveform
      this.find('.waveform-message').textContent = ''
      this.draw()
    } catch (error) {
      if (generation === this.sourceGeneration) this.find('.waveform-message').textContent = `Waveform unavailable: ${error.message}`
    }
  }

  setDraftTime(which, value) {
    this.find(`.draft-${which}`).value = value.toFixed(3)
    this.readSelection()
  }

  readSelection() {
    const start = this.find('.draft-start').valueAsNumber
    const end = this.find('.draft-end').valueAsNumber
    this.selection = Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
    this.draw()
  }

  showIntervalError(message) { this.find('.interval-error').textContent = message }

  addInterval() {
    const interval = { start: this.find('.draft-start').valueAsNumber, end: this.find('.draft-end').valueAsNumber, label: this.find('.draft-label').value }
    const duration = this.job.tracks.find(track => track.key === this.targetKey).duration
    if (!validIntervals([interval], duration)) return this.showIntervalError('Use times within the song, with the end after the start.')
    if (this.drafts.get(this.targetKey).length >= 2000) return this.showIntervalError('This stem already has 2,000 intervals.')
    this.drafts.get(this.targetKey).push(interval)
    this.showIntervalError('')
    this.renderTable()
    this.changed(this.targetKey)
  }

  renderTable() {
    const body = this.find('tbody')
    body.replaceChildren()
    const key = this.targetKey
    const intervals = this.drafts.get(key)
    this.find('.no-labels').hidden = intervals.length > 0
    const duration = this.job.tracks.find(track => track.key === key).duration
    for (const [index, interval] of intervals.entries()) {
      const row = element('tr')
      for (const field of ['start', 'end']) {
        const cell = element('td')
        const input = element('input')
        input.type = 'number'; input.step = '.001'; input.min = 0; input.max = Math.ceil(duration * 1000) / 1000; input.value = interval[field]
        input.setAttribute('aria-label', `${field === 'start' ? 'Start' : 'End'} time for interval ${index + 1}`)
        input.onchange = () => { interval[field] = input.valueAsNumber; this.changed(key) }
        cell.append(input); row.append(cell)
      }
      const labelCell = element('td')
      const select = element('select')
      select.setAttribute('aria-label', `Label for interval ${index + 1}`)
      for (const [value, text] of Object.entries(labels)) { const option = element('option', text); option.value = value; select.append(option) }
      select.value = interval.label
      select.onchange = () => { interval.label = select.value; this.changed(key) }
      labelCell.append(select); row.append(labelCell)
      const actionCell = element('td')
      const actions = element('div', undefined, 'row-actions')
      actions.append(button('▶', () => this.playRange(interval.start, interval.end), `Play interval ${index + 1}`), button('×', () => {
        intervals.splice(index, 1); this.renderTable(); this.changed(key)
      }, `Delete interval ${index + 1}`))
      actionCell.append(actions); row.append(actionCell); body.append(row)
    }
  }

  changed(key) {
    this.dirty.add(key)
    this.backup(key)
    clearTimeout(this.saveTimers.get(key))
    this.saveTimers.set(key, setTimeout(() => this.flush(key), 350))
    if (key === this.targetKey) this.refreshSaveStatus()
  }

  backup(key) {
    try { localStorage.setItem(this.backupKey(key), JSON.stringify({ version: this.versions.get(key), intervals: this.drafts.get(key) })) }
    catch { this.find('.save-status').textContent = 'Browser draft backup unavailable; keep this tab open until saved.' }
  }

  refreshSaveStatus(message, error = false) {
    const dirty = this.dirty.has(this.targetKey)
    const blocked = this.blocked.has(this.targetKey)
    const status = this.find('.save-status')
    status.textContent = message || (blocked ? 'Draft conflict — export before reloading' : dirty ? 'Unsaved changes…' : 'Saved locally')
    status.dataset.error = String(error || blocked)
    this.find('.retry-save').hidden = !dirty
    this.find('.export-draft').hidden = !dirty
  }

  async flush(key) {
    clearTimeout(this.saveTimers.get(key))
    if (this.pendingSaves.has(key)) return this.pendingSaves.get(key)
    if (!this.dirty.has(key) || this.blocked.has(key)) return
    const intervals = structuredClone(this.drafts.get(key))
    const duration = this.job.tracks.find(track => track.key === key).duration
    if (!validIntervals(intervals, duration)) {
      if (this.targetKey === key) this.refreshSaveStatus('Fix invalid times before saving', true)
      return
    }
    if (this.targetKey === key) this.refreshSaveStatus('Saving…')
    const task = (async () => {
      try {
        const saved = await api(`/api/jobs/${this.job.id}/annotations/${key}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: this.versions.get(key), intervals }),
        })
        this.versions.set(key, saved.version)
        if (JSON.stringify(this.drafts.get(key)) === JSON.stringify(intervals)) {
          this.dirty.delete(key)
          try { localStorage.removeItem(this.backupKey(key)) } catch { /* Disk copy is already saved. */ }
        } else {
          this.backup(key)
          this.saveTimers.set(key, setTimeout(() => this.flush(key), 350))
        }
        if (this.targetKey === key) this.refreshSaveStatus()
      } catch (error) {
        if (error.status === 409) this.blocked.add(key)
        if (this.targetKey === key) this.refreshSaveStatus(error.message, true)
      } finally { this.pendingSaves.delete(key) }
    })()
    this.pendingSaves.set(key, task)
    return task
  }

  playRange(start, end) {
    if (!validIntervals([{ start, end, label: 'genuine' }], this.playbackTrack.duration)) return this.showIntervalError('Fix this interval’s times before playing it.')
    this.selection = { start, end }
    this.audio.currentTime = start
    this.rangeEnd = end
    this.audio.play().catch(error => { this.find('.audio-error').textContent = error.message })
    this.draw()
  }

  view() {
    const duration = this.playbackTrack?.duration || 1
    const span = Number(this.find('.zoom').value)
    const start = span ? Math.floor(this.audio.currentTime / span) * span : 0
    return { start, end: span ? Math.min(duration, start + span) : duration }
  }

  bindWaveform() {
    let drag = null
    const point = (event, view) => {
      const bounds = this.canvas.getBoundingClientRect()
      return view.start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (view.end - view.start)
    }
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.waveform) return
      this.audio.pause()
      this.canvas.setPointerCapture(event.pointerId)
      const view = this.view()
      drag = { view, start: point(event, view), x: event.clientX }
      this.selection = null
    })
    this.canvas.addEventListener('pointermove', event => {
      if (!drag) return
      const time = point(event, drag.view)
      this.selection = { start: Math.min(time, drag.start), end: Math.max(time, drag.start) }
      this.draw(drag.view)
    })
    this.canvas.addEventListener('pointerup', event => {
      if (!drag) return
      if (Math.abs(event.clientX - drag.x) < 5) {
        this.audio.currentTime = point(event, drag.view); this.rangeEnd = null; this.selection = null
      } else {
        const time = point(event, drag.view)
        this.find('.draft-start').value = Math.min(time, drag.start).toFixed(3)
        this.find('.draft-end').value = Math.max(time, drag.start).toFixed(3)
        this.readSelection()
      }
      drag = null; this.draw()
    })
    this.canvas.addEventListener('pointercancel', () => { drag = null })
    this.canvas.tabIndex = 0
    this.canvas.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        this.audio.currentTime = Math.max(0, Math.min(this.playbackTrack.duration, this.audio.currentTime + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 30 : 5)))
        this.rangeEnd = null
      }
    })
  }

  animate() {
    cancelAnimationFrame(this.frame)
    const tick = () => {
      if (this.rangeEnd !== null && this.audio.currentTime >= this.rangeEnd) {
        this.audio.pause(); this.audio.currentTime = this.rangeEnd; this.rangeEnd = null
      }
      this.draw()
      if (!this.audio.paused) this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  draw(lockedView) {
    if (!this.playbackTrack) return
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (!width || !height) return
    const dpr = devicePixelRatio || 1
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr)
    }
    const ctx = this.canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const colors = getComputedStyle(document.documentElement)
    const color = name => colors.getPropertyValue(`--${name}`).trim()
    ctx.fillStyle = color('wave-background'); ctx.fillRect(0, 0, width, height)
    const view = lockedView || this.view()
    const xAt = time => (time - view.start) / Math.max(.001, view.end - view.start) * width
    const channels = this.waveform?.peaks || [[], []]
    const fit = this.find('.fit-waveform').checked
    // Both stereo channels share one scale; quiet bleed is never amplified in playback.
    const scale = fit ? Math.max(this.playbackTrack.peak, 1e-8) : 1
    const area = height - 24
    const channelHeight = area / channels.length
    for (const [index, peaks] of channels.entries()) {
      const middle = channelHeight * (index + .5)
      ctx.strokeStyle = color('wave-grid'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, middle); ctx.lineTo(width, middle); ctx.stroke()
      ctx.fillStyle = color('wave')
      ctx.font = '10px monospace'; ctx.fillText(channels.length === 2 ? (index === 0 ? 'L' : 'R') : 'M', 6, middle - channelHeight / 2 + 12)
      if (!this.waveform) continue
      for (let x = 0; x < width; x += 3) {
        const from = Math.floor((view.start + x / width * (view.end - view.start)) / this.waveform.secondsPerBin)
        const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil((view.start + (x + 3) / width * (view.end - view.start)) / this.waveform.secondsPerBin)))
        let peak = 0
        for (let bin = from; bin < to; bin++) peak = Math.max(peak, peaks[bin])
        const amplitude = Math.min(1, peak / scale) * (channelHeight / 2 - 5)
        ctx.fillStyle = x < xAt(this.audio.currentTime) ? color('wave-played') : color('wave')
        ctx.fillRect(x, middle - amplitude, 2, Math.max(.5, amplitude * 2))
      }
    }
    if (this.selection) {
      const start = Math.max(0, Math.min(width, xAt(this.selection.start)))
      const end = Math.max(0, Math.min(width, xAt(this.selection.end)))
      ctx.fillStyle = color('selection'); ctx.fillRect(start, 0, end - start, area)
      ctx.strokeStyle = color('selection-edge'); ctx.strokeRect(start, 0, end - start, area)
    }
    const playhead = xAt(this.audio.currentTime)
    ctx.fillStyle = color('playhead'); ctx.fillRect(playhead, 0, 1.5, area)
    ctx.fillStyle = color('wave'); ctx.font = '10px monospace'
    ctx.fillText(timeText(view.start), 6, height - 7)
    ctx.textAlign = 'right'; ctx.fillText(timeText(view.end), width - 6, height - 7); ctx.textAlign = 'left'
  }
}

function renderPending() {
  const list = $('#pending-files')
  list.replaceChildren()
  for (const [index, file] of pendingFiles.entries()) {
    const row = element('li')
    row.append(element('span', `${file.name} · ${(file.size / 1024 ** 2).toFixed(1)} MB`), button('×', () => { pendingFiles.splice(index, 1); renderPending() }, `Remove ${file.name}`))
    list.append(row)
  }
  $('#upload').disabled = !ready || !pendingFiles.length || uploading
  $('#files').disabled = $('#profile').disabled = $('#isolated').disabled = uploading
  for (const node of list.querySelectorAll('button')) node.disabled = uploading
}

function profileChanged() {
  const profile = profiles[$('#profile').value]
  $('#profile-description').textContent = profile?.description || ''
  $('#isolated-field').hidden = !profile?.isolatedLabel
  $('#isolated-label').textContent = profile?.isolatedLabel || ''
  $('#isolated').checked = false
}

$('#profile').onchange = profileChanged
$('#files').onchange = event => {
  for (const file of event.target.files) {
    if (!pendingFiles.some(candidate => candidate.name === file.name && candidate.size === file.size && candidate.lastModified === file.lastModified)) pendingFiles.push(file)
  }
  if (pendingFiles.length > 30) { pendingFiles = pendingFiles.slice(0, 30); $('#batch-message').textContent = 'Use at most 30 songs in one batch.' }
  event.target.value = ''
  renderPending()
}

$('#upload').onclick = () => {
  if (uploading || !pendingFiles.length) return
  uploading = true
  renderPending()
  const form = new FormData()
  for (const file of pendingFiles) form.append('songs', file, file.name)
  const xhr = new XMLHttpRequest()
  const params = new URLSearchParams({ profile: $('#profile').value, isolated: String($('#isolated').checked && $('#profile').value !== 'quick') })
  xhr.open('POST', `/api/batches?${params}`)
  $('#upload-progress').hidden = false
  $('#upload-progress').value = 0
  $('#batch-message').textContent = 'Sending files to your local processing queue…'
  xhr.upload.onprogress = event => { if (event.lengthComputable) $('#upload-progress').value = event.loaded / event.total * 100 }
  const finish = () => { uploading = false; $('#upload-progress').hidden = true; renderPending() }
  xhr.onload = () => {
    try {
      const result = JSON.parse(xhr.responseText)
      if (xhr.status >= 400) throw new Error(result.error || 'The batch upload failed.')
      for (const job of result) if (!cards.has(job.id)) cards.set(job.id, new SongCard(job))
      pendingFiles = []
      $('#empty-state').hidden = cards.size > 0
      $('#batch-message').textContent = `${result.length} song${result.length === 1 ? '' : 's'} queued. This runs locally, one song at a time.`
    } catch (error) { $('#batch-message').textContent = error.message }
    finish()
  }
  xhr.onerror = () => { $('#batch-message').textContent = 'Could not reach the local server. Keep npm run lab running, then try again.'; finish() }
  xhr.send(form)
}

async function poll() {
  try {
    const jobs = await api('/api/jobs')
    for (const job of jobs) {
      if (cards.has(job.id)) cards.get(job.id).update(job)
      else cards.set(job.id, new SongCard(job))
    }
    $('#empty-state').hidden = cards.size > 0
    $('#connection-status').textContent = ''
  } catch { $('#connection-status').textContent = 'Local server disconnected. Your players and drafts are still here; restart npm run lab to reconnect.' }
  setTimeout(poll, 1500)
}

for (const link of document.querySelectorAll('.export-buttons a')) link.onclick = async event => {
  event.preventDefault()
  for (const card of cards.values()) for (const key of card.dirty) await card.flush(key)
  if ([...cards.values()].some(card => card.dirty.size)) {
    $('#connection-status').textContent = 'Some labels have not saved. Fix invalid times or retry saving before exporting the dataset. You can also export an unsaved draft next to its table.'
    return
  }
  location.href = link.href
}

window.addEventListener('beforeunload', event => {
  if (uploading || [...cards.values()].some(card => card.dirty.size)) { event.preventDefault(); event.returnValue = '' }
})

async function start() {
  try {
    const config = await api('/api/config')
    profiles = config.profiles
    ready = config.setup.ready
    $('#setup-status').dataset.ready = String(ready)
    $('#setup-status').textContent = ready ? 'Local processing ready · runs on this computer' : config.setup.error
    profileChanged()
    renderPending()
  } catch (error) { $('#setup-status').textContent = `Local setup check failed: ${error.message}` }
  poll()
}
start()
