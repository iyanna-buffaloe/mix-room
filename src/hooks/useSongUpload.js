import { COPY } from '../config/siteCopy.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AUDIO_FILE_ENABLED, THOROUGH_AVAILABLE } from '../config/features.js'
import { savedSeparationJob, rememberSeparation, forgetSeparation, runSeparation, separationRequest, loadExistingSeparation, recoverSeparation } from '../separation/separationClient.js'
import { savedProcessingFailure, rememberProcessingFailure, forgetProcessingFailure } from '../separation/processingFailure.js'

const MODE_KEY = 'mix-room-processing-mode'
const readMode = () => { try { return THOROUGH_AVAILABLE && localStorage.getItem(MODE_KEY) === 'thorough' ? 'thorough' : 'quick' } catch { return 'quick' } }

export function useSongUpload(onComplete, ready = true, identityKey = 'guest') {
  const [failure, setFailure] = useState(savedProcessingFailure)
  const [failureOpen, setFailureOpen] = useState(false)
  const [restoredJob] = useState(() => AUDIO_FILE_ENABLED ? savedSeparationJob() : null)
  const [recoveryAvailable, setRecoveryAvailable] = useState(Boolean(restoredJob))
  const [recoveryOwner, setRecoveryOwner] = useState(restoredJob?.ownerId ?? 'guest')
  const initial = useRef(failure ? null : restoredJob)
  const [upload, setUpload] = useState(null)
  const [processingMode, setProcessingMode] = useState(() => restoredJob?.mode ?? readMode())
  const [progress, setProgress] = useState({ percent: 0, message: COPY.preparing_your_song })
  const [cancellingUpload, setCancellingUpload] = useState(false)
  const [available, setAvailable] = useState(null)
  const [credits, setCredits] = useState(null)
  const [creditError, setCreditError] = useState('')
  const mounted = useRef(true)
  const currentIdentity = useRef(identityKey)
  useEffect(() => { currentIdentity.current = identityKey }, [identityKey])
  const refreshCredits = useCallback(async signal => {
    const requestedIdentity = currentIdentity.current
    try {
      const value = await separationRequest('/credits', null, { signal })
      if (!signal?.aborted && mounted.current && currentIdentity.current === requestedIdentity) { setCredits(value); setCreditError('') }
      return value
    } catch {
      if (!signal?.aborted && mounted.current && currentIdentity.current === requestedIdentity) setCreditError('Could not check remaining analyses.')
      return null
    }
  }, [])
  const active = useRef(null), complete = useRef(onComplete)
  const suspendForNavigation = useCallback(() => {
    const run = active.current
    if (!run) return
    run.controller.abort(); active.current = null
    if (run.job) { initial.current = run.job; setRecoveryAvailable(true); setRecoveryOwner(run.ownerId ?? 'guest') }
    setUpload(null); setCancellingUpload(false)
  }, [])
  useEffect(() => {
    const run = active.current
    if (run && (run.ownerId ?? 'guest') !== identityKey) suspendForNavigation()
    if (failure?.ownerId && failure.ownerId !== identityKey) { setFailure(null); setFailureOpen(false) }
  }, [identityKey, failure?.ownerId, suspendForNavigation])
  useEffect(() => { complete.current = onComplete }, [onComplete])
  useEffect(() => { try { localStorage.setItem(MODE_KEY, processingMode) } catch { /* Optional preference. */ } }, [processingMode])
  useEffect(() => {
    if (!AUDIO_FILE_ENABLED) return
    const controller = new AbortController()
    separationRequest('/config', null, { signal: controller.signal }).then(config => { setAvailable(config.available); return refreshCredits(controller.signal) }).catch(() => { if (!controller.signal.aborted) setAvailable(false) })
    return () => controller.abort()
  }, [refreshCredits])
  useEffect(() => { const controller = new AbortController(); refreshCredits(controller.signal); return () => controller.abort() }, [identityKey, refreshCredits])

  useEffect(() => {
    if (!available) return
    const refresh = () => { if (document.visibilityState === 'visible') refreshCredits() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [available, refreshCredits])

  const start = useCallback(async (file, mode, existingJob, resultReference, readOnly = false, previousFailure) => {
    if (active.current) return
    const controller = new AbortController(), run = { controller, job: existingJob, ownerId: identityKey === 'guest' ? null : identityKey }
    active.current = run
    setRecoveryAvailable(false)
    setFailureOpen(false)
    setUpload({ ...(existingJob ?? { name: file.name, mode }), ownerId: run.ownerId })
    setCancellingUpload(false)
    setProgress({ percent: 0, message: existingJob ? COPY.resuming_your_separation : COPY.preparing_your_song })
    try {
      const options = {
        file, mode, existingJob, signal: controller.signal, ownerId: run.ownerId,
        onJob: job => { run.job = job; rememberSeparation(job) },
        onState: state => { run.serviceState = state },
        onProgress: value => { run.progress = value; if (active.current === run && !controller.signal.aborted) setProgress(previous => ({ ...value, percent: Math.max(previous.percent, value.percent) })) },
      }
      const result = readOnly && existingJob ? await recoverSeparation(existingJob, options) : resultReference ? await loadExistingSeparation(resultReference, { ...options, name: file.name }) : await runSeparation(options)
      controller.signal.throwIfAborted()
      await complete.current(result, { signal: controller.signal })
      forgetSeparation(); initial.current = null
      forgetProcessingFailure(); setFailure(null)
    } catch (failure) {
      if (active.current !== run) return
      if (!controller.signal.aborted && failure.code === 'SONG_CREDITS_EXHAUSTED') {
        setCredits(previous => ({ ...previous, remaining: 0 }))
        forgetSeparation(); initial.current = null
      } else if (!controller.signal.aborted) {
        const stopped = { time: new Date().toISOString(), name: existingJob?.name ?? file?.name ?? COPY.your_song,
          message: failure.message || COPY.could_not_finish_separating_your_song, code: failure.code, httpStatus: failure.status, ownerId: run.ownerId,
          job: failure.beforeSubmission ? undefined : run.job, reference: resultReference, percent: run.progress?.percent ?? 0, step: run.progress?.message ?? COPY.starting_processing,
          serviceStatus: run.serviceState?.status ?? previousFailure?.serviceStatus, servicePhase: run.serviceState?.phase ?? previousFailure?.servicePhase,
          providerJobs: run.serviceState?.providerJobs ?? previousFailure?.providerJobs,
        }
        initial.current = null
        if (failure.beforeSubmission) forgetSeparation()
        rememberProcessingFailure(stopped); setFailure(stopped); setFailureOpen(true)
      }
    } finally {
      if (active.current === run) { active.current = null; setUpload(null); setCancellingUpload(false); refreshCredits() }
    }
  }, [refreshCredits, identityKey])

  // A fresh visit must not restore a completed unsaved mix implicitly. Recovery
  // is an explicit action in Upload track and never starts a second paid job.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = null }
  }, [])

  const uploadSong = file => {
    if (!AUDIO_FILE_ENABLED || !ready || !file || active.current) return
    if (!isAudioFile(file)) return alert(COPY.please_choose_an_audio_file)
    // Selecting a new file must never silently resume a different song.
    // The same failed song uses an explicit, read-only recovery action.
    if (failure?.job && failure.name === file.name) return retryLoading()
    if (!credits || credits.remaining <= 0) { refreshCredits(); return }
    return start(file, processingMode)
  }

  const loadMVSEPResult = (reference, name = 'MVSEP mix.wav') => {
    if (!AUDIO_FILE_ENABLED || !ready || active.current || !reference.trim()) return
    return start({ name }, 'existing', undefined, reference)
  }

  const retryLoading = () => {
    if (!ready || active.current || !failure) return
    return start({ name: failure.name }, failure.job?.mode ?? 'existing', failure.job, failure.reference, true, failure)
  }

  const cancelUpload = async () => {
    const run = active.current
    if (!run || cancellingUpload) return
    setCancellingUpload(true)
    try {
      if (run.job) {
        for (let attempt = 0; ; attempt++) {
          try { await separationRequest(`/jobs/${run.job.id}/cancel`, run.job, { method: 'POST' }); break } catch (failure) {
            if (failure.status !== 404 || attempt >= 4) throw failure
            await new Promise(resolve => setTimeout(resolve, 400))
          }
        }
      }
      run.controller.abort()
      forgetSeparation(); initial.current = null
      if (active.current === run) { active.current = null; setUpload(null); setCancellingUpload(false); refreshCredits() }
    } catch {
      if (active.current === run) { setCancellingUpload(false); alert(COPY.could_not_confirm_cancellation_please_try_cancel_processing_again) }
    }
  }

  const canRecover = recoveryAvailable && recoveryOwner === identityKey
  const visibleFailure = !failure?.ownerId || failure.ownerId === identityKey ? failure : null
  const visibleUpload = !upload?.ownerId || upload.ownerId === identityKey ? upload : null
  return { available, credits, refreshCredits, suspendForNavigation, recoveryAvailable: canRecover, resumePreviousJob: () => { if (canRecover && ready && available === true && initial.current && !active.current) start(undefined, initial.current.mode, initial.current) }, creditNotice: creditError, failure: visibleFailure, failureOpen: Boolean(visibleFailure && failureOpen), showFailure: () => setFailureOpen(true), closeFailure: () => setFailureOpen(false), retryLoading,
    clearFailure: () => { setFailure(null); setFailureOpen(false); forgetProcessingFailure(); forgetSeparation(); initial.current = null },
    uploadError: visibleFailure?.message, uploading: Boolean(visibleUpload), uploadName: visibleUpload?.name, uploadMode: visibleUpload?.mode, progress, uploadSong, loadMVSEPResult, cancelUpload, cancellingUpload, processingMode, setProcessingMode }
}

export function isAudioFile(file) {
  return file.type.startsWith('audio/') || /\.(wav|mp3|flac|m4a|aac|ogg|opus|aiff?|wma)$/i.test(file.name)
}
