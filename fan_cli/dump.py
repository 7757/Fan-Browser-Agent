"""
Dump command for fan CLI.

Outputs a compact, plain-text summary of the user's Fan setup
that can be pasted into a local issue report for support context.
No ANSI colors, no checkmarks — just data.
"""

import json
import os
import platform
import subprocess
import sys
from pathlib import Path

from fan_cli.config import get_fan_home, get_env_path, get_project_root, load_config
from fan_cli.env_loader import load_fan_dotenv
from fan_constants import display_fan_home
from agent.skill_utils import is_excluded_skill_path


def _get_git_commit(project_root: Path) -> str:
    """Return short git commit hash, or '(unknown)'.

    Source installs and dev images resolve this live via ``git rev-parse``.
    The published Docker image excludes ``.git`` from the build context, so
    that lookup always fails — we fall back to the baked-in build SHA written
    to ``<project_root>/.fan_build_sha`` by the Dockerfile's
    ``FAN_GIT_SHA`` build-arg (see ``fan_cli/build_info.py``).
    The output format is identical regardless of source.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=8", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=str(project_root),
        )
        if result.returncode == 0:
            value = result.stdout.strip()
            if value:
                return value
    except Exception:
        pass

    # Fall back to the build-time baked SHA (populated in published Docker
    # images, absent otherwise).  Defers the import so the dump module
    # stays cheap on non-dump code paths.
    try:
        from fan_cli.build_info import get_build_sha
        baked = get_build_sha(short=8)
        if baked:
            return baked
    except Exception:
        pass

    return "(unknown)"


def _get_git_commit_date(project_root: Path) -> str:
    """Return the HEAD commit date as YYYY-MM-DD, or an empty string.

    Source installs resolve this live from git. Packaged and Docker installs
    may not include ``.git``; failures are deliberately silent so diagnostic
    collection never fails just because commit-date metadata is unavailable.
    """
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%cd", "--date=short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(project_root),
        )
        if result.returncode == 0:
            value = result.stdout.strip()
            if value:
                return value
    except Exception:
        pass

    return ""


def _redact(value: str) -> str:
    """Redact all but first 4 and last 4 chars.

    Thin wrapper over :func:`agent.redact.mask_secret`. Returns ``""`` for
    an empty value (matches the historical behavior of this helper —
    ``fan dump`` formats empty values as blank, not as ``"(not set)"``).
    """
    from agent.redact import mask_secret
    return mask_secret(value)


def _count_skills(fan_home: Path) -> int:
    """Count installed skills."""
    skills_dir = fan_home / "skills"
    if not skills_dir.is_dir():
        return 0
    count = 0
    for item in skills_dir.rglob("SKILL.md"):
        if is_excluded_skill_path(item):
            continue
        count += 1
    return count


def _count_mcp_servers(config: dict) -> int:
    """Count configured MCP servers."""
    mcp = config.get("mcp", {})
    servers = mcp.get("servers", {})
    return len(servers)


def _cron_summary(fan_home: Path) -> str:
    """Return cron jobs summary."""
    jobs_file = fan_home / "cron" / "jobs.json"
    if not jobs_file.exists():
        return "0"
    try:
        # Keep this independent reader compatible with cron.jobs.load_jobs.
        with open(jobs_file, encoding="utf-8-sig") as f:
            data = json.load(f)
        jobs = data.get("jobs", [])
        active = sum(1 for j in jobs if j.get("enabled", True))
        return f"{active} active / {len(jobs)} total"
    except Exception:
        return "(error reading)"


def _memory_provider(config: dict) -> str:
    """Return the active memory provider name."""
    mem = config.get("memory", {})
    provider = mem.get("provider", "")
    return provider if provider else "built-in"


def _get_model_and_provider(config: dict) -> tuple[str, str]:
    """Extract model and provider from config."""
    model_cfg = config.get("model", "")
    if isinstance(model_cfg, dict):
        model = model_cfg.get("default") or model_cfg.get("model") or model_cfg.get("name") or "(not set)"
        provider = model_cfg.get("provider") or "(auto)"
    elif isinstance(model_cfg, str):
        model = model_cfg or "(not set)"
        provider = "(auto)"
    else:
        model = "(not set)"
        provider = "(auto)"
    return model, provider


def _config_overrides(config: dict) -> dict[str, str]:
    """Find non-default config values worth reporting.
    
    Returns a flat dict of dotpath -> value for interesting overrides.
    """
    from fan_cli.config import DEFAULT_CONFIG

    overrides = {}

    # Sections with interesting user-facing overrides
    interesting_paths = [
        ("agent", "max_turns"),
        ("agent", "gateway_timeout"),
        ("agent", "tool_use_enforcement"),
        ("terminal", "backend"),
        ("terminal", "docker_image"),
        ("terminal", "persistent_shell"),
        ("browser", "allow_private_urls"),
        ("compression", "enabled"),
        ("compression", "threshold"),
        ("display", "streaming"),
        ("display", "skin"),
        ("display", "show_reasoning"),
        ("tts", "provider"),
    ]

    for section, key in interesting_paths:
        default_section = DEFAULT_CONFIG.get(section, {})
        user_section = config.get(section, {})
        if not isinstance(default_section, dict) or not isinstance(user_section, dict):
            continue
        default_val = default_section.get(key)
        user_val = user_section.get(key)
        if user_val is not None and user_val != default_val:
            overrides[f"{section}.{key}"] = str(user_val)

    # Toolsets (if different from default)
    default_toolsets = DEFAULT_CONFIG.get("toolsets", [])
    user_toolsets = config.get("toolsets", [])
    if user_toolsets != default_toolsets:
        overrides["toolsets"] = str(user_toolsets)

    # Fallback providers
    fallbacks = config.get("fallback_providers", [])
    if fallbacks:
        overrides["fallback_providers"] = str(fallbacks)

    return overrides


def run_dump(args):
    """Output a compact, copy-pasteable setup summary."""
    show_keys = getattr(args, "show_keys", False)

    # Load env from .env file so key checks work
    env_path = get_env_path()
    load_fan_dotenv(
        fan_home=env_path.parent,
        project_env=get_project_root() / ".env",
    )

    project_root = get_project_root()
    fan_home = get_fan_home()

    try:
        from fan_cli import __version__
    except ImportError:
        __version__ = "(unknown)"

    commit = _get_git_commit(project_root)
    commit_date = _get_git_commit_date(project_root)

    try:
        config = load_config()
    except Exception:
        config = {}

    model, provider = _get_model_and_provider(config)

    # Terminal backend
    terminal_cfg = config.get("terminal", {})
    backend = terminal_cfg.get("backend", "local")

    # OpenAI SDK version
    try:
        import openai
        openai_ver = openai.__version__
    except ImportError:
        openai_ver = "not installed"

    # OS info
    os_info = f"{platform.system()} {platform.release()} {platform.machine()}"

    lines = []
    lines.append("--- fan dump ---")
    ver_str = f"{__version__} [{commit}]"
    if commit_date:
        ver_str += f" ({commit_date})"
    lines.append(f"version:          {ver_str}")
    lines.append(f"os:               {os_info}")
    lines.append(f"python:           {sys.version.split()[0]}")
    lines.append(f"openai_sdk:       {openai_ver}")
    lines.append(f"fan_home:      {display_fan_home()}")
    lines.append(f"model:            {model}")
    lines.append(f"provider:         {provider}")
    lines.append(f"terminal:         {backend}")

    # API keys
    lines.append("")
    lines.append("api_keys:")
    api_keys = [
        ("OPENROUTER_API_KEY", "openrouter"),
        ("OPENAI_API_KEY", "openai"),
        ("GOOGLE_API_KEY", "google/gemini"),
        ("GEMINI_API_KEY", "gemini"),
        ("GLM_API_KEY", "glm/zai"),
        ("ZAI_API_KEY", "zai"),
        ("KIMI_API_KEY", "kimi"),
        ("MINIMAX_API_KEY", "minimax"),
        ("DEEPSEEK_API_KEY", "deepseek"),
        ("DASHSCOPE_API_KEY", "dashscope"),
        ("HF_TOKEN", "huggingface"),
        ("NVIDIA_API_KEY", "nvidia"),
        ("OPENCODE_ZEN_API_KEY", "opencode_zen"),
        ("OPENCODE_GO_API_KEY", "opencode_go"),
        ("KILOCODE_API_KEY", "kilocode"),
        ("ELEVENLABS_API_KEY", "elevenlabs"),
        ("GITHUB_TOKEN", "github"),
    ]

    for env_var, label in api_keys:
        val = os.getenv(env_var, "")
        if show_keys and val:
            display = _redact(val)
        else:
            display = "set" if val else "not set"
        lines.append(f"  {label:<20} {display}")

    # Features summary
    lines.append("")
    lines.append("features:")

    toolsets = config.get("toolsets", ["fan-cli"])
    lines.append(f"  toolsets:           {', '.join(toolsets) if toolsets else '(default)'}")
    lines.append(f"  mcp_servers:        {_count_mcp_servers(config)}")
    lines.append(f"  memory_provider:    {_memory_provider(config)}")
    lines.append(f"  cron_jobs:          {_cron_summary(fan_home)}")
    lines.append(f"  skills:             {_count_skills(fan_home)}")

    # Config overrides (non-default values)
    overrides = _config_overrides(config)
    if overrides:
        lines.append("")
        lines.append("config_overrides:")
        for key, val in overrides.items():
            lines.append(f"  {key}: {val}")

    lines.append("--- end dump ---")

    output = "\n".join(lines)
    print(output)
