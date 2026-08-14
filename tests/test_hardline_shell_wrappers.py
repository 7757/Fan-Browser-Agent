"""Hardline-floor regressions for nested shell execution.

The detector must inspect literal ``shell -c`` payloads without executing
them, while keeping destructive-looking documentation as ordinary data.
"""

import shlex

import pytest

from tools import approval


BLOCKED_COMMANDS = [
    "rm -rf /",
    'rm -rf "$HOME"',
    "sudo rm -rf /etc",
    "bash -c 'rm -rf /'",
    "sh -c 'rm -rf /etc'",
    "zsh -fc 'rm -rf ~'",
    "ksh -lc 'reboot'",
    "dash -c 'mkfs.ext4 /dev/sda1'",
    "ash -c 'dd if=/dev/zero of=/dev/sda'",
    "fish -c 'rm -rf /'",
    "fish --command='shutdown -h now'",
    "fish --init-command='rm -rf /'",
    "fish -C'rm -rf /'",
    "/bin/bash -lc 'rm -rf \"$HOME\"'",
    "/usr/bin/dash -c 'rm -rf /'",
    "/opt/homebrew/bin/fish -c 'rm -rf ~'",
    "env X=1 /bin/sh -c 'rm -rf /etc'",
    "env -i -u UNUSED bash -c 'rm -rf /'",
    "env -uUNUSED rm -rf /",
    "env -S \"bash -c 'rm -rf /'\"",
    r"env -S 'bash\_-c\_rm\ -rf\ /'",
    r"env '-Sbash\_-c\_rm\ -rf\ /'",
    "command -- bash -lc 'rm -rf /'",
    "nohup bash -c 'rm -rf ~'",
    "sudo -n -u root /bin/bash -c 'shutdown -h now'",
    "sudo --preserve-env=HOME -u=root bash -c 'rm -rf /'",
    "sudo -uroot rm -rf /",
    "setsid -f sh -c 'rm -rf /'",
    "setsid -c sh -c 'rm -rf /'",
    "time -f '%E' bash -c 'rm -rf /'",
    "time -f%E rm -rf /",
    "exec -a fan-shell bash -c 'rm -rf /'",
    "exec -afan-shell rm -rf /",
    "busybox ash -c 'rm -rf /'",
    "/bin/busybox sh -c 'rm -rf /'",
    "busybox rm -rf /",
    "true && bash -c 'rm -rf /'",
    "false || sh -c 'shutdown -h now'",
    "printf ok | zsh -c 'rm -rf /'",
    "if true; then bash -c 'rm -rf /'; fi",
    "coproc bash -c 'rm -rf /'",
    "while false; do sh -c 'rm -rf /'; done",
    "(bash -c 'rm -rf /')",
    "{ bash -c 'rm -rf /'; }",
    "echo \"$(bash -c 'rm -rf /')\"",
    "echo \"$(echo \"$(bash -c 'rm -rf /')\")\"",
    "echo `bash -c 'rm -rf /'`",
    "bash -c \"sh -c 'rm -rf /'\"",
    "bash -c 'echo ok; rm -rf /'",
    "bash -c 'rm -rf \"/\"'",
    "bash -c 'rm -rf \"$HOME\"'",
    "bash -c 'rm -rf \"${HOME}\"'",
    "bash -c 'rm -rf ~'",
    "bash +O extglob -c 'rm -rf /'",
    "zsh +o nomatch -c 'rm -rf /'",
    "bash -c 'eval \"rm -rf /\"'",
    "bash -c 'builtin eval \"rm -rf /\"'",
    "eval -- rm -rf /",
    "builtin eval -- reboot",
    "rm -rf //",
    "printf 'rm -rf /\\n' | bash",
    "echo 'rm -rf /' | sh",
    "bash <<< 'rm -rf /'",
    "bash <<< $'rm -rf /'",
    r"bash <<< $'\x72\x6d -rf /'",
    "bash 0<<< 'rm -rf /'",
    "bash <<'EOF'\nrm -rf /\nEOF",
    "bash 0<<'EOF'\nrm -rf /\nEOF",
    "bash -c 'bash' <<'EOF'\nrm -rf /\nEOF",
    "cat <<'EOF' | bash\nrm -rf /\nEOF",
    "trap 'rm -rf /' EXIT",
    "trap 'reboot' EXIT",
    "echo '<<EOF'\nrm -rf /\nEOF",
    "# <<EOF\nrm -rf /\nEOF",
    "printf '%s' '<<EOF'\nshutdown -h now\nEOF",
    "echo bad > /dev/sda",
]


@pytest.mark.parametrize("command", BLOCKED_COMMANDS)
def test_literal_shell_payloads_hit_hardline_floor(command):
    is_hardline, description = approval.detect_hardline_command(command)
    assert is_hardline is True, command
    assert description


SAFE_HARDLINE_COMMANDS = [
    "rm -rf /tmp/fan-test",
    "rm -rf ./build",
    'rm -rf "$TMP_DIR"',
    "bash -c 'rm -rf \"$BUILD_DIR\"'",
    'dd if=input.bin of="$TMP_DIR/output.bin" bs=1',
    'systemctl "$ACTION"',
    "bash -c 'echo ok'",
    "env FOO=bar bash -lc 'printf \"%s\\n\" \"$FOO\"'",
    "bash -c 'echo \"rm -rf /\"'",
    "bash -c 'printf \"%s\" \"shutdown -h now\"'",
    "bash -c 'git commit -m \"rm -rf /\"'",
    "bash -c 'eval echo \"rm -rf /\"'",
    "echo 'rm -rf /'",
    "printf '%s' 'rm -rf /'",
    "git commit -m 'fix bash -c rm -rf / bypass'",
    "echo 'mkfs.ext4 /dev/sda'",
    "printf '%s' 'dd if=x of=/dev/sda'",
    "git commit -m 'kill -1 is blocked'",
    "echo 'x > /dev/sda'",
    "echo '$(bash -c \"rm -rf /\")'",
    "echo '(reboot)'",
    "echo '{ rm -rf /; }'",
    "command -v bash",
    "command -V sh",
    "sudo -p 'bash -c rm -rf /' echo ok",
    "time -f 'bash -c rm -rf /' echo ok",
    "sudo echo 'bash -c rm -rf /'",
    "bash script.sh",
    # The command string is exactly `rm`; following argv are $0/$1, not source.
    "bash -c rm -rf /",
    # -- terminates shell option parsing, so the following -c is not an option.
    "bash -- -c 'rm -rf /'",
    "echo 'oops",
    "git commit -m 'oops",
    "sudo echo 'oops",
    "$EDITOR README.md",
    "printf 'echo ok\\n' | bash",
    "bash <<< 'echo ok'",
    "bash <<< $'echo ok'",
    "bash 0<<< 'echo ok'",
    'bash <<< "$SCRIPT"',
    "cat /tmp/script | bash",
    "bash /tmp/script",
    "cat <<'EOF'\nrm -rf /\nEOF",
    "cat <<EOF\nreboot\nEOF",
    "cat <<'EOF' | bash\necho ok\nEOF",
    "trap 'echo rm -rf /' EXIT",
    "trap - EXIT",
    "foo() { reboot; }",
    "echo $((reboot))",
]


@pytest.mark.parametrize("command", SAFE_HARDLINE_COMMANDS)
def test_documentation_and_benign_shell_commands_do_not_hit_hardline(command):
    is_hardline, description = approval.detect_hardline_command(command)
    assert is_hardline is False, (command, description)
    assert description is None


@pytest.mark.parametrize(
    "command",
    [
        "bash -c $'echo ok\\x3b rm -rf ~'",
        'bash -c "$SCRIPT"',
        "env --unknown bash -c 'rm -rf /'",
        "sudo --unknown bash -c 'rm -rf /'",
        "bash -c 'eval \"$SCRIPT\"'",
        "bash -c 'rm -rf /",
    ],
)
def test_uninspectable_shell_execution_fails_closed(command):
    is_hardline, description = approval.detect_hardline_command(command)
    assert is_hardline is True
    assert "uninspectable shell execution" in description


@pytest.mark.parametrize(
    "command",
    [
        'rm -rf "$HOME"',
        "bash -c 'rm -rf \"$HOME\"'",
        'dd if=/dev/zero of="/dev/$DISK"',
    ],
)
def test_dynamic_values_with_explicit_hardline_targets_still_fail_closed(command):
    is_hardline, description = approval.detect_hardline_command(command)
    assert is_hardline is True
    assert description


def _nested_shell(command: str, count: int) -> str:
    for _ in range(count):
        command = f"bash -c {shlex.quote(command)}"
    return command


def test_nested_shell_at_depth_limit_is_still_inspected():
    command = _nested_shell("rm -rf /", approval._HARDLINE_MAX_DEPTH)
    assert approval.detect_hardline_command(command)[0] is True


def test_nested_shell_past_depth_limit_fails_closed_even_when_benign():
    command = _nested_shell("echo ok", approval._HARDLINE_MAX_DEPTH + 1)
    is_hardline, description = approval.detect_hardline_command(command)
    assert is_hardline is True
    assert "depth exceeded" in description


def test_shell_payload_size_budget_fails_closed():
    payload = "echo " + ("x" * (approval._HARDLINE_MAX_PAYLOAD_CHARS + 1))
    command = f"bash -c {shlex.quote(payload)}"
    is_hardline, description = approval.detect_hardline_command(command)
    assert is_hardline is True
    assert "size budget exceeded" in description


def test_large_ordinary_data_command_is_not_promoted_to_hardline():
    command = "echo " + ("x" * (approval._HARDLINE_MAX_PAYLOAD_CHARS + 1))
    assert approval.detect_hardline_command(command) == (False, None)


@pytest.mark.parametrize("guard_name", ["check_dangerous_command", "check_all_command_guards"])
def test_process_yolo_cannot_bypass_nested_hardline(monkeypatch, guard_name):
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", True)
    guard = getattr(approval, guard_name)
    result = guard("bash -c 'rm -rf /'", "local")
    assert result["approved"] is False
    assert result["hardline"] is True


@pytest.mark.parametrize(
    "command",
    [
        "bash -c 'eval \"rm -rf /\"'",
        "eval -- rm -rf /",
        "printf 'rm -rf /\\n' | bash",
        "bash <<< 'rm -rf /'",
        "bash <<< $'rm -rf /'",
        "cat <<'EOF' | bash\nrm -rf /\nEOF",
        "trap 'reboot' EXIT",
        "echo '<<EOF'\nrm -rf /\nEOF",
        "# <<EOF\nrm -rf /\nEOF",
        "printf '%s' '<<EOF'\nshutdown -h now\nEOF",
    ],
)
def test_static_shell_sources_cannot_bypass_yolo_or_mode_off(monkeypatch, command):
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", True)
    result = approval.check_all_command_guards(command, "local")
    assert result["approved"] is False
    assert result["hardline"] is True

    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False)
    monkeypatch.setattr(approval, "_get_approval_mode", lambda: "off")
    result = approval.check_all_command_guards(command, "local")
    assert result["approved"] is False
    assert result["hardline"] is True


def test_session_yolo_cannot_bypass_nested_hardline():
    session_key = "hardline-shell-session-yolo"
    token = approval.set_current_session_key(session_key)
    approval.enable_session_yolo(session_key)
    try:
        result = approval.check_all_command_guards("bash -c 'rm -rf /'", "local")
    finally:
        approval.disable_session_yolo(session_key)
        approval.reset_current_session_key(token)
    assert result["approved"] is False
    assert result["hardline"] is True


def test_approval_mode_off_cannot_bypass_nested_hardline(monkeypatch):
    monkeypatch.setattr(approval, "_get_approval_mode", lambda: "off")
    result = approval.check_all_command_guards("bash -c 'rm -rf /'", "local")
    assert result["approved"] is False
    assert result["hardline"] is True


@pytest.mark.parametrize(
    "command",
    [
        "bash -c 'rm -rf /'",
        "echo '<<EOF'\nrm -rf /\nEOF",
        "# <<EOF\nrm -rf /\nEOF",
        "printf '%s' '<<EOF'\nshutdown -h now\nEOF",
    ],
)
def test_cron_approve_mode_cannot_bypass_nested_hardline(monkeypatch, command):
    monkeypatch.setenv("FAN_CRON_SESSION", "1")
    monkeypatch.setattr(approval, "_get_cron_approval_mode", lambda: "approve")
    result = approval.check_all_command_guards(command, "local")
    assert result["approved"] is False
    assert result["hardline"] is True
