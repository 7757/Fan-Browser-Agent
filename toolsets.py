#!/usr/bin/env python3
"""
Toolsets Module

This module provides a flexible system for defining and managing tool aliases/toolsets.
Toolsets allow you to group tools together for specific scenarios and can be composed
from individual tools or other toolsets.

Features:
- Define custom toolsets with specific tools
- Compose toolsets from other toolsets
- Built-in common toolsets for typical use cases
- Easy extension for new toolsets
- Support for dynamic toolset resolution

Usage:
    from toolsets import get_toolset, resolve_toolset, get_all_toolsets
    
    # Get tools for a specific toolset
    tools = get_toolset("research")
    
    # Resolve a toolset to get all tool names (including from composed toolsets)
    all_tools = resolve_toolset("full_stack")
"""

from typing import List, Dict, Any, Set, Optional


# Shared tool list for local runtime surfaces.
# Edit this once to update those surfaces simultaneously.
_FAN_CORE_TOOLS = [
    # Terminal + process management
    "terminal", "process",
    # File manipulation
    "read_file", "write_file", "patch", "search_files",
    # Vision (screenshot analysis for the browser agent)
    "vision_analyze",
    # Skills
    "skills_list", "skill_view", "skill_manage",
    # Planning & memory
    "todo", "memory",
    # Session history search
    "session_search",
    # User questions and structured information collection
    "collect",
    # Code execution + delegation
    "execute_code", "delegate_task",
    # Cronjob management
    "cronjob",
    # Kanban multi-agent coordination — only in schema when the agent is
    # spawned as a kanban worker (FAN_KANBAN_TASK env set) or the current
    # profile explicitly enables the kanban toolset. Gated via check_fn in
    # tools/kanban_tools.py.
    "kanban_show", "kanban_list",
    "kanban_complete", "kanban_block", "kanban_heartbeat",
    "kanban_comment", "kanban_create", "kanban_link",
    "kanban_unblock",
]



# Core toolset definitions
# These can include individual tools or reference other toolsets
TOOLSETS = {
    # Basic toolsets - individual tool categories
    "x_search": {
        "description": (
            "Search X (Twitter) posts and threads via xAI's built-in "
            "x_search Responses tool. Available when xAI credentials are "
            "configured (SuperGrok OAuth or XAI_API_KEY). Off by default; "
            "enable in `fan tools` → X (Twitter) Search."
        ),
        "tools": ["x_search"],
        "includes": []
    },

    "vision": {
        "description": "Image analysis and vision tools",
        "tools": ["vision_analyze"],
        "includes": []
    },

    

    "terminal": {
        "description": "Terminal/command execution and process management tools",
        "tools": ["terminal", "process"],
        "includes": []
    },
    
    "skills": {
        "description": "Access, create, edit, and manage skill documents with specialized instructions and knowledge",
        "tools": ["skills_list", "skill_view", "skill_manage"],
        "includes": []
    },

    "electron_browser": {
        "description": "Electron-native browser runtime control: observe indexed DOM, search/query/extract page content, navigate, click, type, scroll, keys, targets, diagnostics, and raw CDP through the desktop WebContentsView runtime",
        "tools": [
            "browser_observe", "browser_search_page", "browser_find_elements", "browser_find_visual", "browser_page_content", "browser_search",
            "browser_navigate", "browser_click", "browser_type", "browser_fill_form", "browser_scroll", "browser_scroll_to_text",
            "browser_back", "browser_forward", "browser_reload", "browser_send_keys", "browser_select", "browser_dropdown_options",
            "browser_wait", "browser_settle", "browser_cdp", "browser_events",
            "browser_targets", "browser_target_info", "browser_new_tab", "browser_switch_tab", "browser_close_tab", "browser_dialog",
            "browser_upload", "browser_screenshot", "browser_save_pdf", "browser_har", "browser_save_har", "browser_set_viewport",
            "browser_storage_state", "browser_save_storage_state", "browser_load_storage_state", "browser_grant_permissions",
            "browser_start_screencast", "browser_stop_screencast",
            "browser_network_config", "browser_url_policy", "browser_evaluate", "browser_evaluate_js",
            "browser_mouse", "browser_hover", "browser_focus", "browser_drag", "browser_element", "browser_highlight"
        ],
        "includes": []
    },

    "browser_program": {
        "description": (
            "Electron browser workflows as compact numbered snapshots and "
            "sandboxed multi-step transactions"
        ),
        "tools": [
            "browser_snapshot",
            "browser_run",
            "browser_handoff",
        ],
        "includes": [],
    },

    "cronjob": {
        "description": "Cronjob management tool - create, list, update, pause, resume, remove, and trigger scheduled tasks",
        "tools": ["cronjob"],
        "includes": []
    },
    

    
    "file": {
        "description": "File manipulation tools: read, write, patch (with fuzzy matching), and search (content + files)",
        "tools": ["read_file", "write_file", "patch", "search_files"],
        "includes": []
    },
    
    "todo": {
        "description": "Task planning and tracking for multi-step work",
        "tools": ["todo"],
        "includes": []
    },
    
    "memory": {
        "description": "Persistent memory across sessions (personal notes + user profile)",
        "tools": ["memory"],
        "includes": []
    },

    "context_engine": {
        "description": "Runtime tools exposed by the active context engine",
        "tools": [],
        "includes": []
    },
    
    "session_search": {
        "description": "Search and recall past conversations with summarization",
        "tools": ["session_search"],
        "includes": []
    },
    
    "collect": {
        "description": "Ask questions or collect structured information from the user",
        "tools": ["collect"],
        "includes": []
    },
    
    "code_execution": {
        "description": "Run Python scripts that call tools programmatically (reduces LLM round trips)",
        "tools": ["execute_code"],
        "includes": []
    },
    
    "delegation": {
        "description": "Spawn subagents with isolated context for complex subtasks",
        "tools": ["delegate_task"],
        "includes": []
    },

    # "honcho" toolset removed — Honcho is now a memory provider plugin.
    # Tools are injected via MemoryManager, not the toolset system.


    "kanban": {
        "description": (
            "Kanban multi-agent coordination — only active when the agent "
            "is spawned by the kanban dispatcher (FAN_KANBAN_TASK env "
            "set). The dispatcher runs inside the gateway by default; see "
            "`kanban.dispatch_in_gateway` in config.yaml. Lets workers mark "
            "tasks done with structured handoffs, block for human input, "
            "heartbeat during long ops, comment on threads, and (for "
            "orchestrators) list, unblock, and fan out tasks."
        ),
        "tools": [
            "kanban_show", "kanban_list", "kanban_complete", "kanban_block",
            "kanban_heartbeat", "kanban_comment",
            "kanban_create", "kanban_link",
            "kanban_unblock",
        ],
        "includes": [],
    },



    # Scenario-specific toolsets
    
    "debugging": {
        "description": "Debugging and troubleshooting toolkit",
        "tools": ["terminal", "process"],
        "includes": ["file"]
    },
    
    "safe": {
        "description": "Safe toolkit without terminal access",
        "tools": [],
        "includes": ["vision"]
    },
    
    # ==========================================================================
    # Full Fan toolsets for local runtime surfaces
    #
    # Runtime surfaces share the same core tools.
    # ==========================================================================

    "fan-acp": {
        "description": "Editor integration (VS Code, Zed, JetBrains) — coding-focused tools without messaging, audio, or collect UI",
        "tools": [
            "terminal", "process",
            "read_file", "write_file", "patch", "search_files",
            "vision_analyze",
            "skills_list", "skill_view", "skill_manage",
            "todo", "memory",
            "session_search",
            "execute_code", "delegate_task",
        ],
        "includes": []
    },

    "fan-api-server": {
        "description": "OpenAI-compatible API server — full agent tools accessible via HTTP (no interactive UI tools like collect)",
        "tools": [
            # Terminal + process management
            "terminal", "process",
            # File manipulation
            "read_file", "write_file", "patch", "search_files",
            # Vision + image generation
            "vision_analyze",
            # Skills
            "skills_list", "skill_view", "skill_manage",
            # Planning & memory
            "todo", "memory",
            # Session history search
            "session_search",
            # Code execution + delegation
            "execute_code", "delegate_task",
            # Cronjob management
            "cronjob",
        ],
        "includes": []
    },
    
    "fan-cli": {
        "description": "Full interactive CLI toolset - all default tools plus cronjob management",
        "tools": _FAN_CORE_TOOLS,
        "includes": []
    },

    "fan-cron": {
        # Mirrors fan-cli so cron's "default" toolset is the same set of
        # core tools users see interactively — then `fan tools` filters
        # them down per the platform config. _DEFAULT_OFF_TOOLSETS (e.g.
        # homeassistant) are excluded by _get_platform_tools() unless
        # the user explicitly enables them.
        "description": "Default cron toolset - same core tools as fan-cli; gated by `fan tools`",
        "tools": _FAN_CORE_TOOLS,
        "includes": []
    },

    
    
    
    















}



def get_toolset(name: str) -> Optional[Dict[str, Any]]:
    """
    Get a toolset definition by name.
    
    Args:
        name (str): Name of the toolset
        
    Returns:
        Dict: Toolset definition with description, tools, and includes
        None: If toolset not found
    """
    toolset = TOOLSETS.get(name)

    try:
        from tools.registry import registry
    except Exception:
        return toolset if toolset else None

    if toolset:
        merged_tools = sorted(
            set(toolset.get("tools", []))
            | set(registry.get_tool_names_for_toolset(name))
        )
        return {**toolset, "tools": merged_tools}

    registry_toolset = name
    description = f"Plugin toolset: {name}"
    alias_target = registry.get_toolset_alias_target(name)

    if name not in _get_plugin_toolset_names():
        registry_toolset = alias_target
        if not registry_toolset:
            return None
        description = f"MCP server '{name}' tools"
    else:
        reverse_aliases = {
            canonical: alias
            for alias, canonical in _get_registry_toolset_aliases().items()
            if alias not in TOOLSETS
        }
        alias = reverse_aliases.get(name)
        if alias:
            description = f"MCP server '{alias}' tools"

    return {
        "description": description,
        "tools": registry.get_tool_names_for_toolset(registry_toolset),
        "includes": [],
    }


def resolve_toolset(name: str, visited: Set[str] = None) -> List[str]:
    """
    Recursively resolve a toolset to get all tool names.
    
    This function handles toolset composition by recursively resolving
    included toolsets and combining all tools.
    
    Args:
        name (str): Name of the toolset to resolve
        visited (Set[str]): Set of already visited toolsets (for cycle detection)
        
    Returns:
        List[str]: List of all tool names in the toolset
    """
    if visited is None:
        visited = set()
    
    # Special aliases that represent all tools across every toolset
    # This ensures future toolsets are automatically included without changes.
    if name in {"all", "*"}:
        all_tools: Set[str] = set()
        for toolset_name in get_toolset_names():
            # Use a fresh visited set per branch to avoid cross-branch contamination
            resolved = resolve_toolset(toolset_name, visited.copy())
            all_tools.update(resolved)
        return sorted(all_tools)

    # Check for cycles / already-resolved (diamond deps).
    # Silently return [] — either this is a diamond (not a bug, tools already
    # collected via another path) or a genuine cycle (safe to skip).
    if name in visited:
        return []

    visited.add(name)

    # Get toolset definition
    toolset = get_toolset(name)
    if not toolset:
        # Auto-generate a toolset for plugin platforms (fan-<name>).
        # Gives them _FAN_CORE_TOOLS plus any tools the plugin registered
        # into a toolset matching the platform name.
        # Plugin platform registry is empty in the pure browser-agent build,
        # so there is no auto-generated toolset to resolve here.
        return []

    # Collect direct tools
    tools = set(toolset.get("tools", []))

    # Recursively resolve included toolsets, sharing the visited set across
    # sibling includes so diamond dependencies are only resolved once and
    # cycle warnings don't fire multiple times for the same cycle.
    for included_name in toolset.get("includes", []):
        included_tools = resolve_toolset(included_name, visited)
        tools.update(included_tools)
    
    return sorted(tools)


def resolve_multiple_toolsets(toolset_names: List[str]) -> List[str]:
    """
    Resolve multiple toolsets and combine their tools.
    
    Args:
        toolset_names (List[str]): List of toolset names to resolve
        
    Returns:
        List[str]: Combined list of all tool names (deduplicated)
    """
    all_tools = set()
    
    for name in toolset_names:
        tools = resolve_toolset(name)
        all_tools.update(tools)
    
    return sorted(all_tools)


def bundle_non_core_tools(name: str) -> List[str]:
    """Resolve a Fan platform bundle without shared core agent tools.

    Disabling a platform bundle must not accidentally remove terminal, file,
    memory, or other core tools that are shared with the active platform.
    """
    return sorted(set(resolve_toolset(name)) - set(_FAN_CORE_TOOLS))


def _get_plugin_toolset_names() -> Set[str]:
    """Return toolset names registered by plugins (from the tool registry).

    These are toolsets that exist in the registry but not in the static
    ``TOOLSETS`` dict — i.e. they were added by plugins at load time.
    """
    try:
        from tools.registry import registry
        return {
            toolset_name
            for toolset_name in registry.get_registered_toolset_names()
            if toolset_name not in TOOLSETS
        }
    except Exception:
        return set()


def _get_registry_toolset_aliases() -> Dict[str, str]:
    """Return explicit toolset aliases registered in the live registry."""
    try:
        from tools.registry import registry
        return registry.get_registered_toolset_aliases()
    except Exception:
        return {}


def get_all_toolsets() -> Dict[str, Dict[str, Any]]:
    """
    Get all available toolsets with their definitions.

    Includes both statically-defined toolsets and plugin-registered ones.
    
    Returns:
        Dict: All toolset definitions
    """
    result = dict(TOOLSETS)
    aliases = _get_registry_toolset_aliases()
    for ts_name in _get_plugin_toolset_names():
        display_name = ts_name
        for alias, canonical in aliases.items():
            if canonical == ts_name and alias not in TOOLSETS:
                display_name = alias
                break
        if display_name in result:
            continue
        toolset = get_toolset(display_name)
        if toolset:
            result[display_name] = toolset
    return result


def get_toolset_names() -> List[str]:
    """
    Get names of all available toolsets (excluding aliases).

    Includes plugin-registered toolset names.
    
    Returns:
        List[str]: List of toolset names
    """
    names = set(TOOLSETS.keys())
    aliases = _get_registry_toolset_aliases()
    for ts_name in _get_plugin_toolset_names():
        for alias, canonical in aliases.items():
            if canonical == ts_name and alias not in TOOLSETS:
                names.add(alias)
                break
        else:
            names.add(ts_name)
    return sorted(names)




def validate_toolset(name: str) -> bool:
    """
    Check if a toolset name is valid.
    
    Args:
        name (str): Toolset name to validate
        
    Returns:
        bool: True if valid, False otherwise
    """
    # Accept special alias names for convenience
    if name in {"all", "*"}:
        return True
    if name in TOOLSETS:
        return True
    if name in _get_plugin_toolset_names():
        return True
    return name in _get_registry_toolset_aliases()


def create_custom_toolset(
    name: str,
    description: str,
    tools: List[str] = None,
    includes: List[str] = None
) -> None:
    """
    Create a custom toolset at runtime.
    
    Args:
        name (str): Name for the new toolset
        description (str): Description of the toolset
        tools (List[str]): Direct tools to include
        includes (List[str]): Other toolsets to include
    """
    TOOLSETS[name] = {
        "description": description,
        "tools": tools or [],
        "includes": includes or []
    }




def get_toolset_info(name: str) -> Dict[str, Any]:
    """
    Get detailed information about a toolset including resolved tools.
    
    Args:
        name (str): Toolset name
        
    Returns:
        Dict: Detailed toolset information
    """
    toolset = get_toolset(name)
    if not toolset:
        return None
    
    resolved_tools = resolve_toolset(name)
    
    return {
        "name": name,
        "description": toolset["description"],
        "direct_tools": toolset["tools"],
        "includes": toolset["includes"],
        "resolved_tools": resolved_tools,
        "tool_count": len(resolved_tools),
        "is_composite": bool(toolset["includes"])
    }




if __name__ == "__main__":
    print("Toolsets System Demo")
    print("=" * 60)
    
    print("\nAvailable Toolsets:")
    print("-" * 40)
    for name, toolset in get_all_toolsets().items():
        info = get_toolset_info(name)
        composite = "[composite]" if info["is_composite"] else "[leaf]"
        print(f"  {composite} {name:20} - {toolset['description']}")
        print(f"     Tools: {len(info['resolved_tools'])} total")
    
    print("\nToolset Resolution Examples:")
    print("-" * 40)
    for name in ["terminal", "safe", "debugging"]:
        tools = resolve_toolset(name)
        print(f"\n  {name}:")
        print(f"    Resolved to {len(tools)} tools: {', '.join(sorted(tools))}")
    
    print("\nMultiple Toolset Resolution:")
    print("-" * 40)
    combined = resolve_multiple_toolsets(["vision", "terminal"])
    print("  Combining ['vision', 'terminal']:")
    print(f"    Result: {', '.join(sorted(combined))}")
    
    print("\nCustom Toolset Creation:")
    print("-" * 40)
    create_custom_toolset(
        name="my_custom",
        description="My custom toolset for specific tasks",
        tools=["read_file"],
        includes=["terminal", "vision"]
    )
    custom_info = get_toolset_info("my_custom")
    print("  Created 'my_custom' toolset:")
    print(f"    Description: {custom_info['description']}")
    print(f"    Resolved tools: {', '.join(custom_info['resolved_tools'])}")
