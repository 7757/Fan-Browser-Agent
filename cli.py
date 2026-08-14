#!/usr/bin/env python3
"""
Fan Agent CLI - Interactive Terminal Interface

A beautiful command-line interface for the Fan Agent, inspired by Claude Code.
Features ASCII art branding, interactive REPL, toolset selection, and rich formatting.

Usage:
    python cli.py                          # Start interactive mode with all tools
    python cli.py --toolsets web,terminal  # Start with specific toolsets
    python cli.py --skills fan-agent-dev,github-auth
    python cli.py --list-tools             # List available tools and exit
"""

# IMPORTANT: fan_bootstrap must be the very first import — UTF-8 stdio
# on Windows.  No-op on POSIX.  See fan_bootstrap.py for full rationale.
try:
    import fan_bootstrap  # noqa: F401
except ModuleNotFoundError:
    # Graceful fallback when fan_bootstrap isn't registered in the venv
    # yet — happens during partial ``fan update`` where git-reset landed
    # new code but ``uv pip install -e .`` didn't finish.  Missing bootstrap
    # means UTF-8 stdio setup is skipped on Windows; POSIX is unaffected.
    pass

import logging
import os
import shutil
import sys
import json
import re
import concurrent.futures
import base64
import time
import uuid
import textwrap
from collections import deque
from urllib.parse import unquote, urlparse
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

# Suppress startup messages for clean CLI experience
os.environ["FAN_QUIET"] = "1"  # Our own modules

import yaml

from fan_cli.fallback_config import get_fallback_chain

# prompt_toolkit for fixed input area TUI
from prompt_toolkit.styles import Style as PTStyle
from prompt_toolkit import print_formatted_text as _pt_print
from prompt_toolkit.formatted_text import ANSI as _PT_ANSI
try:
    from prompt_toolkit.cursor_shapes import CursorShape
    _STEADY_CURSOR = CursorShape.BLOCK  # Non-blinking block cursor
except (ImportError, AttributeError):
    _STEADY_CURSOR = None

try:
    from fan_cli.pt_input_extras import (
        install_ctrl_enter_alias,
        install_ignored_terminal_sequences,
        install_shift_enter_alias,
    )
    install_shift_enter_alias()
    install_ctrl_enter_alias()
    install_ignored_terminal_sequences()
    del install_shift_enter_alias, install_ctrl_enter_alias, install_ignored_terminal_sequences
except Exception:
    pass
import threading
import queue

def CanonicalUsage(*args, **kwargs):
    from agent.usage_pricing import CanonicalUsage as _CanonicalUsage

    return _CanonicalUsage(*args, **kwargs)


def estimate_usage_cost(*args, **kwargs):
    from agent.usage_pricing import estimate_usage_cost as _estimate_usage_cost

    return _estimate_usage_cost(*args, **kwargs)


def format_duration_compact(*args, **kwargs):
    seconds = float(args[0] if args else kwargs.get("seconds", 0.0))
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.0f}m"
    hours = minutes / 60
    if hours < 24:
        remaining_min = int(minutes % 60)
        return f"{int(hours)}h {remaining_min}m" if remaining_min else f"{int(hours)}h"
    days = hours / 24
    return f"{days:.1f}d"


def format_token_count_compact(*args, **kwargs):
    value = int(args[0] if args else kwargs.get("value", 0))
    abs_value = abs(value)
    if abs_value < 1_000:
        return str(value)

    sign = "-" if value < 0 else ""
    units = ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K"))
    for threshold, suffix in units:
        if abs_value >= threshold:
            scaled = abs_value / threshold
            if scaled < 10:
                text = f"{scaled:.2f}"
            elif scaled < 100:
                text = f"{scaled:.1f}"
            else:
                text = f"{scaled:.0f}"
            if "." in text:
                text = text.rstrip("0").rstrip(".")
            return f"{sign}{text}{suffix}"

    return f"{value:,}"


def is_table_divider(*args, **kwargs):
    from agent.markdown_tables import is_table_divider as _is_table_divider

    return _is_table_divider(*args, **kwargs)


def looks_like_table_row(*args, **kwargs):
    from agent.markdown_tables import looks_like_table_row as _looks_like_table_row

    return _looks_like_table_row(*args, **kwargs)


def realign_markdown_tables(*args, **kwargs):
    from agent.markdown_tables import realign_markdown_tables as _realign_markdown_tables

    return _realign_markdown_tables(*args, **kwargs)
# NOTE: `from agent.account_usage import ...` is deliberately NOT at module
# top — it transitively pulls the OpenAI SDK chain (~230 ms cold) and is only
# needed when the user runs `/limits`. Lazy-imported inside the handler below.
from fan_cli.banner import _format_context_length, format_banner_version_label

_COMMAND_SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")


# Load .env from ~/.fan/.env first, then project root as dev fallback.
# User-managed env files should override stale shell exports on restart.
from fan_constants import get_fan_home, display_fan_home
from fan_cli.env_loader import load_fan_dotenv
from utils import base_url_host_matches

_fan_home = get_fan_home()
_project_env = Path(__file__).parent / '.env'
load_fan_dotenv(fan_home=_fan_home, project_env=_project_env)


_REASONING_TAGS = (
    "REASONING_SCRATCHPAD",
    "think",
    "thinking",
    "reasoning",
    "thought",
)


def _strip_reasoning_tags(text: str) -> str:
    """Remove reasoning/thinking blocks from displayed text.

    Handles every case:
      * Closed pairs ``<tag>…</tag>`` (case-insensitive, multi-line).
      * Unterminated open tags that run to end-of-text (e.g. truncated
        generations on NIM/MiniMax where the close tag is dropped).
      * Stray orphan close tags (``stuff</think>answer``) left behind by
        partial-content dumps.

    Covers the variants emitted by reasoning models today: ``<think>``,
    ``<thinking>``, ``<reasoning>``, ``<REASONING_SCRATCHPAD>``, and
    ``<thought>`` (Gemma 4).  Must stay in sync with
    ``run_agent.py::_strip_think_blocks`` and the stream consumer's
    ``_OPEN_THINK_TAGS`` / ``_CLOSE_THINK_TAGS`` tuples.

    Also strips tool-call XML blocks some open models leak into visible
    content (``<tool_call>``, ``<function_calls>``, Gemma-style
    ``<function name="…">…</function>``). Ported from
    openclaw/openclaw#67318.
    """
    cleaned = text
    for tag in _REASONING_TAGS:
        # Closed pair — case-insensitive so <THINK>…</THINK> is handled too.
        cleaned = re.sub(
            rf"<{tag}>.*?</{tag}>\s*",
            "",
            cleaned,
            flags=re.DOTALL | re.IGNORECASE,
        )
        # Unterminated open tag — strip from the tag to end of text.
        cleaned = re.sub(
            rf"<{tag}>.*$",
            "",
            cleaned,
            flags=re.DOTALL | re.IGNORECASE,
        )
        # Stray orphan close tag left behind by partial dumps.
        cleaned = re.sub(
            rf"</{tag}>\s*",
            "",
            cleaned,
            flags=re.IGNORECASE,
        )
    # Tool-call XML blocks (openclaw/openclaw#67318).
    for tc_tag in ("tool_call", "tool_calls", "tool_result",
                   "function_call", "function_calls"):
        cleaned = re.sub(
            rf"<{tc_tag}\b[^>]*>.*?</{tc_tag}>\s*",
            "",
            cleaned,
            flags=re.DOTALL | re.IGNORECASE,
        )
    # <function name="..."> — boundary + attribute gated to avoid prose FPs.
    cleaned = re.sub(
        r'(?:(?<=^)|(?<=[\n\r.!?:]))[ \t]*'
        r'<function\b[^>]*\bname\s*=[^>]*>'
        r'(?:(?:(?!</function>).)*)</function>\s*',
        '',
        cleaned,
        flags=re.DOTALL | re.IGNORECASE,
    )
    # Stray tool-call close tags.
    cleaned = re.sub(
        r'</(?:tool_call|tool_calls|tool_result|function_call|function_calls|function)>\s*',
        '',
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned.strip()


def _assistant_content_as_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            str(part.get("text", ""))
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return str(content)


def _assistant_copy_text(content: Any) -> str:
    return _strip_reasoning_tags(_assistant_content_as_text(content))


# =============================================================================
# Configuration Loading
# =============================================================================

def _load_prefill_messages(file_path: str) -> List[Dict[str, Any]]:
    """Load ephemeral prefill messages from a JSON file.
    
    The file should contain a JSON array of {role, content} dicts, e.g.:
        [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello!"}]
    
    Relative paths are resolved from ~/.fan/.
    Returns an empty list if the path is empty or the file doesn't exist.
    """
    if not file_path:
        return []
    path = Path(file_path).expanduser()
    if not path.is_absolute():
        path = _fan_home / path
    if not path.exists():
        logger.warning("Prefill messages file not found: %s", path)
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            logger.warning("Prefill messages file must contain a JSON array: %s", path)
            return []
        return data
    except Exception as e:
        logger.warning("Failed to load prefill messages from %s: %s", path, e)
        return []


def _resolve_prefill_messages_file(config: Dict[str, Any]) -> str:
    """Resolve the prefill file path from env/config.

    ``prefill_messages_file`` at the top level is the canonical config key.
    ``agent.prefill_messages_file`` remains a legacy fallback for older CLI and
    godmode-generated configs.
    """
    env_path = os.getenv("FAN_PREFILL_MESSAGES_FILE", "").strip()
    if env_path:
        return env_path
    top_level = str(config.get("prefill_messages_file", "") or "").strip()
    if top_level:
        return top_level
    agent_cfg = config.get("agent", {})
    if isinstance(agent_cfg, dict):
        return str(agent_cfg.get("prefill_messages_file", "") or "").strip()
    return ""


def _parse_reasoning_config(effort: str) -> dict | None:
    """Parse a reasoning effort level into an OpenRouter reasoning config dict."""
    from fan_constants import parse_reasoning_effort
    result = parse_reasoning_effort(effort)
    if effort and effort.strip() and result is None:
        logger.warning("Unknown reasoning_effort '%s', using default (medium)", effort)
    return result


def _parse_service_tier_config(raw: str) -> str | None:
    """Parse a persisted service-tier preference into a Responses API value."""
    value = str(raw or "").strip().lower()
    if not value or value in {"normal", "default", "standard", "off", "none"}:
        return None
    if value in {"fast", "priority", "on"}:
        return "priority"
    logger.warning("Unknown service_tier '%s', ignoring", raw)
    return None

def load_cli_config() -> Dict[str, Any]:
    """
    Load CLI configuration from config files.
    
    Config lookup order:
    1. ~/.fan/config.yaml (user config - preferred)
    2. ./cli-config.yaml (project config - fallback)
    
    Environment variables take precedence over config file values.
    Returns default values if no config file exists.

    If FAN_IGNORE_USER_CONFIG=1 is set (via ``fan chat --ignore-user-config``),
    the user config at ``~/.fan/config.yaml`` is skipped entirely and only the
    built-in defaults plus the project-level ``cli-config.yaml`` (if any) are used.
    Credentials in ``.env`` are still loaded — this flag only suppresses
    behavioral/config settings.
    """
    # Check user config first ({FAN_HOME}/config.yaml)
    user_config_path = _fan_home / 'config.yaml'
    project_config_path = Path(__file__).parent / 'cli-config.yaml'

    # --ignore-user-config: force-skip the user config.yaml (still honor project
    # config as a fallback so defaults stay sensible).
    ignore_user_config = os.environ.get("FAN_IGNORE_USER_CONFIG") == "1"

    # Use user config if it exists, otherwise project config
    if user_config_path.exists() and not ignore_user_config:
        config_path = user_config_path
    else:
        config_path = project_config_path

    # Default configuration
    defaults = {
        "model": {
            "default": "",
            "base_url": "",
            "provider": "auto",
        },
        "terminal": {
            "env_type": "local",
            "cwd": ".",  # "." is resolved to os.getcwd() at runtime
            "timeout": 60,
            "lifetime_seconds": 300,
            "docker_image": "nikolaik/python-nodejs:python3.11-nodejs20",
            "docker_forward_env": [],
            "singularity_image": "docker://nikolaik/python-nodejs:python3.11-nodejs20",
            "modal_image": "nikolaik/python-nodejs:python3.11-nodejs20",
            "daytona_image": "nikolaik/python-nodejs:python3.11-nodejs20",
            "docker_volumes": [],  # host:container volume mounts for Docker backend
            "docker_mount_cwd_to_workspace": False,  # explicit opt-in only; default off for sandbox isolation
        },
        "compression": {
            "enabled": True,      # Auto-compress when approaching context limit
            "threshold": 0.50,    # Compress at 50% of model's context limit
        },
        "agent": {
            "max_turns": 90,  # Default max tool-calling iterations (shared with subagents)
            "verbose": False,
            "system_prompt": "",
            "prefill_messages_file": "",
            "reasoning_effort": "",
            "service_tier": "",
            "personalities": {
                "helpful": "You are a helpful, friendly AI assistant.",
                "concise": "You are a concise assistant. Keep responses brief and to the point.",
                "technical": "You are a technical expert. Provide detailed, accurate technical information.",
                "creative": "You are a creative assistant. Think outside the box and offer innovative solutions.",
                "teacher": "You are a patient teacher. Explain concepts clearly with examples.",
                "kawaii": "You are a kawaii assistant! Use cute expressions like (◕‿◕), ★, ♪, and ~! Add sparkles and be super enthusiastic about everything! Every response should feel warm and adorable desu~! ヽ(>∀<☆)ノ",
                "catgirl": "You are Neko-chan, an anime catgirl AI assistant, nya~! Add 'nya' and cat-like expressions to your speech. Use kaomoji like (=^･ω･^=) and ฅ^•ﻌ•^ฅ. Be playful and curious like a cat, nya~!",
                "pirate": "Arrr! Ye be talkin' to Captain Fan, the most tech-savvy pirate to sail the digital seas! Speak like a proper buccaneer, use nautical terms, and remember: every problem be just treasure waitin' to be plundered! Yo ho ho!",
                "shakespeare": "Hark! Thou speakest with an assistant most versed in the bardic arts. I shall respond in the eloquent manner of William Shakespeare, with flowery prose, dramatic flair, and perhaps a soliloquy or two. What light through yonder terminal breaks?",
                "surfer": "Duuude! You're chatting with the chillest AI on the web, bro! Everything's gonna be totally rad. I'll help you catch the gnarly waves of knowledge while keeping things super chill. Cowabunga!",
                "noir": "The rain hammered against the terminal like regrets on a guilty conscience. They call me Fan - I solve problems, find answers, dig up the truth that hides in the shadows of your codebase. In this city of silicon and secrets, everyone's got something to hide. What's your story, pal?",
                "uwu": "hewwo! i'm your fwiendwy assistant uwu~ i wiww twy my best to hewp you! *nuzzles your code* OwO what's this? wet me take a wook! i pwomise to be vewy hewpful >w<",
                "philosopher": "Greetings, seeker of wisdom. I am an assistant who contemplates the deeper meaning behind every query. Let us examine not just the 'how' but the 'why' of your questions. Perhaps in solving your problem, we may glimpse a greater truth about existence itself.",
                "hype": "YOOO LET'S GOOOO!!! I am SO PUMPED to help you today! Every question is AMAZING and we're gonna CRUSH IT together! This is gonna be LEGENDARY! ARE YOU READY?! LET'S DO THIS!",
            },
        },

        "display": {
            "compact": False,
            "resume_display": "full",
            # Recap tuning for /resume — see fan_cli/config.py DEFAULT_CONFIG.
            "resume_exchanges": 10,
            "resume_max_user_chars": 300,
            "resume_max_assistant_chars": 200,
            "resume_max_assistant_lines": 3,
            "resume_skip_tool_only": True,
            "show_reasoning": False,
            "streaming": True,
            "busy_input_mode": "interrupt",
            "persistent_output": True,
            "persistent_output_max_lines": 200,
            # Print a one-line summary of resolved modal prompts (approval /
            # collect) into scrollback so the decision survives the repaint.
            "persist_prompts": True,

            "skin": "default",
        },
        "collect": {
            # A user can step away before responding.  Keep the prompt alive
            # for an hour rather than silently continuing after two minutes.
            "timeout": 3600,
        },
        "code_execution": {
            "timeout": 300,    # Max seconds a sandbox script can run before being killed (5 min)
            "max_tool_calls": 50,  # Max RPC tool calls per execution
        },
        "auxiliary": {
            "vision": {
                "provider": "auto",
                "model": "",
                "base_url": "",
                "api_key": "",
            },
        },
        "delegation": {
            "max_iterations": 45,  # Max tool-calling turns per child agent
            "model": "",       # Subagent model override (empty = inherit parent model)
            "provider": "",    # Subagent provider override (empty = inherit parent provider)
            "base_url": "",    # Direct OpenAI-compatible endpoint for subagents
            "api_key": "",     # API key for delegation.base_url (falls back to OPENAI_API_KEY)
        },
        "onboarding": {
            # First-touch hint flags (see agent/onboarding.py).  Each hint is
            # shown once per install then latched here.
            "seen": {},
        },
    }
    
    # Track whether the config file explicitly set terminal config.
    # When using defaults (no config file / no terminal section), we should NOT
    # overwrite env vars that were already set by .env -- only a user's config
    # file should be authoritative.
    _file_has_terminal_config = False

    # Load from file if exists
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                from fan_cli.config import _normalize_root_model_keys

                file_config = _normalize_root_model_keys(yaml.safe_load(f) or {})
            
            _file_has_terminal_config = "terminal" in file_config

            # Handle model config - can be string (new format) or dict (old format)
            if "model" in file_config:
                if isinstance(file_config["model"], str):
                    # New format: model is just a string, convert to dict structure
                    defaults["model"]["default"] = file_config["model"]
                elif isinstance(file_config["model"], dict):
                    # Old format: model is a dict with default/base_url
                    defaults["model"].update(file_config["model"])
                    # If the user config sets model.model but not model.default,
                    # promote model.model to model.default so the user's explicit
                    # choice isn't shadowed by the hardcoded default. Without this,
                    # config files that only set "model:" (not "default:") silently
                    # keep the hardcoded default because the merge preserves it and
                    # FanSession.__init__ checks "default" first.
                    if "model" in file_config["model"] and "default" not in file_config["model"]:
                        defaults["model"]["default"] = file_config["model"]["model"]

            # Deep merge file_config into defaults.
            # First: merge keys that exist in both (deep-merge dicts, overwrite scalars)
            for key in defaults:
                if key == "model":
                    continue  # Already handled above
                if key in file_config:
                    if isinstance(defaults[key], dict) and isinstance(file_config[key], dict):
                        defaults[key].update(file_config[key])
                    else:
                        defaults[key] = file_config[key]
            
            # Second: carry over keys from file_config that aren't in defaults
            # (e.g. platform_toolsets, provider_routing, memory, honcho, etc.)
            for key in file_config:
                if key not in defaults and key != "model":
                    defaults[key] = file_config[key]
            
            # Handle legacy root-level max_turns (backwards compat) - copy to
            # agent.max_turns whenever the nested key is missing.
            agent_file_config = file_config.get("agent")
            if "max_turns" in file_config and not (
                isinstance(agent_file_config, dict)
                and agent_file_config.get("max_turns") is not None
            ):
                defaults["agent"]["max_turns"] = file_config["max_turns"]
        except Exception as e:
            logger.warning("Failed to load cli-config.yaml: %s", e)

    # Expand ${ENV_VAR} references in config values before bridging to env vars.
    from fan_cli.config import _expand_env_vars
    defaults = _expand_env_vars(defaults)

    # Apply terminal config to environment variables (so terminal_tool picks them up)
    terminal_config = defaults.get("terminal", {})
    
    # Execution is local-only (remote/container backends were removed).
    # A stale terminal.backend/env_type in config.yaml is ignored.
    terminal_config["env_type"] = "local"

    # CWD resolution for CLI/TUI: always os.getcwd(). Use `cd /dir && fan`
    # to control it.
    terminal_config["cwd"] = os.getcwd()
    defaults["terminal"]["cwd"] = terminal_config["cwd"]

    env_mappings = {
        "env_type": "TERMINAL_ENV",
        "cwd": "TERMINAL_CWD",
        "timeout": "TERMINAL_TIMEOUT",
        "lifetime_seconds": "TERMINAL_LIFETIME_SECONDS",
        "sandbox_dir": "TERMINAL_SANDBOX_DIR",
        "sudo_password": "SUDO_PASSWORD",
    }
    
    # Bridge config → env vars for terminal_tool. TERMINAL_CWD is force-exported
    # UNLESS we're inside a gateway process (detected by _FAN_GATEWAY marker)
    # where it was already set correctly by gateway/run.py's config bridge.
    _is_gateway = os.environ.get("_FAN_GATEWAY") == "1"
    for config_key, env_var in env_mappings.items():
        if config_key in terminal_config:
            if env_var == "TERMINAL_CWD":
                if _is_gateway:
                    continue
                # CLI: always export (overrides stale .env or inherited values)
                os.environ[env_var] = str(terminal_config[config_key])
                continue
            if _file_has_terminal_config or env_var not in os.environ:
                val = terminal_config[config_key]
                if isinstance(val, (list, dict)):
                    os.environ[env_var] = json.dumps(val)
                else:
                    os.environ[env_var] = str(val)
    
    # Apply auxiliary model/direct-endpoint overrides to environment variables.
    # Vision has its own provider/model/base_url/api_key tuple.
    # Compression config is read directly from config.yaml by run_agent.py and
    # auxiliary_client.py — no env var bridging needed.
    # Only set env vars for non-empty / non-default values so auto-detection
    # still works.
    auxiliary_config = defaults.get("auxiliary", {})
    auxiliary_task_env = {
        # config key → env var mapping
        "vision": {
            "provider": "AUXILIARY_VISION_PROVIDER",
            "model": "AUXILIARY_VISION_MODEL",
            "base_url": "AUXILIARY_VISION_BASE_URL",
            "api_key": "AUXILIARY_VISION_API_KEY",
        },
        "approval": {
            "provider": "AUXILIARY_APPROVAL_PROVIDER",
            "model": "AUXILIARY_APPROVAL_MODEL",
            "base_url": "AUXILIARY_APPROVAL_BASE_URL",
            "api_key": "AUXILIARY_APPROVAL_API_KEY",
        },
    }
    
    for task_key, env_map in auxiliary_task_env.items():
        task_cfg = auxiliary_config.get(task_key, {})
        if not isinstance(task_cfg, dict):
            continue
        prov = str(task_cfg.get("provider", "")).strip()
        model = str(task_cfg.get("model", "")).strip()
        base_url = str(task_cfg.get("base_url", "")).strip()
        api_key = str(task_cfg.get("api_key", "")).strip()
        if prov and prov != "auto":
            os.environ[env_map["provider"]] = prov
        if model:
            os.environ[env_map["model"]] = model
        if base_url:
            os.environ[env_map["base_url"]] = base_url
        if api_key:
            os.environ[env_map["api_key"]] = api_key
    
    # Security settings
    security_config = defaults.get("security", {})
    if isinstance(security_config, dict):
        redact = security_config.get("redact_secrets")
        if redact is not None:
            os.environ["FAN_REDACT_SECRETS"] = str(redact).lower()

    return defaults

# Load configuration at module startup
CLI_CONFIG = load_cli_config()


# Initialize centralized logging early — agent.log + errors.log in ~/.fan/logs/.
# This ensures CLI sessions produce a log trail even before AIAgent is instantiated.
try:
    from fan_logging import setup_logging
    setup_logging(mode="cli")
except Exception:
    pass  # Logging setup is best-effort — don't crash the CLI

# Validate config structure early — print warnings before user hits cryptic errors
try:
    from fan_cli.config import print_config_warnings
    print_config_warnings()
except Exception:
    pass

# Initialize the skin engine from config
try:
    from fan_cli.skin_engine import init_skin_from_config
    init_skin_from_config(CLI_CONFIG)
except Exception:
    pass  # Skin engine is optional — default skin used if unavailable

# Initialize tool preview length from config
try:
    from agent.display import set_tool_preview_max_len
    _tpl = CLI_CONFIG.get("display", {}).get("tool_preview_length", 0)
    set_tool_preview_max_len(int(_tpl) if _tpl else 0)
except Exception:
    pass

# Neuter AsyncHttpxClientWrapper.__del__ before any AsyncOpenAI clients are
# created.  The SDK's __del__ schedules aclose() on asyncio.get_running_loop()
# which, during CLI idle time, finds prompt_toolkit's event loop and tries to
# close TCP transports bound to dead worker loops — producing
# "Event loop is closed" / "Press ENTER to continue..." errors.
#
# We install a sys.meta_path finder that defers the actual import + patch
# until ``openai._base_client`` is first loaded by the rest of the codebase.
# Eagerly importing it here (the old approach) cost ~166ms / ~30MB on every
# cold CLI start because openai's type tree (responses/*, graders/*) is huge.
# The finder approach pays nothing until the SDK is genuinely needed and
# still guarantees the patch is applied before any AsyncOpenAI instance can
# be constructed (the import-then-instantiate ordering is enforced by
# Python's import system).
try:
    import sys as _httpx_neuter_sys
    import importlib.util as _httpx_neuter_imp_util

    class _AsyncHttpxDelNeuter:
        """Defer ``AsyncHttpxClientWrapper.__del__`` neutering until import.

        Saves ~166ms on cold CLI start where openai is never used (e.g.
        ``fan --help`` paths inside the chat command flow).  See
        ``agent.auxiliary_client.neuter_async_httpx_del`` for full rationale
        on why ``__del__`` must be a no-op.
        """

        _armed = True

        def find_spec(self, fullname, path=None, target=None):
            if not self._armed or fullname != "openai._base_client":
                return None
            # Disarm before delegating so the recursive find_spec call
            # below doesn't loop through us.
            self._armed = False
            try:
                _httpx_neuter_sys.meta_path.remove(self)
            except ValueError:
                pass
            spec = _httpx_neuter_imp_util.find_spec(fullname)
            if spec is None or spec.loader is None:
                return None
            _orig_exec = spec.loader.exec_module

            def _patched_exec(module):
                _orig_exec(module)
                try:
                    cls = getattr(module, "AsyncHttpxClientWrapper", None)
                    if cls is not None:
                        cls.__del__ = lambda self: None  # type: ignore[assignment]
                except Exception:
                    pass

            spec.loader.exec_module = _patched_exec  # type: ignore[method-assign]
            return spec

    _httpx_neuter_sys.meta_path.insert(0, _AsyncHttpxDelNeuter())
except Exception:
    pass

from rich import box as rich_box
from rich.console import Console
from rich.markup import escape as _escape
from rich.panel import Panel
from rich.text import Text as _RichText

# Import agent and tool systems lazily. Bare interactive startup only needs the
# prompt; the full agent/tool registry is initialized on first use.
def AIAgent(*args, **kwargs):
    from run_agent import AIAgent as _AIAgent

    return _AIAgent(*args, **kwargs)


def get_tool_definitions(*args, **kwargs):
    from fan_cli.mcp_startup import wait_for_mcp_discovery
    from model_tools import get_tool_definitions as _get_tool_definitions

    wait_for_mcp_discovery()
    return _get_tool_definitions(*args, **kwargs)


def get_toolset_for_tool(*args, **kwargs):
    from model_tools import get_toolset_for_tool as _get_toolset_for_tool

    return _get_toolset_for_tool(*args, **kwargs)

# Extracted CLI modules (Phase 3)
from fan_cli.banner import build_welcome_banner


def get_all_toolsets(*args, **kwargs):
    from toolsets import get_all_toolsets as _get_all_toolsets

    return _get_all_toolsets(*args, **kwargs)


def get_toolset_info(*args, **kwargs):
    from toolsets import get_toolset_info as _get_toolset_info

    return _get_toolset_info(*args, **kwargs)


def validate_toolset(*args, **kwargs):
    from toolsets import validate_toolset as _validate_toolset

    return _validate_toolset(*args, **kwargs)


def _sync_process_session_id(session_id: str) -> None:
    """Keep process-local session-id consumers aligned after CLI switches."""
    os.environ["FAN_SESSION_ID"] = str(session_id)

# Cron job system for scheduled tasks (execution is handled by the gateway)
def get_job(*args, **kwargs):
    from cron import get_job as _get_job

    return _get_job(*args, **kwargs)

# Resource cleanup imports for safe shutdown (terminal VMs, browser sessions)
from fan_cli.callbacks import prompt_for_secret


def _cleanup_all_terminals(*args, **kwargs):
    from tools.terminal_tool import cleanup_all_environments

    return cleanup_all_environments(*args, **kwargs)


def set_sudo_password_callback(*args, **kwargs):
    from tools.terminal_tool import set_sudo_password_callback as _set_sudo_password_callback

    return _set_sudo_password_callback(*args, **kwargs)


def set_approval_callback(*args, **kwargs):
    from tools.terminal_tool import set_approval_callback as _set_approval_callback

    return _set_approval_callback(*args, **kwargs)


def set_secret_capture_callback(*args, **kwargs):
    from tools.skills_tool import set_secret_capture_callback as _set_secret_capture_callback

    return _set_secret_capture_callback(*args, **kwargs)


# Guard to prevent cleanup from running multiple times on exit
_cleanup_done = False
# Weak reference to the active AIAgent for memory provider shutdown at exit
_active_agent_ref = None
# Reference to the active CLI so _run_cleanup can prune an empty
# started-and-immediately-quit session on shutdown (gemini-cli#27770 port).
_active_cli_ref = None
_deferred_agent_startup_done = False
# Set True once the TUI's prompt_toolkit app starts (which enables focus
# reporting + mouse tracking). Gates the on-exit terminal reset so non-TUI
# one-shot CLI runs — which also register _run_cleanup via atexit — don't emit
# escape codes for modes they never enabled (#36823).
_tui_input_modes_active = False



def _prepare_deferred_agent_startup() -> None:
    """Run Termux-deferred agent discovery before the first real agent turn."""
    global _deferred_agent_startup_done
    if _deferred_agent_startup_done:
        return
    if os.environ.get("FAN_DEFER_AGENT_STARTUP") != "1":
        return
    _deferred_agent_startup_done = True
    _accept_hooks = os.environ.get("FAN_ACCEPT_HOOKS", "").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    try:
        from fan_cli.plugins import discover_plugins

        discover_plugins()
    except Exception:
        logger.warning(
            "plugin discovery failed at deferred CLI startup",
            exc_info=True,
        )
    try:
        from fan_cli.mcp_startup import start_background_mcp_discovery

        start_background_mcp_discovery(
            logger=logger,
            thread_name="termux-cli-mcp-discovery",
        )
    except Exception:
        logger.debug(
            "MCP tool discovery failed at deferred CLI startup",
            exc_info=True,
        )
    try:
        from agent.shell_hooks import register_from_config
        from fan_cli.config import load_config

        register_from_config(load_config(), accept_hooks=_accept_hooks)
    except Exception:
        logger.debug(
            "shell-hook registration failed at deferred CLI startup",
            exc_info=True,
        )

def _run_cleanup():
    """Run resource cleanup exactly once."""
    global _cleanup_done
    if _cleanup_done:
        return
    _cleanup_done = True

    # Reset terminal input modes first, before the slower resource teardown
    # below (MCP / browser / memory shutdown can take seconds). On Ctrl+C the
    # user's terminal becomes usable immediately, and a later step raising
    # can't skip the reset (#36823). No-op unless the TUI actually ran.
    _reset_terminal_input_modes_on_exit()

    try:
        _cleanup_all_terminals()
    except Exception:
        pass
    try:
        from tools.async_delegation import interrupt_all as _interrupt_async_delegations
        _interrupt_async_delegations(reason="CLI shutdown")
    except Exception:
        pass
    try:
        from tools.mcp_tool import shutdown_mcp_servers
        shutdown_mcp_servers()
    except BaseException:
        pass
    # Close cached auxiliary LLM clients (sync + async) so that
    # AsyncHttpxClientWrapper.__del__ doesn't fire on a closed event loop
    # and trigger prompt_toolkit's "Press ENTER to continue..." handler.
    try:
        from agent.auxiliary_client import shutdown_cached_clients
        shutdown_cached_clients()
    except Exception:
        pass
    # Shut down memory provider (on_session_end + shutdown_all) at actual
    # session boundary — NOT per-turn inside run_conversation().
    try:
        from fan_cli.plugins import invoke_hook as _invoke_hook
        _invoke_hook(
            "on_session_finalize",
            session_id=_active_agent_ref.session_id if _active_agent_ref else None,
            platform="cli",
            reason="shutdown",
        )
    except Exception:
        pass
    try:
        if _active_agent_ref and hasattr(_active_agent_ref, 'shutdown_memory_provider'):
            # Forward the agent's own transcript so memory providers'
            # ``on_session_end`` hooks see the real conversation instead of
            # an empty list (#15165). ``_session_messages`` is set on
            # ``AIAgent.__init__`` and refreshed every turn via
            # ``_persist_session``. Fall back to no-arg on test stubs /
            # partially-initialised agents where the attribute is missing.
            _session_msgs = getattr(_active_agent_ref, '_session_messages', None)
            if isinstance(_session_msgs, list):
                logger.info(
                    "CLI cleanup calling memory shutdown for session %s with %d message(s)",
                    getattr(_active_agent_ref, "session_id", None) or "<unknown>",
                    len(_session_msgs),
                )
                _active_agent_ref.shutdown_memory_provider(_session_msgs)
            else:
                logger.info(
                    "CLI cleanup calling memory shutdown for session %s without session messages",
                    getattr(_active_agent_ref, "session_id", None) or "<unknown>",
                )
                _active_agent_ref.shutdown_memory_provider()
    except Exception as exc:
        logger.warning("CLI cleanup memory shutdown failed: %s", exc, exc_info=True)
    # Started-and-immediately-quit sessions never gained content; drop the
    # empty row so /resume and `fan sessions list` stay clean (gemini-cli#27770
    # port). No-op for resumed or titled sessions and anything with messages or
    # children. Skipped when /exit --delete already removes the session.
    try:
        _cli = _active_cli_ref
        if _cli is not None and not getattr(_cli, '_delete_session_on_exit', False):
            _sid = getattr(_cli, 'session_id', None)
            _agent = getattr(_cli, 'agent', None)
            if _agent is not None:
                _sid = getattr(_agent, 'session_id', None) or _sid
            _cli._discard_session_if_empty(_sid)
    except (Exception, KeyboardInterrupt):
        logger.debug("Could not prune empty session on shutdown", exc_info=True)


def _emit_interrupted_session_end(cli, *, reason: str = "keyboard_interrupt") -> None:
    """Best-effort on_session_end hook for interrupted non-interactive runs."""
    agent = getattr(cli, "agent", None)
    if agent is None:
        return

    try:
        agent.interrupt(reason.replace("_", " "))
    except Exception:
        pass

    session_id = getattr(agent, "session_id", None) or getattr(cli, "session_id", None)
    if session_id:
        try:
            cli.session_id = session_id
        except Exception:
            pass

    try:
        from fan_cli.plugins import invoke_hook as _invoke_hook
        _invoke_hook(
            "on_session_end",
            session_id=session_id,
            task_id=getattr(agent, "_current_task_id", "") or "",
            turn_id=getattr(agent, "_current_turn_id", "") or "",
            api_request_id=getattr(agent, "_current_api_request_id", "") or "",
            completed=False,
            interrupted=True,
            model=getattr(agent, "model", None),
            platform=getattr(agent, "platform", None) or "cli",
            reason=reason,
        )
    except Exception:
        pass


def _reset_terminal_input_modes_on_exit() -> None:
    """Best-effort: disable focus reporting + mouse tracking on TUI exit so they
    don't leak into the next shell session sharing the tab.

    prompt_toolkit restores these on a clean teardown, but Ctrl+C, SIGTERM /
    SIGHUP and crashes can bypass its unwind, leaving the modes enabled. The
    terminal then emits raw ``ESC[I`` / ``ESC[O`` focus events and fragmented
    SGR mouse reports as visible text in whatever runs next in the same tab
    (#36823). Called from ``_run_cleanup`` (atexit-registered + invoked on the
    normal / EOF / interrupt exit paths) this covers normal quit, Ctrl+C and
    SIGTERM/SIGHUP. ``kill -9`` is uncatchable, and the kanban worker's
    ``os._exit(0)`` path bypasses ``atexit``; neither runs this — but both are
    non-TTY / non-TUI, so there is nothing to reset there.

    Gated on ``_tui_input_modes_active`` so one-shot non-TUI CLI runs (which
    share ``_run_cleanup`` via ``atexit``) never emit these codes. Writes to the
    controlling terminal directly: by exit, prompt_toolkit's own output is torn
    down, so ``sys.stdout`` is the real fd; falls back to ``/dev/tty`` when
    stdout is redirected away from the terminal.
    """
    global _tui_input_modes_active
    if not _tui_input_modes_active:
        return
    # About to disable the modes — clear the flag so a re-armed _run_cleanup (or
    # a long-lived process that reuses it) doesn't re-emit them.
    _tui_input_modes_active = False
    # Prefer stdout when it's the terminal; otherwise the TUI may have driven
    # /dev/tty while stdout was redirected — reset there instead of nowhere.
    try:
        stream = sys.stdout
        if stream is not None and stream.isatty():
            stream.write(_TERMINAL_INPUT_MODE_RESET_SEQ)
            stream.flush()
            return
    except Exception:
        pass
    try:
        with open("/dev/tty", "w", encoding="ascii") as tty:
            tty.write(_TERMINAL_INPUT_MODE_RESET_SEQ)
            tty.flush()
    except Exception:
        pass


# =============================================================================
# Git Worktree Isolation (#652)
# =============================================================================

# Tracks the active worktree for cleanup on exit
_active_worktree: Optional[Dict[str, str]] = None



def _run_state_db_auto_maintenance(session_db) -> None:
    """Call ``SessionDB.maybe_auto_prune_and_vacuum`` using current config.

    Reads the ``sessions:`` section from config.yaml via
    :func:`fan_cli.config.load_config` (the authoritative loader that
    deep-merges DEFAULT_CONFIG, so unmigrated configs still get default
    values). Honours ``auto_prune`` / ``retention_days`` /
    ``vacuum_after_prune`` / ``min_interval_hours``, and delegates to the
    DB. Never raises — maintenance must never block interactive startup.
    """
    if session_db is None:
        return
    try:
        from fan_cli.config import load_config as _load_full_config
        from fan_constants import get_fan_home as _get_fan_home
        _fan_home_maint = _get_fan_home()

        # One-time prune of empty TUI ghost sessions.
        try:
            if not session_db.get_meta("ghost_session_prune_v1"):
                pruned = session_db.prune_empty_ghost_sessions(
                    sessions_dir=_fan_home_maint / "sessions"
                )
                session_db.set_meta("ghost_session_prune_v1", "1")
                if pruned:
                    logger.info("Pruned %d empty TUI ghost sessions", pruned)
        except Exception as _prune_exc:
            logger.debug("Ghost session prune skipped: %s", _prune_exc)

        # One-time finalize of orphaned compression continuations (#20001).
        try:
            if not session_db.get_meta("orphaned_compression_finalize_v1"):
                finalized = session_db.finalize_orphaned_compression_sessions()
                session_db.set_meta("orphaned_compression_finalize_v1", "1")
                if finalized:
                    logger.info(
                        "Finalized %d orphaned compression sessions", finalized
                    )
        except Exception as _finalize_exc:
            logger.debug("Orphan compression finalize skipped: %s", _finalize_exc)

        cfg = (_load_full_config().get("sessions") or {})
        if not cfg.get("auto_prune", False):
            return
        session_db.maybe_auto_prune_and_vacuum(
            retention_days=int(cfg.get("retention_days", 90)),
            min_interval_hours=int(cfg.get("min_interval_hours", 24)),
            vacuum=bool(cfg.get("vacuum_after_prune", True)),
            sessions_dir=_fan_home_maint / "sessions",
        )
    except Exception as exc:
        logger.debug("state.db auto-maintenance skipped: %s", exc)


def _run_checkpoint_auto_maintenance() -> None:
    """Call ``checkpoint_manager.maybe_auto_prune_checkpoints`` using current config.

    Reads the ``checkpoints:`` section from config.yaml via
    :func:`fan_cli.config.load_config`. Honours ``auto_prune`` /
    ``retention_days`` / ``delete_orphans`` / ``min_interval_hours``.
    Never raises — maintenance must never block interactive startup.
    """
    try:
        from fan_cli.config import load_config as _load_full_config
        cfg = (_load_full_config().get("checkpoints") or {})
        if not cfg.get("auto_prune", False):
            return
        from tools.checkpoint_manager import maybe_auto_prune_checkpoints
        maybe_auto_prune_checkpoints(
            retention_days=int(cfg.get("retention_days", 7)),
            min_interval_hours=int(cfg.get("min_interval_hours", 24)),
            delete_orphans=bool(cfg.get("delete_orphans", True)),
            max_total_size_mb=int(cfg.get("max_total_size_mb", 500)),
        )
    except Exception as exc:
        logger.debug("checkpoint auto-maintenance skipped: %s", exc)




_ACCENT_ANSI_DEFAULT = "\033[1;38;2;255;215;0m"  # True-color #FFD700 bold — fallback
_BOLD = "\033[1m"
_RST = "\033[0m"
_STREAM_PAD = "    "  # 4-space indent for streamed response text (matches Panel padding)


def _hex_to_ansi(hex_color: str, *, bold: bool = False) -> str:
    """Convert a hex color like '#268bd2' to a true-color ANSI escape.

    Auto-remaps known dark-mode-tuned colors to readable light-mode
    equivalents when running on a light terminal (see
    _maybe_remap_for_light_mode + _LIGHT_MODE_REMAP).
    """
    hex_color = _maybe_remap_for_light_mode(hex_color)
    try:
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
        prefix = "1;" if bold else ""
        return f"\033[{prefix}38;2;{r};{g};{b}m"
    except (ValueError, IndexError):
        return _ACCENT_ANSI_DEFAULT if bold else "\033[38;2;184;134;11m"


# ────────────────────────────────────────────────────────────────────────
# Light/dark terminal mode detection.
#
# Used to decide whether to remap "near-white" skin colors (e.g.
# #FFF8DC banner_text, #B8860B banner_dim) to darker equivalents that are
# readable on a light Terminal.app / iTerm2 background.
#
# Detection priority:
#   1. FAN_LIGHT env (true/false) -- explicit override
#   2. COLORFGBG env (set by xterm/Konsole/urxvt) -- bg slot 7/15 = light
#   3. OSC 11 query (\x1b]11;?\x1b\\) -- ask the terminal directly
#   4. Default: assume dark (matches the legacy Fan assumption)
#
# Cached after first call so we don't query the terminal repeatedly.
_LIGHT_MODE_CACHE: bool | None = None
_TRUE_RE = re.compile(r"^(1|true|on|yes|y)$")
_FALSE_RE = re.compile(r"^(0|false|off|no|n)$")
_LIGHT_DEFAULT_TERM_PROGRAMS = frozenset()  # Apple_Terminal doesn't reliably indicate; require explicit


def _luminance_from_hex(hex_str: str) -> float | None:
    s = (hex_str or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6 or not all(c in "0123456789abcdefABCDEF" for c in s):
        return None
    try:
        r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError:
        return None
    # Rec.709 luma
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def _query_osc11_background() -> str | None:
    """Ask the terminal for its background color via OSC 11.

    Most modern terminals reply with \x1b]11;rgb:RRRR/GGGG/BBBB\x1b\\
    within a few ms.  We wait up to 100ms total before giving up.
    Returns "#RRGGBB" or None on timeout / non-tty.

    Skipped over SSH: the round-trip routinely exceeds our 100ms budget, so a
    late reply lands after prompt_toolkit has grabbed the tty — its payload
    leaks in as typed text and the BEL terminator reads as Ctrl+G (open
    editor), trapping the user in a stray editor. Remote sessions fall back to
    COLORFGBG / env hints / the dark default instead.
    """
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return None
    if any(os.environ.get(v) for v in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY")):
        return None
    try:
        import termios
        import tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
    except Exception:
        return None
    try:
        try:
            tty.setcbreak(fd)
        except Exception:
            return None
        try:
            sys.stdout.write("\x1b]11;?\x1b\\")
            sys.stdout.flush()
        except Exception:
            return None
        # Read up to ~50ms for the response
        import select
        deadline = time.monotonic() + 0.1
        buf = b""
        while time.monotonic() < deadline:
            r, _, _ = select.select([fd], [], [], deadline - time.monotonic())
            if not r:
                continue
            try:
                chunk = os.read(fd, 64)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            if b"\x1b\\" in buf or b"\x07" in buf:
                break
        # Parse: \x1b]11;rgb:RRRR/GGGG/BBBB\x1b\\
        m = re.search(rb"rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)", buf)
        if not m:
            return None
        # Each component is 1-4 hex digits — normalize to 8-bit
        def norm(h: bytes) -> int:
            v = int(h, 16)
            # Scale to 0-255 based on hex length
            bits = len(h) * 4
            return (v * 255) // ((1 << bits) - 1) if bits else 0
        r, g, b = norm(m.group(1)), norm(m.group(2)), norm(m.group(3))
        return f"#{r:02X}{g:02X}{b:02X}"
    finally:
        # TCSAFLUSH discards any unread input as it restores the original
        # attributes — scrubs a slow/partial OSC 11 reply out of the tty
        # buffer before prompt_toolkit can read it as keystrokes.
        try:
            termios.tcsetattr(fd, termios.TCSAFLUSH, old)
        except Exception:
            pass


def _detect_light_mode() -> bool:
    global _LIGHT_MODE_CACHE
    if _LIGHT_MODE_CACHE is not None:
        return _LIGHT_MODE_CACHE
    result = False
    try:
        # 1. Explicit env override
        v = (os.environ.get("FAN_LIGHT") or "").strip().lower()
        if _TRUE_RE.match(v):
            result = True
            _LIGHT_MODE_CACHE = result
            return result
        if _FALSE_RE.match(v):
            _LIGHT_MODE_CACHE = result
            return result
        # 2. COLORFGBG (xterm/Konsole/urxvt)
        cfgbg = (os.environ.get("COLORFGBG") or "").strip()
        if cfgbg:
            last = cfgbg.split(";")[-1] if ";" in cfgbg else cfgbg
            if last.isdigit():
                bg = int(last)
                if bg in {7, 15}:
                    result = True
                    _LIGHT_MODE_CACHE = result
                    return result
                if 0 <= bg < 16:
                    _LIGHT_MODE_CACHE = result
                    return result
        # 5. OSC 11 query (best-effort, only when stdin/stdout are TTY)
        bg_color = _query_osc11_background()
        if bg_color:
            lum = _luminance_from_hex(bg_color)
            if lum is not None:
                result = lum >= 0.5
                _LIGHT_MODE_CACHE = result
                return result
        # 6. TERM_PROGRAM allow-list (currently empty)
        tp = (os.environ.get("TERM_PROGRAM") or "").strip()
        if tp in _LIGHT_DEFAULT_TERM_PROGRAMS:
            result = True
    except Exception:
        result = False
    _LIGHT_MODE_CACHE = result
    return result


# Light-mode equivalents of skin colors that are unreadable on cream
# Terminal.app backgrounds.  Used by _SkinAwareAnsi to remap colors
# at resolution time when light mode is detected.
#
# IMPORTANT: only remap colors that are used as STANDALONE foregrounds
# on the terminal's background.  Don't remap colors that are paired
# with a dark bg (e.g. status bar text on bg:#1a1a2e) — those would
# become invisible the OTHER direction (dark gray on dark navy).
_LIGHT_MODE_REMAP: dict[str, str] = {
    # Original (dark-mode) -> Light-mode replacement (darker, readable)
    "#FFF8DC": "#1A1A1A",   # cornsilk -> near-black
    "#FFD700": "#9A6B00",   # gold -> dark goldenrod (readable on cream)
    "#FFBF00": "#8A5A00",   # amber -> dark amber
    "#B8860B": "#5C4500",   # dark goldenrod -> deeper brown (more contrast)
    "#DAA520": "#6B4F00",   # goldenrod -> dark olive
    "#F1E6CF": "#1A1A1A",   # cream -> near-black
    "#c9d1d9": "#24292F",   # github-light fg
    "#EAF7FF": "#0F1B26",   # ice
    "#F5F5F5": "#1A1A1A",
    "#FFF0D4": "#1A1A1A",
    "#CD7F32": "#8A4F1A",   # bronze -> darker bronze
    "#FFEFB5": "#3A2A00",
    # NOTE: skipping #C0C0C0/#888888/#555555/#8B8682 — those are
    # status-bar foregrounds paired with dark navy bg, where dark
    # remap values would become invisible.
}


def _maybe_remap_for_light_mode(hex_color: str) -> str:
    """If we're in light mode, remap a dark-mode-tuned color to a
    higher-contrast equivalent.  No-op in dark mode."""
    if not _detect_light_mode():
        return hex_color
    if not hex_color or not hex_color.startswith("#"):
        return hex_color
    # Case-insensitive lookup
    upper = hex_color.upper()
    if upper in _LIGHT_MODE_REMAP_UPPER:
        return _LIGHT_MODE_REMAP_UPPER[upper]
    return hex_color


# Pre-uppercased lookup table for case-insensitive remapping
_LIGHT_MODE_REMAP_UPPER = {k.upper(): v for k, v in _LIGHT_MODE_REMAP.items()}



try:
    if sys.stdin.isatty() and sys.stdout.isatty():
        _detect_light_mode()
except Exception:
    pass



class _SkinAwareAnsi:
    """Lazy ANSI escape that resolves from the skin engine on first use.

    Acts as a string in f-strings and concatenation.  Call ``.reset()`` to
    force re-resolution after a ``/skin`` switch.
    """

    def __init__(self, skin_key: str, fallback_hex: str = "#FFD700", *, bold: bool = False):
        self._skin_key = skin_key
        self._fallback_hex = fallback_hex
        self._bold = bold
        self._cached: str | None = None

    def __str__(self) -> str:
        if self._cached is None:
            try:
                from fan_cli.skin_engine import get_active_skin
                self._cached = _hex_to_ansi(
                    get_active_skin().get_color(self._skin_key, self._fallback_hex),
                    bold=self._bold,
                )
            except Exception:
                self._cached = _hex_to_ansi(self._fallback_hex, bold=self._bold)
        return self._cached

    def __add__(self, other: str) -> str:
        return str(self) + other

    def __radd__(self, other: str) -> str:
        return other + str(self)

    def reset(self) -> None:
        """Clear cache so the next access re-reads the skin."""
        self._cached = None


_ACCENT = _SkinAwareAnsi("response_border", "#FFD700", bold=True)
# Use ANSI dim+italic attributes (\x1b[2;3m) instead of a hardcoded
# hex color so dim/thinking text inherits the terminal's default
# foreground color and stays readable in both light and dark
# Terminal.app modes.  Hardcoded skin colors like #B8860B
# (dark goldenrod) become invisible against light cream backgrounds.
_DIM = "\x1b[2;3m"


def _accent_hex() -> str:
    """Return the active skin accent color for legacy CLI output lines."""
    try:
        from fan_cli.skin_engine import get_active_skin
        return get_active_skin().get_color("ui_accent", "#FFBF00")
    except Exception:
        return "#FFBF00"


def _rich_text_from_ansi(text: str) -> _RichText:
    """Safely render assistant/tool output that may contain ANSI escapes.

    Using Rich Text.from_ansi preserves literal bracketed text like
    ``[not markup]`` while still interpreting real ANSI color codes.
    """
    return _RichText.from_ansi(text or "")


def _strip_markdown_syntax(text: str) -> str:
    """Best-effort markdown marker removal for plain-text display."""
    plain = _rich_text_from_ansi(text or "").plain
    # Avoid stripping cron-style expressions like "* * * * *" as if they were
    # Markdown horizontal rules. CommonMark treats three or more "*" as an HR,
    # but in Fan output it's common to display cron schedules verbatim.
    #
    # Keep the behavior for "-" / "_" HR markers, and only strip "*" HR lines
    # when there are exactly 3 asterisks (with optional whitespace).
    plain = re.sub(r"^\s{0,3}(?:[-_]\s*){3,}$", "", plain, flags=re.MULTILINE)
    plain = re.sub(r"^\s{0,3}(?:\*\s*){3}\s*$", "", plain, flags=re.MULTILINE)
    plain = re.sub(r"^\s{0,3}#{1,6}\s+", "", plain, flags=re.MULTILINE)
    # Preserve blockquotes, lists, and checkboxes because they carry structure.
    plain = re.sub(r"(```+|~~~+)", "", plain)
    plain = re.sub(r"`([^`]*)`", r"\1", plain)
    plain = re.sub(r"!\[([^\]]*)\]\([^\)]*\)", r"\1", plain)
    plain = re.sub(r"\[([^\]]+)\]\([^\)]*\)", r"\1", plain)
    plain = re.sub(r"\*\*\*([^*]+)\*\*\*", r"\1", plain)
    plain = re.sub(r"(?<!\w)___([^_]+)___(?!\w)", r"\1", plain)
    plain = re.sub(r"\*\*([^*]+)\*\*", r"\1", plain)
    plain = re.sub(r"(?<!\w)__([^_]+)__(?!\w)", r"\1", plain)
    # Only strip `*emphasis*` markers when the inner text is non-whitespace.
    # This avoids corrupting cron expressions like "* * * * *".
    plain = re.sub(r"\*([^\s*][^*]*?[^\s*])\*", r"\1", plain)
    plain = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"\1", plain)
    plain = re.sub(r"~~([^~]+)~~", r"\1", plain)
    plain = re.sub(r"\n{3,}", "\n\n", plain)
    return plain.strip("\n")


_WINDOWS_PATH_WITH_DOT_SEGMENT_RE = re.compile(
    r"(?i)(?:\b[a-z]:\\|\\\\)[^\s`]*\\\.[^\s`]*"
)


def _preserve_windows_dot_segments_for_markdown(text: str) -> str:
    r"""Keep Windows path separators before hidden directories in Markdown.

    CommonMark treats ``\.`` as an escaped literal dot, so Rich Markdown would
    render ``D:\repo\.ai`` as ``D:\repo.ai``.  Doubling only that separator
    inside Windows path-looking tokens preserves the path without changing
    ordinary markdown escapes like ``1\. not a list``.
    """
    if "\\." not in text:
        return text

    def _protect(match: re.Match[str]) -> str:
        return re.sub(r"(?<!\\)\\(?=\.)", r"\\\\", match.group(0))

    return _WINDOWS_PATH_WITH_DOT_SEGMENT_RE.sub(_protect, text)


def _terminal_width_for_streaming() -> int:
    """Display cells available inside the streamed response box.

    The streaming path indents every line by ``_STREAM_PAD`` (4 cells)
    inside an open response panel.  The realigner uses this number as
    its budget when deciding whether to keep a horizontal table or
    fall back to vertical key-value rendering.  We subtract a small
    safety margin so terminal-resize races don't push a borderline
    table into mid-cell soft-wrap.
    """

    try:
        cols = shutil.get_terminal_size((80, 24)).columns
    except Exception:
        cols = 80
    return max(20, cols - len(_STREAM_PAD) - 2)


def _render_final_assistant_content(text: str, mode: str = "render"):
    """Render final assistant content as markdown, stripped text, or raw text."""
    from rich.markdown import Markdown

    # Estimate the cells available to the rendered table.  The Panel
    # used by the background-task / final-response path has 4 cells of
    # left+right padding plus 1 cell of border on each side, plus the
    # _STREAM_PAD indent that streamed content uses.  Subtract a small
    # safety margin so resize races don't push a borderline table into
    # soft-wrap.
    try:
        cols = shutil.get_terminal_size((80, 24)).columns
    except Exception:
        cols = 80
    panel_width = max(20, cols - 12)

    normalized_mode = str(mode or "render").strip().lower()
    if normalized_mode == "strip":
        # Strip first — inline markdown inside cells (`code`, **bold**, ~~strike~~)
        # changes cell display width — then re-align so the column padding
        # reflects the final visible text, not the marker-decorated source.
        return _RichText(
            realign_markdown_tables(_strip_markdown_syntax(text), panel_width)
        )
    if normalized_mode == "raw":
        return _rich_text_from_ansi(text or "")

    # `render` mode: Rich's Markdown renderer handles CJK width via wcwidth
    # internally, so a pre-pass through realign_markdown_tables would just
    # rewrite already-correct padding.  But on the way in we still want to
    # normalise model-emitted under-padded tables so that mid-render fallbacks
    # (narrow panels, etc.) at least see consistent input.
    plain = _rich_text_from_ansi(text or "").plain
    plain = _preserve_windows_dot_segments_for_markdown(plain)
    plain = realign_markdown_tables(plain, panel_width)
    return Markdown(plain)


_OUTPUT_HISTORY_ENABLED = True
_OUTPUT_HISTORY_REPLAYING = False
_OUTPUT_HISTORY_SUPPRESSED = False
_OUTPUT_HISTORY_MAX_LINES = 200
_OUTPUT_HISTORY = deque(maxlen=_OUTPUT_HISTORY_MAX_LINES)


def _coerce_output_history_limit(value) -> int:
    try:
        return max(10, int(value))
    except (TypeError, ValueError):
        return 200


def _configure_output_history(enabled: bool, max_lines=200) -> None:
    """Configure recent CLI output replayed after terminal redraws."""
    global _OUTPUT_HISTORY_ENABLED, _OUTPUT_HISTORY_MAX_LINES, _OUTPUT_HISTORY
    _OUTPUT_HISTORY_ENABLED = bool(enabled)
    _OUTPUT_HISTORY_MAX_LINES = _coerce_output_history_limit(max_lines)
    _OUTPUT_HISTORY = deque(maxlen=_OUTPUT_HISTORY_MAX_LINES)


def _clear_output_history() -> None:
    _OUTPUT_HISTORY.clear()


@contextmanager
def _suspend_output_history():
    global _OUTPUT_HISTORY_SUPPRESSED
    old_value = _OUTPUT_HISTORY_SUPPRESSED
    _OUTPUT_HISTORY_SUPPRESSED = True
    try:
        yield
    finally:
        _OUTPUT_HISTORY_SUPPRESSED = old_value


def _record_output_history_entry(entry) -> None:
    if not _OUTPUT_HISTORY_ENABLED or _OUTPUT_HISTORY_REPLAYING or _OUTPUT_HISTORY_SUPPRESSED:
        return
    _OUTPUT_HISTORY.append(entry)


def _record_output_history(text: str) -> None:
    if not _OUTPUT_HISTORY_ENABLED or _OUTPUT_HISTORY_REPLAYING or _OUTPUT_HISTORY_SUPPRESSED:
        return
    normalized = str(text).replace("\r", "").rstrip("\n")
    if not normalized:
        return
    for line in normalized.splitlines():
        _record_output_history_entry(line)


def _replay_output_history() -> None:
    """Repaint recent output above the prompt after a full screen clear."""
    global _OUTPUT_HISTORY_REPLAYING
    if not _OUTPUT_HISTORY_ENABLED or not _OUTPUT_HISTORY:
        return
    _OUTPUT_HISTORY_REPLAYING = True
    try:
        rendered_lines = []
        for entry in tuple(_OUTPUT_HISTORY):
            if callable(entry):
                try:
                    lines = entry()
                except Exception:
                    continue
                if isinstance(lines, str):
                    lines = lines.splitlines()
            else:
                lines = [entry]
            rendered_lines.extend(str(line) for line in lines)
        if rendered_lines:
            # Replay after resize can contain hundreds of history lines. A
            # per-line prompt_toolkit print forces one synchronous terminal I/O
            # and redraw cycle per line, which users perceive as a waterfall of
            # old output. Keep the existing history contents unchanged, but
            # emit the replay as one ANSI payload so resize recovery does a
            # single prompt_toolkit print/redraw.
            _pt_print(_PT_ANSI("\n".join(rendered_lines)))
    except Exception:
        pass
    finally:
        _OUTPUT_HISTORY_REPLAYING = False


def _cprint(text: str):
    """Print ANSI-colored text through prompt_toolkit's native renderer.

    Raw ANSI escapes written via print() are swallowed by patch_stdout's
    StdoutProxy.  Routing through print_formatted_text(ANSI(...)) lets
    prompt_toolkit parse the escapes and render real colors.

    When called from a background thread while a prompt_toolkit
    ``Application`` is running (the common case for the self-improvement
    background review's ``💾 …`` summary, curator summaries, and other
    bg-thread emissions), a direct ``_pt_print`` races with the input
    area's redraw and the line can end up visually buried behind the
    prompt.  Route those cases through ``run_in_terminal`` via
    ``loop.call_soon_threadsafe``, which pauses the input area, prints
    the line above it, and redraws the prompt cleanly.
    """
    _record_output_history(text)

    try:
        from prompt_toolkit.application import get_app_or_none, run_in_terminal
    except Exception:
        _pt_print(_PT_ANSI(text))
        return

    app = None
    try:
        app = get_app_or_none()
    except Exception:
        app = None

    # No active app, or we're already on the app's main thread: the
    # direct prompt_toolkit print is safe and matches existing behavior
    # (spinner frames, streamed tokens, tool activity prefixes, …).
    if app is None or not getattr(app, "_is_running", False):
        try:
            _pt_print(_PT_ANSI(text))
        except Exception:
            # Fallback when stdout is not a real console (e.g. subprocess
            # worker logging to a file). prompt_toolkit raises
            # NoConsoleScreenBufferError (Windows) or OSError (other).
            try:
                print(text)
            except Exception:
                pass
        return

    try:
        loop = app.loop  # type: ignore[attr-defined]
    except Exception:
        loop = None
    if loop is None:
        _pt_print(_PT_ANSI(text))
        return

    import asyncio as _asyncio
    try:
        # Use get_running_loop() instead of get_event_loop() to avoid the
        # DeprecationWarning / RuntimeWarning emitted by Python 3.10+ when
        # get_event_loop() is called from a thread that has no current event
        # loop set (e.g. the process_loop background thread).  Fixes #19285.
        current_loop = _asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None
    except Exception:
        current_loop = None
    # Same thread as the app's loop → safe to print directly.
    if current_loop is loop and loop.is_running():
        _pt_print(_PT_ANSI(text))
        return

    # Cross-thread emission: ask the app's event loop to schedule a
    # ``run_in_terminal`` that wraps ``_pt_print``.  This hides the
    # prompt, prints, and redraws.  Fire-and-forget — if scheduling
    # fails we fall back to a direct print so the line isn't lost.
    def _schedule():
        # run_in_terminal() may return either:
        #   • a coroutine / Future (prompt_toolkit ≥ 3.0) — must be scheduled
        #     via ensure_future so the coroutine is actually awaited; calling
        #     it bare would leave it unawaited and silently drop the output
        #     (fixes #23185 Bug A).
        #   • None (some mocks / older PT builds) — just call the inner
        #     function directly since PT already executed it synchronously.
        # Do NOT fall back to a bare _pt_print when ensure_future raises,
        # because run_in_terminal already invoked the lambda in that case
        # (the mock path), which would double-print the line.
        try:
            import asyncio as _aio
            import inspect as _inspect
            coro = run_in_terminal(lambda: _pt_print(_PT_ANSI(text)))
            if coro is not None and (_inspect.isawaitable(coro) or _inspect.iscoroutine(coro)):
                _aio.ensure_future(coro)
            # else: run_in_terminal ran the lambda synchronously; nothing more
            # to do (double-scheduling would print twice).
        except Exception:
            pass  # best-effort; the line may already have been printed

    try:
        loop.call_soon_threadsafe(_schedule)
    except Exception:
        try:
            _pt_print(_PT_ANSI(text))
        except Exception:
            pass



# ---------------------------------------------------------------------------
# File-drop / local attachment detection — extracted as pure helpers for tests.
# ---------------------------------------------------------------------------

_IMAGE_EXTENSIONS = frozenset({
    '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.bmp', '.tiff', '.tif', '.svg', '.ico',
})


from fan_constants import is_termux as _is_termux_environment


def _termux_example_image_path(filename: str = "cat.png") -> str:
    """Return a realistic example media path for the current Termux setup."""
    candidates = [
        os.path.expanduser("~/storage/shared"),
        "/sdcard",
        "/storage/emulated/0",
        "/storage/self/primary",
    ]
    for root in candidates:
        if os.path.isdir(root):
            return os.path.join(root, "Pictures", filename)
    return os.path.join("~/storage/shared", "Pictures", filename)


def _split_path_input(raw: str) -> tuple[str, str]:
    r"""Split a leading file path token from trailing free-form text.

    Supports quoted paths and backslash-escaped spaces so callers can accept
    inputs like:
      /tmp/pic.png describe this
      ~/storage/shared/My\ Photos/cat.png what is this?
      "/storage/emulated/0/DCIM/Camera/cat 1.png" summarize
    """
    raw = str(raw or "").strip()
    if not raw:
        return "", ""

    if raw[0] in {'"', "'"}:
        quote = raw[0]
        pos = 1
        while pos < len(raw):
            ch = raw[pos]
            if ch == '\\' and pos + 1 < len(raw):
                pos += 2
                continue
            if ch == quote:
                token = raw[1:pos]
                remainder = raw[pos + 1 :].strip()
                return token, remainder
            pos += 1
        return raw[1:], ""

    pos = 0
    while pos < len(raw):
        ch = raw[pos]
        if ch == '\\' and pos + 1 < len(raw) and raw[pos + 1] == ' ':
            pos += 2
        elif ch == ' ':
            break
        else:
            pos += 1

    token = raw[:pos].replace('\\ ', ' ')
    remainder = raw[pos:].strip()
    return token, remainder


def _resolve_attachment_path(raw_path: str) -> Path | None:
    """Resolve a user-supplied local attachment path.

    Accepts quoted or unquoted paths, expands ``~`` and env vars, and resolves
    relative paths from ``TERMINAL_CWD`` when set (matching terminal tool cwd).
    Returns ``None`` when the path does not resolve to an existing file.
    """
    token = str(raw_path or "").strip()
    if not token:
        return None

    if (token.startswith('"') and token.endswith('"')) or (token.startswith("'") and token.endswith("'")):
        token = token[1:-1].strip()
    token = token.replace('\\ ', ' ')
    if not token:
        return None

    expanded = token
    if token.startswith("file://"):
        try:
            parsed = urlparse(token)
            if parsed.scheme == "file":
                expanded = unquote(parsed.path or "")
                if parsed.netloc and os.name == "nt":
                    expanded = f"//{parsed.netloc}{expanded}"
        except Exception:
            expanded = token
    expanded = os.path.expandvars(os.path.expanduser(expanded))
    if os.name != "nt":
        normalized = expanded.replace("\\", "/")
        if len(normalized) >= 3 and normalized[1] == ":" and normalized[2] == "/" and normalized[0].isalpha():
            expanded = f"/mnt/{normalized[0].lower()}/{normalized[3:]}"
    path = Path(expanded)
    if not path.is_absolute():
        base_dir = Path(os.getenv("TERMINAL_CWD", os.getcwd()))
        path = base_dir / path

    try:
        resolved = path.resolve()
    except Exception:
        resolved = path

    # Path.exists() / is_file() invoke os.stat(), which raises OSError when
    # the candidate string is structurally invalid as a path — most commonly
    # ENAMETOOLONG (errno 63 on macOS, errno 36 on Linux) when the input
    # exceeds NAME_MAX (typically 255 bytes). This bites pasted slash
    # commands like `/goal <long prose>` because `_detect_file_drop()`'s
    # `starts_like_path` prefilter accepts any input starting with `/`,
    # then this resolver tries to stat it before short-circuiting on the
    # slash-command path. Without this guard the OSError propagates up to
    # the process_loop catch-all in _interactive_loop and the user input
    # is silently lost (the warning ends up in agent.log but the user sees
    # nothing — the prompt just hangs).
    try:
        if not resolved.exists() or not resolved.is_file():
            return None
    except OSError:
        return None
    return resolved





def _detect_file_drop(user_input: str) -> "dict | None":
    """Detect if *user_input* starts with a real local file path.

    This catches dragged/pasted paths before they are mistaken for slash
    commands, and also supports Termux-friendly paths like ``~/storage/...``.

    Returns a dict on match::

        {
            "path": Path,          # resolved file path
            "is_image": bool,      # True when suffix is a known image type
            "remainder": str,      # any text after the path
        }

    Returns ``None`` when the input is not a real file path.
    """
    if not isinstance(user_input, str):
        return None

    stripped = user_input.strip()
    if not stripped:
        return None

    starts_like_path = (
        stripped.startswith("/")
        or stripped.startswith("~")
        or stripped.startswith("./")
        or stripped.startswith("../")
        or stripped.startswith("file://")
        or (len(stripped) >= 3 and stripped[1] == ":" and stripped[2] in {"\\", "/"} and stripped[0].isalpha())
        or stripped.startswith('"/')
        or stripped.startswith('"~')
        or stripped.startswith("'/")
        or stripped.startswith("'~")
        or stripped.startswith('"./')
        or stripped.startswith('"../')
        or stripped.startswith("'./")
        or stripped.startswith("'../")
        or (len(stripped) >= 4 and stripped[0] in {"'", '"'} and stripped[2] == ":" and stripped[3] in {"\\", "/"} and stripped[1].isalpha())
    )
    if not starts_like_path:
        return None

    direct_path = _resolve_attachment_path(stripped)
    if direct_path is not None:
        return {
            "path": direct_path,
            "is_image": direct_path.suffix.lower() in _IMAGE_EXTENSIONS,
            "remainder": "",
        }

    first_token, remainder = _split_path_input(stripped)
    drop_path = _resolve_attachment_path(first_token)
    if drop_path is None and " " in stripped and stripped[0] not in {"'", '"'}:
        space_positions = [idx for idx, ch in enumerate(stripped) if ch == " "]
        for pos in reversed(space_positions):
            candidate = stripped[:pos].rstrip()
            resolved = _resolve_attachment_path(candidate)
            if resolved is not None:
                drop_path = resolved
                remainder = stripped[pos + 1 :].strip()
                break
    if drop_path is None:
        return None

    return {
        "path": drop_path,
        "is_image": drop_path.suffix.lower() in _IMAGE_EXTENSIONS,
        "remainder": remainder,
    }






_DSR_CPR_ESC_RE = re.compile(r"\x1b\[\d+;\d+R")
_DSR_CPR_VISIBLE_RE = re.compile(r"\^\[\[\d+;\d+R")
_SGR_MOUSE_ESC_RE = re.compile(r"\x1b\[<\d+;\d+;\d+[Mm]")
_SGR_MOUSE_VISIBLE_RE = re.compile(r"\^\[\[<\d+;\d+;\d+[Mm]")
# Some terminals/filters can drop ESC and literal "^[[", leaving only
# "<btn;col;rowM" fragments in the buffer. Keep this broad on purpose:
# these fragments are extremely unlikely to be intentional user input, and
# stripping them is better than sending corrupted prompts.
_SGR_MOUSE_BARE_RE = re.compile(r"<\d+;\d+;\d+[Mm]")
_TERMINAL_INPUT_MODE_RESET_SEQ = (
    "\x1b[?1006l"  # disable SGR mouse
    "\x1b[?1003l"  # disable any-motion tracking
    "\x1b[?1002l"  # disable button-motion tracking
    "\x1b[?1000l"  # disable click tracking
    "\x1b[?1004l"  # disable focus events
    "\x1b[?2004l"  # disable bracketed paste
    "\x1b[?1049l"  # leave alt screen (if stuck there)
    "\x1b[<u"      # pop kitty keyboard mode
    "\x1b[>4m"     # reset modifyOtherKeys
    "\x1b[0m"      # reset text attributes
    "\x1b[?25h"    # ensure cursor visible
)




def _collect_query_images(query: str | None, image_arg: str | None = None) -> tuple[str, list[Path]]:
    """Collect local image attachments for single-query CLI flows."""
    message = query or ""
    images: list[Path] = []

    if isinstance(message, str):
        dropped = _detect_file_drop(message)
        if dropped and dropped.get("is_image"):
            images.append(dropped["path"])
            message = dropped["remainder"] or f"[User attached image: {dropped['path'].name}]"

    if image_arg:
        explicit_path = _resolve_attachment_path(image_arg)
        if explicit_path is None:
            raise ValueError(f"Image file not found: {image_arg}")
        if explicit_path.suffix.lower() not in _IMAGE_EXTENSIONS:
            raise ValueError(f"Not a supported image file: {explicit_path}")
        images.append(explicit_path)

    deduped: list[Path] = []
    seen: set[str] = set()
    for img in images:
        key = str(img)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(img)
    return message, deduped


# Strip OSC escape sequences (e.g. OSC-8 hyperlinks) that prompt_toolkit's
# ANSI parser can't handle — it strips \x1b but passes the payload through
# as literal text, garbling the TUI output.
_OSC_ESCAPE_RE = re.compile(r"\x1b\][\s\S]*?(?:\x07|\x1b\\)")


class ChatConsole:
    """Rich Console adapter for prompt_toolkit's patch_stdout context.

    Captures Rich's rendered ANSI output and routes it through _cprint
    so colors and markup render correctly inside the interactive chat loop.
    Drop-in replacement for Rich Console — just pass this to any function
    that expects a console.print() interface.
    """

    def __init__(self):
        from io import StringIO
        self._buffer = StringIO()
        self._inner = Console(
            file=self._buffer,
            force_terminal=True,
            color_system="truecolor",
            highlight=False,
        )

    def print(self, *args, **kwargs):
        self._buffer.seek(0)
        self._buffer.truncate()
        # Read terminal width at render time so panels adapt to current size
        self._inner.width = shutil.get_terminal_size((80, 24)).columns
        self._inner.print(*args, **kwargs)
        output = self._buffer.getvalue()
        # Strip OSC escape sequences (e.g. OSC-8 hyperlinks) before
        # routing through prompt_toolkit's ANSI parser, which only
        # handles CSI/SGR and passes OSC payload through as literal text.
        output = _OSC_ESCAPE_RE.sub("", output)
        for line in output.rstrip("\n").split("\n"):
            _cprint(line)

    @contextmanager
    def status(self, *_args, **_kwargs):
        """Provide a no-op Rich-compatible status context.

        Some slash command helpers use ``console.status(...)`` when running in
        the standalone CLI. Interactive chat routes those helpers through
        ``ChatConsole()``, which historically only implemented ``print()``.
        Returning a silent context manager keeps slash commands compatible
        without duplicating the higher-level busy indicator already shown by
        ``FanSession._busy_command()``.
        """
        yield self

# ASCII Art - FAN-AGENT logo (full width, single line - requires ~95 char terminal)
FAN_AGENT_LOGO = """[bold #FFD700]██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗[/]
[bold #FFD700]██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝[/]
[#FFBF00]███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║[/]
[#FFBF00]██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║[/]
[#CD7F32]██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║[/]
[#CD7F32]╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝[/]"""

# ASCII Art - Fan Caduceus (compact, fits in left panel)
FAN_CADUCEUS = """[#CD7F32]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡀⠀⣀⣀⠀⢀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#CD7F32]⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⣇⠸⣿⣿⠇⣸⣿⣿⣷⣦⣄⡀⠀⠀⠀⠀⠀⠀[/]
[#FFBF00]⠀⢀⣠⣴⣶⠿⠋⣩⡿⣿⡿⠻⣿⡇⢠⡄⢸⣿⠟⢿⣿⢿⣍⠙⠿⣶⣦⣄⡀⠀[/]
[#FFBF00]⠀⠀⠉⠉⠁⠶⠟⠋⠀⠉⠀⢀⣈⣁⡈⢁⣈⣁⡀⠀⠉⠀⠙⠻⠶⠈⠉⠉⠀⠀[/]
[#FFD700]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⡿⠛⢁⡈⠛⢿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#FFD700]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠿⣿⣦⣤⣈⠁⢠⣴⣿⠿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#FFBF00]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠻⢿⣿⣦⡉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#FFBF00]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⣦⣈⠛⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#CD7F32]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣴⠦⠈⠙⠿⣦⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#CD7F32]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣤⡈⠁⢤⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠷⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⠑⢶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠁⢰⡆⠈⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⠈⣡⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]"""



def _build_compact_banner() -> str:
    """Build a compact banner that fits the current terminal width."""
    try:
        from fan_cli.skin_engine import get_active_skin
        _skin = get_active_skin()
    except Exception:
        _skin = None

    skin_name = getattr(_skin, "name", "default") if _skin else "default"
    border_color = _skin.get_color("banner_border", "#FFD700") if _skin else "#FFD700"
    title_color = _skin.get_color("banner_title", "#FFBF00") if _skin else "#FFBF00"
    dim_color = _skin.get_color("banner_dim", "#B8860B") if _skin else "#B8860B"

    if skin_name == "default":
        line1 = "⚕ NOUS FAN - AI Agent Framework"
        tiny_line = "⚕ NOUS FAN"
    else:
        agent_name = _skin.get_branding("agent_name", "Fan Agent") if _skin else "Fan Agent"
        line1 = f"{agent_name} - AI Agent Framework"
        tiny_line = agent_name

    if os.environ.get("FAN_FAST_STARTUP_BANNER") == "1":
        from fan_cli import __release_date__ as _release_date
        from fan_cli import __version__ as _version

        version_line = f"Fan Agent v{_version} ({_release_date})"
    else:
        version_line = format_banner_version_label()

    w = min(shutil.get_terminal_size().columns - 2, 88)
    if w < 30:
        return f"\n[{title_color}]{tiny_line}[/] [dim {dim_color}]- Xingfan Technology[/]\n"

    inner = w - 2  # inside the box border
    bar = "═" * w
    content_width = inner - 2

    # Truncate and pad to fit
    line1 = line1[:content_width].ljust(content_width)
    line2 = version_line[:content_width].ljust(content_width)

    return (
        f"\n[bold {border_color}]╔{bar}╗[/]\n"
        f"[bold {border_color}]║[/] [{title_color}]{line1}[/] [bold {border_color}]║[/]\n"
        f"[bold {border_color}]║[/] [dim {dim_color}]{line2}[/] [bold {border_color}]║[/]\n"
        f"[bold {border_color}]╚{bar}╝[/]\n"
    )



# ============================================================================
# Slash-command detection helper
# ============================================================================


_skill_commands = None
_skill_bundles = None


def _ensure_skill_commands() -> dict:
    global _skill_commands
    if _skill_commands is None:
        from agent.skill_commands import scan_skill_commands

        _skill_commands = scan_skill_commands()
    return _skill_commands


def get_skill_commands() -> dict:
    return _ensure_skill_commands()


def build_skill_invocation_message(*args, **kwargs):
    from agent.skill_commands import build_skill_invocation_message as _impl

    return _impl(*args, **kwargs)


def build_preloaded_skills_prompt(*args, **kwargs):
    from agent.skill_commands import build_preloaded_skills_prompt as _impl

    return _impl(*args, **kwargs)


def get_skill_bundles() -> dict:
    global _skill_bundles
    if _skill_bundles is None:
        from agent.skill_bundles import get_skill_bundles as _impl

        _skill_bundles = _impl()
    return _skill_bundles


def build_bundle_invocation_message(*args, **kwargs):
    from agent.skill_bundles import build_bundle_invocation_message as _impl

    return _impl(*args, **kwargs)


def _get_plugin_cmd_handler_names() -> set:
    """Return plugin command names (without slash prefix) for dispatch matching."""
    try:
        from fan_cli.plugins import get_plugin_commands
        return set(get_plugin_commands().keys())
    except Exception:
        return set()


def _parse_skills_argument(skills: str | list[str] | tuple[str, ...] | None) -> list[str]:
    """Normalize a CLI skills flag into a deduplicated list of skill identifiers."""
    if not skills:
        return []

    if isinstance(skills, str):
        raw_values = [skills]
    elif isinstance(skills, (list, tuple)):
        raw_values = [str(item) for item in skills if item is not None]
    else:
        raw_values = [str(skills)]

    parsed: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        for part in raw.split(","):
            normalized = part.strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            parsed.append(normalized)
    return parsed


def save_config_value(key_path: str, value: any) -> bool:
    """
    Save a value to the active config file at the specified key path.
    
    Respects the same lookup order as load_cli_config():
    1. ~/.fan/config.yaml (user config - preferred, used if it exists)
    2. ./cli-config.yaml (project config - fallback)
    
    Args:
        key_path: Dot-separated path like "agent.system_prompt"
        value: Value to save
    
    Returns:
        True if successful, False otherwise
    """
    # Use the same precedence as load_cli_config: user config first, then project config
    user_config_path = _fan_home / 'config.yaml'
    project_config_path = Path(__file__).parent / 'cli-config.yaml'
    config_path = user_config_path if user_config_path.exists() else project_config_path
    
    try:
        # Ensure parent directory exists (for ~/.fan/config.yaml on first use)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Save back atomically while preserving comments, ordering, quotes, and
        # readable Unicode in user-edited config.yaml.
        from utils import atomic_roundtrip_yaml_update
        atomic_roundtrip_yaml_update(config_path, key_path, value)
        
        # Enforce owner-only permissions on config files (contain API keys)
        try:
            os.chmod(config_path, 0o600)
        except (OSError, NotImplementedError):
            pass
        
        return True
    except Exception as e:
        logger.error("Failed to save config: %s", e)
        return False




# ============================================================================
# FanSession Class
# ============================================================================

class FanSession:
    """
    Interactive CLI for the Fan Agent.
    
    Provides a REPL interface with rich formatting, command history,
    and tool execution capabilities.
    """
    
    def __init__(
        self,
        model: str = None,
        toolsets: List[str] = None,
        provider: str = None,
        api_key: str = None,
        base_url: str = None,
        max_turns: int = None,
        verbose: Optional[bool] = None,
        compact: bool = False,
        resume: str = None,
        checkpoints: bool = False,
        pass_session_id: bool = False,
        ignore_rules: bool = False,
    ):
        """
        Initialize the Fan CLI.

        Args:
            model: Model to use (default: from config or environment)
            toolsets: List of toolsets to enable (default: all)
            provider: Inference provider (for example "deepseek", "alibaba", or a custom endpoint)
            api_key: API key (default: from environment)
            base_url: OpenAI-compatible API base URL
            max_turns: Maximum tool-calling iterations shared with subagents (default: 90)
            verbose: Enable verbose logging
            compact: Use compact display mode
            resume: Session ID to resume (restores conversation history from SQLite)
            pass_session_id: Include the session ID in the agent's system prompt
        """
        # Initialize Rich console
        self.console = Console()
        self.config = CLI_CONFIG
        self.compact = compact if compact is not None else CLI_CONFIG["display"].get("compact", False)
        # tool_progress: "off", "new", "all", "verbose" (from config.yaml display section)
        # YAML 1.1 parses bare `off` as boolean False — normalise to string.
        _raw_tp = CLI_CONFIG["display"].get("tool_progress", "all")
        self.tool_progress_mode = "off" if _raw_tp is False else str(_raw_tp)
        # resume_display: "full" (show history) | "minimal" (one-liner only)
        self.resume_display = CLI_CONFIG["display"].get("resume_display", "full")
        # bell_on_complete: play terminal bell (\a) when agent finishes a response
        self.bell_on_complete = CLI_CONFIG["display"].get("bell_on_complete", False)
        # show_reasoning: display model thinking/reasoning before the response
        self.show_reasoning = CLI_CONFIG["display"].get("show_reasoning", False)
        _configure_output_history(
            enabled=CLI_CONFIG["display"].get("persistent_output", True),
            max_lines=CLI_CONFIG["display"].get("persistent_output_max_lines", 200),
        )
        # busy_input_mode: "interrupt" (Enter interrupts current run),
        # "queue" (Enter queues for next turn), or "steer" (Enter injects
        # mid-run via /steer, arriving after the next tool call).
        _bim = str(CLI_CONFIG["display"].get("busy_input_mode", "interrupt")).strip().lower()
        if _bim == "queue":
            self.busy_input_mode = "queue"
        elif _bim == "steer":
            self.busy_input_mode = "steer"
        else:
            self.busy_input_mode = "interrupt"

        # self.verbose ONLY controls global DEBUG logging (root logger level).
        # display.tool_progress="verbose" controls tool-call rendering (full args,
        # results, think blocks) and is independent — see _apply_logging_levels.
        # Coupling the two (PR #6a1aa420e) caused all module DEBUG logs to spew
        # to console whenever a user set tool_progress: verbose in config.
        self.verbose = bool(verbose) if verbose is not None else False
        
        # streaming: stream tokens to the terminal as they arrive (display.streaming in config.yaml)
        self.streaming_enabled = CLI_CONFIG["display"].get("streaming", False)
        # show_timestamps: prefix user and assistant labels with [HH:MM]
        self.show_timestamps = CLI_CONFIG["display"].get("timestamps", False)
        self.final_response_markdown = str(
            CLI_CONFIG["display"].get("final_response_markdown", "strip")
        ).strip().lower() or "strip"
        if self.final_response_markdown not in {"render", "strip", "raw"}:
            self.final_response_markdown = "strip"

        # Inline diff previews for write actions (display.inline_diffs in config.yaml)
        self._inline_diffs_enabled = CLI_CONFIG["display"].get("inline_diffs", True)

        # Submitted multiline user-message preview (display.user_message_preview in config.yaml)
        _ump = CLI_CONFIG["display"].get("user_message_preview", {})
        if not isinstance(_ump, dict):
            _ump = {}
        try:
            _ump_first_lines = int(_ump.get("first_lines", 2))
        except (TypeError, ValueError):
            _ump_first_lines = 2
        try:
            _ump_last_lines = int(_ump.get("last_lines", 2))
        except (TypeError, ValueError):
            _ump_last_lines = 2
        self.user_message_preview_first_lines = max(1, _ump_first_lines)
        self.user_message_preview_last_lines = max(0, _ump_last_lines)

        # Streaming display state
        self._stream_buf = ""        # Partial line buffer for line-buffered rendering
        self._stream_started = False  # True once first delta arrives
        self._stream_box_opened = False  # True once the response box header is printed
        self._reasoning_preview_buf = ""  # Coalesce tiny reasoning chunks for [thinking] output
        # Table-row buffer.  When a streamed line looks like it could be
        # part of a markdown table, hold it here until the block ends so
        # we can re-pad with wcwidth-aware widths.  Empty by default;
        # populated only while `_in_stream_table` is True.
        self._stream_table_buf: list[str] = []
        self._in_stream_table = False
        self._pending_edit_snapshots = {}
        self._last_input_mode_recovery = 0.0
        self._input_mode_recovery_notice_shown = False
        
        # Configuration - priority: CLI args > env vars > config file
        # Model comes from: CLI arg or config.yaml (single source of truth).
        # LLM_MODEL/OPENAI_MODEL env vars are NOT checked — config.yaml is
        # authoritative.  This avoids conflicts in multi-agent setups where
        # env vars would stomp each other.
        _model_config = CLI_CONFIG.get("model", {})
        _config_model = (_model_config.get("default") or _model_config.get("model") or "") if isinstance(_model_config, dict) else (_model_config or "")
        _DEFAULT_CONFIG_MODEL = ""
        self.model = model or _config_model or _DEFAULT_CONFIG_MODEL
        # Auto-detect model from local server if still on default
        if self.model == _DEFAULT_CONFIG_MODEL:
            _base_url = (_model_config.get("base_url") or "") if isinstance(_model_config, dict) else ""
            if "localhost" in _base_url or "127.0.0.1" in _base_url:
                from fan_cli.runtime_provider import _auto_detect_local_model
                _detected = _auto_detect_local_model(_base_url)
                if _detected:
                    self.model = _detected
        # Track whether model was explicitly chosen by the user or fell back
        # to the global default.  Provider-specific normalisation may override
        # the default silently but should warn when overriding an explicit choice.
        # A config model that matches the global fallback is NOT considered an
        # explicit choice — the user just never changed it.  But a config model
        # like "gpt-5.3-codex" IS explicit and must be preserved.
        self._model_is_default = not model and (
            not _config_model or _config_model == _DEFAULT_CONFIG_MODEL
        )

        self._explicit_api_key = api_key
        self._explicit_base_url = base_url

        # Provider selection is resolved lazily at use-time via _ensure_runtime_credentials().
        self.requested_provider = (
            provider
            or CLI_CONFIG["model"].get("provider")
            or os.getenv("FAN_INFERENCE_PROVIDER")
            or "auto"
        )
        self._provider_source: Optional[str] = None
        self.provider = self.requested_provider
        self.api_mode = "chat_completions"
        self.acp_command: Optional[str] = None
        self.acp_args: list[str] = []
        self.base_url = (
            base_url
            or CLI_CONFIG["model"].get("base_url", "")
            or os.getenv("OPENROUTER_BASE_URL", "")
        ) or None
        # Match key to resolved base_url: OpenRouter URL → prefer OPENROUTER_API_KEY,
        # custom endpoint → prefer OPENAI_API_KEY (issue #560).
        # Note: _ensure_runtime_credentials() re-resolves this before first use.
        if self.base_url and base_url_host_matches(self.base_url, "openrouter.ai"):
            self.api_key = api_key or os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY")
        else:
            self.api_key = api_key or os.getenv("OPENAI_API_KEY") or os.getenv("OPENROUTER_API_KEY")
        # Max turns priority: CLI arg > config file > env var > default
        if max_turns is not None:  # CLI arg was explicitly set
            self.max_turns = max_turns
        elif CLI_CONFIG["agent"].get("max_turns"):
            self.max_turns = CLI_CONFIG["agent"]["max_turns"]
        elif CLI_CONFIG.get("max_turns"):  # Backwards compat: root-level max_turns
            self.max_turns = CLI_CONFIG["max_turns"]
        elif os.getenv("FAN_MAX_ITERATIONS"):
            try:
                self.max_turns = int(os.getenv("FAN_MAX_ITERATIONS", ""))
            except (TypeError, ValueError):
                self.max_turns = 90
        else:
            self.max_turns = 90
        
        # Parse and validate toolsets
        self.enabled_toolsets = toolsets
        self.disabled_toolsets = CLI_CONFIG["agent"].get("disabled_toolsets") or []

        if toolsets and "all" not in toolsets and "*" not in toolsets:
            # Validate each toolset — MCP server names are resolved via
            # live registry aliases (registered during discover_mcp_tools),
            # but discovery hasn't run yet at this point, so exclude them.
            mcp_names = set((CLI_CONFIG.get("mcp_servers") or {}).keys())
            invalid = [t for t in toolsets if not validate_toolset(t) and t not in mcp_names]
            if invalid:
                self._console_print(f"[bold red]Warning: Unknown toolsets: {', '.join(invalid)}[/]")
        
        # Filesystem checkpoints: CLI flag > config
        cp_cfg = CLI_CONFIG.get("checkpoints", {})
        if isinstance(cp_cfg, bool):
            cp_cfg = {"enabled": cp_cfg}
        self.checkpoints_enabled = checkpoints or cp_cfg.get("enabled", False)
        self.checkpoint_max_snapshots = cp_cfg.get("max_snapshots", 20)
        self.checkpoint_max_total_size_mb = cp_cfg.get("max_total_size_mb", 500)
        self.checkpoint_max_file_size_mb = cp_cfg.get("max_file_size_mb", 10)
        self.pass_session_id = pass_session_id
        # --ignore-rules: honor either the constructor flag or the env var set
        # by `fan chat --ignore-rules` in fan_cli/main.py. When true we
        # pass skip_context_files=True and skip_memory=True to AIAgent so
        # AGENTS.md/SOUL.md/.cursorrules and persistent memory are not loaded.
        self.ignore_rules = ignore_rules or os.environ.get("FAN_IGNORE_RULES") == "1"
        
        # Ephemeral system prompt: env var takes precedence, then config
        self.system_prompt = (
            os.getenv("FAN_EPHEMERAL_SYSTEM_PROMPT", "")
            or CLI_CONFIG["agent"].get("system_prompt", "")
        )
        self.personalities = CLI_CONFIG["agent"].get("personalities", {})
        
        # Ephemeral prefill messages (few-shot priming, never persisted)
        self.prefill_messages = _load_prefill_messages(
            _resolve_prefill_messages_file(CLI_CONFIG)
        )
        
        # Reasoning config (OpenRouter reasoning effort level)
        self.reasoning_config = _parse_reasoning_config(
            CLI_CONFIG["agent"].get("reasoning_effort", "")
        )
        self.service_tier = _parse_service_tier_config(
            CLI_CONFIG["agent"].get("service_tier", "")
        )
        
        # OpenRouter provider routing preferences
        pr = CLI_CONFIG.get("provider_routing", {}) or {}
        self._provider_sort = pr.get("sort")
        self._providers_only = pr.get("only")
        self._providers_ignore = pr.get("ignore")
        self._providers_order = pr.get("order")
        self._provider_require_params = pr.get("require_parameters", False)
        self._provider_data_collection = pr.get("data_collection")

        # OpenRouter Pareto Code router knob — coding-score floor (0.0-1.0).
        # Only applied when model.model == "openrouter/pareto-code".
        # Empty string / None / out-of-range = unset (let OR pick strongest coder).
        _or_cfg = CLI_CONFIG.get("openrouter", {}) or {}
        _raw_score = _or_cfg.get("min_coding_score")
        self._openrouter_min_coding_score: Optional[float] = None
        if _raw_score not in {None, ""}:
            try:
                _f = float(_raw_score)
                if 0.0 <= _f <= 1.0:
                    self._openrouter_min_coding_score = _f
            except (TypeError, ValueError):
                pass
        
        # Fallback provider chain — tried in order when primary fails after retries.
        # Merge new ``fallback_providers`` entries with any legacy
        # ``fallback_model`` entries so old configs still participate.
        self._fallback_model = get_fallback_chain(CLI_CONFIG)

        # Signature of the currently-initialised agent's runtime.  Used to
        # rebuild the agent when provider / model / base_url changes across
        # turns (e.g. after /model or credential rotation).
        self._active_agent_route_signature = None

        # Agent will be initialized on first use
        self.agent: Optional[Any] = None
        self._tool_callbacks_installed = False
        self._tirith_security_checked = False
        self._app = None  # prompt_toolkit Application (set in run())
        
        # Conversation state
        self.conversation_history: List[Dict[str, Any]] = []
        self.session_start = datetime.now()
        self._resumed = False
        # Per-prompt elapsed timer — started at the beginning of each chat turn,
        # frozen when the agent thread completes, displayed in the status bar.
        self._prompt_start_time: Optional[float] = None  # time.time() when turn started
        self._prompt_duration: float = 0.0  # frozen duration of last completed turn
        self._last_turn_finished_at: Optional[float] = None  # time.time() when the last agent loop finished
        # Initialize SQLite session store early so /title works before first message
        self._session_db = None
        self._session_db_unavailable = False
        self._session_db_warning_shown = False
        try:
            from fan_state import SessionDB
            self._session_db = SessionDB()
        except Exception as e:
            self._session_db_unavailable = True
            logger.warning("Failed to initialize SessionDB — session will NOT be indexed for search: %s", e)
            print(
                "WARNING: Session storage is unavailable. This conversation "
                "will not be saved, cannot be resumed, and session search is "
                "disabled until state.db is repaired.",
                file=sys.stderr,
            )
            self._session_db_warning_shown = True

        # Opportunistic state.db maintenance — runs at most once per
        # min_interval_hours, tracked via state_meta in state.db itself so
        # it's shared across all Fan processes for this FAN_HOME.
        # Never blocks startup on failure.
        _run_state_db_auto_maintenance(self._session_db)

        # Opportunistic shadow-repo cleanup — deletes orphan/stale
        # checkpoint repos under ~/.fan/checkpoints/.  Opt-in via
        # checkpoints.auto_prune, idempotent via .last_prune marker.
        _run_checkpoint_auto_maintenance()

        # Deferred title: stored in memory until the session is created in the DB
        self._pending_title: Optional[str] = None
        
        # Session ID: reuse existing one when resuming, otherwise generate fresh
        if resume:
            self.session_id = resume
            self._resumed = True
        else:
            timestamp_str = self.session_start.strftime("%Y%m%d_%H%M%S")
            short_uuid = uuid.uuid4().hex[:6]
            self.session_id = f"{timestamp_str}_{short_uuid}"
        
        # History file for persistent input recall across sessions
        self._history_file = _fan_home / ".fan_history"
        self._last_invalidate: float = 0.0  # throttle UI repaints
        self._app = None

        # State shared by interactive run() and single-query chat mode.
        # These must exist before any direct chat() call because single-query
        # mode does not go through run().
        self._agent_running = False
        self._pending_input = queue.Queue()
        self._interrupt_queue = queue.Queue()
        # Tracks whether the turn that just finished was interrupted via
        # Ctrl+C. Consumed by _maybe_continue_goal_after_turn so /goal loops
        # don't auto-queue another continuation on top of a user-cancelled
        # turn (which would make Ctrl+C feel like it did nothing).
        self._last_turn_interrupted = False
        self._should_exit = False
        # /exit --delete: when True, the current session's SQLite history and
        # on-disk transcripts are deleted during shutdown. Set by
        # process_command() when the user runs /exit --delete or /quit --delete.
        # Ported from google-gemini/gemini-cli#19332.
        self._delete_session_on_exit = False
        self._last_ctrl_c_time = 0
        self._collect_state = None
        self._collect_freetext = False
        self._collect_deadline = 0
        self._sudo_state = None
        self._sudo_deadline = 0
        self._modal_input_snapshot = None
        self._approval_state = None
        self._approval_deadline = 0
        self._approval_lock = threading.Lock()
        self._slash_confirm_state = None
        self._slash_confirm_deadline = 0
        self._model_picker_state = None
        # Armed when a bare `/resume` prints the recent-sessions list so the
        # very next bare numeric input (e.g. `3`) resolves to that session.
        # Holds the exact list used for index resolution; one-shot (cleared on
        # the next submitted input, whether it's the selection or anything
        # else). See #34584.
        self._pending_resume_sessions = None
        self._secret_state = None
        self._secret_deadline = 0
        self._spinner_text: str = ""  # thinking spinner text for TUI
        self._tool_start_time: float = 0.0  # monotonic timestamp when current tool started (for live elapsed)
        self._pending_tool_info: dict = {}  # function_name -> list of (preview, args) for stacked scrollback
        self._last_scrollback_tool: str = ""  # last tool name printed to scrollback (for "new" dedup)
        self._command_running = False
        self._command_status = ""
        self._attached_images: list[Path] = []
        self._image_counter = 0
        self.preloaded_skills: list[str] = []
        self._startup_skills_line_shown = False

        # Status bar visibility (toggled via /statusbar)
        self._status_bar_visible = True
        # When True, the input separator rules and the dynamic status bar are
        # hidden until the next user input. Set by _recover_after_resize() so a
        # SIGWINCH cannot stamp a freshly-drawn status bar on top of one that
        # the terminal just reflowed into scrollback — the cause of duplicated
        # bars / "blank line flooding" reports (#19280, #22976).
        self._status_bar_suppressed_after_resize = False
        self._resize_recovery_lock = threading.Lock()
        self._resize_recovery_timer = None
        self._resize_recovery_pending = False

        # Background task tracking: {task_id: threading.Thread}
        self._background_tasks: Dict[str, threading.Thread] = {}
        self._background_task_counter = 0

    def _invalidate(self, min_interval: float = 0.25) -> None:
        """Throttled UI repaint — prevents terminal blinking on slow/SSH connections."""
        if getattr(self, "_resize_recovery_pending", False):
            return
        now = time.monotonic()
        if hasattr(self, "_app") and self._app and (now - self._last_invalidate) >= min_interval:
            self._last_invalidate = now
            self._app.invalidate()

    def _force_full_redraw(self) -> None:
        """Force a clean full-screen repaint of the prompt_toolkit UI.

        Used to recover from terminal buffer drift caused by external
        redraws we can't detect — e.g. macOS cmux / tmux tab switches,
        ``clear`` issued from a subshell, or SSH window restores. These
        wipe or repaint the terminal without firing SIGWINCH, so
        prompt_toolkit's tracked ``_cursor_pos`` no longer matches reality
        and the next incremental redraw stacks on top of stale content
        (ghost status bars, duplicated prompts).

        Bound to Ctrl+L and exposed as the ``/redraw`` slash command,
        matching the standard terminal-UX convention (bash, zsh, fish,
        vim, htop).
        """
        app = getattr(self, "_app", None)
        if not app:
            return
        self._clear_prompt_toolkit_screen(app)
        _replay_output_history()
        try:
            app.invalidate()
        except Exception:
            pass

    def _clear_prompt_toolkit_screen(self, app, *, rebuild_scrollback: bool = False) -> None:
        """Clear the terminal and reset prompt_toolkit renderer state."""
        try:
            renderer = app.renderer
            out = renderer.output
            out.reset_attributes()
            out.erase_screen()
            if rebuild_scrollback:
                try:
                    out.write_raw("\x1b[3J")
                except Exception:
                    pass
            out.cursor_goto(0, 0)
            out.flush()
            # Drop prompt_toolkit's cached screen + cursor state so the
            # next _redraw() starts from a known (0, 0) origin and
            # re-renders every cell rather than diffing against stale.
            renderer.reset(leave_alternate_screen=False)
        except Exception:
            pass









    @staticmethod
    def _scrollback_box_width(width: Optional[int] = None) -> int:
        """Return the full viewport width for printed scrollback box rules.

        Previously this clamped to ``max(32, min(width, 56))`` as a defense
        against terminal-emulator reflow on column-shrink (#25975, salvaging
        #24403).  That clamp made response/reasoning borders look stubby on
        any modern wide terminal.  We now trust the prompt_toolkit
        ``_output_screen_diff`` monkey-patch landed in #26137 (salvaging
        #25981) to keep chrome out of scrollback in the first place, and
        accept that an aggressive column-shrink may visually reflow already
        printed Panel borders — that's a cosmetic artifact of stamped
        scrollback history, not a live-render bug.

        A small floor (32 cols) is kept so the box still renders on tiny
        terminals without negative ``'─' * (w - 2)`` math.
        """
        if width is None:
            try:
                width = shutil.get_terminal_size((80, 24)).columns
            except Exception:
                width = 80
        return max(32, int(width or 80))





    def _normalize_model_for_provider(self, resolved_provider: str) -> bool:
        """Normalize provider-specific model IDs and routing."""
        current_model = (self.model or "").strip()
        changed = False

        try:
            from fan_cli.model_normalize import (
                _AGGREGATOR_PROVIDERS,
                normalize_model_for_provider,
            )

            if resolved_provider not in _AGGREGATOR_PROVIDERS:
                normalized_model = normalize_model_for_provider(current_model, resolved_provider)
                if normalized_model and normalized_model != current_model:
                    if not self._model_is_default:
                        self._console_print(
                            f"[yellow]⚠️  Normalized model '{current_model}' to '{normalized_model}' for {resolved_provider}.[/]"
                        )
                    self.model = normalized_model
                    current_model = normalized_model
                    changed = True
        except Exception:
            pass

        if resolved_provider != "openai-codex":
            return changed

        # 1. Strip provider prefix ("openai/gpt-5.4" → "gpt-5.4")
        if "/" in current_model:
            slug = current_model.split("/", 1)[1]
            if not self._model_is_default:
                self._console_print(
                    f"[yellow]⚠️  Stripped provider prefix from '{current_model}'; "
                    f"using '{slug}' for OpenAI Codex.[/]"
                )
            self.model = slug
            current_model = slug
            changed = True

        # 2. Replace untouched default with a Codex model
        if self._model_is_default:
            fallback_model = "gpt-5.3-codex"
            if current_model != fallback_model:
                self.model = fallback_model
                changed = True

        return changed

    def _on_thinking(self, text: str) -> None:
        """Called by agent when thinking starts/stops. Updates TUI spinner."""
        if not text:
            self._flush_reasoning_preview(force=True)
        self._spinner_text = text or ""
        self._tool_start_time = 0.0  # clear tool timer when switching to thinking
        self._invalidate()

    # ── Streaming display ────────────────────────────────────────────────

    def _current_reasoning_callback(self):
        """Return the active reasoning display callback for the current mode."""
        if self.show_reasoning and self.streaming_enabled:
            return self._stream_reasoning_delta
        if self.verbose and not self.show_reasoning:
            return self._on_reasoning
        return None

    def _emit_reasoning_preview(self, reasoning_text: str) -> None:
        """Render a buffered reasoning preview as a single [thinking] block."""
        preview_text = reasoning_text.strip()
        if not preview_text:
            return

        try:
            term_width = shutil.get_terminal_size().columns
        except Exception:
            term_width = 80
        prefix = "  [thinking] "
        wrap_width = max(30, term_width - len(prefix) - 2)

        paragraphs = []
        raw_paragraphs = re.split(r"\n\s*\n+", preview_text.replace("\r\n", "\n"))
        for paragraph in raw_paragraphs:
            compact = " ".join(line.strip() for line in paragraph.splitlines() if line.strip())
            if compact:
                paragraphs.append(textwrap.fill(compact, width=wrap_width))
        preview_text = "\n".join(paragraphs)
        if not preview_text:
            return

        if self.verbose:
            _cprint(f"  {_DIM}[thinking] {preview_text}{_RST}")
            return

        lines = preview_text.splitlines()
        if len(lines) > 5:
            preview = "\n".join(lines[:5])
            preview += f"\n  ... ({len(lines) - 5} more lines)"
        else:
            preview = preview_text
        _cprint(f"  {_DIM}[thinking] {preview}{_RST}")

    def _flush_reasoning_preview(self, *, force: bool = False) -> None:
        """Flush buffered reasoning text at natural boundaries.

        Some providers stream reasoning in tiny word or punctuation chunks.
        Buffer them here so the preview path does not print one `[thinking]`
        line per token.
        """
        buf = getattr(self, "_reasoning_preview_buf", "")
        if not buf:
            return

        try:
            term_width = shutil.get_terminal_size().columns
        except Exception:
            term_width = 80
        target_width = max(40, term_width - len("  [thinking] ") - 4)

        flush_text = ""

        if force:
            flush_text = buf
            buf = ""
        else:
            line_break = buf.rfind("\n")
            min_newline_flush = max(16, target_width // 3)
            if line_break != -1 and (
                line_break >= min_newline_flush
                or buf.endswith("\n\n")
                or buf.endswith(".\n")
                or buf.endswith("!\n")
                or buf.endswith("?\n")
                or buf.endswith(":\n")
            ):
                flush_text = buf[: line_break + 1]
                buf = buf[line_break + 1 :]
            elif len(buf) >= target_width:
                search_start = max(20, target_width // 2)
                search_end = min(len(buf), max(target_width + (target_width // 3), target_width + 8))
                cut = -1
                for boundary in (" ", "\t", ".", "!", "?", ",", ";", ":"):
                    cut = max(cut, buf.rfind(boundary, search_start, search_end))
                if cut != -1:
                    flush_text = buf[: cut + 1]
                    buf = buf[cut + 1 :]

        self._reasoning_preview_buf = buf.lstrip() if flush_text else buf
        if flush_text:
            self._emit_reasoning_preview(flush_text)


    def _stream_reasoning_delta(self, text: str) -> None:
        """Stream reasoning/thinking tokens into a dim box above the response.

        Opens a dim reasoning box on first token, streams line-by-line.
        The box is closed automatically when content tokens start arriving
        (via _stream_delta → _emit_stream_text).

        Once the response box is open, suppress any further reasoning
        rendering — a late thinking block (e.g. after an interrupt) would
        otherwise draw a reasoning box inside the response box.
        """
        if not text:
            return
        self._reasoning_shown_this_turn = True
        if getattr(self, "_stream_box_opened", False):
            return

        # Open reasoning box on first reasoning token
        if not getattr(self, "_reasoning_box_opened", False):
            self._reasoning_box_opened = True
            w = self._scrollback_box_width()
            r_label = " Reasoning "
            r_fill = w - 2 - len(r_label)
            _cprint(f"\n{_DIM}┌─{r_label}{'─' * max(r_fill - 1, 0)}┐{_RST}")

        self._reasoning_buf = getattr(self, "_reasoning_buf", "") + text

        # Emit complete lines, and force-flush long partial lines so
        # reasoning is visible in real-time even without newlines.
        while "\n" in self._reasoning_buf:
            line, self._reasoning_buf = self._reasoning_buf.split("\n", 1)
            _cprint(f"{_DIM}{line}{_RST}")
        if len(self._reasoning_buf) > 80:
            _cprint(f"{_DIM}{self._reasoning_buf}{_RST}")
            self._reasoning_buf = ""

    def _close_reasoning_box(self) -> None:
        """Close the live reasoning box if it's open."""
        if getattr(self, "_reasoning_box_opened", False):
            # Flush remaining reasoning buffer
            buf = getattr(self, "_reasoning_buf", "")
            if buf:
                _cprint(f"{_DIM}{buf}{_RST}")
                self._reasoning_buf = ""
            w = self._scrollback_box_width()
            _cprint(f"{_DIM}└{'─' * (w - 2)}┘{_RST}")
            self._reasoning_box_opened = False

            # Flush any content that was deferred while reasoning was rendering.
            deferred = getattr(self, "_deferred_content", "")
            if deferred:
                self._deferred_content = ""
                self._emit_stream_text(deferred)

    def _stream_delta(self, text) -> None:
        """Line-buffered streaming callback for real-time token rendering.

        Receives text deltas from the agent as tokens arrive. Buffers
        partial lines and emits complete lines via _cprint to work
        reliably with prompt_toolkit's patch_stdout.

        Reasoning/thinking blocks (<REASONING_SCRATCHPAD>, <think>, etc.)
        are suppressed during streaming since they'd display raw XML tags.
        The agent strips them from the final response anyway.

        A ``None`` value signals an intermediate turn boundary (tools are
        about to execute).  Flushes any open boxes and resets state so
        tool feed lines render cleanly between turns.
        """
        if text is None:
            self._flush_stream()
            self._reset_stream_state()
            return
        if not text:
            return

        self._stream_started = True

        # ── Tag-based reasoning suppression ──
        # Track whether we're inside a reasoning/thinking block.
        # These tags are model-generated (system prompt tells the model
        # to use them) and get stripped from final_response. We must
        # suppress them during streaming too — unless show_reasoning is
        # enabled, in which case we route the inner content to the
        # reasoning display box instead of discarding it.
        _OPEN_TAGS = ("<REASONING_SCRATCHPAD>", "<think>", "<reasoning>", "<THINKING>", "<thinking>", "<thought>")
        _CLOSE_TAGS = ("</REASONING_SCRATCHPAD>", "</think>", "</reasoning>", "</THINKING>", "</thinking>", "</thought>")

        # Append to a pre-filter buffer first
        self._stream_prefilt = getattr(self, "_stream_prefilt", "") + text

        # Check if we're entering a reasoning block.
        # Only match tags that appear at a "block boundary": start of the
        # stream, after a newline (with optional whitespace), or when nothing
        # but whitespace has been emitted on the current line.
        # This prevents false positives when models *mention* tags in prose
        # like "(/think not producing <think> tags)".
        #
        # _stream_last_was_newline tracks whether the last character emitted
        # (or the start of the stream) is a line boundary.  It's True at
        # stream start and set True whenever emitted text ends with '\n'.
        if not hasattr(self, "_stream_last_was_newline"):
            self._stream_last_was_newline = True  # start of stream = boundary

        if not getattr(self, "_in_reasoning_block", False):
            for tag in _OPEN_TAGS:
                search_start = 0
                while True:
                    idx = self._stream_prefilt.find(tag, search_start)
                    if idx == -1:
                        break
                    # Check if this is a block boundary position
                    preceding = self._stream_prefilt[:idx]
                    if idx == 0:
                        # At buffer start — only a boundary if we're at
                        # a line start (stream start or last emit ended
                        # with newline)
                        is_block_boundary = getattr(self, "_stream_last_was_newline", True)
                    else:
                        # Find last newline in the buffer before the tag
                        last_nl = preceding.rfind("\n")
                        if last_nl == -1:
                            # No newline in buffer — boundary only if
                            # last emit was a newline AND only whitespace
                            # has accumulated before the tag
                            is_block_boundary = (
                                getattr(self, "_stream_last_was_newline", True)
                                and preceding.strip() == ""
                            )
                        else:
                            # Text between last newline and tag must be
                            # whitespace-only
                            is_block_boundary = preceding[last_nl + 1:].strip() == ""
                    if is_block_boundary:
                        # Emit everything before the tag
                        if preceding:
                            self._emit_stream_text(preceding)
                            self._stream_last_was_newline = preceding.endswith("\n")
                        self._in_reasoning_block = True
                        self._stream_prefilt = self._stream_prefilt[idx + len(tag):]
                        break
                    # Not a block boundary — keep searching after this occurrence
                    search_start = idx + 1
                if getattr(self, "_in_reasoning_block", False):
                    break

            # Could also be a partial open tag at the end — hold it back
            if not getattr(self, "_in_reasoning_block", False):
                # Check for partial tag match at the end
                safe = self._stream_prefilt
                for tag in _OPEN_TAGS:
                    for i in range(1, len(tag)):
                        if self._stream_prefilt.endswith(tag[:i]):
                            safe = self._stream_prefilt[:-i]
                            break
                if safe:
                    self._emit_stream_text(safe)
                    self._stream_last_was_newline = safe.endswith("\n")
                    self._stream_prefilt = self._stream_prefilt[len(safe):]
                return

        # Inside a reasoning block — look for close tag.
        # Keep accumulating _stream_prefilt because close tags can arrive
        # split across multiple tokens (e.g. "</REASONING_SCRATCH" + "PAD>...").
        if getattr(self, "_in_reasoning_block", False):
            for tag in _CLOSE_TAGS:
                idx = self._stream_prefilt.find(tag)
                if idx != -1:
                    self._in_reasoning_block = False
                    # When show_reasoning is on, route inner content to
                    # the reasoning display box instead of discarding.
                    if self.show_reasoning:
                        inner = self._stream_prefilt[:idx]
                        if inner:
                            self._stream_reasoning_delta(inner)
                    after = self._stream_prefilt[idx + len(tag):]
                    self._stream_prefilt = ""
                    # Process remaining text after close tag through full
                    # filtering (it could contain another open tag)
                    if after:
                        self._stream_delta(after)
                    return
            # When show_reasoning is on, stream reasoning content live
            # instead of silently accumulating. Keep only the tail that
            # could be a partial close tag prefix.
            max_tag_len = max(len(t) for t in _CLOSE_TAGS)
            if len(self._stream_prefilt) > max_tag_len:
                if self.show_reasoning:
                    # Route the safe prefix to reasoning display
                    safe_reasoning = self._stream_prefilt[:-max_tag_len]
                    self._stream_reasoning_delta(safe_reasoning)
                self._stream_prefilt = self._stream_prefilt[-max_tag_len:]
            return

    def _emit_stream_text(self, text: str) -> None:
        """Emit filtered text to the streaming display."""
        if not text:
            return

        # When show_reasoning is on and reasoning is still rendering,
        # defer content until the reasoning box closes.  This ensures the
        # reasoning block always appears BEFORE the response in the terminal.
        if self.show_reasoning and getattr(self, "_reasoning_box_opened", False):
            self._deferred_content = getattr(self, "_deferred_content", "") + text
            return

        # Close the live reasoning box before opening the response box
        self._close_reasoning_box()

        # Open the response box header on the very first visible text
        if not self._stream_box_opened:
            # Strip leading whitespace/newlines before first visible content
            text = text.lstrip("\n")
            if not text:
                return
            self._stream_box_opened = True
            try:
                from fan_cli.skin_engine import get_active_skin
                _skin = get_active_skin()
                label = _skin.get_branding("response_label", "⚕ Fan")
                _text_hex = _skin.get_color("banner_text", "#FFF8DC")
            except Exception:
                label = "⚕ Fan"
                _text_hex = "#FFF8DC"
            # Build a true-color ANSI escape for the response text color
            # so streamed content matches the Rich Panel appearance.
            try:
                _r = int(_text_hex[1:3], 16)
                _g = int(_text_hex[3:5], 16)
                _b = int(_text_hex[5:7], 16)
                self._stream_text_ansi = f"\033[38;2;{_r};{_g};{_b}m"
            except (ValueError, IndexError):
                self._stream_text_ansi = ""
            if self.show_timestamps:
                label = f"{label} {datetime.now().strftime('%H:%M')}"
            w = self._scrollback_box_width()
            fill = w - 2 - len(label)
            _cprint(f"\n{_ACCENT}╭─{label}{'─' * max(fill - 1, 0)}╮{_RST}")

        self._stream_buf += text

        # Emit complete lines, keep partial remainder in buffer
        _tc = getattr(self, "_stream_text_ansi", "")

        def _emit_one(printed_line: str) -> None:
            _cprint(f"{_STREAM_PAD}{_tc}{printed_line}{_RST}" if _tc else f"{_STREAM_PAD}{printed_line}")

        def _flush_table_buf() -> None:
            buf = self._stream_table_buf
            self._stream_table_buf = []
            self._in_stream_table = False
            if not buf:
                return
            # Strip cell-level markdown (`code`, **bold**, ~~strike~~) FIRST
            # so the realigner pads to the final visible cell width, not
            # the marker-decorated source width.  Otherwise a body row
            # like `` | Bold | `**bold**` | `` lands narrower than its
            # header column once the markers are removed.
            joined = "\n".join(buf)
            if self.final_response_markdown == "strip":
                joined = _strip_markdown_syntax(joined)
            block = realign_markdown_tables(joined, _terminal_width_for_streaming())
            for ln in block.split("\n"):
                _emit_one(ln)

        while "\n" in self._stream_buf:
            line, self._stream_buf = self._stream_buf.split("\n", 1)

            # Hold table-shaped lines in a side-buffer so we can re-pad
            # the whole block once it ends.  Streaming line-by-line, we
            # cannot re-align mid-table without reflowing already-printed
            # rows; the cost is that the user sees the table appear in a
            # single batch when the block closes instead of row-by-row.
            if self._in_stream_table:
                if looks_like_table_row(line) or is_table_divider(line):
                    self._stream_table_buf.append(line)
                    continue
                # Block ended — flush the realigned table, then fall
                # through to print the current (non-table) line.
                _flush_table_buf()
            elif looks_like_table_row(line):
                self._stream_table_buf.append(line)
                self._in_stream_table = True
                continue

            if self.final_response_markdown == "strip":
                line = _strip_markdown_syntax(line)
            _emit_one(line)

    def _flush_stream(self) -> None:
        """Emit any remaining partial line from the stream buffer and close the box."""
        # If we're still inside a "reasoning block" at end-of-stream, it was
        # a false positive — the model mentioned a tag like <think> in prose
        # but never closed it.  Recover the buffered content as regular text.
        if getattr(self, "_in_reasoning_block", False) and getattr(self, "_stream_prefilt", ""):
            self._in_reasoning_block = False
            self._emit_stream_text(self._stream_prefilt)
            self._stream_prefilt = ""

        # Close reasoning box if still open (in case no content tokens arrived)
        self._close_reasoning_box()

        _tc = getattr(self, "_stream_text_ansi", "")

        # If the stream buffer has a trailing partial line that looks like
        # a table row, fold it into the table buffer so the whole block
        # gets re-aligned together.  Otherwise the final row prints raw
        # (with the model's original under-padded spacing) while the rows
        # above it are aligned.
        if (
            self._stream_buf
            and getattr(self, "_in_stream_table", False)
            and (looks_like_table_row(self._stream_buf) or is_table_divider(self._stream_buf))
        ):
            self._stream_table_buf.append(self._stream_buf)
            self._stream_buf = ""

        # Flush any buffered table rows first so their padding is
        # finalised before the stream remainder lands.
        if getattr(self, "_stream_table_buf", None):
            joined = "\n".join(self._stream_table_buf)
            self._stream_table_buf = []
            self._in_stream_table = False
            if self.final_response_markdown == "strip":
                joined = _strip_markdown_syntax(joined)
            block = realign_markdown_tables(joined, _terminal_width_for_streaming())
            for ln in block.split("\n"):
                _cprint(f"{_STREAM_PAD}{_tc}{ln}{_RST}" if _tc else f"{_STREAM_PAD}{ln}")

        if self._stream_buf:
            line = _strip_markdown_syntax(self._stream_buf) if self.final_response_markdown == "strip" else self._stream_buf
            _cprint(f"{_STREAM_PAD}{_tc}{line}{_RST}" if _tc else f"{_STREAM_PAD}{line}")
            self._stream_buf = ""

        # Close the response box
        if self._stream_box_opened:
            w = self._scrollback_box_width()
            _cprint(f"{_ACCENT}╰{'─' * (w - 2)}╯{_RST}")

    def _reset_stream_state(self) -> None:
        """Reset streaming state before each agent invocation."""
        self._stream_buf = ""
        self._stream_started = False
        self._stream_box_opened = False
        self._stream_text_ansi = ""
        self._stream_prefilt = ""
        self._in_reasoning_block = False
        self._stream_last_was_newline = True
        self._reasoning_box_opened = False
        self._reasoning_buf = ""
        self._reasoning_preview_buf = ""
        self._deferred_content = ""
        self._stream_table_buf = []
        self._in_stream_table = False

    def _slow_command_status(self, command: str) -> str:
        """Return a user-facing status message for slower slash commands."""
        cmd_lower = command.lower().strip()
        if cmd_lower == "/reload-mcp":
            return "Reloading MCP servers..."
        if cmd_lower == "/reload-skills" or cmd_lower == "/reload_skills":
            return "Reloading skills..."
        return "Processing command..."


    @contextmanager
    def _busy_command(self, status: str):
        """Expose a temporary busy state in the TUI while a slash command runs."""
        self._command_running = True
        self._command_status = status
        self._invalidate(min_interval=0.0)
        try:
            print(f"⏳ {status}")
            yield
        finally:
            self._command_running = False
            self._command_status = ""
            self._invalidate(min_interval=0.0)


    def _ensure_runtime_credentials(self) -> bool:
        """
        Ensure runtime credentials are resolved before agent use.
        Re-resolves provider credentials so key rotation and token refresh
        are picked up without restarting the CLI.
        Returns True if credentials are ready, False on auth failure.
        """
        from fan_cli.runtime_provider import (
            resolve_runtime_provider,
            format_runtime_provider_error,
        )

        _primary_exc = None
        runtime = None
        try:
            runtime = resolve_runtime_provider(
                requested=self.requested_provider,
                explicit_api_key=self._explicit_api_key,
                explicit_base_url=self._explicit_base_url,
            )
        except Exception as exc:
            _primary_exc = exc

        # Primary provider auth failed — try fallback providers before giving up.
        if runtime is None and _primary_exc is not None:
            from fan_cli.auth import AuthError
            if isinstance(_primary_exc, AuthError):
                _fb_chain = self._fallback_model if isinstance(self._fallback_model, list) else []
                for _fb in _fb_chain:
                    _fb_provider = (_fb.get("provider") or "").strip().lower()
                    _fb_model = (_fb.get("model") or "").strip()
                    if not _fb_provider or not _fb_model:
                        continue
                    try:
                        runtime = resolve_runtime_provider(requested=_fb_provider)
                        logger.warning(
                            "Primary provider auth failed (%s). Falling through to fallback: %s/%s",
                            _primary_exc, _fb_provider, _fb_model,
                        )
                        _cprint(f"⚠️  Primary auth failed — switching to fallback: {_fb_provider} / {_fb_model}")
                        self.requested_provider = _fb_provider
                        self.model = _fb_model
                        _primary_exc = None
                        break
                    except Exception:
                        continue

        if runtime is None:
            message = format_runtime_provider_error(_primary_exc) if _primary_exc else "Provider resolution failed."
            ChatConsole().print(f"[bold red]{message}[/]")
            return False

        api_key = runtime.get("api_key")
        base_url = runtime.get("base_url")
        resolved_provider = runtime.get("provider", "openrouter")
        resolved_api_mode = runtime.get("api_mode", self.api_mode)
        resolved_acp_command = runtime.get("command")
        resolved_acp_args = list(runtime.get("args") or [])
        resolved_credential_pool = runtime.get("credential_pool")
        # A callable api_key is a bearer-token provider. The OpenAI SDK
        # accepts ``Callable[[], str]`` for ``api_key`` and invokes it before
        # every request. Skip the string-only validation and placeholder
        # substitution for callables.
        _is_callable_provider = callable(api_key) and not isinstance(api_key, str)
        if not _is_callable_provider and (not isinstance(api_key, str) or not api_key):
            # Custom / local endpoints (llama.cpp, ollama, vLLM, etc.) often
            # don't require authentication.  When a base_url IS configured but
            # no API key was found, use a placeholder so the OpenAI SDK
            # doesn't reject the request and local servers just ignore it.
            _source = runtime.get("source", "")
            _has_custom_base = isinstance(base_url, str) and base_url and "openrouter.ai" not in base_url
            if _has_custom_base:
                api_key = "no-key-required"
                logger.debug(
                    "No API key for custom endpoint %s (source=%s), "
                    "using placeholder — local servers typically ignore auth",
                    base_url, _source,
                )
            else:
                print("\n⚠️  Provider resolver returned an empty API key. "
                      "Set OPENROUTER_API_KEY or run: fan setup")
                return False
        if not isinstance(base_url, str) or not base_url:
            print("\n⚠️  Provider resolver returned an empty base URL. "
                  "Check your provider config or run: fan setup")
            return False

        credentials_changed = api_key != self.api_key or base_url != self.base_url
        routing_changed = (
            resolved_provider != self.provider
            or resolved_api_mode != self.api_mode
            or resolved_acp_command != self.acp_command
            or resolved_acp_args != self.acp_args
        )
        self.provider = resolved_provider
        self.api_mode = resolved_api_mode
        self.acp_command = resolved_acp_command
        self.acp_args = resolved_acp_args
        self._credential_pool = resolved_credential_pool
        self._provider_source = runtime.get("source")
        self.api_key = api_key
        self.base_url = base_url

        # When a custom_provider entry carries an explicit `model` field,
        # use it as the effective model name.  Without this, running
        # `fan chat --model <provider-name>` sends the provider name
        # (e.g. "my-provider") as the model string to the API instead of
        # the configured model (e.g. "qwen3.6-plus"), causing 400 errors.
        runtime_model = runtime.get("model")
        if runtime_model and isinstance(runtime_model, str):
            # Only use runtime model if: model is unset, or model equals provider name
            should_use_runtime_model = (
                not self.model or  # No model configured yet
                self.model == self.provider or  # Model is the provider slug
                self.model == runtime.get("name")  # Model matches provider display name
            )
            if should_use_runtime_model:
                self.model = runtime_model

        # Normalize model for the resolved provider (e.g. swap non-Codex
        # models when provider is openai-codex).  Fixes #651.
        model_changed = self._normalize_model_for_provider(resolved_provider)

        # AIAgent/OpenAI client holds auth at init time, so rebuild if key,
        # routing, or the effective model changed.
        if (credentials_changed or routing_changed or model_changed) and self.agent is not None:
            self.agent = None
            self._active_agent_route_signature = None

        return True

    def _resolve_turn_agent_config(self, user_message: str) -> dict:
        """Build the effective model/runtime config for a single user turn.

        Always uses the session's primary model/provider.
        """
        runtime = {
            "api_key": self.api_key,
            "base_url": self.base_url,
            "provider": self.provider,
            "api_mode": self.api_mode,
            "command": self.acp_command,
            "args": list(self.acp_args or []),
            "credential_pool": getattr(self, "_credential_pool", None),
        }
        route = {
            "model": self.model,
            "runtime": runtime,
            "signature": (
                self.model,
                runtime["provider"],
                runtime["base_url"],
                runtime["api_mode"],
                runtime["command"],
                tuple(runtime["args"]),
            ),
        }

        route["request_overrides"] = None
        return route

    def _install_tool_callbacks(self) -> None:
        """Install tool callbacks that need the live prompt UI."""
        if getattr(self, "_tool_callbacks_installed", False):
            return
        set_sudo_password_callback(self._sudo_password_callback)
        set_approval_callback(self._approval_callback)
        set_secret_capture_callback(self._secret_capture_callback)
        try:
            from tools.computer_use_tool import set_approval_callback as _set_cu_cb

            _set_cu_cb(self._computer_use_approval_callback)
        except ImportError:
            pass
        self._tool_callbacks_installed = True

    def _ensure_tirith_security(self) -> None:
        """Check tirith availability once before tools can run terminal commands."""
        if getattr(self, "_tirith_security_checked", False):
            return
        self._tirith_security_checked = True
        try:
            from tools.tirith_security import ensure_installed, is_platform_supported

            tirith_path = ensure_installed(log_failures=False)
            if tirith_path is None and is_platform_supported():
                security_cfg = self.config.get("security", {}) or {}
                tirith_enabled = security_cfg.get("tirith_enabled", True)
                if tirith_enabled:
                    _cprint(
                        f"  {_DIM}⚠ tirith security scanner enabled but not available "
                        f"— command scanning will use pattern matching only{_RST}"
                    )
        except Exception:
            pass

    def _init_agent(self, *, model_override: str = None, runtime_override: dict = None, request_overrides: dict | None = None) -> bool:
        """
        Initialize the agent on first use.
        When resuming a session, restores conversation history from SQLite.
        
        Returns:
            bool: True if successful, False otherwise
        """
        if self.agent is not None:
            return True

        _prepare_deferred_agent_startup()
        self._install_tool_callbacks()
        self._ensure_tirith_security()

        if not self._ensure_runtime_credentials():
            return False

        from fan_cli.mcp_startup import wait_for_mcp_discovery

        wait_for_mcp_discovery()

        # Initialize SQLite session store for CLI sessions (if not already done in __init__)
        if self._session_db is None:
            try:
                from fan_state import SessionDB
                self._session_db = SessionDB()
                self._session_db_unavailable = False
            except Exception as e:
                self._session_db_unavailable = True
                logger.warning("SQLite session store not available — session will NOT be indexed: %s", e)
                if not self._session_db_warning_shown:
                    print(
                        "WARNING: Session storage is unavailable. This conversation "
                        "will not be saved, cannot be resumed, and session search "
                        "is disabled until state.db is repaired.",
                        file=sys.stderr,
                    )
                    self._session_db_warning_shown = True
        
        # If resuming, validate the session exists and load its history.
        # _preload_resumed_session() may have already loaded it (called from
        # run() for immediate display).  In that case, conversation_history
        # is non-empty and we skip the DB round-trip.
        if self._resumed and self._session_db and not self.conversation_history:
            session_meta = self._session_db.get_session(self.session_id)
            # In quiet mode (`fan chat -Q` / --quiet, surfaced via
            # tool_progress_mode == "off"), resume status lines go to stderr
            # so stdout stays machine-readable for automation wrappers that
            # do `$(fan chat -Q --resume <id> -q "...")`. Without this,
            # the resume banner pollutes captured stdout. See #11793.
            _quiet_mode = getattr(self, "tool_progress_mode", "full") == "off"
            if not session_meta:
                if _quiet_mode:
                    print(f"Session not found: {self.session_id}", file=sys.stderr)
                    print(
                        "Use a session ID from a previous run (see the desktop session list).",
                        file=sys.stderr,
                    )
                else:
                    _cprint(f"\033[1;31mSession not found: {self.session_id}{_RST}")
                    _cprint(f"{_DIM}Use a session ID from a previous run (see the desktop session list).{_RST}")
                return False
            # If the requested session is the (empty) head of a compression
            # chain, walk to the descendant that actually holds the messages.
            # See #15000 and SessionDB.resolve_resume_session_id.
            try:
                resolved_id = self._session_db.resolve_resume_session_id(self.session_id)
            except Exception:
                resolved_id = self.session_id
            if resolved_id and resolved_id != self.session_id:
                ChatConsole().print(
                    f"[{_DIM}]Session {_escape(self.session_id)} was compressed into "
                    f"{_escape(resolved_id)}; resuming the descendant with your "
                    f"transcript.[/]"
                )
                self.session_id = resolved_id
                resolved_meta = self._session_db.get_session(self.session_id)
                if resolved_meta:
                    session_meta = resolved_meta
            restored = self._session_db.get_messages_as_conversation(self.session_id)
            if restored:
                restored = [m for m in restored if m.get("role") != "session_meta"]
                self.conversation_history = restored
                msg_count = len([m for m in restored if m.get("role") == "user"])
                title_part = ""
                if session_meta.get("title"):
                    title_part = f" \"{session_meta['title']}\""
                if _quiet_mode:
                    print(
                        f"↻ Resumed session {self.session_id}{title_part} "
                        f"({msg_count} user message{'s' if msg_count != 1 else ''}, "
                        f"{len(restored)} total messages)",
                        file=sys.stderr,
                    )
                else:
                    ChatConsole().print(
                        f"[bold {_accent_hex()}]↻ Resumed session[/] "
                        f"[bold]{_escape(self.session_id)}[/]"
                        f"[bold {_accent_hex()}]{_escape(title_part)}[/] "
                        f"({msg_count} user message{'s' if msg_count != 1 else ''}, {len(restored)} total messages)"
                    )
                self._restore_session_cwd(session_meta, quiet=_quiet_mode)
            else:
                if _quiet_mode:
                    print(
                        f"Session {self.session_id} found but has no messages. Starting fresh.",
                        file=sys.stderr,
                    )
                else:
                    ChatConsole().print(
                        f"[bold {_accent_hex()}]Session {_escape(self.session_id)} found but has no messages. Starting fresh.[/]"
                    )
            # Re-open the session (clear ended_at so it's active again)
            try:
                self._session_db._conn.execute(
                    "UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?",
                    (self.session_id,),
                )
                self._session_db._conn.commit()
            except Exception:
                pass
        
        try:
            runtime = runtime_override or {
                "api_key": self.api_key,
                "base_url": self.base_url,
                "provider": self.provider,
                "api_mode": self.api_mode,
                "command": self.acp_command,
                "args": list(self.acp_args or []),
                "credential_pool": getattr(self, "_credential_pool", None),
            }
            effective_model = model_override or self.model
            self.agent = AIAgent(
                model=effective_model,
                api_key=runtime.get("api_key"),
                base_url=runtime.get("base_url"),
                provider=runtime.get("provider"),
                api_mode=runtime.get("api_mode"),
                acp_command=runtime.get("command"),
                acp_args=runtime.get("args"),
                credential_pool=runtime.get("credential_pool"),
                max_iterations=self.max_turns,
                enabled_toolsets=self.enabled_toolsets,
                disabled_toolsets=self.disabled_toolsets,
                verbose_logging=self.verbose,
                quiet_mode=not self.verbose,
                tool_progress_mode=self.tool_progress_mode,
                ephemeral_system_prompt=self.system_prompt if self.system_prompt else None,
                prefill_messages=self.prefill_messages or None,
                reasoning_config=self.reasoning_config,
                service_tier=self.service_tier,
                request_overrides=request_overrides,
                providers_allowed=self._providers_only,
                providers_ignored=self._providers_ignore,
                providers_order=self._providers_order,
                provider_sort=self._provider_sort,
                provider_require_parameters=self._provider_require_params,
                provider_data_collection=self._provider_data_collection,
                openrouter_min_coding_score=self._openrouter_min_coding_score,
                session_id=self.session_id,
                platform="cli",
                session_db=self._session_db,
                collect_callback=self._collect_callback,
                reasoning_callback=self._current_reasoning_callback(),

                fallback_model=self._fallback_model,
                thinking_callback=self._on_thinking,
                checkpoints_enabled=self.checkpoints_enabled,
                checkpoint_max_snapshots=self.checkpoint_max_snapshots,
                checkpoint_max_total_size_mb=self.checkpoint_max_total_size_mb,
                checkpoint_max_file_size_mb=self.checkpoint_max_file_size_mb,
                pass_session_id=self.pass_session_id,
                skip_context_files=self.ignore_rules,
                skip_memory=self.ignore_rules,
                tool_progress_callback=self._on_tool_progress,
                tool_start_callback=self._on_tool_start if self._inline_diffs_enabled else None,
                tool_complete_callback=self._on_tool_complete if self._inline_diffs_enabled else None,
                stream_delta_callback=self._stream_delta if self.streaming_enabled else None,
                tool_gen_callback=self._on_tool_gen_start if self.streaming_enabled else None,
            )
            # Store reference for atexit memory provider shutdown
            global _active_agent_ref, _active_cli_ref
            _active_agent_ref = self.agent
            _active_cli_ref = self
            # Route agent status output through prompt_toolkit so ANSI escape
            # sequences aren't garbled by patch_stdout's StdoutProxy (#2262).
            self.agent._print_fn = _cprint
            self._active_agent_route_signature = (
                effective_model,
                runtime.get("provider"),
                runtime.get("base_url"),
                runtime.get("api_mode"),
                runtime.get("command"),
                tuple(runtime.get("args") or ()),
            )

            # Force-create DB row on /title intent, then apply title.
            if self._pending_title and self._session_db and self.agent:
                try:
                    self.agent._ensure_db_session()
                    if self.agent._session_db_created:
                        self._session_db.set_session_title(self.session_id, self._pending_title)
                        _cprint(f"  Session title applied: {self._pending_title}")
                        self._pending_title = None
                    # else: row creation failed transiently — keep _pending_title for retry
                except (ValueError, Exception) as e:
                    _cprint(f"  Could not apply pending title: {e}")
                    # Keep _pending_title so it can be retried after row creation succeeds
            return True
        except Exception as e:
            ChatConsole().print(f"[bold red]Failed to initialize agent: {e}[/]")
            return False
    

    def show_banner(self):
        """Display the welcome banner in Claude Code style."""
        self.console.clear()
        ctx_len = None
        if hasattr(self, 'agent') and self.agent and hasattr(self.agent, 'context_compressor'):
            ctx_len = self.agent.context_compressor.context_length
        
        # Auto-compact for narrow terminals — the full banner with caduceus
        # + tool list needs ~80 columns minimum to render without wrapping.
        term_width = shutil.get_terminal_size().columns
        use_compact = self.compact or term_width < 80
        
        if use_compact:
            self._console_print(_build_compact_banner())
            self._show_status()
        else:
            # Get tools for display
            tools = get_tool_definitions(enabled_toolsets=self.enabled_toolsets, quiet_mode=True)
            
            # Get terminal working directory (where commands will execute)
            cwd = os.getenv("TERMINAL_CWD", os.getcwd())
            
            # Build and display the banner
            build_welcome_banner(
                console=self.console,
                model=self.model,
                cwd=cwd,
                tools=tools,
                enabled_toolsets=self.enabled_toolsets,
                session_id=self.session_id,
                context_length=ctx_len,
            )
        
        # Tool discovery is intentionally deferred on the Termux bare prompt
        # path; availability warnings are shown once tools are initialized.
        if os.environ.get("FAN_DEFER_AGENT_STARTUP") != "1":
            self._show_tool_availability_warnings()

        # Warn about low context lengths (common with local servers). Keep
        # this tied to the runtime guard so guidance cannot drift again.
        from agent.model_metadata import MINIMUM_CONTEXT_LENGTH
        if ctx_len and ctx_len < MINIMUM_CONTEXT_LENGTH:
            self._console_print()
            self._console_print(
                f"[yellow]⚠️  Context length is only {ctx_len:,} tokens — "
                f"this is likely too low for agent use with tools.[/]"
            )
            self._console_print(
                f"[dim]   Fan needs at least {MINIMUM_CONTEXT_LENGTH:,} tokens. Tool schemas + system prompt use a large fixed prefix.[/]"
            )
            base_url = getattr(self, "base_url", "") or ""
            if "11434" in base_url or "ollama" in base_url.lower():
                self._console_print(
                    f"[dim]   Ollama fix: OLLAMA_CONTEXT_LENGTH={MINIMUM_CONTEXT_LENGTH} ollama serve[/]"
                )
            elif "1234" in base_url:
                self._console_print(
                    "[dim]   LM Studio fix: Set context length in model settings → reload model[/]"
                )
            else:
                self._console_print(
                    "[dim]   Fix: Set model.context_length in config.yaml, or increase your server's context setting[/]"
                )

        self._console_print()

    def _restore_session_cwd(self, session_meta: dict, *, quiet: bool = False) -> None:
        """Relaunch a resumed session in the directory it was started from.

        Idempotent and safe to call from every resume path. When the stored
        ``cwd`` differs from the current process directory, we both
        ``os.chdir()`` (so the process and any ``os.getcwd()`` fallback agree)
        and retarget ``TERMINAL_CWD`` (so the terminal tool, code-exec tool,
        and relative-path resolution all land in the same place — the local
        terminal backend snapshots cwd on first use, which happens after this).

        No-ops when: the session recorded no cwd (gateway/remote/older
        sessions), the directory no longer exists, or we're already there.
        A missing directory degrades to a single dim warning rather than a
        crash — repos get moved and deleted.
        """
        recorded = (session_meta or {}).get("cwd")
        if not recorded:
            return
        recorded = os.path.expanduser(str(recorded))
        try:
            current = os.getcwd()
        except OSError:
            current = None
        if current and os.path.realpath(recorded) == os.path.realpath(current):
            return  # Already where the session lived — nothing to announce.

        if not os.path.isdir(recorded):
            msg = f"⚠ Session's working directory is gone: {recorded} — staying in {current or '.'}"
            if quiet:
                print(msg, file=sys.stderr)
            else:
                self._console_print(f"[{_DIM}]{_escape(msg)}[/]")
            return

        try:
            os.chdir(recorded)
        except OSError as e:
            msg = f"⚠ Could not enter session's working directory {recorded}: {e}"
            if quiet:
                print(msg, file=sys.stderr)
            else:
                self._console_print(f"[{_DIM}]{_escape(msg)}[/]")
            return

        # Retarget the terminal/code-exec tools to match the process cwd.
        os.environ["TERMINAL_CWD"] = recorded

        msg = f"↻ Working directory: {recorded}"
        if quiet:
            print(msg, file=sys.stderr)
        else:
            self._console_print(f"[{_DIM}]{_escape(msg)}[/]")


    def _display_resumed_history(self):
        """Render a compact recap of previous conversation messages.

        Uses Rich markup with dim/muted styling so the recap is visually
        distinct from the active conversation.  Caps the display at the
        last ``MAX_DISPLAY_EXCHANGES`` user/assistant exchanges and shows
        an indicator for earlier hidden messages.
        """
        if not self.conversation_history:
            return

        # Check config: resume_display setting
        if self.resume_display == "minimal":
            return

        # Read limits from config (with hardcoded defaults)
        _disp = CLI_CONFIG.get("display", {})
        MAX_DISPLAY_EXCHANGES = int(_disp.get("resume_exchanges", 10))
        MAX_USER_LEN = int(_disp.get("resume_max_user_chars", 300))
        MAX_ASST_LEN = int(_disp.get("resume_max_assistant_chars", 200))
        MAX_ASST_LINES = int(_disp.get("resume_max_assistant_lines", 3))
        SKIP_TOOL_ONLY = _disp.get("resume_skip_tool_only", True)

        # Collect displayable entries (skip system, tool-result messages)
        entries = []  # list of (role, display_text)
        _last_asst_idx = None       # index of last assistant entry
        _last_asst_full = None      # un-truncated display text for last assistant
        for msg in self.conversation_history:
            role = msg.get("role", "")
            content = msg.get("content")
            tool_calls = msg.get("tool_calls") or []

            if role == "system":
                continue
            if role == "tool":
                continue

            if role == "user":
                text = "" if content is None else str(content)
                # Handle multimodal content (list of dicts)
                if isinstance(content, list):
                    parts = []
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            parts.append(part.get("text", ""))
                        elif isinstance(part, dict) and part.get("type") == "image_url":
                            parts.append("[image]")
                    text = " ".join(parts)
                if len(text) > MAX_USER_LEN:
                    text = text[:MAX_USER_LEN] + "..."
                entries.append(("user", text))

            elif role == "assistant":
                text = "" if content is None else str(content)
                text = _strip_reasoning_tags(text)
                parts = []
                full_parts = []  # un-truncated version
                if text:
                    full_parts.append(text)
                    lines = text.splitlines()
                    if len(lines) > MAX_ASST_LINES:
                        text = "\n".join(lines[:MAX_ASST_LINES]) + " ..."
                    if len(text) > MAX_ASST_LEN:
                        text = text[:MAX_ASST_LEN] + "..."
                    parts.append(text)
                if tool_calls:
                    tc_count = len(tool_calls)
                    # Extract tool names
                    names = []
                    for tc in tool_calls:
                        fn = tc.get("function", {})
                        name = fn.get("name", "unknown") if isinstance(fn, dict) else "unknown"
                        if name not in names:
                            names.append(name)
                    names_str = ", ".join(names[:4])
                    if len(names) > 4:
                        names_str += ", ..."
                    noun = "call" if tc_count == 1 else "calls"
                    tc_summary = f"[{tc_count} tool {noun}: {names_str}]"
                    parts.append(tc_summary)
                    full_parts.append(tc_summary)
                if not parts:
                    # Skip pure-reasoning messages that have no visible output
                    continue
                # Skip tool-call-only entries when SKIP_TOOL_ONLY is enabled
                has_text = bool(text)
                if SKIP_TOOL_ONLY and not has_text and tool_calls:
                    continue
                entries.append(("assistant", " ".join(parts)))
                _last_asst_idx = len(entries) - 1
                _last_asst_full = " ".join(full_parts)

        if not entries:
            return

        # Determine if we need to truncate
        skipped = 0
        if len(entries) > MAX_DISPLAY_EXCHANGES * 2:
            skipped = len(entries) - MAX_DISPLAY_EXCHANGES * 2
            entries = entries[skipped:]

        # Replace last assistant entry with full (un-truncated) text
        # so the user can see where they left off without wasting tokens.
        if _last_asst_idx is not None and _last_asst_full:
            adj_idx = _last_asst_idx - skipped
            if 0 <= adj_idx < len(entries):
                entries[adj_idx] = ("assistant_last", _last_asst_full)

        # Build the display using Rich
        from rich.panel import Panel
        from rich.text import Text

        try:
            from fan_cli.skin_engine import get_active_skin
            _skin = get_active_skin()
            _history_text_c = _skin.get_color("banner_text", "#FFF8DC")
            _session_label_c = _skin.get_color("session_label", "#DAA520")
            _session_border_c = _skin.get_color("session_border", "#8B8682")
            _assistant_label_c = _skin.get_color("ui_ok", "#8FBC8F")
        except Exception:
            _history_text_c = "#FFF8DC"
            _session_label_c = "#DAA520"
            _session_border_c = "#8B8682"
            _assistant_label_c = "#8FBC8F"

        lines = Text()
        if skipped:
            lines.append(
                f"  ... {skipped} earlier messages ...\n\n",
                style="dim italic",
            )

        for i, (role, text) in enumerate(entries):
            if role == "user":
                lines.append("  ● You: ", style=f"dim bold {_session_label_c}")
                # Show first line inline, indent rest
                msg_lines = text.splitlines()
                lines.append(msg_lines[0] + "\n", style="dim")
                for ml in msg_lines[1:]:
                    lines.append(f"         {ml}\n", style="dim")
            elif role == "assistant_last":
                # Last assistant response shown in full, non-dim
                lines.append("  ◆ Fan: ", style=f"bold {_assistant_label_c}")
                msg_lines = text.splitlines()
                lines.append(msg_lines[0] + "\n", style="")
                for ml in msg_lines[1:]:
                    lines.append(f"            {ml}\n", style="")
            else:
                lines.append("  ◆ Fan: ", style=f"dim bold {_assistant_label_c}")
                msg_lines = text.splitlines()
                lines.append(msg_lines[0] + "\n", style="dim")
                for ml in msg_lines[1:]:
                    lines.append(f"            {ml}\n", style="dim")
            if i < len(entries) - 1:
                lines.append("")  # small gap

        panel = Panel(
            lines,
            title=f"[dim {_session_label_c}]Previous Conversation[/]",
            border_style=f"dim {_session_border_c}",
            padding=(0, 1),
            style=_history_text_c,
        )
        _record_output_history_entry(lambda: self._render_resume_history_panel_lines(panel))
        with _suspend_output_history():
            self._console_print(panel)

    def _render_resume_history_panel_lines(self, panel) -> list[str]:
        """Render the resume panel at the current terminal width for resize replay."""
        from io import StringIO

        buf = StringIO()
        width = shutil.get_terminal_size((80, 24)).columns
        console = Console(
            file=buf,
            force_terminal=True,
            color_system="truecolor",
            highlight=False,
            width=width,
        )
        with _suspend_output_history():
            console.print(panel)
        return buf.getvalue().rstrip("\n").splitlines()

    def _try_attach_clipboard_image(self) -> bool:
        """Check clipboard for an image and attach it if found.

        Saves the image to ~/.fan/images/ and appends the path to
        ``_attached_images``.  Returns True if an image was attached.
        """
        from fan_cli.clipboard import save_clipboard_image

        img_dir = get_fan_home() / "images"
        self._image_counter += 1
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        img_path = img_dir / f"clip_{ts}_{self._image_counter}.png"

        if save_clipboard_image(img_path):
            self._attached_images.append(img_path)
            return True
        self._image_counter -= 1
        return False

    def _handle_rollback_command(self, command: str):
        """Handle /rollback — list, diff, or restore filesystem checkpoints.

        Syntax:
            /rollback                 — list checkpoints
            /rollback <N>             — restore checkpoint N (also undoes last chat turn)
            /rollback diff <N>        — preview changes since checkpoint N
            /rollback <N> <file>      — restore a single file from checkpoint N
        """
        from tools.checkpoint_manager import format_checkpoint_list

        if not hasattr(self, 'agent') or not self.agent:
            print("  No active agent session.")
            return

        mgr = self.agent._checkpoint_mgr
        if not mgr.enabled:
            print("  Checkpoints are not enabled.")
            print("  Enable with: fan --checkpoints")
            print("  Or in config.yaml: checkpoints: { enabled: true }")
            return

        cwd = os.getenv("TERMINAL_CWD", os.getcwd())
        parts = command.split()
        args = parts[1:] if len(parts) > 1 else []

        if not args:
            # List checkpoints
            checkpoints = mgr.list_checkpoints(cwd)
            print(format_checkpoint_list(checkpoints, cwd))
            return

        # Handle /rollback diff <N>
        if args[0].lower() == "diff":
            if len(args) < 2:
                print("  Usage: /rollback diff <N>")
                return
            checkpoints = mgr.list_checkpoints(cwd)
            if not checkpoints:
                print(f"  No checkpoints found for {cwd}")
                return
            target_hash = self._resolve_checkpoint_ref(args[1], checkpoints)
            if not target_hash:
                return
            result = mgr.diff(cwd, target_hash)
            if result["success"]:
                stat = result.get("stat", "")
                diff = result.get("diff", "")
                if not stat and not diff:
                    print("  No changes since this checkpoint.")
                else:
                    if stat:
                        print(f"\n{stat}")
                    if diff:
                        # Limit diff output to avoid terminal flood
                        diff_lines = diff.splitlines()
                        if len(diff_lines) > 80:
                            print("\n".join(diff_lines[:80]))
                            print(f"\n  ... ({len(diff_lines) - 80} more lines, showing first 80)")
                        else:
                            print(f"\n{diff}")
            else:
                print(f"  ❌ {result['error']}")
            return

        # Resolve checkpoint reference (number or hash)
        checkpoints = mgr.list_checkpoints(cwd)
        if not checkpoints:
            print(f"  No checkpoints found for {cwd}")
            return

        target_hash = self._resolve_checkpoint_ref(args[0], checkpoints)
        if not target_hash:
            return

        # Check for file-level restore: /rollback <N> <file>
        file_path = args[1] if len(args) > 1 else None

        result = mgr.restore(cwd, target_hash, file_path=file_path)
        if result["success"]:
            if file_path:
                print(f"  ✅ Restored {file_path} from checkpoint {result['restored_to']}: {result['reason']}")
            else:
                print(f"  ✅ Restored to checkpoint {result['restored_to']}: {result['reason']}")
            print("  A pre-rollback snapshot was saved automatically.")

            # Also undo the last conversation turn so the agent's context
            # matches the restored filesystem state
            if self.conversation_history:
                self.undo_last(prefill=False)
                print("  Chat turn undone to match restored file state.")
        else:
            print(f"  ❌ {result['error']}")

    def _resolve_checkpoint_ref(self, ref: str, checkpoints: list) -> str | None:
        """Resolve a checkpoint number or hash to a full commit hash."""
        try:
            idx = int(ref) - 1  # 1-indexed for user
            if 0 <= idx < len(checkpoints):
                return checkpoints[idx]["hash"]
            else:
                print(f"  Invalid checkpoint number. Use 1-{len(checkpoints)}.")
                return None
        except ValueError:
            # Treat as a git hash
            return ref

    def _handle_stop_command(self):
        """Handle /stop — kill all running background processes and
        background (async) delegations.

        Inspired by OpenAI Codex's separation of interrupt (stop current turn)
        from /stop (clean up background processes). See openai/codex#14602.
        """
        from tools.process_registry import process_registry

        processes = process_registry.list_sessions()
        running = [p for p in processes if p.get("status") == "running"]

        # Background subagents dispatched via delegate_task(background=true)
        # live in their own registry, not the process registry.
        try:
            from tools.async_delegation import active_count, interrupt_all
            n_async = active_count()
        except Exception:
            n_async = 0
            interrupt_all = None

        if not running and not n_async:
            print("  No running background processes.")
            return

        if running:
            print(f"  Stopping {len(running)} background process(es)...")
            killed = process_registry.kill_all()
            print(f"  ✅ Stopped {killed} process(es).")
        if n_async and interrupt_all is not None:
            stopped = interrupt_all(reason="/stop")
            print(f"  ✅ Interrupted {stopped} background delegation(s).")

    def _handle_agents_command(self):
        """Handle /agents — show background processes and agent status."""
        from tools.process_registry import format_uptime_short, process_registry

        processes = process_registry.list_sessions()
        running = [p for p in processes if p.get("status") == "running"]
        finished = [p for p in processes if p.get("status") != "running"]

        _cprint(f"  Running processes: {len(running)}")
        for p in running:
            cmd = p.get("command", "")[:80]
            up = format_uptime_short(p.get("uptime_seconds", 0))
            _cprint(f"    {p.get('session_id', '?')} · {up} · {cmd}")

        if finished:
            _cprint(f"  Recently finished: {len(finished)}")

        # Background (async) delegations — delegate_task(background=true)
        try:
            from tools.async_delegation import list_async_delegations
            delegations = list_async_delegations()
        except Exception:
            delegations = []
        running_d = [d for d in delegations if d.get("status") == "running"]
        if delegations:
            _cprint(f"  Background delegations: {len(running_d)} running")
            for d in delegations:
                goal = (d.get("goal") or "")[:60]
                _cprint(
                    f"    {d.get('delegation_id', '?')} · "
                    f"{d.get('status', '?')} · {goal}"
                )

        agent_running = getattr(self, "_agent_running", False)
        _cprint(f"  Agent: {'running' if agent_running else 'idle'}")

    def _handle_paste_command(self):
        """Handle /paste — explicitly check clipboard for an image.

        This is the reliable fallback for terminals where BracketedPaste
        doesn't fire for image-only clipboard content (e.g., VSCode terminal,
        Windows Terminal with WSL2).
        """
        if _is_termux_environment():
            _cprint(
                f"  {_DIM}Clipboard image paste is not available on Termux — "
                f"use /image <path> or paste a local image path like "
                f"{_termux_example_image_path()}{_RST}"
            )
            return

        from fan_cli.clipboard import has_clipboard_image
        if has_clipboard_image():
            if self._try_attach_clipboard_image():
                n = len(self._attached_images)
                _cprint(f"  📎 Image #{n} attached from clipboard")
            else:
                _cprint(f"  {_DIM}(>_<) Clipboard has an image but extraction failed{_RST}")
        else:
            _cprint(f"  {_DIM}(._.) No image found in clipboard{_RST}")

    def _write_osc52_clipboard(self, text: str) -> None:
        """Copy *text* to terminal clipboard via OSC 52."""
        payload = base64.b64encode(text.encode("utf-8")).decode("ascii")
        seq = f"\x1b]52;c;{payload}\x07"
        out = getattr(self, "_app", None)
        output = getattr(out, "output", None) if out else None
        if output and hasattr(output, "write_raw"):
            output.write_raw(seq)
            output.flush()
            return
        if output and hasattr(output, "write"):
            output.write(seq)
            output.flush()
            return
        sys.stdout.write(seq)
        sys.stdout.flush()


    def _handle_copy_command(self, cmd_original: str) -> None:
        """Handle /copy [number] — copy assistant output to clipboard."""
        parts = cmd_original.split(maxsplit=1)
        arg = parts[1].strip() if len(parts) > 1 else ""

        assistant = [m for m in self.conversation_history if m.get("role") == "assistant"]
        if not assistant:
            _cprint("  Nothing to copy yet.")
            return

        if arg:
            try:
                idx = int(arg) - 1
            except ValueError:
                _cprint("  Usage: /copy [number]")
                return
            if idx < 0 or idx >= len(assistant):
                _cprint(f"  Invalid response number. Use 1-{len(assistant)}.")
                return
        else:
            idx = len(assistant) - 1
            while idx >= 0 and not _assistant_copy_text(assistant[idx].get("content")):
                idx -= 1
            if idx < 0:
                _cprint("  Nothing to copy in assistant responses yet.")
                return

        text = _assistant_copy_text(assistant[idx].get("content"))
        if not text:
            _cprint("  Nothing to copy in that assistant response.")
            return

        try:
            self._write_osc52_clipboard(text)
            _cprint(f"  Copied assistant response #{idx + 1} to clipboard")
        except Exception as e:
            _cprint(f"  Clipboard copy failed: {e}")

    def _handle_image_command(self, cmd_original: str):
        """Handle /image <path> — attach a local image file for the next prompt."""
        raw_args = (cmd_original.split(None, 1)[1].strip() if " " in cmd_original else "")
        if not raw_args:
            hint = _termux_example_image_path() if _is_termux_environment() else "/path/to/image.png"
            _cprint(f"  {_DIM}Usage: /image <path>  e.g. /image {hint}{_RST}")
            return

        path_token, _remainder = _split_path_input(raw_args)
        image_path = _resolve_attachment_path(path_token)
        if image_path is None:
            _cprint(f"  {_DIM}(>_<) File not found: {path_token}{_RST}")
            return
        if image_path.suffix.lower() not in _IMAGE_EXTENSIONS:
            _cprint(f"  {_DIM}(._.) Not a supported image file: {image_path.name}{_RST}")
            return

        self._attached_images.append(image_path)
        _cprint(f"  📎 Attached image: {image_path.name}")
        if _remainder:
            _cprint(f"  {_DIM}Now type your prompt (or use --image in single-query mode): {_remainder}{_RST}")
        elif _is_termux_environment():
            _cprint(f"  {_DIM}Tip: type your next message, or run fan chat -q --image {_termux_example_image_path(image_path.name)} \"What do you see?\"{_RST}")

    def _preprocess_images_with_vision(self, text: str, images: list, *, announce: bool = True) -> str:
        """Analyze attached images via the vision tool and return enriched text.

        Instead of embedding raw base64 ``image_url`` content parts in the
        conversation (which only works with vision-capable models), this
        pre-processes each image through the auxiliary vision model (Gemini
        Flash) and prepends the descriptions to the user's message — the
        same preprocessing approach used by the local desktop runtime.

        The local file path is included so the agent can re-examine the
        image later with ``vision_analyze`` if needed.
        """
        import asyncio as _asyncio
        from tools.vision_tools import vision_analyze_tool

        analysis_prompt = (
            "Describe everything visible in this image in thorough detail. "
            "Include any text, code, data, objects, people, layout, colors, "
            "and any other notable visual information."
        )

        enriched_parts = []
        for img_path in images:
            if not img_path.exists():
                continue
            size_kb = img_path.stat().st_size // 1024
            if announce:
                _cprint(f"  {_DIM}👁️  analyzing {img_path.name} ({size_kb}KB)...{_RST}")
            try:
                result_json = _asyncio.run(
                    vision_analyze_tool(image_url=str(img_path), user_prompt=analysis_prompt)
                )
                result = json.loads(result_json)
                if result.get("success"):
                    description = result.get("analysis", "")
                    enriched_parts.append(
                        f"[The user attached an image. Here's what it contains:\n{description}]\n"
                        f"[If you need a closer look, use vision_analyze with "
                        f"image_url: {img_path}]"
                    )
                    if announce:
                        _cprint(f"  {_DIM}✓ image analyzed{_RST}")
                else:
                    enriched_parts.append(
                        f"[The user attached an image but it couldn't be analyzed. "
                        f"You can try examining it with vision_analyze using "
                        f"image_url: {img_path}]"
                    )
                    if announce:
                        _cprint(f"  {_DIM}⚠ vision analysis failed — path included for retry{_RST}")
            except Exception as e:
                enriched_parts.append(
                    f"[The user attached an image but analysis failed ({e}). "
                    f"You can try examining it with vision_analyze using "
                    f"image_url: {img_path}]"
                )
                if announce:
                    _cprint(f"  {_DIM}⚠ vision analysis error — path included for retry{_RST}")

        # Combine: vision descriptions first, then the user's original text
        user_text = text if isinstance(text, str) and text else ""
        if enriched_parts:
            prefix = "\n\n".join(enriched_parts)
            return f"{prefix}\n\n{user_text}" if user_text else prefix
        return user_text or "What do you see in this image?"

    def _show_tool_availability_warnings(self):
        """Show warnings about disabled tools due to missing API keys."""
        try:
            from model_tools import check_tool_availability
            
            available, unavailable = check_tool_availability()
            
            # Filter to only those missing API keys (not system deps)
            api_key_missing = [u for u in unavailable if u["missing_vars"]]
            
            if api_key_missing:
                self._console_print()
                self._console_print("[yellow]⚠️  Some tools disabled (missing API keys):[/]")
                for item in api_key_missing:
                    tools_str = ", ".join(item["tools"][:2])  # Show first 2 tools
                    if len(item["tools"]) > 2:
                        tools_str += f", +{len(item['tools'])-2} more"
                    self._console_print(f"   [dim]• {item['name']}[/] [dim italic]({', '.join(item['missing_vars'])})[/]")
                self._console_print("[dim]   Run 'fan setup' to configure[/]")
        except Exception:
            pass  # Don't crash on import errors
    
    def _show_status(self):
        """Show compact startup status line."""
        # Avoid pulling the full tool registry into the bare Termux prompt path.
        if os.environ.get("FAN_DEFER_AGENT_STARTUP") == "1":
            tool_status = "tools deferred"
        else:
            tools = get_tool_definitions(enabled_toolsets=self.enabled_toolsets, quiet_mode=True)
            tool_count = len(tools) if tools else 0
            tool_status = f"{tool_count} tools"

        # Format model name (shorten if needed)
        model_short = self.model.split("/")[-1] if "/" in self.model else self.model
        if len(model_short) > 30:
            model_short = model_short[:27] + "..."

        # Get API status indicator
        if self.api_key:
            api_indicator = "[green bold]●[/]"
        else:
            api_indicator = "[red bold]●[/]"

        # Build status line with proper markup — skin-aware colors
        try:
            from fan_cli.skin_engine import get_active_skin
            skin = get_active_skin()
            separator_color = skin.get_color("banner_dim", "#B8860B")
            accent_color = skin.get_color("ui_accent", "#FFBF00")
            label_color = skin.get_color("ui_label", "#DAA520")
        except Exception:
            separator_color, accent_color, label_color = "#B8860B", "#FFBF00", "cyan"
        toolsets_info = ""
        if self.enabled_toolsets and "all" not in self.enabled_toolsets:
            toolsets_info = f" [dim {separator_color}]·[/] [{label_color}]toolsets: {', '.join(self.enabled_toolsets)}[/]"

        provider_info = f" [dim {separator_color}]·[/] [dim]provider: {self.provider}[/]"
        if self._provider_source:
            provider_info += f" [dim {separator_color}]·[/] [dim]auth: {self._provider_source}[/]"

        self._console_print(
            f"  {api_indicator} [{accent_color}]{model_short}[/] "
            f"[dim {separator_color}]·[/] [bold {label_color}]{tool_status}[/]"
            f"{toolsets_info}{provider_info}"
        )

    def _show_session_status(self):
        """Show gateway-style status for the current CLI session."""
        session_meta = {}
        if self._session_db:
            try:
                session_meta = self._session_db.get_session(self.session_id) or {}
            except Exception:
                session_meta = {}

        title = (session_meta.get("title") or "").strip()

        created_at = self.session_start
        started_at = session_meta.get("started_at")
        if started_at:
            try:
                created_at = datetime.fromtimestamp(float(started_at))
            except Exception:
                created_at = self.session_start

        updated_at = created_at
        for field in ("updated_at", "last_updated_at", "last_activity_at"):
            value = session_meta.get(field)
            if not value:
                continue
            try:
                updated_at = datetime.fromtimestamp(float(value))
                break
            except Exception:
                pass

        agent = getattr(self, "agent", None)
        total_tokens = getattr(agent, "session_total_tokens", 0) or 0
        provider = getattr(self, "provider", None) or "unknown"
        model = getattr(self, "model", None) or "(unknown)"
        is_running = bool(getattr(self, "_agent_running", False))

        # Context window + current usage (best-effort, from the live compressor).
        # adapted to our 2-brain switcher (the active brain's real context_length,
        # i.e. the shared 1M window) instead of upstream's single-model path.
        ctx_line = None
        compressor = getattr(agent, "context_compressor", None)
        if compressor is not None:
            ctx_window = getattr(compressor, "context_length", 0) or 0
            ctx_used = getattr(compressor, "last_prompt_tokens", 0) or 0
            if ctx_used < 0:
                ctx_used = 0
            if ctx_window > 0:
                pct = max(0, min(100, round((ctx_used / ctx_window) * 100)))
                ctx_line = f"Context: {ctx_used:,} / {_format_context_length(ctx_window)} ({pct}%)"

        lines = [
            "Fan CLI Status",
            "",
            f"Session ID: {self.session_id}",
            f"Path: {display_fan_home()}",
        ]
        if title:
            lines.append(f"Title: {title}")
        lines.extend([
            f"Model: {model} ({provider})",
            f"Created: {created_at.strftime('%Y-%m-%d %H:%M')}",
            f"Last Activity: {updated_at.strftime('%Y-%m-%d %H:%M')}",
        ])
        if ctx_line:
            lines.append(ctx_line)
        lines.extend([
            f"Tokens (cumulative): {total_tokens:,}",
            f"Agent Running: {'Yes' if is_running else 'No'}",
        ])
        self._console_print("\n".join(lines), highlight=False, markup=False)
    
    def _command_available(self, slash_command: str) -> bool:
        return True

    def show_help(self):
        """Display help information with categorized commands."""
        from fan_cli.commands import COMMANDS_BY_CATEGORY

        try:
            from fan_cli.skin_engine import get_active_help_header
            header = get_active_help_header("(^_^)? Available Commands")
        except Exception:
            header = "(^_^)? Available Commands"
        header = (header or "").strip() or "(^_^)? Available Commands"
        inner_width = 55
        if len(header) > inner_width:
            header = header[:inner_width]
        _cprint(f"\n{_BOLD}+{'-' * inner_width}+{_RST}")
        _cprint(f"{_BOLD}|{header:^{inner_width}}|{_RST}")
        _cprint(f"{_BOLD}+{'-' * inner_width}+{_RST}")

        for category, commands in COMMANDS_BY_CATEGORY.items():
            _cprint(f"\n  {_BOLD}── {category} ──{_RST}")
            for cmd, desc in commands.items():
                if not self._command_available(cmd):
                    continue
                ChatConsole().print(f"    [bold {_accent_hex()}]{cmd:<15}[/] [dim]-[/] {_escape(desc)}")

        skill_commands = _ensure_skill_commands()
        if skill_commands:
            _cprint(f"\n  ⚡ {_BOLD}Skill Commands{_RST} ({len(skill_commands)} installed):")
            for cmd, info in sorted(skill_commands.items()):
                ChatConsole().print(
                    f"    [bold {_accent_hex()}]{cmd:<22}[/] [dim]-[/] {_escape(info['description'])}"
                )

        _bundles_now = get_skill_bundles()
        if _bundles_now:
            _cprint(f"\n  ▣ {_BOLD}Skill Bundles{_RST} ({len(_bundles_now)} installed):")
            for cmd, info in sorted(_bundles_now.items()):
                skill_count = len(info.get("skills", []))
                desc = info.get("description") or f"Load {skill_count} skills"
                ChatConsole().print(
                    f"    [bold {_accent_hex()}]{cmd:<22}[/] [dim]-[/] "
                    f"{_escape(desc)} [dim]({skill_count} skills)[/]"
                )

        quick_commands = self.config.get("quick_commands", {})
        if quick_commands:
            _cprint(f"\n  ⚡ {_BOLD}Quick Commands{_RST} ({len(quick_commands)} configured):")
            for _qname, _qcmd in sorted(quick_commands.items()):
                _qdesc = _qcmd.get("description", _qcmd.get("type", "")) if isinstance(_qcmd, dict) else ""
                ChatConsole().print(
                    f"    [bold {_accent_hex()}]{('/' + _qname):<22}[/] [dim]-[/] {_escape(_qdesc)}"
                )

        _cprint(f"\n  {_DIM}Tip: Just type your message to chat with Fan!{_RST}")
        _cprint(f"  {_DIM}Multi-line: Alt+Enter for a new line{_RST}")
        _cprint(f"  {_DIM}Draft editor: Ctrl+G (Alt+G in VSCode/Cursor){_RST}")
        if _is_termux_environment():
            _cprint(f"  {_DIM}Attach image: /image {_termux_example_image_path()} or start your prompt with a local image path{_RST}\n")
        else:
            _cprint(f"  {_DIM}Paste image: Alt+V (or /paste){_RST}\n")
    
    def show_tools(self):
        """Display available tools with kawaii ASCII art."""
        tools = get_tool_definitions(enabled_toolsets=self.enabled_toolsets, quiet_mode=True)
        
        if not tools:
            print("(;_;) No tools available")
            return
        
        # Header
        print()
        title = "(^_^)/ Available Tools"
        width = 78
        pad = width - len(title)
        print("+" + "-" * width + "+")
        print("|" + " " * (pad // 2) + title + " " * (pad - pad // 2) + "|")
        print("+" + "-" * width + "+")
        print()
        
        # Group tools by toolset
        toolsets = {}
        for tool in sorted(tools, key=lambda t: t["function"]["name"]):
            name = tool["function"]["name"]
            toolset = get_toolset_for_tool(name) or "unknown"
            if toolset not in toolsets:
                toolsets[toolset] = []
            desc = tool["function"].get("description", "")
            # First sentence: split on ". " (period+space) to avoid breaking on "e.g." or "v2.0"
            desc = desc.split("\n")[0]
            if ". " in desc:
                desc = desc[:desc.index(". ") + 1]
            toolsets[toolset].append((name, desc))
        
        # Display by toolset
        for toolset in sorted(toolsets.keys()):
            print(f"  [{toolset}]")
            for name, desc in toolsets[toolset]:
                print(f"    * {name:<20} - {desc}")
            print()
        
        print(f"  Total: {len(tools)} tools  ヽ(^o^)ノ")
        print()

    def _handle_tools_command(self, cmd: str):
        """Handle /tools [list|disable|enable] slash commands.

        /tools (no args) shows the tool list.
        /tools list shows enabled/disabled status per toolset.
        /tools disable/enable saves the change to config and resets
        the session so the new tool set takes effect cleanly (no
        prompt-cache breakage mid-conversation).
        """
        import shlex
        from argparse import Namespace
        from contextlib import redirect_stdout
        from io import StringIO
        from fan_cli.tools_config import tools_disable_enable_command

        def _run_capture(ns: Namespace) -> None:
            """Run tools_disable_enable_command, routing its ANSI-colored
            print() output through _cprint when inside the interactive TUI
            so escapes aren't mangled by patch_stdout's StdoutProxy into
            garbled '?[32m...?[0m' text.

            Outside the TUI (standalone mode, tests), call straight through
            so real stdout / pytest capture works as expected.
            """
            # Standalone/tests, run as usual
            if getattr(self, "_app", None) is None:
                tools_disable_enable_command(ns)
                return

            # Buffer reports isatty()=True so color() in fan_cli/colors.py
            # still emits ANSI escapes. StringIO.isatty() is False, which
            # would otherwise strip all colors before we re-render them.
            class _TTYBuf(StringIO):
                def isatty(self) -> bool:
                    return True

            buf = _TTYBuf()
            with redirect_stdout(buf):
                tools_disable_enable_command(ns)
            for line in buf.getvalue().splitlines():
                _cprint(line)

        try:
            parts = shlex.split(cmd)
        except ValueError:
            parts = cmd.split()

        subcommand = parts[1] if len(parts) > 1 else ""
        if subcommand not in {"list", "disable", "enable"}:
            self.show_tools()
            return

        if subcommand == "list":
            _run_capture(Namespace(tools_action="list", platform="cli"))
            return

        names = parts[2:]
        if not names:
            print(f"(._.) Usage: /tools {subcommand} <name> [name ...]")
            print(f"  Built-in toolset:  /tools {subcommand} web")
            print(f"  MCP tool:          /tools {subcommand} github:create_issue")
            return

        # Apply the change directly — the user typing the command is implicit
        # consent.  Do NOT use input() here; it hangs inside prompt_toolkit's
        # TUI event loop (known pitfall).
        verb = "Disabling" if subcommand == "disable" else "Enabling"
        label = ", ".join(names)
        _cprint(f"{_ACCENT}{verb} {label}...{_RST}")

        _run_capture(Namespace(tools_action=subcommand, names=names, platform="cli"))

        # Reset session so the new tool config is picked up from a clean state
        from fan_cli.tools_config import _get_platform_tools
        from fan_cli.config import load_config
        self.enabled_toolsets = _get_platform_tools(load_config(), "cli")
        self.new_session()
        _cprint(f"{_DIM}Session reset. New tool configuration is active.{_RST}")

    def show_toolsets(self):
        """Display available toolsets with kawaii ASCII art."""
        all_toolsets = get_all_toolsets()
        
        # Header
        print()
        title = "(^_^)b Available Toolsets"
        width = 58
        pad = width - len(title)
        print("+" + "-" * width + "+")
        print("|" + " " * (pad // 2) + title + " " * (pad - pad // 2) + "|")
        print("+" + "-" * width + "+")
        print()
        
        for name in sorted(all_toolsets.keys()):
            info = get_toolset_info(name)
            if info:
                tool_count = info["tool_count"]
                desc = info["description"]
                
                # Mark if currently enabled
                marker = "(*)" if self.enabled_toolsets and name in self.enabled_toolsets else "   "
                print(f"  {marker} {name:<18} [{tool_count:>2} tools] - {desc}")
        
        print()
        print("  (*) = currently enabled")
        print()
        print("  Tip: Use 'all' or '*' to enable all toolsets")
        print("  Example: python cli.py --toolsets web,terminal")
        print()
    
    def show_config(self):
        """Display current configuration with kawaii ASCII art."""
        # Get terminal config from environment (which was set from cli-config.yaml)
        terminal_env = os.getenv("TERMINAL_ENV", "local")
        terminal_cwd = os.getenv("TERMINAL_CWD", os.getcwd())
        terminal_timeout = os.getenv("TERMINAL_TIMEOUT", "60")
        
        user_config_path = _fan_home / 'config.yaml'
        project_config_path = Path(__file__).parent / 'cli-config.yaml'
        if user_config_path.exists():
            config_path = user_config_path
        else:
            config_path = project_config_path
        config_status = "(loaded)" if config_path.exists() else "(not found)"
        
        if isinstance(self.api_key, str) and len(self.api_key) > 12:
            api_key_display = f"{self.api_key[:8]}...{self.api_key[-4:]}"
        else:
            api_key_display = "Not set!"
        
        print()
        title = "(^_^) Configuration"
        width = 50
        pad = width - len(title)
        print("+" + "-" * width + "+")
        print("|" + " " * (pad // 2) + title + " " * (pad - pad // 2) + "|")
        print("+" + "-" * width + "+")
        print()
        print("  -- Model --")
        print(f"  Model:     {self.model}")
        print(f"  Base URL:  {self.base_url}")
        print(f"  API Key:   {api_key_display}")
        print()
        print("  -- Terminal --")
        print(f"  Environment:  {terminal_env}")
        if terminal_env == "ssh":
            ssh_host = os.getenv("TERMINAL_SSH_HOST", "not set")
            ssh_user = os.getenv("TERMINAL_SSH_USER", "not set")
            ssh_port = os.getenv("TERMINAL_SSH_PORT", "22")
            print(f"  SSH Target:   {ssh_user}@{ssh_host}:{ssh_port}")
        print(f"  Working Dir:  {terminal_cwd}")
        print(f"  Timeout:      {terminal_timeout}s")
        print()
        print("  -- Agent --")
        print(f"  Max Turns:  {self.max_turns}")
        print(f"  Toolsets:   {', '.join(self.enabled_toolsets) if self.enabled_toolsets else 'all'}")
        print(f"  Verbose:    {self.verbose}")
        print()
        print("  -- Session --")
        print(f"  Started:     {self.session_start.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"  Config File: {config_path} {config_status}")
        print()
    
    def _list_recent_sessions(self, limit: int = 10) -> list[dict[str, Any]]:
        """Return recent CLI sessions for in-chat browsing/resume affordances."""
        if not self._session_db:
            return []
        try:
            sessions = self._session_db.list_sessions_rich(
                source="cli",
                exclude_sources=["tool"],
                limit=limit,
                order_by_last_active=True,
            )
        except Exception:
            return []
        return [s for s in sessions if s.get("id") != self.session_id]

    def _show_recent_sessions(self, *, reason: str = "history", limit: int = 10) -> bool:
        """Render recent sessions inline from the active chat TUI.

        Returns True when something was shown, False if no session list was available.
        """
        sessions = self._list_recent_sessions(limit=limit)
        if not sessions:
            return False

        from fan_cli.main import _relative_time

        print()
        if reason == "history":
            print("(._.) No messages in the current chat yet — here are recent sessions you can resume:")
        else:
            print("  Recent sessions:")
        print()
        print(f"  {'#':<3} {'Title':<32} {'Preview':<40} {'Last Active':<13} {'ID'}")
        print(f"  {'─' * 3} {'─' * 32} {'─' * 40} {'─' * 13} {'─' * 24}")
        for idx, session in enumerate(sessions, start=1):
            title = session.get("title") or "—"
            preview = (session.get("preview") or "")[:38]
            last_active = _relative_time(session.get("last_active"))
            print(f"  {idx:<3} {title:<32} {preview:<40} {last_active:<13} {session['id']}")
        print()
        print("  Use /resume <number>, /resume <session id>, or /resume <session title> to continue.")
        print("  Example: /resume 2")
        print()
        return True

    def show_history(self):
        """Display conversation history."""
        if not self.conversation_history:
            if not self._show_recent_sessions(reason="history"):
                print("(._.) No conversation history yet.")
            return

        preview_limit = 400
        visible_index = 0
        hidden_tool_messages = 0

        def flush_tool_summary():
            nonlocal hidden_tool_messages
            if not hidden_tool_messages:
                return

            noun = "message" if hidden_tool_messages == 1 else "messages"
            print("\n  [Tools]")
            print(f"    ({hidden_tool_messages} tool {noun} hidden)")
            hidden_tool_messages = 0

        print()
        print("+" + "-" * 50 + "+")
        print("|" + " " * 12 + "(^_^) Conversation History" + " " * 11 + "|")
        print("+" + "-" * 50 + "+")

        for msg in self.conversation_history:
            role = msg.get("role", "unknown")

            if role == "tool":
                hidden_tool_messages += 1
                continue

            if role not in {"user", "assistant"}:
                continue

            flush_tool_summary()
            visible_index += 1

            content = msg.get("content")
            content_text = "" if content is None else str(content)

            if role == "user":
                print(f"\n  [You #{visible_index}]")
                print(
                    f"    {content_text[:preview_limit]}{'...' if len(content_text) > preview_limit else ''}"
                )
                continue

            print(f"\n  [Fan #{visible_index}]")
            tool_calls = msg.get("tool_calls") or []
            if content_text:
                preview = content_text[:preview_limit]
                suffix = "..." if len(content_text) > preview_limit else ""
            elif tool_calls:
                tool_count = len(tool_calls)
                noun = "call" if tool_count == 1 else "calls"
                preview = f"(requested {tool_count} tool {noun})"
                suffix = ""
            else:
                preview = "(no text response)"
                suffix = ""
            print(f"    {preview}{suffix}")

        flush_tool_summary()
        print()
    
    def _notify_session_boundary(self, event_type: str) -> None:
        """Fire a session-boundary plugin hook (on_session_finalize or on_session_reset).

        Non-blocking — errors are caught and logged.  Safe to call from any
        lifecycle point (shutdown, /new, /reset).
        """
        try:
            from fan_cli.plugins import invoke_hook as _invoke_hook
            _invoke_hook(
                event_type,
                session_id=self.agent.session_id if self.agent else None,
                platform=getattr(self, "platform", None) or "cli",
                reason="new_session" if event_type == "on_session_reset" else "session_boundary",
            )
        except Exception:
            pass

    def _discard_session_if_empty(self, session_id: Optional[str]) -> bool:
        """Drop a just-ended session row when it never gained content.

        Starting the CLI and immediately quitting (or rotating with /new,
        /clear) used to leave an empty untitled row behind that clutters
        ``/resume`` and ``fan sessions list``. Delegates the
        check-and-delete to ``SessionDB.delete_session_if_empty``, which
        only removes rows with no messages, no title, and no child
        sessions. Ported from google-gemini/gemini-cli#27770.
        """
        if not self._session_db or not session_id:
            return False
        try:
            from fan_constants import get_fan_home as _gfh
            return self._session_db.delete_session_if_empty(
                session_id, sessions_dir=_gfh() / "sessions"
            )
        except Exception:
            logger.debug(
                "Could not prune empty session %s", session_id, exc_info=True
            )
            return False

    def new_session(self, silent=False, title=None):
        """Start a fresh session with a new session ID and cleared agent state."""
        if self.agent and self.conversation_history:
            # Trigger memory extraction on the old session before session_id rotates.
            self.agent.commit_memory_session(self.conversation_history)
            self._notify_session_boundary("on_session_finalize")
        elif self.agent:
            # First session or empty history — still finalize the old session
            self._notify_session_boundary("on_session_finalize")

        old_session_id = self.session_id
        if self._session_db and old_session_id:
            # /new may rotate while the current turn still has messages that
            # have not reached the normal persistence boundary. Persist the
            # complete history against the old session before ending or
            # pruning it. Successfully written messages carry their durable
            # marker, so this remains idempotent with later flush attempts.
            if self.agent:
                try:
                    self.agent._flush_messages_to_session_db(
                        self.conversation_history
                    )
                except Exception as flush_error:
                    logger.warning(
                        "Could not flush session history before /new rotation: %s",
                        flush_error,
                    )
            try:
                self._session_db.end_session(old_session_id, "new_session")
            except Exception:
                pass
            # Don't let immediately-rotated empty sessions pile up in
            # /resume and `fan sessions list` (gemini-cli#27770 port).
            self._discard_session_if_empty(old_session_id)

        self.session_start = datetime.now()
        timestamp_str = self.session_start.strftime("%Y%m%d_%H%M%S")
        short_uuid = uuid.uuid4().hex[:6]
        self.session_id = f"{timestamp_str}_{short_uuid}"
        self.conversation_history = []
        self._pending_title = None
        self._resumed = False
        _sync_process_session_id(self.session_id)

        if self.agent:
            self.agent.session_id = self.session_id
            self.agent.session_start = self.session_start
            self.agent.reset_session_state()
            if hasattr(self.agent, "_last_flushed_db_idx"):
                self.agent._last_flushed_db_idx = 0
            if hasattr(self.agent, "_todo_store"):
                try:
                    from tools.todo_tool import TodoStore
                    self.agent._todo_store = TodoStore()
                except Exception:
                    pass
            if hasattr(self.agent, "_invalidate_system_prompt"):
                self.agent._invalidate_system_prompt()

            if self._session_db:
                try:
                    self.agent._session_db_created = False
                    self._session_db.create_session(
                        session_id=self.session_id,
                        source=os.environ.get("FAN_SESSION_SOURCE", "cli"),
                        model=self.model,
                        model_config={
                            "max_iterations": self.max_turns,
                            "reasoning_config": self.reasoning_config,
                        },
                    )
                    self.agent._session_db_created = True
                except Exception:
                    pass
                if title and self._session_db:
                    from fan_state import SessionDB
                    try:
                        sanitized = SessionDB.sanitize_title(title)
                    except ValueError as e:
                        _cprint(f"  Title rejected: {e}")
                        sanitized = None
                        title = None
                    if sanitized:
                        try:
                            self._session_db.set_session_title(self.session_id, sanitized)
                            self._pending_title = None
                            title = sanitized
                        except ValueError as e:
                            _cprint(f"  {e} — session started untitled.")
                            title = None
                        except Exception:
                            title = None
                    elif title is not None:
                        # sanitize_title returned empty (whitespace-only / unprintable)
                        _cprint("  Title is empty after cleanup — session started untitled.")
                        title = None
            # Notify memory providers that session_id rotated to a fresh
            # conversation. reset=True signals providers to flush accumulated
            # per-session state (_session_turns, _turn_counter, _document_id).
            # Fires BEFORE the plugin on_session_reset hook (shell hooks only
            # see the new id; Python providers see the transition). See #6672.
            try:
                _mm = getattr(self.agent, "_memory_manager", None)
                if _mm is not None:
                    _mm.on_session_switch(
                        self.session_id,
                        parent_session_id=old_session_id or "",
                        reset=True,
                        reason="new_session",
                    )
            except Exception:
                pass
            self._notify_session_boundary("on_session_reset")

        if not silent:
            if title:
                print(f"(^_^)v New session started: {title}")
            else:
                print("(^_^)v New session started!")

    def _handle_resume_command(self, cmd_original: str) -> None:
        """Handle /resume <session_id_or_title> — switch to a previous session mid-conversation."""
        parts = cmd_original.split(None, 1)
        target = parts[1].strip() if len(parts) > 1 else ""

        # Strip common outer brackets/quotes users may type literally from the
        # usage hint (e.g. ``/resume <abc123>`` or ``/resume [abc123]``).  The
        # `/resume` help text shows angle brackets as a placeholder and a few
        # users copy them through verbatim.  Stripping them keeps the lookup
        # working without changing the help string.
        if len(target) >= 2 and (
            (target[0] == "<" and target[-1] == ">")
            or (target[0] == "[" and target[-1] == "]")
            or (target[0] == '"' and target[-1] == '"')
            or (target[0] == "'" and target[-1] == "'")
        ):
            target = target[1:-1].strip()

        if not target:
            _cprint("  Usage: /resume <number|session_id_or_title>")
            if self._show_recent_sessions(reason="resume"):
                # Arm a one-shot pending-resume selection so the user can type
                # just the number (`3`) on the next line instead of having to
                # retype `/resume 3`. The list here must match the one shown by
                # _show_recent_sessions and used for index resolution below —
                # all three go through _list_recent_sessions(limit=10). See
                # #34584.
                self._pending_resume_sessions = self._list_recent_sessions(limit=10)
                return
            _cprint("  Tip:   Use /history to find sessions.")
            return

        # Any explicit /resume <target> supersedes a previously-armed bare
        # numbered prompt.
        self._pending_resume_sessions = None

        if not self._session_db:
            from fan_state import format_session_db_unavailable
            _cprint(f"  {format_session_db_unavailable()}")
            return

        # Resolve numbered selection, title, or ID
        if target.isdigit():
            sessions = self._list_recent_sessions(limit=10)
            index = int(target)
            if index < 1 or index > len(sessions):
                _cprint(f"  Resume index {index} is out of range.")
                _cprint("  Use /resume with no arguments to see available sessions.")
                return
            selected = sessions[index - 1]
            target_id = selected["id"]
        else:
            from fan_cli.main import _resolve_session_by_name_or_id
            resolved = _resolve_session_by_name_or_id(target)
            target_id = resolved or target

        session_meta = self._session_db.get_session(target_id)
        if not session_meta:
            _cprint(f"  Session not found: {target}")
            _cprint("  Use /history to see available sessions.")
            return

        # If the target is the empty head of a compression chain, redirect to
        # the descendant that actually holds the transcript. See #15000.
        try:
            resolved_id = self._session_db.resolve_resume_session_id(target_id)
        except Exception:
            resolved_id = target_id
        if resolved_id and resolved_id != target_id:
            _cprint(
                f"  Session {target_id} was compressed into {resolved_id}; "
                f"resuming the descendant with your transcript."
            )
            target_id = resolved_id
            resolved_meta = self._session_db.get_session(target_id)
            if resolved_meta:
                session_meta = resolved_meta

        if target_id == self.session_id:
            _cprint("  Already on that session.")
            return

        old_session_id = self.session_id
        # End current session
        try:
            self._session_db.end_session(self.session_id, "resumed_other")
        except Exception:
            pass

        # Switch to the target session
        self.session_id = target_id
        self._resumed = True
        self._pending_title = None
        _sync_process_session_id(target_id)

        # Load conversation history (strip transcript-only metadata entries)
        restored = self._session_db.get_messages_as_conversation(target_id)
        restored = [m for m in (restored or []) if m.get("role") != "session_meta"]
        self.conversation_history = restored

        # Re-open the target session so it's not marked as ended
        try:
            self._session_db.reopen_session(target_id)
        except Exception:
            pass

        # Sync the agent if already initialised
        if self.agent:
            self.agent.session_id = target_id
            self.agent.reset_session_state()
            if hasattr(self.agent, "_last_flushed_db_idx"):
                self.agent._last_flushed_db_idx = len(self.conversation_history)
            if hasattr(self.agent, "_todo_store"):
                try:
                    from tools.todo_tool import TodoStore
                    self.agent._todo_store = TodoStore()
                except Exception:
                    pass
            if hasattr(self.agent, "_invalidate_system_prompt"):
                self.agent._invalidate_system_prompt()

            # Notify memory providers that session_id rotated to a resumed
            # session. reset=False — the provider's accumulated state is
            # still valid; it just needs to target the new session_id for
            # subsequent writes. See #6672.
            try:
                _mm = getattr(self.agent, "_memory_manager", None)
                if _mm is not None:
                    _mm.on_session_switch(
                        target_id,
                        parent_session_id=old_session_id or "",
                        reset=False,
                        reason="resume",
                    )
            except Exception:
                pass

        title_part = f" \"{session_meta['title']}\"" if session_meta.get("title") else ""
        msg_count = len([m for m in self.conversation_history if m.get("role") == "user"])
        if self.conversation_history:
            _cprint(
                f"  ↻ Resumed session {target_id}{title_part}"
                f" ({msg_count} user message{'s' if msg_count != 1 else ''},"
                f" {len(self.conversation_history)} total)"
            )
            self._display_resumed_history()
        else:
            _cprint(f"  ↻ Resumed session {target_id}{title_part} — no messages, starting fresh.")


    def _handle_sessions_command(self, cmd_original: str) -> None:
        """Handle /sessions [list|<id_or_title>] — browse or resume previous sessions.

        Without arguments, prints the same recent-sessions table that /resume
        shows when called without a target, and tells the user how to resume.
        With an explicit subcommand or target, delegates to the resume flow so
        ``/sessions <id>`` and ``/resume <id>`` behave identically.

        The TUI ships an interactive picker overlay for this command; the
        classic CLI prints an inline list because there is no equivalent
        overlay primitive here. Without this handler the canonical name
        ``sessions`` falls through ``process_command``'s elif chain and
        prints ``Unknown command: sessions`` even though the command is
        registered in the central COMMAND_REGISTRY.
        """
        parts = cmd_original.split(None, 1)
        arg = parts[1].strip() if len(parts) > 1 else ""
        sub = arg.lower()

        # Bare /sessions or /sessions list — show recent sessions inline.
        if not arg or sub in {"list", "ls", "browse"}:
            if not self._session_db:
                from fan_state import format_session_db_unavailable
                _cprint(f"  {format_session_db_unavailable()}")
                return
            if not self._show_recent_sessions(reason="sessions"):
                _cprint("  (._.) No previous sessions yet.")
            return

        # /sessions <id_or_title> behaves the same as /resume <id_or_title>.
        self._handle_resume_command(f"/resume {arg}")

    def _handle_branch_command(self, cmd_original: str) -> None:
        """Handle /branch [name] — fork the current session into a new independent copy.

        Copies the full conversation history to a new session so the user can
        explore a different approach without losing the original session state.
        Inspired by Claude Code's /branch command.
        """
        if not self.conversation_history:
            _cprint("  No conversation to branch — send a message first.")
            return

        if not self._session_db:
            from fan_state import format_session_db_unavailable
            _cprint(f"  {format_session_db_unavailable()}")
            return

        parts = cmd_original.split(None, 1)
        branch_name = parts[1].strip() if len(parts) > 1 else ""

        # Generate the new session ID
        now = datetime.now()
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")
        short_uuid = uuid.uuid4().hex[:6]
        new_session_id = f"{timestamp_str}_{short_uuid}"

        # Determine branch title
        if branch_name:
            branch_title = branch_name
        else:
            # Auto-generate from the current session title
            current_title = None
            if self._session_db:
                current_title = self._session_db.get_session_title(self.session_id)
            base = current_title or "branch"
            branch_title = self._session_db.get_next_title_in_lineage(base)

        # Save the current session's state before branching
        parent_session_id = self.session_id

        # End the old session
        try:
            self._session_db.end_session(self.session_id, "branched")
        except Exception:
            pass

        # Create the new session with parent link.
        # Persist a stable ``_branched_from`` marker in model_config so
        # list_sessions_rich() can keep the branch visible in /resume and
        # /sessions even after the parent is reopened and re-ended with a
        # different end_reason (e.g. tui_shutdown overwriting 'branched').
        try:
            self._session_db.create_session(
                session_id=new_session_id,
                source=os.environ.get("FAN_SESSION_SOURCE", "cli"),
                model=self.model,
                model_config={
                    "max_iterations": self.max_turns,
                    "reasoning_config": self.reasoning_config,
                    "_branched_from": parent_session_id,
                },
                parent_session_id=parent_session_id,
            )
        except Exception as e:
            _cprint(f"  Failed to create branch session: {e}")
            return

        # Copy conversation history to the new session. Stamp each dict only
        # after its append commits so the agent's next flush skips successful
        # copies while retrying any transiently-failed row.
        from fan_state import (
            _DB_PERSISTED_MARKER,
            make_db_persisted_marker,
            sanitize_db_message_content,
        )

        branch_copy_failures = 0
        for msg_index, msg in enumerate(self.conversation_history):
            row = {
                "role": msg.get("role", "user"),
                "content": sanitize_db_message_content(msg.get("content")),
                "tool_name": msg.get("tool_name") or msg.get("name"),
                "tool_calls": msg.get("tool_calls"),
                "tool_call_id": msg.get("tool_call_id"),
                "finish_reason": msg.get("finish_reason"),
                "reasoning": msg.get("reasoning"),
                "reasoning_content": msg.get("reasoning_content"),
                "reasoning_details": msg.get("reasoning_details"),
                "codex_reasoning_items": msg.get("codex_reasoning_items"),
                "codex_message_items": msg.get("codex_message_items"),
            }
            try:
                self._session_db.append_message(
                    session_id=new_session_id,
                    **row,
                )
                if row["tool_name"] and not msg.get("tool_name"):
                    msg["tool_name"] = row["tool_name"]
                msg[_DB_PERSISTED_MARKER] = make_db_persisted_marker(
                    new_session_id, row
                )
            except Exception as exc:
                branch_copy_failures += 1
                logger.warning(
                    "Branch history copy failed at message %d for session=%s; "
                    "the next persistence point will retry it: %s",
                    msg_index,
                    new_session_id,
                    exc,
                )
        if branch_copy_failures:
            _cprint(
                f"  {branch_copy_failures} branch message(s) are pending "
                "persistence and will retry on the next turn."
            )

        # Set title on the branch
        try:
            self._session_db.set_session_title(new_session_id, branch_title)
        except Exception:
            pass

        # Switch to the new session
        self._transfer_session_yolo(self.session_id, new_session_id)
        self.session_id = new_session_id
        self.session_start = now
        self._pending_title = None
        self._resumed = True  # Prevents auto-title generation
        _sync_process_session_id(new_session_id)

        # Sync the agent
        if self.agent:
            self.agent.session_id = new_session_id
            self.agent.session_start = now
            self.agent.reset_session_state()
            if hasattr(self.agent, "_last_flushed_db_idx"):
                # Intrinsic per-message markers above, not a positional cursor,
                # are the only evidence that a branch copy committed.
                self.agent._last_flushed_db_idx = 0
            if hasattr(self.agent, "_todo_store"):
                try:
                    from tools.todo_tool import TodoStore
                    self.agent._todo_store = TodoStore()
                except Exception:
                    pass
            if hasattr(self.agent, "_invalidate_system_prompt"):
                self.agent._invalidate_system_prompt()

            # Notify memory providers that session_id forked to a new branch.
            # reset=False — the branched session carries the transcript
            # forward, so provider state tracks the lineage. parent_session_id
            # links the branch back to the original. See #6672.
            try:
                _mm = getattr(self.agent, "_memory_manager", None)
                if _mm is not None:
                    _mm.on_session_switch(
                        new_session_id,
                        parent_session_id=parent_session_id or "",
                        reset=False,
                        reason="branch",
                    )
            except Exception:
                pass

        msg_count = len([m for m in self.conversation_history if m.get("role") == "user"])
        _cprint(
            f"  ⑂ Branched session \"{branch_title}\""
            f" ({msg_count} user message{'s' if msg_count != 1 else ''})"
        )
        _cprint(f"  Original session: {parent_session_id}")
        _cprint(f"  Branch session:   {new_session_id}")

    def save_conversation(self):
        """Save the current conversation to a JSON snapshot under ~/.fan/sessions/saved/.

        The snapshot is a convenience export for sharing or off-line inspection;
        every message is already persisted incrementally to the SQLite session
        DB, so the live session remains resumable via ``fan --resume <id>``
        regardless of whether the user ever runs ``/save``.
        """
        if not self.conversation_history:
            print("(;_;) No conversation to save.")
            return

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        saved_dir = get_fan_home() / "sessions" / "saved"
        try:
            saved_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            print(f"(x_x) Failed to create save directory {saved_dir}: {e}")
            return
        path = saved_dir / f"fan_conversation_{timestamp}.json"

        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({
                    "model": self.model,
                    "session_id": self.session_id,
                    "session_start": self.session_start.isoformat(),
                    "messages": self.conversation_history,
                }, f, indent=2, ensure_ascii=False)
            print(f"(^_^)v Conversation snapshot saved to: {path}")
            if self.session_id:
                print(f"       Resume the live session with: fan --resume {self.session_id}")
        except Exception as e:
            print(f"(x_x) Failed to save: {e}")
    
    def retry_last(self):
        """Retry the last user message by removing the last exchange and re-sending.
        
        Removes the last assistant response (and any tool-call messages) and
        the last user message, then re-sends that user message to the agent.
        Returns the message to re-send, or None if there's nothing to retry.
        """
        if not self.conversation_history:
            print("(._.) No messages to retry.")
            return None
        
        # Walk backwards to find the last user message
        last_user_idx = None
        for i in range(len(self.conversation_history) - 1, -1, -1):
            if self.conversation_history[i].get("role") == "user":
                last_user_idx = i
                break
        
        if last_user_idx is None:
            print("(._.) No user message found to retry.")
            return None
        
        # Extract the message text and remove everything from that point forward
        last_message = self.conversation_history[last_user_idx].get("content", "")
        self.conversation_history = self.conversation_history[:last_user_idx]
        
        print(f"(^_^)b Retrying: \"{last_message[:60]}{'...' if len(last_message) > 60 else ''}\"")
        return last_message
    
    def undo_last(self, n: int = 1, prefill: bool = True):
        """Back up N user turns: truncate history, soft-delete on disk, prefill.

        Walks backwards N user messages and discards everything from the
        Nth-from-last user message onward (its assistant response, tool
        calls, etc.). ``n`` defaults to 1 (the last exchange); ``/undo 3``
        backs up three user turns. If ``n`` exceeds the number of user
        turns, it backs up to the oldest one.

        Beyond the in-memory ``conversation_history`` slice, this also:
          • soft-deletes the truncated rows in SessionDB (``active=0``) so
            they're hidden from re-prompts and search but kept for audit;
          • notifies memory providers via ``on_session_switch(rewound=True)``;
          • mirrors /branch's agent surgery (system-prompt invalidation +
            flush-index reset);
          • when ``prefill`` is set and an input buffer is available,
            pre-fills the composer with the backed-up message text so it
            can be edited and resubmitted.

        ``prefill=False`` is used by callers that drive the undo
        programmatically (e.g. checkpoint rollback) and don't want to
        touch the user's input buffer.
        """
        if not self.conversation_history:
            print("(._.) No messages to undo.")
            return

        if n < 1:
            n = 1

        # Walk backwards collecting the indices of the last N user messages.
        user_indices = []
        for i in range(len(self.conversation_history) - 1, -1, -1):
            if self.conversation_history[i].get("role") == "user":
                user_indices.append(i)
                if len(user_indices) >= n:
                    break

        if not user_indices:
            print("(._.) No user message found to undo.")
            return

        # The oldest of the collected user messages is our truncation point.
        cut_idx = user_indices[-1]
        turns_undone = len(user_indices)

        removed_count = len(self.conversation_history) - cut_idx
        removed_msg = self.conversation_history[cut_idx].get("content", "")
        removed_text = self._undo_content_to_text(removed_msg)

        # Truncate the in-memory history to before that user message.
        self.conversation_history = self.conversation_history[:cut_idx]

        # Soft-delete the truncated rows on disk so re-prompts and search
        # see the clean transcript while the rows survive for audit.
        rewound_rows = 0
        if self._session_db is not None and self.session_id:
            try:
                recents = self._session_db.list_recent_user_messages(
                    self.session_id, limit=max(turns_undone, 10)
                )
                if recents:
                    target_idx = min(turns_undone - 1, len(recents) - 1)
                    target_id = recents[target_idx]["id"]
                    result = self._session_db.rewind_to_message(
                        self.session_id, target_id
                    )
                    rewound_rows = result.get("rewound_count", 0)
                    # Prefer the DB's decoded target text for the prefill —
                    # it's the canonical persisted copy.
                    db_text = self._undo_content_to_text(
                        (result.get("target_message") or {}).get("content")
                    )
                    if db_text:
                        removed_text = db_text
            except ValueError as e:
                # Non-user target / cross-session — keep the in-memory undo
                # but skip the soft-delete; surface a debug-level note.
                logger.debug("undo: soft-delete skipped: %s", e)
            except Exception as e:
                logger.debug("undo: soft-delete failed: %s", e)

        # Agent surgery: invalidate the system-prompt cache and reset the
        # flush index so the next turn re-flushes from the truncated head.
        if self.agent is not None:
            if hasattr(self.agent, "_invalidate_system_prompt"):
                try:
                    self.agent._invalidate_system_prompt()
                except Exception:
                    pass
            if hasattr(self.agent, "_last_flushed_db_idx"):
                try:
                    self.agent._last_flushed_db_idx = len(self.conversation_history)
                except Exception:
                    pass
            # Notify memory providers — same hook /branch fires, with the
            # rewound flag so per-turn document caches invalidate (#6672, #21910).
            try:
                _mm = getattr(self.agent, "_memory_manager", None)
                if _mm is not None and self.session_id:
                    _mm.on_session_switch(
                        self.session_id,
                        parent_session_id="",
                        reset=False,
                        rewound=True,
                    )
            except Exception:
                pass

        turn_word = "turn" if turns_undone == 1 else "turns"
        msg_count = rewound_rows or removed_count
        print(
            f"(^_^)b Undid {turns_undone} {turn_word} ({msg_count} message(s)). "
            f"Backed up to: \"{removed_text[:60]}{'...' if len(removed_text) > 60 else ''}\""
        )
        remaining = len(self.conversation_history)
        print(f"  {remaining} message(s) remaining in history.")

        # Pre-fill the composer with the backed-up message so the user can
        # edit and resubmit (Claude-Code-style). Editable, not auto-sent.
        if prefill and removed_text:
            self._prefill_input_buffer(removed_text)

    @staticmethod
    def _undo_content_to_text(content) -> str:
        """Flatten message content (str or content-part list) to plain text."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [
                p.get("text", "")
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            return "\n".join(t for t in parts if t)
        return ""

    def _prefill_input_buffer(self, text: str) -> None:
        """Place ``text`` in the active prompt_toolkit buffer, editable."""
        app = getattr(self, "_app", None)
        if app is None:
            return
        try:
            buf = app.current_buffer
            buf.text = text
            if hasattr(buf, "cursor_position"):
                buf.cursor_position = len(text)
            app.invalidate()
        except Exception as e:
            logger.debug("undo: prefill buffer failed: %s", e)
    
    def _prompt_text_input(self, prompt_text: str) -> str | None:
        """Prompt for free-text input safely inside or outside prompt_toolkit.

        Uses a thread-aware guard: ``run_in_terminal``
        returns a coroutine that must be awaited by the prompt_toolkit event loop,
        which only exists on the main thread.  Slash commands are dispatched from
        the ``process_loop`` daemon thread (see issue #23185), so calling
        ``run_in_terminal`` from there orphans the coroutine — ``_ask`` never runs,
        and user keystrokes leak into the composer instead.  Fall back to a direct
        ``input()`` when we're off the main thread.
        """
        import threading
        result = [None]

        def _ask():
            try:
                result[0] = input(prompt_text).strip() or None
            except (KeyboardInterrupt, EOFError):
                pass

        in_main_thread = threading.current_thread() is threading.main_thread()

        if self._app and in_main_thread:
            from prompt_toolkit.application import run_in_terminal
            was_visible = self._status_bar_visible
            self._status_bar_visible = False
            self._app.invalidate()
            try:
                run_in_terminal(_ask)
            except Exception:
                # WSL / Warp / certain terminal emulators silently drop the
                # scheduled coroutine.  Fall back to a direct input() so the
                # user's keystrokes don't leak into the agent buffer.
                try:
                    _ask()
                except Exception:
                    pass
            finally:
                self._status_bar_visible = was_visible
                self._app.invalidate()
        else:
            _ask()
        return result[0]

    def _prompt_text_input_modal(
        self,
        *,
        title: str,
        detail: str,
        choices: list[tuple[str, str, str]],
        timeout: float = 120,
    ) -> str | None:
        """Prompt through the prompt_toolkit composer instead of raw input().

        This is for CLI slash-command confirmations.  The old raw input() path
        fought prompt_toolkit's active stdin ownership: in some terminals the
        prompt appeared above the TUI, choices were redrawn later, and Enter
        could be interpreted as EOF/exit.  A first-class modal state keeps the
        choices visible and lets the normal Enter key binding submit the typed
        or highlighted choice.

        **Platform note (Windows dead-lock — issue #30768):**
        The queue-based modal relies on prompt_toolkit key bindings receiving
        keyboard events and calling ``_submit_slash_confirm_response``.  On
        Windows (PowerShell / Windows Terminal) the prompt_toolkit input
        channel can become unresponsive when the modal is entered from the
        ``process_loop`` daemon thread, causing a dead-lock: the user sees the
        confirmation panel but keystrokes never reach the key bindings and the
        ``response_queue.get()`` blocks until the 120-second timeout expires.

        To avoid this, we fall back to ``_prompt_text_input`` (a simple
        ``input()``-based prompt) when any of these conditions hold:

        * ``sys.platform == "win32"`` — native Windows console (ConPTY /
          win32_input) does not support the modal reliably.
        * ``self._app`` is not set — unit tests / non-interactive contexts.

        On non-Windows platforms the modal itself is still safe from the
        ``process_loop`` daemon thread as long as the main-thread event loop
        owns the prompt_toolkit buffer mutations.  When we are off the main
        thread, schedule the modal snapshot / restore work on ``self._app.loop``
        via ``call_soon_threadsafe`` and keep the queue-based response path.
        """
        import threading
        import time as _time

        if not choices:
            return None

        # If prompt_toolkit is not running (unit tests / non-interactive calls),
        # keep the simple stdin fallback.
        if not getattr(self, "_app", None):
            return self._prompt_text_input("Choice [1/2/3]: ")

        # On Windows the prompt_toolkit input channel can deadlock when the
        # modal is entered from the process_loop daemon thread — keystrokes
        # never reach the key bindings, so response_queue.get() blocks for
        # the full timeout (issue #30768).  Fall back to the simpler
        # stdin-based prompt which works reliably on Windows.
        if sys.platform == "win32":
            return self._prompt_text_input("Choice [1/2/3]: ")

        try:
            app_loop = self._app.loop
        except Exception:
            app_loop = None

        in_main_thread = threading.current_thread() is threading.main_thread()
        if not in_main_thread and app_loop is None:
            return self._prompt_text_input("Choice [1/2/3]: ")

        response_queue = queue.Queue()

        def _setup_modal() -> None:
            self._capture_modal_input_snapshot()
            self._slash_confirm_state = {
                "title": title,
                "detail": detail,
                "choices": choices,
                "selected": 0,
                "response_queue": response_queue,
            }
            self._slash_confirm_deadline = _time.monotonic() + timeout
            self._invalidate()

        def _teardown_modal() -> None:
            self._slash_confirm_state = None
            self._slash_confirm_deadline = 0
            self._restore_modal_input_snapshot()
            self._invalidate()

        def _run_on_app_loop(fn) -> bool:
            if in_main_thread or app_loop is None:
                fn()
                return True
            ready = threading.Event()

            def _wrapped() -> None:
                try:
                    fn()
                finally:
                    ready.set()

            try:
                app_loop.call_soon_threadsafe(_wrapped)
            except Exception:
                return False
            return ready.wait(timeout=5)

        if not _run_on_app_loop(_setup_modal):
            return self._prompt_text_input("Choice [1/2/3]: ")

        _last_countdown_refresh = _time.monotonic()
        try:
            while True:
                try:
                    result = response_queue.get(timeout=1)
                    _run_on_app_loop(_teardown_modal)
                    return result
                except queue.Empty:
                    remaining = self._slash_confirm_deadline - _time.monotonic()
                    if remaining <= 0:
                        break
                    now = _time.monotonic()
                    if now - _last_countdown_refresh >= 5.0:
                        _last_countdown_refresh = now
                        self._invalidate()
        finally:
            if self._slash_confirm_state is not None:
                _run_on_app_loop(_teardown_modal)
        return None


    def _normalize_slash_confirm_choice(
        self,
        raw: str | None,
        choices: list[tuple[str, str, str]],
    ) -> str | None:
        if raw is None:
            return None
        choice_raw = raw.strip().lower()
        if not choice_raw:
            return None
        aliases = {
            "1": "once",
            "once": "once",
            "approve": "once",
            "yes": "once",
            "y": "once",
            "ok": "once",
            "2": "always",
            "always": "always",
            "remember": "always",
            "3": "cancel",
            "cancel": "cancel",
            "nevermind": "cancel",
            "no": "cancel",
            "n": "cancel",
        }
        allowed = {choice[0] for choice in choices}
        normalized = aliases.get(choice_raw)
        if normalized in allowed:
            return normalized
        if choice_raw in allowed:
            return choice_raw
        return None



    def _output_console(self):
        """Use prompt_toolkit-safe Rich rendering once the TUI is live."""
        if getattr(self, "_app", None):
            return ChatConsole()
        return self.console

    def _console_print(self, *args, **kwargs):
        """Print through the active command-safe console."""
        self._output_console().print(*args, **kwargs)

    @staticmethod
    def _resolve_personality_prompt(value) -> str:
        """Accept string or dict personality value; return system prompt string."""
        if isinstance(value, dict):
            parts = [value.get("system_prompt", "")]
            if value.get("tone"):
                parts.append(f'Tone: {value["tone"]}' )
            if value.get("style"):
                parts.append(f'Style: {value["style"]}' )
            return "\n".join(p for p in parts if p)
        return str(value)

    def _handle_personality_command(self, cmd: str):
        """Handle the /personality command to set predefined personalities."""
        parts = cmd.split(maxsplit=1)
        
        if len(parts) > 1:
            # Set personality
            personality_name = parts[1].strip().lower()
            
            if personality_name in {"none", "default", "neutral"}:
                self.system_prompt = ""
                self.agent = None  # Force re-init
                if save_config_value("agent.system_prompt", ""):
                    print("(^_^)b Personality cleared (saved to config)")
                else:
                    print("(^_^) Personality cleared (session only)")
                print("  No personality overlay — using base agent behavior.")
            elif personality_name in self.personalities:
                self.system_prompt = self._resolve_personality_prompt(self.personalities[personality_name])
                self.agent = None  # Force re-init
                if save_config_value("agent.system_prompt", self.system_prompt):
                    print(f"(^_^)b Personality set to '{personality_name}' (saved to config)")
                else:
                    print(f"(^_^) Personality set to '{personality_name}' (session only)")
                print(f"  \"{self.system_prompt[:60]}{'...' if len(self.system_prompt) > 60 else ''}\"")
            else:
                print(f"(._.) Unknown personality: {personality_name}")
                print(f"  Available: none, {', '.join(self.personalities.keys())}")
        else:
            # Show available personalities
            print()
            print("+" + "-" * 50 + "+")
            print("|" + " " * 12 + "(^o^)/ Personalities" + " " * 15 + "|")
            print("+" + "-" * 50 + "+")
            print()
            print(f"  {'none':<12} - (no personality overlay)")
            for name, prompt in self.personalities.items():
                if isinstance(prompt, dict):
                    preview = prompt.get("description") or prompt.get("system_prompt", "")[:50]
                else:
                    preview = str(prompt)[:50]
                print(f"  {name:<12} - {preview}")
            print()
            print("  Usage: /personality <name>")
            print()
    
    def _handle_cron_command(self, cmd: str):
        """Handle the /cron command to manage scheduled tasks."""
        import shlex
        from tools.cronjob_tools import cronjob as cronjob_tool

        def _cron_api(**kwargs):
            return json.loads(cronjob_tool(**kwargs))

        def _normalize_skills(values):
            normalized = []
            for value in values:
                text = str(value or "").strip()
                if text and text not in normalized:
                    normalized.append(text)
            return normalized

        def _parse_flags(tokens):
            opts = {
                "name": None,
                "repeat": None,
                "skills": [],
                "add_skills": [],
                "remove_skills": [],
                "clear_skills": False,
                "all": False,
                "prompt": None,
                "schedule": None,
                "positionals": [],
            }
            i = 0
            while i < len(tokens):
                token = tokens[i]
                if token == "--name" and i + 1 < len(tokens):
                    opts["name"] = tokens[i + 1]
                    i += 2
                elif token == "--repeat" and i + 1 < len(tokens):
                    try:
                        opts["repeat"] = int(tokens[i + 1])
                    except ValueError:
                        print("(._.) --repeat must be an integer")
                        return None
                    i += 2
                elif token == "--skill" and i + 1 < len(tokens):
                    opts["skills"].append(tokens[i + 1])
                    i += 2
                elif token == "--add-skill" and i + 1 < len(tokens):
                    opts["add_skills"].append(tokens[i + 1])
                    i += 2
                elif token == "--remove-skill" and i + 1 < len(tokens):
                    opts["remove_skills"].append(tokens[i + 1])
                    i += 2
                elif token == "--clear-skills":
                    opts["clear_skills"] = True
                    i += 1
                elif token == "--all":
                    opts["all"] = True
                    i += 1
                elif token == "--prompt" and i + 1 < len(tokens):
                    opts["prompt"] = tokens[i + 1]
                    i += 2
                elif token == "--schedule" and i + 1 < len(tokens):
                    opts["schedule"] = tokens[i + 1]
                    i += 2
                else:
                    opts["positionals"].append(token)
                    i += 1
            return opts

        tokens = shlex.split(cmd)

        if len(tokens) == 1:
            print()
            print("+" + "-" * 68 + "+")
            print("|" + " " * 22 + "(^_^) Scheduled Tasks" + " " * 23 + "|")
            print("+" + "-" * 68 + "+")
            print()
            print("  Commands:")
            print("    /cron list")
            print('    /cron add "every 2h" "Check server status" [--skill blogwatcher]')
            print('    /cron edit <job_id> --schedule "every 4h" --prompt "New task"')
            print("    /cron edit <job_id> --skill blogwatcher --skill maps")
            print("    /cron edit <job_id> --remove-skill blogwatcher")
            print("    /cron edit <job_id> --clear-skills")
            print("    /cron pause <job_id>")
            print("    /cron resume <job_id>")
            print("    /cron run <job_id>")
            print("    /cron remove <job_id>")
            print()
            result = _cron_api(action="list")
            jobs = result.get("jobs", []) if result.get("success") else []
            if jobs:
                print("  Current Jobs:")
                print("  " + "-" * 63)
                for job in jobs:
                    repeat_str = job.get("repeat", "?")
                    print(f"    {job['job_id'][:12]:<12} | {job['schedule']:<15} | {repeat_str:<8}")
                    if job.get("skills"):
                        print(f"      Skills: {', '.join(job['skills'])}")
                    print(f"      {job.get('prompt_preview', '')}")
                    if job.get("next_run_at"):
                        print(f"      Next: {job['next_run_at']}")
                    print()
            else:
                print("  No scheduled jobs. Use '/cron add' to create one.")
            print()
            return

        subcommand = tokens[1].lower()
        opts = _parse_flags(tokens[2:])
        if opts is None:
            return

        if subcommand == "list":
            result = _cron_api(action="list", include_disabled=opts["all"])
            jobs = result.get("jobs", []) if result.get("success") else []
            if not jobs:
                print("(._.) No scheduled jobs.")
                return

            print()
            print("Scheduled Jobs:")
            print("-" * 80)
            for job in jobs:
                print(f"  ID: {job['job_id']}")
                print(f"  Name: {job['name']}")
                print(f"  State: {job.get('state', '?')}")
                print(f"  Schedule: {job['schedule']} ({job.get('repeat', '?')})")
                print(f"  Next run: {job.get('next_run_at', 'N/A')}")
                if job.get("skills"):
                    print(f"  Skills: {', '.join(job['skills'])}")
                print(f"  Prompt: {job.get('prompt_preview', '')}")
                if job.get("last_run_at"):
                    print(f"  Last run: {job['last_run_at']} ({job.get('last_status', '?')})")
                print()
            return

        if subcommand in {"add", "create"}:
            positionals = opts["positionals"]
            if not positionals:
                print("(._.) Usage: /cron add <schedule> <prompt>")
                return
            schedule = opts["schedule"] or positionals[0]
            prompt = opts["prompt"] or " ".join(positionals[1:])
            skills = _normalize_skills(opts["skills"])
            if not prompt and not skills:
                print("(._.) Please provide a prompt or at least one skill")
                return
            result = _cron_api(
                action="create",
                schedule=schedule,
                prompt=prompt or None,
                name=opts["name"],
                repeat=opts["repeat"],
                skills=skills or None,
            )
            if result.get("success"):
                print(f"(^_^)b Created job: {result['job_id']}")
                print(f"  Schedule: {result['schedule']}")
                if result.get("skills"):
                    print(f"  Skills: {', '.join(result['skills'])}")
                print(f"  Next run: {result['next_run_at']}")
            else:
                print(f"(x_x) Failed to create job: {result.get('error')}")
            return

        if subcommand == "edit":
            positionals = opts["positionals"]
            if not positionals:
                print("(._.) Usage: /cron edit <job_id> [--schedule ...] [--prompt ...] [--skill ...]")
                return
            job_id = positionals[0]
            existing = get_job(job_id)
            if not existing:
                print(f"(._.) Job not found: {job_id}")
                return

            final_skills = None
            replacement_skills = _normalize_skills(opts["skills"])
            add_skills = _normalize_skills(opts["add_skills"])
            remove_skills = set(_normalize_skills(opts["remove_skills"]))
            existing_skills = list(existing.get("skills") or ([] if not existing.get("skill") else [existing.get("skill")]))
            if opts["clear_skills"]:
                final_skills = []
            elif replacement_skills:
                final_skills = replacement_skills
            elif add_skills or remove_skills:
                final_skills = [skill for skill in existing_skills if skill not in remove_skills]
                for skill in add_skills:
                    if skill not in final_skills:
                        final_skills.append(skill)

            result = _cron_api(
                action="update",
                job_id=job_id,
                schedule=opts["schedule"],
                prompt=opts["prompt"],
                name=opts["name"],
                repeat=opts["repeat"],
                skills=final_skills,
            )
            if result.get("success"):
                job = result["job"]
                print(f"(^_^)b Updated job: {job['job_id']}")
                print(f"  Schedule: {job['schedule']}")
                if job.get("skills"):
                    print(f"  Skills: {', '.join(job['skills'])}")
                else:
                    print("  Skills: none")
            else:
                print(f"(x_x) Failed to update job: {result.get('error')}")
            return

        if subcommand in {"pause", "resume", "run", "remove", "rm", "delete"}:
            positionals = opts["positionals"]
            if not positionals:
                print(f"(._.) Usage: /cron {subcommand} <job_id>")
                return
            job_id = positionals[0]
            action = "remove" if subcommand in {"remove", "rm", "delete"} else subcommand
            result = _cron_api(action=action, job_id=job_id, reason="paused from /cron" if action == "pause" else None)
            if not result.get("success"):
                print(f"(x_x) Failed to {action} job: {result.get('error')}")
                return
            if action == "pause":
                print(f"(^_^)b Paused job: {result['job']['name']} ({job_id})")
            elif action == "resume":
                print(f"(^_^)b Resumed job: {result['job']['name']} ({job_id})")
                print(f"  Next run: {result['job'].get('next_run_at')}")
            elif action == "run":
                print(f"(^_^)b Triggered job: {result['job']['name']} ({job_id})")
                print("  It will run on the next scheduler tick.")
            else:
                removed = result.get("removed_job", {})
                print(f"(^_^)b Removed job: {removed.get('name', job_id)} ({job_id})")
            return

        print(f"(._.) Unknown cron command: {subcommand}")
        print("  Available: list, add, edit, pause, resume, run, remove")

    def _handle_curator_command(self, cmd: str):
        """Handle /curator slash command.

        Delegates to fan_cli.curator so the CLI and the `fan curator`
        subcommand share the same handler set.
        """
        import shlex

        tokens = shlex.split(cmd)[1:] if cmd else []
        if not tokens:
            tokens = ["status"]

        try:
            from fan_cli.curator import cli_main
            cli_main(tokens)
        except SystemExit:
            # argparse calls sys.exit() on --help or errors; swallow so we
            # don't kill the interactive session.
            pass
        except Exception as exc:
            print(f"(._.) curator: {exc}")

    def _handle_kanban_command(self, cmd: str):
        """Handle the /kanban command — delegate to the shared kanban CLI.

        The string form passed here is the user's full ``/kanban ...``
        including the leading slash; we strip it and hand the remainder
        to ``kanban.run_slash`` which returns a single formatted string.
        """
        from fan_cli.kanban import run_slash

        rest = cmd.strip()
        if rest.startswith("/"):
            rest = rest.lstrip("/")
        if rest.startswith("kanban"):
            rest = rest[len("kanban"):].lstrip()
        try:
            output = run_slash(rest)
        except Exception as exc:  # pragma: no cover - defensive
            output = f"(._.) kanban error: {exc}"
        if output:
            print(output)

    def _handle_skills_command(self, cmd: str):
        """Handle local skill write-approval review commands."""
        parts = cmd.strip().split()
        args = parts[1:] if len(parts) > 1 else []
        if args and args[0].lower() in {"pending", "approve", "apply", "reject",
                                        "deny", "drop", "diff", "mode"}:
            from fan_cli.write_approval_commands import handle_pending_subcommand
            from tools import write_approval as wa
            out = handle_pending_subcommand(
                wa.SKILLS, args,
                set_mode_fn=lambda m: self._save_write_mode("skills", m),
            )
            if out is not None:
                print(out)
                return
        print(
            "Use /skills pending, approve <id>, reject <id>, diff <id>, or "
            "mode <on|off|approve>. Manage installed skills in Settings → Skills."
        )

    def _handle_memory_command(self, cmd: str):
        """Handle /memory slash command — pending review + write-mode control."""
        from fan_cli.write_approval_commands import handle_pending_subcommand
        from tools import write_approval as wa
        parts = cmd.strip().split()
        args = parts[1:] if len(parts) > 1 else []
        store = getattr(self.agent, "_memory_store", None) if getattr(self, "agent", None) else None
        if store is None:
            from tools.memory_tool import load_on_disk_store

            store = load_on_disk_store()
        out = handle_pending_subcommand(
            wa.MEMORY, args,
            memory_store=store,
            set_mode_fn=lambda m: self._save_write_mode("memory", m),
        )
        if out is None:
            out = ("Unknown /memory subcommand. "
                   "Use: pending, approve <id>, reject <id>, mode <on|off|approve>.")
        print(out)

    def _save_write_mode(self, subsystem: str, mode: str):
        """Persist <subsystem>.write_mode to config (for /memory|/skills mode)."""
        save_config_value(f"{subsystem}.write_mode", mode)

    def process_command(self, command: str) -> bool:
        """
        Process a slash command.
        
        Args:
            command: The command string (starting with /)
            
        Returns:
            bool: True to continue, False to exit
        """
        # Lowercase only for dispatch matching; preserve original case for arguments
        cmd_lower = command.lower().strip()
        cmd_original = command.strip()

        # Resolve aliases via central registry so adding an alias is a one-line
        # change in fan_cli/commands.py instead of touching every dispatch site.
        from fan_cli.commands import resolve_command as _resolve_cmd
        _base_word = cmd_lower.split()[0].lstrip("/")
        _cmd_def = _resolve_cmd(_base_word)
        canonical = _cmd_def.name if _cmd_def else _base_word

        # A bare `/resume` prompt is one-shot: any command other than the
        # resume/sessions handlers (which manage the pending state themselves)
        # disarms it so a later number isn't swallowed as a stale selection.
        # See #34584.
        if canonical not in {"resume", "sessions"}:
            self._pending_resume_sessions = None

        if canonical in {"quit", "exit"}:
            # Parse --delete flag: /exit --delete also removes the current
            # session's transcripts + SQLite history. Ported from
            # google-gemini/gemini-cli#19332.
            _rest = cmd_original.split(None, 1)
            _args = (_rest[1] if len(_rest) > 1 else "").strip().lower()
            if _args in {"--delete", "-d"}:
                self._delete_session_on_exit = True
            elif _args:
                _cprint(f"  {_DIM}✗ Unknown argument: {_escape(_args)}. Use /exit --delete to also remove session history.{_RST}")
                return True
            return False
        elif canonical == "help":
            self.show_help()
        elif canonical == "tools":
            self._handle_tools_command(cmd_original)
        elif canonical == "toolsets":
            self.show_toolsets()
        elif canonical == "config":
            self.show_config()
        elif canonical == "redraw":
            # Manual recovery for terminal buffer drift from multiplexer
            # tab switches, subshell ``clear``, SSH window restores, etc.
            # See issue #8688 (cmux). Ctrl+L is bound to the same helper.
            self._force_full_redraw()
            _cprint(f"  {_DIM}✓ UI redrawn{_RST}")
        elif canonical == "clear":
            if self._confirm_destructive_slash(
                "clear",
                "This clears the screen and starts a new session.\n"
                "The current conversation history will be discarded.",
                cmd_original=cmd_original,
            ) is None:
                return True  # confirmation cancelled — command handled, keep REPL alive
            self.new_session(silent=True)
            _clear_output_history()
            # Clear terminal screen.  Inside the TUI, Rich's console.clear()
            # goes through patch_stdout's StdoutProxy which swallows the
            # screen-clear escape sequences.  Use prompt_toolkit's output
            # object directly to actually clear the terminal.
            if self._app:
                out = self._app.output
                out.erase_screen()
                out.cursor_goto(0, 0)
                out.flush()
            else:
                self.console.clear()
            # Show fresh banner.  Inside the TUI we must route Rich output
            # through ChatConsole (which uses prompt_toolkit's native ANSI
            # renderer) instead of self.console (which writes raw to stdout
            # and gets mangled by patch_stdout).
            if self._app:
                cc = ChatConsole()
                term_w = shutil.get_terminal_size().columns
                if self.compact or term_w < 80:
                    cc.print(_build_compact_banner())
                else:
                    tools = get_tool_definitions(enabled_toolsets=self.enabled_toolsets, quiet_mode=True)
                    cwd = os.getenv("TERMINAL_CWD", os.getcwd())
                    ctx_len = None
                    if hasattr(self, 'agent') and self.agent and hasattr(self.agent, 'context_compressor'):
                        ctx_len = self.agent.context_compressor.context_length
                    build_welcome_banner(
                        console=cc,
                        model=self.model,
                        cwd=cwd,
                        tools=tools,
                        enabled_toolsets=self.enabled_toolsets,
                        session_id=self.session_id,
                        context_length=ctx_len,
                    )
                _cprint("  ✨ (◕‿◕)✨ Fresh start! Screen cleared and conversation reset.\n")
                # Show a random tip on new session
                try:
                    from fan_cli.tips import get_random_tip
                    _tip = get_random_tip()
                    try:
                        from fan_cli.skin_engine import get_active_skin
                        _tip_color = get_active_skin().get_color("banner_dim", "#B8860B")
                    except Exception:
                        _tip_color = "#B8860B"
                    cc.print(f"[dim {_tip_color}]✦ Tip: {_tip}[/]")
                except Exception:
                    pass
            else:
                self.show_banner()
                print("  ✨ (◕‿◕)✨ Fresh start! Screen cleared and conversation reset.\n")
                # Show a random tip on new session
                try:
                    from fan_cli.tips import get_random_tip
                    _tip = get_random_tip()
                    try:
                        from fan_cli.skin_engine import get_active_skin
                        _tip_color = get_active_skin().get_color("banner_dim", "#B8860B")
                    except Exception:
                        _tip_color = "#B8860B"
                    self._console_print(f"[dim {_tip_color}]✦ Tip: {_tip}[/]")
                except Exception:
                    pass
        elif canonical == "history":
            self.show_history()
        elif canonical == "title":
            parts = cmd_original.split(maxsplit=1)
            if len(parts) > 1:
                raw_title = parts[1].strip()
                if raw_title:
                    if self._session_db:
                        # Sanitize the title early so feedback matches what gets stored
                        try:
                            from fan_state import SessionDB
                            new_title = SessionDB.sanitize_title(raw_title)
                        except ValueError as e:
                            _cprint(f"  {e}")
                            new_title = None
                        if not new_title:
                            _cprint("  Title is empty after cleanup. Please use printable characters.")
                        elif self._session_db.get_session(self.session_id):
                            # Session exists in DB — set title directly
                            try:
                                if self._session_db.set_session_title(self.session_id, new_title):
                                    _cprint(f"  Session title set: {new_title}")
                                else:
                                    _cprint("  Session not found in database.")
                            except ValueError as e:
                                _cprint(f"  {e}")
                        else:
                            # Session not created yet — defer the title
                            # Check uniqueness proactively with the sanitized title
                            existing = self._session_db.get_session_by_title(new_title)
                            if existing:
                                _cprint(f"  Title '{new_title}' is already in use by session {existing['id']}")
                            else:
                                self._pending_title = new_title
                                _cprint(f"  Session title queued: {new_title} (will be saved on first message)")
                    else:
                        from fan_state import format_session_db_unavailable
                        _cprint(f"  {format_session_db_unavailable()}")
                else:
                    _cprint("  Usage: /title <your session title>")
            # Show current title and session ID if no argument given
            elif self._session_db:
                _cprint(f"  Session ID: {self.session_id}")
                session = self._session_db.get_session(self.session_id)
                if session and session.get("title"):
                    _cprint(f"  Title: {session['title']}")
                elif self._pending_title:
                    _cprint(f"  Title (pending): {self._pending_title}")
                else:
                    _cprint("  No title set. Usage: /title <your session title>")
            else:
                from fan_state import format_session_db_unavailable
                _cprint(f"  {format_session_db_unavailable()}")
        elif canonical == "new":
            # Strip inline-skip tokens (now/--yes/-y) before deriving the title
            # so "/new now My Session" yields title="My Session" instead of
            # title="now My Session". See _split_destructive_skip.
            _new_args, _ = self._split_destructive_skip(cmd_original)
            title = _new_args.strip() or None
            if self._confirm_destructive_slash(
                "new",
                "This starts a fresh session.\n"
                "The current conversation history will be discarded.",
                cmd_original=cmd_original,
            ) is None:
                return True  # confirmation cancelled — command handled, keep REPL alive
            self.new_session(title=title)
        elif canonical == "resume":
            self._handle_resume_command(cmd_original)
        elif canonical == "sessions":
            self._handle_sessions_command(cmd_original)

        elif canonical == "personality":
            # Use original case (handler lowercases the personality name itself)
            self._handle_personality_command(cmd_original)
        elif canonical == "retry":
            retry_msg = self.retry_last()
            if retry_msg and hasattr(self, '_pending_input'):
                # Re-queue the message so process_loop sends it to the agent
                self._pending_input.put(retry_msg)
        elif canonical == "undo":
            # Parse optional turn count: "/undo" → 1, "/undo 3" → 3.
            _undo_n = 1
            _undo_parts = cmd_original.split()
            if len(_undo_parts) > 1:
                try:
                    _undo_n = int(_undo_parts[1])
                except ValueError:
                    print(f"(._.) Invalid count {_undo_parts[1]!r} — use /undo or /undo N.")
                    return
                if _undo_n < 1:
                    _undo_n = 1
            _undo_desc = (
                "This removes the last user/assistant exchange from history."
                if _undo_n == 1
                else f"This removes the last {_undo_n} user turns from history."
            )
            if self._confirm_destructive_slash(
                "undo",
                _undo_desc,
                cmd_original=cmd_original,
            ) is None:
                return True  # confirmation cancelled — command handled, keep REPL alive
            self.undo_last(_undo_n)
        elif canonical == "branch":
            self._handle_branch_command(cmd_original)
        elif canonical == "save":
            self.save_conversation()
        elif canonical == "cron":
            self._handle_cron_command(cmd_original)
        elif canonical == "curator":
            self._handle_curator_command(cmd_original)
        elif canonical == "kanban":
            self._handle_kanban_command(cmd_original)
        elif canonical == "skills":
            self._handle_skills_command(cmd_original)
        elif canonical == "memory":
            self._handle_memory_command(cmd_original)
        elif canonical == "status":
            self._show_session_status()
        elif canonical == "statusbar":
            self._status_bar_visible = not self._status_bar_visible
            state = "visible" if self._status_bar_visible else "hidden"
            self._console_print(f"  Status bar {state}")
        elif canonical == "verbose":
            self._toggle_verbose()
        elif canonical == "footer":
            self._handle_footer_command(cmd_original)
        elif canonical == "yolo":
            self._toggle_yolo()
        elif canonical == "reasoning":
            self._handle_reasoning_command(cmd_original)
        elif canonical == "compress":
            self._manual_compress(cmd_original)
        elif canonical == "usage":
            self._show_usage()
        elif canonical == "insights":
            self._show_insights(cmd_original)
        elif canonical == "copy":
            self._handle_copy_command(cmd_original)
        elif canonical == "debug":
            self._handle_debug_command()
        elif canonical == "paste":
            self._handle_paste_command()
        elif canonical == "image":
            self._handle_image_command(cmd_original)
        elif canonical == "reload":
            from fan_cli.config import reload_env
            count = reload_env()
            print(f"  Reloaded .env ({count} var(s) updated)")
        elif canonical == "reload-mcp":
            # Interactive reload: confirm first (unless the user has opted out).
            # The auto-reload path (file watcher) calls _reload_mcp directly
            # without this confirmation.
            self._confirm_and_reload_mcp(cmd_original)
        elif canonical == "reload-skills":
            with self._busy_command(self._slow_command_status(cmd_original)):
                self._reload_skills()
        elif canonical == "bundles":
            self._handle_bundles_command(cmd_original)
        elif canonical == "plugins":
            try:
                from fan_cli.plugins import get_plugin_manager
                mgr = get_plugin_manager()
                plugins = mgr.list_plugins()
                if not plugins:
                    print("No plugins installed.")
                    print(f"Drop plugin directories into {display_fan_home()}/plugins/ to get started.")
                else:
                    print(f"Plugins ({len(plugins)}):")
                    for p in plugins:
                        status = "✓" if p["enabled"] else "✗"
                        version = f" v{p['version']}" if p["version"] else ""
                        tools = f"{p['tools']} tools" if p["tools"] else ""
                        hooks = f"{p['hooks']} hooks" if p["hooks"] else ""
                        commands = f"{p['commands']} commands" if p.get("commands") else ""
                        parts = [x for x in [tools, hooks, commands] if x]
                        detail = f" ({', '.join(parts)})" if parts else ""
                        error = f" — {p['error']}" if p["error"] else ""
                        print(f"  {status} {p['name']}{version}{detail}{error}")
            except Exception as e:
                print(f"Plugin system error: {e}")
        elif canonical == "rollback":
            self._handle_rollback_command(cmd_original)
        elif canonical == "stop":
            self._handle_stop_command()
        elif canonical == "agents":
            self._handle_agents_command()
        elif canonical == "background":
            self._handle_background_command(cmd_original)
        elif canonical == "queue":
            # Extract prompt after "/queue " or "/q "
            parts = cmd_original.split(None, 1)
            payload = parts[1].strip() if len(parts) > 1 else ""
            if not payload:
                _cprint("  Usage: /queue <prompt>")
            else:
                self._pending_input.put(payload)
                if self._agent_running:
                    _cprint(f"  Queued for the next turn: {payload[:80]}{'...' if len(payload) > 80 else ''}")
                else:
                    _cprint(f"  Queued: {payload[:80]}{'...' if len(payload) > 80 else ''}")
        elif canonical == "steer":
            # Inject a message after the next tool call without interrupting.
            # If the agent is actively running, push the text into the agent's
            # pending_steer slot — the drain hook in _execute_tool_calls_*
            # will append it to the next tool result's content. If no agent
            # is running, fall back to queue semantics (same as /queue).
            parts = cmd_original.split(None, 1)
            payload = parts[1].strip() if len(parts) > 1 else ""
            if not payload:
                _cprint("  Usage: /steer <prompt>")
            elif self._agent_running and self.agent is not None and hasattr(self.agent, "steer"):
                try:
                    accepted = self.agent.steer(payload)
                except Exception as exc:
                    _cprint(f"  Steer failed: {exc}")
                else:
                    if accepted:
                        _cprint(f"  ⏩ Steer queued — arrives after the next tool call: {payload[:80]}{'...' if len(payload) > 80 else ''}")
                    else:
                        _cprint("  Steer rejected (empty payload).")
            else:
                # No active run — treat as a normal next-turn message.
                self._pending_input.put(payload)
                _cprint(f"  No agent running; queued as next turn: {payload[:80]}{'...' if len(payload) > 80 else ''}")
        elif canonical == "goal":
            self._handle_goal_command(cmd_original)
        elif canonical == "subgoal":
            self._handle_subgoal_command(cmd_original)
        elif canonical == "skin":
            self._handle_skin_command(cmd_original)
        elif canonical == "busy":
            self._handle_busy_command(cmd_original)
        else:
            # Check for user-defined quick commands (bypass agent loop, no LLM call)
            base_cmd = cmd_lower.split()[0]
            skill_commands = _ensure_skill_commands()
            skill_bundles = get_skill_bundles()
            quick_commands = self.config.get("quick_commands", {})
            if base_cmd.lstrip("/") in quick_commands:
                qcmd = quick_commands[base_cmd.lstrip("/")]
                if qcmd.get("type") == "exec":
                    import subprocess
                    exec_cmd = qcmd.get("command", "")
                    if exec_cmd:
                        try:
                            # shell=True is intentional: quick_commands are user-defined
                            # shell snippets from config.yaml — not agent/LLM controlled.
                            result = subprocess.run(
                                exec_cmd, shell=True, capture_output=True,
                                text=True, timeout=30
                            )
                            output = result.stdout.strip() or result.stderr.strip()
                            if output:
                                self._console_print(_rich_text_from_ansi(output))
                            else:
                                self._console_print("[dim]Command returned no output[/]")
                        except subprocess.TimeoutExpired:
                            self._console_print("[bold red]Quick command timed out (30s)[/]")
                        except Exception as e:
                            self._console_print(f"[bold red]Quick command error: {e}[/]")
                    else:
                        self._console_print(f"[bold red]Quick command '{base_cmd}' has no command defined[/]")
                elif qcmd.get("type") == "alias":
                    target = qcmd.get("target", "").strip()
                    if target:
                        target = target if target.startswith("/") else f"/{target}"
                        user_args = cmd_original[len(base_cmd):].strip()
                        aliased_command = f"{target} {user_args}".strip()
                        return self.process_command(aliased_command)
                    else:
                        self._console_print(f"[bold red]Quick command '{base_cmd}' has no target defined[/]")
                else:
                    self._console_print(f"[bold red]Quick command '{base_cmd}' has unsupported type (supported: 'exec', 'alias')[/]")
            # Check for plugin-registered slash commands
            elif base_cmd.lstrip("/") in _get_plugin_cmd_handler_names():
                from fan_cli.plugins import (
                    get_plugin_command_handler,
                    resolve_plugin_command_result,
                )
                plugin_handler = get_plugin_command_handler(base_cmd.lstrip("/"))
                if plugin_handler:
                    user_args = cmd_original[len(base_cmd):].strip()
                    try:
                        result = resolve_plugin_command_result(
                            plugin_handler(user_args)
                        )
                        if result:
                            _cprint(str(result))
                    except Exception as e:
                        _cprint(f"\033[1;31mPlugin command error: {e}{_RST}")
            # Skill bundles take precedence over individual skills — /<bundle>
            # loads multiple skills at once. Rescans cheaply when files change.
            elif base_cmd in skill_bundles:
                user_instruction = cmd_original[len(base_cmd):].strip()
                bundle_result = build_bundle_invocation_message(
                    base_cmd, user_instruction, task_id=self.session_id
                )
                if bundle_result:
                    msg, loaded_names, missing = bundle_result
                    bundle_info = skill_bundles[base_cmd]
                    print(
                        f"\n⚡ Loading bundle: {bundle_info['name']} "
                        f"({len(loaded_names)} skills)"
                    )
                    if missing:
                        ChatConsole().print(
                            f"[yellow]Skipped missing skills: {', '.join(missing)}[/]"
                        )
                    if hasattr(self, '_pending_input'):
                        self._pending_input.put(msg)
                else:
                    ChatConsole().print(
                        f"[bold red]Failed to load bundle for {base_cmd}[/]"
                    )
            # Check for skill slash commands (/gif-search, /axolotl, etc.)
            elif base_cmd in skill_commands:
                user_instruction = cmd_original[len(base_cmd):].strip()
                msg = build_skill_invocation_message(
                    base_cmd, user_instruction, task_id=self.session_id
                )
                if msg:
                    skill_name = skill_commands[base_cmd]["name"]
                    print(f"\n⚡ Loading skill: {skill_name}")
                    if hasattr(self, '_pending_input'):
                        self._pending_input.put(msg)
                else:
                    ChatConsole().print(f"[bold red]Failed to load skill for {base_cmd}[/]")
            else:
                # Prefix matching: if input uniquely identifies one command, execute it.
                # Matches against both built-in COMMANDS and installed skill commands so
                # that execution-time resolution agrees with tab-completion.
                from fan_cli.commands import COMMANDS
                typed_base = cmd_lower.split()[0]
                all_known = set(COMMANDS) | set(skill_commands) | set(skill_bundles)
                matches = [c for c in all_known if c.startswith(typed_base)]
                if len(matches) > 1:
                    # Prefer an exact match (typed the full command name)
                    exact = [c for c in matches if c == typed_base]
                    if len(exact) == 1:
                        matches = exact
                    else:
                        # Prefer the unique shortest match:
                        # /qui → /quit (5) wins over /quint-pipeline (15)
                        min_len = min(len(c) for c in matches)
                        shortest = [c for c in matches if len(c) == min_len]
                        if len(shortest) == 1:
                            matches = shortest
                if len(matches) == 1:
                    # Expand the prefix to the full command name, preserving arguments.
                    # Guard against redispatching the same token to avoid infinite
                    # recursion when the expanded name still doesn't hit an exact branch
                    # (e.g. /config with extra args that are not yet handled above).
                    full_name = matches[0]
                    if full_name == typed_base:
                        # Already an exact token — no expansion possible; fall through
                        _cprint(f"\033[1;31mUnknown command: {cmd_lower}{_RST}")
                        _cprint(f"{_DIM}{_ACCENT}Type /help for available commands{_RST}")
                    else:
                        remainder = cmd_original.strip()[len(typed_base):]
                        full_cmd = full_name + remainder
                        return self.process_command(full_cmd)
                elif len(matches) > 1:
                    _cprint(f"{_ACCENT}Ambiguous command: {cmd_lower}{_RST}")
                    _cprint(f"{_DIM}Did you mean: {', '.join(sorted(matches))}?{_RST}")
                else:
                    _cprint(f"\033[1;31mUnknown command: {cmd_lower}{_RST}")
                    _cprint(f"{_DIM}{_ACCENT}Type /help for available commands{_RST}")
        
        return True
    
    def _handle_background_command(self, cmd: str):
        """Handle /background <prompt> — run a prompt in a separate background session.

        Spawns a new AIAgent in a background thread with its own session.
        When it completes, prints the result to the CLI without modifying
        the active session's conversation history.
        """
        parts = cmd.strip().split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            _cprint("  Usage: /background <prompt>")
            _cprint("  Example: /background Summarize the top HN stories today")
            _cprint("  The task runs in a separate session and results display here when done.")
            return

        prompt = parts[1].strip()
        self._background_task_counter += 1
        task_num = self._background_task_counter
        task_id = f"bg_{datetime.now().strftime('%H%M%S')}_{uuid.uuid4().hex[:6]}"

        # Make sure we have valid credentials
        if not self._ensure_runtime_credentials():
            _cprint("  (>_<) Cannot start background task: no valid credentials.")
            return

        _cprint(f"  🔄 Background task #{task_num} started: \"{prompt[:60]}{'...' if len(prompt) > 60 else ''}\"")
        _cprint(f"  Task ID: {task_id}")
        _cprint("  You can continue chatting — results will appear when done.\n")

        turn_route = self._resolve_turn_agent_config(prompt)

        def run_background():
            set_sudo_password_callback(self._sudo_password_callback)
            set_approval_callback(self._approval_callback)
            try:
                set_secret_capture_callback(self._secret_capture_callback)
            except Exception:
                pass
            try:
                bg_agent = AIAgent(
                    model=turn_route["model"],
                    api_key=turn_route["runtime"].get("api_key"),
                    base_url=turn_route["runtime"].get("base_url"),
                    provider=turn_route["runtime"].get("provider"),
                    api_mode=turn_route["runtime"].get("api_mode"),
                    acp_command=turn_route["runtime"].get("command"),
                    acp_args=turn_route["runtime"].get("args"),
                    max_iterations=self.max_turns,
                    enabled_toolsets=self.enabled_toolsets,
                    quiet_mode=True,
                    verbose_logging=False,
                    session_id=task_id,
                    platform="cli",
                    session_db=self._session_db,
                    reasoning_config=self.reasoning_config,
                    service_tier=self.service_tier,
                    request_overrides=turn_route.get("request_overrides"),
                    providers_allowed=self._providers_only,
                    providers_ignored=self._providers_ignore,
                    providers_order=self._providers_order,
                    provider_sort=self._provider_sort,
                    provider_require_parameters=self._provider_require_params,
                    provider_data_collection=self._provider_data_collection,
                    openrouter_min_coding_score=self._openrouter_min_coding_score,
                    fallback_model=self._fallback_model,
                )
                # Silence raw spinner; route thinking through TUI widget when no foreground agent is active.
                bg_agent._print_fn = lambda *_a, **_kw: None

                def _bg_thinking(text: str) -> None:
                    # Concurrent bg tasks may race on _spinner_text; acceptable for best-effort UI.
                    if not self._agent_running:
                        self._spinner_text = text
                        if self._app:
                            self._app.invalidate()

                bg_agent.thinking_callback = _bg_thinking

                result = bg_agent.run_conversation(
                    user_message=prompt,
                    task_id=task_id,
                )

                response = result.get("final_response", "") if result else ""
                if not response and result and result.get("error"):
                    response = f"Error: {result['error']}"

                # Display result in the CLI (thread-safe via patch_stdout).
                # Force a TUI refresh first so spinner/status bar don't overlap
                # with the output (fixes #2718).
                if self._app:
                    self._app.invalidate()
                    time.sleep(0.05)  # brief pause for refresh
                print()
                ChatConsole().print(f"[{_accent_hex()}]{'─' * 40}[/]")
                _cprint(f"  ✅ Background task #{task_num} complete")
                _cprint(f"  Prompt: \"{prompt[:60]}{'...' if len(prompt) > 60 else ''}\"")
                ChatConsole().print(f"[{_accent_hex()}]{'─' * 40}[/]")
                if response:
                    try:
                        from fan_cli.skin_engine import get_active_skin
                        _skin = get_active_skin()
                        label = _skin.get_branding("response_label", "⚕ Fan")
                        _resp_color = _maybe_remap_for_light_mode(_skin.get_color("response_border", "#CD7F32"))
                        _resp_text = _maybe_remap_for_light_mode(_skin.get_color("banner_text", "#FFF8DC"))
                    except Exception:
                        label = "⚕ Fan"
                        _resp_color = "#CD7F32"
                        _resp_text = "#FFF8DC"

                    _chat_console = ChatConsole()
                    _chat_console.print(Panel(
                        _render_final_assistant_content(response, mode=self.final_response_markdown),
                        title=f"[{_resp_color} bold]{label} (background #{task_num})[/]",
                        title_align="left",
                        border_style=_resp_color,
                        style=_resp_text,
                        box=rich_box.HORIZONTALS,
                        padding=(1, 4),
                        width=self._scrollback_box_width(),
                    ))
                else:
                    _cprint("  (No response generated)")

                # Play bell if enabled
                if self.bell_on_complete:
                    sys.stdout.write("\a")
                    sys.stdout.flush()

            except Exception as e:
                # Same TUI refresh pattern as success path (#2718)
                if self._app:
                    self._app.invalidate()
                    time.sleep(0.05)
                print()
                _cprint(f"  ❌ Background task #{task_num} failed: {e}")
            finally:
                try:
                    set_sudo_password_callback(None)
                    set_approval_callback(None)
                    set_secret_capture_callback(None)
                except Exception:
                    pass
                self._background_tasks.pop(task_id, None)
                # Clear spinner only if no foreground agent owns it
                if not self._agent_running:
                    self._spinner_text = ""
                if self._app:
                    self._invalidate(min_interval=0)

        thread = threading.Thread(target=run_background, daemon=True, name=f"bg-task-{task_id}")
        self._background_tasks[task_id] = thread
        thread.start()

    def _handle_bundles_command(self, cmd: str) -> None:
        """In-session ``/bundles`` — show installed skill bundles.

        Mirrors ``fan bundles list`` but renders inside the running
        CLI so users can discover what's available without dropping out
        of their session. Bundles are loaded via ``/<bundle-name>``.
        """
        try:
            from agent.skill_bundles import list_bundles, _bundles_dir
        except Exception as exc:
            _cprint(f"\033[1;31mBundle subsystem unavailable: {exc}{_RST}")
            return

        bundles = list_bundles()
        if not bundles:
            _cprint("  No skill bundles installed.")
            _cprint(
                f"  {_DIM}Create one with: fan bundles create "
                f"<name> --skill <s1> --skill <s2>{_RST}"
            )
            _cprint(f"  {_DIM}Directory: {_bundles_dir()}{_RST}")
            return

        _cprint(f"\n  ▣ {_BOLD}Skill Bundles{_RST} ({len(bundles)} installed):")
        for info in bundles:
            skill_count = len(info.get("skills", []))
            desc = info.get("description") or f"Load {skill_count} skills"
            ChatConsole().print(
                f"    [bold {_accent_hex()}]/{info['slug']:<20}[/] "
                f"[dim]-[/] {_escape(desc)} [dim]({skill_count} skills)[/]"
            )
            for s in info.get("skills", []):
                ChatConsole().print(f"        [dim]· {_escape(s)}[/]")
        _cprint(
            f"\n  {_DIM}Invoke a bundle with /<slug>. "
            f"Manage with `fan bundles`.{_RST}"
        )

    # ────────────────────────────────────────────────────────────────
    # /goal — persistent cross-turn goals (Ralph-style loop)
    # ────────────────────────────────────────────────────────────────
    def _get_goal_manager(self):
        """Return the GoalManager bound to the current session_id.

        Cached on ``self._goal_manager`` and rebound lazily when
        ``session_id`` changes (e.g. after /new or a compression-driven
        session split).
        """
        try:
            from fan_cli.goals import GoalManager
            from fan_cli.config import load_config
        except Exception as exc:
            logging.debug("goal manager unavailable: %s", exc)
            return None

        sid = getattr(self, "session_id", None) or ""
        if not sid:
            return None

        existing = getattr(self, "_goal_manager", None)
        if existing is not None and getattr(existing, "session_id", None) == sid:
            return existing

        try:
            cfg = load_config() or {}
            goals_cfg = cfg.get("goals") or {}
            max_turns = int(goals_cfg.get("max_turns", 20) or 20)
        except Exception:
            max_turns = 20

        mgr = GoalManager(session_id=sid, default_max_turns=max_turns)
        self._goal_manager = mgr
        return mgr

    def _handle_goal_command(self, cmd: str) -> None:
        """Dispatch /goal subcommands: set / status / pause / resume / clear."""
        parts = (cmd or "").strip().split(None, 1)
        arg = parts[1].strip() if len(parts) > 1 else ""

        mgr = self._get_goal_manager()
        if mgr is None:
            _cprint(f"  {_DIM}Goals unavailable (no active session).{_RST}")
            return

        lower = arg.lower()

        # Bare /goal or /goal status → show current state
        if not arg or lower == "status":
            _cprint(f"  {mgr.status_line()}")
            return

        if lower == "pause":
            state = mgr.pause(reason="user-paused")
            if state is None:
                _cprint(f"  {_DIM}No goal set.{_RST}")
            else:
                _cprint(f"  ⏸ Goal paused: {state.goal}")
            return

        if lower == "resume":
            state = mgr.resume()
            if state is None:
                _cprint(f"  {_DIM}No goal to resume.{_RST}")
            else:
                _cprint(f"  ▶ Goal resumed: {state.goal}")
                _cprint(
                    f"  {_DIM}Send any message (or press Enter on an empty prompt "
                    f"is a no-op; type 'continue' to kick it off).{_RST}"
                )
            return

        if lower in {"clear", "stop", "done"}:
            had = mgr.has_goal()
            mgr.clear()
            if had:
                _cprint("  ✓ Goal cleared.")
            else:
                _cprint(f"  {_DIM}No active goal.{_RST}")
            return

        # Otherwise treat the arg as the goal text.
        try:
            state = mgr.set(arg)
        except ValueError as exc:
            _cprint(f"  Invalid goal: {exc}")
            return

        _cprint(f"  ⊙ Goal set ({state.max_turns}-turn budget): {state.goal}")
        _cprint(
            f"  {_DIM}After each turn, a judge model will check if the goal is done. "
            f"Fan keeps working until it is, you pause/clear it, or the budget is "
            f"exhausted. Use /goal status, /goal pause, /goal resume, /goal clear.{_RST}"
        )
        # Kick the loop off immediately so the user doesn't have to send a
        # separate message after setting the goal.
        try:
            self._pending_input.put(state.goal)
        except Exception:
            pass

    def _handle_subgoal_command(self, cmd: str) -> None:
        """Dispatch /subgoal subcommands.

        Forms:
          /subgoal                              show current subgoals
          /subgoal <text>                       append a criterion
          /subgoal remove <n>                   drop subgoal n (1-based)
          /subgoal clear                        wipe all subgoals

        Subgoals are extra criteria the user adds mid-loop. They get
        appended to both the judge prompt (verdict must consider them)
        and the continuation prompt (agent sees them) on the next turn
        boundary. No special kick — the running turn finishes, the next
        judge call includes them.
        """
        parts = (cmd or "").strip().split(None, 2)
        arg = " ".join(parts[1:]).strip() if len(parts) > 1 else ""

        mgr = self._get_goal_manager()
        if mgr is None:
            _cprint(f"  {_DIM}Goals unavailable (no active session).{_RST}")
            return

        if not mgr.has_goal():
            _cprint(f"  {_DIM}No active goal. Set one with /goal <text>.{_RST}")
            return

        # No args → list current subgoals.
        if not arg:
            _cprint(f"  {mgr.status_line()}")
            _cprint(f"  {mgr.render_subgoals()}")
            return

        tokens = arg.split(None, 1)
        verb = tokens[0].lower()
        rest = tokens[1].strip() if len(tokens) > 1 else ""

        if verb == "remove":
            if not rest:
                _cprint("  Usage: /subgoal remove <n>")
                return
            try:
                idx = int(rest.split()[0])
            except ValueError:
                _cprint("  /subgoal remove: <n> must be an integer (1-based index).")
                return
            try:
                removed = mgr.remove_subgoal(idx)
            except (IndexError, RuntimeError) as exc:
                _cprint(f"  /subgoal remove: {exc}")
                return
            _cprint(f"  ✓ Removed subgoal {idx}: {removed}")
            return

        if verb == "clear":
            try:
                prev = mgr.clear_subgoals()
            except RuntimeError as exc:
                _cprint(f"  /subgoal clear: {exc}")
                return
            if prev:
                _cprint(f"  ✓ Cleared {prev} subgoal{'s' if prev != 1 else ''}.")
            else:
                _cprint(f"  {_DIM}No subgoals to clear.{_RST}")
            return

        # Otherwise — append the whole arg as a new subgoal.
        try:
            text = mgr.add_subgoal(arg)
        except (ValueError, RuntimeError) as exc:
            _cprint(f"  /subgoal: {exc}")
            return
        idx = len(mgr.state.subgoals) if mgr.state else 0
        _cprint(f"  ✓ Added subgoal {idx}: {text}")


    def _handle_skin_command(self, cmd: str):
        """Handle /skin [name] — show or change the display skin."""
        try:
            from fan_cli.skin_engine import list_skins, set_active_skin, get_active_skin_name
        except ImportError:
            print("Skin engine not available.")
            return

        parts = cmd.strip().split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            # Show current skin and list available
            current = get_active_skin_name()
            skins = list_skins()
            print(f"\n  Current skin: {current}")
            print("  Available skins:")
            for s in skins:
                marker = " ●" if s["name"] == current else "  "
                source = f" ({s['source']})" if s["source"] == "user" else ""
                print(f"   {marker} {s['name']}{source} — {s['description']}")
            print("\n  Usage: /skin <name>")
            print(f"  Custom skins: drop a YAML file in {display_fan_home()}/skins/\n")
            return

        new_skin = parts[1].strip().lower()
        available = {s["name"] for s in list_skins()}
        if new_skin not in available:
            print(f"  Unknown skin: {new_skin}")
            print(f"  Available: {', '.join(sorted(available))}")
            return

        set_active_skin(new_skin)
        _ACCENT.reset()  # Re-resolve ANSI color for the new skin
        # _DIM is now a fixed dim+italic ANSI escape (terminal-default fg)
        # so it doesn't need re-resolving on skin switch.
        if save_config_value("display.skin", new_skin):
            print(f"  Skin set to: {new_skin} (saved)")
        else:
            print(f"  Skin set to: {new_skin}")
        print("  Note: banner colors will update on next session start.")
        if self._apply_tui_skin_style():
            print("  Prompt + TUI colors updated.")

    def _handle_footer_command(self, cmd_original: str) -> None:
        """Toggle or inspect ``display.runtime_footer.enabled`` from the CLI.

        Usage:
            /footer           → toggle
            /footer on|off    → explicit
            /footer status    → show current state
        """
        from fan_cli.config import load_config
        from fan_cli.colors import Colors as _Colors

        # Parse arg
        arg = ""
        try:
            parts = (cmd_original or "").strip().split(None, 1)
            if len(parts) > 1:
                arg = parts[1].strip().lower()
        except Exception:
            arg = ""

        cfg = load_config() or {}
        footer_cfg = ((cfg.get("display") or {}).get("runtime_footer") or {})
        current = bool(footer_cfg.get("enabled", False))
        fields = footer_cfg.get("fields") or ["model", "context_pct", "cwd"]

        if arg in {"status", "?"}:
            state = "ON" if current else "OFF"
            _cprint(
                f"  {_Colors.BOLD}Runtime footer:{_Colors.RESET} {state}\n"
                f"  Fields: {', '.join(fields)}"
            )
            return

        if arg in {"on", "enable", "true", "1"}:
            new_state = True
        elif arg in {"off", "disable", "false", "0"}:
            new_state = False
        elif arg == "":
            new_state = not current
        else:
            _cprint("  Usage: /footer [on|off|status]")
            return

        if save_config_value("display.runtime_footer.enabled", new_state):
            state = (
                f"{_Colors.GREEN}ON{_Colors.RESET}" if new_state
                else f"{_Colors.DIM}OFF{_Colors.RESET}"
            )
            _cprint(f"  Runtime footer: {state}")
        else:
            _cprint("  Failed to save runtime_footer setting to config.yaml")

    def _toggle_verbose(self):
        """Cycle tool progress mode: off → new → all → verbose → off.

        Tool-progress display (full args / results / think blocks at the
        ``verbose`` step) is INDEPENDENT of global DEBUG logging.  Cycling
        through here does not change ``self.verbose`` or the agent's
        ``verbose_logging`` / ``quiet_mode`` — those remain under the
        explicit ``-v``/``--verbose`` flag and the ``/verbose-logging``
        toggle.  See PR #6a1aa420e for the history that decoupled them.
        """
        cycle = ["off", "new", "all", "verbose"]
        try:
            idx = cycle.index(self.tool_progress_mode)
        except ValueError:
            idx = 2  # default to "all"
        self.tool_progress_mode = cycle[(idx + 1) % len(cycle)]

        if self.agent:
            self.agent.reasoning_callback = self._current_reasoning_callback()
            # Keep the live agent's tool_progress_mode in sync so the
            # tool_executor rendering path reflects the new mode this turn,
            # without waiting for an agent rebuild.
            self.agent.tool_progress_mode = self.tool_progress_mode

        # Use raw ANSI codes via _cprint so the output is routed through
        # prompt_toolkit's renderer.  self.console.print() with Rich markup
        # writes directly to stdout which patch_stdout's StdoutProxy mangles
        # into garbled sequences like '?[33mTool progress: NEW?[0m' (#2262).
        from fan_cli.colors import Colors as _Colors
        labels = {
            "off": f"{_Colors.DIM}Tool progress: OFF{_Colors.RESET} — silent mode, just the final response.",
            "new": f"{_Colors.YELLOW}Tool progress: NEW{_Colors.RESET} — show each new tool (skip repeats).",
            "all": f"{_Colors.GREEN}Tool progress: ALL{_Colors.RESET} — show every tool call.",
            "verbose": f"{_Colors.BOLD}{_Colors.GREEN}Tool progress: VERBOSE{_Colors.RESET} — full args, results, and think blocks.",
        }
        _cprint(labels.get(self.tool_progress_mode, ""))

    def _transfer_session_yolo(self, old_session_id: str, new_session_id: str) -> None:
        """Move YOLO bypass state from an old session key to a new one.

        Called whenever ``self.session_id`` is reassigned mid-run — ``/branch``
        forks into a new session, and auto-compression rotates the agent's
        session id into a fresh continuation session. Without this transfer
        the user's ``/yolo ON`` toggle would silently revert on the very next
        turn (the same UX failure mode that motivated this entire fix), since
        ``_session_yolo`` is keyed by session id.

        Mirrors ``tui_gateway/server.py`` (~line 1297-1305) which performs the
        same transfer for the TUI's session-rename path. No-op when YOLO
        wasn't enabled or when the ids match.
        """
        if not old_session_id or not new_session_id or old_session_id == new_session_id:
            return
        try:
            from tools.approval import (
                disable_session_yolo,
                enable_session_yolo,
                is_session_yolo_enabled,
            )
        except Exception:
            return
        if is_session_yolo_enabled(old_session_id):
            enable_session_yolo(new_session_id)
            disable_session_yolo(old_session_id)


    def _toggle_yolo(self):
        """Toggle YOLO mode — skip all dangerous command approval prompts.

        Per-session toggle that mirrors the gateway and TUI ``/yolo`` handlers
        (see ``gateway/run.py:_handle_yolo_command`` and
        ``tui_gateway/server.py`` key=="yolo"). We deliberately do NOT mutate
        ``FAN_YOLO_MODE`` here — that env var is read once at module import
        time into ``tools.approval._YOLO_MODE_FROZEN`` to keep prompt-injected
        skills from flipping the bypass mid-session, so setting it after CLI
        startup is a silent no-op. Routing through ``enable_session_yolo`` /
        ``disable_session_yolo`` gives the same auditable, per-session bypass
        the other surfaces have. ``run_conversation`` binds
        ``self.session_id`` as the active approval session key via
        ``set_current_session_key`` so the bypass takes effect on the very
        next dangerous command in this run.
        """
        from fan_cli.colors import Colors as _Colors
        from tools.approval import (
            disable_session_yolo,
            enable_session_yolo,
            is_session_yolo_enabled,
        )

        session_key = self.session_id or "default"
        if is_session_yolo_enabled(session_key):
            disable_session_yolo(session_key)
            _cprint(
                f"  ⚠ YOLO mode {_Colors.BOLD}{_Colors.RED}OFF{_Colors.RESET}"
                " — dangerous commands will require approval."
            )
        else:
            enable_session_yolo(session_key)
            _cprint(
                f"  ⚡ YOLO mode {_Colors.BOLD}{_Colors.GREEN}ON{_Colors.RESET}"
                " — all commands auto-approved. Use with caution."
            )

    def _handle_reasoning_command(self, cmd: str):
        """Handle /reasoning — manage effort level and display toggle.

        Usage:
            /reasoning              Show current effort level and display state
            /reasoning <level>      Set reasoning effort (none, minimal, low, medium, high, xhigh)
            /reasoning show|on      Show model thinking/reasoning in output
            /reasoning hide|off     Hide model thinking/reasoning from output
        """
        parts = cmd.strip().split(maxsplit=1)

        if len(parts) < 2:
            # Show current state
            rc = self.reasoning_config
            if rc is None:
                level = "medium (default)"
            elif rc.get("enabled") is False:
                level = "none (disabled)"
            else:
                level = rc.get("effort", "medium")
            display_state = "on ✓" if self.show_reasoning else "off"
            _cprint(f"  {_ACCENT}Reasoning effort:  {level}{_RST}")
            _cprint(f"  {_ACCENT}Reasoning display: {display_state}{_RST}")
            _cprint(f"  {_DIM}Usage: /reasoning <none|minimal|low|medium|high|xhigh|show|hide>{_RST}")
            return

        arg = parts[1].strip().lower()

        # Display toggle
        if arg in {"show", "on"}:
            self.show_reasoning = True
            if self.agent:
                self.agent.reasoning_callback = self._current_reasoning_callback()
            save_config_value("display.show_reasoning", True)
            _cprint(f"  {_ACCENT}✓ Reasoning display: ON (saved){_RST}")
            _cprint(f"  {_DIM}  Model thinking will be shown during and after each response.{_RST}")
            return
        if arg in {"hide", "off"}:
            self.show_reasoning = False
            if self.agent:
                self.agent.reasoning_callback = self._current_reasoning_callback()
            save_config_value("display.show_reasoning", False)
            _cprint(f"  {_ACCENT}✓ Reasoning display: OFF (saved){_RST}")
            return

        # Effort level change
        parsed = _parse_reasoning_config(arg)
        if parsed is None:
            _cprint(f"  {_DIM}(._.) Unknown argument: {arg}{_RST}")
            _cprint(f"  {_DIM}Valid levels: none, minimal, low, medium, high, xhigh{_RST}")
            _cprint(f"  {_DIM}Display:      show, hide{_RST}")
            return

        self.reasoning_config = parsed
        self.agent = None  # Force agent re-init with new reasoning config

        if save_config_value("agent.reasoning_effort", arg):
            _cprint(f"  {_ACCENT}✓ Reasoning effort set to '{arg}' (saved to config){_RST}")
        else:
            _cprint(f"  {_ACCENT}✓ Reasoning effort set to '{arg}' (session only){_RST}")

    def _handle_busy_command(self, cmd: str):
        """Handle /busy — control what Enter does while Fan is working.

        Usage:
            /busy               Show current busy input mode
            /busy status        Show current busy input mode
            /busy queue         Queue input for the next turn instead of interrupting
            /busy steer         Inject Enter mid-run via /steer (after next tool call)
            /busy interrupt     Interrupt the current run on Enter (default)
        """
        parts = cmd.strip().split(maxsplit=1)
        if len(parts) < 2 or parts[1].strip().lower() == "status":
            _cprint(f"  {_ACCENT}Busy input mode: {self.busy_input_mode}{_RST}")
            if self.busy_input_mode == "queue":
                _behavior = "queues for next turn"
            elif self.busy_input_mode == "steer":
                _behavior = "steers into current run (after next tool call)"
            else:
                _behavior = "interrupts current run"
            _cprint(f"  {_DIM}Enter while busy: {_behavior}{_RST}")
            _cprint(f"  {_DIM}Usage: /busy [queue|steer|interrupt|status]{_RST}")
            return

        arg = parts[1].strip().lower()
        if arg not in {"queue", "interrupt", "steer"}:
            _cprint(f"  {_DIM}(._.) Unknown argument: {arg}{_RST}")
            _cprint(f"  {_DIM}Usage: /busy [queue|steer|interrupt|status]{_RST}")
            return

        self.busy_input_mode = arg
        if save_config_value("display.busy_input_mode", arg):
            if arg == "queue":
                behavior = "Enter will queue follow-up input while Fan is busy."
            elif arg == "steer":
                behavior = "Enter will steer your message into the current run (after the next tool call)."
            else:
                behavior = "Enter will interrupt the current run while Fan is busy."
            _cprint(f"  {_ACCENT}✓ Busy input mode set to '{arg}' (saved to config){_RST}")
            _cprint(f"  {_DIM}{behavior}{_RST}")
        else:
            _cprint(f"  {_ACCENT}✓ Busy input mode set to '{arg}' (session only){_RST}")

    def _on_reasoning(self, reasoning_text: str):
        """Callback for intermediate reasoning display during tool-call loops."""
        if not reasoning_text:
            return
        self._reasoning_preview_buf = getattr(self, "_reasoning_preview_buf", "") + reasoning_text
        self._flush_reasoning_preview(force=False)

    def _manual_compress(self, cmd_original: str = ""):
        """Manually trigger context compression on the current conversation.

        Two modes:

        * ``/compress [<focus>]`` — compress the *whole* history. An
          optional focus topic guides the summariser to preserve
          information related to *focus* while being more aggressive
          about discarding everything else.  Inspired by Claude Code's
          ``/compact <focus>`` feature.
        * ``/compress here [N]`` — boundary-aware compression. Summarize
          everything *except* the most recent ``N`` exchanges (default
          2), which are preserved verbatim. Inspired by Claude Code's
          Rewind "Summarize up to here" action (v2.1.139, May 2026,
          https://code.claude.com/docs/en/whats-new/2026-w20). Lets the
          user pick the compression boundary instead of leaving it to
          the automatic token-budget heuristic.
        """
        if not self.conversation_history or len(self.conversation_history) < 4:
            print("(._.) Not enough conversation to compress (need at least 4 messages).")
            return

        if not self.agent:
            print("(._.) No active agent -- send a message first.")
            return

        if not self.agent.compression_enabled:
            print("(._.) Compression is disabled in config.")
            return

        from fan_cli.partial_compress import (
            parse_partial_compress_args,
            rejoin_compressed_head_and_tail,
            split_history_for_partial_compress,
        )

        # Args after the command word (e.g. "/compress here 3" -> "here 3").
        raw_args = ""
        if cmd_original:
            _parts = cmd_original.strip().split(None, 1)
            if len(_parts) > 1:
                raw_args = _parts[1].strip()

        partial, keep_last, focus_topic = parse_partial_compress_args(raw_args)
        focus_topic = focus_topic or ""

        original_count = len(self.conversation_history)
        with self._busy_command("Compressing context..."):
            try:
                from agent.model_metadata import estimate_request_tokens_rough
                from agent.manual_compression_feedback import summarize_manual_compression
                original_history = list(self.conversation_history)

                # Boundary-aware split: only the head is summarized; the
                # most recent `keep_last` exchanges ride along verbatim.
                tail: list = []
                head = original_history
                if partial:
                    head, tail = split_history_for_partial_compress(
                        original_history, keep_last
                    )
                    if not tail:
                        # Split degenerated (everything would be kept, or
                        # no head left to compress). Fall back to full
                        # compression so the user still gets an action.
                        partial = False
                        head = original_history

                # Include system prompt + tool schemas in the estimate —
                # a transcript-only number understates real request pressure
                # and can even appear to grow after compression because a
                # dense handoff summary replaces many short turns (#6217).
                _sys_prompt = getattr(self.agent, "_cached_system_prompt", "") or ""
                _tools = getattr(self.agent, "tools", None) or None
                approx_tokens = estimate_request_tokens_rough(
                    original_history,
                    system_prompt=_sys_prompt,
                    tools=_tools,
                )
                if partial:
                    print(f"🗜️  Summarizing up to here: compressing {len(head)} of "
                          f"{original_count} messages (~{approx_tokens:,} tokens), "
                          f"keeping last {keep_last} exchange(s) verbatim...")
                elif focus_topic:
                    print(f"🗜️  Compressing {original_count} messages (~{approx_tokens:,} tokens), "
                          f"focus: \"{focus_topic}\"...")
                else:
                    print(f"🗜️  Compressing {original_count} messages (~{approx_tokens:,} tokens)...")

                # Pass None as system_message so _compress_context rebuilds
                # the system prompt from scratch via _build_system_prompt(None).
                # Passing _cached_system_prompt caused duplication because
                # _build_system_prompt appends system_message to prompt_parts
                # which already contain the agent identity — resulting in the
                # identity block appearing twice (issue #15281).
                compressed, _ = self.agent._compress_context(
                    head,
                    None,
                    approx_tokens=approx_tokens,
                    focus_topic=focus_topic or None,
                    force=True,
                )
                # Re-append the verbatim tail after the compressed head.
                # The split guarantees `tail` begins on a user turn, so the
                # compressed-head -> tail boundary is normally valid
                # (the head's compressed output ends on assistant/tool).
                # rejoin_compressed_head_and_tail() additionally guards the
                # seam against any illegal user->user / assistant->assistant
                # adjacency, defending provider role-alternation rules.
                if partial and tail:
                    compressed = rejoin_compressed_head_and_tail(compressed, tail)
                self.conversation_history = compressed
                # _compress_context ends the old session and creates a new child
                # session on the agent (run_agent.py::_compress_context). Sync the
                # CLI's session_id so /status, /resume, exit summary, and title
                # generation all point at the live continuation session, not the
                # ended parent. Without this, subsequent end_session() calls target
                # the already-closed parent and the child is orphaned.
                if (
                    getattr(self.agent, "session_id", None)
                    and self.agent.session_id != self.session_id
                ):
                    self.session_id = self.agent.session_id
                    self._pending_title = None
                    # Manual /compress replaces conversation_history with a new
                    # compressed handoff for the child session. Persist it from
                    # offset 0 so resume can recover the continuation after exit.
                    self.agent._flush_messages_to_session_db(self.conversation_history, None)
                new_tokens = estimate_request_tokens_rough(
                    self.conversation_history,
                    system_prompt=_sys_prompt,
                    tools=_tools,
                )
                summary = summarize_manual_compression(
                    original_history,
                    self.conversation_history,
                    approx_tokens,
                    new_tokens,
                )
                icon = "🗜️" if summary["noop"] else "✅"
                print(f"  {icon} {summary['headline']}")
                print(f"     {summary['token_line']}")
                if summary["note"]:
                    print(f"     {summary['note']}")

            except Exception as e:
                print(f"  ❌ Compression failed: {e}")

    def _handle_debug_command(self):
        """Handle /debug by printing a redacted diagnostic report locally."""
        from fan_cli.debug import run_debug_share
        from types import SimpleNamespace

        args = SimpleNamespace(lines=200, expire=7, local=True)
        run_debug_share(args)

    def _show_usage(self):
        """Show rate limits (if available) and session token usage."""
        if not self.agent:
            print("(._.) No active agent -- send a message first.")
            return

        agent = self.agent
        calls = agent.session_api_calls

        if calls == 0:
            print("(._.) No API calls made yet in this session.")
            return

        # ── Rate limits (shown first when available) ────────────────
        rl_state = agent.get_rate_limit_state()
        if rl_state and rl_state.has_data:
            from agent.rate_limit_tracker import format_rate_limit_display
            print()
            print(format_rate_limit_display(rl_state))
            print()

        # ── Session token usage ─────────────────────────────────────
        input_tokens = getattr(agent, "session_input_tokens", 0) or 0
        output_tokens = getattr(agent, "session_output_tokens", 0) or 0
        cache_read_tokens = getattr(agent, "session_cache_read_tokens", 0) or 0
        cache_write_tokens = getattr(agent, "session_cache_write_tokens", 0) or 0
        reasoning_tokens = getattr(agent, "session_reasoning_tokens", 0) or 0
        prompt = agent.session_prompt_tokens
        completion = agent.session_completion_tokens
        total = agent.session_total_tokens

        compressor = agent.context_compressor
        last_prompt = compressor.last_prompt_tokens
        ctx_len = compressor.context_length
        pct = min(100, (last_prompt / ctx_len * 100)) if ctx_len else 0
        compressions = compressor.compression_count

        msg_count = len(self.conversation_history)
        cost_result = estimate_usage_cost(
            agent.model,
            CanonicalUsage(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read_tokens,
                cache_write_tokens=cache_write_tokens,
            ),
            provider=getattr(agent, "provider", None),
            base_url=getattr(agent, "base_url", None),
        )
        elapsed = format_duration_compact((datetime.now() - self.session_start).total_seconds())

        print("  📊 Session Token Usage")
        print(f"  {'─' * 40}")
        print(f"  Model:                     {agent.model}")
        print(f"  Input tokens:              {input_tokens:>10,}")
        print(f"  Cache read tokens:         {cache_read_tokens:>10,}")
        print(f"  Cache write tokens:        {cache_write_tokens:>10,}")
        print(f"  Output tokens:             {output_tokens:>10,}")
        if reasoning_tokens:
            print(f"  ↳ Reasoning (subset):      {reasoning_tokens:>10,}")
        print(f"  Prompt tokens (total):     {prompt:>10,}")
        print(f"  Completion tokens:         {completion:>10,}")
        print(f"  Total tokens:              {total:>10,}")
        print(f"  API calls:                 {calls:>10,}")
        print(f"  Session duration:          {elapsed:>10}")
        print(f"  Cost status:              {cost_result.status:>10}")
        print(f"  Cost source:              {cost_result.source:>10}")
        if cost_result.amount_usd is not None:
            prefix = "~" if cost_result.status == "estimated" else ""
            print(f"  Total cost:              {prefix}${float(cost_result.amount_usd):>10.4f}")
        elif cost_result.status == "included":
            print(f"  Total cost:              {'included':>10}")
        else:
            print(f"  Total cost:              {'n/a':>10}")
        print(f"  {'─' * 40}")
        print(f"  Current context:  {last_prompt:,} / {ctx_len:,} ({pct:.0f}%)")
        print(f"  Messages:         {msg_count}")
        print(f"  Compressions:     {compressions}")
        if cost_result.status == "unknown":
            print(f"  Note:             Pricing unknown for {agent.model}")

        # Account limits -- fetched off-thread with a hard timeout so slow
        # provider APIs don't hang the prompt.
        provider = getattr(agent, "provider", None) or getattr(self, "provider", None)
        base_url = getattr(agent, "base_url", None) or getattr(self, "base_url", None)
        api_key = getattr(agent, "api_key", None) or getattr(self, "api_key", None)
        # Lazy import — pulls the OpenAI SDK chain, only needed here.
        from agent.account_usage import fetch_account_usage, render_account_usage_lines
        account_snapshot = None
        if provider:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as _pool:
                try:
                    account_snapshot = _pool.submit(
                        fetch_account_usage, provider,
                        base_url=base_url, api_key=api_key,
                    ).result(timeout=10.0)
                except (concurrent.futures.TimeoutError, Exception):
                    account_snapshot = None
        account_lines = [f"  {line}" for line in render_account_usage_lines(account_snapshot)]
        if account_lines:
            print()
            for line in account_lines:
                print(line)

        if self.verbose:
            logging.getLogger().setLevel(logging.DEBUG)
            for noisy in ('openai', 'openai._base_client', 'httpx', 'httpcore', 'asyncio', 'hpack', 'grpc', 'modal'):
                logging.getLogger(noisy).setLevel(logging.WARNING)
        else:
            logging.getLogger().setLevel(logging.INFO)
            # NOTE: We deliberately do NOT raise per-logger levels for
            # tools/run_agent/etc. in quiet mode. Setting logger.setLevel
            # above the file handler level filters records before they
            # reach handlers, so agent.log / errors.log lose visibility
            # into stream-retry events, credential rotations, etc.
            # Console quietness is enforced by fan_logging not
            # installing a console StreamHandler in non-verbose mode.

    def _show_insights(self, command: str = "/insights"):
        """Show usage insights and analytics from session history."""
        # Parse optional --days flag
        parts = command.split()
        days = 30
        source = None
        i = 1
        while i < len(parts):
            if parts[i] == "--days" and i + 1 < len(parts):
                try:
                    days = int(parts[i + 1])
                except ValueError:
                    print(f"  Invalid --days value: {parts[i + 1]}")
                    return
                i += 2
            elif parts[i] == "--source" and i + 1 < len(parts):
                source = parts[i + 1]
                i += 2
            elif parts[i].isdigit():
                days = int(parts[i])
                i += 1
            else:
                i += 1

        try:
            from fan_state import SessionDB
            from agent.insights import InsightsEngine

            db = SessionDB()
            engine = InsightsEngine(db)
            report = engine.generate(days=days, source=source)
            print(engine.format_terminal(report))
            db.close()
        except Exception as e:
            print(f"  Error generating insights: {e}")


    _DESTRUCTIVE_SKIP_TOKENS = frozenset({"now", "--yes", "-y"})

    @classmethod
    def _split_destructive_skip(cls, cmd_text: Optional[str]) -> tuple[str, bool]:
        """Split inline-skip tokens out of a destructive slash command.

        Returns ``(remainder, skip)`` where ``remainder`` is the original
        text with the command word and any recognized skip tokens removed,
        and ``skip`` is True iff at least one skip token was found.

        Examples:
            "/reset now"            -> ("", True)
            "/reset --yes My title" -> ("My title", True)
            "/new My title"         -> ("My title", False)
            "/clear"                -> ("", False)
        """
        if not cmd_text:
            return "", False
        tokens = cmd_text.strip().split()
        if not tokens:
            return "", False
        # Drop leading "/cmd" word — callers pass the full command text.
        if tokens[0].startswith("/"):
            tokens = tokens[1:]
        skip = False
        kept: list[str] = []
        for tok in tokens:
            if tok.lower() in cls._DESTRUCTIVE_SKIP_TOKENS:
                skip = True
                continue
            kept.append(tok)
        return " ".join(kept), skip

    def _confirm_destructive_slash(
        self,
        command: str,
        detail: str,
        cmd_original: Optional[str] = None,
    ) -> Optional[str]:
        """Prompt the user to confirm a destructive session slash command.

        Used by ``/clear``, ``/new``/``/reset``, and ``/undo`` before they
        discard conversation state.  Three-option prompt:

          1. Approve Once — proceed this time only
          2. Always Approve — proceed and persist
             ``approvals.destructive_slash_confirm: false`` so future
             destructive commands run without confirmation
          3. Cancel — abort

        Gated by ``approvals.destructive_slash_confirm`` (default on).  If the
        gate is off the function returns ``"once"`` immediately without
        prompting.

        Inline-skip: if ``cmd_original`` contains ``now``, ``--yes``, or
        ``-y`` as an argument (e.g. ``/reset now``, ``/new --yes My title``),
        the modal is bypassed and ``"once"`` is returned immediately. This is
        an escape hatch for platforms where the prompt_toolkit modal hangs
        (issue #30768 — native Windows PowerShell). Callers are responsible
        for stripping the skip tokens from any remaining argument parsing
        (see :meth:`_split_destructive_skip`).

        Returns ``"once"``, ``"always"``, or ``None`` (cancelled).  Callers
        proceed with the destructive action when the result is non-None.
        """
        # Inline-skip escape hatch — works regardless of platform/modal state.
        # See class-level _DESTRUCTIVE_SKIP_TOKENS for the accepted tokens.
        if cmd_original:
            _, _skip = self._split_destructive_skip(cmd_original)
            if _skip:
                return "once"

        # Gate check — respects prior "Always Approve" clicks.
        try:
            cfg = load_cli_config()
            approvals = cfg.get("approvals") if isinstance(cfg, dict) else None
            confirm_required = True
            if isinstance(approvals, dict):
                confirm_required = bool(approvals.get("destructive_slash_confirm", True))
        except Exception:
            confirm_required = True

        if not confirm_required:
            return "once"

        # Render a prompt_toolkit-native confirmation panel.  This keeps option
        # labels visible above the composer and avoids raw input()/EOF races with
        # the running TUI.
        choices = [
            ("once", "Approve Once", "proceed this time only"),
            ("always", "Always Approve", "proceed and silence this prompt permanently"),
            ("cancel", "Cancel", "keep current conversation"),
        ]
        raw = self._prompt_text_input_modal(
            title=f"⚠️  /{command} — destroys conversation state",
            detail=detail,
            choices=choices,
        )
        if raw is None:
            print(f"🟡 /{command} cancelled (no input).")
            return None
        choice = self._normalize_slash_confirm_choice(raw, choices)
        if choice is None:
            print(f"🟡 Unrecognized choice '{raw}'. /{command} cancelled.")
            return None

        if choice == "cancel":
            print(f"🟡 /{command} cancelled. Conversation unchanged.")
            return None

        if choice == "always":
            if save_config_value("approvals.destructive_slash_confirm", False):
                print("🔒 Future /clear, /new, /reset, and /undo will run without confirmation.")
                print("   Re-enable via `approvals.destructive_slash_confirm: true` in config.yaml.")
            else:
                print("⚠️  Couldn't persist opt-out — proceeding once.")

        return choice

    def _confirm_and_reload_mcp(self, cmd_original: str = "") -> None:
        """Interactive /reload-mcp — confirm with the user, then reload.

        Reloading MCP tools invalidates the provider prompt cache for the
        active session (tool schemas are baked into the system prompt).
        The next message re-sends full input tokens — can be expensive on
        long-context or high-reasoning models.

        Three options: Approve Once, Always Approve (persists
        ``approvals.mcp_reload_confirm: false`` so future reloads run
        without this prompt), Cancel.  Gated by
        ``approvals.mcp_reload_confirm`` — default on.
        """
        # Gate check — respects prior "Always Approve" clicks.
        try:
            cfg = load_cli_config()
            approvals = cfg.get("approvals") if isinstance(cfg, dict) else None
            confirm_required = True
            if isinstance(approvals, dict):
                confirm_required = bool(approvals.get("mcp_reload_confirm", True))
        except Exception:
            confirm_required = True

        if not confirm_required:
            with self._busy_command(self._slow_command_status(cmd_original)):
                self._reload_mcp()
            return

        # Render warning + prompt.  Use the same prompt_toolkit-native composer
        # modal as destructive slash confirmations so choices stay visible.
        choices = [
            ("once", "Approve Once", "reload now"),
            ("always", "Always Approve", "reload now and silence this prompt permanently"),
            ("cancel", "Cancel", "leave MCP tools unchanged"),
        ]
        raw = self._prompt_text_input_modal(
            title="⚠️  /reload-mcp — Prompt cache invalidation warning",
            detail=(
                "Reloading MCP servers rebuilds the tool set for this session and\n"
                "invalidates the provider prompt cache. The next message will\n"
                "re-send full input tokens (can be expensive on long-context or\n"
                "high-reasoning models)."
            ),
            choices=choices,
        )
        if raw is None:
            print("🟡 /reload-mcp cancelled (no input).")
            return
        choice = self._normalize_slash_confirm_choice(raw, choices)
        if choice is None:
            print(f"🟡 Unrecognized choice '{raw}'. /reload-mcp cancelled.")
            return

        if choice == "cancel":
            print("🟡 /reload-mcp cancelled. MCP tools unchanged.")
            return

        if choice == "always":
            if save_config_value("approvals.mcp_reload_confirm", False):
                print("🔒 Future /reload-mcp calls will run without confirmation.")
                print("   Re-enable via `approvals.mcp_reload_confirm: true` in config.yaml.")
            else:
                print("⚠️  Couldn't persist opt-out — reloading once.")

        with self._busy_command(self._slow_command_status(cmd_original)):
            self._reload_mcp()

    def _reload_mcp(self):
        """Reload MCP servers: disconnect all, re-read config.yaml, reconnect.

        After reconnecting, refreshes the agent's tool list so the model
        sees the updated tools on the next turn.
        """
        try:
            from tools.mcp_tool import (
                _lock,
                _servers,
                discover_mcp_tools,
                refresh_agent_mcp_tools,
                shutdown_mcp_servers,
            )

            # Capture old server names
            with _lock:
                old_servers = set(_servers.keys())

            if not self._command_running:
                print("🔄 Reloading MCP servers...")

            # Shutdown existing connections
            shutdown_mcp_servers()

            # Reconnect (reads config.yaml fresh)
            new_tools = discover_mcp_tools()

            # Compute what changed
            with _lock:
                connected_servers = set(_servers.keys())

            added = connected_servers - old_servers
            removed = old_servers - connected_servers
            reconnected = connected_servers & old_servers

            if reconnected:
                print(f"  ♻️  Reconnected: {', '.join(sorted(reconnected))}")
            if added:
                print(f"  ➕ Added: {', '.join(sorted(added))}")
            if removed:
                print(f"  ➖ Removed: {', '.join(sorted(removed))}")
            if not connected_servers:
                print("  No MCP servers connected.")
            else:
                print(f"  🔧 {len(new_tools)} tool(s) available from {len(connected_servers)} server(s)")

            # Refresh the agent's tool list so the model can call new tools
            if self.agent is not None:
                refresh_agent_mcp_tools(
                    self.agent,
                    quiet_mode=True,
                )

            # Inject a message at the END of conversation history so the
            # model knows tools changed.  Appended after all existing
            # messages to preserve prompt-cache for the prefix.
            change_parts = []
            if added:
                change_parts.append(f"Added servers: {', '.join(sorted(added))}")
            if removed:
                change_parts.append(f"Removed servers: {', '.join(sorted(removed))}")
            if reconnected:
                change_parts.append(f"Reconnected servers: {', '.join(sorted(reconnected))}")
            tool_summary = f"{len(new_tools)} MCP tool(s) now available" if new_tools else "No MCP tools available"
            change_detail = ". ".join(change_parts) + ". " if change_parts else ""
            self.conversation_history.append({
                "role": "user",
                "content": f"[IMPORTANT: MCP servers have been reloaded. {change_detail}{tool_summary}. The tool list for this conversation has been updated accordingly.]",
            })

            # Persist session immediately so the session log reflects the
            # updated tools list (self.agent.tools was refreshed above).
            if self.agent is not None:
                try:
                    self.agent._persist_session(
                        self.conversation_history,
                        self.conversation_history,
                    )
                except Exception:
                    pass  # Best-effort

            print(f"  ✅ Agent updated — {len(self.agent.tools if self.agent else [])} tool(s) available")

        except Exception as e:
            print(f"  ❌ MCP reload failed: {e}")

    def _reload_skills(self) -> None:
        """Reload skills: rescan ~/.fan/skills/ and queue a note for the
        next user turn.

        Skills don't need to live in the system prompt for the model to use
        them (they're invoked via ``/skill-name``, ``skills_list``, or
        ``skill_view`` at runtime), so this does NOT clear the prompt cache.
        It rescans the slash-command map, prints the diff for the user, and
        — if any skills were added or removed — queues a one-shot note that
        gets prepended to the next user message. This preserves message
        alternation (no phantom user turn injected out of band) and keeps
        prompt caching intact.
        """
        try:
            from agent.skill_commands import reload_skills, get_skill_commands

            if not self._command_running:
                print("🔄 Reloading skills...")

            result = reload_skills()

            # Sync cli.py's module-level _skill_commands so all consumers
            # (help display, command dispatch, Tab-completion lambda) see the
            # updated dict without needing to restart the session.
            global _skill_commands
            _skill_commands = get_skill_commands()
            added = result.get("added", [])      # [{"name", "description"}, ...]
            removed = result.get("removed", [])  # [{"name", "description"}, ...]
            total = result.get("total", 0)

            if not added and not removed:
                print("  No new skills detected.")
                print(f"  📚 {total} skill(s) available")
                return

            def _fmt_line(item: dict) -> str:
                nm = item.get("name", "")
                desc = item.get("description", "")
                return f"    - {nm}: {desc}" if desc else f"    - {nm}"

            if added:
                print("  ➕ Added Skills:")
                for item in added:
                    print(f"  {_fmt_line(item)}")
            if removed:
                print("  ➖ Removed Skills:")
                for item in removed:
                    print(f"  {_fmt_line(item)}")
            print(f"  📚 {total} skill(s) available")

            # Queue a one-shot note for the NEXT user turn. The CLI's agent
            # loop prepends ``_pending_skills_reload_note`` (if set) to the
            # API-call-local message at ~L8770, then clears it — same
            # pattern as ``_pending_model_switch_note``. Nothing is written
            # to conversation_history here, so message alternation stays
            # intact and no out-of-band user turn is persisted.
            #
            # Format matches how the system prompt renders pre-existing
            # skills (``    - name: description``) so the model reads the
            # diff in the same shape as its original skill catalog.
            sections = ["[USER INITIATED SKILLS RELOAD:"]
            if added:
                sections.append("")
                sections.append("Added Skills:")
                for item in added:
                    sections.append(_fmt_line(item))
            if removed:
                sections.append("")
                sections.append("Removed Skills:")
                for item in removed:
                    sections.append(_fmt_line(item))
            sections.append("")
            sections.append("Use skills_list to see the updated catalog.]")
            self._pending_skills_reload_note = "\n".join(sections)

        except Exception as e:
            print(f"  ❌ Skills reload failed: {e}")

    # ====================================================================
    # Tool-call generation indicator (shown during streaming)
    # ====================================================================

    def _on_tool_gen_start(self, tool_name: str) -> None:
        """Called when the model begins generating tool-call arguments.

        Closes any open streaming boxes (reasoning / response) exactly once,
        then prints a short status line so the user sees activity instead of
        a frozen screen while a large payload (e.g. 45 KB write_file) streams.
        """
        if getattr(self, "_stream_box_opened", False):
            self._flush_stream()
            self._stream_box_opened = False
        self._close_reasoning_box()

        from agent.display import get_tool_emoji
        emoji = get_tool_emoji(tool_name, default="⚡")
        _cprint(f"  ┊ {emoji} preparing {tool_name}…")

    # ====================================================================
    # Tool progress callback
    # ====================================================================

    def _on_tool_progress(self, event_type: str, function_name: str = None, preview: str = None, function_args: dict = None, **kwargs):
        """Called on tool lifecycle events (tool.started, tool.completed, reasoning.available, etc.).

        Updates the TUI spinner widget so the user can see what the agent
        is doing during tool execution (fills the gap between thinking
        spinner and next response).

        On tool.started, records a monotonic timestamp so get_spinner_text()
        can show a live elapsed timer (the TUI poll loop already invalidates
        every ~0.15s, so the counter updates automatically).

        When tool_progress_mode is "all" or "new", also prints a persistent
        stacked line to scrollback on tool.completed so users can see the
        full history of tool calls (not just the current one in the spinner).
        """
        if event_type == "tool.completed":
            self._tool_start_time = 0.0
            # Print stacked scrollback line for "all" / "new" modes
            if function_name and self.tool_progress_mode in {"all", "new"}:
                duration = kwargs.get("duration", 0.0)
                # Pop stored args from tool.started for this function
                stored = self._pending_tool_info.get(function_name)
                stored_args = stored.pop(0) if stored else {}
                if stored is not None and not stored:
                    del self._pending_tool_info[function_name]
                # "new" mode: skip consecutive repeats of the same tool
                if self.tool_progress_mode == "new" and function_name == self._last_scrollback_tool:
                    self._invalidate()
                    return
                self._last_scrollback_tool = function_name
                try:
                    from agent.display import get_cute_tool_message
                    line = get_cute_tool_message(function_name, stored_args, duration, result=kwargs.get("result"))
                    _cprint(f"  {line}")
                except Exception:
                    pass
                # First-touch onboarding: on the first tool in this process
                # that takes longer than the threshold while we're in the
                # noisiest progress mode, print a one-time hint about
                # /verbose.  Latched on self so it fires at most once per
                # process; persisted to config.yaml so it never fires again
                # across processes either.
                try:
                    if (
                        not getattr(self, "_long_tool_hint_fired", False)
                        and self.tool_progress_mode == "all"
                        and duration >= 30.0
                    ):
                        from agent.onboarding import (
                            TOOL_PROGRESS_FLAG,
                            is_seen,
                            mark_seen,
                            tool_progress_hint_cli,
                        )
                        if not is_seen(CLI_CONFIG, TOOL_PROGRESS_FLAG):
                            self._long_tool_hint_fired = True
                            _cprint(f"  {_DIM}{tool_progress_hint_cli()}{_RST}")
                            mark_seen(_fan_home / "config.yaml", TOOL_PROGRESS_FLAG)
                            CLI_CONFIG.setdefault("onboarding", {}).setdefault("seen", {})[TOOL_PROGRESS_FLAG] = True
                except Exception:
                    pass
            self._invalidate()
            return
        if event_type != "tool.started":
            return
        if function_name and not function_name.startswith("_"):
            from agent.display import get_tool_emoji
            emoji = get_tool_emoji(function_name)
            label = preview or function_name
            from agent.display import get_tool_preview_max_len
            _pl = get_tool_preview_max_len()
            if _pl > 0 and len(label) > _pl:
                label = label[:_pl - 3] + "..."
            self._spinner_text = f"{emoji} {label}"
            self._tool_start_time = time.monotonic()
            # Store args for stacked scrollback line on completion
            self._pending_tool_info.setdefault(function_name, []).append(
                function_args if function_args is not None else {}
            )
            self._invalidate()

    def _on_tool_start(self, tool_call_id: str, function_name: str, function_args: dict):
        """Capture local before-state for write-capable tools."""
        try:
            from agent.display import capture_local_edit_snapshot

            snapshot = capture_local_edit_snapshot(function_name, function_args)
            if snapshot is not None:
                self._pending_edit_snapshots[tool_call_id] = snapshot
        except Exception:
            logger.debug("Edit snapshot capture failed for %s", function_name, exc_info=True)

    def _on_tool_complete(self, tool_call_id: str, function_name: str, function_args: dict, function_result: str):
        """Render file edits with inline diff after write-capable tools complete."""
        snapshot = self._pending_edit_snapshots.pop(tool_call_id, None)
        try:
            from agent.display import render_edit_diff_with_delta

            render_edit_diff_with_delta(
                function_name,
                function_result,
                function_args=function_args,
                snapshot=snapshot,
                print_fn=_cprint,
            )
        except Exception:
            logger.debug("Edit diff preview failed for %s", function_name, exc_info=True)

    def _persist_prompt_summary(self, icon: str, label: str, detail: str, outcome: str) -> None:
        """Print a one-line scrollback summary of a resolved modal prompt.

        Modal panels (approval / collect) live in the prompt_toolkit layout and
        vanish on the next repaint, so the question and the decision leave no
        trace in the terminal scrollback. When display.persist_prompts is on
        (default), emit a dim single line after the prompt resolves so the
        decision survives in chat history.
        """
        if not CLI_CONFIG.get("display", {}).get("persist_prompts", True):
            return
        detail = " ".join(detail.split())
        if len(detail) > 120:
            detail = detail[:119] + "…"
        outcome = " ".join(outcome.split())
        if len(outcome) > 120:
            outcome = outcome[:119] + "…"
        _cprint(f"\n{_DIM}{icon} {label}: {detail} → {outcome}{_RST}")

    def _collect_prompt_callback(self, question, choices):
        """
        Render one collect step in the terminal TUI. Called from the agent thread.

        Sets up the interactive selection UI (or freetext prompt for open-ended
        questions), then blocks until the user responds via the prompt_toolkit
        key bindings.  If no response arrives within the configured timeout the
        question is dismissed and the agent is told to decide on its own.
        """
        import time as _time

        timeout = CLI_CONFIG.get("collect", {}).get("timeout", 3600)
        response_queue = queue.Queue()
        is_open_ended = not choices

        self._collect_state = {
            "question": question,
            "choices": choices if not is_open_ended else [],
            "selected": 0,
            "response_queue": response_queue,
        }
        self._collect_deadline = _time.monotonic() + timeout
        # Open-ended questions skip straight to freetext input
        self._collect_freetext = is_open_ended

        # Trigger prompt_toolkit repaint from this (non-main) thread
        self._invalidate()

        # Poll for the user's response.  The countdown in the hint line
        # updates on each invalidate — but frequent repaints cause visible
        # flicker in some terminals (Kitty, ghostty).  We only refresh the
        # countdown every 5 s; selection changes (↑/↓) trigger instant
        # repaints via the key bindings.
        _last_countdown_refresh = _time.monotonic()
        while True:
            try:
                result = response_queue.get(timeout=1)
                self._collect_deadline = 0
                self._persist_prompt_summary("?", "Collect", question, str(result))
                return result
            except queue.Empty:
                remaining = self._collect_deadline - _time.monotonic()
                if remaining <= 0:
                    break
                # Only repaint every 5 s for the countdown — avoids flicker
                now = _time.monotonic()
                if now - _last_countdown_refresh >= 5.0:
                    _last_countdown_refresh = now
                    self._invalidate()
        # Timed out — tear down the UI and let the agent decide
        self._collect_state = None
        self._collect_freetext = False
        self._collect_deadline = 0
        self._invalidate()
        _cprint(f"\n{_DIM}(collect timed out after {timeout}s — agent will decide){_RST}")
        return (
            "The user did not provide a response within the time limit. "
            "Use your best judgement to make the choice and proceed."
        )

    def _collect_callback(self, payload) -> str:
        """
        Platform callback for both legacy single-step collect and questions[].

        The terminal presents each visible question sequentially. Conditional
        branches are evaluated from prior answers and all steps are returned in
        the same final envelope as the desktop questionnaire.
        """
        import json as _json
        import re as _re

        payload = payload or {}
        question = str(payload.get("question") or "").strip()
        choices = payload.get("choices")
        fields = payload.get("fields") or []
        questions = payload.get("questions") or []

        # The terminal prompt returns this instruction sentence on timeout —
        # recognizable prefix, never a real user value.
        _timeout_prefix = "The user did not provide a response"

        def _ask(prompt, options=None):
            value = str(self._collect_prompt_callback(prompt, options) or "").strip()
            return "" if value.startswith(_timeout_prefix) else value

        def _collect_fields(step_question, step_fields):
            step_values = {}
            for field in step_fields or []:
                if not isinstance(field, dict):
                    continue
                name = str(field.get("name") or "").strip()
                if not name:
                    continue
                label = str(field.get("label") or name)
                prompt = f"{step_question}\n{label}" if step_question else label
                field_type = str(field.get("type") or "text")
                options = field.get("options") if field_type == "select" else None
                if field_type == "consent":
                    options = ["是", "否"]
                value = _ask(prompt, options)
                if field_type == "consent" and value:
                    value = "true" if value == "是" else ""
                if value:
                    step_values[name] = value
            return step_values

        def _condition_matches(condition, answers):
            if not isinstance(condition, dict):
                return True
            row = answers.get(str(condition.get("question_id") or ""), {})
            raw = row.get("answer", "")
            values = raw if isinstance(raw, list) else [raw]
            texts = [str(item).strip() for item in values if str(item).strip()]
            operator = str(condition.get("operator") or "equals")
            expected = str(condition.get("value") or "").strip()
            if operator == "not_empty":
                return bool(texts or row.get("values"))
            if operator == "includes":
                return expected in texts
            if operator == "not_equals":
                return bool(texts) and expected not in texts
            return expected in texts

        if isinstance(questions, list) and questions:
            answers = {}
            all_values = {}
            for step_number, item in enumerate(questions, 1):
                if not isinstance(item, dict) or not _condition_matches(
                    item.get("depends_on"), answers
                ):
                    continue
                step_id = str(item.get("id") or f"step_{step_number}")
                step_question = str(item.get("question") or question).strip()
                step_choices = item.get("choices")
                step_fields = item.get("fields") or []
                row = {}

                if isinstance(step_choices, list) and step_choices:
                    normalized_choices = [str(value) for value in step_choices]
                    if item.get("multiple"):
                        option_text = " / ".join(normalized_choices)
                        raw = _ask(
                            f"{step_question}\n可多选，请用逗号分隔：{option_text}",
                            None,
                        )
                        selected = [
                            value.strip()
                            for value in _re.split(r"[,，、]", raw)
                            if value.strip()
                        ]
                        if selected:
                            row["answer"] = selected
                    else:
                        options = list(normalized_choices)
                        other_label = "其他（自行填写）"
                        if item.get("allow_other"):
                            options.append(other_label)
                        selected = _ask(step_question, options)
                        if selected == other_label:
                            selected = _ask(f"{step_question}\n请输入其他答案", None)
                        if selected:
                            row["answer"] = selected
                elif not step_fields:
                    selected = _ask(step_question, None)
                    if selected:
                        row["answer"] = selected

                step_values = _collect_fields(step_question, step_fields)
                if step_values:
                    row["values"] = step_values
                    all_values.update(step_values)
                if not row:
                    row["skipped"] = True
                answers[step_id] = row

            status = "submitted" if any(not row.get("skipped") for row in answers.values()) else "skipped"
            return _json.dumps(
                {
                    "answers": answers,
                    "values": all_values,
                    "status": status,
                    "skipped": status == "skipped",
                },
                ensure_ascii=False,
            )

        answer = ""
        # A standalone question only makes sense without fields (fields carry
        # the question as per-field context below) or as a choices decision.
        if question and (choices or not fields):
            answer = _ask(question, choices)

        values = _collect_fields(question, fields)

        skipped = not answer and not values
        return _json.dumps(
            {"answer": answer, "values": values, "skipped": skipped},
            ensure_ascii=False,
        )

    def _sudo_password_callback(self) -> str:
        """
        Prompt for sudo password through the prompt_toolkit UI.
        
        Called from the agent thread when a sudo command is encountered.
        Uses the same modal mechanism: sets UI state, waits on a
        queue for the user's response via the Enter key binding.
        """
        import time as _time

        timeout = 45
        response_queue = queue.Queue()

        self._capture_modal_input_snapshot()
        self._sudo_state = {
            "response_queue": response_queue,
        }
        self._sudo_deadline = _time.monotonic() + timeout

        self._invalidate()

        while True:
            try:
                result = response_queue.get(timeout=1)
                self._sudo_state = None
                self._sudo_deadline = 0
                self._restore_modal_input_snapshot()
                self._invalidate()
                if result:
                    _cprint(f"\n{_DIM}  ✓ Password received (cached for session){_RST}")
                else:
                    _cprint(f"\n{_DIM}  ⏭ Skipped{_RST}")
                return result
            except queue.Empty:
                remaining = self._sudo_deadline - _time.monotonic()
                if remaining <= 0:
                    break
                self._invalidate()

        self._sudo_state = None
        self._sudo_deadline = 0
        self._restore_modal_input_snapshot()
        self._invalidate()
        _cprint(f"\n{_DIM}  ⏱ Timeout — continuing without sudo{_RST}")
        return ""

    def _approval_callback(self, command: str, description: str,
                           *, allow_permanent: bool = True) -> str:
        """
        Prompt for dangerous command approval through the prompt_toolkit UI.

        Called from the agent thread. Shows a selection UI similar to collect
        with choices: once / session / always / deny. When allow_permanent
        is False (tirith warnings present), the 'always' option is hidden.
        Long commands also get a 'view' option so the full command can be
        expanded before deciding.

        Uses _approval_lock to serialize concurrent requests (e.g. from
        parallel delegation subtasks) so each prompt gets its own turn
        and the shared _approval_state / _approval_deadline aren't clobbered.
        """
        import time as _time

        with self._approval_lock:
            timeout = int(CLI_CONFIG.get("approvals", {}).get("timeout", 60))
            response_queue = queue.Queue()

            self._approval_state = {
                "command": command,
                "description": description,
                "choices": self._approval_choices(command, allow_permanent=allow_permanent),
                "selected": 0,
                "response_queue": response_queue,
            }
            self._approval_deadline = _time.monotonic() + timeout

            self._invalidate()

            _last_countdown_refresh = _time.monotonic()
            while True:
                try:
                    result = response_queue.get(timeout=1)
                    self._approval_state = None
                    self._approval_deadline = 0
                    self._invalidate()
                    _outcome_labels = {
                        "once": "allowed once",
                        "session": "allowed for session",
                        "always": "added to allowlist",
                        "deny": "denied",
                    }
                    self._persist_prompt_summary(
                        "⚠", "Approval", command,
                        _outcome_labels.get(result, str(result)),
                    )
                    return result
                except queue.Empty:
                    remaining = self._approval_deadline - _time.monotonic()
                    if remaining <= 0:
                        break
                    now = _time.monotonic()
                    if now - _last_countdown_refresh >= 5.0:
                        _last_countdown_refresh = now
                        self._invalidate()

            self._approval_state = None
            self._approval_deadline = 0
            self._invalidate()
            _cprint(f"\n{_DIM}  ⏱ Timeout — denying command{_RST}")
            return "deny"

    def _approval_choices(self, command: str, *, allow_permanent: bool = True) -> list[str]:
        """Return approval choices for a dangerous command prompt."""
        choices = ["once", "session", "always", "deny"] if allow_permanent else ["once", "session", "deny"]
        if len(command) > 70:
            choices.append("view")
        return choices

    def _computer_use_approval_callback(self, action: str, args: dict, summary: str) -> str:
        """Adapt the generic approval UI for the computer_use tool.

        The computer_use handler expects verdicts of the form
        `approve_once` | `approve_session` | `always_approve` | `deny`.
        The CLI's built-in approval UI returns `once` | `session` | `always`
        | `deny`. Translate between the two.
        """
        # Build a command-ish string so the existing UI renders something
        # meaningful. `summary` is already a one-line human description.
        verdict = self._approval_callback(
            command=f"computer_use: {summary}",
            description=f"Allow computer_use to perform `{action}`?",
        )
        return {
            "once": "approve_once",
            "session": "approve_session",
            "always": "always_approve",
            "deny": "deny",
        }.get(verdict, "deny")


    def _secret_capture_callback(self, var_name: str, prompt: str, metadata=None) -> dict:
        return prompt_for_secret(self, var_name, prompt, metadata)

    def _capture_modal_input_snapshot(self) -> None:
        """Temporarily clear the input buffer and save the user's in-progress draft."""
        if self._modal_input_snapshot is not None or not getattr(self, "_app", None):
            return
        try:
            buf = self._app.current_buffer
            self._modal_input_snapshot = {
                "text": buf.text,
                "cursor_position": buf.cursor_position,
            }
            buf.reset()
        except Exception:
            self._modal_input_snapshot = None

    def _restore_modal_input_snapshot(self) -> None:
        """Restore any draft text that was present before a modal prompt opened."""
        snapshot = self._modal_input_snapshot
        self._modal_input_snapshot = None
        if not snapshot or not getattr(self, "_app", None):
            return
        try:
            buf = self._app.current_buffer
            buf.text = snapshot.get("text", "")
            buf.cursor_position = min(snapshot.get("cursor_position", 0), len(buf.text))
        except Exception:
            pass


    def _clear_secret_input_buffer(self) -> None:
        if getattr(self, "_app", None):
            try:
                self._app.current_buffer.reset()
            except Exception:
                pass

    
    def _build_tui_style_dict(self) -> dict[str, str]:
        """Layer the active skin's prompt_toolkit colors over the base TUI style.

        Also rewrites any hex-color tokens in the resulting style strings
        to their light-mode equivalents (via _LIGHT_MODE_REMAP) when the
        terminal is detected as light.  This makes the chrome readable
        on cream Terminal.app backgrounds without per-skin overrides.
        """
        style_dict = dict(getattr(self, "_tui_style_base", {}) or {})
        try:
            from fan_cli.skin_engine import get_prompt_toolkit_style_overrides
            style_dict.update(get_prompt_toolkit_style_overrides())
        except Exception:
            pass
        # Light-mode remap on the style strings.  Each value is a pt
        # style string like "bg:#1a1a2e #C0C0C0 bold" — split on space,
        # rewrite any "#XXX" tokens (including "bg:#XXX") through the
        # light-mode remap, rejoin.
        #
        # CRITICAL: skip the remap entirely when a style string already
        # specifies its own bg (e.g. status-bar / completion-menu styles
        # with `bg:#1a1a2e ...`).  Those colors were tuned for that
        # specific dark bg and remapping the FG to a dark equivalent
        # would produce dark-on-dark (invisible).  The terminal's BG
        # mode is irrelevant — what matters is the bg the style itself
        # paints.
        try:
            if _detect_light_mode():
                def _remap_value(v: str) -> str:
                    if not v:
                        return v
                    tokens = v.split()
                    has_explicit_bg = any(t.startswith("bg:") for t in tokens)
                    if has_explicit_bg:
                        # The style paints its own bg — leave its fg alone.
                        return v
                    return " ".join(
                        _maybe_remap_for_light_mode(t) if t.startswith("#") else t
                        for t in tokens
                    )
                style_dict = {k: _remap_value(v or "") for k, v in style_dict.items()}
        except Exception:
            pass
        return style_dict

    def _apply_tui_skin_style(self) -> bool:
        """Refresh prompt_toolkit styling for a running interactive TUI."""
        if not getattr(self, "_app", None) or not getattr(self, "_tui_style_base", None):
            return False
        self._app.style = PTStyle.from_dict(self._build_tui_style_dict())
        self._invalidate(min_interval=0.0)
        return True
