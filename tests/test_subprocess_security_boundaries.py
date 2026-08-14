from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, mock_open, patch

from agent.copilot_acp_client import _build_subprocess_env as copilot_env
from agent.secret_sources.bitwarden import _run_bws_list
from agent.transports.codex_app_server import CodexAppServerClient
from agent.lsp.install import _install_subprocess_env
from fan_cli.kanban_db import Task, _default_spawn
from tools.environments import local
from tools.lazy_deps import _venv_pip_install
from tools.mcp_tool import _build_safe_env as mcp_env


_SAFE_ENV = {
    "HOME": "/home/fan-test",
    "PATH": "/usr/bin:/bin",
    "LANG": "en_US.UTF-8",
    "FAN_TEST_VISIBLE": "yes",
}

_ACTIVE_PROVIDER_ENV = {
    "DASHSCOPE_API_KEY": "dashscope-secret",
    "DASHSCOPE_BASE_URL": "https://dashscope.example/v1",
    "OPENAI_API_KEY": "openai-custom-secret",
    "OPENAI_BASE_URL": "https://custom.example/v1",
    "OPENROUTER_API_KEY": "openrouter-custom-secret",
    "OPENROUTER_BASE_URL": "https://openrouter.example/v1",
    "CUSTOM_BASE_URL": "https://named-custom.example/v1",
    "OLLAMA_API_KEY": "ollama-cloud-secret",
}

_NON_PROVIDER_SECRETS = {
    "GITHUB_TOKEN": "github-tool-secret",
    "NOTION_API_KEY": "notion-skill-secret",
    "BWS_ACCESS_TOKEN": "bitwarden-bootstrap-secret",
    "FAN_APP_CLIENT_SECRET": "fan-server-client-secret",
    "FAN_API_KEY": "fan-control-secret",
    "API_SERVER_KEY": "fan-api-server-secret",
    "ELECTRON_BROWSER_RUNTIME_URL": "http://127.0.0.1:45678",
    "ELECTRON_BROWSER_RUNTIME_TOKEN": "desktop-browser-capability",
    "FAN_DESKTOP_SESSION_TOKEN": "desktop-session-capability",
    "AUXILIARY_APPROVAL_API_KEY": "approval-side-model-secret",
    "AUXILIARY_APPROVAL_BASE_URL": "http://private-approval.internal/v1",
}


class FanSubprocessEnvironmentTest(unittest.TestCase):
    def _build(self, *, inherit: bool, extra: dict[str, str] | None = None):
        source = {
            **_SAFE_ENV,
            **_ACTIVE_PROVIDER_ENV,
            **_NON_PROVIDER_SECRETS,
            # This provider was removed from Fan. Its historical env variable
            # must not be revived by the model-child compatibility allowlist.
            "ANTHROPIC_API_KEY": "removed-provider-secret",
            "VIRTUAL_ENV": "/tmp/parent-venv",
            "CONDA_PREFIX": "/tmp/parent-conda",
        }
        with patch.dict(os.environ, source, clear=True):
            return local.fan_subprocess_env(
                inherit_provider_credentials=inherit,
                extra_env=extra,
            )

    def test_installer_child_gets_no_fan_managed_credentials(self):
        result = self._build(inherit=False)

        self.assertEqual(result["FAN_TEST_VISIBLE"], "yes")
        self.assertEqual(result["LANG"], "en_US.UTF-8")
        self.assertEqual(result["PYTHONUTF8"], "1")
        for name in {
            *_ACTIVE_PROVIDER_ENV,
            *_NON_PROVIDER_SECRETS,
            "ANTHROPIC_API_KEY",
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
        }:
            self.assertNotIn(name, result, name)

    def test_model_child_gets_only_current_fan_provider_credentials(self):
        result = self._build(inherit=True)

        for name, value in _ACTIVE_PROVIDER_ENV.items():
            self.assertEqual(result.get(name), value, name)
        for name in {*_NON_PROVIDER_SECRETS, "ANTHROPIC_API_KEY"}:
            self.assertNotIn(name, result, name)

    def test_explicit_extra_env_cannot_restore_internal_or_skill_secrets(self):
        result = self._build(
            inherit=True,
            extra={
                "NOTION_API_KEY": "extra-notion-secret",
                "AUXILIARY_APPROVAL_API_KEY": "extra-approval-secret",
                "ELECTRON_BROWSER_RUNTIME_TOKEN": "extra-browser-token",
                "OPENAI_API_KEY": "explicit-current-provider-key",
            },
        )

        self.assertEqual(
            result.get("OPENAI_API_KEY"), "explicit-current-provider-key"
        )
        self.assertNotIn("NOTION_API_KEY", result)
        self.assertNotIn("AUXILIARY_APPROVAL_API_KEY", result)
        self.assertNotIn("ELECTRON_BROWSER_RUNTIME_TOKEN", result)

    def test_browser_runtime_capability_requires_dedicated_opt_in(self):
        source = {
            **_SAFE_ENV,
            "ELECTRON_BROWSER_RUNTIME_URL": "http://127.0.0.1:45678",
            "ELECTRON_BROWSER_RUNTIME_TOKEN": "desktop-browser-capability",
            "FAN_API_KEY": "control-secret",
        }
        with patch.dict(os.environ, source, clear=True):
            result = local.fan_subprocess_env(
                inherit_provider_credentials=True,
                inherit_browser_runtime_capability=True,
            )

        self.assertEqual(
            result.get("ELECTRON_BROWSER_RUNTIME_URL"),
            "http://127.0.0.1:45678",
        )
        self.assertEqual(
            result.get("ELECTRON_BROWSER_RUNTIME_TOKEN"),
            "desktop-browser-capability",
        )
        self.assertNotIn("FAN_API_KEY", result)

    def test_terminal_passthrough_cannot_restore_dynamic_internal_secrets(self):
        extra = {
            "AUXILIARY_APPROVAL_API_KEY": "approval-secret",
            "AUXILIARY_APPROVAL_BASE_URL": "http://private.internal/v1",
            "FAN_API_KEY": "control-secret",
            "FAN_TEST_VISIBLE": "yes",
        }
        with patch(
            "tools.env_passthrough.is_env_passthrough", return_value=True
        ):
            result = local._sanitize_subprocess_env({}, extra)

        self.assertEqual(result.get("FAN_TEST_VISIBLE"), "yes")
        self.assertNotIn("AUXILIARY_APPROVAL_API_KEY", result)
        self.assertNotIn("AUXILIARY_APPROVAL_BASE_URL", result)
        self.assertNotIn("FAN_API_KEY", result)

    def test_mcp_explicit_env_cannot_restore_dynamic_internal_secrets(self):
        result = mcp_env(
            {
                "AUXILIARY_APPROVAL_API_KEY": "approval-secret",
                "AUXILIARY_APPROVAL_BASE_URL": "http://private.internal/v1",
                "FAN_API_KEY": "control-secret",
                "MCP_EXPLICIT_SETTING": "yes",
            }
        )

        self.assertEqual(result.get("MCP_EXPLICIT_SETTING"), "yes")
        self.assertNotIn("AUXILIARY_APPROVAL_API_KEY", result)
        self.assertNotIn("AUXILIARY_APPROVAL_BASE_URL", result)
        self.assertNotIn("FAN_API_KEY", result)

    def test_copilot_acp_does_not_receive_fan_provider_or_control_secrets(self):
        with patch.dict(
            os.environ,
            {**_SAFE_ENV, **_ACTIVE_PROVIDER_ENV, **_NON_PROVIDER_SECRETS},
            clear=True,
        ):
            result = copilot_env()

        self.assertEqual(result.get("FAN_TEST_VISIBLE"), "yes")
        for name in {*_ACTIVE_PROVIDER_ENV, *_NON_PROVIDER_SECRETS}:
            self.assertNotIn(name, result, name)

    def test_codex_app_server_receives_provider_allowlist_only(self):
        fake_process = MagicMock()
        with (
            patch.dict(
                os.environ,
                {**_SAFE_ENV, **_ACTIVE_PROVIDER_ENV, **_NON_PROVIDER_SECRETS},
                clear=True,
            ),
            patch(
                "agent.transports.codex_app_server.subprocess.Popen",
                return_value=fake_process,
            ) as popen,
            patch("agent.transports.codex_app_server.threading.Thread.start"),
        ):
            CodexAppServerClient(
                env={
                    "NOTION_API_KEY": "explicit-skill-secret",
                    "AUXILIARY_APPROVAL_API_KEY": "explicit-side-model-secret",
                }
            )

        child_env = popen.call_args.kwargs["env"]
        for name, value in _ACTIVE_PROVIDER_ENV.items():
            self.assertEqual(child_env.get(name), value, name)
        for name in {*_NON_PROVIDER_SECRETS, "NOTION_API_KEY"}:
            self.assertNotIn(name, child_env, name)


class ExplicitSecretChildTest(unittest.TestCase):
    def test_lsp_package_installers_get_no_fan_managed_credentials(self):
        with patch.dict(
            os.environ,
            {**_SAFE_ENV, **_ACTIVE_PROVIDER_ENV, **_NON_PROVIDER_SECRETS},
            clear=True,
        ):
            child_env = _install_subprocess_env({"GOBIN": "/tmp/fan-lsp-bin"})

        self.assertEqual(child_env.get("GOBIN"), "/tmp/fan-lsp-bin")
        for name in {*_ACTIVE_PROVIDER_ENV, *_NON_PROVIDER_SECRETS}:
            self.assertNotIn(name, child_env, name)

    def test_bitwarden_child_receives_only_its_explicit_bootstrap_token(self):
        completed = SimpleNamespace(returncode=0, stdout="[]", stderr="")
        with (
            patch.dict(
                os.environ,
                {**_SAFE_ENV, **_ACTIVE_PROVIDER_ENV, **_NON_PROVIDER_SECRETS},
                clear=True,
            ),
            patch(
                "agent.secret_sources.bitwarden.subprocess.run",
                return_value=completed,
            ) as run,
        ):
            _run_bws_list(
                Path("/trusted/bws"),
                "explicit-bws-token",
                "project-id",
                "https://vault.example",
            )

        child_env = run.call_args.kwargs["env"]
        self.assertEqual(child_env.get("BWS_ACCESS_TOKEN"), "explicit-bws-token")
        self.assertEqual(child_env.get("BWS_SERVER_URL"), "https://vault.example")
        for name in {*_ACTIVE_PROVIDER_ENV, *_NON_PROVIDER_SECRETS} - {
            "BWS_ACCESS_TOKEN"
        }:
            self.assertNotIn(name, child_env, name)

    def test_lazy_dependency_installer_uses_sanitized_env_and_output(self):
        raw_secret = "sk-proj-lazydependencysecret123456789"
        completed = subprocess.CompletedProcess(
            args=["uv"],
            returncode=0,
            stdout=f"OPENAI_API_KEY={raw_secret}\ninstalled",
            stderr="",
        )
        with (
            patch.dict(
                os.environ,
                {**_SAFE_ENV, **_ACTIVE_PROVIDER_ENV, **_NON_PROVIDER_SECRETS},
                clear=True,
            ),
            patch("tools.lazy_deps.shutil.which", return_value="/usr/bin/uv"),
            patch("tools.lazy_deps.subprocess.run", return_value=completed) as run,
        ):
            result = _venv_pip_install(("safe-package==1.0",))

        child_env = run.call_args.kwargs["env"]
        for name in {*_ACTIVE_PROVIDER_ENV, *_NON_PROVIDER_SECRETS}:
            self.assertNotIn(name, child_env, name)
        self.assertIn("VIRTUAL_ENV", child_env)
        self.assertTrue(result.success)
        self.assertNotIn(raw_secret, result.stdout)


class ModelWorkerEnvironmentTest(unittest.TestCase):
    def test_kanban_worker_receives_provider_allowlist_not_parent_keyring(self):
        task = Task(
            id="task-1",
            title="test task",
            body=None,
            assignee="worker",
            status="ready",
            priority=1,
            created_by=None,
            created_at=0,
            started_at=None,
            completed_at=None,
            workspace_kind="shared",
            workspace_path=None,
            claim_lock=None,
            claim_expires=None,
            tenant=None,
        )
        fake_process = MagicMock(pid=12345)
        with tempfile.TemporaryDirectory(prefix="fan-kanban-env-") as temp:
            temp_path = Path(temp)
            with (
                patch.dict(
                    os.environ,
                    {**_SAFE_ENV, **_ACTIVE_PROVIDER_ENV, **_NON_PROVIDER_SECRETS},
                    clear=True,
                ),
                patch("fan_cli.kanban_db._resolve_fan_argv", return_value=["fan"]),
                patch(
                    "fan_cli.kanban_db._kanban_worker_skill_available",
                    return_value=False,
                ),
                patch(
                    "fan_cli.kanban_db.worker_logs_dir",
                    return_value=temp_path / "logs",
                ),
                patch(
                    "fan_cli.kanban_db.kanban_db_path",
                    return_value=temp_path / "kanban.db",
                ),
                patch(
                    "fan_cli.kanban_db.workspaces_root",
                    return_value=temp_path / "workspaces",
                ),
                patch(
                    "fan_cli.kanban_db.worker_log_rotation_config",
                    return_value=(1024 * 1024, 1),
                ),
                patch(
                    "fan_cli.kanban_db.subprocess.Popen",
                    return_value=fake_process,
                ) as popen,
                patch("builtins.open", mock_open()),
            ):
                self.assertEqual(_default_spawn(task, temp), 12345)

        child_env = popen.call_args.kwargs["env"]
        for name, value in _ACTIVE_PROVIDER_ENV.items():
            self.assertEqual(child_env.get(name), value, name)
        self.assertEqual(
            child_env.get("ELECTRON_BROWSER_RUNTIME_URL"),
            _NON_PROVIDER_SECRETS["ELECTRON_BROWSER_RUNTIME_URL"],
        )
        self.assertEqual(
            child_env.get("ELECTRON_BROWSER_RUNTIME_TOKEN"),
            _NON_PROVIDER_SECRETS["ELECTRON_BROWSER_RUNTIME_TOKEN"],
        )
        for name in _NON_PROVIDER_SECRETS.keys() - {
            "ELECTRON_BROWSER_RUNTIME_URL",
            "ELECTRON_BROWSER_RUNTIME_TOKEN",
        }:
            self.assertNotIn(name, child_env, name)
        self.assertEqual(child_env.get("FAN_KANBAN_TASK"), "task-1")


if __name__ == "__main__":
    unittest.main()
