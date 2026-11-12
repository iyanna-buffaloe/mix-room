import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from import_stems import build_mix, import_stems, read_manifest, SAMPLE_RATE


class StemImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def manifest(self, entries):
        path = self.root / "stems.json"
        path.write_text(json.dumps(entries))
        return path

    def audio(self, name, samples, sr=SAMPLE_RATE):
        path = self.root / name
        sf.write(path, samples, sr, subtype="FLOAT")
        return str(path)

    def test_names_are_display_labels_with_unique_safe_keys(self):
        source = self.audio("audio.wav", np.zeros((100, 2)))
        labels = [" Kick ", "Kick", "Kick 2", "../音声", "123"]
        stems = read_manifest(self.manifest([{"file": source, "label": label} for label in labels]))
        self.assertEqual([stem["label"] for stem in stems], [label.strip() for label in labels])
        keys = [stem["key"] for stem in stems]
        self.assertEqual(len(set(keys)), len(keys))
        for key in keys:
            self.assertRegex(key, r"^[a-z][a-z0-9_]*$")

    def test_invalid_names_and_empty_batches_are_rejected(self):
        source = self.audio("audio.wav", np.zeros((100, 2)))
        for entries in [[], [{"file": source, "label": " "}], [{"file": source, "label": "a" * 61}], [{"file": source, "label": "Kick"}] * 33]:
            with self.assertRaises(ValueError):
                read_manifest(self.manifest(entries))

    def test_mix_preserves_pan_relative_volume_and_shorter_stem_timing(self):
        left = self.audio("left.wav", np.tile([0.4, 0.0], (SAMPLE_RATE, 1)))
        right = self.audio("right.wav", np.tile([0.0, 0.2], (SAMPLE_RATE // 2, 1)))
        mix = self.root / "mix.wav"
        build_mix([{"file": left}, {"file": right}], mix, lambda *_: None)
        samples, sr = sf.read(mix)
        self.assertEqual(sr, SAMPLE_RATE)
        self.assertEqual(len(samples), SAMPLE_RATE)
        np.testing.assert_allclose(samples[100], [0.4, 0.2], atol=1e-6)
        np.testing.assert_allclose(samples[-100], [0.4, 0.0], atol=1e-6)

    def test_mix_prevents_clipping_without_normalizing_each_stem(self):
        source = self.audio("loud.wav", np.tile([0.8, 0.4], (1000, 1)))
        mix = self.root / "mix.wav"
        build_mix([{"file": source}] * 3, mix, lambda *_: None)
        samples, _ = sf.read(mix)
        self.assertLessEqual(np.max(np.abs(samples)), 0.981)
        np.testing.assert_allclose(samples[100], [0.98, 0.49], atol=1e-6)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for audio imports")
    def test_import_analyzes_all_stems_without_separation_and_ends_short_stems(self):
        sr = 22050
        tone = np.sin(2 * np.pi * 400 * np.arange(sr) / sr) * 0.2
        short = self.audio("short.wav", tone[:sr // 2], sr)
        long = self.audio("long.wav", np.stack([tone, tone * 0.25], axis=1), sr)
        manifest = self.manifest([{"file": short, "label": "Piano 1"}, {"file": long, "label": "Piano 1"}])
        out, mix = self.root / "analysis", self.root / "mix.wav"
        progress = []
        with patch("analysis.run_separation", side_effect=AssertionError("Separation must not run")) as separate:
            import_stems(manifest, out, mix, lambda percent, _: progress.append(percent))
            separate.assert_not_called()
        meta = json.loads((out / "instrument_meta.json").read_text())
        self.assertEqual(meta["processingMode"], "stems")
        self.assertEqual(meta["title"], "stem mix")
        self.assertEqual([stem["fileName"] for stem in meta["instruments"]], ["short.wav", "long.wav"])
        self.assertEqual([stem["label"] for stem in meta["instruments"]], ["Piano 1", "Piano 1"])
        self.assertTrue(all(stem["active"] for stem in meta["instruments"]))
        self.assertLess(meta["instruments"][1]["pan"], -0.5)
        frames = json.loads((out / "piano_1_frames.json").read_text())
        self.assertEqual(frames[-1]["t"], 0.5)
        self.assertEqual(frames[-1]["loud"], 0)
        self.assertEqual(sf.info(mix).frames, SAMPLE_RATE)
        self.assertEqual(list(out.glob("decoded-*.wav")), [])
        self.assertEqual(progress, sorted(progress))

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for audio imports")
    def test_custom_title_and_original_filename_are_preserved(self):
        source = self.audio("source.wav", np.sin(2 * np.pi * 300 * np.arange(SAMPLE_RATE) / SAMPLE_RATE) * 0.2)
        manifest = self.manifest([{"file": source, "label": "Piano", "fileName": "Original piano.wav"}])
        out, mix = self.root / "analysis", self.root / "mix.wav"
        import_stems(manifest, out, mix, lambda *_: None, title="  My song  ")
        meta = json.loads((out / "instrument_meta.json").read_text())
        self.assertEqual(meta["title"], "My song")
        self.assertEqual(meta["instruments"][0]["fileName"], "Original piano.wav")

    def test_invalid_title_fails_before_decoding_audio(self):
        for title in ["", " ", "a" * 121, None]:
            with self.assertRaisesRegex(ValueError, "song title"):
                import_stems(self.root / "missing.json", self.root / "analysis", self.root / "mix.wav", title=title)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for audio imports")
    def test_invalid_audio_does_not_produce_a_room(self):
        source = self.root / "invalid.wav"
        source.write_text("not audio")
        manifest = self.manifest([{"file": str(source), "label": "Bass"}])
        out, mix = self.root / "analysis", self.root / "mix.wav"
        with self.assertRaisesRegex(ValueError, "Could not decode Bass"):
            import_stems(manifest, out, mix, lambda *_: None)
        self.assertFalse((out / "instrument_meta.json").exists())
        self.assertFalse(mix.exists())


if __name__ == "__main__":
    unittest.main()
