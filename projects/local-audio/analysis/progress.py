"""Send processing progress to the upload server without changing terminal logs."""

import json
import re
import sys
from contextlib import contextmanager, redirect_stderr

PREFIX = "MIX_ROOM_PROGRESS "


def report_progress(percent, message):
    print(PREFIX + json.dumps({"percent": round(percent, 1), "message": message}), flush=True)


class ModelProgressStream:
    """Forward stderr and read Audio Separator's tqdm inference counters."""

    def __init__(self, stream, callback):
        self.stream = stream
        self.callback = callback
        self.pending = ""
        self.last_count = None

    def write(self, text):
        written = self.stream.write(text)
        self.pending += text
        parts = re.split(r"[\r\n]", self.pending)
        self.pending = parts.pop()[-4096:]
        for line in parts:
            self.read_counter(line)
        # tqdm does not always terminate its current display with a newline.
        self.read_counter(self.pending)
        return written

    def read_counter(self, line):
        match = re.search(r"\b(\d+)/(\d+)\s+\[", line)
        if match:
            current, total = map(int, match.groups())
            if total > 0 and 0 <= current <= total and (current, total) != self.last_count:
                self.last_count = current, total
                self.callback(current / total)

    def flush(self):
        self.stream.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


@contextmanager
def model_progress(callback):
    if callback is None:
        yield
    else:
        with redirect_stderr(ModelProgressStream(sys.stderr, callback)):
            yield
