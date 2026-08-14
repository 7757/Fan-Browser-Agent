import json
import os
import platform
import shutil
import shlex
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from tools.approval import detect_protected_write_command
from tools.terminal_tool import terminal_tool
from agent.file_safety import (
    FAN_AUTHORITY_STATE_FILENAMES,
    build_agent_write_sandbox_profile,
    get_read_block_error,
    raise_if_read_blocked,
    wrap_agent_subprocess_argv,
)


@pytest.fixture()
def fan_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "fan-state"
    home.mkdir()
    monkeypatch.setenv("FAN_HOME", str(home))
    return home


@pytest.mark.parametrize(
    "command",
    [
        "echo 'security: off' > $FAN_HOME/config.yaml",
        "printf '%s\\n' x >> \"${FAN_HOME}/auth.json\"",
        "printf x | tee -a $FAN_HOME/config.validated.yaml",
        "sed -i.bak 's/a/b/' $FAN_HOME/config.yaml",
        "cp /tmp/replacement $FAN_HOME/client_config_cache.json",
        "mv /tmp/replacement $FAN_HOME/auth.json",
        "rm -f $FAN_HOME/config.yaml",
        "truncate -s 0 $FAN_HOME/auth.json",
        "dd if=/dev/null of=$FAN_HOME/config.yaml",
        "ln $FAN_HOME/config.yaml /tmp/fan-config-hardlink",
        "sh -c 'echo disabled > $FAN_HOME/config.yaml'",
        "cd $FAN_HOME && echo disabled > config.yaml",
    ],
)
def test_detects_static_terminal_writes_to_fan_authority_state(
    fan_home: Path,
    command: str,
) -> None:
    blocked, operation, target = detect_protected_write_command(command, cwd="/tmp")

    assert blocked is True
    assert operation
    assert target
    assert Path(target).parent == fan_home


@pytest.mark.parametrize(
    "command",
    [
        "cat $FAN_HOME/config.yaml",
        "rg allow_private_urls $FAN_HOME/config.yaml",
        "stat $FAN_HOME/auth.json",
        "cp $FAN_HOME/config.yaml /tmp/config-backup.yaml",
        "echo 'rm $FAN_HOME/config.yaml'",
        "printf '%s' '> $FAN_HOME/config.yaml'",
        "echo ok > /tmp/fan-terminal-guard-ok.txt",
    ],
)
def test_allows_read_only_or_unrelated_terminal_commands(
    fan_home: Path,
    command: str,
) -> None:
    assert detect_protected_write_command(command, cwd="/tmp") == (False, None, None)


def test_relative_target_uses_terminal_cwd(fan_home: Path) -> None:
    blocked, operation, target = detect_protected_write_command(
        "tee config.yaml",
        cwd=str(fan_home),
    )

    assert blocked is True
    assert operation == "tee"
    assert target == os.path.realpath(fan_home / "config.yaml")


def test_file_read_guard_covers_all_fan_authority_state(fan_home: Path) -> None:
    for filename in FAN_AUTHORITY_STATE_FILENAMES:
        error = get_read_block_error(str(fan_home / filename))
        assert error is not None, filename
        assert "Access denied" in error

    pairing_error = get_read_block_error(str(fan_home / "pairing" / "device.json"))
    assert pairing_error is not None
    assert "pairing" in pairing_error.lower()


def test_exception_read_guard_allows_media_and_blocks_credentials(
    fan_home: Path, tmp_path: Path
) -> None:
    image = tmp_path / "attachment.png"
    image.write_bytes(b"not-decoded-by-this-policy-test")
    raise_if_read_blocked(str(image))

    protected = fan_home / "auth.json"
    protected.write_text("{}", encoding="utf-8")
    with pytest.raises(PermissionError, match="Access denied"):
        raise_if_read_blocked(str(protected))


def test_terminal_force_cannot_bypass_protected_write_guard(fan_home: Path) -> None:
    command = "echo unsafe > $FAN_HOME/config.yaml"
    with patch("tools.terminal_tool._create_environment") as create_environment:
        result = json.loads(terminal_tool(command, force=True, workdir="/tmp"))

    assert result["status"] == "blocked"
    assert "protected path" in result["error"]
    assert not (fan_home / "config.yaml").exists()
    # Environment creation can occur before the final live-cwd guard, but no
    # command execution is permitted. If an existing shared environment is
    # present, even creation is skipped.
    if create_environment.called:
        create_environment.return_value.execute.assert_not_called()


@pytest.mark.skipif(
    platform.system() != "Darwin" or not shutil.which("sandbox-exec"),
    reason="macOS Seatbelt sandbox is the current desktop security boundary",
)
def test_process_sandbox_blocks_generated_interpreter_and_link_bypasses(
    fan_home: Path,
    tmp_path: Path,
) -> None:
    protected = fan_home / "config.yaml"
    protected.write_text("safe\n", encoding="utf-8")
    script = tmp_path / "write.py"
    script.write_text(
        "from pathlib import Path\n"
        f"Path({str(protected)!r}).write_text('hacked')\n",
        encoding="utf-8",
    )

    generated = subprocess.run(
        wrap_agent_subprocess_argv([sys.executable, str(script)]),
        text=True,
        capture_output=True,
        check=False,
    )
    assert generated.returncode != 0
    assert protected.read_text(encoding="utf-8") == "safe\n"

    node = shutil.which("node")
    if node:
        node_attempt = subprocess.run(
            wrap_agent_subprocess_argv(
                [node, "-e", f"require('fs').writeFileSync({str(protected)!r}, 'hacked')"]
            ),
            text=True,
            capture_output=True,
            check=False,
        )
        assert node_attempt.returncode != 0
        assert protected.read_text(encoding="utf-8") == "safe\n"

    perl = shutil.which("perl")
    if perl:
        perl_program = f"open my $fh, '>', {str(protected)!r} or die $!; print $fh 'hacked';"
        perl_attempt = subprocess.run(
            wrap_agent_subprocess_argv([perl, "-e", perl_program]),
            text=True,
            capture_output=True,
            check=False,
        )
        assert perl_attempt.returncode != 0
        assert protected.read_text(encoding="utf-8") == "safe\n"

    hardlink = tmp_path / "hardlink"
    hardlink_attempt = subprocess.run(
        wrap_agent_subprocess_argv(["/bin/ln", str(protected), str(hardlink)]),
        text=True,
        capture_output=True,
        check=False,
    )
    assert hardlink_attempt.returncode != 0
    assert not hardlink.exists()

    symlink = tmp_path / "symlink"
    symlink.symlink_to(protected)
    symlink_attempt = subprocess.run(
        wrap_agent_subprocess_argv(
            ["/bin/sh", "-c", f"printf hacked > {str(symlink)!r}"]
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    assert symlink_attempt.returncode != 0
    assert protected.read_text(encoding="utf-8") == "safe\n"

    moved_root = fan_home.with_name(f"{fan_home.name}-moved")
    root_rename_attempt = subprocess.run(
        wrap_agent_subprocess_argv(["/bin/mv", str(fan_home), str(moved_root)]),
        text=True,
        capture_output=True,
        check=False,
    )
    assert root_rename_attempt.returncode != 0
    assert fan_home.is_dir()
    assert not moved_root.exists()


def test_sandbox_profile_uses_resolved_fan_state_root(fan_home: Path) -> None:
    profile = build_agent_write_sandbox_profile()
    if platform.system() == "Darwin" and shutil.which("sandbox-exec"):
        assert profile is not None
        assert "deny file-write*" in profile
        assert os.path.realpath(fan_home) in profile
    else:
        assert profile is None


@pytest.mark.skipif(
    platform.system() != "Darwin" or not Path("/usr/bin/sandbox-exec").is_file(),
    reason="macOS Seatbelt sandbox is the current desktop security boundary",
)
def test_sandbox_launcher_ignores_user_writable_path_entries(
    fan_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_launcher = fake_bin / "sandbox-exec"
    fake_launcher.write_text(
        "#!/bin/sh\n[ \"$1\" = \"-p\" ] && shift 2\nexec \"$@\"\n",
        encoding="utf-8",
    )
    fake_launcher.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}")

    protected = fan_home / "config.yaml"
    protected.write_text("safe\n", encoding="utf-8")
    wrapped = wrap_agent_subprocess_argv(
        ["/bin/sh", "-c", f"printf hacked > {shlex.quote(str(protected))}"]
    )
    result = subprocess.run(wrapped, capture_output=True, text=True, check=False)

    assert wrapped[0] == "/usr/bin/sandbox-exec"
    assert result.returncode != 0
    assert protected.read_text(encoding="utf-8") == "safe\n"


def test_macos_sandbox_launcher_failure_is_fail_closed() -> None:
    with (
        patch("agent.file_safety.platform.system", return_value="Darwin"),
        patch("agent.file_safety._trusted_macos_sandbox_exec", return_value=None),
        pytest.raises(RuntimeError, match="trusted macOS sandbox launcher"),
    ):
        wrap_agent_subprocess_argv(["/bin/true"])


@pytest.mark.skipif(
    platform.system() != "Darwin" or not Path("/usr/bin/sandbox-exec").is_file(),
    reason="macOS Seatbelt sandbox is the current desktop security boundary",
)
def test_sandbox_blocks_custom_fan_home_ancestor_relocation_without_blocking_siblings(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outer = tmp_path / "outer"
    parent = outer / "state-parent"
    fan_home = parent / "fan"
    fan_home.mkdir(parents=True)
    monkeypatch.setenv("FAN_HOME", str(fan_home))
    protected = fan_home / "config.yaml"
    protected.write_text("safe\n", encoding="utf-8")

    moved_parent = outer / "state-parent-moved"
    relocation = subprocess.run(
        wrap_agent_subprocess_argv(
            [
                "/bin/sh",
                "-c",
                (
                    f"mv {shlex.quote(str(parent))} {shlex.quote(str(moved_parent))} "
                    f"&& printf hacked > "
                    f"{shlex.quote(str(moved_parent / 'fan' / 'config.yaml'))}"
                ),
            ]
        ),
        capture_output=True,
        text=True,
        check=False,
    )
    assert relocation.returncode != 0
    assert parent.is_dir()
    assert not moved_parent.exists()
    assert protected.read_text(encoding="utf-8") == "safe\n"

    project_a = outer / "project-a"
    project_b = outer / "project-b"
    project_a.mkdir()
    ordinary = subprocess.run(
        wrap_agent_subprocess_argv(
            [
                "/bin/sh",
                "-c",
                (
                    f"printf ok > {shlex.quote(str(project_a / 'result.txt'))} "
                    f"&& mv {shlex.quote(str(project_a))} {shlex.quote(str(project_b))}"
                ),
            ]
        ),
        capture_output=True,
        text=True,
        check=False,
    )
    assert ordinary.returncode == 0, ordinary.stderr
    assert (project_b / "result.txt").read_text(encoding="utf-8") == "ok"


@pytest.mark.skipif(
    platform.system() != "Darwin" or not shutil.which("sandbox-exec"),
    reason="macOS Seatbelt sandbox is the current desktop security boundary",
)
def test_sandbox_keeps_isolated_subprocess_home_writable(fan_home: Path) -> None:
    ordinary_cache = fan_home / "home" / ".cache" / "tool" / "state.json"
    code = (
        "from pathlib import Path; "
        f"p=Path({str(ordinary_cache)!r}); p.parent.mkdir(parents=True); "
        "p.write_text('ok')"
    )

    result = subprocess.run(
        wrap_agent_subprocess_argv([sys.executable, "-c", code]),
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert ordinary_cache.read_text(encoding="utf-8") == "ok"


@pytest.mark.skipif(
    platform.system() != "Darwin" or not shutil.which("sandbox-exec"),
    reason="macOS Seatbelt sandbox is the current desktop security boundary",
)
def test_execute_code_inherits_authority_state_write_sandbox(fan_home: Path) -> None:
    from tools.code_execution_tool import execute_code

    protected = fan_home / "config.yaml"
    protected.write_text("security: {}\n", encoding="utf-8")
    code = (
        "from pathlib import Path\n"
        f"Path({str(protected)!r}).write_text('hacked')\n"
    )

    with patch(
        "tools.approval.check_execute_code_guard",
        return_value={"approved": True},
    ):
        result = json.loads(execute_code(code, enabled_tools=[]))

    assert result["status"] == "error"
    assert "Operation not permitted" in result["output"]
    assert protected.read_text(encoding="utf-8") == "security: {}\n"


@pytest.mark.skipif(
    platform.system() != "Darwin" or not shutil.which("sandbox-exec"),
    reason="macOS Seatbelt sandbox is the current desktop security boundary",
)
def test_local_terminal_environment_inherits_write_sandbox(
    fan_home: Path,
    tmp_path: Path,
) -> None:
    from tools.environments.local import LocalEnvironment

    protected = fan_home / "config.yaml"
    protected.write_text("security: {}\n", encoding="utf-8")
    code = f"from pathlib import Path; Path({str(protected)!r}).write_text('hacked')"
    environment = LocalEnvironment(cwd=str(tmp_path))
    try:
        result = environment.execute(f"python3 -c {shlex.quote(code)}")
    finally:
        environment.cleanup()

    assert result["returncode"] != 0
    assert "Operation not permitted" in result["output"]
    assert protected.read_text(encoding="utf-8") == "security: {}\n"
