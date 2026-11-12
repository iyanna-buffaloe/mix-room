import { useRef, useState } from 'react'
import { COPY } from '../config/siteCopy.js'

const WORKSPACE_TABS = [
  { view: 'playing', label: COPY.now_playing },
  { view: 'instruments', label: COPY.visible_instruments },
  { view: 'processing', label: COPY.upload_tracks },
  { view: 'mixes', label: COPY.my_mixes },
  { view: 'about', label: COPY.information },
  { view: 'settings', label: COPY.preferences },
]
const MOBILE_DESTINATIONS = WORKSPACE_TABS.filter(({ view }) => view === 'processing' || view === 'mixes')
const ROOM_TOOLS = WORKSPACE_TABS.filter(({ view }) => ['instruments', 'settings', 'about'].includes(view))

export default function WorkspaceNavigation({ workspaceView, setWorkspaceView, mobileLayout, portrait, disabled, uploadTargetRef, guidedPanel, selectedInspector }) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsButton = useRef(null)
  const activeView = selectedInspector || workspaceView
  const activeTool = ROOM_TOOLS.find(tab => tab.view === activeView)
  const guidedTools = ['instruments', 'settings'].includes(guidedPanel)
  const showTools = (toolsOpen || guidedTools) && !portrait && !disabled

  const chooseMobileView = view => {
    setToolsOpen(false)
    setWorkspaceView(view)
    if (!guidedPanel) requestAnimationFrame(() => document.getElementById('room-workspace')?.focus())
  }

  const handleTabKey = (event, index) => {
    const direction = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? WORKSPACE_TABS.length - 1 : direction ? (index + direction + WORKSPACE_TABS.length) % WORKSPACE_TABS.length : null
    if (next === null) return
    event.preventDefault()
    setWorkspaceView(WORKSPACE_TABS[next].view)
    document.getElementById(`workspace-tab-${WORKSPACE_TABS[next].view}`)?.focus({ preventScroll: true })
  }

  const renderTab = (tab, index) => <button
    key={tab.view} id={`workspace-tab-${tab.view}`} type="button" role="tab"
    aria-selected={activeView === tab.view} aria-controls="room-workspace" aria-label={tab.label} title={tab.label}
    tabIndex={activeView === tab.view ? 0 : -1}
    disabled={disabled} ref={tab.view === 'processing' ? uploadTargetRef : undefined}
    onClick={() => setWorkspaceView(tab.view)} onKeyDown={event => handleTabKey(event, index)}
  ><span className="mix-room__tab-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span className="mix-room__tab-label">{tab.label}</span></button>

  const mobileDestination = ({ view, label }) => <button
    key={view} id={`workspace-mobile-${view === 'playing' ? 'now-playing' : view}`} type="button"
    aria-current={activeView === view ? 'page' : undefined}
    aria-controls="room-workspace" disabled={disabled} ref={view === 'processing' ? uploadTargetRef : undefined}
    onClick={() => chooseMobileView(view)}
  >{label}</button>

  if (mobileLayout) return (
    <nav className="mix-room__navigation" aria-label={COPY.music_room_views}>
      <div className="mix-room__mobile-navigation" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setToolsOpen(false)
      }} onKeyDown={event => {
        if (event.key === 'Escape' && showTools) {
          event.stopPropagation()
          setToolsOpen(false)
          toolsButton.current?.focus()
        }
      }}>
        {(portrait ? WORKSPACE_TABS : MOBILE_DESTINATIONS).map(mobileDestination)}
        {!portrait && <>
          <button ref={toolsButton} type="button" aria-expanded={showTools} aria-controls="workspace-room-tools"
            data-active={Boolean(activeTool)} disabled={disabled} onClick={() => setToolsOpen(open => !open)}>
            Room tools <span aria-hidden="true">⌃</span>
          </button>
          <div id="workspace-room-tools" className="mix-room__room-tools" data-guided={guidedTools} hidden={!showTools}>
            {ROOM_TOOLS.map(mobileDestination)}
          </div>
        </>}
      </div>
    </nav>
  )

  return (
    <nav className="mix-room__navigation" aria-label={COPY.music_room_views}>
      <div className="mix-room__tabs" role="tablist" aria-label={COPY.workspace} aria-orientation="vertical">
        <div className="mix-room__primary-tabs">{WORKSPACE_TABS.slice(0, 4).map(renderTab)}</div>
        <div className="mix-room__utility-tabs">{WORKSPACE_TABS.slice(4).map((tab, index) => renderTab(tab, index + 4))}</div>
      </div>
    </nav>
  )
}
