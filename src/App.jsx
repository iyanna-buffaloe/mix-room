import { COPY, formatCopy } from './config/siteCopy.js'
import { useState, useEffect, useEffectEvent, useCallback, useRef, useMemo } from 'react'
import { createPortal, flushSync } from 'react-dom'
import defaultSongData from './demo/nin-demon-seed/instrument_meta.json'
import { useSongUpload } from './hooks/useSongUpload.js'
import { useBrowserMix } from './hooks/useBrowserMix.js'
import { AUDIO_FILE_ENABLED, THOROUGH_AVAILABLE } from './config/features.js'
import UploadPanel from './components/UploadPanel.jsx'
import MixEditor from './components/MixEditor.jsx'
import InstrumentVisibilityPanel from './components/InstrumentVisibilityPanel.jsx'
import AudioPlayer from './components/AudioPlayer.jsx'
import FullscreenControls from './components/FullscreenControls.jsx'
import WorkspaceOverlay from './components/WorkspaceOverlay.jsx'
import WorkspaceNavigation from './components/WorkspaceNavigation.jsx'
import GitHubLink from './components/GitHubLink.jsx'
import AccountAccess from './components/AccountAccess.jsx'
import AccountPage from './components/AccountPage.jsx'
import MixLibrary from './components/MixLibrary.jsx'
import DraftGuard from './components/DraftGuard.jsx'
import { useAccount } from './hooks/useAccount.js'
import { downloadMixBackup, readMixArchive } from './audio/mixArchive.js'
import { useViewSettings } from './hooks/useViewSettings.js'
import { useViewportSize } from './hooks/useViewportSize.js'
import { useVideoDownload } from './hooks/useVideoDownload.js'
import { waitForFullRoom } from './export/exportScene.js'
import { ProcessingFailure } from './components/ProcessingFailure.jsx'
import { isDeveloperMode } from './config/developerMode.js'
import { ROOM_COMPACT_QUERY } from './room/roomViewport.js'
import { makeInstruments, initialInstrumentVisibility } from './room/instrumentSetup.js'
import { useRoomFullscreen } from './hooks/useRoomFullscreen.js'
import RoomScene from './room/RoomScene.jsx'
import DemoTutorial from './components/DemoTutorial.jsx'
import { useDemoTutorial } from './hooks/useDemoTutorial.js'
import { buildTutorialPassages } from './demo/tutorialPassages.js'
import { useTutorialInspector, TUTORIAL_INSPECTORS } from './hooks/useTutorialInspector.js'
import './App.css'

// ============================================================
// DATA LOADING
// ============================================================

// Load the demo's audio measurements once. Give each file the same instrument
// name used by uploads and saved mixes, so they can all use the same lookup.
const frameModules = import.meta.glob('./demo/nin-demon-seed/*_frames.json', { eager: true })
const defaultFrames = Object.fromEntries(
  Object.entries(frameModules).map(([path, module]) => [
    path.split('/').pop().replace('_frames.json', ''), module.default
  ])
)

// ============================================================
// FULLSCREEN ICONS
// ============================================================

// Draw the fullscreen and phone-rotation symbols. Their buttons also have text
// labels for screen readers. The rotation button can turn the room even when
// the browser cannot turn or lock the phone's screen itself.


function FullscreenIcon({ exit = false }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={exit
        ? 'M9 3v6H3 M15 3v6h6 M9 21v-6H3 M15 21v-6h6'
        : 'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6'} />
    </svg>
  )
}

function RotationIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

// ============================================================
// APP — SHARED WORKFLOWS
// ============================================================
//
// Connect the parts of the app that need to agree: the open mix, account,
// playback, uploads and panels. Other files draw the room or show individual
// panels; App decides when those parts can act and what they need to remember.
//
// The first section remembers the user's choices and works out what to show.
// The groups below handle sign-in, unsaved changes, uploads and video downloads,
// then describe the page. Important steps also have short comments beside them.
//
// Changing panels or entering fullscreen must not restart the song. Signing in
// keeps the current mix and selected file, but uploading or downloading still
// needs another click. Switching accounts clears private work from the old one.


function App() {
  useEffect(() => { document.title = COPY.music_room_visualize_your_mix }, [])

  const { settings: viewSettings, updateSetting: changeViewSetting, resetSettings, restoreSettings } = useViewSettings()
  const account = useAccount()

  const [libraryMode, setLibraryMode] = useState(null)
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [guard, setGuard] = useState(null)
  const [accountRequest, setAccountRequest] = useState(null)
  const afterSave = useRef(null),
    afterSignIn = useRef(false),
    backupInput = useRef(null),
    accountReturnView = useRef('playing')
  const previousAccount = useRef(null)

  const [workspaceNotice, setWorkspaceNotice] = useState('')
  const [pendingNameEdits, setPendingNameEdits] = useState(false)
  const nameCommit = useRef(null)
  const registerNameCommit = useCallback(value => { nameCommit.current = value }, [])

  const wasAnalyzing = useRef(false)
  const viewportSize = useViewportSize()
  const [workspaceView, setWorkspaceView] = useState('playing')
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia(ROOM_COMPACT_QUERY).matches)
  const [preparingVideo, setPreparingVideo] = useState(false)

  // Share one audio element across panels so playback does not start over.
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const fileInputRef = useRef(null)

  const canvasContainerRef = useRef(null)
  const canvasContentRef = useRef(null)
  const [workspaceOverlayHost, setWorkspaceOverlayHost] = useState(null)
  const [canvasOverlayHost, setCanvasOverlayHost] = useState(null)
  const bindCanvasContent = useCallback(node => { canvasContentRef.current = node; setCanvasOverlayHost(node) }, [])

  const sceneRef = useRef(null)
  const exportFrameRef = useRef(null)
  const labelLayout = useRef(new Map())
  const {
    fullscreenButtonRef, exitFullscreenButtonRef,
    fullscreenPlayerHost, setFullscreenPlayerHost,
    expandedCanvas, fullscreenExiting, fullscreenOrientation, isFullscreen,
    enterFullscreen, rotateFullscreen, exitFullscreen
  } = useRoomFullscreen(canvasContainerRef)

  const browserMix = useBrowserMix(defaultSongData, defaultFrames, account.user?.id ?? null)

  const updateSetting = (key, value) => {
    changeViewSetting(key, value)
    browserMix.markDirty()
  }

  const songUpload = useSongUpload(browserMix.acceptSeparatedMix, !browserMix.restoring, account.user?.id ?? 'guest')
  const refreshProcessingCredits = songUpload.refreshCredits
  useEffect(() => {
    if (wasAnalyzing.current && !browserMix.processing) refreshProcessingCredits()
    wasAnalyzing.current = browserMix.processing
  }, [browserMix.processing, refreshProcessingCredits])

  const { mix: songData, framesByKey, mixId, savingNames } = browserMix
  const getFrames = useMemo(() => key => framesByKey[key] ?? [], [framesByKey])
  // Song-specific presentation belongs only to the bundled demo.
  const instruments = useMemo(() => makeInstruments(songData, getFrames, browserMix.isDemo ? defaultSongData.presentation?.labels : undefined), [songData, getFrames, browserMix.isDemo])
  const tutorialPassages = useMemo(() => Object.fromEntries(instruments.map(instrument => [instrument.key, buildTutorialPassages(getFrames(instrument.key))])), [instruments, getFrames])
  const panProfiles = useMemo(() => Object.fromEntries(instruments.map(instrument => [instrument.key,
    viewSettings.panEnabled ? instrument.panMotion : { ...instrument.panMotion, enabled: false, anchors: [] },
  ])), [instruments, viewSettings.panEnabled])

  const { uploadSong, processingMode, setProcessingMode } = songUpload
  const [mvsepResultLink, setMVSEPResultLink] = useState('')
  const [developerMode] = useState(() => isDeveloperMode(window.location.search))

  const uploading = browserMix.processing || songUpload.uploading
  const uploadName = browserMix.processing ? browserMix.name : songUpload.uploadName
  const uploadMode = browserMix.processing ? 'stems' : songUpload.uploadMode
  const progress = browserMix.processing ? browserMix.progress : songUpload.progress
  const cancelUpload = browserMix.processing ? browserMix.cancelProcessing : songUpload.cancelUpload
  const cancellingUpload = browserMix.processing ? browserMix.finalizing : songUpload.cancellingUpload
  const audioSeparationReady = AUDIO_FILE_ENABLED && songUpload.available === true && songUpload.credits?.remaining > 0
  const [uploadView, setUploadView] = useState('song')

  // Keep hidden instruments hidden for this mix; start fresh for a different mix.
  const [visibility, setVisibility] = useState(() => ({ mixId, values: initialInstrumentVisibility(instruments) }))
  const visibleInstruments = visibility.mixId === mixId ? visibility.values : initialInstrumentVisibility(instruments)
  const [hoveredKey, setHoveredKey] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)

  const pendingAccess = useRef(null), exportGuard = useRef(false)
  const [actionFocus, setActionFocus] = useState(null)

  const exportIdentity = useRef({ accountId: account.user?.id, mixId })
  useEffect(() => { exportIdentity.current = { accountId: account.user?.id, mixId } }, [account.user?.id, mixId])

  const songTitle = songData.title ?? songData.audioUrl.split('/').pop().replace(/\.[^/.]+$/, '')
  const { exportingVideo, videoProgress, downloadVideo, cancelVideo } = useVideoDownload(
    sceneRef, exportFrameRef, audioRef, songTitle,
    instruments.filter(inst => visibleInstruments[inst.key] !== false).map(inst => inst.key), getFrames, panProfiles,
  )

  const busy = uploading || exportingVideo || preparingVideo || savingNames || browserMix.restoring || libraryBusy
  const tutorial = useDemoTutorial(audioRef, browserMix.isDemo, workspaceView, (busy && !savingNames) || Boolean(libraryMode || guard || accountRequest))
  const inspector = useTutorialInspector(tutorial)
  const chooseTutorialPanel = inspector.choose
  const roomSurfaceRef = useRef(null)
  const tutorialUploadTargetRef = useRef(null)
  const navigateWorkspace = view => {
    if (tutorial.active && (TUTORIAL_INSPECTORS.includes(view) || view === 'playing')) {
      inspector.choose(view === 'playing' ? null : view)
      setWorkspaceView(view)
      return
    }
    setWorkspaceView(view)
  }
  useEffect(() => {
    if (!tutorial.active) return
    const view = inspector.panel || 'playing'
    // Use the actual existing workspace when an inspector chapter begins.
    if (isFullscreen && inspector.panel) { if (!fullscreenExiting) exitFullscreen(); return }
    if (view !== workspaceView) setWorkspaceView(view)
  }, [tutorial.active, inspector.panel, workspaceView, isFullscreen, fullscreenExiting, exitFullscreen])

  const modeView = tutorial.active && inspector.panel === 'editor' ? 'editor' : workspaceView
  const mixIsSaved = Boolean(browserMix.record && browserMix.saved && !browserMix.dirty && !pendingNameEdits)

  // ============================================================
  // ACCOUNT ACCESS AND LEAVING A DRAFT
  // ============================================================
  //
  // Help sign-in, saving and leaving a mix work together. Ask about unsaved
  // changes before replacing a mix, and save edited names before saving the mix.
  // After sign-in, return to the requested button only if the same mix or file
  // is still open. Closing the library also cancels any save waiting on it.

  useEffect(() => {
    if (!actionFocus || account.status !== 'signed-in' || busy) return
    const control = document.getElementById(actionFocus)
    if (!control || control.disabled || !control.getClientRects().length) return
    const frame = requestAnimationFrame(() => {
      control.focus({ preventScroll: true });
      setActionFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [actionFocus, account.status, busy, audioSeparationReady, workspaceView])

  const finishSignOut = () => {
    browserMix.clear()
    setLibraryMode(null)
    setWorkspaceView('playing')
  }

  const requestLeave = () => browserMix.dirty || pendingNameEdits
    ? new Promise(resolve => setGuard({ resolve }))
    : Promise.resolve(true)

  const requestAccount = (save = true, intent = null, mode = 'sign-in', returnFocusTo = document.activeElement) => {
    pendingAccess.current = intent
    afterSignIn.current = save
    setLibraryMode(null)
    setAccountRequest({ id: crypto.randomUUID(), mode, intent: intent?.kind, returnFocusTo })
  }

  const finishAccountRequest = status => {
    if (status !== 'signed-in') afterSignIn.current = false
    const intent = pendingAccess.current;
    pendingAccess.current = null

    // Ignore an old sign-in request if the user has since changed the mix or file.
    if (!intent || status !== 'signed-in' || intent.mixId !== mixId || (intent.kind === 'upload' && intent.file !== selectedFile)) return
    setWorkspaceView(intent.kind === 'upload' ? 'processing' : 'playing')
    setWorkspaceNotice(intent.kind === 'upload' ? 'Signed in. Your file is ready to upload.' : 'Signed in. Your mix is ready to download.')
    setActionFocus(intent.kind === 'upload' ? 'song-upload-submit' : 'video-download')
  }

  const closeLibrary = () => {
    if (!libraryMode) closeOverlay()
    setLibraryMode(null)
    afterSave.current?.(false)
    afterSave.current = null
  }

  const decideLeave = async choice => {
    const pending = guard;
    setGuard(null)

    if (choice === 'save') {
      // Include unfinished name edits before asking the library to save the mix.
      if (await nameCommit.current?.() === false) {
        pending.resolve(false);
        return
      };
      afterSave.current = pending.resolve;
      setLibraryMode('save')
    }
    else {
      pending.resolve(choice === 'discard');
      if (choice === 'account') requestAccount()
    }
  }

  useEffect(() => {
    if (account.status === 'signed-in' && afterSignIn.current) {
      afterSignIn.current = false;
      setLibraryMode('save')
    }
  }, [account.status])

  // ============================================================
  // ACCOUNT AND PAGE CLEANUP
  // ============================================================
  //
  // Warn before leaving the page with unsaved changes. Forget private work when
  // someone signs out or changes accounts, and clear unfinished requests when
  // the page is left or brought back through browser history. A guest signing
  // in for the first time keeps the mix they were already working on.

  useEffect(() => {
    if (!browserMix.dirty && !pendingNameEdits) return
    const warn = event => {
      event.preventDefault();
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [browserMix.dirty, pendingNameEdits])

  const clearPreviousAccount = useEffectEvent(() => {
    // An upload, download or save from the old account must not resume for the new one.
    pendingAccess.current = null;
    setActionFocus(null);
    cancelVideo()

    setSelectedFile(null);
    setWorkspaceNotice('');
    setVisibility({ mixId: 'empty', values: {} });
    setHoveredKey(null);
    audioRef.current?.pause()

    afterSave.current?.(false);
    afterSave.current = null;
    guard?.resolve(false);
    setGuard(null);
    setLibraryMode(null)
    if (workspaceView === 'account') setWorkspaceView('playing')
  })

  const resetForPageNavigation = useEffectEvent(() => {
    pendingAccess.current = null;
    setActionFocus(null);
    cancelVideo()

    audioRef.current?.pause();
    browserMix.clear();
    songUpload.suspendForNavigation()

    setSelectedFile(null);
    setWorkspaceNotice('');
    setLibraryMode(null);
    setWorkspaceView('playing')

    afterSave.current?.(false);
    afterSave.current = null;
    guard?.resolve(false);
    setGuard(null)
  })

  useEffect(() => {
    const leave = () => resetForPageNavigation()
    const resume = event => { if (event.persisted) resetForPageNavigation() }
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume)

    return () => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', resume)
    }
  }, [])

  useEffect(() => {
    const previous = previousAccount.current
    previousAccount.current = account.user?.id ?? null
    if (previous && previous !== account.user?.id) clearPreviousAccount()
  }, [account.user?.id])

  // ============================================================
  // WORKSPACE, PROGRESS AND RECOVERY
  // ============================================================
  //
  // Decide whether to show the welcome screen, an error or progress, without
  // stacking them on top of each other. Keep the chosen file available after an
  // error. Escape closes a panel and returns to its navigation button, unless
  // an open dialog or fullscreen needs to handle that key first.

  const busyProgress = uploading ? progress : videoProgress
  const roomOverlay = uploading || exportingVideo ? 'progress'
    : songUpload.failureOpen && songUpload.failure ? 'failure'
      : !browserMix.hasContent && !isFullscreen && workspaceView === 'playing' ? 'opening' : null

  const closeProcessingFailure = () => {
    songUpload.closeFailure()
    setUploadView('song')
    setWorkspaceView('processing')
  }

  useEffect(() => {
    const query = window.matchMedia(ROOM_COMPACT_QUERY)
    const update = () => setMobileLayout(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (uploading || exportingVideo || songUpload.failureOpen) setWorkspaceView('playing')
  }, [uploading, exportingVideo, songUpload.failureOpen])

  useEffect(() => {
    if (!['instruments', 'processing', 'about', 'settings', 'demo', 'github', 'editor', 'mixes', 'account'].includes(workspaceView) || isFullscreen) return
    const close = event => {
      if (event.key === 'Escape') {
        if (document.querySelector('dialog[open]')) return
        if (tutorial.active) chooseTutorialPanel(null)
        setWorkspaceView(workspaceView === 'account' ? accountReturnView.current : 'playing')
        const returnControl = workspaceView === 'account' ? document.getElementById('workspace-tab-account') : mobileLayout
          ? document.getElementById('workspace-mobile-playing')
          : document.getElementById('workspace-tab-playing')
        returnControl?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [workspaceView, isFullscreen, mobileLayout, tutorial.active, chooseTutorialPanel])


  // ============================================================
  // UPLOAD, NAME AND VIDEO ACTIONS
  // ============================================================
  //
  // Prepare a video from the full room rather than the small panel preview.
  // Uploading keeps the chosen file through sign-in, but still asks about any
  // unsaved mix before replacing it. Applying edited names pauses playback and
  // tells the Editor and any waiting save whether the changes were accepted.

  const handleDownloadVideo = async () => {
    if (busy || exportGuard.current) return
    if (account.status !== 'signed-in') {
      requestAccount(false, { kind: 'download', mixId });
      return
    }

    exportGuard.current = true
    setPreparingVideo(true)
    setWorkspaceView('playing')
    try {
      // Let the enlarged room finish resizing before recording its video.
      await waitForFullRoom(sceneRef, canvasContentRef)

      // Stop if the account or mix changed while we were waiting.
      if (exportIdentity.current.accountId !== account.user.id || exportIdentity.current.mixId !== mixId) return
      await downloadVideo()
    } catch (error) {
      alert(error.message || COPY.could_not_prepare_the_room_for_export_please_try_again)
    } finally {
      exportGuard.current = false
      setPreparingVideo(false)
    }
  }

  const handleChooseFile = () => fileInputRef.current.click()

  const handleUploadClick = async () => {
    if (busy || !selectedFile) return
    if (account.status !== 'signed-in' && (account.status !== 'guest' || songUpload.credits?.remaining <= 0)) {
      requestAccount(false, { kind: 'upload', mixId, file: selectedFile });
      return
    }

    if (await requestLeave()) uploadSong(selectedFile)
  }

  const saveMixNames = async (title, instruments) => {
    if (busy) return false
    if (!tutorial.active) audioRef.current?.pause()
    return browserMix.saveNames(title, instruments, { preserveDemoPlayback: tutorial.active && browserMix.isDemo })
  }


  // ============================================================
  // PLAYBACK, MIX AND VIEW CHANGES
  // ============================================================
  //
  // Start or pause the song, show or hide instruments, and change the open mix.
  // Changes to an instrument or view count as unsaved edits. Before replacing
  // the mix, ask whether to save or discard those edits. Canceling the file
  // picker keeps the previous file; choosing that same file again also works.

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio || busy || !browserMix.hasContent) return
    if (audio.paused) {
      try {
        await audio.play()
      } catch (error) {
        console.error(COPY.unable_to_play_audio, error)
      }
    } else {
      audio.pause()
    }
  }

  useEffect(() => {
    // Pause the song while its audio, names or video are being prepared.
    if (uploading || exportingVideo || (savingNames && !tutorial.active)) {
      audioRef.current?.pause()
      setHoveredKey(null)
      document.body.style.cursor = 'auto'
    }
  }, [uploading, exportingVideo, savingNames, tutorial.active])

  const setInstrumentVisibility = (key, visible) => {
    browserMix.markDirty()
    setVisibility(previous => ({ mixId, values: { ...(previous.mixId === mixId ? previous.values : {}), [key]: visible } }))
    if (!visible && hoveredKey === key) {
      setHoveredKey(null)
      document.body.style.cursor = 'auto'
    }
  }

  const closeOverlay = () => {
    if (tutorial.active) { inspector.choose(null); return }
    setWorkspaceView(workspaceView === 'account' ? accountReturnView.current : 'playing')
    const returnControl = mobileLayout
      ? document.getElementById('workspace-mobile-playing')
      : document.getElementById('workspace-tab-playing')
    returnControl?.focus({ preventScroll: true })
  }

  const resetView = () => {
    if (busy) return
    resetSettings()
    browserMix.markDirty()
    setVisibility({ mixId, values: initialInstrumentVisibility(instruments) })
    setHoveredKey(null)
    document.body.style.cursor = 'auto'
  }

  const switchMix = async action => {
    if (busy) return
    if (!await requestLeave()) return
    audioRef.current?.pause()
    setHoveredKey(null)
    document.body.style.cursor = 'auto'
    action()
    setWorkspaceView('playing')
  }

  const startGuidedDemo = () => {
    if (busy) return
    const begin = () => {
      audioRef.current?.pause()
      setHoveredKey(null)
      // Mount the audio source before play(), keeping playback in the click gesture.
      flushSync(() => { browserMix.loadDemo(); setWorkspaceView('playing') })
      tutorial.start()
    }
    if (browserMix.dirty || pendingNameEdits) requestLeave().then(approved => { if (approved) begin() })
    else begin()
  }
  const tutorialUpload = async () => {
    tutorial.stop()
    if (isFullscreen) await exitFullscreen()
    setWorkspaceView('processing')
    requestAnimationFrame(() => document.getElementById('room-workspace')?.focus())
  }

  const handleFileChange = (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (file) setSelectedFile(file)
  }


  // ============================================================
  // PAGE LAYOUT
  // ============================================================
  //
  // Put the navigation, room, panels and playback controls on the page. Hide
  // panels rather than recreating them, so their unfinished choices are kept.
  // The room and fullscreen controls rotate together, while the song's audio
  // element stays in place. Opening a saved mix restores its view choices too.

  return (<>
    <div data-view={workspaceView} data-tutorial={tutorial.active || undefined} data-tutorial-panel={tutorial.active ? inspector.panel || undefined : undefined} data-compact-form={viewportSize.width <= 600 && viewportSize.portrait && viewportSize.height <= 740}
      data-compact-upload={viewportSize.width <= 600 && viewportSize.portrait && viewportSize.height <= 600}
      data-keyboard={mobileLayout && viewportSize.keyboard}
      data-progress={uploading || exportingVideo} data-failure={songUpload.failureOpen}
      className={`mix-room${workspaceView !== 'playing' || uploading || exportingVideo || songUpload.failureOpen ? ' mix-room--panel' : ''}${isFullscreen ? ' mix-room--fullscreen' : ''}${fullscreenExiting ? ' mix-room--fullscreen-exiting' : ''}`}>
      <header className="mix-room__masthead">
        <div className="mix-room__brand">
          <span className="mix-room__brand-mark" aria-hidden="true"><img src="/branding/mix-room-mark.png" alt="" width="256" height="256" /></span>
          <span className="mix-room__brand-copy"><strong>{COPY.music_room}</strong><small>{COPY.spatial_audio_system}</small></span>
        </div>
        <nav className="mix-room__mode-tabs mix-room__mode-tabs--desktop" aria-label={COPY.music_room_modes}>
          <button type="button" aria-pressed={!['editor', 'demo'].includes(modeView)} disabled={busy} onClick={() => navigateWorkspace('playing')}>{COPY.visualizer}</button>
          <button id="workspace-tab-editor" type="button" aria-pressed={modeView === 'editor'} disabled={busy} onClick={() => navigateWorkspace('editor')}>{COPY.editor}</button>
          <button id="workspace-tab-demo" type="button" aria-pressed={workspaceView === 'demo'} disabled={busy} onClick={() => setWorkspaceView('demo')}>{COPY.archive}</button>
        </nav>
        <div className="mix-room__view-status" aria-label={`${COPY.z_map_relative}; ${viewSettings.depthTransparency ? COPY.view_translucent : COPY.view_opaque}`}><span>{COPY.z_map_relative}</span><span>{viewSettings.depthTransparency ? COPY.view_translucent : COPY.view_opaque}</span></div>
        <AccountAccess hidden={isFullscreen} disabled={busy} openRequest={accountRequest} accountPageOpen={workspaceView === 'account'} viewport={viewportSize}
          credits={songUpload.credits}
          onOpenAccount={() => {
            if (workspaceView !== 'account') accountReturnView.current = workspaceView;
            setWorkspaceView('account')
          }}
          onDismiss={finishAccountRequest}
          onBeforeSignOut={requestLeave} onAfterSignOut={finishSignOut} />
      </header>

      {/* Use one Save/Discard/Cancel question for unsaved changes across all panels. */}
      <DraftGuard open={Boolean(guard)} signedIn={account.status === 'signed-in'} onChoose={decideLeave} />
      {!mobileLayout && <WorkspaceNavigation workspaceView={workspaceView} setWorkspaceView={navigateWorkspace} guidedPanel={tutorial.active ? tutorial.cue?.panel : null} selectedInspector={inspector.panel} mobileLayout={false} uploadTargetRef={tutorialUploadTargetRef} disabled={uploading || exportingVideo || preparingVideo || songUpload.failureOpen} />}
      {mobileLayout && <nav className="mix-room__mode-tabs mix-room__mode-tabs--mobile" aria-label={COPY.music_room_modes}>
        <button id="workspace-mobile-playing" type="button" aria-pressed={!['editor', 'demo'].includes(modeView)} disabled={busy} onClick={() => navigateWorkspace('playing')}>{COPY.visualizer}</button>
        <button id="workspace-mobile-editor" type="button" aria-pressed={modeView === 'editor'} disabled={busy} onClick={() => navigateWorkspace('editor')}>{COPY.editor}</button>
        <button id="workspace-mobile-demo" type="button" aria-pressed={workspaceView === 'demo'} disabled={busy} onClick={() => setWorkspaceView('demo')}>{COPY.archive}</button>
      </nav>}
      <main ref={setWorkspaceOverlayHost} id="room-workspace" className={`mix-room__workspace mix-room__workspace--${workspaceView}`} tabIndex={mobileLayout ? -1 : undefined}
        role={mobileLayout ? undefined : 'tabpanel'}
        aria-labelledby={workspaceView === 'github' ? 'workspace-overlay-title' : workspaceView === 'account' || !mobileLayout ? `workspace-tab-${workspaceView}` : `workspace-mobile-${workspaceView}`}>

        {/* Keep the room here while panels change, so switching views does not restart it. */}
        <div ref={canvasContainerRef} tabIndex={-1} className={`mix-room__canvas${expandedCanvas ? ' mix-room__canvas--expanded' : ''}`} data-fullscreen-orientation={isFullscreen ? fullscreenOrientation : undefined} aria-busy={uploading || exportingVideo}>
          <div ref={bindCanvasContent} className="mix-room__canvas-content" data-guide-portrait={isFullscreen && fullscreenOrientation === 'portrait'}>
            <div ref={roomSurfaceRef} className="mix-room__room-surface">
            <RoomScene canvasContentRef={roomSurfaceRef} workspaceView={workspaceView} isFullscreen={isFullscreen}
              mobileLayout={mobileLayout} exportingVideo={exportingVideo} uploading={uploading} hasContent={browserMix.hasContent}
              fullscreenOrientation={fullscreenOrientation} sceneRef={sceneRef} viewSettings={viewSettings}
              instruments={instruments} visibleInstruments={visibleInstruments} getFrames={getFrames}
              exportFrameRef={exportFrameRef} audioRef={audioRef} panProfiles={panProfiles}
              hoveredKey={hoveredKey} setHoveredKey={setHoveredKey} labelLayout={labelLayout} mixId={mixId}
              tutorialCue={tutorial.cue} tutorialPassages={tutorialPassages} />
          {mobileLayout && browserMix.hasContent && workspaceView === 'playing' && !isFullscreen && !busy && <button type="button" className="mix-room__mobile-canvas-expand" onClick={enterFullscreen} aria-label={COPY.enter_fullscreen} title={COPY.enter_fullscreen} />}
            </div>

            {isFullscreen && (
              <FullscreenControls surfaceRef={canvasContainerRef}>
                <div className="mix-room__fullscreen-player" ref={setFullscreenPlayerHost} />
                {browserMix.isDemo && !tutorial.active && <><button type="button" className="mix-room__fullscreen-control mix-room__tutorial-replay" disabled={busy} onClick={startGuidedDemo}>Replay demo</button><button type="button" className="mix-room__fullscreen-control mix-room__tutorial-replay" disabled={busy} onClick={tutorialUpload}>Upload tracks</button></>}
                {mobileLayout && <button
                  type="button"
                  className="mix-room__fullscreen-control mix-room__rotate-fullscreen"
                  onClick={rotateFullscreen}
                  disabled={fullscreenExiting}
                  aria-label={fullscreenOrientation === 'portrait' ? COPY.switch_to_landscape : COPY.switch_to_portrait}
                  title={fullscreenOrientation === 'portrait' ? COPY.switch_to_landscape : COPY.switch_to_portrait}
                  aria-pressed={fullscreenOrientation === 'landscape'}
                >
                  <RotationIcon />
                </button>}
                <button
                  ref={exitFullscreenButtonRef}
                  type="button"
                  className="mix-room__fullscreen-control mix-room__exit-fullscreen"
                  onClick={exitFullscreen}
                  disabled={fullscreenExiting}
                  aria-label={COPY.exit_fullscreen}
                  title={COPY.exit_fullscreen_esc}
                >
                  <FullscreenIcon exit />
                </button>
              </FullscreenControls>
            )}
            {roomOverlay === 'opening' && <section className="mix-room__opening" aria-labelledby="opening-room-title">
              <h2 id="opening-room-title">Welcome to Mix Room!</h2>
              {account.status === 'checking' || browserMix.restoring ? <p role="status">Checking your account and local workspace…</p> : <>
                <div className="mix-room__opening-actions">
                  <button type="button" onClick={startGuidedDemo}>Play tutorial</button>
                  <button type="button" onClick={() => setWorkspaceView('processing')}>Upload track</button>
                </div>
                {account.status === 'guest' && <div className="mix-room__guest-info">
                  <p>{mobileLayout ? 'Guests get one audio file analysis and one stem analysis.' : 'Without an account, you can try one audio file analysis and one stem analysis.'}</p>
                  <div className="mix-room__guest-modes">
                    <article className="mix-room__guest-mode-card"><h3>Audio file analysis</h3><p>Your song is separated into stems, then analyzed to build your room.</p></article>
                    <article className="mix-room__guest-mode-card"><h3>Stem analysis</h3><p>Upload your own stems and analysis begins immediately.</p></article>
                  </div>
                  <button type="button" className="mix-room__guest-signup" onClick={event => requestAccount(false, null, 'sign-up', event.currentTarget)}><span className="mix-room__guest-signup-detail">Create an account for unlimited stem analysis and up to three audio file analyses</span><span className="mix-room__guest-signup-short">Create account</span> <span aria-hidden="true">→</span></button>
                </div>}
                {account.status === 'signed-in' && <button type="button" className="mix-room__opening-library" onClick={() => setWorkspaceView('mixes')}><span>{COPY.my_mixes}</span><span aria-hidden="true">→</span></button>}
                {import.meta.env.DEV && developerMode && <div className="mix-room__opening-actions"><button type="button" onClick={() => backupInput.current?.click()}>Open a mix backup</button></div>}
                {browserMix.legacy && <div className="mix-room__legacy">
                  <strong>An older mix is stored in this browser</strong>
                  <span>It has not been attached to any account. Keep a backup before deleting the local copy.</span>
                  <div className="mix-room__opening-actions">
                    <button type="button" onClick={browserMix.openLegacy}>Open for this visit</button>
                    <button type="button" onClick={() => {
                      try {
                        downloadMixBackup(browserMix.legacy)
                      } catch (error) {
                        setWorkspaceNotice(error.message)
                      }
                    }}>Download older mix backup</button>
                    <button type="button" onClick={async () => {
                      if (window.confirm('Delete the older browser copy? Keep a backup first. This cannot be undone.')) {
                        try {
                          await browserMix.deleteLegacy()
                        } catch (error) {
                          setWorkspaceNotice(error.message)
                        }
                      }
                    }}>Delete local copy…</button>
                  </div>
                </div>}
                {(workspaceNotice || browserMix.notice) && <p role="status">{workspaceNotice || browserMix.notice}</p>}
              </>}
            </section>}

            {roomOverlay === 'failure' && <ProcessingFailure failure={songUpload.failure} developerMode={developerMode} onRetry={songUpload.retryLoading} onClose={closeProcessingFailure} />}

            {roomOverlay === 'progress' && (
              <div className="mix-room__loading">
                <div className="mix-room__loading-content">
                  <p className="mix-room__loading-eyebrow">{uploading ? (uploadMode === 'stems' ? COPY.analyzing_your_stems : uploadMode === 'existing' ? COPY.loading_your_mvsep_result : formatCopy(COPY.preparing_your_mix, { value1: uploadMode === 'thorough' ? COPY.thorough : THOROUGH_AVAILABLE ? COPY.quick : COPY.six_stem_separation })) : COPY.exporting_video}</p>
                  <h2 className="mix-room__loading-title">{uploading ? uploadName : songTitle}</h2>
                  <p className="mix-room__loading-stage" role="status">{busyProgress.message}</p>
                  <div
                    className="mix-room__progress"
                    role="progressbar"
                    aria-label={uploading ? COPY.song_processing : COPY.video_export}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.floor(busyProgress.percent)}
                  >
                    <div className="mix-room__progress-fill" style={{ width: `${busyProgress.percent}%` }} />
                  </div>
                  <p className="mix-room__loading-percent">{Math.floor(busyProgress.percent)}%</p>
                  {uploading && <button type="button" className="mix-room__loading-cancel" onClick={cancelUpload} disabled={cancellingUpload}>{browserMix.finalizing ? 'Finishing…' : cancellingUpload ? 'Cancelling…' : COPY.cancel_processing}</button>}
                  {exportingVideo && <button type="button" className="mix-room__loading-cancel" onClick={cancelVideo}>{COPY.cancel_export}</button>}
                </div>
              </div>
            )}

            {/* Rotate these buttons with the room; moving the buttons must not restart the song. */}

          </div>
          {['processing', 'account'].includes(workspaceView) && !isFullscreen && <button type="button" className="mix-room__preview-expand" onClick={() => setWorkspaceView('playing')} aria-label={COPY.expand_room_preview}><span>{COPY.live_room_enlarge}</span></button>}
        </div>
            <div className="mix-room__ordinary-panels">
              <div data-guide-panel="instruments">
        <InstrumentVisibilityPanel hidden={workspaceView !== 'instruments'}
          instruments={instruments} visibleInstruments={visibleInstruments} setInstrumentVisibility={setInstrumentVisibility}
          exportingVideo={exportingVideo} viewSettings={viewSettings} updateSetting={updateSetting} closeOverlay={closeOverlay} />
              </div>
              <div data-guide-panel="editor">
        <MixEditor key={mixId} hidden={workspaceView !== 'editor'} currentMix={songData} hasContent={browserMix.hasContent}
          disabled={busy} savingNames={savingNames} onSaveNames={saveMixNames} onClose={closeOverlay}
          onEditStateChange={setPendingNameEdits} registerNameCommit={registerNameCommit} />
              </div>
              <div data-guide-panel="settings">
        <WorkspaceOverlay view="settings" hidden={workspaceView !== 'settings'} onClose={closeOverlay}
          settings={viewSettings} updateSetting={updateSetting} onResetView={resetView}
          onLoadDemo={browserMix.isDemo ? () => setWorkspaceView('playing') : startGuidedDemo} onReplayTutorial={startGuidedDemo} onRestoreMix={() => switchMix(browserMix.restoreSavedMix)}
          isDemo={browserMix.isDemo} hasSavedMix={browserMix.hasSavedMix} disabled={busy} demoTitle={defaultSongData.title}
          demoArtist={defaultSongData.artist} demoCredits={defaultSongData.credits}
        />              </div>
            </div>
        {workspaceView === 'account' && !isFullscreen && account.status === 'signed-in' && <AccountPage key={`account-${account.user.id}`} account={account} credits={songUpload.credits} disabled={busy}
          onClose={() => { closeOverlay(); document.getElementById('workspace-tab-account')?.focus({ preventScroll: true }) }}
          onMixes={() => setWorkspaceView('mixes')} onBeforeSignOut={requestLeave}
          onAfterSignOut={finishSignOut} />}

        <UploadPanel hidden={workspaceView !== 'processing' || isFullscreen} busy={busy}
          account={account} songUpload={songUpload} browserMix={browserMix} uploadView={uploadView} setUploadView={setUploadView}
          developerMode={developerMode} processingMode={processingMode} setProcessingMode={setProcessingMode}
          selectedFile={selectedFile} fileInputRef={fileInputRef} handleFileChange={handleFileChange} handleChooseFile={handleChooseFile}
          mvsepResultLink={mvsepResultLink} setMVSEPResultLink={setMVSEPResultLink} handleUploadClick={handleUploadClick}
          uploading={uploading} audioSeparationReady={audioSeparationReady} mixId={mixId}
          requestAccount={requestAccount} requestLeave={requestLeave} closeOverlay={closeOverlay} />

        {/* Keep unfinished names when changing panels, but reset the Editor for a different mix. */}


        {!isFullscreen && <WorkspaceOverlay view={workspaceView === 'settings' ? null : workspaceView} onClose={closeOverlay}
          settings={viewSettings} updateSetting={updateSetting} onResetView={resetView}
          onLoadDemo={browserMix.isDemo ? () => setWorkspaceView('playing') : startGuidedDemo} onReplayTutorial={startGuidedDemo} onRestoreMix={() => switchMix(browserMix.restoreSavedMix)}
          isDemo={browserMix.isDemo} hasSavedMix={browserMix.hasSavedMix} disabled={busy} demoTitle={defaultSongData.title}
          demoArtist={defaultSongData.artist} demoCredits={defaultSongData.credits}
        />}

        {/* Changing accounts starts a fresh library view, so the old account's list is not kept. */}
        <MixLibrary key={account.user?.id ?? 'guest'} mode={libraryMode || (!isFullscreen && workspaceView === 'mixes' ? 'list' : null)} account={account} draft={browserMix} view={{ settings: viewSettings, visibility: visibleInstruments }} requestLeave={requestLeave}
          onBusy={setLibraryBusy} onSignIn={() => requestAccount(libraryMode === 'save')}
          onUpload={() => setWorkspaceView('processing')} onClose={closeLibrary}
          onShow={() => {
            setLibraryMode(null);
            setWorkspaceView('mixes')
          }}
          onSaved={() => {
            setLibraryMode(null);
            setWorkspaceView('playing');
            setWorkspaceNotice('');
            const done = afterSave.current;
            afterSave.current = null;
            done?.(true)
          }}
          onOpened={(decoded, row, ownerId) => {
            audioRef.current?.pause();
            const openedId = browserMix.loadRecord(decoded.record, row, ownerId);
            if (!openedId) return;
            restoreSettings(decoded.view.settings);
            setVisibility({ mixId: openedId, values: decoded.view.visibility });
            setLibraryMode(null);
            setWorkspaceView('playing')
          }} />
      </main>

      {tutorial.active && (isFullscreen ? canvasOverlayHost : workspaceOverlayHost) && createPortal(<>
        <DemoTutorial tutorial={tutorial} onUpload={tutorialUpload} onReplay={startGuidedDemo} inspector={inspector} view={workspaceView} />
        <button className="mix-room__tutorial-skip" type="button" onClick={tutorial.stop}>Skip tutorial</button>
      </>, isFullscreen ? canvasOverlayHost : workspaceOverlayHost)}

      <footer className="mix-room__toolbar mix-room__bottom-toolbar" aria-label={COPY.playback_controls}>
        <div className="mix-room__toolbar-section mix-room__player-section mix-room__controls">
          <div className="mix-room__track-title">{browserMix.hasContent && <><h2 className="mix-room__title" title={songTitle}>{songTitle}</h2>{(browserMix.isDemo || browserMix.dirty || pendingNameEdits) && <small>{browserMix.isDemo ? COPY.track_demo_source : 'Not saved'}</small>}</>}<span className="mix-room__save-status" role="status">{workspaceNotice}</span>{browserMix.isDemo && !tutorial.active && <button className="mix-room__tutorial-replay" type="button" disabled={busy} onClick={startGuidedDemo}>Replay demo</button>}{browserMix.isDemo && !tutorial.active && <button className="mix-room__tutorial-replay" type="button" disabled={busy} onClick={tutorialUpload}>Upload tracks</button>}</div>
          <AudioPlayer audioRef={audioRef} src={songData.audioUrl} playing={playing} onPlayingChange={setPlaying} onTogglePlayback={togglePlayback} onSeek={tutorial.seek} disabled={busy || !browserMix.hasContent} loop={viewSettings.loop} controlsHost={fullscreenPlayerHost} />

          <div className="mix-room__top-actions">
            <button
              type="button"
              className="mix-room__icon-button mix-room__labeled-button"
              data-saved={mixIsSaved}
              disabled={busy || !browserMix.record || mixIsSaved}
              onClick={async () => { if (await nameCommit.current?.() !== false) setLibraryMode('save') }}
              aria-label={mixIsSaved ? 'Saved' : 'Save mix'}
              title={mixIsSaved ? 'Mix saved to your account' : 'Save mix to your account'}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d={mixIsSaved ? 'm5 12 4 4L19 6' : 'M12 5v14M5 12h14'} />
              </svg>
              <small>{mixIsSaved ? 'Saved' : 'Save mix'}</small>
            </button>
            <button
              id="video-download"
              type="button"
              className="mix-room__icon-button mix-room__labeled-button"
              onClick={handleDownloadVideo}
              disabled={busy || !browserMix.hasContent}
              aria-label={account.status === 'signed-in' ? COPY.download_room_video : 'Sign in to download'}
              title={account.status === 'signed-in' ? COPY.export_and_download_room_video : 'Sign in to download this video'}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5" />
              </svg>
              <small>{mobileLayout ? 'Download' : account.status === 'signed-in' ? 'Download video' : 'Sign in to download'}</small>
            </button>
            <button
              ref={fullscreenButtonRef}
              type="button"
              className="mix-room__icon-button mix-room__fullscreen-button mix-room__labeled-button"
              onClick={enterFullscreen}
              disabled={exportingVideo || preparingVideo || !browserMix.hasContent || (tutorial.active && Boolean(inspector.panel))}
              aria-label={COPY.enter_fullscreen}
              title={tutorial.active && inspector.panel ? 'Close the panel to expand the room' : COPY.enter_fullscreen}
            >
              <FullscreenIcon />
              <small>{mobileLayout ? 'Expand' : COPY.expand}</small>
            </button>
          </div>
        </div>

      </footer>

      {mobileLayout && <WorkspaceNavigation workspaceView={workspaceView} setWorkspaceView={navigateWorkspace} guidedPanel={tutorial.active ? tutorial.cue?.panel : null} selectedInspector={inspector.panel} mobileLayout portrait={viewportSize.portrait} uploadTargetRef={tutorialUploadTargetRef} disabled={busy || songUpload.failureOpen} />}
      <input ref={backupInput} type="file" accept=".mixroom,application/octet-stream" hidden aria-label="Choose a Mix Room backup" onChange={async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || !await requestLeave()) return

        try {
          const decoded = await readMixArchive(file);
          const openedId = browserMix.loadRecord(decoded.record, null, account.user?.id ?? null);
          if (!openedId) return;
          restoreSettings(decoded.view.settings);
          setVisibility({ mixId: openedId, values: decoded.view.visibility });
          setWorkspaceView('playing')
        }
        catch (error) {
          setWorkspaceNotice(error.message)
        }
      }} />
    </div>
    <GitHubLink hidden={isFullscreen || mobileLayout} disabled={busy} expanded={workspaceView === 'github'} onClick={() => setWorkspaceView(workspaceView === 'github' ? 'playing' : 'github')} />
  </>)
}

export default App
