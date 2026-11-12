import { useId } from 'react'
import { useFrame } from '@react-three/fiber'
import { inTutorialPassage } from '../demo/tutorialPassages.js'
import { projectTutorialTarget } from './tutorialProjection.js'

export function TutorialProjection({ labels, targets, paths, svg, passages, audioRef }) {
  useFrame(({ camera, size }) => {
    camera.updateWorldMatrix(true, false)
    for (const key of targets) {
      const active = inTutorialPassage(passages[key], audioRef.current?.currentTime ?? 0)
      const projected = active ? projectTutorialTarget(labels.current.get(key), camera, size.width, size.height) : null
      const nodes = paths.current.get(key)
      nodes?.shape?.setAttribute('d', projected?.shape || '')
      nodes?.label?.setAttribute('d', projected?.label || '')
    }
    svg.current?.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`)
  })
  return null
}

export default function TutorialSpotlight({ targets, veil, paths, svg }) {
  const mask = `tutorial-${useId().replaceAll(':', '')}`
  return <svg ref={svg} className="mix-room__tutorial-veil" aria-hidden="true" data-visible={veil}>
    <defs><mask id={mask} maskUnits="userSpaceOnUse" style={{ maskType: 'luminance' }}>
      <rect width="100%" height="100%" fill="white" />
      {targets.map(key => <g key={key} fill="black" stroke="black" strokeWidth="28" strokeLinejoin="round" data-tutorial-target={key}>
        <path ref={node => { const value = paths.current.get(key) || {}; value.shape = node; paths.current.set(key, value) }} data-part="shape" />
        <path ref={node => { const value = paths.current.get(key) || {}; value.label = node; paths.current.set(key, value) }} data-part="label" />
      </g>)}
    </mask></defs>
    <rect width="100%" height="100%" fill="rgba(83,91,99,.65)" mask={`url(#${mask})`} />
  </svg>
}
