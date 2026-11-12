import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { createFixedLabelLayout } from './fixedLabelLayout.js'

export default function InstrumentLabelLayout({ labels, instrumentCount }) {
  const layout = useMemo(() => createFixedLabelLayout(), [])
  const exported = useRef(null)

  useFrame(({ camera, size, scene }) => {
    const exporting = scene.userData.mixRoomExport
    if (exporting && exported.current?.context !== exporting) exported.current = { context: exporting, layout: createFixedLabelLayout() }
    const apply = exporting ? exported.current.layout : layout
    const entries = [...labels.current.entries()].filter(([, entry]) => entry.anchor?.parent && entry.text && entry.centerWorld)
    const ready = entries.length === instrumentCount && apply(entries, exporting?.camera ?? camera, exporting?.width ?? size.width, exporting?.height ?? size.height)
    for (const [, entry] of entries) entry.anchor.visible = ready && entry.showLabel
  })
  return null
}
