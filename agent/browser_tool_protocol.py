"""Correctness contract shared by the browser-aware agent loop.

The model still receives compact numeric DOM indexes, but those indexes are
valid only for the browser snapshot that produced them.  This module keeps the
Python-side policy in one place: extracting that snapshot token and deciding
when one browser tool invalidates the rest of the same assistant batch.
"""

from __future__ import annotations

import json
from dataclasses import is_dataclass, replace
from types import SimpleNamespace
from typing import Any, Mapping

from agent.transports.types import ToolCall

from agent.stale_observation_collapser import (
    PAGE_OBSERVATION_BEGIN,
    PAGE_OBSERVATION_END,
)


BROWSER_TOOL_PREFIX = "browser_"

_BROWSER_TYPE_FIELD_KEYS = frozenset(
    {
        "index",
        "text",
        "value_ref",
        "clear",
        "typing_mode",
        "delay_ms",
        "fast",
        "autocomplete_wait",
        "autocompleteWait",
        "autocomplete_wait_ms",
        "autocompleteWaitMs",
    }
)
_BROWSER_FILL_FORM_MAX_FIELDS = 50

_SAME_SNAPSHOT_INDEXED_TOOLS = frozenset(
    {
        "browser_click",
        "browser_type",
        "browser_select",
        "browser_dropdown_options",
    }
)

_TERMINAL_NAVIGATION_FAILURE_CODES = frozenset(
    {
        "NAVIGATION_FAILED",
        "NAVIGATION_TIMEOUT",
    }
)

# These tools either rebuild the selector map themselves, mutate the page, or
# can change which page/tab subsequent calls would address.  Once one executes,
# later browser calls from the same model response were planned against an old
# world and must be replanned from the returned observation.
_BROWSER_REPLAN_BARRIER_TOOLS = frozenset(
    {
        "browser_snapshot",
        "browser_run",
        "browser_handoff",
        "browser_observe",
        "browser_find_visual",
        "browser_search",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_fill_form",
        "browser_scroll",
        "browser_scroll_to_text",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "browser_send_keys",
        "browser_select",
        "browser_wait",
        "browser_settle",
        "browser_cdp",
        "browser_new_tab",
        "browser_switch_tab",
        "browser_close_tab",
        "browser_dialog",
        "browser_upload",
        "browser_load_storage_state",
        "browser_grant_permissions",
        "browser_set_viewport",
        "browser_evaluate",
        "browser_evaluate_js",
        "browser_mouse",
        "browser_hover",
        "browser_focus",
        "browser_drag",
    }
)

_NETWORK_CONFIG_MUTATION_KEYS = frozenset(
    {
        "user_agent",
        "userAgent",
        "headers",
        "extra_http_headers",
        "extraHTTPHeaders",
        "clear",
        "clear_headers",
        "clearHeaders",
    }
)
_URL_POLICY_MUTATION_KEYS = frozenset(
    {
        "allowed_domains",
        "allowedDomains",
        "prohibited_domains",
        "prohibitedDomains",
        "block_ip_addresses",
        "blockIPAddresses",
        "clear",
    }
)


def is_browser_tool(tool_name: str | None) -> bool:
    return str(tool_name or "").startswith(BROWSER_TOOL_PREFIX)


def _coalescible_browser_type_field(tool_call: Any) -> dict[str, Any] | None:
    """Return one fill-form field when a single-field call is safe to batch.

    The conversion is intentionally strict. Unknown or invalid arguments keep
    their original call so normal validation can report the real error instead
    of silently changing its meaning.
    """

    function = getattr(tool_call, "function", None)
    if getattr(function, "name", None) != "browser_type":
        return None

    # Provider-bound function-call metadata (for example Gemini thought
    # signatures or Responses item ids) must remain attached to the exact call
    # the provider emitted. Description guidance still applies to those calls,
    # but Fan does not rewrite them locally.
    provider_data = getattr(tool_call, "provider_data", None)
    if (
        (isinstance(provider_data, Mapping) and bool(provider_data))
        or getattr(tool_call, "extra_content", None)
        or getattr(tool_call, "response_item_id", None)
    ):
        return None

    raw_arguments = getattr(function, "arguments", None)
    if isinstance(raw_arguments, str):
        try:
            arguments = json.loads(raw_arguments)
        except (TypeError, ValueError):
            return None
    elif isinstance(raw_arguments, Mapping):
        arguments = dict(raw_arguments)
    else:
        return None
    if not isinstance(arguments, Mapping):
        return None
    if set(arguments).difference(_BROWSER_TYPE_FIELD_KEYS):
        return None

    index = arguments.get("index")
    if not isinstance(index, int) or isinstance(index, bool) or index <= 0:
        return None

    value_ref = arguments.get("value_ref")
    text = arguments.get("text")
    if isinstance(value_ref, str) and value_ref:
        value_key = "value_ref"
        value = value_ref
    elif isinstance(text, str) and text:
        value_key = "text"
        value = text
    else:
        return None

    field: dict[str, Any] = {"index": index, value_key: value}

    clear = arguments.get("clear")
    if "clear" in arguments:
        if not isinstance(clear, bool):
            return None
        field["clear"] = clear

    fast = arguments.get("fast")
    if "fast" in arguments and not isinstance(fast, bool):
        return None
    typing_mode = arguments.get("typing_mode")
    if fast is True:
        # Runtime semantics give the compatibility flag precedence over an
        # explicit mode, so preserve that ordering in the transaction field.
        field["typing_mode"] = "fast"
    elif typing_mode is not None:
        if typing_mode not in {"human", "fast", "direct"}:
            return None
        field["typing_mode"] = typing_mode

    delay_ms = arguments.get("delay_ms")
    if delay_ms is not None:
        if not isinstance(delay_ms, (int, float)) or isinstance(delay_ms, bool):
            return None
        field["delay_ms"] = delay_ms

    for snake_key, camel_key in (
        ("autocomplete_wait", "autocompleteWait"),
        ("autocomplete_wait_ms", "autocompleteWaitMs"),
    ):
        option = arguments.get(snake_key, arguments.get(camel_key))
        if option is None:
            continue
        if snake_key == "autocomplete_wait":
            if not isinstance(option, bool):
                return None
            if option:
                # A real autocomplete wait can reveal dynamic choices, so the
                # next field must be planned from a fresh observation.
                return None
        else:
            if (
                not isinstance(option, (int, float))
                or isinstance(option, bool)
                or option < 0
            ):
                return None
            if option > 0:
                return None
        field[snake_key] = option

    return field


def _tool_call_with_function(
    tool_call: Any,
    *,
    name: str,
    arguments: str,
) -> Any | None:
    """Clone a tool call through its canonical immutable/model constructor.

    Normalized transports use a flat :class:`ToolCall` whose ``function`` is a
    read-only compatibility property returning itself.  Treat that type first;
    attempting to assign ``function`` silently disabled coalescing on real
    provider responses.  SDK model and test-namespace fallbacks likewise build
    new values instead of mutating copied objects with ``setattr``.
    """

    if isinstance(tool_call, ToolCall):
        return replace(tool_call, name=name, arguments=arguments)

    function = getattr(tool_call, "function", None)
    if function is None:
        return None
    try:
        if hasattr(function, "model_copy"):
            cloned_function = function.model_copy(
                update={"name": name, "arguments": arguments}
            )
        elif is_dataclass(function):
            cloned_function = replace(
                function,
                name=name,
                arguments=arguments,
            )
        elif isinstance(function, SimpleNamespace):
            function_values = vars(function).copy()
            function_values.update({"name": name, "arguments": arguments})
            cloned_function = SimpleNamespace(**function_values)
        else:
            return None

        if hasattr(tool_call, "model_copy"):
            return tool_call.model_copy(update={"function": cloned_function})
        if is_dataclass(tool_call):
            return replace(tool_call, function=cloned_function)
        if isinstance(tool_call, SimpleNamespace):
            call_values = vars(tool_call).copy()
            call_values["function"] = cloned_function
            return SimpleNamespace(**call_values)
        return None
    except (AttributeError, TypeError, ValueError):
        return None


def coalesce_browser_type_calls(
    tool_calls: list[Any],
    *,
    available_tool_names: set[str] | frozenset[str] | None = None,
) -> list[Any]:
    """Turn adjacent compatible single-field calls into one form transaction.

    This normalization runs before the assistant tool-call block is persisted,
    so canonical history still has exactly one result for every declared call.
    The first call id and provider-neutral metadata are retained. Runs with
    invalid arguments, duplicate indexes, provider-bound metadata, or more than
    the runtime field limit are left untouched and follow the normal executor
    path.
    """

    calls = list(tool_calls or [])
    if len(calls) < 2:
        return tool_calls
    if available_tool_names is not None and "browser_fill_form" not in available_tool_names:
        return tool_calls

    normalized: list[Any] = []
    changed = False
    cursor = 0
    while cursor < len(calls):
        current = calls[cursor]
        function = getattr(current, "function", None)
        if getattr(function, "name", None) != "browser_type":
            normalized.append(current)
            cursor += 1
            continue

        end = cursor + 1
        while end < len(calls):
            candidate_function = getattr(calls[end], "function", None)
            if getattr(candidate_function, "name", None) != "browser_type":
                break
            end += 1

        run = calls[cursor:end]
        fields = [_coalescible_browser_type_field(call) for call in run]
        indexes = [field["index"] for field in fields if field is not None]
        compatible = (
            2 <= len(run) <= _BROWSER_FILL_FORM_MAX_FIELDS
            and all(field is not None for field in fields)
            and len(indexes) == len(set(indexes))
        )
        if compatible:
            merged_arguments = json.dumps(
                {"fields": fields},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            merged = _tool_call_with_function(
                run[0],
                name="browser_fill_form",
                arguments=merged_arguments,
            )
            if merged is not None:
                normalized.append(merged)
                changed = True
            else:
                normalized.extend(run)
        else:
            normalized.extend(run)
        cursor = end

    return normalized if changed else tool_calls


def browser_result_effect(value: Any) -> str | None:
    parsed = value
    if isinstance(value, str):
        try:
            import json

            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
    if not isinstance(parsed, Mapping):
        return None
    effect = parsed.get("effect")
    if isinstance(effect, str):
        return effect
    for key in ("result", "screenshot", "pdf"):
        nested = parsed.get(key)
        if isinstance(nested, Mapping):
            found = browser_result_effect(nested)
            if found:
                return found
    return None


def browser_call_can_share_snapshot(
    tool_name: str,
    arguments: Mapping[str, Any] | None,
) -> bool:
    """Whether one direct call can safely target the current selector snapshot.

    Sharing is deliberately limited to positive indexed operations. Coordinate
    clicks have no stable element identity, and autocomplete typing can reveal
    new choices that must be observed before another action is planned.
    """

    name = str(tool_name or "")
    args = arguments if isinstance(arguments, Mapping) else {}
    if name not in _SAME_SNAPSHOT_INDEXED_TOOLS:
        return False
    index = args.get("index")
    if not isinstance(index, int) or isinstance(index, bool) or index <= 0:
        return False
    if name == "browser_click" and any(
        args.get(key) is not None
        for key in ("coordinate_x", "coordinate_y", "x", "y")
    ):
        return False
    if name == "browser_type":
        autocomplete_wait = args.get(
            "autocomplete_wait",
            args.get("autocompleteWait"),
        )
        autocomplete_wait_ms = args.get(
            "autocomplete_wait_ms",
            args.get("autocompleteWaitMs"),
        )
        if autocomplete_wait is True:
            return False
        if isinstance(autocomplete_wait_ms, (int, float)) and not isinstance(
            autocomplete_wait_ms, bool
        ) and autocomplete_wait_ms > 0:
            return False
    return True


def browser_result_allows_snapshot_continue(value: Any) -> bool:
    """Accept only a trusted wrapper marker from a successful deferred observe."""

    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return False
    if not isinstance(parsed, Mapping):
        return False
    if parsed.get("same_snapshot_continue") is not True:
        return False
    if browser_result_requests_replan(parsed):
        return False
    return browser_result_effect(parsed) in {"none", "value-only", "dom-structure"}


def browser_tool_opens_replan_barrier(
    tool_name: str,
    arguments: Mapping[str, Any] | None,
    result: Any = None,
) -> bool:
    """Return whether executing this tool invalidates later browser calls.

    Most entries are static.  Configuration/readback tools are argument
    sensitive so harmless reads do not force an extra model round.
    """

    name = str(tool_name or "")
    args = arguments if isinstance(arguments, Mapping) else {}
    effect = browser_result_effect(result)
    if effect in {"snapshot-refresh", "dom-structure", "navigation", "tab-change"}:
        return True
    if effect == "value-only":
        return False
    if name in _BROWSER_REPLAN_BARRIER_TOOLS:
        return True
    if name == "browser_network_config":
        return any(key in args for key in _NETWORK_CONFIG_MUTATION_KEYS)
    if name == "browser_url_policy":
        return any(key in args for key in _URL_POLICY_MUTATION_KEYS)
    if name == "browser_har":
        return bool(args.get("clear"))
    if name == "browser_element":
        return str(args.get("operation") or "info").strip().lower() == "evaluate"
    return False


def browser_result_requests_replan(value: Any) -> bool:
    """Recognize a wrapper's safe non-execution result without string matching."""

    parsed = value
    if isinstance(value, str):
        try:
            import json

            parsed = json.loads(value)
        except (TypeError, ValueError):
            return False
    if not isinstance(parsed, Mapping):
        return False
    if parsed.get("replan_required") is True:
        return True
    nested = parsed.get("result")
    return isinstance(nested, Mapping) and nested.get("replan_required") is True


def browser_navigation_failure(value: Any) -> dict[str, Any] | None:
    """Return trusted top-level metadata for an explicit navigation failure.

    The Electron wrapper exposes runtime failures as a JSON tool result with a
    top-level ``code`` and nested ``details``.  Only that structural envelope is
    accepted here: page text or a DOM snapshot that happens to contain JSON-like
    error words must never be able to forge control-flow state.

    This helper deliberately does *not* decide whether the conversation should
    stop.  A single failed navigation is still returned to the model so it can
    explain the blocker normally.  The normalized record is retained only so a
    later browser no-progress circuit break can report the real network error.
    """

    parsed = value
    if isinstance(value, str):
        try:
            import json

            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
    if not isinstance(parsed, Mapping):
        return None

    code = str(parsed.get("code") or "").strip().upper()
    if code not in _TERMINAL_NAVIGATION_FAILURE_CODES:
        return None

    raw_details = parsed.get("details")
    details = raw_details if isinstance(raw_details, Mapping) else {}

    def _first(*keys: str) -> Any:
        for key in keys:
            if key in details and details.get(key) is not None:
                return details.get(key)
            if key in parsed and parsed.get(key) is not None:
                return parsed.get(key)
        return None

    failure: dict[str, Any] = {
        "code": code,
        "error": str(parsed.get("error") or code).strip(),
    }
    for output_key, source_keys in (
        ("networkErrorCode", ("networkErrorCode", "network_error_code")),
        ("errorDescription", ("errorDescription", "error_description")),
        ("requestedUrl", ("requestedUrl", "requested_url")),
        ("validatedUrl", ("validatedUrl", "validated_url")),
        ("retryable", ("retryable",)),
    ):
        found = _first(*source_keys)
        if found is not None:
            failure[output_key] = found
    return failure


def browser_result_contains_page_observation(value: Any) -> bool:
    """Return whether a model-facing browser result contains a full DOM snapshot."""

    if isinstance(value, str):
        return PAGE_OBSERVATION_BEGIN in value and PAGE_OBSERVATION_END in value
    if isinstance(value, Mapping):
        return any(
            browser_result_contains_page_observation(item)
            for item in value.values()
        )
    if isinstance(value, (list, tuple)):
        return any(browser_result_contains_page_observation(item) for item in value)
    return False


def browser_observation_content_fingerprint(value: Any) -> str | None:
    """Hash the exact model-facing content that carries a full observation."""

    if not browser_result_contains_page_observation(value):
        return None
    import hashlib
    import json

    if isinstance(value, str):
        serialized = value
    else:
        try:
            serialized = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            )
        except (TypeError, ValueError):
            serialized = repr(value)
    return hashlib.sha256(serialized.encode("utf-8", errors="replace")).hexdigest()


def browser_observation_is_authoritative(tool_name: str, value: Any) -> bool:
    """Return whether an attached observation is safe to reuse for actions.

    A navigation may time out its settle phase after the document is already
    visible.  Its trailing observation is useful progress evidence, but the
    page can still replace its document/selector map immediately afterwards.
    Keep that transitional DOM visible to the model while requiring a fresh
    observation before the next state-bound action.
    """

    if not browser_result_contains_page_observation(value):
        return False
    if str(tool_name or "") != "browser_navigate":
        return True

    parsed = value
    if isinstance(value, str):
        try:
            import json

            parsed = json.loads(value)
        except (TypeError, ValueError):
            # A navigate result that cannot be structurally verified is not a
            # safe source of reusable numeric indexes.
            return False
    if not isinstance(parsed, Mapping):
        return False
    navigation = parsed.get("result")
    return not (isinstance(navigation, Mapping) and navigation.get("settled") is False)


def decision_token_from_live_state(state: Any, workbench_id: str) -> dict[str, Any] | None:
    """Build the internal token binding one model request to one DOM snapshot."""

    if not isinstance(state, Mapping):
        return None

    active_tab_id = str(state.get("activeTabId") or "").strip()
    if not active_tab_id:
        tabs = state.get("tabs")
        if isinstance(tabs, list):
            for tab in tabs:
                if isinstance(tab, Mapping) and tab.get("current"):
                    active_tab_id = str(tab.get("targetId") or "").strip()
                    break
    if not active_tab_id:
        return None

    selector_generation = state.get("selectorGeneration")
    page_generation = state.get("pageGeneration", state.get("activeGeneration"))
    view_epoch = state.get("viewEpoch")
    document_revision = state.get("documentRevision")
    tab_list_generation = state.get("tabListGeneration", 0)
    if (
        not _is_generation(view_epoch)
        or not _is_generation(document_revision)
        or not _is_generation(selector_generation)
        or not _is_generation(page_generation)
    ):
        return None
    if not _is_generation(tab_list_generation):
        tab_list_generation = 0

    return {
        "version": 1,
        "sessionId": str(workbench_id or state.get("sessionId") or "main"),
        "activeTabId": active_tab_id,
        "viewEpoch": int(view_epoch),
        "documentRevision": int(document_revision),
        "pageGeneration": int(page_generation),
        "selectorGeneration": int(selector_generation),
        "tabListGeneration": int(tab_list_generation),
    }


def _is_generation(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0


def browser_replan_result(trigger_tool: str, *, reason: str) -> str:
    """Stable synthetic result for a browser call skipped at the batch barrier."""

    import json

    return json.dumps(
        {
            "status": "skipped",
            "executed": False,
            "replan_required": True,
            "code": "BROWSER_REPLAN_REQUIRED",
            "trigger_tool": str(trigger_tool or "browser action"),
            "reason": reason,
            "message": (
                "This browser call did not execute because an earlier action in the "
                "same turn updated the browser state. Replan from the latest page "
                "observation; do not continue using element indices from the old DOM."
            ),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


__all__ = [
    "browser_call_can_share_snapshot",
    "coalesce_browser_type_calls",
    "browser_navigation_failure",
    "browser_observation_content_fingerprint",
    "browser_observation_is_authoritative",
    "browser_replan_result",
    "browser_result_contains_page_observation",
    "browser_result_allows_snapshot_continue",
    "browser_result_requests_replan",
    "browser_result_effect",
    "browser_tool_opens_replan_barrier",
    "decision_token_from_live_state",
    "is_browser_tool",
]
