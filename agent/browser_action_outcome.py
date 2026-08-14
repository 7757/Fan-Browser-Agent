"""Keep failed browser actions unresolved until a real recovery action lands.

An observation describes the current page; it does not prove that a failed
click, navigation, or input action succeeded.  This module keeps that fact as
small per-turn state and annotates tool results so both the model and the final
user response cannot silently turn an execution error into a success claim.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, MutableMapping

from agent.browser_tool_protocol import is_browser_tool


_ACTION_GROUP_BY_TOOL = {
    "browser_run": "program",
    "browser_navigate": "navigation",
    "browser_search": "navigation",
    "browser_back": "navigation",
    "browser_forward": "navigation",
    "browser_reload": "navigation",
    "browser_new_tab": "navigation",
    "browser_switch_tab": "navigation",
    "browser_close_tab": "navigation",
    "browser_click": "click",
    "browser_find_visual": "click",
    "browser_type": "input",
    "browser_fill_form": "input",
    "browser_send_keys": "input",
    "browser_select": "selection",
    "browser_dialog": "selection",
    "browser_upload": "selection",
    "browser_scroll": "scroll",
    "browser_scroll_to_text": "scroll",
    "browser_drag": "pointer",
    "browser_mouse": "pointer",
    "browser_hover": "pointer",
    "browser_focus": "pointer",
    "browser_evaluate": "script",
    "browser_evaluate_js": "script",
    "browser_cdp": "script",
}


def _error_preview(value: Any) -> str:
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return " ".join(value.split())[:240]
    if isinstance(parsed, Mapping):
        for key in ("error", "message", "reason", "detail"):
            candidate = parsed.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return " ".join(candidate.split())[:240]
    return ""


def _annotate_result(value: Any, state: Mapping[str, Any], *, failed_now: bool) -> Any:
    message = (
        "This browser action did not succeed. A later page observation can only read "
        "the current state; it cannot prove that the action completed. Do not claim the "
        "goal is complete until another browser action in the same category succeeds."
        if failed_now
        else
        "The previous critical browser action remains unresolved. The current read "
        "result is not evidence that the action succeeded. Retry the same category of "
        "action or report honestly that it is incomplete."
    )
    status = {
        "state": "failed" if failed_now else "unresolved",
        "verified": False,
        "failed_tool": str(state.get("tool") or "browser action"),
        "message": message,
    }

    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return f"{value}\n\n[Browser execution verification] {message}"
        if isinstance(parsed, dict):
            parsed["browser_action_status"] = status
            return json.dumps(parsed, ensure_ascii=False)

    if isinstance(value, dict):
        annotated = dict(value)
        annotated["browser_action_status"] = status
        return annotated
    return value


def record_browser_action_outcome(
    state: MutableMapping[str, Any] | None,
    tool_name: str,
    result: Any,
    *,
    failed: bool,
) -> Any:
    """Update one turn's unresolved browser-action state and annotate results."""

    if state is None or not is_browser_tool(tool_name):
        return result

    group = _ACTION_GROUP_BY_TOOL.get(str(tool_name or ""))
    if group and failed:
        state.clear()
        state.update(
            {
                "tool": tool_name,
                "group": group,
                "error_preview": _error_preview(result),
            }
        )
        return _annotate_result(result, state, failed_now=True)

    if group and not failed and state.get("group") == group:
        state.clear()
        return result

    if state:
        return _annotate_result(result, state, failed_now=False)
    return result


def browser_action_failure_footer(state: Mapping[str, Any] | None) -> str:
    if not state:
        return ""
    tool = str(state.get("tool") or "browser action")
    preview = str(state.get("error_preview") or "").strip()
    detail = f" Reason: {preview}" if preview else ""
    return (
        f"Browser execution verification: the critical `{tool}` action failed during "
        "this turn, and no later action in the same category recovered it. The current "
        "goal is not verified as complete. If the text above claims that something was "
        f"clicked or completed, this verification result takes precedence.{detail}"
    )


__all__ = ["browser_action_failure_footer", "record_browser_action_outcome"]
