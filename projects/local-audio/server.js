import express from 'express'
import multer from 'multer'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { randomUUID } from 'crypto'
import { runAnalysisProcess } from './analysisProcess.js'
import { getPythonCommand } from './pythonRuntime.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

async function analyzeSong(songPath, onProgress, mode = 'thorough', { signal, outputDir } = {}) {
  await runAnalysisProcess(getPythonCommand(), ['-X', 'faulthandler', '-u', 'analysis.py', songPath, '--mode', mode, '--output-dir', outputDir], {
    cwd: path.join(ROOT, 'analysis'), signal, onProgress,
  })
}

async function analyzeStemFiles(stems, onProgress, { signal, outputDir, mixPath, title = 'stem mix' } = {}) {
  const manifest = path.join(path.dirname(outputDir), 'stems.json')
  fs.writeFileSync(manifest, JSON.stringify(stems))
  await runAnalysisProcess(getPythonCommand(), ['-X', 'faulthandler', '-u', 'import_stems.py', manifest, '--output-dir', outputDir, '--mix-path', mixPath, `--title=${title}`], {
    cwd: path.join(ROOT, 'analysis'), signal, onProgress,
  })
}

function publishSong(file, outputDir, audioDir, assetsDir, id) {
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'instrument_meta.json'), 'utf8'))
  if (!Array.isArray(metadata.instruments)) throw new Error('Invalid instrument metadata')
  const names = metadata.instruments.map(instrument => {
    if (!/^[a-z][a-z0-9_]*$/.test(instrument.key)) throw new Error('Invalid instrument key')
    return `${instrument.key}_frames.json`
  })
  // Read every result before publishing; partial/canceled analysis stays private.
  const files = [...names, 'instrument_meta.json'].map(name => [name, fs.readFileSync(path.join(outputDir, name))])
  fs.mkdirSync(assetsDir, { recursive: true })
  const temporaryAudio = path.join(audioDir, `.upload-${id}.tmp`)
  try {
    fs.copyFileSync(file.path, temporaryAudio)
    fs.renameSync(temporaryAudio, path.join(audioDir, file.filename))
    for (const [name, contents] of files) {
      const destination = path.join(assetsDir, name)
      if (fs.existsSync(destination) && fs.readFileSync(destination).equals(contents)) continue
      const temporary = `${destination}.${id}.tmp`
      fs.writeFileSync(temporary, contents)
      fs.renameSync(temporary, destination)
    }
    for (const name of fs.readdirSync(assetsDir)) {
      if (name.endsWith('_frames.json') && !names.includes(name)) fs.unlinkSync(path.join(assetsDir, name))
    }
  } finally {
    fs.rmSync(temporaryAudio, { force: true })
  }
}

export function createApp({ audioDir = path.join(ROOT, 'output/audio'), assetsDir = path.join(ROOT, 'output/analysis'), analyze = analyzeSong, analyzeStems = analyzeStemFiles } = {}) {
  const app = express()
  let processing = false
  const jobs = new Map()
  const controls = new Map()
  fs.mkdirSync(audioDir, { recursive: true })
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.workDir),
    filename: (req, file, cb) => cb(null, req.stemUpload ? `${randomUUID()}${path.extname(file.originalname)}` : path.basename(file.originalname)),
  })
  const upload = multer({ storage }).single('song')
  const uploadStems = multer({ storage, limits: { files: 32, fields: 2, fieldSize: 16384 } }).array('stems', 32)

  app.post('/api/rename', express.json({ limit: '16kb' }), (req, res) => {
    if (processing) return res.status(409).json({ success: false, error: 'Wait for processing to finish before renaming.' })
    const { audioUrl, title, instruments } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || !Array.isArray(instruments)) {
      return res.status(400).json({ success: false, error: 'Provide a song title (1–120 characters) and instrument names.' })
    }
    const destination = path.join(assetsDir, 'instrument_meta.json')
    let temporary
    try {
      if (!fs.existsSync(destination)) return res.status(404).json({ success: false, error: 'No mix is loaded.' })
      const metadata = JSON.parse(fs.readFileSync(destination, 'utf8'))
      if (audioUrl !== metadata.audioUrl || metadata.processingMode !== 'stems') {
        return res.status(409).json({ success: false, error: 'The loaded mix has changed. Refresh before renaming.' })
      }
      const labels = new Map()
      for (const instrument of instruments) {
        if (!instrument || typeof instrument.key !== 'string' || typeof instrument.label !== 'string' || !instrument.label.trim() || instrument.label.trim().length > 60 || labels.has(instrument.key)) {
          return res.status(400).json({ success: false, error: 'Give every instrument a name of 1–60 characters.' })
        }
        labels.set(instrument.key, instrument.label.trim())
      }
      if (labels.size !== metadata.instruments.length || metadata.instruments.some(instrument => !labels.has(instrument.key))) {
        return res.status(400).json({ success: false, error: 'The instrument list does not match the loaded mix.' })
      }
      metadata.title = title.trim()
      metadata.instruments = metadata.instruments.map(instrument => ({ ...instrument, label: labels.get(instrument.key) }))
      // Rename display text only. Audio, instrument keys, and frame data remain
      // intact, so this does not require another round of audio analysis.
      temporary = `${destination}.${randomUUID()}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(metadata))
      fs.renameSync(temporary, destination)
      res.json({ success: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ success: false, error: 'Could not save the names. Please try again.' })
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true })
    }
  })

  app.get('/api/progress/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Upload not found' })
    res.json(job)
  })

  app.post('/api/cancel/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Upload not found' })
    const control = controls.get(req.params.id)
    if (control) {
      Object.assign(job, { status: 'cancelling', message: 'Cancelling processing' })
      control.controller.abort()
      await control.done
    }
    res.json(job)
  })

  // Serialize uploads before writing files or regenerating the shared frame data.
  const uploadHandler = stemUpload => async (req, res) => {
    if (processing) return res.status(409).json({ success: false, error: 'A song is already processing.' })
    const mode = stemUpload ? 'stems' : (req.query.mode ?? 'thorough')
    if (!stemUpload && mode !== 'quick' && mode !== 'thorough') {
      return res.status(400).json({ success: false, error: 'Invalid processing mode.' })
    }
    const id = req.query.jobId ?? randomUUID()
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid upload ID.' })
    }
    if (jobs.has(id)) return res.status(409).json({ success: false, error: 'Upload ID already used.' })
    // Retain recent completed jobs so a page refresh can recover progress.
    if (jobs.size >= 20) jobs.delete(jobs.keys().next().value)
    const job = { status: 'processing', percent: 0, message: stemUpload ? 'Uploading stems' : 'Uploading song' }
    jobs.set(id, job)
    processing = true
    const controller = new AbortController()
    let resolveDone
    const done = new Promise(resolve => { resolveDone = resolve })
    controls.set(id, { controller, done })
    let workDir, outcome, reply
    try {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-room-job-'))
      req.workDir = workDir
      req.stemUpload = stemUpload
      const outputDir = path.join(workDir, 'analysis')
      fs.mkdirSync(outputDir)
      await new Promise((resolve, reject) => {
        const cancel = () => { reject(new DOMException('Upload cancelled', 'AbortError')); req.destroy() }
        const disconnected = () => reject(new Error('Upload disconnected'))
        controller.signal.addEventListener('abort', cancel, { once: true })
        req.once('aborted', disconnected)
        const receive = stemUpload ? uploadStems : upload
        receive(req, res, err => {
          controller.signal.removeEventListener('abort', cancel)
          req.removeListener('aborted', disconnected)
          if (err) reject(err)
          else resolve()
        })
      })
      controller.signal.throwIfAborted()
      if (stemUpload ? !req.files?.length : !req.file) {
        outcome = { status: 'failed', message: stemUpload ? 'No stem files were uploaded.' : 'No audio file was uploaded.' }
        reply = { code: 400, body: { success: false, error: outcome.message } }
      } else {
        job.percent = 5
        job.message = stemUpload ? 'Preparing stems' : 'Preparing song'
        const report = (percent, message) => {
          if (!controller.signal.aborted && Number.isFinite(percent) && typeof message === 'string') {
            job.percent = Math.max(job.percent, Math.min(99, percent))
            job.message = message
          }
        }
        const options = { signal: controller.signal, outputDir }
        let playbackFile = req.file
        if (stemUpload) {
          let labels
          try { labels = JSON.parse(req.body.labels) } catch { /* Validated below. */ }
          if (!Array.isArray(labels) || labels.length !== req.files.length || labels.some(label => typeof label !== 'string' || !label.trim() || label.trim().length > 60)) {
            throw Object.assign(new Error('Provide an instrument name (1–60 characters) for every stem.'), { status: 400 })
          }
          const title = req.body.title ?? 'stem mix'
          if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
            throw Object.assign(new Error('Provide a song title of 1–120 characters.'), { status: 400 })
          }
          const filename = `stem-mix-${id}.wav`
          playbackFile = { filename, path: path.join(workDir, filename) }
          await analyzeStems(req.files.map((file, index) => ({ file: file.path, fileName: file.originalname, label: labels[index].trim() })), report, { ...options, mixPath: playbackFile.path, title: title.trim() })
        } else {
          console.log(`Received ${req.file.filename}, running ${mode} processing...`)
          await analyze(req.file.path, report, mode, options)
        }
        controller.signal.throwIfAborted()
        // This short synchronous commit cannot be interrupted by a cancel request.
        publishSong(playbackFile, outputDir, audioDir, assetsDir, id)
        outcome = { status: 'complete', percent: 100, message: 'Room ready' }
        reply = { code: 200, body: { success: true, filename: playbackFile.filename } }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        outcome = { status: 'cancelled', message: 'Processing cancelled' }
        reply = { code: 200, body: { success: false, cancelled: true } }
      } else {
        console.error(err)
        const badUpload = err.status === 400 || err instanceof multer.MulterError
        const message = badUpload ? (err instanceof multer.MulterError ? 'Upload up to 32 stems with one instrument name per file.' : err.message) : 'Processing failed. Please try uploading again.'
        outcome = { status: 'failed', message }
        reply = { code: badUpload ? 400 : 500, body: { success: false, error: badUpload ? message : 'Analysis failed' } }
      }
    } finally {
      if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(console.error)
      processing = false
      Object.assign(job, outcome)
      controls.delete(id)
      resolveDone()
    }
    if (!res.destroyed) res.status(reply.code).json(reply.body)
  }
  app.post('/api/upload', uploadHandler(false))
  app.post('/api/upload-stems', uploadHandler(true))
  return app
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const PORT = 3001
  createApp().listen(PORT, () => console.log(`Upload server running on http://localhost:${PORT}`))
}
