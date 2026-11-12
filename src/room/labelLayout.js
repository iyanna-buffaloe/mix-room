const LABEL_GAP = 4

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

// Small measured offsets are common in stereo mixes. Let those read as a
// direction, then reach the edge quickly enough for a part such as Nice
// Shoes' "Other" stem (+0.06) to sit clearly on the right of its wide oval.
export function labelPanBias(pan) {
  if (!Number.isFinite(pan)) return 0
  const direction = Math.sign(pan)
  const amount = Math.abs(pan)
  if (amount <= 0.005) return 0
  return direction * clamp((amount - 0.005) / 0.055, 0, 1)
}

// A depth-tested label needs to sit just in front of its own ellipsoid. At the
// center that is one vertical radius forward; toward an edge the curved
// surface naturally comes back toward the instrument's center plane.
export function ellipsoidFrontDepth(x, y, radiusX, radiusY, padding = 0.035) {
  if (!(radiusX > 0) || !(radiusY > 0)) return padding
  const normalizedDistance = (x / radiusX) ** 2 + (y / radiusY) ** 2
  return radiusY * Math.sqrt(Math.max(0, 1 - Math.min(1, normalizedDistance))) + padding
}

function overlapArea(a, b) {
  const overlapX = Math.max(0, (a.width + b.width) / 2 + LABEL_GAP - Math.abs(a.x - b.x))
  const overlapY = Math.max(0, (a.height + b.height) / 2 + LABEL_GAP - Math.abs(a.y - b.y))
  return overlapX * overlapY
}

function stableDirection(key) {
  let value = 0
  for (const character of key) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return value % 2 ? 1 : -1
}

// Arrange labels in screen space while keeping every label inside the ellipse
// of its own instrument. Avoiding overlap is secondary to that boundary: when
// a crowded passage has no perfect answer, the label stays with its shape.
export function arrangeLabels(labels) {
  const placed = []
  const ordered = [...labels].sort((a, b) => Math.abs(b.panBias) - Math.abs(a.panBias) || b.radiusX * b.radiusY - a.radiusX * a.radiusY || a.key.localeCompare(b.key))

  for (const label of ordered) {
    const radiusX = Math.max(label.width / 2 + LABEL_GAP, label.radiusX * 0.9)
    const radiusY = Math.max(label.height / 2 + LABEL_GAP, label.radiusY * 0.9)
    const centeredCornerX = Math.min(1, (label.width / 2 + LABEL_GAP) / radiusX)
    const maxY = Math.max(0, radiusY * Math.sqrt(Math.max(0, 1 - centeredCornerX ** 2)) - label.height / 2 - LABEL_GAP)
    const verticalDirection = stableDirection(label.key)
    const yFractions = [0, verticalDirection * 0.34, -verticalDirection * 0.34, verticalDirection * 0.68, -verticalDirection * 0.68, 0.9, -0.9]
    let best = { ...label }
    let bestScore = Infinity

    for (const yFraction of yFractions) {
      const offsetY = maxY * yFraction
      const cornerY = Math.min(1, (Math.abs(offsetY) + label.height / 2 + LABEL_GAP) / radiusY)
      const maxX = Math.max(0, radiusX * Math.sqrt(Math.max(0, 1 - cornerY ** 2)) - label.width / 2 - LABEL_GAP)
      const preferredX = maxX * label.panBias
      const direction = Math.sign(label.panBias) || stableDirection(label.key)
      const xOffsets = Math.abs(label.panBias) > 0.01
        ? [preferredX, direction * maxX, direction * maxX * 0.72, direction * maxX * 0.4, 0, -direction * maxX * 0.45]
        : [0, direction * maxX * 0.45, -direction * maxX * 0.45, direction * maxX * 0.8, -direction * maxX * 0.8]

      for (const offsetX of xOffsets) {
        const candidate = { ...label, x: label.x + offsetX, y: label.y + offsetY }
        const overlap = placed.reduce((total, other) => total + overlapArea(candidate, other), 0)
        const preference = maxX ? Math.abs(offsetX - preferredX) / maxX : 0
        const verticalMove = maxY ? Math.abs(offsetY) / maxY : 0
        const wrongSide = label.panBias && Math.sign(offsetX) && Math.sign(offsetX) !== Math.sign(label.panBias) ? 3 : 0
        const score = overlap * 1000 + preference * 12 + verticalMove * 4 + wrongSide
        if (score < bestScore) {
          best = candidate
          bestScore = score
        }
      }
    }
    placed.push(best)
  }

  return placed
}
