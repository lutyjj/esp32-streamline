from __future__ import annotations

import os
import unittest

from streamline_tools.secret_input import read_secret_fd


class SecretInputTests(unittest.TestCase):
    def test_absent_descriptor_returns_empty(self) -> None:
        self.assertEqual(read_secret_fd({}, "SECRET_FD"), "")

    def test_reads_once_and_removes_descriptor_from_environment(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"fixture-key\n")
        finally:
            os.close(write_fd)
        environment = {"SECRET_FD": str(read_fd)}
        try:
            self.assertEqual(read_secret_fd(environment, "SECRET_FD"), "fixture-key")
        finally:
            os.close(read_fd)
        self.assertNotIn("SECRET_FD", environment)

    def test_rejects_oversized_input_without_echoing_it(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"sensitive-value")
        finally:
            os.close(write_fd)
        try:
            with self.assertRaisesRegex(ValueError, "exceeds 4 bytes") as raised:
                read_secret_fd({"SECRET_FD": str(read_fd)}, "SECRET_FD", limit=4)
        finally:
            os.close(read_fd)
        self.assertNotIn("sensitive-value", str(raised.exception))

    def test_rejects_invalid_descriptor_without_exposing_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "must name a file descriptor"):
            read_secret_fd({"SECRET_FD": "not-a-descriptor"}, "SECRET_FD")

    def test_rejects_non_utf8_without_echoing_it(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"\xffprivate")
        finally:
            os.close(write_fd)
        try:
            with self.assertRaisesRegex(ValueError, "must be UTF-8") as raised:
                read_secret_fd({"SECRET_FD": str(read_fd)}, "SECRET_FD")
        finally:
            os.close(read_fd)
        self.assertNotIn("private", str(raised.exception))
