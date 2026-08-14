from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from fan_cli import config
from tools import mcp_tool
from tools.environments import local


_SESSION = "FAN_DESKTOP_SESSION_TOKEN"
_DIAGNOSTIC = "FAN_DESKTOP_DIAGNOSTIC_TOKEN"
_VERIFY = "FAN_DESKTOP_DIAGNOSTIC_VERIFY_KEY"


class PrivateSubprocessEnvTest(unittest.TestCase):
    def test_main_latches_desktop_env_before_plugin_discovery(self):
        project_root = Path(__file__).resolve().parents[1]
        source = (project_root / "fan_cli" / "main.py").read_text(encoding="utf-8")
        bootstrap = source.index("import fan_bootstrap")
        latch = source.index("from fan_cli import desktop_private_env")
        plugins = source.index("discover_plugins()", latch)
        self.assertLess(bootstrap, latch)
        self.assertLess(latch, plugins)

    def test_terminal_and_process_env_cannot_force_or_passthrough_capabilities(self):
        base = {
            "PATH": os.environ.get("PATH", ""),
            _SESSION: "base-session",
            _DIAGNOSTIC: "base-diagnostic",
            _VERIFY: "base-public-key",
        }
        extra = {
            _SESSION: "extra-session",
            _DIAGNOSTIC: "extra-diagnostic",
            _VERIFY: "extra-public-key",
            _SESSION.lower(): "lower-session",
            _DIAGNOSTIC.lower(): "lower-diagnostic",
            _VERIFY.lower(): "lower-public-key",
            f"_FAN_FORCE_{_SESSION}": "forced-session",
            f"_FAN_FORCE_{_DIAGNOSTIC}": "forced-diagnostic",
            f"_FAN_FORCE_{_VERIFY}": "forced-public-key",
            "FAN_TEST_VISIBLE": "yes",
        }
        with patch("tools.env_passthrough.is_env_passthrough", return_value=True):
            sanitized = local._sanitize_subprocess_env(base, extra)

        self.assertNotIn(_SESSION, sanitized)
        self.assertNotIn(_DIAGNOSTIC, sanitized)
        self.assertNotIn(_VERIFY, sanitized)
        self.assertNotIn(_SESSION.lower(), sanitized)
        self.assertNotIn(_DIAGNOSTIC.lower(), sanitized)
        self.assertNotIn(_VERIFY.lower(), sanitized)
        self.assertEqual(sanitized["FAN_TEST_VISIBLE"], "yes")

        inherited = {
            _SESSION: "parent-session",
            _DIAGNOSTIC: "parent-diagnostic",
            _VERIFY: "parent-public-key",
        }
        with (
            patch.dict(os.environ, inherited),
            patch("tools.env_passthrough.is_env_passthrough", return_value=True),
        ):
            run_env = local._make_run_env(extra)

        self.assertNotIn(_SESSION, run_env)
        self.assertNotIn(_DIAGNOSTIC, run_env)
        self.assertNotIn(_VERIFY, run_env)
        self.assertEqual(run_env["FAN_TEST_VISIBLE"], "yes")

    def test_mcp_explicit_env_cannot_restore_desktop_capabilities(self):
        safe_env = mcp_tool._build_safe_env(
            {
                _SESSION: "configured-session",
                _DIAGNOSTIC: "configured-diagnostic",
                _VERIFY: "configured-public-key",
                _SESSION.lower(): "configured-lower-session",
                _DIAGNOSTIC.lower(): "configured-lower-diagnostic",
                _VERIFY.lower(): "configured-lower-public-key",
                "MCP_VISIBLE_SETTING": "yes",
            }
        )

        self.assertNotIn(_SESSION, safe_env)
        self.assertNotIn(_DIAGNOSTIC, safe_env)
        self.assertNotIn(_VERIFY, safe_env)
        self.assertNotIn(_SESSION.lower(), safe_env)
        self.assertNotIn(_DIAGNOSTIC.lower(), safe_env)
        self.assertNotIn(_VERIFY.lower(), safe_env)
        self.assertEqual(safe_env["MCP_VISIBLE_SETTING"], "yes")

    def test_env_writer_and_reload_cannot_restore_process_only_capabilities(self):
        for key in (
            _SESSION,
            _DIAGNOSTIC,
            _VERIFY,
            _SESSION.lower(),
            _DIAGNOSTIC.lower(),
            _VERIFY.lower(),
        ):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    config._reject_denylisted_env_var(key)

        with (
            patch.object(
                config,
                "load_env",
                return_value={
                    _SESSION: "persisted-session",
                    _DIAGNOSTIC: "persisted-diagnostic",
                    _VERIFY: "persisted-public-key",
                    _SESSION.lower(): "persisted-lower-session",
                    _DIAGNOSTIC.lower(): "persisted-lower-diagnostic",
                    _VERIFY.lower(): "persisted-lower-public-key",
                    "FAN_TEST_RELOADED": "yes",
                },
            ),
            patch.dict(
                os.environ,
                {
                    _SESSION: "existing-session",
                    _DIAGNOSTIC: "existing-diagnostic",
                    _VERIFY: "existing-public-key",
                },
            ),
        ):
            config.reload_env()
            self.assertNotIn(_SESSION, os.environ)
            self.assertNotIn(_DIAGNOSTIC, os.environ)
            self.assertNotIn(_VERIFY, os.environ)
            self.assertNotIn(_SESSION.lower(), os.environ)
            self.assertNotIn(_DIAGNOSTIC.lower(), os.environ)
            self.assertNotIn(_VERIFY.lower(), os.environ)
            self.assertEqual(os.environ["FAN_TEST_RELOADED"], "yes")

    def test_dashboard_consumes_session_and_public_verify_key_before_direct_child_spawn(self):
        project_root = Path(__file__).resolve().parents[1]
        script = r'''
import json
import os
import subprocess
import sys

from fan_cli import web_server

child_code = (
    "import json, os; "
    "print(json.dumps({"
    "'session': 'FAN_DESKTOP_SESSION_TOKEN' in os.environ, "
    "'diagnostic': 'FAN_DESKTOP_DIAGNOSTIC_TOKEN' in os.environ, "
    "'verify': 'FAN_DESKTOP_DIAGNOSTIC_VERIFY_KEY' in os.environ"
    "}))"
)
child = json.loads(subprocess.check_output(
    [sys.executable, "-c", child_code],
    env=os.environ.copy(),
    text=True,
))
print(json.dumps({
    "session_value": web_server._SESSION_TOKEN,
    "has_verify_key": web_server._DIAGNOSTIC_VERIFY_KEY is not None,
    "parent_session": "FAN_DESKTOP_SESSION_TOKEN" in os.environ,
    "parent_diagnostic": "FAN_DESKTOP_DIAGNOSTIC_TOKEN" in os.environ,
    "parent_verify": "FAN_DESKTOP_DIAGNOSTIC_VERIFY_KEY" in os.environ,
    "child": child,
}))
'''
        env = os.environ.copy()
        env[_SESSION] = "consume-session"
        env.pop(_DIAGNOSTIC, None)
        public_key = Ed25519PrivateKey.generate().public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        import base64

        env[_VERIFY] = base64.urlsafe_b64encode(public_key).rstrip(b"=").decode()
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=project_root,
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        observed = json.loads(result.stdout.strip().splitlines()[-1])

        self.assertEqual(observed["session_value"], "consume-session")
        self.assertTrue(observed["has_verify_key"])
        self.assertFalse(observed["parent_session"])
        self.assertFalse(observed["parent_diagnostic"])
        self.assertFalse(observed["parent_verify"])
        self.assertEqual(
            observed["child"],
            {"session": False, "diagnostic": False, "verify": False},
        )


if __name__ == "__main__":
    unittest.main()
