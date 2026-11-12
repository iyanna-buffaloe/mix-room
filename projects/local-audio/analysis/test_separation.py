import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from types import SimpleNamespace

import numpy as np
import soundfile as sf

import separation as pipeline


class SeparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.song = self.root / 'song.wav'
        sf.write(self.song, np.ones((44100, 2)) * 0.1, 44100)
        for name, value in [('SEPARATED_DIR', self.root / 'separated'), ('MODEL_DIR', self.root / 'models')]:
            replacement = patch.object(pipeline, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        replacement = patch.object(pipeline, 'create_separator')
        self.separator_class = replacement.start()
        self.addCleanup(replacement.stop)
        self.separator_class.return_value.effective_precision = 'fp32'
        self.separator_class.return_value.model_instance.torch_device = 'cpu'
        replacement = patch.object(pipeline, 'release_separator')
        self.release = replacement.start()
        self.addCleanup(replacement.stop)
        self.separator_class.return_value.separate.side_effect = self.generate

    def generate(self, audio_path, custom_output_names):
        folder = Path(self.separator_class.call_args.kwargs['output_dir'])
        data, sr = sf.read(audio_path)
        files = []
        for i, key in enumerate(reversed(list(custom_output_names.values()))):
            path = folder / f'{key}.wav'
            sf.write(path, data * 0.5, sr)
            files.append(str(path) if i % 2 else path.name)
        return files

    def stage(self, **kwargs):
        return pipeline.separate_stage(self.song, pipeline.BASE_MODEL, pipeline.BASE_STEMS, self.root / 'instruments', **kwargs)

    def test_pipeline_returns_leaf_stems_and_maps_backing_output(self):
        stems = pipeline.run_separation(self.song)
        self.assertEqual({s['key'] for s in stems}, {
            'bass', 'guitar', 'piano', 'other', 'lead_vocals', 'backing_vocals',
            'kick', 'snare', 'toms', 'hihat', 'ride', 'crash',
        })
        self.assertTrue(all(Path(s['file']).is_file() for s in stems))
        calls = self.separator_class.return_value.separate.call_args_list
        self.assertEqual(Path(calls[1].args[0]).name, 'drums.wav')
        self.assertEqual(Path(calls[2].args[0]).name, 'vocals.wav')
        self.assertEqual(calls[2].kwargs['custom_output_names']['Instrumental'], 'backing_vocals')

    def test_second_run_and_analysis_only_never_load_models(self):
        original = pipeline.run_separation(self.song)
        self.separator_class.reset_mock()
        self.assertEqual(pipeline.run_separation(self.song), original)
        self.assertEqual(pipeline.run_separation(self.song, cached_only=True), original)
        self.separator_class.assert_not_called()

    def test_mp3_inputs_use_wav_compatible_encoding_in_both_modes(self):
        if not sf.check_format('MP3', 'MPEG_LAYER_III'):
            self.skipTest('This libsndfile cannot write the MP3 regression fixture')
        song = self.root / 'compressed song.mp3'
        samples = np.column_stack([
            np.sin(2 * np.pi * frequency * np.arange(96000) / 48000) * 0.1
            for frequency in (220, 440)
        ])
        sf.write(song, samples, 48000)
        original_hash = pipeline.file_digest(song)
        decoded, sr = sf.read(song, dtype='float32', always_2d=True)
        converted_paths = []

        def generate_with_input_subtype(audio_path, custom_output_names):
            info = sf.info(audio_path)
            self.assertTrue(sf.check_format('WAV', info.subtype))
            if Path(audio_path).name == 'source.wav':
                converted_paths.append(Path(audio_path))
                self.assertEqual(info.subtype, 'FLOAT')
                self.assertEqual(info.samplerate, sr)
                # libsndfile's MP3 decoder rounds slightly differently per read size.
                np.testing.assert_allclose(sf.read(audio_path, dtype='float32', always_2d=True)[0], decoded, rtol=0, atol=1e-5)
            folder = Path(self.separator_class.call_args.kwargs['output_dir'])
            data, rate = sf.read(audio_path)
            files = []
            for key in custom_output_names.values():
                destination = folder / f'{key}.wav'
                # Match the installed library's input-subtype export behavior.
                sf.write(destination, data * 0.5, rate, subtype=info.subtype)
                files.append(str(destination))
            return files

        self.separator_class.return_value.separate.side_effect = generate_with_input_subtype
        for mode in ('quick', 'thorough'):
            stems = pipeline.run_separation(song, mode=mode)
            self.assertTrue(all(sf.info(stem['file']).format == 'WAV' for stem in stems))
            self.assertEqual(pipeline.file_digest(song), original_hash)
            self.separator_class.reset_mock()
            self.assertEqual(pipeline.run_separation(song, mode=mode, cached_only=True), stems)
            self.separator_class.assert_not_called()
        self.assertEqual(len(converted_paths), 2)
        self.assertTrue(all(not path.exists() for path in converted_paths))

    def test_wav_inputs_do_not_require_conversion(self):
        self.stage()
        self.assertEqual(Path(self.separator_class.return_value.separate.call_args.args[0]), self.song.resolve())

    def test_compressed_duration_uses_decoded_samples_even_when_header_is_longer(self):
        if not sf.check_format('MP3', 'MPEG_LAYER_III'):
            self.skipTest('This libsndfile cannot write the MP3 regression fixture')
        song = self.root / 'padded.mp3'
        sf.write(song, np.ones((44100, 2)) * 0.1, 44100)
        decoded, sr = sf.read(song)
        original_info = sf.info
        def padded_info(path, *args, **kwargs):
            info = original_info(path, *args, **kwargs)
            if Path(path).resolve() == song.resolve():
                return SimpleNamespace(subtype=info.subtype, duration=info.duration + 0.2,
                                       samplerate=info.samplerate, channels=info.channels)
            return info
        with patch.object(pipeline.sf, 'info', side_effect=padded_info):
            self.assertEqual(pipeline.audio_duration(song), len(decoded) / sr)
            stems = pipeline.run_separation(song, mode='quick')
            self.separator_class.reset_mock()
            self.assertEqual(pipeline.run_separation(song, mode='quick', cached_only=True), stems)
            self.separator_class.assert_not_called()

    def test_missing_or_corrupt_output_invalidates_cache(self):
        stems = self.stage()
        Path(stems[0]['file']).unlink()
        self.stage()
        Path(stems[0]['file']).write_bytes(b'corrupt')
        self.stage()
        self.assertEqual(self.separator_class.call_count, 3)

    def test_modified_valid_audio_invalidates_cache(self):
        stems = self.stage()
        sf.write(stems[0]['file'], np.zeros((44100, 2)), 44100)
        self.stage()
        self.assertEqual(self.separator_class.call_count, 2)

    def test_settings_model_and_input_changes_invalidate_cache(self):
        self.stage()
        settings = copy.deepcopy(pipeline.SEPARATOR_SETTINGS)
        settings['mdxc_params']['overlap'] = 2
        with patch.object(pipeline, 'SEPARATOR_SETTINGS', settings):
            self.stage()
        pipeline.separate_stage(self.song, 'different.ckpt', pipeline.BASE_STEMS, self.root / 'instruments')
        sf.write(self.song, np.zeros((44100, 2)), 44100)
        self.stage()
        self.assertEqual(self.separator_class.call_count, 4)

    def test_force_regenerates_all_stages(self):
        pipeline.run_separation(self.song)
        pipeline.run_separation(self.song, force=True)
        self.assertEqual(self.separator_class.call_count, 6)

    def test_analysis_only_requires_complete_cache_without_loading_models(self):
        with self.assertRaisesRegex(RuntimeError, 'without --analysis-only'):
            pipeline.run_separation(self.song, cached_only=True)
        self.separator_class.assert_not_called()

    def test_incomplete_stage_does_not_replace_previous_cache(self):
        stems = self.stage()
        manifest = (self.root / 'instruments' / 'manifest.json').read_text()
        hashes = [pipeline.file_digest(s['file']) for s in stems]
        self.separator_class.return_value.separate.side_effect = None
        self.separator_class.return_value.separate.return_value = ['snare.wav']
        with self.assertRaisesRegex(RuntimeError, 'bass'):
            self.stage(force=True)
        self.assertEqual((self.root / 'instruments' / 'manifest.json').read_text(), manifest)
        self.assertEqual([pipeline.file_digest(s['file']) for s in stems], hashes)

    def test_missing_and_truncated_outputs_are_rejected(self):
        def missing(audio_path, custom_output_names):
            return [f'{key}.wav' for key in custom_output_names.values()]
        self.separator_class.return_value.separate.side_effect = missing
        with self.assertRaises(FileNotFoundError):
            self.stage()
        def truncated(audio_path, custom_output_names):
            files = self.generate(audio_path, custom_output_names)
            folder = Path(self.separator_class.call_args.kwargs['output_dir'])
            sf.write(folder / 'bass.wav', np.zeros(10), 44100)
            return files
        self.separator_class.return_value.separate.side_effect = truncated
        with self.assertRaisesRegex(RuntimeError, 'duration'):
            self.stage()
        self.assertFalse((self.root / 'instruments' / 'manifest.json').exists())

    def test_partial_cache_reruns_only_missing_stage(self):
        pipeline.run_separation(self.song)
        (pipeline.song_directory(self.song) / 'vocal_parts' / 'backing_vocals.wav').unlink()
        self.separator_class.reset_mock()
        pipeline.run_separation(self.song)
        self.assertEqual(self.separator_class.call_count, 1)
        self.separator_class.return_value.load_model.assert_called_once_with(model_filename=pipeline.VOCAL_MODEL)

    def test_same_filename_with_new_content_has_separate_cache(self):
        first = pipeline.song_directory(self.song)
        sf.write(self.song, np.zeros((44100, 2)), 44100)
        self.assertNotEqual(pipeline.song_directory(self.song), first)

    def test_audio_separator_version_change_invalidates_cache(self):
        self.stage()
        with patch.object(pipeline, 'version', return_value='new-version'):
            self.stage()
        self.assertEqual(self.separator_class.call_count, 2)

    def test_progress_advances_through_stages_and_cached_outputs(self):
        for cached_only in (False, True):
            updates = []
            pipeline.run_separation(self.song, cached_only=cached_only, progress=lambda percent, message: updates.append(percent))
            self.assertEqual(updates[0], 5)
            self.assertEqual(updates[-1], 95)
            self.assertEqual(updates, sorted(updates))
            self.assertIn(40, updates)
            self.assertIn(55, updates)

    def test_renamed_identical_song_reuses_all_stages(self):
        stems = pipeline.run_separation(self.song)
        renamed = self.root / 'renamed.wav'
        shutil.copyfile(self.song, renamed)
        self.separator_class.reset_mock()
        self.assertEqual(pipeline.run_separation(renamed), stems)
        self.separator_class.assert_not_called()

    def test_auto_requests_float16_only_for_supported_roformer_models(self):
        pipeline.run_separation(self.song)
        calls = self.separator_class.call_args_list
        self.assertTrue(calls[0].kwargs['use_native_fp16'])
        self.assertNotIn('use_native_fp16', calls[1].kwargs)
        self.assertTrue(calls[2].kwargs['use_native_fp16'])

    def test_auto_reuses_float16_but_explicit_fp32_requires_full_precision_cache(self):
        self.separator_class.return_value.effective_precision = 'native_fp16'
        self.stage()
        self.separator_class.reset_mock()
        self.stage(cached_only=True)
        self.separator_class.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'without --analysis-only'):
            self.stage(cached_only=True, precision='fp32')
        self.separator_class.return_value.effective_precision = 'fp32'
        self.stage(precision='fp32')
        self.assertNotIn('use_native_fp16', self.separator_class.call_args.kwargs)
        self.stage(cached_only=True, precision='fp32')
        self.assertEqual(self.separator_class.call_count, 1)

    def test_legacy_full_precision_manifest_is_reused(self):
        self.stage()
        path = self.root / 'instruments' / 'manifest.json'
        manifest = json.loads(path.read_text())
        del manifest['execution']
        path.write_text(json.dumps(manifest))
        self.separator_class.reset_mock()
        self.stage(cached_only=True, precision='fp32')
        self.separator_class.assert_not_called()

    def test_model_is_released_when_inference_fails(self):
        self.separator_class.return_value.separate.side_effect = RuntimeError('inference failed')
        with self.assertRaisesRegex(RuntimeError, 'inference failed'):
            self.stage()
        self.release.assert_called_once_with(self.separator_class.return_value)
        self.assertFalse((self.root / 'instruments' / 'manifest.json').exists())

    def test_invalid_execution_metadata_is_rebuilt(self):
        self.stage()
        path = self.root / 'instruments' / 'manifest.json'
        manifest = json.loads(path.read_text())
        manifest['execution'] = []
        path.write_text(json.dumps(manifest))
        self.stage()
        self.assertEqual(self.separator_class.call_count, 2)

    def test_inaudible_vocals_preserve_residual_without_loading_model(self):
        data = np.full((44100, 2), 0.00001, dtype=np.float32)
        sf.write(self.song, data, 44100, subtype='FLOAT')
        stems = pipeline.separate_stage(self.song, pipeline.VOCAL_MODEL, pipeline.VOCAL_STEMS, self.root / 'vocal_parts')
        self.separator_class.assert_not_called()
        by_key = {stem['key']: stem['file'] for stem in stems}
        self.assertEqual(Path(by_key['lead_vocals']).read_bytes(), self.song.read_bytes())
        np.testing.assert_array_equal(sf.read(by_key['backing_vocals'])[0], np.zeros_like(data))
        self.assertEqual(pipeline.separate_stage(self.song, pipeline.VOCAL_MODEL, pipeline.VOCAL_STEMS, self.root / 'vocal_parts', cached_only=True), stems)

    def test_vocal_shortcut_checks_later_audio_not_just_the_intro(self):
        data = np.zeros((44100 * 3, 2), dtype=np.float32)
        data[-44100:] = 0.008
        sf.write(self.song, data, 44100, subtype='FLOAT')
        pipeline.separate_stage(self.song, pipeline.VOCAL_MODEL, pipeline.VOCAL_STEMS, self.root / 'vocal_parts')
        self.separator_class.assert_called_once()

    def test_vocal_shortcut_does_not_skip_audio_above_conservative_floor(self):
        sf.write(self.song, np.full((44100, 2), 0.00011), 44100, subtype='FLOAT')
        pipeline.separate_stage(self.song, pipeline.VOCAL_MODEL, pipeline.VOCAL_STEMS, self.root / 'vocal_parts')
        self.separator_class.assert_called_once()

    def test_quick_returns_four_stems_from_one_demucs_pass(self):
        updates = []
        stems = pipeline.run_separation(self.song, mode='quick', progress=lambda percent, message: updates.append(percent))
        self.assertEqual({stem['key'] for stem in stems}, {'bass', 'drums', 'other', 'vocals'})
        self.separator_class.assert_called_once()
        self.separator_class.return_value.load_model.assert_called_once_with(model_filename=pipeline.QUICK_MODEL)
        self.assertEqual(self.separator_class.call_args.kwargs['demucs_params']['shifts'], 0)
        self.assertNotIn('use_native_fp16', self.separator_class.call_args.kwargs)
        self.assertEqual(updates, sorted(updates))
        self.assertEqual((updates[0], updates[-1]), (5, 95))

    def test_modes_keep_separate_reusable_caches(self):
        quick = pipeline.run_separation(self.song, mode='quick')
        thorough = pipeline.run_separation(self.song, mode='thorough')
        self.assertEqual(self.separator_class.call_count, 4)
        self.separator_class.reset_mock()
        self.assertEqual(pipeline.run_separation(self.song, mode='quick', cached_only=True), quick)
        self.assertEqual(pipeline.run_separation(self.song, mode='thorough', cached_only=True), thorough)
        self.separator_class.assert_not_called()
        self.assertNotEqual(Path(quick[0]['file']).parent, Path(thorough[0]['file']).parent)

    def test_quick_cache_reused_for_renamed_song(self):
        original = pipeline.run_separation(self.song, mode='quick')
        renamed = self.root / 'renamed.wav'
        shutil.copyfile(self.song, renamed)
        self.separator_class.reset_mock()
        self.assertEqual(pipeline.run_separation(renamed, mode='quick', cached_only=True), original)
        self.separator_class.assert_not_called()

    def test_quick_analysis_only_does_not_use_thorough_cache(self):
        pipeline.run_separation(self.song)
        self.separator_class.reset_mock()
        with self.assertRaisesRegex(RuntimeError, 'without --analysis-only'):
            pipeline.run_separation(self.song, mode='quick', cached_only=True)
        self.separator_class.assert_not_called()

    def test_unknown_processing_mode_is_rejected_before_model_loading(self):
        with self.assertRaisesRegex(ValueError, 'quick or thorough'):
            pipeline.run_separation(self.song, mode='unknown')
        self.separator_class.assert_not_called()


class SeparatorRuntimeTests(unittest.TestCase):
    def test_telemetry_is_disabled_before_separator_initialization(self):
        events = []
        runtime = SimpleNamespace(disable_telemetry_events=Mock(side_effect=lambda: events.append('disable')))
        separator_class = Mock(side_effect=lambda **kwargs: events.append('initialize'))
        with patch.dict(sys.modules, {
            'onnxruntime': runtime,
            'audio_separator.separator': SimpleNamespace(Separator=separator_class),
        }):
            pipeline.create_separator(output_format='WAV')
        self.assertEqual(events, ['disable', 'initialize'])
        runtime.disable_telemetry_events.assert_called_once_with()
        separator_class.assert_called_once_with(output_format='WAV')


if __name__ == '__main__':
    unittest.main()
