export function fullscreenElement(doc = document) {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

// Keep the request in the tap's call stack so transient user activation is
// available. Safari's older API uses a different name and returns no promise.
export async function requestRoomFullscreen(element) {
  if (!element) return false
  try {
    if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' })
    else if (element.webkitRequestFullscreen) await element.webkitRequestFullscreen()
    else return false
    return true
  } catch {
    return false
  }
}

export async function exitRoomFullscreen(doc = document) {
  if (doc.exitFullscreen) await doc.exitFullscreen()
  else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen()
}
