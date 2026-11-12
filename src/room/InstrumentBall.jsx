import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text, Billboard } from '@react-three/drei'
import * as THREE from 'three'
import { getBubbleVisibility, depthOpacity } from './audioVisuals.js'
import { STEREO_LAYOUT, stereoImageShape } from './stereoImage.js'
import { panMotionX } from './panMotion.js'
import { labelPanBias } from './labelLayout.js'

// Labels in the room load their own font, separately from the page's buttons.
const INSTRUMENT_FONT = '/fonts/Arimo-Regular.ttf'

// ============================================================
// HIDDEN-BUBBLE HIT TESTING
// ============================================================
//
// Ignore mouse and touch hits on hidden or silent bubbles. That lets the user
// reach a visible bubble behind them. Visible bubbles keep their usual hit checks.
const ignoreRaycast = () => {}

// ============================================================
// INSTRUMENT BUBBLE AND LABEL
// ============================================================
//
// Draw one instrument's bubble and label, and highlight it when pointed at.
// Move the label with its bubble so they do not drift apart. When making a
// video, use the recorder's audio measurements instead of live playback time.

export default function InstrumentBall({
  labelLayout, instrumentKey, shown, exportFrameRef,
  label, labelScale = 1, color, position, radius, stereoWidth, stereoPan,
  panMotion, framePan, loudness, viewSettings,
  isHovered, onHoverStart, onHoverEnd
}) {
  const ballGroup = useRef(null)
  const sphereRef = useRef(null)
  const textRef = useRef(null)
  const labelAnchor = useRef(null)
  const centerWorld = useMemo(() => new THREE.Vector3(), [])
  const layoutCenterWorld = useMemo(() => new THREE.Vector3(), [])

  // Remove this label when its bubble leaves, so an old mix's labels cannot linger.
  useEffect(() => () => { labelLayout.current.delete(instrumentKey) }, [labelLayout, instrumentKey])
  const centerX = position[0]

  // Keep the shape steady; move it only when the sound clearly travels left or right.
  const shape = useMemo(() => stereoImageShape(stereoPan, stereoWidth, radius, centerX), [stereoPan, stereoWidth, radius, centerX])

  // Keep labels readable even on smaller bubbles, such as vocals.
  const labelFontSize = THREE.MathUtils.clamp(0.32 + (radius - 0.8) * 0.05, 0.32, 0.38) * viewSettings.labelScale * labelScale
  const visibility = getBubbleVisibility(loudness, viewSettings)
  const isVisible = shown && visibility > 0
  const opacity = visibility

  // If a pointed-at instrument goes silent or is hidden, remove its highlight
  // and hand cursor even if the user has not moved the pointer away.
  useEffect(() => {
    if (!isVisible && isHovered) {
      onHoverEnd()
      document.body.style.cursor = 'auto'
    }
  }, [isVisible, isHovered, onHoverEnd])

  // Update the bubble before arranging the labels. Use the same moment in the
  // song for its position, brightness and label, so they stay together.
  useFrame(() => {
    if (!ballGroup.current || !labelAnchor.current) return
    const exportFrame = exportFrameRef.current?.[instrumentKey]
    ballGroup.current.position.x = panMotionX(shape, panMotion, exportFrame?.pan ?? framePan, STEREO_LAYOUT.panScale)
    sphereRef.current.scale.x = shape.radii[0] / radius
    const level = exportFrame?.loud ?? loudness
    const frameVisibility = shown ? getBubbleVisibility(level, viewSettings) : 0
    ballGroup.current.visible = frameVisibility > 0
    sphereRef.current.material.opacity = frameVisibility

    // Pointing at a bubble helps while editing, but must not highlight the downloaded video.
    if (!isHovered || exportFrame) sphereRef.current.material.opacity *= depthOpacity(position[2], viewSettings)
    sphereRef.current.material.emissiveIntensity = isHovered && !exportFrame ? 0.5 : 0
    if (textRef.current) textRef.current.fillOpacity = frameVisibility

    // Leave room for each label, then move it with its own bubble. Use the same
    // left/right measurement for both, so the label stays beside the right sound.
    centerWorld.set(ballGroup.current.position.x, position[1], position[2])
    ballGroup.current.parent.localToWorld(centerWorld)
    layoutCenterWorld.set(shape.x, position[1], position[2])
    ballGroup.current.parent.localToWorld(layoutCenterWorld)
    labelLayout.current.set(instrumentKey, { anchor: labelAnchor.current, text: textRef.current,
      centerWorld, layoutCenterWorld, radiusX: shape.radii[0], radiusY: radius, visible: frameVisibility > 0,
      referencePanBias: labelPanBias(stereoPan), panBias: labelPanBias(panMotion.enabled ? exportFrame?.pan ?? framePan : stereoPan),
      label, fontSize: labelFontSize, showLabel: viewSettings.showLabels })
  }, -1)

  return (
    <group ref={ballGroup} name={`instrument-${instrumentKey}`} position={position} visible={isVisible}>
      <mesh
        ref={sphereRef}
        raycast={isVisible ? THREE.Mesh.prototype.raycast : ignoreRaycast}
        onPointerOver={(e) => { e.stopPropagation(); onHoverStart(); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { onHoverEnd(); document.body.style.cursor = 'auto' }}
      >
        <sphereGeometry args={[radius, 32, 32]} />
        <meshStandardMaterial
          color={color}
          roughness={0.6}
          transparent
          opacity={opacity * depthOpacity(position[2], viewSettings)}
          depthWrite={!viewSettings.depthTransparency}
          emissive={color}
          emissiveIntensity={isHovered ? 0.5 : 0}
        />
      </mesh>

      {/* Face the label toward the camera; label placement keeps it near its bubble. */}
      <Billboard name={`instrument-label-${instrumentKey}`} ref={labelAnchor} visible={viewSettings.showLabels}>
        <Text
          ref={textRef}
          font={INSTRUMENT_FONT}
          position={[0, 0, 0]}
          fontSize={labelFontSize}
          color="white"
          textAlign="center"
          anchorX="center"
          anchorY="middle"
          fillOpacity={visibility}
          material-depthTest={!viewSettings.depthTransparency}
          material-depthWrite={false}
          renderOrder={10}
        >
          {label}
        </Text>
      </Billboard>
    </group>
  )
}
