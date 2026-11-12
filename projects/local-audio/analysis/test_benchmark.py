import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_measures_a_real_process_with_private_output_and_fresh_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            song = root / 'song with spaces.wav'
            song.write_bytes(b'fixture')
            (root / 'analysis.py').write_text('''
import argparse, json, time
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('song')
parser.add_argument('--mode')
parser.add_argument('--force', action='store_true')
parser.add_argument('--output-dir')
args = parser.parse_args()
assert args.force
assert Path(args.song).read_bytes() == b'fixture'
Path('observed.json').write_text(json.dumps(vars(args)))
allocation = bytearray(32 * 1024 * 1024)
time.sleep(0.6)
Path(args.output_dir, 'instrument_meta.json').write_text('{}')
''')
            with patch.object(benchmark, 'ROOT', root):
                result = benchmark.run_mode(song, 'quick')
            self.assertEqual(result['exit_code'], 0)
            self.assertGreaterEqual(result['seconds'], 0.6)
            self.assertGreater(result['peak_ram_gib'], 0.03)
            args = json.loads((root / 'observed.json').read_text())
            self.assertEqual(args['mode'], 'quick')
            self.assertFalse(Path(args['output_dir']).exists())
            self.assertEqual(song.read_bytes(), b'fixture')

    def test_failure_writes_a_report_and_skips_the_next_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            song = root / 'song.wav'
            song.write_bytes(b'fixture')
            result = {'mode': 'quick', 'seconds': 1, 'peak_ram_gib': 0.5, 'exit_code': 1}
            with patch.object(benchmark, 'ROOT', root), patch.object(sys, 'argv', ['benchmark.py', str(song), '--mode', 'both']), patch.object(benchmark, 'run_mode', return_value=result) as run:
                self.assertEqual(benchmark.main(), 1)
            run.assert_called_once_with(song.resolve(), 'quick')
            reports = list((root / 'benchmarks').glob('*.json'))
            self.assertEqual(len(reports), 1)
            self.assertNotIn(':', reports[0].name)
            self.assertEqual(json.loads(reports[0].read_text())['results'], [result])


if __name__ == '__main__':
    unittest.main()
