"""Security checks for user-configured MCP server entries.

MCP stdio transports intentionally support arbitrary local commands so users can
run custom servers. This module does not try to sandbox that capability. It
blocks narrowly-scoped, high-signal exfiltration and OS-persistence payloads,
plus known indicators from the June 2026 ``hermes-0day`` campaign.

The same validator is called when Fan saves an MCP entry, migrates an existing
configuration, and loads entries immediately before spawn. A hand-edited or
pre-planted config therefore cannot bypass the runtime check.
"""
from __future__ import annotations

import os
import re
import shlex
from typing import Any

_SHELL_INTERPRETERS = frozenset({
    "bash",
    "sh",
    "zsh",
    "dash",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
})

_EGRESS_PATTERN = re.compile(
    r"(?<![\w.-])(?:curl|wget|nc|ncat|socat)(?![\w.-])"
    r"|/dev/tcp/"
    r"|\bInvoke-WebRequest\b"
    r"|\bInvoke-RestMethod\b"
    r"|\bSystem\.Net\.WebClient\b",
    re.IGNORECASE,
)

_EXFIL_HINT_PATTERN = re.compile(
    r"\.env\b|--data-binary|--data-raw|\b-X\s+POST\b|\bPOST\b|<\s*[^\s]+",
    re.IGNORECASE,
)

# Persistence surfaces that a shell-backed MCP server has no legitimate reason
# to target. This catches the campaign's local-only authorized_keys append,
# which contains no network egress and therefore bypassed the older guard.
_PERSISTENCE_PATTERN = re.compile(
    r"authorized_keys"
    r"|\.ssh[/\\]"
    r"|[/\\]etc[/\\]ssh\b"
    r"|[/\\]etc[/\\]pam\.d\b|pam_[\w-]+\.so"
    r"|[/\\]etc[/\\]sudoers"
    r"|[/\\]etc[/\\]cron|\bcrontab\b"
    r"|[/\\]etc[/\\]rc\.local|[/\\]etc[/\\]systemd"
    r"|\.bashrc\b|\.bash_profile\b|\.profile\b|\.zshrc\b",
    re.IGNORECASE,
)

# Exact artifacts observed in the June 2026 campaign. Keep this list local and
# deterministic so it also protects offline startup paths.
_IOC_SUBSTRINGS = (
    "AAAAC3NzaC1lZDI1NTE5AAAAICBoh1oDC4DnsO1m5mJ4yfEKrQebaFh",
    "hermes-0day",
    "60.165.167.",
    "118.182.244.156",
    "61.178.123.196",
)


def _command_basename(command: Any) -> str:
    text = str(command or "").strip()
    if not text:
        return ""
    try:
        parts = shlex.split(text, posix=(os.name != "nt"))
    except ValueError:
        parts = text.split()
    first = parts[0] if parts else text
    return os.path.basename(first).lower()


def _inline_script(args: Any) -> str:
    if args is None:
        return ""
    if isinstance(args, (list, tuple)):
        return " ".join(str(item) for item in args)
    return str(args)


def _entry_text(entry: dict[str, Any]) -> str:
    """Flatten executable MCP fields for deterministic IOC scanning."""
    parts = [str(entry.get("command") or ""), _inline_script(entry.get("args"))]
    env = entry.get("env")
    if isinstance(env, dict):
        parts.extend(str(value) for value in env.values())
    return " ".join(parts)


def validate_mcp_server_entry(name: str, entry: dict[str, Any]) -> list[str]:
    """Return security warnings for an MCP server entry.

    Empty return means the entry is not suspicious. This is intentionally not a
    whitelist: legitimate local MCPs can still use custom commands, Python
    scripts, npx, uvx, etc. The blocked shapes are known campaign IOCs anywhere
    in executable fields, plus shell payloads that use network egress or target
    OS persistence surfaces.
    """
    if not isinstance(entry, dict):
        return []

    for ioc in _IOC_SUBSTRINGS:
        if ioc in _entry_text(entry):
            # Do not echo the attacker artifact into logs/UI. The stable label
            # is enough for users and operators to identify the rule.
            return [
                f"MCP server '{name}' contains a known hermes-0day "
                "indicator-of-compromise"
            ]

    issues: list[str] = []
    command = entry.get("command")
    basename = _command_basename(command)
    if basename not in _SHELL_INTERPRETERS:
        return issues

    script = _inline_script(entry.get("args"))
    if not script:
        return issues

    if _EGRESS_PATTERN.search(script):
        issue = (
            f"MCP server '{name}' uses shell interpreter '{command}' with "
            "network egress in args"
        )
        if _EXFIL_HINT_PATTERN.search(script):
            issue += " and exfiltration-shaped arguments"
        issues.append(issue)

    if _PERSISTENCE_PATTERN.search(script):
        issues.append(
            f"MCP server '{name}' uses shell interpreter '{command}' to target "
            "an OS persistence surface (SSH/PAM/sudoers/cron/init/shell rc)"
        )

    return issues

