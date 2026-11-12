import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from worker import describe_audio


class WaveformTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_stereo_peaks_and_rms_preserve_quiet_amplitudes_and_duration(self):
        source = self.root / "quiet.wav"
        samples = np.column_stack([np.ones(44541) * .001, np.ones(44541) * .01]).astype(np.float32)
        sf.write(source, samples, 44100, subtype="FLOAT")
        track = describe_audio(source, "toms", "Toms", self.root, True)
        waveform = json.loads(Path(track["waveformFile"]).read_text())
        self.assertAlmostEqual(track["duration"], 1.01, places=7)
        self.assertEqual(waveform["secondsPerBin"], .01)
        self.assertEqual(len(waveform["peaks"][0]), 101)
        self.assertAlmostEqual(waveform["peaks"][0][0], .001, places=8)
        self.assertAlmostEqual(waveform["peaks"][1][0], .01, places=8)
        self.assertAlmostEqual(track["rmsDb"], 20 * np.log10(np.sqrt((.001 ** 2 + .01 ** 2) / 2)), places=5)
        np.testing.assert_array_equal(sf.read(source, dtype="float32")[0], samples)

    def test_silence_and_partial_last_bin_have_finite_json_without_added_duration(self):
        source = self.root / "silence.wav"
        sf.write(source, np.zeros((443, 1)), 44100, subtype="FLOAT")
        track = describe_audio(source, "crash", "Crash", self.root, True)
        waveform = json.loads(Path(track["waveformFile"]).read_text())
        self.assertIsNone(track["rmsDb"])
        self.assertEqual(track["peak"], 0)
        self.assertEqual(waveform["peaks"], [[0, 0]])
        self.assertAlmostEqual(waveform["duration"], 443 / 44100)

    def test_transient_positions_and_nonfinite_audio(self):
        source = self.root / "transients.wav"
        audio = np.zeros((44100, 2), dtype=np.float32)
        audio[4410, 0] = .1
        audio[22050, 1] = -.25
        sf.write(source, audio, 44100, subtype="FLOAT")
        track = describe_audio(source, "kick", "Kick", self.root, True)
        peaks = json.loads(Path(track["waveformFile"]).read_text())["peaks"]
        self.assertEqual(np.argmax(peaks[0]), 10)
        self.assertEqual(np.argmax(peaks[1]), 50)
        self.assertEqual(track["peak"], .25)
        audio[0, 0] = np.nan
        sf.write(source, audio, 44100, subtype="FLOAT")
        with self.assertRaisesRegex(ValueError, "Non-finite"):
            describe_audio(source, "kick", "Kick", self.root, True)


if __name__ == "__main__":
    unittest.main()
