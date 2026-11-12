import { Canvas } from '@react-three/fiber'
import { useRef } from 'react'
import { ContactShadows } from '@react-three/drei'
import { useAudioFrame } from '../hooks/useAudioFrame.js'
import { RoomViewport, RoomCamera, RoomBackground } from './RoomViewport.jsx'
import { ROOM_CAMERA } from './roomViewport.js'
import { clampToRoom } from './instrumentSetup.js'
import { roomStyle } from './roomStyles.js'
import Room from './Room.jsx'
import InstrumentBall from './InstrumentBall.jsx'
import InstrumentLabelLayout from './InstrumentLabelLayout.jsx'
import TutorialSpotlight, { TutorialProjection } from './TutorialSpotlight.jsx'

// ============================================================
// LIVE INSTRUMENT ADAPTER
// ============================================================
//
// Give one instrument bubble the audio measurements for the current moment in
// the song. While recording a video, the recorder chooses those moments instead.

function AnimatedInstrument({
  labelLayout, instrument, shown, frames, exportFrameRef, audioRef,
  uploading, viewSettings, panMotion, isHovered, onHoverStart, onHoverEnd
}) {
  const frame = useAudioFrame(audioRef, frames, !uploading, panMotion)
  const position = clampToRoom([instrument.baseX, instrument.baseY, instrument.baseZ], instrument.radius)
  return (
    <InstrumentBall
      labelLayout={labelLayout}
      instrumentKey={instrument.key}
      shown={shown}
      exportFrameRef={exportFrameRef}
      label={instrument.label}
      labelScale={instrument.labelScale}
      color={instrument.color}
      position={position}
      radius={instrument.radius}
      stereoWidth={instrument.width}
      stereoPan={instrument.pan}
      panMotion={panMotion}
      framePan={frame.pan}
      loudness={frame.loud}
      viewSettings={viewSettings}
      isHovered={isHovered}
      onHoverStart={onHoverStart}
      onHoverEnd={onHoverEnd}
    />
  )
}

// ============================================================
// SCENE ASSEMBLY
// ============================================================
//
// Build the picture: camera, room, instrument bubbles and labels. App still
// handles accounts and uploads. Live playback redraws as the song moves; the
// video recorder controls drawing when making a download.
//
// Keep each bubble while changing panels, and start label placement fresh when
// another mix opens. Phone previews use less detailed shadows to save work;
// downloaded videos keep the full shadow detail.

export default function RoomScene({
  canvasContentRef, workspaceView, isFullscreen, mobileLayout,
  exportingVideo, uploading, hasContent, fullscreenOrientation,
  sceneRef, viewSettings, instruments, visibleInstruments, getFrames,
  exportFrameRef, audioRef, panProfiles, hoveredKey, setHoveredKey, labelLayout, mixId,
  tutorialCue, tutorialPassages
}) {
  const spotlight = { paths: useRef(new Map()), svg: useRef(null) }
  return (
    <RoomViewport containerRef={canvasContentRef} contained={['processing', 'account'].includes(workspaceView) && !isFullscreen} fill={mobileLayout || isFullscreen || ['processing', 'account'].includes(workspaceView)}>
      <Canvas
        camera={ROOM_CAMERA}
        // Measure the room before it is turned sideways on a phone.
        resize={{ offsetSize: true }}
        onCreated={state => {
          sceneRef.current = state
        }}
        frameloop={exportingVideo ? 'never' : uploading || !hasContent ? 'demand' : 'always'}
      >
        <RoomCamera fit={mobileLayout || (['processing', 'account'].includes(workspaceView) && !isFullscreen)} fullscreenLandscape={mobileLayout && isFullscreen && fullscreenOrientation === 'landscape'} />
        <RoomBackground color={roomStyle(viewSettings.roomStyle).background} />
        <ambientLight intensity={2} />
        <directionalLight position={[0, 5, 1]} intensity={.9} />
        <Room style={viewSettings.roomStyle} />

        {/* Keep the same bubble for each instrument so its movement does not reset. */}
        {instruments.map(inst => {
          return (
            <AnimatedInstrument
              labelLayout={labelLayout}
              key={inst.key}
              instrument={inst}
              shown={visibleInstruments[inst.key] !== false}
              frames={getFrames(inst.key)}
              exportFrameRef={exportFrameRef}
              audioRef={audioRef}
              uploading={uploading || exportingVideo}
              viewSettings={viewSettings}
              panMotion={panProfiles[inst.key]}
              isHovered={hoveredKey === inst.key}
              onHoverStart={() => setHoveredKey(inst.key)}
              onHoverEnd={() => setHoveredKey(null)}
            />
          )
        })}

        {/* Forget the old label positions when a different mix is opened. */}
        <InstrumentLabelLayout key={mixId} labels={labelLayout} instrumentCount={instruments.length} />
        {tutorialCue && <TutorialProjection labels={labelLayout} targets={tutorialCue.targets} passages={tutorialPassages} audioRef={audioRef} {...spotlight} />}
        <ContactShadows position={[0, -2.98, 0]} opacity={.5} scale={10} blur={2} far={4} resolution={mobileLayout && !exportingVideo ? 256 : 512} />
      </Canvas>
      {tutorialCue && <TutorialSpotlight targets={tutorialCue.targets} veil={tutorialCue.veil} {...spotlight} />}
    </RoomViewport>
  )
}
