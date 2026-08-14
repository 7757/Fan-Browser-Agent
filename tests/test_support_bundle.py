import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

from fan_cli.support_bundle import (
    SupportBundleContext,
    create_support_bundle,
    preview_support_logs,
)


class SupportBundleTest(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory(prefix="fan-support-bundle-")
        self.home = Path(self._temp.name)

    def tearDown(self):
        self._temp.cleanup()

    def write_log(self, name: str, text: str) -> Path:
        path = self.home / "logs" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_bundle_contains_only_redacted_selected_log_tails(self):
        self.write_log(
            "desktop.log",
            "user=a@example.com Bearer secret-token /Users/alice/work?api_key=hidden\n"
            "Prompt: my diagnosis is private\n"
            'tool_args={"query":"private customer data"}\n'
            "Cookie: session=alpha; csrf=bravo\n"
            "GET https://example.com/path?ordinary_private_value=leak\n"
            "token ghp_abcdefghijklmnopqrstuvwxyz1234567890 AKIA1234567890ABCDEF\n",
        )
        (self.home / "config.yaml").write_text("api_key: must-not-leak", encoding="utf-8")
        (self.home / "sessions.db").write_text("private conversation", encoding="utf-8")

        result = create_support_bundle(
            SupportBundleContext(diagnostic_id="diag_1", app_version="1.2.3"),
            fan_home=self.home,
            now=1_700_000_000,
        )

        with zipfile.ZipFile(result.path) as archive:
            self.assertEqual(set(archive.namelist()), {"logs/desktop.log", "manifest.json"})
            log_text = archive.read("logs/desktop.log").decode()
            manifest = json.loads(archive.read("manifest.json"))
        self.assertNotIn("secret-token", log_text)
        self.assertNotIn("hidden", log_text)
        self.assertNotIn("a@example.com", log_text)
        self.assertNotIn("/Users/alice", log_text)
        self.assertNotIn("my diagnosis is private", log_text)
        self.assertNotIn("private customer data", log_text)
        self.assertNotIn("csrf=bravo", log_text)
        self.assertNotIn("ordinary_private_value=leak", log_text)
        self.assertNotIn("ghp_", log_text)
        self.assertNotIn("AKIA1234567890ABCDEF", log_text)
        self.assertEqual(manifest["diagnostic"]["id"], "diag_1")
        self.assertTrue(manifest["privacy"]["mayContainUserProvidedText"])
        self.assertIn("sessions", manifest["privacy"]["sourceExclusions"])
        self.assertNotIn("config.yaml", json.dumps(manifest))
        if os.name != "nt":
            self.assertEqual(result.path.stat().st_mode & 0o777, 0o600)

    def test_preview_and_bundle_reject_unapproved_names(self):
        self.write_log(
            "agent.log",
            "2026-07-10T01:02:03Z start\n2026-07-10T01:04:05Z end\n",
        )
        preview = preview_support_logs(fan_home=self.home, log_names=["agent.log"])
        self.assertEqual(preview[0]["name"], "agent.log")
        self.assertEqual(preview[0]["selectedBytes"], preview[0]["sourceBytes"])
        self.assertFalse(preview[0]["truncated"])
        self.assertEqual(preview[0]["timeRangeStart"], "2026-07-10T01:02:03Z")
        self.assertEqual(preview[0]["timeRangeEnd"], "2026-07-10T01:04:05Z")
        self.assertRegex(preview[0]["modifiedAt"], r"^20\d\d-")
        with self.assertRaisesRegex(ValueError, "Unsupported support log"):
            create_support_bundle(
                SupportBundleContext(), fan_home=self.home, log_names=["../config.yaml"]
            )

    def test_symlinked_log_is_never_followed(self):
        outside = self.home / "secret.txt"
        outside.write_text("Bearer do-not-read", encoding="utf-8")
        logs = self.home / "logs"
        logs.mkdir()
        link = logs / "agent.log"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable")

        result = create_support_bundle(
            SupportBundleContext(), fan_home=self.home, log_names=["agent.log"]
        )
        with zipfile.ZipFile(result.path) as archive:
            self.assertNotIn("logs/agent.log", archive.namelist())

    def test_log_tail_is_bounded_and_marked_truncated(self):
        self.write_log("errors.log", "a" * 10_000)
        result = create_support_bundle(
            SupportBundleContext(),
            fan_home=self.home,
            log_names=["errors.log"],
            per_log_bytes=512,
            total_log_bytes=512,
        )
        self.assertEqual(result.files[0].source_bytes, 10_000)
        self.assertLessEqual(result.files[0].included_bytes, 512)
        self.assertTrue(result.files[0].truncated)


if __name__ == "__main__":
    unittest.main()
