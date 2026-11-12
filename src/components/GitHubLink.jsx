import { COPY } from '../config/siteCopy.js'

export default function GitHubLink({ hidden = false, onClick, expanded = false, disabled = false }) {
  return <button type="button" onClick={onClick} aria-expanded={expanded} aria-controls="workspace-overlay-title" disabled={disabled} className="mix-room__github-link" hidden={hidden} aria-label={COPY.music_room_on_github} title={COPY.music_room_on_github}>
    <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.542v-2.095c-3.13.68-3.791-1.508-3.791-1.508-.512-1.3-1.25-1.647-1.25-1.647-1.023-.7.077-.685.077-.685 1.132.08 1.727 1.162 1.727 1.162 1.006 1.724 2.64 1.225 3.283.937.102-.728.394-1.226.715-1.508-2.499-.284-5.126-1.25-5.126-5.563 0-1.23.44-2.235 1.16-3.023-.116-.284-.503-1.43.11-2.981 0 0 .945-.303 3.094 1.155A10.78 10.78 0 0 1 12 6.01c.957.004 1.92.13 2.819.379 2.147-1.458 3.09-1.155 3.09-1.155.615 1.55.228 2.697.112 2.981.722.788 1.159 1.793 1.159 3.023 0 4.324-2.63 5.275-5.137 5.553.404.35.765 1.034.765 2.084v3.256c0 .3.203.65.774.54A11.251 11.251 0 0 0 12 .75Z" /></svg>
    <span aria-hidden="true">GitHub →</span>
  </button>
}
