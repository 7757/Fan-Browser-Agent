from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from agent import redact
from agent.secret_sources.bitwarden import _run_bws_list
from agent.transports.codex_app_server import (
    _redact_error_payload,
    check_codex_binary,
)
from tools.environments.base import BaseEnvironment
from tools.process_registry import (
    _redact_process_result,
    format_process_notification,
)


class TerminalOutputRedactionTest(unittest.TestCase):
    def setUp(self):
        self._redaction = patch.object(redact, "_REDACT_ENABLED", True)
        self._redaction.start()

    def tearDown(self):
        self._redaction.stop()

    def test_environment_dump_masks_opaque_token_without_mangling_safe_env(self):
        secret = "opaque-service-token-123456789"
        output = f"MY_SERVICE_TOKEN={secret}\nHOME=/home/fan"

        result = redact.redact_terminal_output(output, "printenv")

        self.assertNotIn(secret, result)
        self.assertIn("HOME=/home/fan", result)

    def test_shell_c_environment_dump_is_detected(self):
        self.assertTrue(redact.is_env_dump_command("bash -c 'printenv | sort'"))
        self.assertTrue(redact.is_env_dump_command("cat x && declare -x"))
        self.assertFalse(redact.is_env_dump_command("printf 'TOKEN=x'"))

    def test_source_output_keeps_false_positive_but_masks_real_key_shape(self):
        secret = "sk-proj-sourceleaksecret123456789"
        output = f"MAX_TOKENS=100\nOPENAI_API_KEY={secret}"

        result = redact.redact_terminal_output(output, "cat config.py")

        self.assertIn("MAX_TOKENS=100", result)
        self.assertNotIn(secret, result)

    def test_process_result_and_completion_notification_share_policy(self):
        secret = "opaque-background-token-123456789"
        event = {
            "type": "completion",
            "session_id": "proc-1",
            "command": "printenv",
            "exit_code": 0,
            "output": f"SERVICE_TOKEN={secret}\nHOME=/home/fan",
        }

        redacted = _redact_process_result(event)
        notification = format_process_notification(event)

        self.assertNotIn(secret, redacted["output"])
        self.assertNotIn(secret, notification or "")
        self.assertIn("HOME=/home/fan", notification or "")
        # Boundary redaction must not mutate the process registry's event.
        self.assertIn(secret, event["output"])


class _CaptureEnvironment(BaseEnvironment):
    def __init__(self):
        super().__init__(cwd="/tmp", timeout=30)
        self.commands: list[str] = []

    def _run_bash(
        self,
        cmd_string: str,
        *,
        login: bool = False,
        timeout: int = 120,
        stdin_data: str | None = None,
    ):
        self.commands.append(cmd_string)
        return object()

    def _wait_for_process(self, proc, *, timeout=None, interrupt_event=None):
        return {
            "output": f"{self._cwd_marker}/tmp{self._cwd_marker}\n",
            "exit_code": 0,
        }

    def cleanup(self):
        return None


class SnapshotPermissionBoundaryTest(unittest.TestCase):
    def test_initial_snapshot_clamps_umask_before_metadata_writes(self):
        env = _CaptureEnvironment()

        env.init_session()

        bootstrap = env.commands[0]
        self.assertLess(bootstrap.index("umask 077"), bootstrap.index("export -p"))
        self.assertLess(bootstrap.index("umask 077"), bootstrap.index("pwd -P >"))

    def test_refresh_clamps_umask_only_after_user_command(self):
        env = _CaptureEnvironment()
        env._snapshot_ready = True

        wrapped = env._wrap_command("umask 022; touch user-file", "/tmp")

        user_command = wrapped.index("eval '")
        fan_umask = wrapped.index("umask 077")
        snapshot_write = wrapped.index("export -p >")
        cwd_write = wrapped.index("pwd -P >")
        self.assertLess(user_command, fan_umask)
        self.assertLess(fan_umask, snapshot_write)
        self.assertLess(fan_umask, cwd_write)


class ExceptionOutputRedactionTest(unittest.TestCase):
    def test_codex_error_data_is_redacted_recursively(self):
        secret = "sk-proj-nestederrorsecret123456789"
        payload = {
            "detail": [
                {"stderr": f"OPENAI_API_KEY={secret}"},
                "ordinary context",
            ]
        }

        result = _redact_error_payload(payload)

        self.assertNotIn(secret, str(result))
        self.assertEqual(result["detail"][1], "ordinary context")

    def test_bitwarden_failure_never_echoes_bootstrap_token(self):
        token = "opaque-bitwarden-bootstrap-token-123456789"
        failed = type(
            "Completed",
            (),
            {
                "returncode": 1,
                "stdout": "",
                "stderr": f"server rejected {token}",
            },
        )()
        with patch(
            "agent.secret_sources.bitwarden.subprocess.run", return_value=failed
        ):
            with self.assertRaises(RuntimeError) as caught:
                _run_bws_list(
                    Path("/trusted/bws"),
                    token,
                    "project-id",
                )

        self.assertNotIn(token, str(caught.exception))

    def test_codex_version_parse_failure_redacts_child_stdout(self):
        secret = "sk-proj-codexversionleak123456789"
        completed = type(
            "Completed",
            (),
            {"returncode": 0, "stdout": f"OPENAI_API_KEY={secret}", "stderr": ""},
        )()
        with (
            patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}, clear=True),
            patch(
                "agent.transports.codex_app_server.subprocess.run",
                return_value=completed,
            ),
        ):
            ok, message = check_codex_binary()

        self.assertFalse(ok)
        self.assertNotIn(secret, message)


if __name__ == "__main__":
    unittest.main()
