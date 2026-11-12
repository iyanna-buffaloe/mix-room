import { Vector3 } from 'three'
import { arrangeLabels, ellipsoidFrontDepth } from './labelLayout.js'

const pixels = (point, width, height) => ({ x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 })

// Keep one arrangement per mix, expressed relative to each instrument. A
// changing pan carries only that label; visibility never rearranges its peers.
export function createFixedLabelLayout() {
  let positions
  const world = new Vector3(), eye = new Vector3()

  return (entries, camera, width, height) => {
    if (!width || !height || !entries.length) return false
    if (!positions) {
      // Never show an approximate placement and then jump when the font loads.
      if (entries.some(([, entry]) => {
        const info = entry.text.textRenderInfo
        return !info?.blockBounds || info.parameters.text !== entry.label || info.parameters.fontSize !== entry.fontSize
      })) return false

      camera.updateWorldMatrix(true, false)
      const projected = entries.map(([key, entry]) => {
        const centerWorld = entry.layoutCenterWorld ?? entry.centerWorld
        const center = centerWorld.clone().project(camera)
        const screenCenter = pixels(center, width, height)
        const right = centerWorld.clone(); right.x += entry.radiusX; right.project(camera)
        const top = centerWorld.clone(); top.y += entry.radiusY; top.project(camera)
        const bounds = entry.text.textRenderInfo.blockBounds
        const worldWidth = bounds[2] - bounds[0]
        // Reserve the activity note even when it is currently silent.
        const worldHeight = bounds[3] - bounds[1] + (entry.note ? entry.fontSize * 0.55 : 0)
        const labelRight = centerWorld.clone(); labelRight.x += worldWidth / 2; labelRight.project(camera)
        const labelTop = centerWorld.clone(); labelTop.y += worldHeight / 2; labelTop.project(camera)
        return {
          key, x: screenCenter.x, y: screenCenter.y, depth: center.z,
          width: Math.max(1, Math.abs(labelRight.x - center.x) * width),
          height: Math.max(1, Math.abs(labelTop.y - center.y) * height),
          radiusX: Math.max(1, Math.abs(right.x - center.x) * width / 2),
          radiusY: Math.max(1, Math.abs(top.y - center.y) * height / 2),
          panBias: entry.referencePanBias ?? entry.panBias, worldWidth, worldHeight,
        }
      })

      const byKey = new Map(entries)
      positions = new Map(arrangeLabels(projected).map(label => {
        const entry = byKey.get(label.key)
        const position = new Vector3(label.x / width * 2 - 1, 1 - label.y / height * 2, label.depth).unproject(camera)
        return [label.key, {
          offset: position.sub(entry.layoutCenterWorld ?? entry.centerWorld),
          referenceBias: entry.referencePanBias ?? entry.panBias,
          worldWidth: label.worldWidth, worldHeight: label.worldHeight, fontSize: entry.fontSize,
        }]
      }))
    }

    camera.getWorldPosition(eye)
    for (const [key, entry] of entries) {
      const plan = positions.get(key)
      if (!plan) continue
      const bounds = entry.text.textRenderInfo?.blockBounds
      const matching = entry.text.textRenderInfo?.parameters.fontSize === entry.fontSize && entry.text.textRenderInfo?.parameters.text === entry.label
      const width = matching && bounds ? bounds[2] - bounds[0] : plan.worldWidth * entry.fontSize / plan.fontSize
      const height = matching && bounds ? bounds[3] - bounds[1] : plan.worldHeight * entry.fontSize / plan.fontSize
      const rx = entry.radiusX * 0.84, ry = entry.radiusY * 0.84, gap = 0.025
      const maxY = Math.max(0, ry * Math.sqrt(Math.max(0, 1 - ((width / 2 + gap) / rx) ** 2)) - height / 2 - gap)
      const y = Math.max(-maxY, Math.min(maxY, plan.offset.y))
      const maxX = Math.max(0, rx * Math.sqrt(Math.max(0, 1 - ((Math.abs(y) + height / 2 + gap) / ry) ** 2)) - width / 2 - gap) * 0.8
      const baseX = Math.max(-maxX, Math.min(maxX, plan.offset.x))
      const bias = Math.max(-1, Math.min(1, entry.panBias || 0))
      const reference = Math.max(-1, Math.min(1, plan.referenceBias || 0))
      const fraction = bias < reference ? (reference - bias) / (reference + 1) : bias > reference ? (bias - reference) / (1 - reference) : 0
      const x = baseX + ((bias < reference ? -maxX : maxX) - baseX) * fraction
      const nearestX = Math.sign(x) * Math.max(0, Math.abs(x) - width * 0.55)
      const nearestY = Math.sign(y) * Math.max(0, Math.abs(y) - height * 0.55)
      world.copy(entry.centerWorld)
      world.x += x; world.y += y
      const front = ellipsoidFrontDepth(nearestX, nearestY, entry.radiusX, entry.radiusY)
      // Lift toward the camera along the same sightline. Adding only Z pushes
      // off-center labels sideways in perspective, beyond their own oval.
      const distance = world.z - eye.z
      if (camera.isPerspectiveCamera && Math.abs(distance) > 1e-6) world.lerp(eye, -front / distance)
      else world.z += front
      entry.anchor.position.copy(entry.anchor.parent.worldToLocal(world))
    }
    return true
  }
}
