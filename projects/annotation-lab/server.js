import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runAnalysisProcess } from '../local-audio/analysisProcess.js'
import { getPythonCommand } from '../local-audio/pythonRuntime.js'
import { PROFILES, validateIntervals } from './profiles.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LAB = path.dirname(fileURLToPath(import.meta.url))
const exec = promisify(execFile)
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.aif', '.aiff', '.ogg', '.m4a', '.aac', '.opus', '.wma'])
const now = () => new Date().toISOString()

function writeJson(file, value) {
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2))
  fs.renameSync(temporary, file)
}

async function checkSetup() {
  const { stdout } = await exec(getPythonCommand(), [path.join(LAB, 'worker.py'), '--check'], { cwd: ROOT, timeout: 20000 })
  return JSON.parse(stdout)
}

async function processSong(job, { directory, dataDir, signal, onProgress }) {
  const request = path.join(directory, 'request.json')
  writeJson(request, { input: job.input, profile: job.profile, isolated: job.isolated, directory, cache: path.join(dataDir, 'cache') })
  await runAnalysisProcess(getPythonCommand(), ['-X', 'faulthandler', '-u', path.join(LAB, 'worker.py'), request], {
    cwd: ROOT, signal, onProgress: (percent, message) => onProgress({ percent, message }),
  })
  return JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
}

function csvCell(value) {
  let text = String(value ?? '')
  // Filenames can become spreadsheet formulas when a CSV is opened in Excel.
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function createLab({ dataDir = path.join(LAB, 'data'), analyze = processSong, setup = checkSetup } = {}) {
  dataDir = path.resolve(dataDir)
  fs.mkdirSync(path.join(dataDir, 'jobs'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'incoming'), { recursive: true })
  const jobs = new Map()
  const directories = new Map()
  let running = false
  let stopping = false
  let activeController
  let activeDone = Promise.resolve()
  let sequence = 0
  const app = express()
  const save = job => writeJson(path.join(directories.get(job.id), 'job.json'), job)

  for (const id of fs.readdirSync(path.join(dataDir, 'jobs'))) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue
    try {
      const directory = path.join(dataDir, 'jobs', id)
      const job = JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'))
      if (job.id !== id || !Object.hasOwn(PROFILES, job.profile)) continue
      directories.set(id, directory)
      if (['processing', 'queued', 'cancelling'].includes(job.status)) {
        Object.assign(job, { status: 'interrupted', message: 'The local server stopped. Retry to continue using any completed cached stages.' })
        save(job)
      }
      jobs.set(id, job)
      sequence = Math.max(sequence, job.sequence ?? 0)
    } catch (error) { console.error(`Could not read lab job ${id}: ${error.message}`) }
  }

  function publicJob(job) {
    const { input: _input, tracks, ...publicFields } = job
    return {
      ...publicFields,
      tracks: (tracks ?? []).map(({ file: _file, waveformFile: _waveform, ...track }) => ({
        ...track, url: `/api/jobs/${job.id}/audio/${track.key}`, waveformUrl: `/api/jobs/${job.id}/waveform/${track.key}`,
      })),
    }
  }

  async function drain() {
    if (running || stopping) return
    running = true
    try {
      for (;;) {
        const job = [...jobs.values()].find(candidate => candidate.status === 'queued')
        if (!job || stopping) break
        const controller = new AbortController()
        activeController = controller
        Object.assign(job, { status: 'processing', percent: 1, message: 'Preparing local separation', error: null })
        save(job)
        try {
          const result = await analyze(job, {
            directory: directories.get(job.id), dataDir, signal: controller.signal,
            onProgress: ({ percent, message }) => {
              if (job.status !== 'processing' || !Number.isFinite(percent) || typeof message !== 'string') return
              Object.assign(job, { percent: Math.max(job.percent, Math.min(99, percent)), message })
              save(job)
            },
          })
          controller.signal.throwIfAborted()
          const keys = (result.tracks ?? []).filter(track => track.annotatable).map(track => track.key)
          if (keys.length !== PROFILES[job.profile].keys.length || PROFILES[job.profile].keys.some(key => !keys.includes(key))) {
            throw new Error('Local separation returned an incomplete stem set.')
          }
          for (const track of result.tracks) {
            if (!/^[a-z_]+$/.test(track.key) || !(track.duration > 0)) throw new Error('Invalid local audio result.')
            for (const file of [track.file, track.waveformFile]) {
              const relative = path.relative(dataDir, file)
              if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file)) throw new Error('The local result file is missing or outside the lab workspace.')
            }
          }
          Object.assign(job, result, { status: 'done', percent: 100, message: 'Ready to listen and label', completedAt: now() })
        } catch (error) {
          Object.assign(job, { status: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? 'Cancelled. Cached stages can be reused on retry.' : 'Local separation failed. Retry after checking the error below.', error: controller.signal.aborted ? null : error.message })
        } finally {
          save(job)
          activeController = undefined
        }
      }
    } finally { running = false }
  }

  function schedule() {
    if (running || stopping) return
    activeDone = drain()
    activeDone.catch(error => console.error('Lab queue error:', error))
  }

  // This is a loopback-only developer tool. Reject requests from other sites.
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname)) return res.status(403).json({ error: 'Open this tool through localhost.' })
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({ error: 'Requests must come from the local lab page.' })
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  app.use(express.json({ limit: '512kb' }))
  app.get('/api/config', async (_req, res) => {
    try { res.json({ profiles: PROFILES, setup: await setup() }) }
    catch (error) { res.json({ profiles: PROFILES, setup: { ready: false, error: `Could not check Python: ${error.message}. Run npm run doctor in the project folder.` } }) }
  })
  app.get('/api/jobs', (_req, res) => res.json([...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0)).map(publicJob)))

  const upload = multer({
    storage: multer.diskStorage({
      destination: path.join(dataDir, 'incoming'),
      filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { files: 30, fileSize: 1024 ** 3, fields: 0 },
    fileFilter: (_req, file, callback) => AUDIO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())
      ? callback(null, true) : callback(new Error('Choose WAV, MP3, FLAC, AIFF, OGG, M4A, AAC, OPUS, or WMA audio files.')),
  }).array('songs', 30)

  app.post('/api/batches', (req, res, next) => {
    if (stopping) return res.status(503).json({ error: 'The local server is stopping.' })
    if (typeof req.query.profile !== 'string' || !Object.hasOwn(PROFILES, req.query.profile)) return res.status(400).json({ error: 'Choose a valid batch separation model.' })
    if (!['true', 'false', undefined].includes(req.query.isolated) || (req.query.profile === 'quick' && req.query.isolated === 'true')) {
      return res.status(400).json({ error: 'Quick separation requires full mixes.' })
    }
    upload(req, res, error => {
      if (error) return next(error)
      if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one audio file.' })
      const added = []
      try {
        const batchId = randomUUID()
        for (const file of req.files) {
          const id = randomUUID()
          const directory = path.join(dataDir, 'jobs', id)
          fs.mkdirSync(directory)
          const input = path.join(directory, `input${path.extname(file.filename)}`)
          fs.renameSync(file.path, input)
          // Multipart filenames are often UTF-8 bytes decoded as Latin-1 by Busboy.
          const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8')
          const filename = [...file.originalname].some(character => character.charCodeAt(0) > 255) || decodedName.includes('\ufffd') ? file.originalname : decodedName
          const job = { id, batchId, sequence: ++sequence, filename, input, profile: req.query.profile, isolated: req.query.isolated === 'true', status: 'queued', percent: 0, message: 'Waiting for the previous song', createdAt: now(), annotations: {}, tracks: [] }
          directories.set(id, directory)
          save(job)
          jobs.set(id, job)
          added.push(job)
        }
        res.status(202).json(added.map(publicJob))
        schedule()
      } catch (error) {
        // A failed upload should not leave a partial batch in the processing queue.
        for (const job of added) { jobs.delete(job.id); fs.rmSync(directories.get(job.id), { recursive: true, force: true }); directories.delete(job.id) }
        next(error)
      } finally { for (const file of req.files) fs.rmSync(file.path, { force: true }) }
    })
  })

  app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Song not found.' })
    if (job.status === 'processing') {
      job.status = 'cancelling'; job.message = 'Stopping local separation'; activeController?.abort()
    } else if (job.status === 'queued') { job.status = 'cancelled'; job.message = 'Cancelled before processing' }
    save(job)
    res.json(publicJob(job))
  })
  app.post('/api/jobs/:id/retry', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Song not found.' })
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) return res.status(409).json({ error: 'Only failed, cancelled, or interrupted songs can be retried.' })
    Object.assign(job, { status: 'queued', percent: 0, error: null, message: 'Waiting to retry using cached stages' })
    save(job); res.json(publicJob(job)); schedule()
  })
  app.put('/api/jobs/:id/annotations/:key', (req, res) => {
    const job = jobs.get(req.params.id)
    const track = job?.tracks.find(candidate => candidate.key === req.params.key && candidate.annotatable)
    if (!track || job.status !== 'done') return res.status(404).json({ error: 'This stem is not ready for annotation.' })
    const previous = job.annotations[track.key] ?? { version: 0, intervals: [] }
    if (req.body.version !== previous.version) return res.status(409).json({ error: 'Labels changed in another tab. Export your draft, then reload before saving.', current: previous })
    try {
      const intervals = validateIntervals(req.body.intervals, track.duration)
      const annotation = { version: previous.version + 1, updatedAt: now(), intervals }
      job.annotations[track.key] = annotation
      try { save(job) } catch (error) { job.annotations[track.key] = previous; throw error }
      res.json(annotation)
    } catch (error) { res.status(400).json({ error: error.message }) }
  })

  for (const [route, field] of [['audio', 'file'], ['waveform', 'waveformFile']]) {
    app.get(`/api/jobs/:id/${route}/:key`, (req, res, next) => {
      const job = jobs.get(req.params.id)
      const track = job?.tracks.find(candidate => candidate.key === req.params.key)
      if (!track || job.status !== 'done') return res.status(404).json({ error: 'Audio is not ready.' })
      // sendFile supports byte ranges, so long WAVs can be scrubbed without reloading.
      res.sendFile(track[field], error => {
        // Switching/ seeking audio routinely cancels a previous byte-range read.
        if (error && !['ECONNABORTED', 'EPIPE'].includes(error.code)) next(error)
      })
    })
  }

  app.get('/api/export', (req, res) => {
    const songs = [...jobs.values()].filter(job => job.status === 'done').map(job => ({
      id: job.id, filename: job.filename, profile: job.profile, isolated: job.isolated,
      createdAt: job.createdAt, provenance: job.provenance,
      tracks: job.tracks.map(({ file, waveformFile: _waveform, ...track }) => ({ ...track, localFile: path.relative(dataDir, file).split(path.sep).join('/') })),
      annotations: job.annotations,
    }))
    if (req.query.format === 'csv') {
      const rows = [['song_id', 'filename', 'profile', 'stem', 'start_seconds', 'end_seconds', 'label', 'input_sha256', 'pipeline_version']]
      for (const song of songs) for (const [key, annotation] of Object.entries(song.annotations)) for (const interval of annotation.intervals) {
        rows.push([song.id, song.filename, song.profile, key, interval.start, interval.end, interval.label, song.provenance?.inputSha256, song.provenance?.pipelineVersion])
      }
      res.attachment('music-room-labels.csv').type('text/csv').send(rows.map(row => row.map(csvCell).join(',')).join('\r\n'))
    } else res.attachment('music-room-dataset.json').json({ schemaVersion: 1, exportedAt: now(), timeUnit: 'seconds', labels: ['genuine', 'bleed_absent', 'uncertain'], songs })
  })

  app.use(express.static(path.join(LAB, 'public')))
  app.use((error, req, res, _next) => {
    for (const file of req.files ?? []) fs.rmSync(file.path, { force: true })
    console.error(error)
    if (!res.headersSent) res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Each audio file must be smaller than 1 GB.' : error.message })
  })

  return { app, async close() { stopping = true; activeController?.abort(); await activeDone }, jobs }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LAB_PORT || 3002)
  const lab = createLab({ dataDir: process.env.LAB_DATA_DIR || path.join(LAB, 'data') })
  const server = lab.app.listen(port, '127.0.0.1', () => {
    console.log(`Music Room annotation lab: http://127.0.0.1:${port}`)
    console.log(process.env.LAB_DATA_DIR ? 'Using the specified LAB_DATA_DIR for private local data.' : 'Audio, stems, labels, and caches stay in the ignored projects/annotation-lab/data folder.')
    console.log('No MVSEP credits are used.')
  })
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set LAB_PORT to another port.` : error.message); process.exitCode = 1 })
  async function stop() { server.close(); await lab.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
