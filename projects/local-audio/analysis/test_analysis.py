import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

import analysis as pipeline


class MixAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sr = 22050
        self.tone = np.sin(2 * np.pi * 400 * np.arange(self.sr) / self.sr)

    def audio(self, name, samples):
        path = self.root / f"{name}.wav"
        sf.write(path, samples, self.sr, subtype="FLOAT")
        return str(path)

    def normalized_pair(self, gain):
        measurements = [
            pipeline.measure_stem(
                self.audio(f"tone-{level}", self.tone * level * gain),
                10,
                pipeline.DRUM_SILENCE_THRESHOLD_DB,
            )
            for level in (0.2, 0.02)
        ]
        reference = max(m["ceiling"] for m in measurements)
        return [
            np.array([f["loud"] for f in pipeline.normalize_stem(m, reference)])
            for m in measurements
        ]

    def test_relative_volume_preserves_quiet_stem_activity(self):
        loud, quiet = self.normalized_pair(1)
        self.assertGreater(np.mean(loud), np.mean(quiet))
        self.assertGreater(np.max(quiet), 0.5)

    def test_changing_master_gain_preserves_balance(self):
        original = self.normalized_pair(1)
        quieter = self.normalized_pair(0.5)
        for a, b in zip(original, quieter):
            np.testing.assert_allclose(a, b, atol=0.001)

    def test_silence_and_faint_bleed_stay_absent(self):
        for level in (0, 0.0001):
            path = self.audio(f"silent-{level}", self.tone * level)
            measurement = pipeline.measure_stem(path, 10, pipeline.DRUM_SILENCE_THRESHOLD_DB)
            self.assertFalse(measurement["active"])
            self.assertTrue(all(f["loud"] == 0 for f in pipeline.normalize_stem(measurement, 0.1)))

    def test_export_keeps_brief_drums_and_weights_pan_by_signal(self):
        brief = np.zeros(self.sr * 10)
        brief[:self.sr // 10] = self.tone[:self.sr // 10] * 0.03
        stereo = np.zeros((self.sr * 2, 2))
        stereo[:self.sr, 0] = self.tone * 0.2
        stereo[self.sr:, 1] = self.tone * 0.02
        stems = [
            {"key": "kick", "file": self.audio("kick", brief)},
            {"key": "guitar", "file": self.audio("guitar", stereo)},
            {"key": "vocals", "file": self.audio("vocals", self.tone * 0)},
        ]
        with patch.object(pipeline, "OUTPUT_DIR", str(self.root)):
            pipeline.write_analysis(stems, "/audio/test.wav", {"kick"})
        meta = json.loads((self.root / "instrument_meta.json").read_text())
        by_key = {m["key"]: m for m in meta["instruments"]}
        frames = json.loads((self.root / "kick_frames.json").read_text())
        self.assertTrue(by_key["kick"]["active"])
        self.assertLess(np.mean([f["loud"] for f in frames]), 0.05)
        self.assertFalse(by_key["vocals"]["active"])
        self.assertLess(by_key["guitar"]["pan"], -0.9)

    def test_quiet_high_frequency_tail_does_not_dominate_pitch(self):
        tail = np.sin(2 * np.pi * 8000 * np.arange(self.sr * 3) / self.sr) * 0.00001
        path = self.audio("tail", np.concatenate([self.tone * 0.2, tail]))
        self.assertLess(pipeline.get_freq(path), 0.1)

    def test_export_preserves_quiet_backing_vocals(self):
        stems = [
            {"key": "lead_vocals", "file": self.audio("lead", self.tone * 0.2)},
            {"key": "backing_vocals", "file": self.audio("backing", self.tone * 0.008)},
        ]
        with patch.object(pipeline, "OUTPUT_DIR", str(self.root)):
            pipeline.write_analysis(stems, "/audio/test.wav", set())
        meta = json.loads((self.root / "instrument_meta.json").read_text())
        self.assertTrue(all(stem["active"] for stem in meta["instruments"]))
        self.assertTrue((self.root / "backing_vocals_frames.json").is_file())

    def test_export_removes_stale_generated_frames(self):
        stale = self.root / "unused_frames.json"
        stale.write_text("[]")
        stems = [{"key": "lead_vocals", "file": self.audio("lead", self.tone * 0.2)}]
        with patch.object(pipeline, "OUTPUT_DIR", str(self.root)):
            pipeline.write_analysis(stems, "/audio/test.wav", set())
        self.assertFalse(stale.exists())
        self.assertTrue((self.root / "lead_vocals_frames.json").is_file())

    def test_staged_analysis_does_not_change_the_current_room(self):
        live = self.root / "live"
        live.mkdir()
        (live / "instrument_meta.json").write_text("previous metadata")
        (live / "other_frames.json").write_text("previous frames")
        staging = self.root / "staging"
        stems = [{"key": "vocals", "file": self.audio("vocals", self.tone * 0.2)}]
        with patch.object(pipeline, "OUTPUT_DIR", str(live)):
            pipeline.write_analysis(stems, "/audio/test.wav", set(), output_dir=str(staging))
        self.assertEqual((live / "instrument_meta.json").read_text(), "previous metadata")
        self.assertEqual((live / "other_frames.json").read_text(), "previous frames")
        self.assertTrue((staging / "vocals_frames.json").is_file())
        self.assertEqual(json.loads((staging / "instrument_meta.json").read_text())["audioUrl"], "/audio/test.wav")

    def test_analysis_reports_completion_after_metadata_is_written(self):
        updates = []
        stems = [{"key": "lead_vocals", "file": self.audio("lead", self.tone * 0.2)}]
        def progress(fraction, message):
            updates.append(fraction)
            if fraction == 1:
                self.assertTrue((self.root / "instrument_meta.json").is_file())
        with patch.object(pipeline, "OUTPUT_DIR", str(self.root)):
            pipeline.write_analysis(stems, "/audio/test.wav", set(), progress=progress)
        self.assertEqual(updates, sorted(updates))
        self.assertEqual(updates[-1], 1)

    def tom_activity(self, toms, kick, kick_sr=None):
        tom_path = self.audio("toms", toms)
        kick_path = self.root / "kick.wav"
        sf.write(kick_path, kick, kick_sr or self.sr, subtype="FLOAT")
        measurement = pipeline.measure_stem(tom_path, 10, pipeline.DRUM_SILENCE_THRESHOLD_DB)
        activity, bleed = pipeline.get_tom_activity(tom_path, str(kick_path), measurement)
        measurement["activity"] = activity
        measurement["kickBleed"] = bleed
        return measurement, pipeline.normalize_stem(measurement)

    def test_weak_kick_copy_does_not_light_up_toms(self):
        t = np.arange(self.sr * 2) / self.sr
        kick = 0.3 * np.exp(-(t % 0.5) / 0.08) * np.sin(2 * np.pi * 70 * t)
        measurement, frames = self.tom_activity(kick * 0.1, kick)
        self.assertTrue(measurement["active"])
        self.assertGreater(np.max(measurement["kickBleed"]), 0.95)
        self.assertLess(max(f["loud"] for f in frames), 0.05)

    def test_independent_tom_hits_survive_simultaneous_kicks(self):
        t = np.arange(self.sr * 2) / self.sr
        envelope = np.exp(-(t % 0.5) / 0.08)
        kick = 0.3 * envelope * np.sin(2 * np.pi * 70 * t)
        toms = kick * 0.1 + 0.07 * envelope * np.sin(2 * np.pi * 180 * t)
        measurement, frames = self.tom_activity(toms, kick)
        self.assertLess(np.max(measurement["kickBleed"]), 0.65)
        self.assertGreater(max(f["loud"] for f in frames), 0.9)

    def test_stronger_tom_waveform_is_not_classified_as_weak_spill(self):
        kick = self.tone * 0.1
        measurement, frames = self.tom_activity(kick * 0.8, kick)
        self.assertTrue(np.all(measurement["kickBleed"] == 0))
        self.assertGreater(max(f["loud"] for f in frames), 0.9)

    def test_quiet_residue_between_tom_hits_is_suppressed(self):
        t = np.arange(self.sr * 2) / self.sr
        toms = np.sin(2 * np.pi * 180 * t) * 0.0002
        toms[self.sr:self.sr + self.sr // 5] += self.tone[:self.sr // 5] * 0.03
        measurement, frames = self.tom_activity(toms, np.zeros_like(toms))
        self.assertTrue(measurement["active"])
        self.assertTrue(all(f["loud"] == 0 for f in frames if 0.1 < f["t"] < 0.8))
        self.assertGreater(max(f["loud"] for f in frames), 0.9)

    def test_shorter_kick_does_not_suppress_later_toms(self):
        toms = np.concatenate([np.zeros(self.sr), self.tone * 0.03])
        measurement, frames = self.tom_activity(toms, np.zeros(self.sr // 2), kick_sr=self.sr // 2)
        self.assertTrue(np.all(measurement["kickBleed"] == 0))
        self.assertGreater(max(f["loud"] for f in frames if f["t"] > 1.2), 0.9)

    def test_export_decodes_each_stem_once_including_tom_comparison(self):
        stems = [
            {"key": key, "file": self.audio(key, self.tone * level)}
            for key, level in [('kick', 0.2), ('toms', 0.01), ('guitar', 0.1)]
        ]
        with patch.object(pipeline, 'OUTPUT_DIR', str(self.root)), patch.object(pipeline.librosa, 'load', wraps=pipeline.librosa.load) as load:
            pipeline.write_analysis(stems, '/audio/test.wav', {'kick', 'toms'})
        self.assertEqual([call.args[0] for call in load.call_args_list], [stem['file'] for stem in stems])

    def test_block_frequency_matches_original_across_boundaries_and_sample_rates(self):
        rng = np.random.default_rng(42)
        for sr in (22050, 44100):
            for length in (1, 2048, 512 * 256, sr * 7):
                samples = rng.normal(0, 0.1, length).astype(np.float32)
                samples[length // 2:] *= 0.01
                with np.testing.suppress_warnings() as warnings:
                    warnings.filter(UserWarning)
                    centroid = pipeline.librosa.feature.spectral_centroid(y=samples, sr=sr)[0]
                    energy = pipeline.librosa.feature.rms(y=samples)[0] ** 2
                expected = round(float(min(np.average(centroid, weights=energy) / 8000, 1)), 3)
                self.assertEqual(pipeline.measure_frequency(samples, sr), expected)
        self.assertEqual(pipeline.measure_frequency(np.zeros(self.sr), self.sr), 0)
        self.assertEqual(pipeline.measure_frequency(np.zeros(0), self.sr), 0.5)

    def test_width_matches_correlation_without_full_channel_copies(self):
        rng = np.random.default_rng(42)
        left = rng.normal(0.02, 0.1, self.sr * 4).astype(np.float32)
        for right in (left, -left, left * 0.3 + rng.normal(0, 0.01, len(left)), rng.normal(0, 0.1, len(left))):
            samples = np.array([left, right], dtype=np.float32)
            expected = round(float(np.clip(1 - abs(np.corrcoef(samples)[0, 1]), 0, 1)), 3)
            self.assertEqual(pipeline.measure_width(samples), expected)
        self.assertEqual(pipeline.measure_width(left), 0)
        self.assertEqual(pipeline.measure_width(np.zeros((2, self.sr))), 0)

    def test_switching_modes_exports_matching_metadata_and_removes_old_parts(self):
        tone_path = self.audio('tone', self.tone * 0.1)
        parts = [{'key': key, 'file': tone_path} for key in ('kick', 'toms', 'lead_vocals', 'backing_vocals')]
        broad = [{'key': key, 'file': tone_path} for key in ('drums', 'bass', 'other', 'vocals')]
        with patch.object(pipeline, 'OUTPUT_DIR', str(self.root)):
            for stems, mode in [(parts, 'thorough'), (broad, 'quick'), (parts, 'thorough')]:
                pipeline.write_analysis(stems, '/audio/song.wav', {'drums', 'kick', 'toms'}, processing_mode=mode)
                metadata = json.loads((self.root / 'instrument_meta.json').read_text())
                self.assertEqual(metadata['processingMode'], mode)
                self.assertEqual({stem['key'] for stem in metadata['instruments']}, {stem['key'] for stem in stems})
                self.assertEqual({path.name for path in self.root.glob('*_frames.json')}, {f"{stem['key']}_frames.json" for stem in stems})


if __name__ == "__main__":
    unittest.main()
