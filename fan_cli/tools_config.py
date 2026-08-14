"""
Unified tool configuration for Fan Agent.

`fan tools` and `fan setup tools` both enter this module.
Select a local runtime → toggle toolsets on/off → for newly enabled tools
that need API keys, run through provider-aware configuration.

Saves per-runtime tool configuration to ~/.fan/config.yaml under
the `platform_toolsets` key.
"""

import json as _json
import logging
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set

from fan_cli._subprocess_compat import find_node_executable

from fan_cli.config import (
    cfg_get,
    load_config, save_config, get_env_value, save_env_value,
)
from fan_cli.colors import Colors, color
from utils import base_url_hostname, is_truthy_value

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent.resolve()


# ─── UI Helpers (shared with setup.py) ────────────────────────────────────────

from fan_cli.cli_output import (  # noqa: E402 — late import block
    print_error as _print_error,
    print_info as _print_info,
    print_success as _print_success,
    print_warning as _print_warning,
    prompt as _prompt,
)

# ─── Toolset Registry ─────────────────────────────────────────────────────────

# Toolsets shown in the configurator, grouped for display.
# Each entry: (toolset_name, label, description)
# These map to keys in toolsets.py TOOLSETS dict.
CONFIGURABLE_TOOLSETS = [
    ("browser",         "🌐 Browser Automation",       "navigate, click, type, scroll"),
    ("terminal",        "💻 Terminal & Processes",      "terminal, process"),
    ("file",            "📁 File Operations",           "read, write, patch, search"),
    ("code_execution",  "⚡ Code Execution",            "execute_code"),
    ("vision",          "👁️  Vision / Image Analysis",  "vision_analyze"),
    ("moa",             "🧠 Mixture of Agents",         "mixture_of_agents"),
    ("skills",          "📚 Skills",                    "list, view, manage"),
    ("todo",            "📋 Task Planning",             "todo"),
    ("memory",          "💾 Memory",                    "persistent memory across sessions"),
    ("context_engine",  "🧩 Context Engine",            "runtime tools from the active context engine"),
    ("session_search",  "🔎 Session Search",            "search past conversations"),
    ("collect",         "❓ User Information",          "collect"),
    ("delegation",      "👥 Task Delegation",           "delegate_task"),
    ("cronjob",         "⏰ Cron Jobs",                 "create/list/update/pause/resume/run, with optional attached skills"),
]


def gui_toolset_label(label: str) -> str:
    """Strip leading emoji/icons from toolset titles for GUI surfaces.

    Registry labels use ``<emoji> <title>``; plugin toolsets prefix with ``🔌``.
    CLI/TUI keeps the raw ``label`` — only HTTP APIs call this helper.
    """
    text = (label or "").strip()
    if not text:
        return text
    parts = text.split(None, 1)
    if len(parts) == 2 and parts[0] and not any(ch.isascii() and ch.isalnum() for ch in parts[0]):
        return parts[1].strip()
    return text


# Toolsets that are OFF by default for new installs.
# They're still in _FAN_CORE_TOOLS (available at runtime if enabled),
# but the setup checklist won't pre-select them for first-time users.
_DEFAULT_OFF_TOOLSETS = {"moa"}

# Runtime-scoped toolsets: only appear in the `fan tools` checklist for
# these runtimes, and only resolve/save for these runtimes.  A toolset
# absent from this map is available on every platform (current behaviour).
#
# Use this for tools whose APIs only make sense on one runtime. Keeps every
# other runtime's checklist from filling up with irrelevant toggles.
_TOOLSET_PLATFORM_RESTRICTIONS: Dict[str, Set[str]] = {
}


def _toolset_allowed_for_platform(ts_key: str, platform: str) -> bool:
    """Return True if ``ts_key`` is configurable on ``platform``.

    Toolsets without a restriction entry are allowed everywhere (the default).
    """
    allowed = _TOOLSET_PLATFORM_RESTRICTIONS.get(ts_key)
    return allowed is None or platform in allowed


def _get_effective_configurable_toolsets():
    """Return CONFIGURABLE_TOOLSETS + any plugin-provided toolsets.

    Plugin toolsets are appended at the end so they appear after the
    built-in toolsets in the TUI checklist. A plugin whose toolset key
    already appears in ``CONFIGURABLE_TOOLSETS`` is skipped — bundled
    plugins (e.g. ``plugins/spotify``) share their toolset key with the
    built-in entry, and we want the built-in label/description to win.
    Without the dedupe, ``fan tools`` → "reconfigure existing" would
    list the same toolset twice.
    """
    result = list(CONFIGURABLE_TOOLSETS)
    seen = {ts_key for ts_key, _, _ in result}
    try:
        from fan_cli.plugins import discover_plugins, get_plugin_toolsets
        discover_plugins()  # idempotent — ensures plugins are loaded
        for entry in get_plugin_toolsets():
            if entry[0] in seen:
                continue
            seen.add(entry[0])
            result.append(entry)
    except Exception:
        pass
    return result


def _get_plugin_toolset_keys() -> set:
    """Return the set of toolset keys provided by plugins."""
    try:
        from fan_cli.plugins import discover_plugins, get_plugin_toolsets
        discover_plugins()  # idempotent — ensures plugins are loaded
        return {ts_key for ts_key, _, _ in get_plugin_toolsets()}
    except Exception:
        return set()


def _checklist_toolset_keys(platform: str) -> Set[str]:
    """Return the toolset keys the ``fan tools`` checklist actually offers
    for ``platform``.

    This mirrors exactly what ``_prompt_toolset_checklist`` renders:
    ``_get_effective_configurable_toolsets()`` (built-in + plugin toolsets),
    filtered by ``_toolset_allowed_for_platform``. The checklist's returned
    selection can therefore only ever be a subset of this universe.

    Non-configurable toolsets that ``_get_platform_tools`` resolves at read
    time — ``kanban`` and other check_fn-gated toolsets, recovered platform
    composites, MCP server names — are NOT in this set because the checklist
    never shows them. Use this to scope the added/removed diff the UI prints,
    so ``fan tools`` never claims to add or remove a toolset the user was
    never given a checkbox for. The underlying config is unaffected — those
    entries are preserved by ``_save_platform_tools`` regardless.
    """
    return {
        ts_key
        for ts_key, _, _ in _get_effective_configurable_toolsets()
        if _toolset_allowed_for_platform(ts_key, platform)
    }

# Platform display config — derived from the canonical registry so every
# module shares the same data.  Kept as dict-of-dicts for backward
# compatibility with existing ``PLATFORMS[key]["label"]`` access patterns.
from fan_cli.platforms import PLATFORMS as _PLATFORMS_REGISTRY

PLATFORMS = {
    k: {"label": info.label, "default_toolset": info.default_toolset}
    for k, info in _PLATFORMS_REGISTRY.items()
}


# ─── Tool Categories (provider-aware configuration) ──────────────────────────
# Maps toolset keys to their provider options. When a toolset is newly enabled,
# we use this to show provider selection and prompt for the right API keys.
# Toolsets not in this map either need no config or use the simple fallback.

TOOL_CATEGORIES = {}

# Simple env-var requirements for toolsets NOT in TOOL_CATEGORIES.
# Used as a fallback for tools like vision/moa that just need an API key.
TOOLSET_ENV_REQUIREMENTS = {
    "vision":     [("OPENROUTER_API_KEY",   "https://openrouter.ai/keys")],
    "moa":        [("OPENROUTER_API_KEY",   "https://openrouter.ai/keys")],
}


def _run_post_setup(post_setup_key: str):
    """Run post-setup hooks for tools that need extra installation steps."""
    import shutil
    if post_setup_key == "agent_browser":
        node_modules = PROJECT_ROOT / "node_modules" / "agent-browser"
        npm_bin = find_node_executable("npm")
        # Step 1: install the agent-browser npm package into node_modules/
        if not node_modules.exists() and npm_bin:
            _print_info("    Installing Node.js dependencies for browser tools...")
            import subprocess
            # Use the resolved npm_bin absolute path so subprocess.Popen can
            # execute npm.cmd on Windows (CreateProcessW otherwise rejects
            # batch shims).  On POSIX npm_bin is the plain path — same
            # behaviour as before.
            result = subprocess.run(
                [npm_bin, "install", "--silent"],
                capture_output=True, text=True, cwd=str(PROJECT_ROOT)
            )
            if result.returncode == 0:
                _print_success("    Node.js dependencies installed")
            else:
                from fan_constants import display_fan_home
                _print_warning(f"    npm install failed - run manually: cd {display_fan_home()}/fan-agent && npm install")
                if result.stderr:
                    _print_info(f"      {result.stderr.strip()[:200]}")
        elif not node_modules.exists():
            _print_warning("    Node.js not found - browser tools require: npm install (in fan-agent directory)")
            return

        # The desktop attaches to Electron's Chromium over CDP (is_local=False),
        # so no local-Chromium install step is needed here.


# ─── Platform / Toolset Helpers ───────────────────────────────────────────────

def _get_enabled_platforms() -> List[str]:
    """Return the built-in local runtime keys."""
    return list(PLATFORMS)


def _platform_toolset_summary(config: dict, platforms: Optional[List[str]] = None) -> Dict[str, Set[str]]:
    """Return a summary of enabled toolsets per platform.

    When ``platforms`` is None, this uses ``_get_enabled_platforms`` to
    enumerate local runtimes. Callers may pass an explicit subset.
    """
    if platforms is None:
        platforms = _get_enabled_platforms()

    summary: Dict[str, Set[str]] = {}
    for pkey in platforms:
        summary[pkey] = _get_platform_tools(config, pkey)
    return summary


def _parse_enabled_flag(value, default: bool = True) -> bool:
    """Parse bool-like config values used by tool/platform settings."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    return default


def enabled_mcp_server_names(config: dict) -> set[str]:
    """Return globally enabled MCP server toolset names."""
    mcp_servers = (config or {}).get("mcp_servers") or {}
    return {
        str(name)
        for name, server_cfg in mcp_servers.items()
        if isinstance(server_cfg, dict)
        and _parse_enabled_flag(server_cfg.get("enabled", True), default=True)
    }


def _get_platform_tools(
    config: dict,
    platform: str,
    *,
    include_default_mcp_servers: bool = True,
) -> Set[str]:
    """Resolve which individual toolset names are enabled for a platform."""
    from toolsets import resolve_toolset, TOOLSETS

    platform_toolsets = config.get("platform_toolsets") or {}
    toolset_names = platform_toolsets.get(platform)

    if toolset_names is None or not isinstance(toolset_names, list):
        plat_info = PLATFORMS.get(platform)
        if plat_info:
            default_ts = plat_info["default_toolset"]
        else:
            # Plugin platform — derive toolset name from platform key
            default_ts = f"fan-{platform}"
        toolset_names = [default_ts]

    # YAML may parse bare numeric names (e.g. ``12306:``) as int.
    # Normalise to str so downstream sorted() never mixes types.
    toolset_names = [str(ts) for ts in toolset_names]

    configurable_keys = {ts_key for ts_key, _, _ in CONFIGURABLE_TOOLSETS}
    plugin_ts_keys = _get_plugin_toolset_keys()
    platform_default_keys = {p["default_toolset"] for p in PLATFORMS.values()}

    # If the saved list contains any configurable keys directly, the user
    # has explicitly configured this platform — use direct membership.
    # This avoids the subset-inference bug where composite toolsets like
    # "fan-cli" (which include all _FAN_CORE_TOOLS) cause disabled
    # toolsets to re-appear as enabled.
    has_explicit_config = any(ts in configurable_keys for ts in toolset_names)

    if has_explicit_config:
        enabled_toolsets = {
            ts for ts in toolset_names
            if ts in configurable_keys and _toolset_allowed_for_platform(ts, platform)
        }
        # Mixed config: composite toolset alongside configurables (e.g.
        # ``[fan-cli, spotify]`` after enabling Spotify via ``fan
        # tools``). Without expansion the composite name is silently dropped,
        # leaving sessions with only the configurable opt-ins and no native
        # tools. Mirror the else-branch's subset inference, but apply
        # _DEFAULT_OFF_TOOLSETS only to the implicit expansion — anything the
        # user explicitly listed (e.g. ``spotify``) must survive.
        composite_tools = set()
        for ts_name in toolset_names:
            if ts_name in configurable_keys or ts_name in plugin_ts_keys:
                continue
            if ts_name not in TOOLSETS:
                continue
            composite_tools.update(resolve_toolset(ts_name))

        if composite_tools:
            expanded = set()
            for ts_key, _, _ in CONFIGURABLE_TOOLSETS:
                if not _toolset_allowed_for_platform(ts_key, platform):
                    continue
                ts_tools = set(resolve_toolset(ts_key))
                if ts_tools and ts_tools.issubset(composite_tools):
                    expanded.add(ts_key)

            default_off = set(_DEFAULT_OFF_TOOLSETS)
            if platform in default_off and platform not in _TOOLSET_PLATFORM_RESTRICTIONS:
                default_off.remove(platform)
            expanded -= default_off

            enabled_toolsets |= expanded
    else:
        # No explicit config — fall back to resolving composite toolset names
        # (e.g. "fan-cli") to individual tool names and reverse-mapping.
        all_tool_names = set()
        for ts_name in toolset_names:
            all_tool_names.update(resolve_toolset(ts_name))

        enabled_toolsets = set()
        for ts_key, _, _ in CONFIGURABLE_TOOLSETS:
            if not _toolset_allowed_for_platform(ts_key, platform):
                continue
            ts_tools = set(resolve_toolset(ts_key))
            if ts_tools and ts_tools.issubset(all_tool_names):
                enabled_toolsets.add(ts_key)

        default_off = set(_DEFAULT_OFF_TOOLSETS)
        # If the runtime's own name matches a default-off toolset, keep that
        # toolset enabled on first install. Runtime-restricted toolsets remain
        # opt-in even on their own runtime.
        if platform in default_off and platform not in _TOOLSET_PLATFORM_RESTRICTIONS:
            default_off.remove(platform)
        enabled_toolsets -= default_off

    # Recover non-configurable runtime toolsets. These are part of the
    # runtime's default composite but
    # absent from CONFIGURABLE_TOOLSETS, so they can't appear in the TUI
    # checklist or in a user-saved config.  Must run in BOTH branches —
    # otherwise saving via `fan tools` (which flips has_explicit_config
    # to True) silently drops them.
    _plat_info = PLATFORMS.get(platform)
    _default_ts = _plat_info["default_toolset"] if _plat_info else f"fan-{platform}"
    platform_tool_universe = set(resolve_toolset(_default_ts))
    configurable_tool_universe = set()
    for ck in configurable_keys:
        configurable_tool_universe.update(resolve_toolset(ck))
    claimed = set()
    for ts_key in enabled_toolsets:
        claimed.update(resolve_toolset(ts_key))
    skip = configurable_keys | plugin_ts_keys | platform_default_keys
    skip |= {k for k in TOOLSETS if k.startswith("fan-")}
    skip |= set(_DEFAULT_OFF_TOOLSETS) - {platform}
    for ts_key, ts_def in TOOLSETS.items():
        if ts_key in skip:
            continue
        if ts_def.get("includes"):
            continue
        ts_tools = set(resolve_toolset(ts_key))
        if not ts_tools or not ts_tools.issubset(platform_tool_universe):
            continue
        if ts_tools.issubset(configurable_tool_universe):
            continue
        if not ts_tools.issubset(claimed):
            enabled_toolsets.add(ts_key)
            claimed.update(ts_tools)

    # Plugin toolsets: enabled by default unless explicitly disabled, or
    # unless the toolset is in _DEFAULT_OFF_TOOLSETS (e.g. spotify —
    # shipped as a bundled plugin but user must opt in via `fan tools`
    # so we don't ship 7 Spotify tool schemas to users who don't use it).
    # A plugin toolset is "known" for a platform once `fan tools`
    # has been saved for that platform (tracked via known_plugin_toolsets).
    # Unknown plugins default to enabled; known-but-absent = disabled.
    if plugin_ts_keys:
        known_map = config.get("known_plugin_toolsets") or {}
        if not isinstance(known_map, dict):
            known_map = {}
        known_for_platform = set(known_map.get(platform) or [])
        for pts in plugin_ts_keys:
            if pts in toolset_names:
                # Explicitly listed in config — enabled
                enabled_toolsets.add(pts)
            elif pts in _DEFAULT_OFF_TOOLSETS:
                # Opt-in plugin toolset — stay off until user picks it
                continue
            elif pts not in known_for_platform:
                # New plugin not yet seen by fan tools — default enabled
                enabled_toolsets.add(pts)
            # else: known but not in config = user disabled it

    # Context-engine tools are runtime-provided by the active engine, so they
    # are not part of any static platform composite. When a non-default engine
    # is selected, keep its recovery/status tools available even after a user
    # saves an explicit platform toolset list. Preserve the explicit empty-list
    # contract: selecting no configurable tools means no context-engine tools
    # either unless the user adds ``context_engine`` manually later.
    context_cfg = config.get("context") or {}
    if not isinstance(context_cfg, dict):
        context_cfg = {}
    context_engine_name = str(context_cfg.get("engine") or "compressor").strip().lower()
    explicit_empty_selection = (
        platform in platform_toolsets
        and isinstance(platform_toolsets.get(platform), list)
        and not toolset_names
    )
    if context_engine_name and context_engine_name != "compressor" and not explicit_empty_selection:
        enabled_toolsets.add("context_engine")

    # Preserve any explicit non-configurable toolset entries (for example,
    # custom toolsets or MCP server names saved in platform_toolsets).
    explicit_passthrough = {
        ts
        for ts in toolset_names
        if ts not in configurable_keys
        and ts not in plugin_ts_keys
        and ts not in platform_default_keys
    }

    # MCP servers are expected to be available on all platforms by default.
    # If the platform explicitly lists one or more MCP server names, treat that
    # as an allowlist. Otherwise include every globally enabled MCP server.
    # Special sentinel: "no_mcp" in the toolset list disables all MCP servers.
    enabled_mcp_servers = enabled_mcp_server_names(config)
    # Allow "no_mcp" sentinel to opt out of all MCP servers for this platform
    if "no_mcp" in toolset_names:
        explicit_mcp_servers = set()
        enabled_toolsets.update(explicit_passthrough - enabled_mcp_servers - {"no_mcp"})
    else:
        explicit_mcp_servers = explicit_passthrough & enabled_mcp_servers
        enabled_toolsets.update(explicit_passthrough - enabled_mcp_servers)
    if include_default_mcp_servers:
        if explicit_mcp_servers or "no_mcp" in toolset_names:
            enabled_toolsets.update(explicit_mcp_servers)
        else:
            enabled_toolsets.update(enabled_mcp_servers)
    else:
        enabled_toolsets.update(explicit_mcp_servers)

    # Honor agent.disabled_toolsets from config.yaml — allows users to
    # globally suppress specific toolsets (e.g. "memory") across all
    # platforms without per-platform toolset configuration.  This runs
    # last so it overrides everything above.
    agent_cfg = config.get("agent") or {}
    disabled_toolsets = agent_cfg.get("disabled_toolsets") or []
    if disabled_toolsets:
        disabled_set = {str(ts) for ts in disabled_toolsets}
        enabled_toolsets -= disabled_set

    return enabled_toolsets


def _save_platform_tools(config: dict, platform: str, enabled_toolset_keys: Set[str]):
    """Save the selected toolset keys for a platform to config.

    Preserves any non-configurable toolset entries (like MCP server names)
    that were already in the config for this platform.
    """
    config.setdefault("platform_toolsets", {})

    # Drop platform-scoped toolsets that don't apply here.  Prevents the
    # "Configure all runtimes" checklist (or a hand-edited config.yaml)
    # from turning on a runtime-scoped toolset in the wrong surface.
    enabled_toolset_keys = {
        ts for ts in enabled_toolset_keys
        if _toolset_allowed_for_platform(ts, platform)
    }

    # Get the set of all configurable toolset keys (built-in + plugin)
    configurable_keys = {ts_key for ts_key, _, _ in CONFIGURABLE_TOOLSETS}
    plugin_keys = _get_plugin_toolset_keys()
    configurable_keys |= plugin_keys

    # Also exclude runtime default composite toolsets.
    # These are "super" toolsets that resolve to ALL tools, so preserving them
    # would silently override the user's unchecked selections on the next read.
    platform_default_keys = {p["default_toolset"] for p in PLATFORMS.values()}

    # Get existing toolsets for this platform
    existing_toolsets = cfg_get(config, "platform_toolsets", platform, default=[])
    if not isinstance(existing_toolsets, list):
        existing_toolsets = []
    existing_toolsets = [str(ts) for ts in existing_toolsets]

    # Preserve any entries that are NOT configurable toolsets and NOT platform
    # defaults (i.e. only MCP server names should be preserved)
    preserved_entries = {
        entry for entry in existing_toolsets
        if entry not in configurable_keys and entry not in platform_default_keys
    }
    # Opening `fan tools` is the user's opt-in to reconfigure tools, so treat
    # saving from the picker as consent to clear the "no_mcp" sentinel. The
    # picker has no checkbox for no_mcp, so without this users who once set it
    # by hand could never re-enable MCP servers through the UI.
    preserved_entries.discard("no_mcp")

    # Merge preserved entries with new enabled toolsets
    config["platform_toolsets"][platform] = sorted(enabled_toolset_keys | preserved_entries)

    # Track which plugin toolsets are "known" for this platform so we can
    # distinguish "new plugin, default enabled" from "user disabled it".
    if plugin_keys:
        if not isinstance(config.get("known_plugin_toolsets"), dict):
            config["known_plugin_toolsets"] = {}
        config["known_plugin_toolsets"][platform] = sorted(plugin_keys)

    save_config(config)


def _toolset_has_keys(
    ts_key: str,
    config: dict = None,
    *,
    force_fresh: bool = False,
) -> bool:
    """Check if a toolset's required API keys are configured."""
    if config is None:
        config = load_config()

    if ts_key == "vision":
        try:
            from agent.auxiliary_client import resolve_vision_provider_client

            _provider, client, _model = resolve_vision_provider_client()
            return client is not None
        except Exception:
            return False

    # Check TOOL_CATEGORIES first (provider-aware)
    cat = TOOL_CATEGORIES.get(ts_key)
    if cat:
        for provider in _visible_providers(cat, config, force_fresh=force_fresh):
            env_vars = provider.get("env_vars", [])
            if not env_vars:
                return True  # No-key provider (e.g. Local Browser)
            if all(get_env_value(e["key"]) for e in env_vars):
                return True
        return False

    # Fallback to simple requirements
    requirements = TOOLSET_ENV_REQUIREMENTS.get(ts_key, [])
    if not requirements:
        return True
    return all(get_env_value(var) for var, _ in requirements)


# ─── Menu Helpers ─────────────────────────────────────────────────────────────

def _prompt_choice(question: str, choices: list, default: int = 0) -> int:
    """Single-select menu (arrow keys). Delegates to curses_radiolist."""
    from fan_cli.curses_ui import curses_radiolist
    return curses_radiolist(question, choices, selected=default, cancel_returns=default)


# ─── Token Estimation ────────────────────────────────────────────────────────

# Module-level cache so discovery + tokenization runs at most once per process.
_tool_token_cache: Optional[Dict[str, int]] = None


def _estimate_tool_tokens() -> Dict[str, int]:
    """Return estimated token counts per individual tool name.

    Uses tiktoken (cl100k_base) to count tokens in the JSON-serialised
    OpenAI-format tool schema.  Triggers tool discovery on first call,
    then caches the result for the rest of the process.

    Returns an empty dict when tiktoken or the registry is unavailable.
    """
    global _tool_token_cache
    if _tool_token_cache is not None:
        return _tool_token_cache

    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
    except Exception:
        logger.debug("tiktoken unavailable; skipping tool token estimation")
        _tool_token_cache = {}
        return _tool_token_cache

    try:
        # Trigger full tool discovery (imports all tool modules).
        import model_tools  # noqa: F401
        from tools.registry import registry
    except Exception:
        logger.debug("Tool registry unavailable; skipping token estimation")
        _tool_token_cache = {}
        return _tool_token_cache

    counts: Dict[str, int] = {}
    for name in registry.get_all_tool_names():
        schema = registry.get_schema(name)
        if schema:
            # Mirror what gets sent to the API:
            # {"type": "function", "function": <schema>}
            text = _json.dumps({"type": "function", "function": schema})
            counts[name] = len(enc.encode(text))
    _tool_token_cache = counts
    return _tool_token_cache


def _prompt_toolset_checklist(
    platform_label: str,
    enabled: Set[str],
    platform: str = "cli",
    *,
    force_fresh: bool = True,
) -> Set[str]:
    """Multi-select checklist of toolsets. Returns set of selected toolset keys."""
    from fan_cli.curses_ui import curses_checklist
    from toolsets import resolve_toolset

    # Pre-compute per-tool token counts (cached after first call).
    tool_tokens = _estimate_tool_tokens()

    effective_all = _get_effective_configurable_toolsets()
    # Drop platform-scoped toolsets that don't apply to this platform.
    effective = [
        (k, l, d) for (k, l, d) in effective_all
        if _toolset_allowed_for_platform(k, platform)
    ]

    labels = []
    for ts_key, ts_label, ts_desc in effective:
        suffix = ""
        if (
            not _toolset_has_keys(ts_key, force_fresh=force_fresh)
            and (TOOL_CATEGORIES.get(ts_key) or TOOLSET_ENV_REQUIREMENTS.get(ts_key))
        ):
            suffix = "  [no API key]"
        labels.append(f"{ts_label}  ({ts_desc}){suffix}")

    pre_selected = {
        i for i, (ts_key, _, _) in enumerate(effective)
        if ts_key in enabled
    }

    # Build a live status function that shows deduplicated total token cost.
    status_fn = None
    if tool_tokens:
        ts_keys = [ts_key for ts_key, _, _ in effective]

        def status_fn(chosen: set) -> str:
            # Collect unique tool names across all selected toolsets
            all_tools: set = set()
            for idx in chosen:
                all_tools.update(resolve_toolset(ts_keys[idx]))
            total = sum(tool_tokens.get(name, 0) for name in all_tools)
            if total >= 1000:
                return f"Est. tool context: ~{total / 1000:.1f}k tokens"
            return f"Est. tool context: ~{total} tokens"

    chosen = curses_checklist(
        f"Tools for {platform_label}",
        labels,
        pre_selected,
        cancel_returns=pre_selected,
        status_fn=status_fn,
    )
    return {effective[i][0] for i in chosen}


# ─── Provider-Aware Configuration ────────────────────────────────────────────

def _configure_toolset(
    ts_key: str,
    config: dict,
    *,
    force_fresh: bool = True,
):
    """Configure a toolset - provider selection + API keys.
    
    Uses TOOL_CATEGORIES for provider-aware config, falls back to simple
    env var prompts for toolsets not in TOOL_CATEGORIES.
    """
    cat = TOOL_CATEGORIES.get(ts_key)

    if cat:
        _configure_tool_category(ts_key, cat, config, force_fresh=force_fresh)
    else:
        # Simple fallback for vision, moa, etc.
        _configure_simple_requirements(ts_key)




def _visible_providers(
    cat: dict,
    config: dict,
    *,
    force_fresh: bool = False,
) -> list[dict]:
    """Return provider entries visible for the current config state."""
    return list(cat.get("providers", []))


_POST_SETUP_INSTALLED: dict = {
    # post_setup_key -> predicate(): True when the install side-effect
    # is already satisfied. Used by `_toolset_needs_configuration_prompt`
    # to force the provider-setup flow when a no-key provider still needs
    # a binary/dependency install (otherwise an already-configured user
    # who toggles the toolset on via `fan tools` gets a silent no-op
    # because the gate sees "no env vars to ask about" and skips the
    # provider-setup flow that would have run the post_setup hook).
    #
    # Only entries here are gated; other post_setup hooks (agent_browser,
    # etc.) keep their existing behaviour. Add an
    # entry when (a) the post_setup is the ONLY install side-effect for
    # a no-key provider, and (b) an installed-state check is cheap and
    # doesn't trigger a heavy import.
}


def _post_setup_already_installed(post_setup_key: str) -> bool:
    """Return True when the post_setup install side-effect is satisfied."""
    predicate = _POST_SETUP_INSTALLED.get(post_setup_key)
    if predicate is None:
        # No install-state check registered → assume satisfied (don't
        # change behaviour for hooks we haven't explicitly opted in).
        return True
    try:
        return bool(predicate())
    except Exception:
        return True


def _toolset_needs_configuration_prompt(
    ts_key: str,
    config: dict,
    *,
    force_fresh: bool = False,
) -> bool:
    """Return True when enabling this toolset should open provider setup."""
    cat = TOOL_CATEGORIES.get(ts_key)
    if not cat:
        return not _toolset_has_keys(ts_key, config, force_fresh=force_fresh)

    # If any visible provider has a registered post_setup install-state
    # check that hasn't been satisfied, force the configuration flow so
    # `_configure_provider` invokes `_run_post_setup` and the install
    # actually runs.
    for provider in _visible_providers(cat, config, force_fresh=force_fresh):
        post_setup = provider.get("post_setup")
        if post_setup and not _post_setup_already_installed(post_setup):
            return True

    return not _toolset_has_keys(ts_key, config, force_fresh=force_fresh)


def _configure_tool_category(
    ts_key: str,
    cat: dict,
    config: dict,
    *,
    force_fresh: bool = True,
):
    """Configure a tool category with provider selection."""
    icon = cat.get("icon", "")
    name = cat["name"]
    providers = _visible_providers(cat, config, force_fresh=force_fresh)

    # Check Python version requirement
    if cat.get("requires_python"):
        req = cat["requires_python"]
        if sys.version_info < req:
            print()
            _print_error(f"  {name} requires Python {req[0]}.{req[1]}+ (current: {sys.version_info.major}.{sys.version_info.minor})")
            _print_info("  Upgrade Python and reinstall to enable this tool.")
            return

    if not providers:
        print()
        _print_info(f"  No providers are available for {name}.")
        if cat.get("setup_note"):
            _print_info(f"  {cat['setup_note']}")
        return

    if len(providers) == 1:
        # Single provider - configure directly
        provider = providers[0]
        print()
        print(color(f"  --- {icon} {name} ({provider['name']}) ---", Colors.CYAN))
        if provider.get("tag"):
            _print_info(f"  {provider['tag']}")
        # For single-provider tools, show a note if available
        if cat.get("setup_note"):
            _print_info(f"  {cat['setup_note']}")
        _configure_provider(provider, config, force_fresh=force_fresh)
    else:
        # Multiple providers - let user choose
        print()
        # Use custom title if provided (e.g. "Select Search Provider")
        title = cat.get("setup_title", "Choose a provider")
        print(color(f"  --- {icon} {name} - {title} ---", Colors.CYAN))
        if cat.get("setup_note"):
            _print_info(f"  {cat['setup_note']}")
        print()

        # Plain text labels only (no ANSI codes in menu items)
        provider_choices = []
        for p in providers:
            badge = f" [{p['badge']}]" if p.get("badge") else ""
            tag = f" — {p['tag']}" if p.get("tag") else ""
            configured = ""
            env_vars = p.get("env_vars", [])
            if not env_vars or all(get_env_value(v["key"]) for v in env_vars):
                if _is_provider_active(p, config, force_fresh=force_fresh):
                    configured = " [active]"
                elif not env_vars:
                    configured = ""
                else:
                    configured = " [configured]"
            provider_choices.append(f"{p['name']}{badge}{tag}{configured}")

        # Add skip option
        provider_choices.append("Skip — keep defaults / configure later")

        # Detect current provider as default
        default_idx = _detect_active_provider_index(
            providers,
            config,
            force_fresh=force_fresh,
        )

        provider_idx = _prompt_choice(f"  {title}:", provider_choices, default_idx)

        # Skip selected
        if provider_idx >= len(providers):
            _print_info(f"  Skipped {name}")
            return

        _configure_provider(providers[provider_idx], config, force_fresh=force_fresh)


def _is_provider_active(
    provider: dict,
    config: dict,
    *,
    force_fresh: bool = False,
) -> bool:
    """Check if a provider entry matches the currently active config."""
    return False


def _detect_active_provider_index(
    providers: list,
    config: dict,
    *,
    force_fresh: bool = False,
) -> int:
    """Return the index of the currently active provider, or 0."""
    for i, p in enumerate(providers):
        if _is_provider_active(p, config, force_fresh=force_fresh):
            return i
        # Fallback: env vars present → likely configured
        env_vars = p.get("env_vars", [])
        if env_vars and all(get_env_value(v["key"]) for v in env_vars):
            return i
    return 0










def _write_provider_config(provider: dict, config: dict) -> None:
    """Persist the provider/backend config keys for a selected provider.

    This is the pure, non-interactive core of :func:`_configure_provider` —
    it writes provider-specific config keys,
    but does NOT prompt for env vars, run post-setup hooks, or run interactive
    model pickers. Both the CLI configurator and the desktop GUI
    ``PUT .../provider`` endpoint call through here so there is one code path.
    """
    # Tools run locally as configured — clear any stale gateway flag left on
    # this provider's category section from a previous config.
    for cat_key, cat in TOOL_CATEGORIES.items():
        if provider in cat.get("providers", []):
            section = config.get(cat_key)
            if isinstance(section, dict) and section.get("use_gateway"):
                section["use_gateway"] = False
            break


def apply_provider_selection(ts_key: str, provider_name: str, config: dict) -> None:
    """Non-interactively persist a provider selection for a toolset.

    Resolves ``provider_name`` within ``ts_key``'s category (matching the
    rows the GUI/CLI picker shows via :func:`_visible_providers`) and writes
    the corresponding backend/provider config keys. Unlike
    :func:`_configure_provider`, this does NOT prompt for API keys, run
    post-setup hooks, or run interactive model pickers — those are handled
    separately (env endpoints, post-setup endpoints, the model picker) in the
    desktop GUI.

    Raises ``KeyError`` if the toolset has no category or the provider name
    is not found among the visible providers.
    """
    cat = TOOL_CATEGORIES.get(ts_key)
    if cat is None:
        raise KeyError(f"Toolset has no configurable category: {ts_key}")

    providers = _visible_providers(cat, config, force_fresh=True)
    provider = next((p for p in providers if p.get("name") == provider_name), None)
    if provider is None:
        raise KeyError(f"Unknown provider {provider_name!r} for toolset {ts_key!r}")

    _write_provider_config(provider, config)


def _configure_provider(
    provider: dict,
    config: dict,
    *,
    force_fresh: bool = True,
):
    """Configure a single provider - prompt for API keys and set config."""
    env_vars = provider.get("env_vars", [])

    # Persist the provider/backend config keys. Shared with the GUI
    # provider-select endpoint via apply_provider_selection so there is a
    # single source of truth for these writes.
    _write_provider_config(provider, config)

    if not env_vars:
        if provider.get("post_setup"):
            _run_post_setup(provider["post_setup"])
        _print_success(f"  {provider['name']} - no configuration needed!")
        return

    # Prompt for each required env var
    all_configured = True

    for var in env_vars:
        existing = get_env_value(var["key"])
        if existing:
            _print_success(f"  {var['key']}: already configured")
            # Don't ask to update - this is a new enable flow.
            # Reconfigure is handled separately.
        else:
            url = var.get("url", "")
            if url:
                _print_info(f"  Get yours at: {url}")

            default_val = var.get("default", "")
            if default_val:
                value = _prompt(f"    {var.get('prompt', var['key'])}", default_val)
            else:
                value = _prompt(f"    {var.get('prompt', var['key'])}", password=True)

            if value:
                save_env_value(var["key"], value)
                _print_success("    Saved")
            else:
                _print_warning("    Skipped")
                all_configured = False

    # Run post-setup hooks if needed
    if provider.get("post_setup") and all_configured:
        _run_post_setup(provider["post_setup"])

    if all_configured:
        _print_success(f"  {provider['name']} configured!")


def _configure_simple_requirements(ts_key: str):
    """Simple fallback for toolsets that just need env vars (no provider selection)."""
    if ts_key == "vision":
        if _toolset_has_keys("vision"):
            return
        print()
        print(color("  Vision / Image Analysis requires a multimodal backend:", Colors.YELLOW))
        choices = [
            "OpenRouter — uses Gemini",
            "OpenAI-compatible endpoint — base URL, API key, and vision model",
            "Skip",
        ]
        idx = _prompt_choice("  Configure vision backend", choices, 2)
        if idx == 0:
            _print_info("  Get key at: https://openrouter.ai/keys")
            value = _prompt("    OPENROUTER_API_KEY", password=True)
            if value and value.strip():
                save_env_value("OPENROUTER_API_KEY", value.strip())
                _print_success("    Saved")
            else:
                _print_warning("    Skipped")
        elif idx == 1:
            base_url = _prompt("    OPENAI_BASE_URL (blank for OpenAI)").strip() or "https://api.openai.com/v1"
            is_native_openai = base_url_hostname(base_url) == "api.openai.com"
            key_label = "    OPENAI_API_KEY" if is_native_openai else "    API key"
            api_key = _prompt(key_label, password=True)
            if api_key and api_key.strip():
                save_env_value("OPENAI_API_KEY", api_key.strip())
                # Save vision base URL to config (not .env — only secrets go there)
                _cfg = load_config()
                _aux = _cfg.setdefault("auxiliary", {}).setdefault("vision", {})
                _aux["base_url"] = base_url
                save_config(_cfg)
                if is_native_openai:
                    save_env_value("AUXILIARY_VISION_MODEL", "gpt-4o-mini")
                _print_success("    Saved")
            else:
                _print_warning("    Skipped")
        return

    requirements = TOOLSET_ENV_REQUIREMENTS.get(ts_key, [])
    if not requirements:
        return

    missing = [(var, url) for var, url in requirements if not get_env_value(var)]
    if not missing:
        return

    ts_label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts_key), ts_key)
    print()
    print(color(f"  {ts_label} requires configuration:", Colors.YELLOW))

    for var, url in missing:
        if url:
            _print_info(f"  Get key at: {url}")
        value = _prompt(f"    {var}", password=True)
        if value and value.strip():
            save_env_value(var, value.strip())
            _print_success("    Saved")
        else:
            _print_warning("    Skipped")


def _reconfigure_tool(
    config: dict,
    *,
    force_fresh: bool = True,
):
    """Let user reconfigure an existing tool's provider or API key."""
    # Build list of configurable tools that are currently set up
    configurable = []
    for ts_key, ts_label, _ in _get_effective_configurable_toolsets():
        cat = TOOL_CATEGORIES.get(ts_key)
        reqs = TOOLSET_ENV_REQUIREMENTS.get(ts_key)
        if cat or reqs:
            if (
                _toolset_has_keys(ts_key, config, force_fresh=force_fresh)
                or _toolset_enabled_for_reconfigure(ts_key, config)
            ):
                configurable.append((ts_key, ts_label))

    if not configurable:
        _print_info("No configured tools to reconfigure.")
        return

    choices = [label for _, label in configurable]
    choices.append("Cancel")

    idx = _prompt_choice("  Which tool would you like to reconfigure?", choices, len(choices) - 1)

    if idx >= len(configurable):
        return  # Cancel

    ts_key, ts_label = configurable[idx]
    cat = TOOL_CATEGORIES.get(ts_key)

    if cat:
        _configure_tool_category_for_reconfig(
            ts_key,
            cat,
            config,
            force_fresh=force_fresh,
        )
    else:
        _reconfigure_simple_requirements(ts_key)

    save_config(config)


def _toolset_enabled_for_reconfigure(ts_key: str, config: dict) -> bool:
    """Return True if a configurable toolset is enabled anywhere.

    Reconfigure must include enabled-but-unconfigured categories so users can
    finish provider/API-key setup without disabling and re-enabling the toolset.
    """
    for platform in PLATFORMS:
        if not _toolset_allowed_for_platform(ts_key, platform):
            continue
        try:
            enabled = _get_platform_tools(
                config,
                platform,
                include_default_mcp_servers=False,
            )
        except Exception:
            continue
        if ts_key in enabled:
            return True
    return False


def _configure_tool_category_for_reconfig(
    ts_key: str,
    cat: dict,
    config: dict,
    *,
    force_fresh: bool = True,
):
    """Reconfigure a tool category - provider selection + API key update."""
    icon = cat.get("icon", "")
    name = cat["name"]
    providers = _visible_providers(cat, config, force_fresh=force_fresh)

    if len(providers) == 1:
        provider = providers[0]
        print()
        print(color(f"  --- {icon} {name} ({provider['name']}) ---", Colors.CYAN))
        _reconfigure_provider(provider, config, force_fresh=force_fresh)
    else:
        print()
        print(color(f"  --- {icon} {name} - Choose a provider ---", Colors.CYAN))
        print()

        provider_choices = []
        for p in providers:
            badge = f" [{p['badge']}]" if p.get("badge") else ""
            tag = f" — {p['tag']}" if p.get("tag") else ""
            configured = ""
            env_vars = p.get("env_vars", [])
            if not env_vars or all(get_env_value(v["key"]) for v in env_vars):
                if _is_provider_active(p, config, force_fresh=force_fresh):
                    configured = " [active]"
                elif not env_vars:
                    configured = ""
                else:
                    configured = " [configured]"
            provider_choices.append(f"{p['name']}{badge}{tag}{configured}")

        default_idx = _detect_active_provider_index(
            providers,
            config,
            force_fresh=force_fresh,
        )

        provider_idx = _prompt_choice("  Select provider:", provider_choices, default_idx)
        _reconfigure_provider(
            providers[provider_idx],
            config,
            force_fresh=force_fresh,
        )


def _reconfigure_provider(
    provider: dict,
    config: dict,
    *,
    force_fresh: bool = True,
):
    """Reconfigure a provider - update API keys."""
    env_vars = provider.get("env_vars", [])

    # Tools run locally as configured — clear any stale gateway flag left on
    # this provider's category section from a previous config.
    for cat_key, cat in TOOL_CATEGORIES.items():
        if provider in cat.get("providers", []):
            section = config.get(cat_key)
            if isinstance(section, dict) and section.get("use_gateway"):
                section["use_gateway"] = False
            break

    if not env_vars:
        if provider.get("post_setup"):
            _run_post_setup(provider["post_setup"])
        _print_success(f"  {provider['name']} - no configuration needed!")
        return

    for var in env_vars:
        existing = get_env_value(var["key"])
        if existing:
            _print_info(f"  {var['key']}: configured ({existing[:8]}...)")
        url = var.get("url", "")
        if url:
            _print_info(f"  Get yours at: {url}")
        default_val = var.get("default", "")
        value = _prompt(f"    {var.get('prompt', var['key'])} (Enter to keep current)", password=not default_val)
        if value and value.strip():
            save_env_value(var["key"], value.strip())
            _print_success("    Updated")
        else:
            _print_info("    Kept current")

    if provider.get("post_setup"):
        _run_post_setup(provider["post_setup"])


def _reconfigure_simple_requirements(ts_key: str):
    """Reconfigure simple env var requirements."""
    requirements = TOOLSET_ENV_REQUIREMENTS.get(ts_key, [])
    if not requirements:
        return

    ts_label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts_key), ts_key)
    print()
    print(color(f"  {ts_label}:", Colors.CYAN))

    for var, url in requirements:
        existing = get_env_value(var)
        if existing:
            _print_info(f"  {var}: configured ({existing[:8]}...)")
        if url:
            _print_info(f"  Get key at: {url}")
        value = _prompt(f"    {var} (Enter to keep current)", password=True)
        if value and value.strip():
            save_env_value(var, value.strip())
            _print_success("    Updated")
        else:
            _print_info("    Kept current")


# ─── Main Entry Point ─────────────────────────────────────────────────────────

def tools_command(args=None, first_install: bool = False, config: dict = None):
    """Entry point for `fan tools` and `fan setup tools`.

    Args:
        first_install: When True (set by the setup wizard on fresh installs),
            skip the platform menu, go straight to the CLI checklist, and
            prompt for API keys on all enabled tools that need them.
        config: Optional config dict to use.  When called from the setup
            wizard, the wizard passes its own dict so that platform_toolsets
            are written into it and survive the wizard's final save_config().
    """
    if config is None:
        config = load_config()
    enabled_platforms = _get_enabled_platforms()

    print()

    # Non-interactive summary mode for CLI usage
    if getattr(args, "summary", False):
        total = len(_get_effective_configurable_toolsets())
        print(color("⚕ Tool Summary", Colors.CYAN, Colors.BOLD))
        print()
        summary = _platform_toolset_summary(config, enabled_platforms)
        for pkey in enabled_platforms:
            pinfo = PLATFORMS[pkey]
            enabled = summary.get(pkey, set())
            count = len(enabled)
            print(color(f"  {pinfo['label']}", Colors.BOLD) + color(f"  ({count}/{total})", Colors.DIM))
            if enabled:
                for ts_key in sorted(enabled):
                    label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts_key), ts_key)
                    print(color(f"    ✓ {label}", Colors.GREEN))
            else:
                print(color("    (none enabled)", Colors.DIM))
        print()
        return
    print(color("⚕ Fan Tool Configuration", Colors.CYAN, Colors.BOLD))
    print(color("  Enable or disable tools per local runtime.", Colors.DIM))
    print(color("  Tools that need API keys will be configured when enabled.", Colors.DIM))
    print()

    # ── First-time install: linear flow, no runtime menu ──
    if first_install:
        for pkey in enabled_platforms:
            pinfo = PLATFORMS[pkey]
            current_enabled = _get_platform_tools(config, pkey, include_default_mcp_servers=False)

            # Uncheck toolsets that should be off by default
            checklist_preselected = current_enabled - _DEFAULT_OFF_TOOLSETS

            # Show checklist
            new_enabled = _prompt_toolset_checklist(pinfo["label"], checklist_preselected, pkey)

            # Only diff against toolsets the checklist actually offered. The
            # resolved ``current_enabled`` can include non-configurable toolsets
            # (e.g. ``kanban``, recovered platform composites) the user was
            # never shown a checkbox for; without this scope the summary would
            # print spurious ``- kanban`` removals even though the config keeps
            # them. See _checklist_toolset_keys.
            _diff_universe = _checklist_toolset_keys(pkey)
            added = (new_enabled - current_enabled) & _diff_universe
            removed = (current_enabled - new_enabled) & _diff_universe
            if added:
                for ts in sorted(added):
                    label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts), ts)
                    print(color(f"  + {label}", Colors.GREEN))
            if removed:
                for ts in sorted(removed):
                    label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts), ts)
                    print(color(f"  - {label}", Colors.RED))

            # Walk through ALL selected tools that have provider options or
            # need API keys. This ensures browser/runtime options are shown even when
            # a free provider exists.
            to_configure = [
                ts_key for ts_key in sorted(new_enabled)
                if (TOOL_CATEGORIES.get(ts_key) or TOOLSET_ENV_REQUIREMENTS.get(ts_key))
            ]

            if to_configure:
                print()
                print(color(f"  Configuring {len(to_configure)} tool(s):", Colors.YELLOW))
                for ts_key in to_configure:
                    label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts_key), ts_key)
                    print(color(f"    • {label}", Colors.DIM))
                print(color("  You can skip any tool you don't need right now.", Colors.DIM))
                print()
                for ts_key in to_configure:
                    _configure_toolset(ts_key, config)

            _save_platform_tools(config, pkey, new_enabled)
            save_config(config)
            print(color(f"  ✓ Saved {pinfo['label']} tool configuration", Colors.GREEN))
            print()

        return

    # ── Returning user: runtime menu loop ──
    # Build runtime choices
    platform_choices = []
    platform_keys = []
    for pkey in enabled_platforms:
        pinfo = PLATFORMS[pkey]
        current = _get_platform_tools(config, pkey, include_default_mcp_servers=False)
        count = len(current)
        total = len(_get_effective_configurable_toolsets())
        platform_choices.append(f"Configure {pinfo['label']}  ({count}/{total} enabled)")
        platform_keys.append(pkey)

    if len(platform_keys) > 1:
        platform_choices.append("Configure all local runtimes (global)")
    platform_choices.append("Reconfigure an existing tool's provider or API key")

    # Show MCP option if any MCP servers are configured
    _has_mcp = bool(config.get("mcp_servers"))
    if _has_mcp:
        platform_choices.append("Configure MCP server tools")

    platform_choices.append("Done")

    # Index offsets for the extra options after per-platform entries
    _global_idx = len(platform_keys) if len(platform_keys) > 1 else -1
    _reconfig_idx = len(platform_keys) + (1 if len(platform_keys) > 1 else 0)
    _mcp_idx = (_reconfig_idx + 1) if _has_mcp else -1
    _done_idx = _reconfig_idx + (2 if _has_mcp else 1)

    while True:
        idx = _prompt_choice("Select an option:", platform_choices, default=0)

        # "Done" selected
        if idx == _done_idx:
            break

        # "Reconfigure" selected
        if idx == _reconfig_idx:
            _reconfigure_tool(config, force_fresh=True)
            print()
            continue

        # "Configure MCP tools" selected
        if idx == _mcp_idx:
            _configure_mcp_tools_interactive(config)
            print()
            continue

        # "Configure all platforms (global)" selected
        if idx == _global_idx:
            # Use the union of all platforms' current tools as the starting state
            all_current = set()
            for pk in platform_keys:
                all_current |= _get_platform_tools(config, pk, include_default_mcp_servers=False)
            new_enabled = _prompt_toolset_checklist(
                "All platforms",
                all_current,
                force_fresh=True,
            )
            if new_enabled != all_current:
                for pk in platform_keys:
                    prev = _get_platform_tools(config, pk, include_default_mcp_servers=False)
                    # Scope the printed diff to the checklist's universe (see
                    # _checklist_toolset_keys) so non-configurable toolsets like
                    # ``kanban`` aren't reported as added/removed.
                    _diff_universe = _checklist_toolset_keys(pk)
                    added = (new_enabled - prev) & _diff_universe
                    removed = (prev - new_enabled) & _diff_universe
                    pinfo_inner = PLATFORMS[pk]
                    if added or removed:
                        print(color(f"  {pinfo_inner['label']}:", Colors.DIM))
                        for ts in sorted(added):
                            label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts), ts)
                            print(color(f"    + {label}", Colors.GREEN))
                        for ts in sorted(removed):
                            label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts), ts)
                            print(color(f"    - {label}", Colors.RED))
                    # Configure API keys for newly enabled tools
                    for ts_key in sorted(added):
                        if (TOOL_CATEGORIES.get(ts_key) or TOOLSET_ENV_REQUIREMENTS.get(ts_key)):
                            if _toolset_needs_configuration_prompt(
                                ts_key,
                                config,
                                force_fresh=True,
                            ):
                                _configure_toolset(ts_key, config)
                    _save_platform_tools(config, pk, new_enabled)
                save_config(config)
                print(color("  ✓ Saved configuration for all platforms", Colors.GREEN))
                # Update choice labels
                for ci, pk in enumerate(platform_keys):
                    new_count = len(_get_platform_tools(config, pk, include_default_mcp_servers=False))
                    total = len(_get_effective_configurable_toolsets())
                    platform_choices[ci] = f"Configure {PLATFORMS[pk]['label']}  ({new_count}/{total} enabled)"
            else:
                print(color("  No changes", Colors.DIM))
            print()
            continue

        pkey = platform_keys[idx]
        pinfo = PLATFORMS[pkey]

        # Get current enabled toolsets for this platform
        current_enabled = _get_platform_tools(config, pkey, include_default_mcp_servers=False)

        # Show checklist
        new_enabled = _prompt_toolset_checklist(
            pinfo["label"],
            current_enabled,
            force_fresh=True,
        )

        if new_enabled != current_enabled:
            # Scope the printed diff to the checklist's universe (see
            # _checklist_toolset_keys) so non-configurable toolsets like
            # ``kanban`` aren't reported as added/removed.
            _diff_universe = _checklist_toolset_keys(pkey)
            added = (new_enabled - current_enabled) & _diff_universe
            removed = (current_enabled - new_enabled) & _diff_universe

            if added:
                for ts in sorted(added):
                    label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts), ts)
                    print(color(f"  + {label}", Colors.GREEN))
            if removed:
                for ts in sorted(removed):
                    label = next((l for k, l, _ in _get_effective_configurable_toolsets() if k == ts), ts)
                    print(color(f"  - {label}", Colors.RED))

            # Configure newly enabled toolsets that need API keys
            for ts_key in sorted(added):
                if (TOOL_CATEGORIES.get(ts_key) or TOOLSET_ENV_REQUIREMENTS.get(ts_key)):
                    if _toolset_needs_configuration_prompt(
                        ts_key,
                        config,
                        force_fresh=True,
                    ):
                        _configure_toolset(ts_key, config)

            _save_platform_tools(config, pkey, new_enabled)
            save_config(config)
            print(color(f"  ✓ Saved {pinfo['label']} configuration", Colors.GREEN))
        else:
            print(color(f"  No changes to {pinfo['label']}", Colors.DIM))

        print()

        # Update the choice label with new count
        new_count = len(_get_platform_tools(config, pkey, include_default_mcp_servers=False))
        total = len(_get_effective_configurable_toolsets())
        platform_choices[idx] = f"Configure {pinfo['label']}  ({new_count}/{total} enabled)"

    print()
    from fan_constants import display_fan_home
    print(color(f"  Tool configuration saved to {display_fan_home()}/config.yaml", Colors.DIM))
    print(color("  Changes take effect in the next local session.", Colors.DIM))
    print()


# ─── MCP Tools Interactive Configuration ─────────────────────────────────────


def _configure_mcp_tools_interactive(config: dict):
    """Probe MCP servers for available tools and let user toggle them on/off.

    Connects to each configured MCP server, discovers tools, then shows
    a per-server curses checklist.  Writes changes back as ``tools.exclude``
    entries in config.yaml.
    """
    from fan_cli.curses_ui import curses_checklist

    mcp_servers = config.get("mcp_servers") or {}
    if not mcp_servers:
        _print_info("No MCP servers configured.")
        return

    # Count enabled servers
    enabled_names = [
        k for k, v in mcp_servers.items()
        if v.get("enabled", True) not in {False, "false", "0", "no", "off"}
    ]
    if not enabled_names:
        _print_info("All MCP servers are disabled.")
        return

    print()
    print(color("  Discovering tools from MCP servers...", Colors.YELLOW))
    print(color(f"  Connecting to {len(enabled_names)} server(s): {', '.join(enabled_names)}", Colors.DIM))

    try:
        from tools.mcp_tool import probe_mcp_server_tools
        server_tools = probe_mcp_server_tools()
    except Exception as exc:
        _print_error(f"Failed to probe MCP servers: {exc}")
        return

    if not server_tools:
        _print_warning("Could not discover tools from any MCP server.")
        _print_info("Check that server commands/URLs are correct and dependencies are installed.")
        return

    # Report discovery results
    failed = [n for n in enabled_names if n not in server_tools]
    if failed:
        for name in failed:
            _print_warning(f"  Could not connect to '{name}'")

    total_tools = sum(len(tools) for tools in server_tools.values())
    print(color(f"  Found {total_tools} tool(s) across {len(server_tools)} server(s)", Colors.GREEN))
    print()

    any_changes = False

    for server_name, tools in server_tools.items():
        if not tools:
            _print_info(f"  {server_name}: no tools found")
            continue

        srv_cfg = mcp_servers.get(server_name, {})
        tools_cfg = srv_cfg.get("tools") or {}
        include_list = tools_cfg.get("include") or []
        exclude_list = tools_cfg.get("exclude") or []

        # Build checklist labels
        labels = []
        for tool_name, description in tools:
            desc_short = description[:70] + "..." if len(description) > 70 else description
            if desc_short:
                labels.append(f"{tool_name}  ({desc_short})")
            else:
                labels.append(tool_name)

        # Determine which tools are currently enabled
        pre_selected: Set[int] = set()
        tool_names = [t[0] for t in tools]
        for i, tool_name in enumerate(tool_names):
            if include_list:
                # Include mode: only included tools are selected
                if tool_name in include_list:
                    pre_selected.add(i)
            elif exclude_list:
                # Exclude mode: everything except excluded
                if tool_name not in exclude_list:
                    pre_selected.add(i)
            else:
                # No filter: all enabled
                pre_selected.add(i)

        chosen = curses_checklist(
            f"MCP Server: {server_name}  ({len(tools)} tools)",
            labels,
            pre_selected,
            cancel_returns=pre_selected,
        )

        if chosen == pre_selected:
            _print_info(f"  {server_name}: no changes")
            continue

        # Compute new include list (the chosen tools). We standardize on
        # tools.include across the codebase (catalog installs, fan mcp
        # configure, and this UI) so a server\'s on-disk config shape doesn\'t
        # depend on which UI the user touched last.
        chosen_names = [tool_names[i] for i in sorted(chosen)]

        # Update config
        srv_cfg = mcp_servers.setdefault(server_name, {})
        tools_cfg = srv_cfg.setdefault("tools", {})

        if len(chosen) == len(tools):
            # All tools enabled — clear filters (cleanest config shape; the
            # server\'s native tool set is the active set, and any tools the
            # server adds later are auto-enabled).
            tools_cfg.pop("exclude", None)
            tools_cfg.pop("include", None)
        else:
            tools_cfg["include"] = chosen_names
            # Drop any legacy exclude block — we\'re include-mode now.
            tools_cfg.pop("exclude", None)

        enabled_count = len(chosen)
        disabled_count = len(tools) - enabled_count
        _print_success(
            f"  {server_name}: {enabled_count} enabled, {disabled_count} disabled"
        )
        any_changes = True

    if any_changes:
        save_config(config)
        print()
        print(color("  ✓ MCP tool configuration saved", Colors.GREEN))
    else:
        print(color("  No changes to MCP tools", Colors.DIM))


# ─── Non-interactive disable/enable ──────────────────────────────────────────


def _apply_toolset_change(config: dict, platform: str, toolset_names: List[str], action: str):
    """Add or remove built-in toolsets for a platform."""
    enabled = _get_platform_tools(config, platform, include_default_mcp_servers=False)
    if action == "disable":
        updated = enabled - set(toolset_names)
    else:
        updated = enabled | set(toolset_names)
    _save_platform_tools(config, platform, updated)


def _apply_mcp_change(config: dict, targets: List[str], action: str) -> Set[str]:
    """Add or remove specific MCP tools from a server's exclude list.

    Returns the set of server names that were not found in config.
    """
    failed_servers: Set[str] = set()
    mcp_servers = config.get("mcp_servers") or {}

    for target in targets:
        server_name, tool_name = target.split(":", 1)
        if server_name not in mcp_servers:
            failed_servers.add(server_name)
            continue
        tools_cfg = mcp_servers[server_name].setdefault("tools", {})
        exclude = list(tools_cfg.get("exclude") or [])
        if action == "disable":
            if tool_name not in exclude:
                exclude.append(tool_name)
        else:
            exclude = [t for t in exclude if t != tool_name]
        tools_cfg["exclude"] = exclude

    return failed_servers


def _print_tools_list(enabled_toolsets: set, mcp_servers: dict, platform: str = "cli"):
    """Print a summary of enabled/disabled toolsets and MCP tool filters."""
    effective_all = _get_effective_configurable_toolsets()
    effective = [
        (k, l, d) for (k, l, d) in effective_all
        if _toolset_allowed_for_platform(k, platform)
    ]
    builtin_keys = {ts_key for ts_key, _, _ in CONFIGURABLE_TOOLSETS}

    print(f"Built-in toolsets ({platform}):")
    for ts_key, label, _ in effective:
        if ts_key not in builtin_keys:
            continue
        status = (color("✓ enabled", Colors.GREEN) if ts_key in enabled_toolsets
                  else color("✗ disabled", Colors.RED))
        print(f"  {status}  {ts_key}  {color(label, Colors.DIM)}")

    # Plugin toolsets
    plugin_entries = [(k, l) for k, l, _ in effective if k not in builtin_keys]
    if plugin_entries:
        print()
        print(f"Plugin toolsets ({platform}):")
        for ts_key, label in plugin_entries:
            status = (color("✓ enabled", Colors.GREEN) if ts_key in enabled_toolsets
                      else color("✗ disabled", Colors.RED))
            print(f"  {status}  {ts_key}  {color(label, Colors.DIM)}")

    if mcp_servers:
        print()
        print("MCP servers:")
        for srv_name, srv_cfg in mcp_servers.items():
            tools_cfg = srv_cfg.get("tools") or {}
            exclude = tools_cfg.get("exclude") or []
            include = tools_cfg.get("include") or []
            if include:
                _print_info(f"{srv_name}  [include only: {', '.join(include)}]")
            elif exclude:
                _print_info(f"{srv_name}  [excluded: {color(', '.join(exclude), Colors.YELLOW)}]")
            else:
                _print_info(f"{srv_name}  {color('all tools enabled', Colors.DIM)}")


def tools_disable_enable_command(args):
    """Enable, disable, or list tools for a platform.

    Built-in toolsets use plain names (e.g. ``browser``, ``memory``).
    MCP tools use ``server:tool`` notation (e.g. ``github:create_issue``).
    """
    action = args.tools_action
    platform = getattr(args, "platform", "cli")
    config = load_config()

    if platform not in PLATFORMS:
        _print_error(f"Unknown platform '{platform}'. Valid: {', '.join(PLATFORMS)}")
        return

    if action == "list":
        _print_tools_list(_get_platform_tools(config, platform, include_default_mcp_servers=False),
                          config.get("mcp_servers") or {}, platform)
        return

    targets: List[str] = args.names
    toolset_targets = [t for t in targets if ":" not in t]
    mcp_targets = [t for t in targets if ":" in t]

    valid_toolsets = {ts_key for ts_key, _, _ in CONFIGURABLE_TOOLSETS} | _get_plugin_toolset_keys()
    unknown_toolsets = [t for t in toolset_targets if t not in valid_toolsets]
    if unknown_toolsets:
        for name in unknown_toolsets:
            _print_error(f"Unknown toolset '{name}'")
        toolset_targets = [t for t in toolset_targets if t in valid_toolsets]

    # Reject platform-scoped toolsets on platforms that don't allow them.
    restricted_targets = [
        t for t in toolset_targets
        if not _toolset_allowed_for_platform(t, platform)
    ]
    if restricted_targets:
        for name in restricted_targets:
            allowed = sorted(_TOOLSET_PLATFORM_RESTRICTIONS.get(name) or set())
            _print_error(
                f"Toolset '{name}' is not available on platform '{platform}' "
                f"(only: {', '.join(allowed)})"
            )
        toolset_targets = [t for t in toolset_targets if t not in restricted_targets]

    if toolset_targets:
        _apply_toolset_change(config, platform, toolset_targets, action)

    failed_servers: Set[str] = set()
    if mcp_targets:
        failed_servers = _apply_mcp_change(config, mcp_targets, action)
        for srv in failed_servers:
            _print_error(f"MCP server '{srv}' not found in config")

    save_config(config)

    successful = [
        t for t in targets
        if t not in unknown_toolsets and (":" not in t or t.split(":")[0] not in failed_servers)
    ]
    if successful:
        verb = "Disabled" if action == "disable" else "Enabled"
        _print_success(f"{verb}: {', '.join(successful)}")
