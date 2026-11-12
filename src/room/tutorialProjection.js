import { Vector3 } from 'three'

const pixels = (point, width, height) => ({ x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 })
const pathFor = points => points.length ? `M${points.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('L')}Z` : ''
const boundsFor = points => ({ left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) })

// The apparent edge is the tangent circle viewed on a unit sphere, transformed
// back through this ellipsoid. Projecting its center/radius alone misses the
// perspective silhouette, particularly for wide shapes near the sides.
export function projectTutorialTarget(entry, camera, width, height) {
  // Guidance describes the real part's position even between hits. Its actual
  // bubble and text keep their normal audio-driven transparency.
  if (!entry || !width || !height) return null
  const center = entry.centerWorld
  const radii = new Vector3(entry.radiusX, entry.radiusY, entry.radiusY)
  const eye = camera.getWorldPosition(new Vector3()).sub(center).divide(radii)
  const distanceSquared = eye.lengthSq()
  if (distanceSquared <= 1) return null
  const normal = eye.clone().normalize()
  const u = new Vector3().crossVectors(normal, Math.abs(normal.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize()
  const v = new Vector3().crossVectors(normal, u)
  const circleCenter = eye.clone().divideScalar(distanceSquared)
  const radius = Math.sqrt(1 - 1 / distanceSquared)
  const world = new Vector3()
  const shape = []
  for (let index = 0; index < 64; index++) {
    const angle = index * Math.PI * 2 / 64
    world.copy(circleCenter).addScaledVector(u, radius * Math.cos(angle)).addScaledVector(v, radius * Math.sin(angle)).multiply(radii).add(center).project(camera)
    shape.push(pixels(world, width, height))
  }
  const label = []
  const text = entry.text
  const bounds = text?.textRenderInfo?.blockBounds
  if (entry.showLabel && entry.anchor.visible && bounds) {
    text.updateWorldMatrix(true, false)
    for (const [x, y] of [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]]) {
      world.set(x, y, 0).applyMatrix4(text.matrixWorld).project(camera)
      label.push(pixels(world, width, height))
    }
  }
  return { shape: pathFor(shape), label: pathFor(label), bounds: boundsFor([...shape, ...label]) }
}

export function tutorialCaptionOverlap(targets, x, y, width, height) {
  return targets.reduce((total, target) => total
    + Math.max(0, Math.min(x + width, target.right + 10) - Math.max(x, target.left - 10))
    * Math.max(0, Math.min(y + height, target.bottom + 10) - Math.max(y, target.top - 10)), 0)
}

export function tutorialCaptionPosition(targets, width, height, captionWidth, captionHeight, safe = {}) {
  const left = Math.max(12, safe.left || 0), top = Math.max(12, safe.top || 0)
  const right = Math.max(left, width - captionWidth - Math.max(12, safe.right || 0))
  const bottom = Math.max(top, height - captionHeight - Math.max(100, safe.bottom || 0))
  const candidates = [[left, top], [right, top], [left, bottom], [right, bottom], [left, (top + bottom) / 2], [right, (top + bottom) / 2]]
  const score = ([x, y]) => tutorialCaptionOverlap(targets, x, y, captionWidth, captionHeight)
  return candidates.reduce((best, point) => score(point) < score(best) ? point : best)
}
