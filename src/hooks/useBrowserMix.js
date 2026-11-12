import { COPY } from '../config/siteCopy.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { processBrowserStems, validateStemUpload } from '../audio/browserStemProcessing.js'
import { loadBrowserMix, deleteLegacyBrowserMix, renameMix } from '../audio/browserMixStorage.js'
import { separationRequest, getSeparationAccountToken } from '../separation/separationClient.js'

// Audio and edits live only in this mounted page. IndexedDB is read exclusively
// for a user-controlled migration; new mixes and name edits never write there.
export function useBrowserMix(defaultMetadata, defaultFrames, accountId = null) {
  const [record, setRecord] = useState(null)
  const [legacy, setLegacy] = useState(null)
  const [demoSelected, setDemoSelected] = useState(false)
  const [demoIdentity, setDemoIdentity] = useState('demo')
  const [restoring, setRestoring] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [processingAccount, setProcessingAccount] = useState(null)
  const [savingNames, setSavingNames] = useState(false)
  const [name, setName] = useState('')
  const [progress, setProgress] = useState({ percent: 0, message: COPY.preparing_stems })
  const [notice, setNotice] = useState('')
  const [saved, setSaved] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [contentOwner, setContentOwner] = useState(null)
  const active = useRef(null), mounted = useRef(false), recordRef = useRef(null), revision = useRef(0), owner = useRef(null)
  const accountRef = useRef(accountId)
  const processingOwner = useRef(null), finishing = useRef(false)
  useEffect(() => { accountRef.current = accountId }, [accountId])

  useEffect(() => {
    let cancelled = false
    mounted.current = true
    loadBrowserMix().then(value => { if (!cancelled) setLegacy(value) }).catch(() => {
      if (!cancelled) setNotice('The older browser mix could not be checked. Existing local data has not been removed.')
    }).finally(() => { if (!cancelled) setRestoring(false) })
    return () => { cancelled = true; mounted.current = false; active.current?.abort() }
  }, [])

  const clear = () => {
    active.current?.abort(); recordRef.current = null; owner.current = null; revision.current++
    setRecord(null); setDemoSelected(false); setSaved(null); setDirty(false); setNotice(''); setContentOwner(null)
  }
  useEffect(() => {
    if (processingOwner.current && processingOwner.current !== accountId) active.current?.abort()
    if (owner.current && owner.current !== accountId) clear()
  }, [accountId])
  // Hide private content in the same render as account loss, before effects.
  const allowed = !contentOwner || contentOwner === accountId
  const displayedRecord = allowed ? record : null
  const audioBlob = displayedRecord?.audioBlob
  const demoSource = displayedRecord?.demoSource === defaultMetadata.audioUrl
  const audioUrl = useMemo(() => demoSource ? defaultMetadata.audioUrl : audioBlob ? URL.createObjectURL(audioBlob) : demoSelected ? defaultMetadata.audioUrl : undefined, [audioBlob, demoSelected, defaultMetadata.audioUrl, demoSource])
  useEffect(() => () => { if (audioUrl?.startsWith('blob:')) URL.revokeObjectURL(audioUrl) }, [audioUrl])
  const empty = useMemo(() => ({ ...defaultMetadata, title: 'Choose a mix', artist: '', audioUrl: undefined, instruments: [], duration: 0 }), [defaultMetadata])
  const mix = useMemo(() => displayedRecord ? { ...displayedRecord.metadata, audioUrl } : demoSelected ? defaultMetadata : empty, [displayedRecord, audioUrl, demoSelected, defaultMetadata, empty])

  const publish = (value, savedRow = null, ownerId = accountRef.current) => {
    if (!mounted.current) return
    recordRef.current = value; owner.current = ownerId; revision.current++
    setRecord(value); setDemoSelected(false); setSaved(savedRow); setDirty(!savedRow); setNotice(''); setContentOwner(ownerId)
  }
  const analyzeStems = async (stems, title = 'stem mix') => {
    if (active.current || restoring) return
    try { validateStemUpload(stems, title) } catch (error) { alert(error.message); return }
    const controller = new AbortController(), startedOwner = accountRef.current, trialId = crypto.randomUUID()
    let trialToken, reserved = false, completed = false
    processingOwner.current = startedOwner
    setProcessingAccount(startedOwner)
    active.current = controller
    setProcessing(true); setName(title.trim()); setProgress({ percent: 0, message: COPY.preparing_stems })
    try {
      trialToken = await getSeparationAccountToken()
      await separationRequest('/stems/reserve', null, { method: 'POST', body: { id: trialId }, signal: controller.signal, accountToken: trialToken })
      reserved = true
      const result = await processBrowserStems(stems, title, { signal: controller.signal,
        onProgress: value => { if (mounted.current && !controller.signal.aborted) setProgress(previous => ({ ...value, percent: Math.max(previous.percent, value.percent) })) },
      })
      controller.signal.throwIfAborted()
      if (startedOwner && startedOwner !== accountRef.current) return
      finishing.current = true; setFinalizing(true)
      setProgress({ percent: 99, message: 'Finishing your analysis…' })
      await separationRequest('/stems/complete', null, { method: 'POST', body: { id: trialId }, accountToken: trialToken })
      completed = true
      controller.signal.throwIfAborted()
      publish({ version: 1, id: crypto.randomUUID(), ...result }, null, startedOwner)
      if (mounted.current) setProgress({ percent: 100, message: COPY.room_ready })
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) alert(error.message || COPY.could_not_analyze_the_stems_please_try_again)
    } finally {
      if (reserved && !completed) await separationRequest('/stems/release', null, { method: 'POST', body: { id: trialId }, accountToken: trialToken, signal: AbortSignal.timeout(5000) }).catch(() => {})
      finishing.current = false; processingOwner.current = null
      if (active.current === controller) active.current = null
      if (mounted.current) { setProcessing(false); setFinalizing(false) }
    }
  }
  const saveNames = async (title, instruments, { preserveDemoPlayback = false } = {}) => {
    if (active.current || restoring) return false
    const controller = new AbortController(); active.current = controller; setSavingNames(true)
    try {
      let current = recordRef.current ?? { version: 1, id: crypto.randomUUID(), metadata: defaultMetadata, framesByKey: defaultFrames }
      let next = renameMix(current, title, instruments)
      // Guided renaming is a real editable draft, with the same archive audio,
      // but retains the mounted reference source and Editor identity so Apply
      // names cannot interrupt playback or silently end the lesson.
      if (preserveDemoPlayback && (demoSelected || demoSource)) next.demoSource = defaultMetadata.audioUrl
      if (!current.audioBlob) {
        const response = await fetch(defaultMetadata.audioUrl, { signal: controller.signal })
        if (!response.ok) throw new Error('The demo audio could not be loaded.')
        next = { ...next, audioBlob: await response.blob() }
      }
      controller.signal.throwIfAborted()
      const previousSaved = saved
      publish(next, previousSaved, owner.current ?? accountRef.current); setDirty(true)
      return true
    } catch (error) { if (!controller.signal.aborted && mounted.current) alert(error.message || COPY.could_not_save_the_names); return false }
    finally { if (active.current === controller) active.current = null; if (mounted.current) setSavingNames(false) }
  }
  return {
    mix, mixId: demoSource || demoSelected ? demoIdentity : displayedRecord?.id ?? 'empty', framesByKey: displayedRecord?.framesByKey ?? (demoSelected ? defaultFrames : {}),
    restoring, processing: processing && (!processingAccount || processingAccount === accountId), finalizing, savingNames, name, progress, notice, analyzeStems, saveNames, legacy, saved, dirty: allowed && dirty,
    hasContent: Boolean(displayedRecord || demoSelected), record: displayedRecord, isDemo: demoSelected || demoSource, hasSavedMix: false,
    cancelProcessing: () => { if (!finishing.current) active.current?.abort() },
    acceptSeparatedMix: async (result, { signal }) => { signal.throwIfAborted(); publish({ version: 1, id: crypto.randomUUID(), ...result }) },
    loadDemo: () => { if (!active.current && !restoring) { clear(); setDemoIdentity(crypto.randomUUID()); setDemoSelected(true) } },
    restoreSavedMix: () => {},
    clear,
    // Each opening gets a fresh editor identity, even for copies of one archive.
    // Staged form values must not leak into the next loaded saved version.
    loadRecord: (value, row, ownerId) => {
      if (active.current || (ownerId && ownerId !== accountRef.current)) return null
      const opened = { ...value, id: crypto.randomUUID() }
      publish(opened, row, ownerId)
      return opened.id
    },
    openLegacy: () => { if (legacy && !active.current) publish({ ...legacy, id: crypto.randomUUID() }, null, null) },
    deleteLegacy: async () => { if (legacy) { await deleteLegacyBrowserMix(legacy.id); setLegacy(null) } },
    markDirty: () => { if (recordRef.current) { revision.current++; setDirty(true) } },
    snapshot: () => ({ record: recordRef.current, revision: revision.current }),
    markSaved: (row, ownerId, expectedRevision) => {
      if (revision.current === expectedRevision && recordRef.current) {
        const next = { ...recordRef.current, metadata: { ...recordRef.current.metadata, title: row.name } }
        recordRef.current = next; setRecord(next); owner.current = ownerId; setContentOwner(ownerId); setSaved(row); setDirty(false)
      }
    },
    renamedSaved: row => {
      if (saved?.id !== row.id) return
      setSaved(row)
      if (!dirty && recordRef.current) { const next = { ...recordRef.current, metadata: { ...recordRef.current.metadata, title: row.name } }; recordRef.current = next; setRecord(next) }
    },
    deletedSaved: id => { if (saved?.id === id) { setSaved(null); setDirty(true); revision.current++ } },
  }
}
