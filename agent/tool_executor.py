"""Tool-call execution — sequential and concurrent dispatch.

Both AIAgent methods (``_execute_tool_calls_sequential`` and
``_execute_tool_calls_concurrent``) live here as module-level
functions that take the parent ``AIAgent`` as their first argument.

``run_agent`` keeps thin wrappers so existing call sites work; tests
that patch ``run_agent._set_interrupt`` are honored because the
extracted functions reach back through the ``run_agent`` module via
``_ra()`` for that symbol.
"""

from __future__ import annotations

import concurrent.futures
from contextlib import contextmanager
import json
import logging
import os
import random
import threading
import time
from typing import Any, Optional

from agent.display import (
    KawaiiSpinner,
    build_tool_preview as _build_tool_preview,
    get_cute_tool_message as _get_cute_tool_message_impl,
    get_tool_emoji as _get_tool_emoji,
    redact_browser_typed_text_for_display as _redact_browser_typed_text_for_display,
    redact_tool_args_for_display as _redact_tool_args_for_display,
    _detect_tool_failure,
)
from agent.tool_guardrails import ToolGuardrailDecision
from agent.stale_observation_collapser import release_superseded_observation_images
from agent.browser_tool_protocol import (
    browser_call_can_share_snapshot,
    browser_navigation_failure,
    browser_observation_content_fingerprint,
    browser_observation_is_authoritative,
    browser_replan_result,
    browser_result_allows_snapshot_continue,
    browser_result_contains_page_observation,
    browser_result_requests_replan,
    browser_tool_opens_replan_barrier,
    is_browser_tool,
)
from agent.browser_action_outcome import record_browser_action_outcome
from agent.human_interaction_state import (
    current_resume_generation as _human_resume_generation,
    mark_human_interaction_resumed,
)
from agent.tool_dispatch_helpers import (
    _is_destructive_command,
    _is_multimodal_tool_result,
    _multimodal_text_summary,
    _append_subdir_hint_to_multimodal,
    make_tool_result_message,
)
from tools.terminal_tool import (
    get_active_env,
)
from tools.thread_context import propagate_context_to_thread
from tools.tool_result_storage import (
    maybe_persist_tool_result,
    enforce_turn_budget,
)
from tools.budget_config import (
    BudgetConfig,
    DEFAULT_BUDGET,
    budget_for_context_window,
)

logger = logging.getLogger(__name__)


def _record_trusted_browser_control_boundary(agent) -> None:
    controller = getattr(agent, "_tool_guardrails", None)
    recorder = getattr(
        controller,
        "record_trusted_browser_control_boundary",
        None,
    )
    if callable(recorder):
        recorder()


def _ensure_file_checkpoint(
    agent,
    function_name: str,
    function_args: dict,
    effective_task_id: str,
) -> None:
    """Checkpoint the same resolved workspace path the file tool will mutate."""
    file_path = function_args.get("path", "")
    if not file_path:
        return

    from tools.file_tools import _resolve_path_for_task

    resolved_path = _resolve_path_for_task(
        file_path,
        effective_task_id or "default",
    )
    work_dir = agent._checkpoint_mgr.get_working_dir_for_path(str(resolved_path))
    agent._checkpoint_mgr.ensure_checkpoint(work_dir, f"before {function_name}")


def _flush_session_db_after_tool_progress(
    agent,
    messages: list,
    *,
    stage: str,
) -> None:
    """Best-effort persistence after each settled tool-call transition."""
    try:
        agent._flush_messages_to_session_db(messages)
    except Exception as exc:
        logger.warning(
            "Incremental tool-call persistence failed after %s: %s",
            stage,
            exc,
        )


def _is_interpreter_shutdown_submit_error(exc: RuntimeError) -> bool:
    return "cannot schedule new futures after interpreter shutdown" in str(exc)


def _budget_for_agent(agent) -> BudgetConfig:
    """Resolve the context-scaled tool-output budget for one tool batch."""
    try:
        context_length = getattr(
            getattr(agent, "context_compressor", None),
            "context_length",
            None,
        )
        return (
            budget_for_context_window(int(context_length))
            if context_length
            else DEFAULT_BUDGET
        )
    except Exception:
        return DEFAULT_BUDGET


def _persist_env_factory(task_id: str):
    """Return a zero-arg factory that lazily resolves (creating if absent) the
    local execution env for *task_id*. Passed to the tool-result persistence
    layer so an oversized result can be written to a real file and recovered
    via read_file even on a browser-only turn that never spun up a terminal env
    (otherwise env is None → dead-end inline truncation). The factory only runs
    when a result actually exceeds its threshold, so small results pay nothing."""
    def _factory():
        from tools.code_execution_tool import _get_or_create_env
        return _get_or_create_env(task_id)[0]
    return _factory

# Maximum number of concurrent worker threads for parallel tool execution.
# Mirrors the constant in ``run_agent`` for tests/imports that look here.
_MAX_TOOL_WORKERS = 8
_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S = 420.0


def _store_concurrent_result(
    results: list,
    result_lock: threading.Lock,
    sealed_indices: set[int],
    index: int,
    value: tuple,
    *,
    seal: bool = False,
) -> bool:
    """Store one worker result unless the coordinator already finalized it.

    A timed-out daemon worker can return after the batch has moved on.  Without
    this sealed-slot guard that late worker can replace the deterministic
    timeout error while the main thread is formatting results, making the same
    call appear to both time out and succeed.
    """
    with result_lock:
        if index in sealed_indices:
            return False
        results[index] = value
        if seal:
            sealed_indices.add(index)
        return True


def _parse_tool_arguments(raw_arguments: Any) -> tuple[dict, Optional[str]]:
    """Parse model-emitted tool arguments without repairing or coercing them.

    Dispatching ``{}`` after malformed JSON is unsafe: an argument-less tool
    can still have side effects, and a truncated destructive call must never be
    converted into a different valid invocation.  Only a JSON object crosses
    the execution boundary; every other shape becomes one deterministic tool
    error and is not dispatched.
    """
    try:
        arguments = json.loads(raw_arguments)
    except (json.JSONDecodeError, TypeError):
        arguments = None
    if isinstance(arguments, dict):
        return arguments, None
    return {}, json.dumps(
        {
            "error": "Invalid tool arguments",
            "message": (
                "Tool arguments must be a valid JSON object; tool was not executed."
            ),
        },
        ensure_ascii=False,
    )


_FORM_SUBMIT_INPUT_TOOLS = frozenset({"browser_type", "browser_fill_form"})
_FORM_SUBMIT_TYPE_ARGUMENTS = frozenset(
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
_FORM_SUBMIT_FIELD_ARGUMENTS = frozenset(
    {
        "index",
        "text",
        "value_ref",
        "clear",
        "typing_mode",
        "delay_ms",
        "autocomplete_wait",
        "autocomplete_wait_ms",
        "expected_label",
        "expected",
    }
)
_FORM_SUBMIT_CLICK_ARGUMENTS = frozenset(
    {
        "index",
        "allow_occluded",
        "expected",
        "expected_role",
        "expected_name",
        "expected_text",
        "expected_tag",
    }
)


def _has_dynamic_autocomplete_intent(field: dict[str, Any]) -> bool | None:
    """Return dynamic intent, or ``None`` for invalid autocomplete options."""

    wait = field.get("autocomplete_wait", field.get("autocompleteWait"))
    if wait is not None:
        if not isinstance(wait, bool):
            return None
        if wait:
            return True
    wait_ms = field.get("autocomplete_wait_ms", field.get("autocompleteWaitMs"))
    if wait_ms is not None:
        if (
            not isinstance(wait_ms, (int, float))
            or isinstance(wait_ms, bool)
            or wait_ms < 0
        ):
            return None
        if wait_ms > 0:
            return True
    return False


def _adjacent_form_submit_candidate(
    tool_calls: list[Any],
    index: int,
    function_name: str,
    function_args: dict[str, Any],
) -> tuple[Any, dict[str, Any]] | None:
    """Recognize the only browser pair safe for transaction lowering.

    ``index`` is zero-based.  The public calls and their ids stay untouched;
    this merely proves that the immediately following call is a direct,
    indexed click expressible by the private ``formSubmit`` RPC.
    """

    if function_name not in _FORM_SUBMIT_INPUT_TOOLS or index + 1 >= len(tool_calls):
        return None
    if function_name == "browser_type":
        if set(function_args).difference(_FORM_SUBMIT_TYPE_ARGUMENTS):
            return None
        fields = [function_args]
    else:
        if set(function_args) != {"fields"}:
            return None
        fields = function_args.get("fields")
        if not isinstance(fields, list) or not 1 <= len(fields) <= 50:
            return None

    seen_indices: set[int] = set()
    for field in fields:
        allowed = (
            _FORM_SUBMIT_TYPE_ARGUMENTS
            if function_name == "browser_type"
            else _FORM_SUBMIT_FIELD_ARGUMENTS
        )
        if not isinstance(field, dict) or set(field).difference(allowed):
            return None
        # Only an enabled/positive autocomplete wait is dynamic. Explicit
        # false/zero disables the wait and remains safe for stable lowering.
        if _has_dynamic_autocomplete_intent(field) is not False:
            return None
        field_index = field.get("index")
        if (
            not isinstance(field_index, int)
            or isinstance(field_index, bool)
            or field_index <= 0
            or field_index in seen_indices
        ):
            return None
        seen_indices.add(field_index)
    click_call = tool_calls[index + 1]
    click_function = getattr(click_call, "function", None)
    if getattr(click_function, "name", None) != "browser_click":
        return None
    click_args, malformed = _parse_tool_arguments(
        getattr(click_function, "arguments", None)
    )
    if malformed is not None or set(click_args).difference(_FORM_SUBMIT_CLICK_ARGUMENTS):
        return None
    click_index = click_args.get("index")
    if (
        not isinstance(click_index, int)
        or isinstance(click_index, bool)
        or click_index <= 0
    ):
        return None
    if "expected" in click_args and not isinstance(click_args.get("expected"), dict):
        return None
    allow_occluded = click_args.get("allow_occluded")
    if "allow_occluded" in click_args and not isinstance(allow_occluded, bool):
        return None
    if allow_occluded is True:
        # Stable form submission never weakens hit-testing. A caller that
        # explicitly accepts an occluded target must use the ordinary click
        # path where that exceptional semantics remains visible and isolated.
        return None
    if click_index in seen_indices:
        return None
    return click_call, click_args


def _has_adjacent_same_snapshot_call(
    tool_calls: list[Any],
    index: int,
    function_name: str,
    function_args: dict[str, Any],
) -> bool:
    """Return whether the next direct call may reuse this selector snapshot.

    The runtime still validates the original decision token and resolves every
    target live. This helper only suppresses the eager post-action observation;
    it does not make stale, detached, disabled, or navigated targets executable.
    """

    if not browser_call_can_share_snapshot(function_name, function_args):
        return False
    if index + 1 >= len(tool_calls):
        return False
    next_function = getattr(tool_calls[index + 1], "function", None)
    next_name = getattr(next_function, "name", None)
    if not isinstance(next_name, str):
        return False
    next_args, malformed = _parse_tool_arguments(
        getattr(next_function, "arguments", None)
    )
    return malformed is None and browser_call_can_share_snapshot(
        next_name,
        next_args,
    )


def _preflight_tool_execution(
    agent,
    function_name: str,
    function_args: dict[str, Any],
    *,
    effective_task_id: str,
    tool_call_id: str,
) -> tuple[Optional[str], str, ToolGuardrailDecision | None]:
    """Run the ordinary plugin and loop-guardrail gates without dispatching."""

    block_message: Optional[str] = None
    block_error_type = "plugin_block"
    try:
        from fan_cli.plugins import get_pre_tool_call_block_message

        block_message = get_pre_tool_call_block_message(
            function_name,
            function_args,
            task_id=effective_task_id or "",
            session_id=getattr(agent, "session_id", "") or "",
            tool_call_id=tool_call_id or "",
            turn_id=getattr(agent, "_current_turn_id", "") or "",
            api_request_id=getattr(agent, "_current_api_request_id", "") or "",
        )
    except Exception:
        pass

    guardrail_block: ToolGuardrailDecision | None = None
    if block_message is None:
        decision = _navigation_failure_recovery_halt(
            agent,
            function_name,
        ) or agent._tool_guardrails.before_call(
            function_name,
            function_args,
            browser_state=getattr(agent, "_browser_decision_token", None),
        )
        if not decision.allows_execution:
            guardrail_block = decision
    return block_message, block_error_type, guardrail_block


def _resolve_concurrent_tool_timeout() -> float | None:
    """Return the bounded batch timeout; non-positive explicitly disables it."""
    raw = os.getenv("FAN_CONCURRENT_TOOL_TIMEOUT_S", "").strip()
    if not raw:
        return _DEFAULT_CONCURRENT_TOOL_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError:
        logger.warning(
            "invalid FAN_CONCURRENT_TOOL_TIMEOUT_S=%r; using %.0fs",
            raw,
            _DEFAULT_CONCURRENT_TOOL_TIMEOUT_S,
        )
        return _DEFAULT_CONCURRENT_TOOL_TIMEOUT_S
    return None if value <= 0 else value


def _ra():
    """Lazy reference to ``run_agent`` so patches like ``run_agent._set_interrupt`` work."""
    import run_agent
    return run_agent


def _emit_terminal_post_tool_call(
    agent,
    *,
    function_name: str,
    function_args: dict,
    result: Any,
    effective_task_id: str,
    tool_call_id: str,
    duration_ms: int = 0,
    status: str | None = None,
    error_type: str | None = None,
    error_message: str | None = None,
) -> None:
    try:
        from model_tools import _emit_post_tool_call_hook
        browser_call = is_browser_tool(function_name)
        display_args = function_args if browser_call else (
            _redact_tool_args_for_display(function_name, function_args) or function_args
        )
        display_result = result if browser_call else _redact_browser_typed_text_for_display(
            result,
            function_args.get("text") if isinstance(function_args, dict) else None,
        )
        display_error = error_message if browser_call else _redact_browser_typed_text_for_display(
            error_message,
            function_args.get("text") if isinstance(function_args, dict) else None,
        )
        _emit_post_tool_call_hook(
            function_name=function_name,
            function_args=display_args,
            result=display_result,
            task_id=effective_task_id or "",
            session_id=getattr(agent, "session_id", "") or "",
            tool_call_id=tool_call_id or "",
            turn_id=getattr(agent, "_current_turn_id", "") or "",
            api_request_id=getattr(agent, "_current_api_request_id", "") or "",
            duration_ms=duration_ms,
            status=status,
            error_type=error_type,
            error_message=display_error,
        )
    except Exception:
        pass


def _cancelled_tool_result(reason: str = "user interrupt") -> str:
    return json.dumps(
        {
            "error": f"Tool execution cancelled by {reason}",
            "status": "cancelled",
        },
        ensure_ascii=False,
    )


def _unknown_form_submit_result(*, code: str, reason: str) -> str:
    """Conservatively settle a form step whose physical state is unknowable."""

    return json.dumps(
        {
            "effect": "dom-structure",
            "result": {
                "status": "unknown",
                "executed": None,
                "execution_state": "unknown",
                "replan_required": True,
                "retryable": False,
                "do_not_retry": True,
                "code": code,
                "reason": reason,
            },
        },
        ensure_ascii=False,
    )


def _interrupted_form_submit_result() -> str:
    """Conservatively settle a transaction interrupted while awaiting RPC."""

    return _unknown_form_submit_result(
        code="FORM_SUBMIT_INTERRUPTED",
        reason=(
            "The form transaction was interrupted while its runtime status was "
            "unknown. Do not retry blindly; observe and verify first."
        ),
    )


@contextmanager
def _browser_decision_context(agent, function_name: str):
    """Bind one model-emitted browser tool to the request's DOM snapshot."""

    if not is_browser_tool(function_name):
        yield
        return
    from tools.electron_browser_context import (
        clear_browser_decision_context,
        current_browser_decision_token,
        current_browser_observation_token,
        set_browser_decision_context,
    )

    initial_token = getattr(agent, "_browser_decision_token", None)
    agent._browser_last_tool_state_before = (
        dict(initial_token) if isinstance(initial_token, dict) else None
    )
    agent._browser_last_tool_state_after = None
    agent._browser_last_observation_state_after = None
    set_browser_decision_context(
        initial_token,
        required=True,
    )
    try:
        yield
    finally:
        agent._browser_last_tool_state_after = current_browser_decision_token()
        agent._browser_last_observation_state_after = (
            current_browser_observation_token()
        )
        clear_browser_decision_context()


def _record_model_visible_browser_observation(
    agent,
    function_name: str,
    content: Any,
    decision_token: Any,
    *,
    canonical_content: Any = None,
) -> None:
    """Bind the exact DOM sent to the model to its runtime decision token."""

    if not is_browser_tool(function_name):
        return
    if not browser_result_contains_page_observation(content):
        return

    if not browser_observation_is_authoritative(function_name, content):
        # An unsettled navigation snapshot is useful for narration, but its
        # indexes must never cross into another model decision as authoritative.
        agent._browser_model_visible_observation_token = None
        agent._browser_model_visible_observation_fingerprint = None
        agent._browser_force_observe = True
        logger.info(
            "[grounding] transitional %s observation requires refresh before next model request",
            function_name,
        )
        return

    if isinstance(decision_token, dict):
        fingerprint = browser_observation_content_fingerprint(
            content if canonical_content is None else canonical_content
        )
        if not fingerprint:
            agent._browser_model_visible_observation_token = None
            agent._browser_model_visible_observation_fingerprint = None
            agent._browser_force_observe = True
            return
        agent._browser_model_visible_observation_token = dict(decision_token)
        agent._browser_model_visible_observation_fingerprint = fingerprint
        agent._browser_force_observe = False
        return

    # A DOM without a token cannot be proven to match any future action. Keep
    # it visible as read-only evidence but fail closed for indexed operations.
    agent._browser_model_visible_observation_token = None
    agent._browser_model_visible_observation_fingerprint = None
    agent._browser_force_observe = True
    logger.warning(
        "[grounding] model-visible %s observation had no decision token; forcing refresh",
        function_name,
    )


def _record_turn_browser_navigation_failure(
    agent,
    function_name: str,
    function_result: Any,
    *,
    failed: bool,
) -> None:
    """Retain the latest explicit navigation failure for terminal reporting.

    This is evidence only; it never halts a turn.  A later successful navigate
    clears the record, while observations of Chromium's error document leave it
    intact so a browser no-progress halt can explain the real blocker instead
    of calling it an empty page.
    """

    if function_name not in {
        "browser_navigate",
        "browser_search",
        "browser_reload",
        "browser_back",
        "browser_forward",
        "browser_new_tab",
        "browser_switch_tab",
        "browser_close_tab",
    }:
        return
    navigation_failure = browser_navigation_failure(function_result)
    if navigation_failure is not None:
        agent._turn_browser_navigation_failure = navigation_failure
    elif not failed:
        agent._turn_browser_navigation_failure = None


def _navigation_failure_recovery_halt(
    agent,
    function_name: str,
) -> ToolGuardrailDecision | None:
    """Stop meaningless reads of a terminal Chromium network-error document.

    A different navigation/search remains allowed so the model may try one
    genuinely different route.  Once the runtime has explicitly marked the
    current navigation non-retryable, however, observing, waiting or settling
    that same internal error document cannot create progress and should not
    consume the ordinary three-step no-progress budget.
    """

    if function_name not in {"browser_observe", "browser_wait", "browser_settle"}:
        return None
    failure = getattr(agent, "_turn_browser_navigation_failure", None)
    if not isinstance(failure, dict) or failure.get("retryable") is True:
        return None
    description = str(
        failure.get("errorDescription")
        or failure.get("error")
        or failure.get("code")
        or "navigation failure"
    )
    target = str(
        failure.get("requestedUrl")
        or failure.get("validatedUrl")
        or ""
    )
    suffix = f" ({target})" if target else ""
    return ToolGuardrailDecision(
        action="halt",
        code="browser_navigation_failure_circuit_open",
        message=(
            f"Stopped {function_name}: the current main page has a confirmed navigation "
            f"failure, {description}{suffix}. Further observation or waiting will not "
            "recover it. Use a new navigation path or report the network blocker honestly."
        ),
        tool_name=function_name,
        count=1,
    )


def _append_browser_replan_skip(
    agent,
    messages: list,
    *,
    tool_call,
    function_name: str,
    function_args: dict,
    effective_task_id: str,
    trigger_tool: str,
    reason: str,
    terminal_decision: ToolGuardrailDecision | None = None,
) -> None:
    """Settle one skipped tool_call_id without dispatching browser code."""

    if terminal_decision is not None:
        result = json.dumps(
            {
                "status": "skipped",
                "executed": False,
                "replan_required": False,
                "code": "BROWSER_GUARDRAIL_TERMINAL",
                "trigger_tool": str(trigger_tool or "browser action"),
                "reason": reason,
                "message": (
                    "This browser call did not execute. The tool-loop guardrail has "
                    "terminated browser automation for this turn, so no new browser "
                    "actions may be dispatched."
                ),
                "guardrail": terminal_decision.to_metadata(),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        error_type = "browser_guardrail_terminal"
    else:
        result = browser_replan_result(trigger_tool, reason=reason)
        error_type = "browser_replan_required"
    display_args = _redact_tool_args_for_display(function_name, function_args) or function_args
    _emit_terminal_post_tool_call(
        agent,
        function_name=function_name,
        function_args=function_args,
        result=result,
        effective_task_id=effective_task_id,
        tool_call_id=getattr(tool_call, "id", "") or "",
        status="skipped",
        error_type=error_type,
        error_message=reason,
    )
    if getattr(agent, "tool_progress_callback", None):
        try:
            agent.tool_progress_callback(
                "tool.completed",
                function_name,
                None,
                None,
                duration=0.0,
                is_error=False,
                result=result,
            )
        except Exception:
            pass
    if getattr(agent, "tool_complete_callback", None):
        try:
            agent.tool_complete_callback(tool_call.id, function_name, display_args, result)
        except Exception:
            pass
    try:
        from agent import llm_io_log

        llm_io_log.log_tool(function_name, display_args, result, duration_ms=0)
    except Exception:
        pass
    content = agent._tool_result_content_for_active_model(function_name, result)
    messages.append(
        make_tool_result_message(
            function_name,
            content,
            tool_call.id,
            trusted_internal=True,
        )
    )
    _flush_session_db_after_tool_progress(
        agent,
        messages,
        stage=f"skipped browser result {function_name}",
    )
    agent._apply_pending_steer_to_tool_results(messages, 1)
    logger.info(
        "browser tool %s skipped after %s (%s)",
        function_name,
        trigger_tool,
        reason,
    )


def _emit_cancelled_terminal_post_tool_call(
    agent,
    *,
    function_name: str,
    function_args: dict,
    effective_task_id: str,
    tool_call_id: str,
    start_time: float,
    reason: str = "user interrupt",
    error_type: str = "keyboard_interrupt",
) -> str:
    result = _cancelled_tool_result(reason)
    _emit_terminal_post_tool_call(
        agent,
        function_name=function_name,
        function_args=function_args,
        result=result,
        effective_task_id=effective_task_id,
        tool_call_id=tool_call_id,
        duration_ms=int((time.time() - start_time) * 1000),
        status="cancelled",
        error_type=error_type,
        error_message=f"Tool execution cancelled by {reason}",
    )
    return result


def _tool_search_scoped_names(agent) -> frozenset:
    """Return the deferrable tool names the session may invoke via tool_call.

    The Tool Search unwrap dispatches the underlying tool directly, bypassing
    the bridge branch (and its scope check) in
    ``model_tools.handle_function_call``. To keep a restricted-toolset session
    (subagent, kanban worker, curated gateway session) from reaching tools it
    was never granted, the unwrap validates the underlying name against this
    set: the deferrable subset of the session's own enabled/disabled toolset
    scope.

    Result is cached on the agent and refreshed when the tool registry's
    generation changes (e.g. an MCP server reconnects), so the common case is
    a dict lookup, not a full tool-defs rebuild on every tool call.
    """
    try:
        import model_tools
        from tools import tool_search as _ts
        from tools.registry import registry as _registry
    except Exception:
        return frozenset()

    enabled = getattr(agent, "enabled_toolsets", None)
    disabled = getattr(agent, "disabled_toolsets", None)
    cache_key = (
        getattr(_registry, "_generation", 0),
        frozenset(enabled) if enabled is not None else None,
        frozenset(disabled) if disabled is not None else None,
    )
    cached = getattr(agent, "_tool_search_scope_cache", None)
    if cached is not None and cached[0] == cache_key:
        return cached[1]
    try:
        scoped_defs = model_tools.get_tool_definitions(
            enabled_toolsets=enabled,
            disabled_toolsets=disabled,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        ) or []
        names = _ts.scoped_deferrable_names(scoped_defs)
    except Exception:
        names = frozenset()
    try:
        agent._tool_search_scope_cache = (cache_key, names)
    except Exception:
        pass
    return names


def execute_tool_calls_concurrent(agent, assistant_message, messages: list, effective_task_id: str, api_call_count: int = 0) -> None:
    """Execute multiple tool calls concurrently using a thread pool.

    Results are collected in the original tool-call order and appended to
    messages so the API sees them in the expected sequence.
    """
    tool_calls = assistant_message.tool_calls
    tool_budget = _budget_for_agent(agent)
    num_tools = len(tool_calls)
    human_resume_generation = _human_resume_generation()

    # ── Pre-flight: interrupt check ──────────────────────────────────
    if agent._interrupt_requested:
        print(f"{agent.log_prefix}⚡ Interrupt: skipping {num_tools} tool call(s)")
        for tc in tool_calls:
            messages.append(make_tool_result_message(
                tc.function.name,
                f"[Tool execution cancelled — {tc.function.name} was skipped due to user interrupt]",
                tc.id,
            ))
            _flush_session_db_after_tool_progress(
                agent,
                messages,
                stage=f"cancelled tool result {tc.function.name}",
            )
        return

    # ── Parse args + pre-execution bookkeeping ───────────────────────
    parsed_calls = []  # list of (tool_call, function_name, function_args)
    for tool_call in tool_calls:
        function_name = tool_call.function.name

        function_args, malformed_args_result = _parse_tool_arguments(
            tool_call.function.arguments
        )
        if malformed_args_result is not None:
            _emit_terminal_post_tool_call(
                agent,
                function_name=function_name,
                function_args={},
                result=malformed_args_result,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
                status="error",
                error_type="invalid_tool_arguments",
                error_message="Tool arguments were not a valid JSON object",
            )
            parsed_calls.append(
                (tool_call, function_name, {}, malformed_args_result, False)
            )
            continue

        # Reset nudge counters only for a structurally valid invocation.
        if function_name == "memory":
            agent._turns_since_memory = 0
        elif function_name == "skill_manage":
            agent._iters_since_skill = 0

        # ── Tool Search unwrap ────────────────────────────────────────
        # When the model invokes the tool_call bridge, peel it open so
        # every downstream check (checkpointing, guardrails, plugin
        # pre-tool-call hooks, the display/activity feed, the post-call
        # callback) sees the underlying tool — not the bridge. This is
        # the OpenClaw lesson: hooks must observe the real tool name.
        #
        # The original tool_call entry on ``tool_call.function`` is left
        # untouched so the conversation transcript and the matching
        # tool_call_id are preserved exactly as the model emitted them.
        #
        # Scope gate: the unwrap dispatches the underlying tool directly
        # (bypassing the bridge branch in handle_function_call and its
        # scope check), so we enforce session toolset scope HERE. A tool
        # the session was not granted is rejected before any checkpoint,
        # hook, or dispatch fires.
        _ts_scope_block = None
        try:
            from tools import tool_search as _ts
            if function_name == _ts.TOOL_CALL_NAME:
                _underlying, _underlying_args, _err = _ts.resolve_underlying_call(function_args)
                if not _err and _underlying:
                    if _underlying in _tool_search_scoped_names(agent):
                        function_name = _underlying
                        function_args = _underlying_args
                    else:
                        _ts_scope_block = json.dumps({
                            "error": (
                                f"'{_underlying}' is not available in this session. "
                                "Use tool_search to find tools you can call."
                            ),
                        }, ensure_ascii=False)
        except Exception:
            pass

        # ── Block evaluation (BEFORE checkpoint preflight) ───────────
        # We must know whether the tool will execute before touching
        # checkpoint state (dedup slot, real snapshots).
        block_result = None
        blocked_by_guardrail = False
        if _ts_scope_block is not None:
            # Out-of-scope tool_call: reject before hooks/guardrails/dispatch.
            block_result = _ts_scope_block
            _emit_terminal_post_tool_call(
                agent,
                function_name=function_name,
                function_args=function_args,
                result=block_result,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
                status="blocked",
                error_type="tool_scope_block",
                error_message=_ts_scope_block,
            )
        else:
            try:
                from fan_cli.plugins import get_pre_tool_call_block_message
                block_message = get_pre_tool_call_block_message(
                    function_name,
                    function_args,
                    task_id=effective_task_id or "",
                    session_id=getattr(agent, "session_id", "") or "",
                    tool_call_id=getattr(tool_call, "id", "") or "",
                    turn_id=getattr(agent, "_current_turn_id", "") or "",
                    api_request_id=getattr(agent, "_current_api_request_id", "") or "",
                )
            except Exception:
                block_message = None

            if block_message is not None:
                block_result = json.dumps({"error": block_message}, ensure_ascii=False)
                _emit_terminal_post_tool_call(
                    agent,
                    function_name=function_name,
                    function_args=function_args,
                    result=block_result,
                    effective_task_id=effective_task_id,
                    tool_call_id=getattr(tool_call, "id", "") or "",
                    status="blocked",
                    error_type="plugin_block",
                    error_message=block_message,
                )
            else:
                guardrail_decision = _navigation_failure_recovery_halt(
                    agent,
                    function_name,
                ) or agent._tool_guardrails.before_call(
                    function_name,
                    function_args,
                    browser_state=getattr(agent, "_browser_decision_token", None),
                )
                if not guardrail_decision.allows_execution:
                    block_result = agent._guardrail_block_result(guardrail_decision)
                    blocked_by_guardrail = True
                    _emit_terminal_post_tool_call(
                        agent,
                        function_name=function_name,
                        function_args=function_args,
                        result=block_result,
                        effective_task_id=effective_task_id,
                        tool_call_id=getattr(tool_call, "id", "") or "",
                        status="blocked",
                        error_type="guardrail_block",
                        error_message=getattr(guardrail_decision, "message", None) or "Tool blocked by guardrail policy",
                    )

        # ── Checkpoint preflight (only for tools that will execute) ──
        if block_result is None:
            # Checkpoint for file-mutating tools
            if function_name in {"write_file", "patch"} and agent._checkpoint_mgr.enabled:
                try:
                    _ensure_file_checkpoint(
                        agent,
                        function_name,
                        function_args,
                        effective_task_id,
                    )
                except Exception:
                    pass

            # Checkpoint before destructive terminal commands
            if function_name == "terminal" and agent._checkpoint_mgr.enabled:
                try:
                    cmd = function_args.get("command", "")
                    if _is_destructive_command(cmd):
                        cwd = function_args.get("workdir") or os.getenv("TERMINAL_CWD", os.getcwd())
                        agent._checkpoint_mgr.ensure_checkpoint(
                            cwd, f"before terminal: {cmd[:60]}"
                        )
                except Exception:
                    pass

        parsed_calls.append((tool_call, function_name, function_args, block_result, blocked_by_guardrail))

    # ── Logging / callbacks ──────────────────────────────────────────
    tool_names_str = ", ".join(name for _, name, _, _, _ in parsed_calls)
    if getattr(agent, "tool_progress_mode", "all") != "off":
        print(f"  ⚡ Concurrent: {num_tools} tool calls — {tool_names_str}")
        for i, (tc, name, args, block_result, blocked_by_guardrail) in enumerate(parsed_calls, 1):
            display_args = _redact_tool_args_for_display(name, args) or args
            args_str = json.dumps(display_args, ensure_ascii=False)
            if agent.verbose_logging:
                print(f"  📞 Tool {i}: {name}({list(display_args.keys())})")
                print(agent._wrap_verbose("Args: ", json.dumps(display_args, indent=2, ensure_ascii=False)))
            else:
                args_preview = args_str[:agent.log_prefix_chars] + "..." if len(args_str) > agent.log_prefix_chars else args_str
                print(f"  📞 Tool {i}: {name}({list(args.keys())}) - {args_preview}")

    for tc, name, args, block_result, blocked_by_guardrail in parsed_calls:
        if block_result is not None:
            continue
        if agent.tool_progress_callback:
            try:
                display_args = _redact_tool_args_for_display(name, args) or args
                preview = _build_tool_preview(name, display_args)
                agent.tool_progress_callback("tool.started", name, preview, display_args)
            except Exception as cb_err:
                logging.debug(f"Tool progress callback error: {cb_err}")

    for tc, name, args, block_result, blocked_by_guardrail in parsed_calls:
        if block_result is not None:
            continue
        if agent.tool_start_callback:
            try:
                display_args = _redact_tool_args_for_display(name, args) or args
                agent.tool_start_callback(tc.id, name, display_args)
            except Exception as cb_err:
                logging.debug(f"Tool start callback error: {cb_err}")

    # ── Concurrent execution ─────────────────────────────────────────
    # Each slot holds (function_name, function_args, function_result, duration, error_flag, blocked_flag)
    results = [None] * num_tools
    result_lock = threading.Lock()
    sealed_result_indices: set[int] = set()
    for i, (tc, name, args, block_result, blocked_by_guardrail) in enumerate(parsed_calls):
        if block_result is not None:
            _store_concurrent_result(
                results,
                result_lock,
                sealed_result_indices,
                i,
                (name, args, block_result, 0.0, True, True),
                seal=True,
            )

    # Touch activity before launching workers so the gateway knows
    # we're executing tools (not stuck).
    agent._current_tool = tool_names_str
    agent._touch_activity(f"executing {num_tools} tools concurrently: {tool_names_str}")

    def _run_tool(index, tool_call, function_name, function_args):
        """Worker function executed in a thread."""
        # Register this worker tid so the agent can fan out an interrupt
        # to it — see AIAgent.interrupt().  Must happen first thing, and
        # must be paired with discard + clear in the finally block.
        _worker_tid = threading.current_thread().ident
        with agent._tool_worker_threads_lock:
            agent._tool_worker_threads.add(_worker_tid)
        # Race: if the agent was interrupted between fan-out (which
        # snapshotted an empty/earlier set) and our registration, apply
        # the interrupt to our own tid now so is_interrupted() inside
        # the tool returns True on the next poll.
        if agent._interrupt_requested:
            try:
                _ra()._set_interrupt(True, _worker_tid)
            except Exception:
                pass
        # Set the activity callback on THIS worker thread so
        # _wait_for_process (terminal commands) can fire heartbeats.
        # The callback is thread-local; the main thread's callback
        # is invisible to worker threads.
        try:
            from tools.environments.base import set_activity_callback
            set_activity_callback(agent._touch_activity)
        except Exception:
            pass
        # Approval/sudo callbacks (thread-local) and the agent turn's
        # ContextVars are propagated by propagate_context_to_thread() at the
        # submit site below (GHSA-qg5c-hvr5-hjgr, #13617).
        start = time.time()
        try:
            try:
                if agent._interrupt_requested:
                    result = _cancelled_tool_result()
                    duration = time.time() - start
                    _store_concurrent_result(
                        results,
                        result_lock,
                        sealed_result_indices,
                        index,
                        (function_name, function_args, result, duration, True, False),
                    )
                    return
                result = agent._invoke_tool(
                    function_name,
                    function_args,
                    effective_task_id,
                    tool_call.id,
                    messages=messages,
                    pre_tool_block_checked=True,
                )
            except KeyboardInterrupt:
                try:
                    agent.interrupt("keyboard interrupt")
                except Exception:
                    pass
                result = _emit_cancelled_terminal_post_tool_call(
                    agent,
                    function_name=function_name,
                    function_args=function_args,
                    effective_task_id=effective_task_id,
                    tool_call_id=getattr(tool_call, "id", "") or "",
                    start_time=start,
                )
                duration = time.time() - start
                logger.info("tool %s cancelled (%.2fs)", function_name, duration)
                _store_concurrent_result(
                    results,
                    result_lock,
                    sealed_result_indices,
                    index,
                    (function_name, function_args, result, duration, True, False),
                )
                return
            except Exception as tool_error:
                result = f"Error executing tool '{function_name}': {tool_error}"
                logger.error("_invoke_tool raised for %s: %s", function_name, tool_error, exc_info=True)
            duration = time.time() - start
            is_error, _ = _detect_tool_failure(function_name, result)
            if is_error:
                logger.info("tool %s failed (%.2fs): %s", function_name, duration, result[:200])
            else:
                logger.info("tool %s completed (%.2fs, %d chars)", function_name, duration, len(result))
            _store_concurrent_result(
                results,
                result_lock,
                sealed_result_indices,
                index,
                (function_name, function_args, result, duration, is_error, False),
            )
        finally:
            # Tear down worker-tid tracking.  Clear any interrupt bit we may
            # have set so the next task scheduled onto this recycled tid
            # starts with a clean slate.  This MUST be in a finally block
            # because BaseException subclasses (CancelledError, KeyboardInterrupt)
            # bypass ``except Exception`` and would otherwise leak the tid
            # into _interrupted_threads, poisoning the recycled thread.
            with agent._tool_worker_threads_lock:
                agent._tool_worker_threads.discard(_worker_tid)
            try:
                _ra()._set_interrupt(False, _worker_tid)
            except Exception:
                pass

    # Start spinner for CLI mode (skip when TUI handles tool progress)
    spinner = None
    if agent._should_emit_quiet_tool_messages() and agent._should_start_quiet_spinner():
        face = random.choice(KawaiiSpinner.get_waiting_faces())
        spinner = KawaiiSpinner(f"{face} ⚡ running {num_tools} tools concurrently", spinner_type='dots', print_fn=agent._print_fn)
        spinner.start()

    try:
        runnable_calls = [
            (i, tc, name, args)
            for i, (tc, name, args, block_result, blocked_by_guardrail) in enumerate(parsed_calls)
            if block_result is None
        ]
        futures = []
        future_to_index = {}
        timeout_s = _resolve_concurrent_tool_timeout()
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        if runnable_calls:
            max_workers = min(len(runnable_calls), _MAX_TOOL_WORKERS)
            from tools.daemon_pool import DaemonThreadPoolExecutor

            executor = DaemonThreadPoolExecutor(max_workers=max_workers)
            abandon_executor = False
            try:
                for submit_index, (i, tc, name, args) in enumerate(runnable_calls):
                    # Propagate the agent turn's ContextVars (e.g.
                    # _approval_session_key) AND thread-local approval/sudo
                    # callbacks into the worker thread; clears callbacks on exit.
                    try:
                        f = executor.submit(
                            propagate_context_to_thread(_run_tool), i, tc, name, args
                        )
                    except RuntimeError as submit_error:
                        if not _is_interpreter_shutdown_submit_error(submit_error):
                            raise
                        skipped_calls = runnable_calls[submit_index:]
                        logger.warning(
                            "Interpreter shutdown while scheduling concurrent tools; "
                            "skipping %d unsubmitted tool(s)",
                            len(skipped_calls),
                        )
                        for skipped_i, _tc, skipped_name, skipped_args in skipped_calls:
                            result = (
                                f"Error executing tool '{skipped_name}': "
                                "Python interpreter is shutting down; tool was not started"
                            )
                            _store_concurrent_result(
                                results,
                                result_lock,
                                sealed_result_indices,
                                skipped_i,
                                (skipped_name, skipped_args, result, 0.0, True, False),
                                seal=True,
                            )
                        break
                    futures.append(f)
                    future_to_index[f] = i

                # Wait for all to complete with periodic heartbeats so the
                # gateway's inactivity monitor doesn't kill us during long
                # concurrent tool batches. Also check for user interrupts
                # so we don't block indefinitely when the user sends /stop
                # or a new message during concurrent tool execution.
                _conc_start = time.time()
                _interrupt_logged = False
                while True:
                    wait_timeout = 5.0
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            done, not_done = set(), {f for f in futures if not f.done()}
                        else:
                            wait_timeout = min(wait_timeout, remaining)
                            done, not_done = concurrent.futures.wait(
                                futures, timeout=wait_timeout,
                            )
                    else:
                        done, not_done = concurrent.futures.wait(
                            futures, timeout=wait_timeout,
                        )
                    if not not_done:
                        break

                    if deadline is not None and time.monotonic() >= deadline:
                        abandon_executor = True
                        elapsed = timeout_s or 0.0
                        timed_out_indices = {
                            future_to_index[future]
                            for future in not_done
                            if future in future_to_index
                        }
                        names = [parsed_calls[index][1] for index in timed_out_indices]
                        logger.warning(
                            "concurrent tool batch timed out after %.1fs; %d tool(s) "
                            "still running: %s",
                            elapsed,
                            len(timed_out_indices),
                            ", ".join(names[:5]),
                        )
                        for future in not_done:
                            future.cancel()
                        with agent._tool_worker_threads_lock:
                            worker_tids = list(agent._tool_worker_threads)
                        for tid in worker_tids:
                            try:
                                _ra()._set_interrupt(True, tid)
                            except Exception:
                                pass
                        for index in timed_out_indices:
                            tc, name, args, _block, _guardrail = parsed_calls[index]
                            result = json.dumps(
                                {
                                    "error": "Concurrent tool execution timed out",
                                    "tool": name,
                                    "timeout_seconds": elapsed,
                                },
                                ensure_ascii=False,
                            )
                            _store_concurrent_result(
                                results,
                                result_lock,
                                sealed_result_indices,
                                index,
                                (name, args, result, elapsed, True, False),
                                seal=True,
                            )
                            _emit_terminal_post_tool_call(
                                agent,
                                function_name=name,
                                function_args=args,
                                result=result,
                                effective_task_id=effective_task_id,
                                tool_call_id=getattr(tc, "id", "") or "",
                                status="error",
                                error_type="concurrent_tool_timeout",
                                error_message=result,
                            )
                        break

                    # Check for interrupt — the per-thread interrupt signal
                    # already causes individual tools (terminal, execute_code)
                    # to abort, but tools without interrupt checks (read_file)
                    # will run to completion. Cancel any futures
                    # that haven't started yet so we don't block on them.
                    if agent._interrupt_requested:
                        abandon_executor = True
                        if not _interrupt_logged:
                            _interrupt_logged = True
                            agent._vprint(
                                f"{agent.log_prefix}⚡ Interrupt: cancelling "
                                f"{len(not_done)} pending concurrent tool(s)",
                                force=True,
                            )
                        for f in not_done:
                            f.cancel()
                        # Give already-running tools a moment to notice the
                        # per-thread interrupt signal and exit gracefully.
                        concurrent.futures.wait(not_done, timeout=3.0)
                        break

                    _conc_elapsed = int(time.time() - _conc_start)
                    # Heartbeat every ~30s (6 × 5s poll intervals)
                    if _conc_elapsed > 0 and _conc_elapsed % 30 < 6:
                        _still_running = [
                            parsed_calls[future_to_index[f]][1]
                            for f in not_done
                            if f in future_to_index
                        ]
                        agent._touch_activity(
                            f"concurrent tools running ({_conc_elapsed}s, "
                            f"{len(not_done)} remaining: {', '.join(_still_running[:3])})"
                        )
            finally:
                # Hung workers are detached daemon threads. Normal completion
                # still joins so callbacks/results are fully settled.
                executor.shutdown(
                    wait=not abandon_executor,
                    cancel_futures=abandon_executor,
                )
    finally:
        if spinner:
            # Build a summary message for the spinner stop
            completed = sum(1 for r in results if r is not None)
            total_dur = sum(r[3] for r in results if r is not None)
            spinner.stop(f"⚡ {completed}/{num_tools} tools completed in {total_dur:.1f}s total")

    if _human_resume_generation() != human_resume_generation:
        # A parallel-safe tool (for example MCP elicitation) may still block
        # for human input in a worker thread. The shared session generation
        # carries that boundary back to this thread so the next model turn
        # cannot reuse browser state captured before the user intervened.
        _record_trusted_browser_control_boundary(agent)
        agent._browser_force_observe = True
        agent._browser_decision_token = None

    # ── Post-execution: display per-tool results ─────────────────────
    for i, (tc, name, args, block_result, blocked_by_guardrail) in enumerate(parsed_calls):
        r = results[i]
        blocked = False
        if r is None:
            # Tool was cancelled (interrupt) or thread didn't return
            if agent._interrupt_requested:
                function_result = f"[Tool execution cancelled — {name} was skipped due to user interrupt]"
                _emit_terminal_post_tool_call(
                    agent,
                    function_name=name,
                    function_args=args,
                    result=function_result,
                    effective_task_id=effective_task_id,
                    tool_call_id=getattr(tc, "id", "") or "",
                    status="cancelled",
                    error_type="keyboard_interrupt",
                    error_message="Tool execution cancelled by user interrupt",
                )
            else:
                function_result = f"Error executing tool '{name}': thread did not return a result"
                _emit_terminal_post_tool_call(
                    agent,
                    function_name=name,
                    function_args=args,
                    result=function_result,
                    effective_task_id=effective_task_id,
                    tool_call_id=getattr(tc, "id", "") or "",
                    status="error",
                    error_type="thread_missing_result",
                    error_message=function_result,
                )
            tool_duration = 0.0
        else:
            function_name, function_args, function_result, tool_duration, is_error, blocked = r

            if not blocked:
                _record_turn_browser_navigation_failure(
                    agent,
                    function_name,
                    function_result,
                    failed=is_error,
                )
                function_result = agent._append_guardrail_observation(
                    function_name,
                    function_args,
                    function_result,
                    failed=is_error,
                )
                function_result = record_browser_action_outcome(
                    getattr(agent, "_turn_unresolved_browser_action", None),
                    function_name,
                    function_result,
                    failed=is_error,
                )

            if is_error:
                _err_text = _multimodal_text_summary(function_result)
                result_preview = _err_text[:200] if len(_err_text) > 200 else _err_text
                logger.warning("Tool %s returned error (%.2fs): %s", function_name, tool_duration, result_preview)

            # Track file-mutation outcome for the turn-end verifier.
            # `blocked` calls never actually ran — don't let a guardrail
            # block count as either a failure or a success.
            if not blocked:
                try:
                    agent._record_file_mutation_result(
                        function_name, function_args, function_result, is_error,
                    )
                except Exception as _ver_err:
                    logging.debug("file-mutation verifier record failed: %s", _ver_err)

            if not blocked and agent.tool_progress_callback:
                try:
                    agent.tool_progress_callback(
                        "tool.completed", function_name, None, None,
                        duration=tool_duration, is_error=is_error,
                        result=function_result,
                    )
                except Exception as cb_err:
                    logging.debug(f"Tool progress callback error: {cb_err}")

            if agent.verbose_logging:
                logging.debug(f"Tool {function_name} completed in {tool_duration:.2f}s")
                logging.debug(f"Tool result ({len(function_result)} chars): {function_result}")

        # Print cute message per tool
        if agent._should_emit_quiet_tool_messages():
            cute_msg = _get_cute_tool_message_impl(name, args, tool_duration, result=function_result)
            agent._safe_print(f"  {cute_msg}")
        elif getattr(agent, "tool_progress_mode", "all") != "off":
            _preview_str = _multimodal_text_summary(function_result)
            if agent.verbose_logging:
                print(f"  ✅ Tool {i+1} completed in {tool_duration:.2f}s")
                print(agent._wrap_verbose("Result: ", _preview_str))
            else:
                response_preview = _preview_str[:agent.log_prefix_chars] + "..." if len(_preview_str) > agent.log_prefix_chars else _preview_str
                print(f"  ✅ Tool {i+1} completed in {tool_duration:.2f}s - {response_preview}")

        agent._current_tool = None
        agent._touch_activity(f"tool completed: {name} ({tool_duration:.1f}s)")

        if not blocked and agent.tool_complete_callback:
            try:
                display_args = _redact_tool_args_for_display(name, args) or args
                agent.tool_complete_callback(tc.id, name, display_args, function_result)
            except Exception as cb_err:
                logging.debug(f"Tool complete callback error: {cb_err}")

        try:  # 全量日志:标记工具【真正执行完毕】(区别于响应里"模型决定调用的工具"那是意图)
            from agent import llm_io_log
            display_args = _redact_tool_args_for_display(name, args) or args
            llm_io_log.log_tool(name, display_args, function_result, duration_ms=int(tool_duration * 1000))
        except Exception:
            pass

        function_result = maybe_persist_tool_result(
            content=function_result,
            tool_name=name,
            tool_use_id=tc.id,
            env=get_active_env(effective_task_id),
            env_factory=_persist_env_factory(effective_task_id),
            config=tool_budget,
        ) if not _is_multimodal_tool_result(function_result) else function_result

        subdir_hints = agent._subdirectory_hints.check_tool_call(name, args)
        if subdir_hints:
            if _is_multimodal_tool_result(function_result):
                # Append the hint to the text summary part so the model
                # still sees it; don't touch the image blocks.
                _append_subdir_hint_to_multimodal(function_result, subdir_hints)
            else:
                function_result += subdir_hints

        # Unwrap _multimodal dicts to an OpenAI-style content list so any
        # vision-capable provider receives [{type:text},{type:image_url}]
        # rather than a raw Python dict. Vision-capable OpenAI-compatible servers
        # (mlx-vlm, GPT-4o, …) accept image_url in tool messages natively.
        # Text-only servers get a string-safe fallback here so a rejected
        # image tool result never poisons canonical session history.
        # String results pass through unchanged.
        _tool_content = agent._tool_result_content_for_active_model(name, function_result)
        release_superseded_observation_images(messages, _tool_content)
        tool_message = make_tool_result_message(name, _tool_content, tc.id)
        _record_model_visible_browser_observation(
            agent,
            name,
            _tool_content,
            None,
            canonical_content=tool_message.get("content"),
        )
        messages.append(tool_message)
        risk_metadata = tool_message.get("_tool_output_risk")
        if (
            risk_metadata is not None
            and risk_metadata.get("risk") != "low"
            and agent.tool_progress_callback
        ):
            try:
                agent.tool_progress_callback(
                    "tool.output_risk",
                    name,
                    None,
                    None,
                    tool_call_id=tc.id,
                    risk_metadata=risk_metadata,
                )
            except Exception as callback_error:
                logging.debug("Tool output risk callback error: %s", callback_error)
        _flush_session_db_after_tool_progress(
            agent,
            messages,
            stage=f"tool result {name}",
        )

        # ── Per-tool /steer drain ───────────────────────────────────
        # Same as the sequential path: drain between each collected
        # result so the steer lands as early as possible.
        agent._apply_pending_steer_to_tool_results(messages, 1)

    # ── Per-turn aggregate budget enforcement ─────────────────────────
    num_tools = len(parsed_calls)
    if num_tools > 0:
        turn_tool_msgs = messages[-num_tools:]
        enforce_turn_budget(
            turn_tool_msgs,
            env=get_active_env(effective_task_id),
            env_factory=_persist_env_factory(effective_task_id),
            config=tool_budget,
        )

    # ── /steer injection ──────────────────────────────────────────────
    # Append any pending user steer text to the last tool result so the
    # agent sees it on its next iteration. Runs AFTER budget enforcement
    # so the steer marker is never truncated. See steer() for details.
    if num_tools > 0:
        agent._apply_pending_steer_to_tool_results(messages, num_tools)



def execute_tool_calls_sequential(agent, assistant_message, messages: list, effective_task_id: str, api_call_count: int = 0) -> None:
    """Execute tool calls sequentially (original behavior). Used for single calls or interactive tools."""
    tool_budget = _budget_for_agent(agent)
    browser_replan_barrier: tuple[str, str] | None = None
    browser_terminal_barrier_decision: ToolGuardrailDecision | None = None
    pending_form_submit_steps: dict[int, dict[str, Any]] = {}
    for i, tool_call in enumerate(assistant_message.tool_calls, 1):
        cached_form_submit_step = pending_form_submit_steps.pop(i, None)
        must_settle_cached_runtime = bool(
            cached_form_submit_step is not None
            and cached_form_submit_step.get("kind")
            in {"runtime", "prerequisite-skipped", "blocked"}
        )
        human_resume_generation = _human_resume_generation()
        # SAFETY: check interrupt BEFORE starting each tool.
        # If the user sent "stop" during a previous tool's execution,
        # do NOT start any more tools -- skip them all immediately.
        if agent._interrupt_requested and not must_settle_cached_runtime:
            remaining_calls = assistant_message.tool_calls[i-1:]
            if remaining_calls:
                agent._vprint(f"{agent.log_prefix}⚡ Interrupt: skipping {len(remaining_calls)} tool call(s)", force=True)
            for skipped_tc in remaining_calls:
                skipped_name = skipped_tc.function.name
                messages.append(make_tool_result_message(
                    skipped_name,
                    f"[Tool execution cancelled — {skipped_name} was skipped due to user interrupt]",
                    skipped_tc.id,
                ))
                _flush_session_db_after_tool_progress(
                    agent,
                    messages,
                    stage=f"cancelled tool result {skipped_name}",
                )
            break

        function_name = tool_call.function.name

        # A prior browser action in this same assistant response changed the
        # world the remaining calls were planned against.  Settle direct browser_*
        # calls before even parsing their arguments; a malformed stale call must
        # not obscure the stronger "not executed" guarantee.
        if (
            cached_form_submit_step is None
            and browser_replan_barrier is not None
            and is_browser_tool(function_name)
        ):
            trigger_tool, reason = browser_replan_barrier
            _append_browser_replan_skip(
                agent,
                messages,
                tool_call=tool_call,
                function_name=function_name,
                function_args={},
                effective_task_id=effective_task_id,
                trigger_tool=trigger_tool,
                reason=reason,
                terminal_decision=browser_terminal_barrier_decision,
            )
            continue

        function_args, malformed_args_result = _parse_tool_arguments(
            tool_call.function.arguments
        )
        if malformed_args_result is not None:
            _emit_terminal_post_tool_call(
                agent,
                function_name=function_name,
                function_args={},
                result=malformed_args_result,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
                status="error",
                error_type="invalid_tool_arguments",
                error_message="Tool arguments were not a valid JSON object",
            )
            messages.append(
                make_tool_result_message(
                    function_name,
                    malformed_args_result,
                    tool_call.id,
                )
            )
            _flush_session_db_after_tool_progress(
                agent,
                messages,
                stage=f"malformed tool result {function_name}",
            )
            agent._apply_pending_steer_to_tool_results(messages, 1)
            if is_browser_tool(function_name):
                browser_replan_barrier = (
                    function_name,
                    "The previous browser tool had invalid arguments. Later browser "
                    "calls in the same turn were not executed to avoid continuing from "
                    "an unverified state.",
                )
            continue

        # Tool Search unwrap — see execute_tool_calls_concurrent for full
        # rationale, including the scope gate (the unwrap dispatches the
        # underlying tool directly, so session toolset scope is enforced here).
        _ts_scope_block: Optional[str] = None
        try:
            from tools import tool_search as _ts
            if function_name == _ts.TOOL_CALL_NAME:
                _underlying, _underlying_args, _err = _ts.resolve_underlying_call(function_args)
                if not _err and _underlying:
                    if _underlying in _tool_search_scoped_names(agent):
                        function_name = _underlying
                        function_args = _underlying_args
                    else:
                        _ts_scope_block = (
                            f"'{_underlying}' is not available in this session. "
                            "Use tool_search to find tools you can call."
                        )
        except Exception:
            pass

        # tool_search may unwrap to an browser_* tool.  Apply the same barrier after
        # unwrapping so the bridge cannot bypass browser batch semantics.
        if (
            cached_form_submit_step is None
            and browser_replan_barrier is not None
            and is_browser_tool(function_name)
        ):
            trigger_tool, reason = browser_replan_barrier
            _append_browser_replan_skip(
                agent,
                messages,
                tool_call=tool_call,
                function_name=function_name,
                function_args=function_args,
                effective_task_id=effective_task_id,
                trigger_tool=trigger_tool,
                reason=reason,
                terminal_decision=browser_terminal_barrier_decision,
            )
            continue

        # Check plugin hooks for a block directive before executing.
        _block_msg: Optional[str] = None
        _block_error_type = "plugin_block"
        _guardrail_block_decision: ToolGuardrailDecision | None = None
        _form_submit_plan: dict[str, Any] | None = None
        if cached_form_submit_step is not None:
            function_args = cached_form_submit_step.get("function_args", function_args)
        if (
            cached_form_submit_step is not None
            and cached_form_submit_step.get("kind") != "prerequisite-skipped"
        ):
            _block_msg = cached_form_submit_step.get("block_message")
            _block_error_type = cached_form_submit_step.get(
                "block_error_type", "plugin_block"
            )
            _guardrail_block_decision = cached_form_submit_step.get(
                "guardrail_block"
            )
        elif _ts_scope_block is not None:
            _block_msg = _ts_scope_block
            _block_error_type = "tool_scope_block"
        else:
            (
                _block_msg,
                _block_error_type,
                _guardrail_block_decision,
            ) = _preflight_tool_execution(
                agent,
                function_name,
                function_args,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
            )

        _execution_blocked = _block_msg is not None or _guardrail_block_decision is not None

        if (
            _guardrail_block_decision is not None
            and is_browser_tool(function_name)
            and (
                _guardrail_block_decision.code == "strategy_pivot_required"
                or _guardrail_block_decision.should_halt
            )
        ):
            # A blocked third/fifth no-progress attempt is itself the recovery
            # boundary. Calls later in this assistant batch were authored before
            # the model saw that pivot instruction, so none of them may execute.
            # A sixth-outcome (or other terminal browser) decision is stronger:
            # settle every remaining browser tool_call_id without dispatch while
            # still allowing unrelated non-browser tools to finish.
            if _guardrail_block_decision.should_halt:
                barrier_reason = (
                    "The browser tool loop reached its termination condition for this "
                    "turn. Later browser calls in the same turn were not executed."
                )
                browser_terminal_barrier_decision = _guardrail_block_decision
            else:
                barrier_reason = (
                    "The browser tool loop requires the strategy-pivot guidance to be "
                    "returned to the model first. Later browser calls in the same turn "
                    "were not executed and await the next model decision."
                )
                browser_terminal_barrier_decision = None
            browser_replan_barrier = (function_name, barrier_reason)

        # The only exception to the ordinary post-mutation replan barrier is a
        # direct, adjacent form input -> indexed click pair. Recognize the pair
        # even when the input preflight blocks: the declared click still needs
        # its own safely-skipped settlement and must never execute by itself.
        if (
            cached_form_submit_step is None
            and getattr(tool_call.function, "name", None) == function_name
        ):
            candidate = _adjacent_form_submit_candidate(
                assistant_message.tool_calls,
                i - 1,
                function_name,
                function_args,
            )
            if candidate is not None:
                submit_call, submit_args = candidate
                if _execution_blocked:
                    reason = (
                        "The adjacent form input was blocked before execution; "
                        "the submit click was not executed and requires replanning."
                    )
                    pending_form_submit_steps[i + 1] = {
                        "kind": "prerequisite-skipped",
                        "function_args": submit_args,
                        "result": browser_replan_result(
                            function_name,
                            reason=reason,
                        ),
                        "duration": 0.0,
                        "terminal_status": "skipped",
                        "started": False,
                    }
                else:
                    # Preflight the click before any field changes; if both calls
                    # are allowed the renderer can validate and execute them
                    # atomically against the original snapshot.
                    (
                        submit_block_message,
                        submit_block_error_type,
                        submit_guardrail_block,
                    ) = _preflight_tool_execution(
                        agent,
                        "browser_click",
                        submit_args,
                        effective_task_id=effective_task_id,
                        tool_call_id=getattr(submit_call, "id", "") or "",
                    )
                    if submit_block_message is not None or submit_guardrail_block is not None:
                        pending_form_submit_steps[i + 1] = {
                            "kind": "blocked",
                            "function_args": submit_args,
                            "block_message": submit_block_message,
                            "block_error_type": submit_block_error_type,
                            "guardrail_block": submit_guardrail_block,
                        }
                        if (
                            submit_guardrail_block is not None
                            and (
                                submit_guardrail_block.code
                                == "strategy_pivot_required"
                                or submit_guardrail_block.should_halt
                            )
                        ):
                            # The submit call is preflighted before the input is
                            # dispatched so both can run atomically. If that
                            # preflight reaches a pivot/terminal boundary, do
                            # not let the still-unexecuted input slip past it.
                            if submit_guardrail_block.should_halt:
                                barrier_reason = (
                                    "The browser tool loop reached its termination "
                                    "condition for this turn. Later browser calls in "
                                    "the same turn were not executed."
                                )
                                browser_terminal_barrier_decision = (
                                    submit_guardrail_block
                                )
                            else:
                                barrier_reason = (
                                    "The browser tool loop requires the strategy-pivot "
                                    "guidance to be returned to the model first. Later "
                                    "browser calls in the same turn were not executed "
                                    "and await the next model decision."
                                )
                                browser_terminal_barrier_decision = None
                            browser_replan_barrier = (
                                "browser_click",
                                barrier_reason,
                            )
                            _append_browser_replan_skip(
                                agent,
                                messages,
                                tool_call=tool_call,
                                function_name=function_name,
                                function_args=function_args,
                                effective_task_id=effective_task_id,
                                trigger_tool="browser_click",
                                reason=barrier_reason,
                                terminal_decision=(
                                    browser_terminal_barrier_decision
                                ),
                            )
                            continue
                    else:
                        _form_submit_plan = {
                            "tool_call": submit_call,
                            "function_args": submit_args,
                        }

        _same_snapshot_continue = bool(
            not _execution_blocked
            and cached_form_submit_step is None
            and _form_submit_plan is None
            and getattr(tool_call.function, "name", None) == function_name
            and _has_adjacent_same_snapshot_call(
                assistant_message.tool_calls,
                i - 1,
                function_name,
                function_args,
            )
        )
        _dispatch_function_args = function_args
        if _same_snapshot_continue:
            _dispatch_function_args = {
                **function_args,
                "_fan_same_snapshot_continue": True,
            }

        _tool_already_started = bool(
            cached_form_submit_step is not None
            and cached_form_submit_step.get("started")
        )

        if _execution_blocked:
            # Tool blocked by plugin or guardrail policy — skip counters,
            # callbacks, checkpointing, activity mutation, and real execution.
            pass
        # Reset nudge counters when the relevant tool is actually used
        elif function_name == "memory":
            agent._turns_since_memory = 0
        elif function_name == "skill_manage":
            agent._iters_since_skill = 0

        if getattr(agent, "tool_progress_mode", "all") != "off":
            display_args = _redact_tool_args_for_display(function_name, function_args) or function_args
            args_str = json.dumps(display_args, ensure_ascii=False)
            if agent.verbose_logging:
                print(f"  📞 Tool {i}: {function_name}({list(display_args.keys())})")
                print(agent._wrap_verbose("Args: ", json.dumps(display_args, indent=2, ensure_ascii=False)))
            else:
                args_preview = args_str[:agent.log_prefix_chars] + "..." if len(args_str) > agent.log_prefix_chars else args_str
                print(f"  📞 Tool {i}: {function_name}({list(function_args.keys())}) - {args_preview}")

        if not _execution_blocked and not _tool_already_started:
            agent._current_tool = function_name
            agent._touch_activity(f"executing tool: {function_name}")

        # Set activity callback for long-running tool execution (terminal
        # commands, etc.) so the gateway's inactivity monitor doesn't kill
        # the agent while a command is running.
        if not _execution_blocked and not _tool_already_started:
            try:
                from tools.environments.base import set_activity_callback
                set_activity_callback(agent._touch_activity)
            except Exception:
                pass

        if not _execution_blocked and not _tool_already_started and agent.tool_progress_callback:
            try:
                display_args = _redact_tool_args_for_display(function_name, function_args) or function_args
                preview = _build_tool_preview(function_name, display_args)
                agent.tool_progress_callback("tool.started", function_name, preview, display_args)
            except Exception as cb_err:
                logging.debug(f"Tool progress callback error: {cb_err}")

        if not _execution_blocked and not _tool_already_started and agent.tool_start_callback:
            try:
                display_args = _redact_tool_args_for_display(function_name, function_args) or function_args
                agent.tool_start_callback(tool_call.id, function_name, display_args)
            except Exception as cb_err:
                logging.debug(f"Tool start callback error: {cb_err}")
        if (
            not _execution_blocked
            and not _tool_already_started
            and not must_settle_cached_runtime
            and agent._interrupt_requested
        ):
            _block_msg = "Tool execution cancelled by user interrupt"
            _block_error_type = "keyboard_interrupt"
            _execution_blocked = True

        # Checkpoint: snapshot working dir before file-mutating tools
        if not _execution_blocked and function_name in {"write_file", "patch"} and agent._checkpoint_mgr.enabled:
            try:
                _ensure_file_checkpoint(
                    agent,
                    function_name,
                    function_args,
                    effective_task_id,
                )
            except Exception:
                pass  # never block tool execution

        # Checkpoint before destructive terminal commands
        if not _execution_blocked and function_name == "terminal" and agent._checkpoint_mgr.enabled:
            try:
                cmd = function_args.get("command", "")
                if _is_destructive_command(cmd):
                    cwd = function_args.get("workdir") or os.getenv("TERMINAL_CWD", os.getcwd())
                    agent._checkpoint_mgr.ensure_checkpoint(
                        cwd, f"before terminal: {cmd[:60]}"
                    )
            except Exception:
                pass  # never block tool execution

        tool_start_time = time.time()
        _form_submit_lowered_step = False
        _form_submit_terminal_status: str | None = None

        if _block_msg is not None:
            # Tool blocked by plugin policy — return error without executing.
            function_result = json.dumps({"error": _block_msg}, ensure_ascii=False)
            tool_duration = 0.0
            _emit_terminal_post_tool_call(
                agent,
                function_name=function_name,
                function_args=function_args,
                result=function_result,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
                status="blocked",
                error_type=_block_error_type,
                error_message=_block_msg,
            )
        elif _guardrail_block_decision is not None:
            # Tool blocked by tool-loop guardrail — synthesize exactly one
            # tool result for the original tool_call_id without executing.
            function_result = agent._guardrail_block_result(_guardrail_block_decision)
            tool_duration = 0.0
            _emit_terminal_post_tool_call(
                agent,
                function_name=function_name,
                function_args=function_args,
                result=function_result,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
                status="blocked",
                error_type="guardrail_block",
                error_message=getattr(_guardrail_block_decision, "message", None) or "Tool blocked by guardrail policy",
            )
        elif (
            cached_form_submit_step is not None
            and cached_form_submit_step.get("kind")
            in {"runtime", "prerequisite-skipped"}
        ):
            function_result = cached_form_submit_step["result"]
            tool_duration = float(cached_form_submit_step.get("duration", 0.0))
            _form_submit_terminal_status = cached_form_submit_step.get(
                "terminal_status"
            )
            _form_submit_lowered_step = True
        elif _form_submit_plan is not None:
            from tools.electron_browser_tool import _browser_form_submit_transaction

            submit_terminal_status: str | None = None
            try:
                with _browser_decision_context(agent, function_name):
                    function_result, submit_result = _browser_form_submit_transaction(
                        function_name,
                        function_args,
                        _form_submit_plan["function_args"],
                        task_id=effective_task_id,
                    )
            except KeyboardInterrupt:
                # The click's pre-hook already ran, while the single runtime RPC
                # may have crossed either physical step before interruption.
                # Settle both declared call ids as unknown/cancelled; never emit
                # a false "not executed" claim or leave the click hook dangling.
                function_result = _interrupted_form_submit_result()
                submit_result = _interrupted_form_submit_result()
                _form_submit_terminal_status = "cancelled"
                submit_terminal_status = "cancelled"
                try:
                    agent.interrupt("keyboard interrupt")
                except Exception:
                    pass
            except Exception as tool_error:
                unknown_reason = (
                    "The form transaction raised after dispatch may have begun, so "
                    "both input and submit have an unknown execution state. Do not "
                    "retry blindly; observe and verify first."
                )
                function_result = _unknown_form_submit_result(
                    code="FORM_SUBMIT_EXECUTOR_EXCEPTION",
                    reason=unknown_reason,
                )
                submit_result = function_result
                _form_submit_terminal_status = "error"
                submit_terminal_status = "error"
                logger.error(
                    "browser form submit transaction raised: %s",
                    tool_error,
                    exc_info=True,
                )
            tool_duration = time.time() - tool_start_time
            pending_form_submit_steps[i + 1] = {
                "kind": "runtime",
                "function_args": _form_submit_plan["function_args"],
                "result": submit_result,
                "duration": 0.0,
                "terminal_status": submit_terminal_status,
                # The runtime already settled the physical click, but its
                # model/UI step has not started yet. The next loop iteration
                # emits start+complete back-to-back and must run even if a user
                # interrupt arrived after the transaction returned.
                "started": False,
            }
            _form_submit_lowered_step = True
        elif function_name == "todo":
            from tools.todo_tool import todo_tool as _todo_tool
            function_result = _todo_tool(
                todos=function_args.get("todos"),
                merge=function_args.get("merge", False),
                store=agent._todo_store,
            )
            tool_duration = time.time() - tool_start_time
            if agent._should_emit_quiet_tool_messages():
                agent._vprint(f"  {_get_cute_tool_message_impl('todo', function_args, tool_duration, result=function_result)}")
        elif function_name == "session_search":
            session_db = agent._get_session_db_for_recall()
            if not session_db:
                from fan_state import format_session_db_unavailable
                function_result = json.dumps({"success": False, "error": format_session_db_unavailable()})
            else:
                from tools.session_search_tool import session_search as _session_search
                function_result = _session_search(
                    query=function_args.get("query", ""),
                    role_filter=function_args.get("role_filter"),
                    limit=function_args.get("limit", 3),
                    session_id=function_args.get("session_id"),
                    around_message_id=function_args.get("around_message_id"),
                    window=function_args.get("window", 5),
                    sort=function_args.get("sort"),
                    db=session_db,
                    current_session_id=agent.session_id,
                )
            tool_duration = time.time() - tool_start_time
            if agent._should_emit_quiet_tool_messages():
                agent._vprint(f"  {_get_cute_tool_message_impl('session_search', function_args, tool_duration, result=function_result)}")
        elif function_name == "memory":
            target = function_args.get("target", "memory")
            from tools.memory_tool import memory_tool as _memory_tool
            function_result = _memory_tool(
                action=function_args.get("action"),
                target=target,
                content=function_args.get("content"),
                old_text=function_args.get("old_text"),
                store=agent._memory_store,
            )
            if agent._memory_manager:
                try:
                    agent._memory_manager.notify_memory_tool_write(
                        function_result,
                        function_args,
                        build_metadata=lambda: agent._build_memory_write_metadata(
                            task_id=effective_task_id,
                            tool_call_id=getattr(tool_call, "id", None),
                        ),
                    )
                except Exception:
                    pass
            tool_duration = time.time() - tool_start_time
            if agent._should_emit_quiet_tool_messages():
                agent._vprint(f"  {_get_cute_tool_message_impl('memory', function_args, tool_duration, result=function_result)}")
        elif function_name == "collect":
            from tools.collect_tool import collect_tool as _collect_tool
            collect_tool_call_id = getattr(tool_call, "id", None)
            collect_callback = (
                lambda payload: agent.collect_callback(
                    {**payload, "tool_call_id": collect_tool_call_id}
                )
                if agent.collect_callback is not None
                else None
            )
            function_result = _collect_tool(
                question=function_args.get("question", ""),
                choices=function_args.get("choices"),
                fields=function_args.get("fields"),
                questions=function_args.get("questions"),
                submit_label=function_args.get("submit_label"),
                skip_label=function_args.get("skip_label"),
                submitted_label=function_args.get("submitted_label"),
                skipped_label=function_args.get("skipped_label"),
                callback=collect_callback,
            )
            # Gateway callbacks pass through the common _block() path, which
            # already marks the resume. A CLI callback does not, so mark it
            # here only when the callback actually completed an interaction.
            if _human_resume_generation() == human_resume_generation:
                try:
                    collect_result = json.loads(function_result)
                except (TypeError, ValueError):
                    collect_result = None
                if isinstance(collect_result, dict) and collect_result.get("status") in {
                    "submitted", "skipped", "cancelled", "expired", "interrupted"
                }:
                    mark_human_interaction_resumed()
            tool_duration = time.time() - tool_start_time
            if agent._should_emit_quiet_tool_messages():
                agent._vprint(f"  {_get_cute_tool_message_impl('collect', function_args, tool_duration, result=function_result)}")
        elif function_name == "delegate_task":
            tasks_arg = function_args.get("tasks")
            if tasks_arg and isinstance(tasks_arg, list):
                spinner_label = f"🔀 delegating {len(tasks_arg)} tasks · (/agents to monitor)"
            else:
                goal_preview = (function_args.get("goal") or "")[:30]
                spinner_label = (
                    f"🔀 {goal_preview} · (/agents to monitor)"
                    if goal_preview
                    else "🔀 delegating · (/agents to monitor)"
                )
            spinner = None
            if agent._should_emit_quiet_tool_messages() and agent._should_start_quiet_spinner():
                face = random.choice(KawaiiSpinner.get_waiting_faces())
                spinner = KawaiiSpinner(f"{face} {spinner_label}", spinner_type='dots', print_fn=agent._print_fn)
                spinner.start()
            agent._delegate_spinner = spinner
            _delegate_result = None
            try:
                function_result = agent._dispatch_delegate_task(function_args)
                _delegate_result = function_result
            finally:
                agent._delegate_spinner = None
                tool_duration = time.time() - tool_start_time
                cute_msg = _get_cute_tool_message_impl('delegate_task', function_args, tool_duration, result=_delegate_result)
                if spinner:
                    spinner.stop(cute_msg)
                elif agent._should_emit_quiet_tool_messages():
                    agent._vprint(f"  {cute_msg}")
        elif agent._context_engine_tool_names and function_name in agent._context_engine_tool_names:
            # Context engine tools (lcm_grep, lcm_describe, lcm_expand, etc.)
            spinner = None
            if agent._should_emit_quiet_tool_messages():
                face = random.choice(KawaiiSpinner.get_waiting_faces())
                emoji = _get_tool_emoji(function_name)
                preview = _build_tool_preview(function_name, function_args) or function_name
                spinner = KawaiiSpinner(f"{face} {emoji} {preview}", spinner_type='dots', print_fn=agent._print_fn)
                spinner.start()
            _ce_result = None
            try:
                function_result = agent.context_compressor.handle_tool_call(function_name, function_args, messages=messages)
                _ce_result = function_result
            except Exception as tool_error:
                function_result = json.dumps({"error": f"Context engine tool '{function_name}' failed: {tool_error}"})
                logger.error("context_engine.handle_tool_call raised for %s: %s", function_name, tool_error, exc_info=True)
            finally:
                tool_duration = time.time() - tool_start_time
                cute_msg = _get_cute_tool_message_impl(function_name, function_args, tool_duration, result=_ce_result)
                if spinner:
                    spinner.stop(cute_msg)
                elif agent._should_emit_quiet_tool_messages():
                    agent._vprint(f"  {cute_msg}")
        elif agent._memory_manager and agent._memory_manager.has_tool(function_name):
            # Memory provider tools (hindsight_retain, honcho_search, etc.)
            # These are not in the tool registry — route through MemoryManager.
            spinner = None
            if agent._should_emit_quiet_tool_messages() and agent._should_start_quiet_spinner():
                face = random.choice(KawaiiSpinner.get_waiting_faces())
                emoji = _get_tool_emoji(function_name)
                preview = _build_tool_preview(function_name, function_args) or function_name
                spinner = KawaiiSpinner(f"{face} {emoji} {preview}", spinner_type='dots', print_fn=agent._print_fn)
                spinner.start()
            _mem_result = None
            try:
                function_result = agent._memory_manager.handle_tool_call(function_name, function_args)
                _mem_result = function_result
            except Exception as tool_error:
                function_result = json.dumps({"error": f"Memory tool '{function_name}' failed: {tool_error}"})
                logger.error("memory_manager.handle_tool_call raised for %s: %s", function_name, tool_error, exc_info=True)
            finally:
                tool_duration = time.time() - tool_start_time
                cute_msg = _get_cute_tool_message_impl(function_name, function_args, tool_duration, result=_mem_result)
                if spinner:
                    spinner.stop(cute_msg)
                elif agent._should_emit_quiet_tool_messages():
                    agent._vprint(f"  {cute_msg}")
        elif agent.quiet_mode:
            spinner = None
            if agent._should_emit_quiet_tool_messages() and agent._should_start_quiet_spinner():
                face = random.choice(KawaiiSpinner.get_waiting_faces())
                emoji = _get_tool_emoji(function_name)
                preview = _build_tool_preview(function_name, function_args) or function_name
                spinner = KawaiiSpinner(f"{face} {emoji} {preview}", spinner_type='dots', print_fn=agent._print_fn)
                spinner.start()
            _spinner_result = None
            try:
                with _browser_decision_context(agent, function_name):
                    function_result = _ra().handle_function_call(
                        function_name, _dispatch_function_args, effective_task_id,
                        tool_call_id=tool_call.id,
                        session_id=agent.session_id or "",
                        turn_id=getattr(agent, "_current_turn_id", "") or "",
                        api_request_id=getattr(agent, "_current_api_request_id", "") or "",
                        enabled_tools=list(agent.valid_tool_names) if agent.valid_tool_names else None,
                        skip_pre_tool_call_hook=True,
                        enabled_toolsets=getattr(agent, "enabled_toolsets", None),
                        disabled_toolsets=getattr(agent, "disabled_toolsets", None),
                        result_mode="model",
                    )
                _spinner_result = function_result
            except KeyboardInterrupt:
                function_result = _emit_cancelled_terminal_post_tool_call(
                    agent,
                    function_name=function_name,
                    function_args=function_args,
                    effective_task_id=effective_task_id,
                    tool_call_id=getattr(tool_call, "id", "") or "",
                    start_time=tool_start_time,
                )
                _spinner_result = function_result
                try:
                    agent.interrupt("keyboard interrupt")
                except Exception:
                    pass
                raise
            except Exception as tool_error:
                function_result = f"Error executing tool '{function_name}': {tool_error}"
                logger.error("handle_function_call raised for %s: %s", function_name, tool_error, exc_info=True)
            finally:
                tool_duration = time.time() - tool_start_time
                cute_msg = _get_cute_tool_message_impl(function_name, function_args, tool_duration, result=_spinner_result)
                if spinner:
                    spinner.stop(cute_msg)
                elif agent._should_emit_quiet_tool_messages():
                    agent._vprint(f"  {cute_msg}")
        else:
            try:
                with _browser_decision_context(agent, function_name):
                    function_result = _ra().handle_function_call(
                        function_name, _dispatch_function_args, effective_task_id,
                        tool_call_id=tool_call.id,
                        session_id=agent.session_id or "",
                        turn_id=getattr(agent, "_current_turn_id", "") or "",
                        api_request_id=getattr(agent, "_current_api_request_id", "") or "",
                        enabled_tools=list(agent.valid_tool_names) if agent.valid_tool_names else None,
                        skip_pre_tool_call_hook=True,
                        enabled_toolsets=getattr(agent, "enabled_toolsets", None),
                        disabled_toolsets=getattr(agent, "disabled_toolsets", None),
                        result_mode="model",
                    )
            except KeyboardInterrupt:
                _emit_cancelled_terminal_post_tool_call(
                    agent,
                    function_name=function_name,
                    function_args=function_args,
                    effective_task_id=effective_task_id,
                    tool_call_id=getattr(tool_call, "id", "") or "",
                    start_time=tool_start_time,
                )
                try:
                    agent.interrupt("keyboard interrupt")
                except Exception:
                    pass
                raise
            except Exception as tool_error:
                function_result = f"Error executing tool '{function_name}': {tool_error}"
                logger.error("handle_function_call raised for %s: %s", function_name, tool_error, exc_info=True)
            tool_duration = time.time() - tool_start_time

        if isinstance(function_result, str):
            result_preview = function_result if agent.verbose_logging else (
                function_result[:200] if len(function_result) > 200 else function_result
            )
            _result_len = len(function_result)
        else:
            # Multimodal dict result (_multimodal=True) — not sliceable as string
            result_preview = function_result
            _result_len = len(str(function_result))

        # Log tool errors to the persistent error log so [error] tags
        # in the UI always have a corresponding detailed entry on disk.
        _is_error_result, _ = _detect_tool_failure(function_name, function_result)
        if not _execution_blocked:
            _record_turn_browser_navigation_failure(
                agent,
                function_name,
                function_result,
                failed=_is_error_result,
            )
        human_interaction_resumed = (
            _human_resume_generation() != human_resume_generation
        )
        if not _execution_blocked and human_interaction_resumed:
            # A user may have navigated, switched tabs, or changed the page while
            # the agent was blocked. Invalidate both layers: later browser calls
            # already emitted in this assistant batch are skipped, and the next
            # model request performs a real observe before receiving a new token.
            _record_trusted_browser_control_boundary(agent)
            agent._browser_force_observe = True
            agent._browser_decision_token = None
            browser_replan_barrier = (
                function_name,
                "The wait for human input or approval has ended. Later browser calls "
                "in the same turn were not executed; after resuming, the page will be "
                "observed again first.",
            )
        if not _execution_blocked and is_browser_tool(function_name):
            if _is_error_result:
                browser_replan_barrier = (
                    function_name,
                    "The previous browser tool failed. Remaining browser calls in the "
                    "same turn were stopped to avoid continuing from an unknown state.",
                )
            elif browser_result_requests_replan(function_result):
                browser_replan_barrier = (
                    function_name,
                    "The previous browser tool safely rejected stale state and returned "
                    "the latest observation.",
                )
            elif browser_result_allows_snapshot_continue(function_result):
                # This direct model batch intentionally targets elements from
                # one snapshot. The wrapper deferred its trailing observation,
                # while the runtime preserved and live-validated the map.
                pass
            elif browser_tool_opens_replan_barrier(function_name, function_args, function_result):
                browser_replan_barrier = (
                    function_name,
                    "The previous browser tool refreshed the page snapshot, changed the "
                    "page, or changed tab state.",
                )
        # The agent-runtime tools above (todo, session_search, memory,
        # context-engine, memory-manager, collect, delegate_task) are
        # dispatched inline — they never reach handle_function_call, so the
        # executor is the one that has to fire post_tool_call. For
        # registry-dispatched tools the else-branch above invoked
        # handle_function_call, which already fires the hook.
        from agent.agent_runtime_helpers import agent_runtime_owns_post_tool_hook
        _executor_must_emit_post_hook = (
            not _execution_blocked
            and (
                _form_submit_lowered_step
                or agent_runtime_owns_post_tool_hook(agent, function_name)
            )
        )
        if _executor_must_emit_post_hook:
            terminal_cancelled = _form_submit_terminal_status == "cancelled"
            _emit_terminal_post_tool_call(
                agent,
                function_name=function_name,
                function_args=function_args,
                result=function_result,
                effective_task_id=effective_task_id,
                tool_call_id=getattr(tool_call, "id", "") or "",
                duration_ms=int(tool_duration * 1000),
                status=_form_submit_terminal_status,
                error_type="keyboard_interrupt" if terminal_cancelled else None,
                error_message=(
                    "Form submit transaction interrupted with unknown execution state"
                    if terminal_cancelled
                    else None
                ),
            )
        if not _execution_blocked:
            agent._last_tool_guardrail_after_call_decision = None
            function_result = agent._append_guardrail_observation(
                function_name,
                function_args,
                function_result,
                failed=_is_error_result,
            )
            post_guardrail_decision = getattr(
                agent,
                "_last_tool_guardrail_after_call_decision",
                None,
            )
            if is_browser_tool(function_name):
                if (
                    isinstance(post_guardrail_decision, ToolGuardrailDecision)
                    and post_guardrail_decision.should_halt
                ):
                    browser_terminal_barrier_decision = post_guardrail_decision
                    browser_replan_barrier = (
                        function_name,
                        "The browser tool loop reached its termination condition for "
                        "this turn. Later browser calls in the same turn were not executed.",
                    )
                elif (
                    isinstance(post_guardrail_decision, ToolGuardrailDecision)
                    and post_guardrail_decision.code
                    == "strategy_pivot_required"
                ):
                    browser_terminal_barrier_decision = None
                    browser_replan_barrier = (
                        function_name,
                        "The browser tool loop requires the strategy-pivot guidance to "
                        "be returned to the model first. Later browser calls in the same "
                        "turn were not executed and await the next model decision.",
                    )
                elif browser_result_requests_replan(function_result):
                    # Structured fallback for alternate/dummy agent wrappers
                    # that preserve the guardrail envelope but do not expose
                    # the concrete ToolGuardrailDecision object.
                    browser_replan_barrier = (
                        function_name,
                        "The previous browser tool requires replanning from the current "
                        "result. Later browser calls in the same turn were not executed.",
                    )
            function_result = record_browser_action_outcome(
                getattr(agent, "_turn_unresolved_browser_action", None),
                function_name,
                function_result,
                failed=_is_error_result,
            )
            preview_text = _multimodal_text_summary(function_result)
            result_preview = function_result if agent.verbose_logging else (
                preview_text[:200] if len(preview_text) > 200 else preview_text
            )
        if _is_error_result:
            logger.warning("Tool %s returned error (%.2fs): %s", function_name, tool_duration, result_preview)
        else:
            logger.info("tool %s completed (%.2fs, %d chars)", function_name, tool_duration, _result_len)

        # Track file-mutation outcome for the turn-end verifier.  See
        # the concurrent path for the rationale; both paths must feed
        # the same state so the footer reflects every tool call in the
        # turn, not just the parallel ones.
        if not _execution_blocked:
            try:
                agent._record_file_mutation_result(
                    function_name, function_args, function_result, _is_error_result,
                )
            except Exception as _ver_err:
                logging.debug("file-mutation verifier record failed: %s", _ver_err)

        if not _execution_blocked and agent.tool_progress_callback:
            try:
                agent.tool_progress_callback(
                    "tool.completed", function_name, None, None,
                    duration=tool_duration, is_error=_is_error_result,
                    result=function_result,
                )
            except Exception as cb_err:
                logging.debug(f"Tool progress callback error: {cb_err}")

        agent._current_tool = None
        agent._touch_activity(f"tool completed: {function_name} ({tool_duration:.1f}s)")

        if agent.verbose_logging:
            logging.debug(f"Tool {function_name} completed in {tool_duration:.2f}s")
            _log_result = _multimodal_text_summary(function_result)
            logging.debug(f"Tool result ({len(_log_result)} chars): {_log_result}")

        if not _execution_blocked and agent.tool_complete_callback:
            try:
                display_args = _redact_tool_args_for_display(function_name, function_args) or function_args
                agent.tool_complete_callback(tool_call.id, function_name, display_args, function_result)
            except Exception as cb_err:
                logging.debug(f"Tool complete callback error: {cb_err}")

        try:  # 全量日志:标记工具【真正执行完毕】(区别于响应里"模型决定调用的工具"那是意图)
            from agent import llm_io_log
            display_args = _redact_tool_args_for_display(function_name, function_args) or function_args
            llm_io_log.log_tool(
                function_name,
                display_args,
                function_result,
                duration_ms=int(tool_duration * 1000),
            )
        except Exception:
            pass

        function_result = maybe_persist_tool_result(
            content=function_result,
            tool_name=function_name,
            tool_use_id=tool_call.id,
            env=get_active_env(effective_task_id),
            env_factory=_persist_env_factory(effective_task_id),
            config=tool_budget,
        ) if not _is_multimodal_tool_result(function_result) else function_result

        # Discover subdirectory context files from tool arguments
        subdir_hints = agent._subdirectory_hints.check_tool_call(function_name, function_args)
        if subdir_hints:
            if _is_multimodal_tool_result(function_result):
                _append_subdir_hint_to_multimodal(function_result, subdir_hints)
            else:
                function_result += subdir_hints

        # Unwrap _multimodal dicts to an OpenAI-style content list
        # (see parallel path for rationale). String results pass through.
        _tool_content = agent._tool_result_content_for_active_model(function_name, function_result)
        release_superseded_observation_images(messages, _tool_content)
        tool_message = make_tool_result_message(
            function_name,
            _tool_content,
            tool_call.id,
        )
        _record_model_visible_browser_observation(
            agent,
            function_name,
            _tool_content,
            getattr(agent, "_browser_last_observation_state_after", None),
            canonical_content=tool_message.get("content"),
        )
        messages.append(tool_message)
        risk_metadata = tool_message.get("_tool_output_risk")
        if (
            risk_metadata is not None
            and risk_metadata.get("risk") != "low"
            and agent.tool_progress_callback
        ):
            try:
                agent.tool_progress_callback(
                    "tool.output_risk",
                    function_name,
                    None,
                    None,
                    tool_call_id=tool_call.id,
                    risk_metadata=risk_metadata,
                )
            except Exception as callback_error:
                logging.debug("Tool output risk callback error: %s", callback_error)
        _flush_session_db_after_tool_progress(
            agent,
            messages,
            stage=f"tool result {function_name}",
        )

        # ── Per-tool /steer drain ───────────────────────────────────
        # Drain pending steer BETWEEN individual tool calls so the
        # injection lands as soon as a tool finishes — not after the
        # entire batch.  The model sees it on the next API iteration.
        agent._apply_pending_steer_to_tool_results(messages, 1)

        if getattr(agent, "tool_progress_mode", "all") != "off":
            if agent.verbose_logging:
                print(f"  ✅ Tool {i} completed in {tool_duration:.2f}s")
                print(agent._wrap_verbose("Result: ", function_result))
            else:
                _fr_str = function_result if isinstance(function_result, str) else str(function_result)
                response_preview = _fr_str[:agent.log_prefix_chars] + "..." if len(_fr_str) > agent.log_prefix_chars else _fr_str
                print(f"  ✅ Tool {i} completed in {tool_duration:.2f}s - {response_preview}")

        must_settle_next_runtime = bool(
            pending_form_submit_steps.get(i + 1, {}).get("kind")
            in {"runtime", "prerequisite-skipped", "blocked"}
        )
        if (
            agent._interrupt_requested
            and i < len(assistant_message.tool_calls)
            and not must_settle_next_runtime
        ):
            remaining = len(assistant_message.tool_calls) - i
            agent._vprint(f"{agent.log_prefix}⚡ Interrupt: skipping {remaining} remaining tool call(s)", force=True)
            for skipped_tc in assistant_message.tool_calls[i:]:
                skipped_name = skipped_tc.function.name
                messages.append(make_tool_result_message(
                    skipped_name,
                    f"[Tool execution skipped — {skipped_name} was not started. User sent a new message]",
                    skipped_tc.id,
                ))
                _flush_session_db_after_tool_progress(
                    agent,
                    messages,
                    stage=f"skipped tool result {skipped_name}",
                )
            break

        if (
            agent.tool_delay > 0
            and i < len(assistant_message.tool_calls)
            and not must_settle_next_runtime
        ):
            time.sleep(agent.tool_delay)

    # ── Per-turn aggregate budget enforcement ─────────────────────────
    num_tools_seq = len(assistant_message.tool_calls)
    if num_tools_seq > 0:
        enforce_turn_budget(
            messages[-num_tools_seq:],
            env=get_active_env(effective_task_id),
            env_factory=_persist_env_factory(effective_task_id),
            config=tool_budget,
        )

    # ── /steer injection ──────────────────────────────────────────────
    # See _execute_tool_calls_parallel for the rationale. Same hook,
    # applied to sequential execution as well.
    if num_tools_seq > 0:
        agent._apply_pending_steer_to_tool_results(messages, num_tools_seq)




__all__ = [
    "execute_tool_calls_concurrent",
    "execute_tool_calls_sequential",
]
