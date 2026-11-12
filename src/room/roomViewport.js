// Fit the complete composition on every screen, including fullscreen.
// Fit the complete room in compact views. Desktop keeps the closer view.
export const ROOM_VIEW = { aspect: 16 / 10, fov: 50, halfWidth: 5, bottom: -3, top: 2, front: 2.5, centerY: -0.5, padding: 1.06 }
// Match App.css: narrow desktop windows keep the side navigation above 600px.
// Touch devices keep the phone layout when rotated to landscape.
export const ROOM_COMPACT_QUERY = '(max-width: 600px), (pointer: coarse) and (max-width: 1100px)'

export function fitRoomViewport(width, height, aspect = ROOM_VIEW.aspect) {
  if (!(width > 0 && height > 0 && aspect > 0)) return { width: 0, height: 0 }
  const fittedWidth = Math.min(width, height * aspect)
  return { width: fittedWidth, height: fittedWidth / aspect }
}

export function roomCameraPosition(aspect = ROOM_VIEW.aspect) {
  const halfHeight = Math.max(ROOM_VIEW.top - ROOM_VIEW.centerY, ROOM_VIEW.centerY - ROOM_VIEW.bottom)
  const distance = Math.max(halfHeight, ROOM_VIEW.halfWidth / aspect) * ROOM_VIEW.padding / Math.tan(ROOM_VIEW.fov * Math.PI / 360)
  return [0, ROOM_VIEW.centerY, ROOM_VIEW.front + distance]
}

// Keep the same horizontal composition as the 16:10 room while filling the
// screen. Wider phones reveal less ceiling/floor, rather than adding borders
// or changing the camera's distance and perspective.
export function fullscreenRoomFov(aspect = ROOM_VIEW.aspect) {
  const validAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : ROOM_VIEW.aspect
  return 2 * Math.atan(Math.tan(ROOM_VIEW.fov * Math.PI / 360) * ROOM_VIEW.aspect / validAspect) * 180 / Math.PI
}

export const ROOM_CAMERA = { position: roomCameraPosition(), fov: ROOM_VIEW.fov }
