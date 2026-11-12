import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

from progress import PREFIX, ModelProgressStream, model_progress, report_progress


class ProgressTests(unittest.TestCase):
    def test_partial_inference_counters_are_forwarded_and_reported_once(self):
        output = io.StringIO()
        updates = []
        stream = ModelProgressStream(output, updates.append)
        pieces = ['\r 10%|x | 1/', '10 [00:01<00:09]', '\r 50%|xx | 5/10 [00:05<00:05]', '\n']
        for piece in pieces:
            stream.write(piece)
        self.assertEqual(updates, [0.1, 0.5])
        self.assertEqual(output.getvalue(), ''.join(pieces))

    def test_download_counters_and_unrelated_logs_are_ignored(self):
        updates = []
        stream = ModelProgressStream(io.StringIO(), updates.append)
        stream.write('\r 25%|xxx | 175M/699M [00:12<00:30]\nWarning: audio writer\n')
        stream.write('\r 0/0 [00:00]\n\r 11/10 [00:01]\n')
        self.assertEqual(updates, [])

    def test_progress_protocol_is_json_and_rounds_percentage(self):
        output = io.StringIO()
        with redirect_stdout(output):
            report_progress(42.123, 'Separating drums')
        line = output.getvalue()
        self.assertTrue(line.startswith(PREFIX))
        self.assertEqual(json.loads(line[len(PREFIX):]), {'percent': 42.1, 'message': 'Separating drums'})

    def test_model_progress_restores_stderr_after_failure(self):
        output = io.StringIO()
        updates = []
        with redirect_stderr(output):
            with self.assertRaises(RuntimeError):
                with model_progress(updates.append):
                    sys.stderr.write('\r 2/4 [00:01]\n')
                    raise RuntimeError('Model failed')
            self.assertIs(sys.stderr, output)
        self.assertEqual(updates, [0.5])


if __name__ == '__main__':
    unittest.main()
