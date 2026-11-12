import { useEffect, useMemo } from 'react'
import { CanvasTexture, Color, Float32BufferAttribute, PlaneGeometry, SRGBColorSpace } from 'three'

// A small procedural sky texture: no external images or requests are needed.
function skyTexture(color) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(0, 0, 512, 256)
  for (const [x, y, width, height] of [[50, 65, 110, 26], [200, 165, 150, 30], [365, 60, 125, 23], [490, 210, 95, 25]]) {
    context.fillStyle = 'rgba(245,252,255,0.32)'
    context.filter = 'blur(8px)'
    context.beginPath()
    context.ellipse(x, y, width / 2, height / 2, 0, 0, Math.PI * 2)
    context.fill()
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

export function RoomWalls({ palette, traditional }) {
  const texture = useMemo(() => traditional ? skyTexture(palette.wall) : null, [traditional, palette.wall])
  useEffect(() => () => texture?.dispose(), [texture])
  return <>
    {[
      { position: [0, -0.5, -5], rotation: [0, 0, 0] },
      { position: [-5, -0.5, 0], rotation: [0, Math.PI / 2, 0] },
      { position: [5, -0.5, 0], rotation: [0, -Math.PI / 2, 0] },
    ].map((wall, index) => <mesh key={index} {...wall}>
      <planeGeometry args={[10, 5]} />
      <meshStandardMaterial key={traditional ? 'sky' : 'plain'} color={texture ? '#ffffff' : palette.wall} map={texture} roughness={0.95} />
    </mesh>)}
  </>
}

export function RoomFloor({ palette }) {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(10, 10)
    const colors = []
    const back = new Color(palette.floorBack), front = new Color(palette.floorFront)
    for (let i = 0; i < plane.attributes.position.count; i++) {
      const t = (plane.attributes.position.getY(i) + 5) / 10
      const color = front.clone().lerp(back, t)
      colors.push(color.r, color.g, color.b)
    }
    plane.setAttribute('color', new Float32BufferAttribute(colors, 3))
    return plane
  }, [palette.floorBack, palette.floorFront])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3, 0]} geometry={geometry} dispose={null}>
    <meshStandardMaterial vertexColors roughness={0.95} />
  </mesh>
}
