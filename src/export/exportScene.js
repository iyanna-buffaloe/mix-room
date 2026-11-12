import { COPY } from '../config/siteCopy.js'
import { PerspectiveCamera } from 'three'
import { ROOM_VIEW } from '../room/roomViewport.js'
import { getExportSize } from './videoTimeline.js'

// ============================================================
// REFERENCE-FRAME VIDEO CAPTURE
// ============================================================
//
// Record the video at its chosen size, regardless of the live room's screen
// size or phone rotation. render draws each requested video frame; restore
// puts the live room back afterward, even if recording fails or is canceled.

export function prepareExportScene(state) {
  const size = getExportSize()
  const camera = new PerspectiveCamera(ROOM_VIEW.fov, size.width / size.height, 0.1, 1000)
  camera.position.set(0, 0, 8)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()

  // Tell room objects which camera the video uses. Remember any earlier setting
  // so finishing this recording does not erase it.
  const previous = state.scene.userData.mixRoomExport
  state.scene.userData.mixRoomExport = { ...size, camera }
  return {
    ...size,

    // Draw the video at its fixed size rather than the current preview size.
    render(time) {
      if (state.gl.getPixelRatio() !== 1) state.gl.setPixelRatio(1)
      if (state.gl.domElement.width !== size.width || state.gl.domElement.height !== size.height) state.gl.setSize(size.width, size.height, false)
      state.advance(time, false)
      state.gl.render(state.scene, camera)
    },

    // Use the screen's current size; the window may have changed during recording.
    restore() {
      if (previous) state.scene.userData.mixRoomExport = previous
      else delete state.scene.userData.mixRoomExport
      const current = state.get()
      state.gl.setPixelRatio(current.viewport.dpr)
      state.gl.setSize(current.size.width, current.size.height, false)
    },
  }
}

// ============================================================
// WAIT FOR A SETTLED CAPTURE SURFACE
// ============================================================
//
// Wait for the enlarged room to finish resizing before recording. Check that
// the room on the page and its drawing area agree for three updates in a row.
// If they do not settle in time, explain the problem instead of recording a
// picture that is still changing size.

export async function waitForFullRoom(sceneRef, containerRef) {
  const deadline = performance.now() + 3000
  let settled = 0

  while (settled < 3) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const state = sceneRef.current
    if (!state) return // The recorder will explain that the room is not ready to draw.
    const canvas = state.gl.domElement
    const bounds = { width: canvas.clientWidth, height: canvas.clientHeight }
    const ratio = state.gl.getPixelRatio()
    const size = state.get().size
    const container = containerRef.current
    const style = getComputedStyle(container)
    const available = {
      width: container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    }

    // Match the space available to the full room. A short landscape screen
    // can have a different shape from the standard video picture.
    const target = available
    const fullView = container.closest('.mix-room__workspace')?.classList.contains('mix-room__workspace--playing')

    // The drawing code catches up shortly after the page resizes. Wait for
    // its measurements and actual picture size, not just the visible box.
    const matches = fullView && Math.abs(bounds.width - target.width) < 2 && Math.abs(bounds.height - target.height) < 2
      && Math.abs(size.width - bounds.width) < 2 && Math.abs(size.height - bounds.height) < 2
      && Math.abs(canvas.width - size.width * ratio) < 2 && Math.abs(canvas.height - size.height * ratio) < 2
    settled = matches ? settled + 1 : 0
    if (performance.now() > deadline) throw new Error(COPY.the_room_is_still_resizing_please_try_downloading_again)
  }
}
