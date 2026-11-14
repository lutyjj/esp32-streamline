"""Contract tests for the relay from QEMU's log file to a DUT's message queue.

Each test runs the relay as a process against pytest-embedded's own message
queue manager, as the QEMU service does.
"""

import os
import tempfile
import time
import unittest
from pathlib import Path

from pytest_embedded.log import MessageQueueManager

from streamline_tools.device.qemu_relay import QemuRelay


def _cpu_seconds(pid: int) -> float:
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")


class QemuRelayTest(unittest.TestCase):
    def setUp(self) -> None:
        manager = MessageQueueManager()
        manager.start()
        self.addCleanup(manager.shutdown)
        self.queue = manager.MessageQueue()
        self.log = Path(self.enterContext(tempfile.TemporaryDirectory())) / "qemu.log"
        self.log.write_bytes(b"boot\n")
        self.relay = QemuRelay(self.queue, str(self.log))
        self.relay.start()
        self.addCleanup(self.relay.join)
        self.addCleanup(self.relay.terminate)
        self.assertEqual(self.queue.get(timeout=30), b"boot\n")

    def test_forwards_what_qemu_appends(self) -> None:
        with self.log.open("ab") as log:
            log.write(b"console ready\n")
        self.assertEqual(self.queue.get(timeout=5), b"console ready\n")

    def test_idles_at_the_end_of_the_log(self) -> None:
        assert self.relay.pid is not None
        before = _cpu_seconds(self.relay.pid)
        time.sleep(1)
        self.assertLess(_cpu_seconds(self.relay.pid) - before, 0.1)


if __name__ == "__main__":
    unittest.main()
