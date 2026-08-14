"""Replay-history cleanup shared by every Fan session-resume path.

An interrupted tool loop can leave a persisted assistant tool-call with no
result, or an assistant/tool block whose result explicitly says it was
interrupted.  Replaying either structure makes a resumed model re-issue the
same action.  These helpers remove only that model-facing poison; the gateway
keeps the original transcript for the user-facing audit trail.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List

from agent.tool_dispatch_helpers import make_tool_result_message
from agent.tool_result_classification import tool_may_have_side_effect

logger = logging.getLogger(__name__)


def is_interrupted_tool_result(content: Any) -> bool:
    """Return whether *content* is Fan's persisted interrupt marker."""
    if not isinstance(content, str):
        return False
    lowered = content.lower()
    if "[command interrupted]" in lowered:
        return True
    return (
        "exit_code" in lowered
        and ("130" in lowered or "-1" in lowered)
        and "interrupt" in lowered
    )


def strip_interrupted_tool_tails(
    history: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Remove interrupted assistant→tool blocks while preserving clean ones."""
    if not history:
        return history

    cleaned: List[Dict[str, Any]] = []
    index = 0
    while index < len(history):
        message = history[index]
        if not isinstance(message, dict):
            cleaned.append(message)
            index += 1
            continue
        if message.get("role") == "assistant" and message.get("tool_calls"):
            end = index + 1
            results: List[Dict[str, Any]] = []
            while end < len(history):
                candidate = history[end]
                if not isinstance(candidate, dict) or candidate.get("role") != "tool":
                    break
                results.append(candidate)
                end += 1
            if results and any(
                is_interrupted_tool_result(result.get("content"))
                for result in results
            ):
                calls = message.get("tool_calls") or []
                if any(
                    tool_may_have_side_effect(
                        str((call.get("function") or {}).get("name") or "")
                    )
                    for call in calls
                    if isinstance(call, dict)
                ):
                    call_names = {
                        str(call.get("id") or call.get("call_id") or ""): str(
                            (call.get("function") or {}).get("name") or ""
                        )
                        for call in calls
                        if isinstance(call, dict)
                    }
                    # Keep successful sibling results and turn an interrupted
                    # result into an explicit recovery outcome.  Removing the
                    # whole block made the model repeat a tool that might have
                    # already changed browser, filesystem, or external state.
                    cleaned.append(message)
                    for result in results:
                        if not is_interrupted_tool_result(result.get("content")):
                            cleaned.append(result)
                            continue
                        recovered = dict(result)
                        name = call_names.get(str(result.get("tool_call_id") or ""), "")
                        disposition = "unknown" if tool_may_have_side_effect(name) else "none"
                        recovered["effect_disposition"] = disposition
                        recovered["content"] = (
                            "[Recovery note: this tool may have executed before the "
                            "interruption, and its outcome is unknown. Inspect the "
                            "current state before deciding whether to retry.]"
                            if disposition == "unknown"
                            else "[Recovery note: the read-only tool did not finish "
                            "before the interruption and produced no side effects.]"
                        )
                        cleaned.append(recovered)
                    index = end
                    continue
                logger.debug(
                    "Stripping interrupted read-only assistant/tool replay block (%d-%d)",
                    index,
                    end - 1,
                )
                index = end
                continue
        if (
            message.get("role") == "tool"
            and is_interrupted_tool_result(message.get("content"))
        ):
            logger.debug("Stripping orphan interrupted tool result from replay history")
            index += 1
            continue
        cleaned.append(message)
        index += 1
    return cleaned


def strip_dangling_tool_call_tail(
    history: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Drop an unanswered trailing assistant tool-call from replay input."""
    if not history:
        return history
    last = history[-1]
    if not (
        isinstance(last, dict)
        and last.get("role") == "assistant"
        and last.get("tool_calls")
    ):
        return history
    tool_calls = last.get("tool_calls") or []
    if any(
        tool_may_have_side_effect(str((call.get("function") or {}).get("name") or ""))
        for call in tool_calls
        if isinstance(call, dict)
    ):
        recovered = list(history)
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            name = str(function.get("name") or "unknown")
            call_id = str(call.get("id") or call.get("call_id") or "")
            disposition = "unknown" if tool_may_have_side_effect(name) else "none"
            content = (
                "[Recovery note: this tool may have executed before Fan stopped, and "
                "its outcome is unknown. Inspect the current state before deciding "
                "whether to retry.]"
                if disposition == "unknown"
                else "[Recovery note: the read-only tool did not finish and produced "
                "no side effects.]"
            )
            recovered.append(
                make_tool_result_message(
                    name,
                    content,
                    call_id,
                    effect_disposition=disposition,
                )
            )
        logger.warning(
            "Recovered dangling side-effecting tool call(s) as unknown instead of erasing them"
        )
        return recovered
    logger.debug(
        "Stripping dangling unanswered read-only assistant tool-call tail (%d call(s))",
        len(tool_calls),
    )
    return history[:-1]


# High-risk confirmations must not survive a restart/resume gap. These are
# deliberately narrow textual confirmations, not generic acknowledgements.
_DANGEROUS_CONFIRMATION_EXPIRY_SECONDS = 60.0
_DANGEROUS_CONFIRMATION_PATTERNS = (
    "confirm forced restart",
    "confirm forced reboot",
    "confirm shutdown",
    "confirm reboot",
    "confirm power off",
    "yes, delete everything",
    "confirm wipe",
    "confirm factory reset",
    "確認強制重開機",
    "確認強制重開",
    "確認重啟",
)
_EXPIRED_CONFIRMATION_SENTINEL = (
    "[A high-risk confirmation previously given here has EXPIRED and must "
    "not be acted on. Ask the user to re-confirm explicitly before "
    "performing any destructive action.]"
)


def is_dangerous_confirmation(content: Any) -> bool:
    """Return whether user text contains a known destructive-action approval."""
    if not isinstance(content, str):
        return False
    text = content.strip().lower()
    return any(pattern in text for pattern in _DANGEROUS_CONFIRMATION_PATTERNS)


def strip_stale_dangerous_confirmations(
    history: List[Dict[str, Any]],
    *,
    now: float | None = None,
    expiry_seconds: float = _DANGEROUS_CONFIRMATION_EXPIRY_SECONDS,
) -> List[Dict[str, Any]]:
    """Redact expired destructive confirmations without breaking role order.

    A desktop process may die after persisting a user's confirmation but before
    the matching tool result. On resume that old text must not look like a new
    authorization. Redact in place rather than dropping the user turn: strict
    provider APIs reject the consecutive assistant messages deletion can leave.
    Histories without timestamps remain untouched for backward compatibility.
    """
    if not history:
        return history
    current_time = time.time() if now is None else now
    cleaned: List[Dict[str, Any]] = []
    for message in history:
        if not (
            isinstance(message, dict)
            and message.get("role") == "user"
            and is_dangerous_confirmation(message.get("content"))
        ):
            cleaned.append(message)
            continue
        timestamp = message.get("timestamp")
        try:
            is_expired = timestamp is not None and (
                current_time - float(timestamp) > expiry_seconds
            )
        except (TypeError, ValueError):
            is_expired = False
        if not is_expired:
            cleaned.append(message)
            continue
        logger.debug(
            "Redacting stale dangerous confirmation from replay history "
            "(age=%.1fs, expiry=%.1fs)",
            current_time - float(timestamp),
            expiry_seconds,
        )
        redacted = dict(message)
        redacted["content"] = _EXPIRED_CONFIRMATION_SENTINEL
        cleaned.append(redacted)
    return cleaned


def sanitize_replay_history(history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return the safe model replay history without mutating persisted rows."""
    if not history:
        return history
    cleaned = strip_interrupted_tool_tails(history)
    cleaned = strip_dangling_tool_call_tail(cleaned)
    return strip_stale_dangerous_confirmations(cleaned)
