"""Relays QEMU's log file into a pytest-embedded DUT's message queue.

A workaround for pytest-embedded 2.9.3, whose relay rereads the log in a loop
that never waits, so it and the queue's manager each keep over half a host core
busy per emulator. This relay sleeps at the end of the log. Install it as
`Qemu.REDIRECT_CLS`, and delete it once pytest-embedded's relay waits there.
"""

import time
from multiprocessing.context import SpawnProcess
from typing import Any

# How long the relay waits at the end of QEMU's log before reading again.
POLL_INTERVAL = 0.01


class QemuRelay(SpawnProcess):
    """A process that copies QEMU's log into a DUT's message queue as QEMU writes it."""

    def __init__(self, msg_queue: Any, logfile: str) -> None:
        super().__init__(target=_forward, args=(msg_queue, logfile), daemon=True)


def _forward(msg_queue: Any, logfile: str) -> None:
    # Binary: a text read fails on a UTF-8 sequence split at the end of the log.
    with open(logfile, "rb") as log:
        while True:
            chunk = log.read()
            if not chunk:
                time.sleep(POLL_INTERVAL)
                continue
            try:
                msg_queue.put(chunk)
            except OSError, EOFError:
                # The queue's manager has shut down.
                return
