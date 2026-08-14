import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fan_cli import crash_log
from fan_cli.crash_log import append_redacted_crash


class CrashLogTest(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory(prefix="fan-crash-log-")
        self.root = Path(self._temp.name)
        self.path = self.root / "logs" / "gateway_crash.log"

    def tearDown(self):
        self._temp.cleanup()

    def test_redacts_and_rotates(self):
        append_redacted_crash(
            self.path,
            "first",
            "Bearer first-secret user=a@example.com /Users/alice/work",
            max_bytes=160,
            backups=2,
        )
        append_redacted_crash(self.path, "second", "x" * 130, max_bytes=160, backups=2)
        current = self.path.read_text(encoding="utf-8")
        rotated = Path(f"{self.path}.1").read_text(encoding="utf-8")
        self.assertIn("second", current)
        self.assertNotIn("first-secret", rotated)
        self.assertNotIn("a@example.com", rotated)
        self.assertNotIn("/Users/alice", rotated)
        if os.name != "nt":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_refuses_symlink_target(self):
        self.path.parent.mkdir(parents=True)
        outside = self.root / "outside.txt"
        outside.write_text("private", encoding="utf-8")
        try:
            self.path.symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable")
        with self.assertRaises(OSError):
            append_redacted_crash(self.path, "unsafe", "trace")
        self.assertEqual(outside.read_text(encoding="utf-8"), "private")

    def test_writes_when_fchmod_is_unavailable(self):
        with patch.object(crash_log.os, "fchmod", None, create=True):
            append_redacted_crash(self.path, "windows", "trace")

        self.assertIn("windows", self.path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
