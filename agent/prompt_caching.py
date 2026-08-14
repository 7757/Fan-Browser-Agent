"""Cache-control marker strategy for compatible chat-completions endpoints.

The current product uses this only for Qwen/Alibaba endpoints that explicitly
support ``cache_control`` markers. Four breakpoints are placed on the system
prompt and the last three non-tool conversation messages.

Pure functions -- no class state, no AIAgent dependency.
"""

import copy
from typing import Any, Dict, List


def _apply_cache_marker(msg: dict, cache_marker: dict) -> bool:
    """Add cache_control to a single message, handling all format variations."""
    role = msg.get("role", "")
    content = msg.get("content")

    if role == "tool":
        return False

    if content is None or content == "":
        return False

    if isinstance(content, str):
        msg["content"] = [
            {"type": "text", "text": content, "cache_control": cache_marker}
        ]
        return True

    if isinstance(content, list) and content:
        last = content[-1]
        if isinstance(last, dict):
            last["cache_control"] = cache_marker
            return True

    return False


def _build_marker() -> Dict[str, str]:
    return {"type": "ephemeral"}


def apply_cache_control(api_messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Apply the system-and-three cache marker strategy.

    Places up to 4 cache_control breakpoints: system prompt + the last 3
    non-system, non-tool messages.

    Returns:
        Deep copy of messages with cache_control breakpoints injected.
    """
    messages = copy.deepcopy(api_messages)
    if not messages:
        return messages

    marker = _build_marker()

    breakpoints_used = 0

    if messages[0].get("role") == "system":
        if _apply_cache_marker(messages[0], marker):
            breakpoints_used += 1

    remaining = 4 - breakpoints_used
    eligible = []
    for i, message in enumerate(messages):
        if message.get("role") in {"system", "tool"}:
            continue
        content = message.get("content")
        if isinstance(content, str) and content:
            eligible.append(i)
        elif isinstance(content, list) and any(isinstance(part, dict) for part in content):
            eligible.append(i)
    for idx in eligible[-remaining:]:
        _apply_cache_marker(messages[idx], marker)

    return messages
