"""Shared helpers for classifying tool result payloads."""

from __future__ import annotations

import json
from typing import Any


FILE_MUTATING_TOOL_NAMES = frozenset({"write_file", "patch"})

# Interrupted calls are discarded only when they are known read-only. Unknown,
# plugin, MCP, browser-action, and mutation tools are conservatively treated as
# effect-capable so replay cannot silently repeat an operation after a restart.
NO_EFFECT_TOOL_NAMES = frozenset(
    {
        "read_file",
        "search_files",
        "session_search",
        "skill_view",
        "skills_list",
        "web_extract",
        "web_search",
        "vision_analyze",
        "browser_observe",
        "browser_search_page",
        "browser_find_elements",
        "browser_page_content",
        "browser_events",
        "browser_targets",
        "browser_target_info",
        "browser_dropdown_options",
        "browser_storage_state",
        "browser_wait",
        "browser_settle",
        "read_terminal",
    }
)


def tool_may_have_side_effect(tool_name: str) -> bool:
    """Whether an interrupted call must be retained as potentially applied."""
    return tool_name not in NO_EFFECT_TOOL_NAMES


def file_mutation_result_landed(tool_name: str, result: Any) -> bool:
    """Return True when a file mutation result proves the write landed."""
    if tool_name not in FILE_MUTATING_TOOL_NAMES or not isinstance(result, str):
        return False
    try:
        data = json.loads(result.strip())
    except Exception:
        return False
    if not isinstance(data, dict) or data.get("error"):
        return False
    if tool_name == "write_file":
        return "bytes_written" in data
    if tool_name == "patch":
        return data.get("success") is True
    return False
