import { COPY } from '../config/siteCopy.js'
import { encodeSeparationWav } from '../../shared/separationAudio.js'

self.onmessage = ({ data }) => {
  try {
    const wav = encodeSeparationWav(data.left, data.right, fraction => self.postMessage({ type: 'progress', fraction }))
    self.postMessage({ type: 'ready', wav }, [wav])
  } catch {
    self.postMessage({ type: 'error', message: COPY.could_not_prepare_this_audio_file })
  }
}
