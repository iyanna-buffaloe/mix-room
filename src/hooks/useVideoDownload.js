import { COPY } from '../config/siteCopy.js'
import { useEffect, useRef, useState } from 'react'
import { checkCancelled, exportVideo, saveVideo } from '../export/videoExport.js'
import { createFrameSampler } from '../export/videoTimeline.js'
import { prepareExportScene } from '../export/exportScene.js'

async function waitForLabels(scene, signal) {
  const labels = []
  scene.traverse(object => {
    if (typeof object.sync === 'function' && 'textRenderInfo' in object) {
      object.sync()
      labels.push(object)
    }
  })
  const deadline = performance.now() + 15_000
  while (labels.some(label => !label.textRenderInfo)) {
    checkCancelled(signal)
    if (performance.now() > deadline) throw new Error(COPY.instrument_labels_are_still_loading_please_try_again)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export function useVideoDownload(sceneRef, exportFrameRef, audioRef, title, instrumentKeys, getFrames, panProfiles = {}) {
  const [exportingVideo, setExportingVideo] = useState(false)
  const [videoProgress, setVideoProgress] = useState({ percent: 0, message: COPY.preparing_video })
  const active = useRef(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current?.abort()
    }
  }, [])

  const cancelVideo = () => active.current?.abort()
  const downloadVideo = async () => {
    if (active.current) return
    const state = sceneRef.current
    const audio = audioRef.current
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext
    if (!state || !OfflineContext || !window.VideoEncoder || !window.AudioEncoder) {
      alert(COPY.fast_video_export_is_unavailable_in_this_browser_please_try_a_current_version_of)
      return
    }
    const controller = new AbortController()
    active.current = controller
    const previousLoop = state.get().frameloop
    audio.pause()
    setExportingVideo(true)
    setVideoProgress({ percent: 0, message: COPY.preparing_audio })
    state.setFrameloop('never')
    let exportScene
    try {
      const response = await fetch(audio.currentSrc || audio.src, { signal: controller.signal })
      if (!response.ok) throw new Error(COPY.could_not_load_the_song_for_export)
      const bytes = await response.arrayBuffer()
      checkCancelled(controller.signal)
      const audioBuffer = await new OfflineContext(2, 1, 48_000).decodeAudioData(bytes)
      checkCancelled(controller.signal)
      setVideoProgress({ percent: 5, message: COPY.preparing_instruments })
      await waitForLabels(state.scene, controller.signal)
      checkCancelled(controller.signal)

      const source = state.gl.domElement
      exportScene = prepareExportScene(state)
      const size = { width: exportScene.width, height: exportScene.height }
      const canvas = document.createElement('canvas')
      Object.assign(canvas, size)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error(COPY.could_not_prepare_the_video_canvas)
      const samplers = Object.fromEntries(instrumentKeys.map(key => [key, createFrameSampler(getFrames(key), panProfiles[key])]))
      const result = await exportVideo({
        canvas, audioBuffer, title, signal: controller.signal,
        onProgress: value => { if (mounted.current) setVideoProgress(value) },
        renderFrame: (time, delta) => {
          exportFrameRef.current = Object.fromEntries(Object.entries(samplers).map(([key, sample]) => [key, sample(time, delta)]))
          exportScene.render(time, delta)
          context.drawImage(source, 0, 0, size.width, size.height)
        },
      })
      checkCancelled(controller.signal)
      if (mounted.current) saveVideo(result.blob, result.filename)
    } catch (error) {
      if (error.name !== 'AbortError' && mounted.current) alert(error.message || COPY.could_not_export_the_video_please_try_again)
    } finally {
      exportFrameRef.current = null
      exportScene?.restore()
      if (mounted.current) {
        state.advance(0, false)
        state.setFrameloop(previousLoop)
        setExportingVideo(false)
      }
      active.current = null
    }
  }

  return { exportingVideo, videoProgress, downloadVideo, cancelVideo }
}
