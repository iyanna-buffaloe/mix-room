import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Grid, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { roomStyle } from './roomStyles.js'
import { RoomWalls, RoomFloor } from './RoomSurface.jsx'

// ============================================================
// SPEAKER CABINET
// ============================================================
//
// Draw the speaker box and its round cones using the room's colors. Draw them
// behind the instrument bubbles so the decoration does not cover the music.

function Speaker({ position, palette }) {
  return (
    <group position={position}>

      <RoundedBox args={[0.82, 1.16, 0.48]} radius={0.055} smoothness={4} renderOrder={-1}>
        <meshStandardMaterial color={palette.speaker} roughness={0.8} transparent depthWrite={false} />
      </RoundedBox>

      {/* Set the front panel slightly inside the box, with both cones facing the listener. */}
      <mesh position={[0, 0, 0.245]} renderOrder={-1}>
        <boxGeometry args={[0.72, 1.05, 0.025]} />
        <meshStandardMaterial color={palette.speakerPanel} roughness={0.9} transparent depthWrite={false} />
      </mesh>
      {[
        { y: 0.3, radius: 0.12 },
        { y: -0.17, radius: 0.27 },
      ].map(driver => (
        <group key={driver.y} position={[0, driver.y, 0.27]}>
          <mesh renderOrder={-1}>
            <ringGeometry args={[driver.radius * 0.78, driver.radius, 48]} />
            <meshStandardMaterial color={palette.driver} roughness={0.7} transparent depthWrite={false} />
          </mesh>
          <mesh position={[0, 0, -0.005]} renderOrder={-1}>
            <circleGeometry args={[driver.radius * 0.79, 48]} />
            <meshStandardMaterial color="#72777e" roughness={0.95} transparent depthWrite={false} />
          </mesh>
          <mesh position={[0, 0, 0.01]} scale={[1, 1, 0.35]} renderOrder={-1}>
            <sphereGeometry args={[driver.radius * 0.36, 24, 16]} />
            <meshStandardMaterial color="#565b62" roughness={0.6} transparent depthWrite={false} />
          </mesh>
        </group>
      ))}
      <mesh position={[0.27, -0.45, 0.27]} renderOrder={-1}>
        <circleGeometry args={[0.018, 16]} />
        <meshBasicMaterial color="#a6e7f2" transparent depthWrite={false} />
      </mesh>
    </group>
  )
}

// ============================================================
// CAMERA-AWARE SPEAKER PLACEMENT
// ============================================================
//
// Keep the speakers near the front corners as the room changes size. For a
// downloaded video, use the video's camera to place them. Also adjust their
// height so the top of a speaker never gets cut off by the picture's edge.

function RoomSpeakers({ palette }) {
  const speakers = useRef(null)
  const { camera, viewport, scene } = useThree()
  const frontZ = 2.5
  const target = useMemo(() => new THREE.Vector3(0, 0, frontZ), [])
  useFrame(() => {
    if (!speakers.current) return
    const exporting = scene.userData.mixRoomExport

    // Place speakers for the picture being recorded, rather than the live preview.
    const activeCamera = exporting?.camera ?? camera
    const view = viewport.getCurrentViewport(activeCamera, target, exporting ?? undefined)
    const x = Math.max(0, Math.min(4.35, view.width / 2 - 0.6))

    const y = Math.min(2 - 1.16 / 2, activeCamera.position.y + view.height / 2 - 1.16 / 2 - 0.12)
    speakers.current.children[0].position.set(-x, y, frontZ)
    speakers.current.children[1].position.set(x, y, frontZ)
  })
  return <group ref={speakers}>
    <Speaker palette={palette} position={[-4.35, 1.42, frontZ]} />
    <Speaker palette={palette} position={[4.35, 1.42, frontZ]} />
  </group>
}

// ============================================================
// ROOM SCENERY
// ============================================================
//
// Choose the room's colors and bring together its speakers, ceiling, floor,
// grid and walls. Separate drawing functions build the floor and wall shapes.

export default function Room({ style }) {
  const palette = roomStyle(style)
  return (
    <group>
      <RoomSpeakers palette={palette} />

      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 2, 0]}>
        <planeGeometry args={[10, 10]} />
        <meshStandardMaterial color={palette.ceiling}/>
      </mesh>

      {/* Lift the grid a little above the floor so the two surfaces do not flicker. */}
      <Grid
        position={[0, -2.99, 0]}
        args={[10, 10]}
        cellSize={0.5}
        cellThickness={0.9}
        cellColor={palette.grid}
        sectionSize={2}
        sectionThickness={.5}
        sectionColor={palette.grid}
        fadeDistance={20}
        infiniteGrid={false}
      />

      <RoomFloor palette={palette} />
      <RoomWalls palette={palette} traditional={style === 'traditional'} />
    </group>
  )
}
