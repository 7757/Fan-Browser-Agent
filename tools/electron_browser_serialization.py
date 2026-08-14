"""Pure model-facing observation and error serialization helpers."""

from __future__ import annotations

import json
import re
from typing import Any

from agent.stale_observation_collapser import PAGE_OBSERVATION_BEGIN, PAGE_OBSERVATION_END


def _tabs_prefix(result: dict[str, Any]) -> str:
    """Render the compact tab header included in model observations."""

    tabs = result.get("tabs")
    if not isinstance(tabs, list) or len(tabs) < 1:
        return ""
    parts = []
    for tab in tabs:
        if not isinstance(tab, dict):
            continue
        mark = " (current)" if tab.get("current") else ""
        stable_id = str(tab.get("stableId") or "").strip()
        tab_ref = stable_id or str(tab.get("tabId"))
        loading = " (loading)" if tab.get("loading") else ""
        label = (
            str(tab.get("title") or "").strip() or str(tab.get("url") or "")
        ).strip()
        parts.append(f"[tab {tab_ref}]{mark}{loading} {label}".strip())
    if not parts:
        return ""
    return "Open tabs (switch with browser_switch_tab <tab id>): " + " | ".join(parts) + "\n\n"


def _obs_page_header(result: dict[str, Any]) -> str:
    """Render the page breadcrumb retained when stale observations collapse."""

    url = title = ""
    for tab in result.get("tabs") or []:
        if isinstance(tab, dict) and tab.get("current"):
            url = str(tab.get("url") or "")
            title = str(tab.get("title") or "")
            break
    url = url or str(result.get("url") or "")
    title = title or str(result.get("title") or "")

    def _clean(value: str, limit: int) -> str:
        return " ".join(str(value).replace("]", "").replace("·", "•").split())[:limit]

    ident = " · ".join(
        part for part in (_clean(title, 60), _clean(url, 160)) if part
    ) or "(unknown page)"
    return f"[page: {ident}]"


_OBS_MARKER_RE = re.compile(
    r"^\[(Start|End) of page\]$"
    r"|^\[[↑↓] ~.*screen\(s\) (above|below).*\]$"
    r"|^\.\.\. \(more content below viewport - scroll to reveal\)$"
    r"|^<page_stats>.*</page_stats>$"
    r"|^<page_info>.*</page_info>$"
)


def _is_blank_observation(result: dict[str, Any], dom: str) -> bool:
    """Return true only for a still-loading page with no usable observation."""

    if result.get("isPdfViewer"):
        return False
    captcha = result.get("captchaState")
    if isinstance(captcha, dict) and captcha.get("detected"):
        return False
    snapshot = result.get("snapshot")
    if not (isinstance(snapshot, dict) and snapshot.get("interactiveCount") == 0):
        return False
    for line in str(dom or "").splitlines():
        stripped = line.strip()
        if not stripped or _OBS_MARKER_RE.match(stripped):
            continue
        return False
    pending = result.get("pendingNetworkRequests")
    if isinstance(pending, list) and pending:
        return True
    tabs = result.get("tabs")
    if isinstance(tabs, list):
        for tab in tabs:
            if isinstance(tab, dict) and tab.get("current") and tab.get("loading"):
                return True
    return False


def _observe_text(
    result: dict[str, Any] | None,
    dom_format: str | None = None,
) -> str:
    if not isinstance(result, dict):
        return ""
    if str(dom_format or "").lower() == "electron":
        dom = str(result.get("text") or "")
    else:
        dom = str(
            result.get("browserUseText")
            or result.get("browserUseDomTreeText")
            or result.get("text")
            or ""
        )
    hint = result.get("truncationHint")
    suffix = ("\n\n⚠️ [Observation truncated] " + str(hint)) if hint else ""
    notices: list[str] = []
    if result.get("isPdfViewer"):
        message = "[PDF viewer] This page is a PDF; its DOM is not interactive."
        path = result.get("pdfDownloadPath")
        if path:
            message += " It was downloaded automatically to: " + str(path)
            message += "\nRead it with read_file instead."
        else:
            message += (
                " The system is downloading it automatically. Use browser_events to "
                "find the completion event's savePath, then read it with read_file."
            )
        notices.append(message)
    if _is_blank_observation(result, dom):
        notices.append(
            "[Observation] The page is still loading—network requests are pending or "
            "the tab is loading—and no interactive elements are available. Call "
            "browser_wait, then browser_observe."
        )
    prefix = "".join(notice + "\n\n" for notice in notices)
    body = prefix + _tabs_prefix(result) + dom + suffix
    body = body.replace(PAGE_OBSERVATION_END, "(…)")
    header = _obs_page_header(result)
    return f"{PAGE_OBSERVATION_BEGIN}\n{header}\n{body}\n{PAGE_OBSERVATION_END}"


def format_observation_for_model(
    result: dict[str, Any] | None,
    dom_format: str | None = None,
) -> str:
    """Public formatter for correctness paths that force an unbound observe."""

    return _observe_text(result, dom_format)


_BROWSER_REPLAN_ERROR_CODES = frozenset({
    "STALE_ELEMENT_REFERENCE",
    "BROWSER_STATE_CHANGED",
    "BROWSER_SESSION_MISMATCH",
    "BROWSER_DECISION_TOKEN_MISSING",
    "ELEMENT_NOT_FOUND",
    "TAB_NOT_FOUND",
})


def _is_stale_index_error(err: Any, code: Any = None) -> bool:
    """Return whether an action was rejected against a stale browser snapshot."""

    if str(code or "") in _BROWSER_REPLAN_ERROR_CODES:
        return True
    return isinstance(err, str) and "is stale" in err and "page changed" in err


_ERROR_HINTS: tuple[tuple[str, str], ...] = (
    (
        "option not found",
        "Do not guess or rewrite option names. Use browser_dropdown_options to read the "
        "exact visible text for this index, then call browser_select again with the "
        "returned text unchanged. Recovery is complete only after that selection succeeds.",
    ),
    (
        "is disabled",
        "This element is disabled and cannot be operated. Choose another target or "
        "complete the prerequisite that enables it, such as filling required fields.",
    ),
    (
        "is not visible or has no bounding box",
        "This element is not visible. Scroll to it with browser_scroll or confirm it "
        "appeared with browser_observe before acting.",
    ),
    (
        "is not available",
        "This element index is stale because the page may have changed. Call "
        "browser_observe and act with a current index.",
    ),
    (
        "does not exist in the browser snapshot",
        "This element is not part of the DOM shown to the model in this turn. Call "
        "browser_observe and act with a current index.",
    ),
    (
        "decision snapshot is unavailable",
        "The action was safely skipped to avoid operating the wrong page. Call "
        "browser_observe and replan from the latest page.",
    ),
    (
        "is ambiguous",
        "The target tab is ambiguous. Use browser_observe to inspect Open tabs and use "
        "a more specific tab ID.",
    ),
    (
        "timed out after",
        "The action timed out; the page may still be loading or stuck. Wait with "
        "browser_wait or browser_settle, then call browser_observe before retrying.",
    ),
    (
        "still settling",
        "It is not yet known whether the action took effect. Do not replay it. Call "
        "browser_observe to get the settled page and continue from the new state.",
    ),
    (
        "execution status is unknown",
        "It is not known whether the action took effect. Do not replay it. Call "
        "browser_observe and continue from the current page state.",
    ),
    (
        "tab not found",
        "That tab does not exist. Use browser_observe to read the real tab IDs in Open "
        "tabs, then call browser_switch_tab.",
    ),
    (
        "webcontentsview not found",
        "This tab is unavailable and may have crashed or closed. Use browser_observe to "
        "confirm the current page or switch to another tab.",
    ),
    (
        "multi-tab not supported",
        "This environment does not support multiple tabs. Complete the task in the "
        "current tab without opening another one.",
    ),
    (
        "expression must be an arrow function",
        "browser_evaluate code must be an arrow function, for example "
        "(...args) => { ... }. Rewrite it in arrow-function form.",
    ),
    (
        "expression must start with",
        "browser_evaluate code must be an arrow function, for example "
        "(...args) => { ... }. Rewrite it in arrow-function form.",
    ),
    (
        "javascript execution error",
        "The JavaScript failed with the original error shown above. Check selectors and "
        "syntax before retrying, or use browser_observe with index-based actions.",
    ),
    (
        "javascript evaluation failed",
        "The JavaScript failed with the original error shown above. Check selectors and "
        "syntax before retrying, or use browser_observe with index-based actions.",
    ),
    (
        "missing electron_browser_runtime",
        "The browser runtime is not ready; the desktop app may still be starting. Retry "
        "once after a short delay. If it continues to fail, ask the user to restart the app.",
    ),
    (
        "request failed",
        "The browser runtime is temporarily unreachable. Retry once after a short delay. "
        "If it continues to fail, ask the user to restart the desktop app.",
    ),
)


def _strip_runtime_error_shell(msg: str) -> str:
    """Remove the client HTTP wrapper around a runtime error."""

    match = re.match(r"^Electron browser runtime HTTP \d+: (.*)$", msg, re.DOTALL)
    if not match:
        return msg
    body = match.group(1).strip()
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        return body or msg
    if isinstance(parsed, dict) and parsed.get("error"):
        return str(parsed["error"])
    return body or msg


def _format_structured_error_details(details: Any) -> str:
    if not isinstance(details, dict):
        return ""
    lines: list[str] = []
    options = details.get("options")
    if isinstance(options, list) and options:
        labels: list[str] = []
        for option in options[:50]:
            if isinstance(option, dict):
                text = str(option.get("text") or "").strip()
                value = str(option.get("value") or "").strip()
                label = text or value
                if text and value and text != value:
                    label = f"{text} (value={value})"
                if option.get("disabled"):
                    label = f"{label} [disabled]"
            else:
                label = str(option).strip()
            if label:
                labels.append(label)
        if labels:
            lines.append("[Available options] " + "; ".join(labels))
    current = details.get("value")
    expected = details.get("expectedValue")
    if current is not None or expected is not None:
        lines.append(f"[Selection state] current={current!s}; expected={expected!s}")
    action = details.get("action")
    reason = details.get("reason")
    if action or reason:
        lines.append(f"[Browser state] action={action or '-'}; change={reason or '-'}")
    return "\n".join(lines)


def _enrich_error(err: Any, details: Any = None) -> str:
    """Render a clean runtime error plus one actionable hint when recognized."""

    message = _strip_runtime_error_shell(str(err))
    structured = _format_structured_error_details(details)
    if _is_stale_index_error(message):
        return message if not structured else f"{message}\n{structured}"
    lowered = message.lower()
    for needle, hint in _ERROR_HINTS:
        if needle in lowered:
            enriched = f"{message}\n[Next step] {hint}"
            return enriched if not structured else f"{enriched}\n{structured}"
    return message if not structured else f"{message}\n{structured}"


def _append_recent_events(dom: str, result: dict[str, Any]) -> str:
    """Append the runtime's compact recent-event list to an observation."""

    events = result.get("recentEvents") if isinstance(result, dict) else None
    if not isinstance(events, list) or not events:
        return dom
    lines: list[str] = []
    for event in events:
        if isinstance(event, dict):
            event_type = str(event.get("type") or event.get("name") or "event")
            detail = (
                event.get("message") or event.get("url") or event.get("savePath") or ""
            )
            timestamp = event.get("timestamp") or event.get("ts") or ""
            line = f"- {event_type}"
            if detail:
                line += ": " + str(detail)[:200]
            if timestamp:
                line += f" @{timestamp}"
            lines.append(line)
        else:
            lines.append("- " + str(event)[:200])
    if not lines:
        return dom
    return dom + "\n\n[Recent events]\n" + "\n".join(lines)
