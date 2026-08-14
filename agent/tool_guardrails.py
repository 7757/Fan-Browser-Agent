"""Pure tool-call loop guardrail primitives.

The controller in this module is intentionally side-effect free: it tracks
per-turn tool-call observations and returns decisions. Runtime code owns whether
those decisions become warning guidance, synthetic tool results, or controlled
turn halts.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

from utils import safe_json_loads
from agent.tool_result_classification import file_mutation_result_landed


IDEMPOTENT_TOOL_NAMES = frozenset(
    {
        "read_file",
        "search_files",
        "session_search",
        "browser_snapshot",
        "browser_observe",
        "browser_search_page",
        "browser_find_elements",
        "browser_page_content",
        "browser_events",
        "browser_targets",
        "browser_target_info",
        "browser_dropdown_options",
        "browser_storage_state",
        "mcp_filesystem_read_file",
        "mcp_filesystem_read_text_file",
        "mcp_filesystem_read_multiple_files",
        "mcp_filesystem_list_directory",
        "mcp_filesystem_list_directory_with_sizes",
        "mcp_filesystem_directory_tree",
        "mcp_filesystem_get_file_info",
        "mcp_filesystem_search_files",
    }
)

MUTATING_TOOL_NAMES = frozenset(
    {
        "terminal",
        "execute_code",
        "write_file",
        "patch",
        "todo",
        "memory",
        "skill_manage",
        "browser_run",
        "browser_handoff",
        "browser_search",
        "browser_click",
        "browser_type",
        "browser_navigate",
        "browser_fill_form",
        "browser_scroll",
        "browser_scroll_to_text",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "browser_send_keys",
        "browser_select",
        "browser_find_visual",
        "browser_new_tab",
        "browser_switch_tab",
        "browser_close_tab",
        "browser_dialog",
        "browser_upload",
        "browser_screenshot",
        "browser_save_pdf",
        "browser_har",
        "browser_save_har",
        "browser_save_storage_state",
        "browser_load_storage_state",
        "browser_grant_permissions",
        "browser_start_screencast",
        "browser_stop_screencast",
        "browser_set_viewport",
        "browser_network_config",
        "browser_url_policy",
        "browser_evaluate",
        "browser_evaluate_js",
        "browser_cdp",
        "browser_mouse",
        "browser_hover",
        "browser_focus",
        "browser_drag",
        "browser_element",
        "browser_highlight",
        "cronjob",
        "delegate_task",
        "process",
    }
)


# A successful observe/navigation proves that the runtime and current page are
# usable again. Keep only capability-level failures open across that boundary;
# page-specific mismatches and settled timeouts must be allowed to recover.
PERSISTENT_BROWSER_ERROR_CODES = frozenset(
    {
        "VISION_PROVIDER_UNAVAILABLE",
        "VISION_UNAVAILABLE",
        "BROWSER_RUNTIME_UNAVAILABLE",
        "ELECTRON_BROWSER_RUNTIME_UNAVAILABLE",
        "BROWSER_QUEUE_CLOSED",
    }
)

TRANSIENT_BROWSER_SETTLEMENT_CODES = frozenset(
    {
        "BROWSER_SESSION_ACTION_SETTLING",
    }
)


# Browser actions that are expected to produce an observable page change.  A
# successful RPC is not progress by itself: if the active document, tab, DOM,
# value or scroll position remains unchanged, repeating one of these actions is
# a stalled browser path.
_BROWSER_INTERACTION_TOOLS = frozenset(
    {
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
        "browser_find_visual",
        "browser_new_tab",
        "browser_switch_tab",
        "browser_close_tab",
        "browser_dialog",
        "browser_upload",
        "browser_mouse",
        "browser_hover",
        "browser_focus",
        "browser_drag",
        "browser_run",
    }
)

_BROWSER_RECOVERY_TOOLS = frozenset(
    {"browser_snapshot", "browser_observe", "browser_wait", "browser_settle"}
)

# These tools can complete useful work without changing the live page.  Their
# normal success must not be mistaken for browser stagnation.
_BROWSER_OUTPUT_TOOLS = frozenset(
    {
        "browser_screenshot",
        "browser_save_pdf",
        "browser_har",
        "browser_save_har",
        "browser_storage_state",
        "browser_save_storage_state",
        "browser_load_storage_state",
        "browser_events",
        "browser_targets",
        "browser_target_info",
        "browser_network_config",
        "browser_url_policy",
        "browser_start_screencast",
        "browser_stop_screencast",
        "browser_highlight",
    }
)

_BROWSER_VALUE_EFFECT_TOOLS = frozenset(
    {"browser_type", "browser_fill_form", "browser_focus", "browser_select"}
)

_BROWSER_STATE_FIELDS = (
    "sessionId",
    "activeTabId",
    "documentRevision",
    "pageGeneration",
    "tabListGeneration",
)

_DOM_INDEX_RE = re.compile(r"\*?\[\d+\]")
_PAGE_URL_RE = re.compile(r"^\[page:.*?\s[·|]\s(\S+)\]", re.MULTILINE)
_FAN_METHOD_CALL_RE = re.compile(r"\bfan\.([A-Za-z][A-Za-z0-9_]*)\s*\(")

_BROWSER_ATOMIC_METHOD_NAMES = {
    "browser_snapshot": "observe",
    "browser_observe": "observe",
    "browser_page_content": "pageContent",
    "browser_search": "search",
    "browser_navigate": "navigate",
    "browser_click": "click",
    "browser_type": "type",
    "browser_fill_form": "fillForm",
    "browser_scroll": "scroll",
    "browser_scroll_to_text": "scrollToText",
    "browser_back": "back",
    "browser_forward": "forward",
    "browser_reload": "reload",
    "browser_send_keys": "keys",
    "browser_select": "select",
    "browser_new_tab": "newTab",
    "browser_switch_tab": "switchTab",
    "browser_close_tab": "closeTab",
    "browser_dialog": "dialog",
    "browser_upload": "upload",
    "browser_wait": "wait",
    "browser_settle": "settle",
    "browser_dropdown_options": "dropdownOptions",
    "browser_hover": "hover",
    "browser_focus": "focus",
    "browser_drag": "drag",
    "browser_screenshot": "saveScreenshot",
    "browser_save_pdf": "savePdf",
    "browser_handoff": "handoff",
}

_FAN_METHOD_FAMILIES = {
    "observe": "observation",
    "pageContent": "observation",
    "tabs": "observation",
    "dropdownOptions": "observation",
    "navigate": "navigation",
    "search": "navigation",
    "back": "navigation",
    "forward": "navigation",
    "reload": "navigation",
    "click": "pointer",
    "clickPoint": "pointer",
    "hover": "pointer",
    "focus": "pointer",
    "type": "form",
    "fillForm": "form",
    "formSubmit": "form",
    "keys": "form",
    "dialog": "dialog",
    "select": "form",
    "scroll": "scroll",
    "scrollToText": "scroll",
    "drag": "drag",
    "dragPoint": "drag",
    "upload": "upload",
    "wait": "wait",
    "waitForElement": "wait",
    "waitForState": "wait",
    "settle": "wait",
    "newTab": "tabs",
    "switchTab": "tabs",
    "closeTab": "tabs",
    "saveScreenshot": "output",
    "savePdf": "output",
    "handoff": "control",
}
_FAN_NON_OPERATION_METHODS = frozenset({"ref"})


@dataclass(frozen=True)
class _BrowserProgressSnapshot:
    """Stable, model-independent browser state used only by the loop guard."""

    identity: tuple[tuple[str, str], ...] = ()
    url: str | None = None
    dom_hash: str | None = None
    position: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ToolCallGuardrailConfig:
    """Thresholds for per-turn tool-call loop detection.

    Warnings are enabled by default and never prevent tool execution. Hard stops
    are explicit opt-in so interactive CLI/TUI sessions get a gentle nudge unless
    the user enables circuit-breaker behavior in config.yaml.
    """

    warnings_enabled: bool = True
    hard_stop_enabled: bool = False
    exact_failure_warn_after: int = 2
    exact_failure_block_after: int = 5
    same_tool_failure_warn_after: int = 3
    same_tool_failure_halt_after: int = 8
    no_progress_warn_after: int = 2
    no_progress_block_after: int = 5
    # Browser stagnation is a correctness boundary and is always enforced.  It
    # is deliberately independent from ``hard_stop_enabled``, which remains an
    # opt-in policy for generic CLI tools.
    browser_no_progress_warn_after: int = 2
    browser_path_block_after: int = 2
    browser_method_error_block_after: int = 2
    browser_strategy_pivot_after: int = 3
    browser_strategy_pivot_interval: int = 2
    browser_strategy_pivot_limit: int = 2
    browser_total_no_progress_budget: int = 6
    # Compatibility alias for callers/configs that still use the old field.
    # Its semantics are now the total recovery budget rather than a
    # consecutive-three-step circuit breaker.
    browser_no_progress_halt_after: int = 6
    idempotent_tools: frozenset[str] = field(default_factory=lambda: IDEMPOTENT_TOOL_NAMES)
    mutating_tools: frozenset[str] = field(default_factory=lambda: MUTATING_TOOL_NAMES)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any] | None) -> "ToolCallGuardrailConfig":
        """Build config from the `tool_loop_guardrails` config.yaml section."""
        if not isinstance(data, Mapping):
            return cls()

        warn_after = data.get("warn_after")
        if not isinstance(warn_after, Mapping):
            warn_after = {}
        hard_stop_after = data.get("hard_stop_after")
        if not isinstance(hard_stop_after, Mapping):
            hard_stop_after = {}
        browser_no_progress = data.get("browser_no_progress")
        if not isinstance(browser_no_progress, Mapping):
            browser_no_progress = {}

        defaults = cls()
        if "total_budget" in browser_no_progress:
            browser_total_no_progress_budget = _positive_int(
                browser_no_progress.get("total_budget"),
                defaults.browser_total_no_progress_budget,
            )
        else:
            # Existing generated configs may still contain the former default
            # ``halt_after: 3``.  Treat that as a legacy alias, but never let it
            # silently restore the removed three-step stop.
            browser_total_no_progress_budget = max(
                defaults.browser_total_no_progress_budget,
                _positive_int(
                    browser_no_progress.get("halt_after"),
                    defaults.browser_total_no_progress_budget,
                ),
            )
        return cls(
            warnings_enabled=_as_bool(data.get("warnings_enabled"), defaults.warnings_enabled),
            hard_stop_enabled=_as_bool(data.get("hard_stop_enabled"), defaults.hard_stop_enabled),
            exact_failure_warn_after=_positive_int(
                warn_after.get("exact_failure", data.get("exact_failure_warn_after")),
                defaults.exact_failure_warn_after,
            ),
            same_tool_failure_warn_after=_positive_int(
                warn_after.get("same_tool_failure", data.get("same_tool_failure_warn_after")),
                defaults.same_tool_failure_warn_after,
            ),
            no_progress_warn_after=_positive_int(
                warn_after.get("idempotent_no_progress", data.get("no_progress_warn_after")),
                defaults.no_progress_warn_after,
            ),
            exact_failure_block_after=_positive_int(
                hard_stop_after.get("exact_failure", data.get("exact_failure_block_after")),
                defaults.exact_failure_block_after,
            ),
            same_tool_failure_halt_after=_positive_int(
                hard_stop_after.get("same_tool_failure", data.get("same_tool_failure_halt_after")),
                defaults.same_tool_failure_halt_after,
            ),
            no_progress_block_after=_positive_int(
                hard_stop_after.get("idempotent_no_progress", data.get("no_progress_block_after")),
                defaults.no_progress_block_after,
            ),
            browser_no_progress_warn_after=_positive_int(
                browser_no_progress.get("warn_after"),
                defaults.browser_no_progress_warn_after,
            ),
            browser_path_block_after=_positive_int(
                browser_no_progress.get("path_block_after"),
                defaults.browser_path_block_after,
            ),
            browser_method_error_block_after=_positive_int(
                browser_no_progress.get("same_method_error_block_after"),
                defaults.browser_method_error_block_after,
            ),
            browser_strategy_pivot_after=_positive_int(
                browser_no_progress.get("strategy_pivot_after"),
                defaults.browser_strategy_pivot_after,
            ),
            browser_strategy_pivot_interval=_positive_int(
                browser_no_progress.get("strategy_pivot_interval"),
                defaults.browser_strategy_pivot_interval,
            ),
            browser_strategy_pivot_limit=_positive_int(
                browser_no_progress.get("strategy_pivot_limit"),
                defaults.browser_strategy_pivot_limit,
            ),
            browser_total_no_progress_budget=browser_total_no_progress_budget,
            browser_no_progress_halt_after=browser_total_no_progress_budget,
        )


@dataclass(frozen=True)
class ToolCallSignature:
    """Stable, non-reversible identity for a tool name plus canonical args."""

    tool_name: str
    args_hash: str

    @classmethod
    def from_call(cls, tool_name: str, args: Mapping[str, Any] | None) -> "ToolCallSignature":
        canonical = canonical_tool_args(args or {})
        return cls(tool_name=tool_name, args_hash=_sha256(canonical))

    def to_metadata(self) -> dict[str, str]:
        """Return public metadata without raw argument values."""
        return {"tool_name": self.tool_name, "args_hash": self.args_hash}


@dataclass(frozen=True)
class ToolGuardrailDecision:
    """Decision returned by the tool-call guardrail controller."""

    action: str = "allow"  # allow | warn | skip | block | halt
    code: str = "allow"
    message: str = ""
    tool_name: str = ""
    count: int = 0
    signature: ToolCallSignature | None = None
    # Small, sanitized context used only to explain a browser halt to the
    # user. Keep raw tool arguments and page content out of this structure.
    user_context: Mapping[str, Any] = field(
        default_factory=dict,
        compare=False,
        repr=False,
    )
    # Machine-readable recovery contract for the conversation loop and model.
    # Unlike ``user_context``, this is deliberately emitted by ``to_metadata``.
    recovery_context: Mapping[str, Any] = field(
        default_factory=dict,
        compare=False,
        repr=False,
    )

    @property
    def allows_execution(self) -> bool:
        return self.action in {"allow", "warn"}

    @property
    def should_halt(self) -> bool:
        return self.action in {"block", "halt"}

    def to_metadata(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "action": self.action,
            "code": self.code,
            "message": self.message,
            "tool_name": self.tool_name,
            "count": self.count,
        }
        if self.signature is not None:
            data["signature"] = self.signature.to_metadata()
        if self.recovery_context:
            data["recovery"] = dict(self.recovery_context)
        return data


def canonical_tool_args(args: Mapping[str, Any]) -> str:
    """Return sorted compact JSON for parsed tool arguments."""
    if not isinstance(args, Mapping):
        raise TypeError(f"tool args must be a mapping, got {type(args).__name__}")
    return json.dumps(
        args,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _result_text(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        return str(result)


def classify_tool_failure(tool_name: str, result: Any) -> tuple[bool, str]:
    """Safety-fallback classifier used only when callers don't pass ``failed``.

    Mirrors ``agent.display._detect_tool_failure`` exactly so the guardrail
    never disagrees with the CLI's user-visible ``[error]`` tag. Production
    callers in ``run_agent.py`` always pass an explicit ``failed=`` derived
    from ``_detect_tool_failure``; this function exists so standalone callers
    (tests, tooling) still get consistent behavior.
    """
    if result is None:
        return False, ""
    result_text = _result_text(result)
    if file_mutation_result_landed(tool_name, result_text):
        return False, ""

    if tool_name == "terminal":
        data = safe_json_loads(result_text)
        if isinstance(data, dict):
            exit_code = data.get("exit_code")
            exit_expected = data.get("exit_code_expected") is True
            if exit_code is not None and exit_code != 0 and not exit_expected:
                return True, f" [exit {exit_code}]"
        return False, ""

    if tool_name == "memory":
        data = safe_json_loads(result_text)
        if isinstance(data, dict):
            if data.get("success") is False and "exceed the limit" in data.get("error", ""):
                return True, " [full]"

    lower = result_text[:500].lower()
    if '"error"' in lower or '"failed"' in lower or result_text.startswith("Error"):
        return True, " [error]"

    return False, ""


class ToolCallGuardrailController:
    """Per-turn controller for repeated failed/non-progressing tool calls."""

    def __init__(self, config: ToolCallGuardrailConfig | None = None):
        self.config = config or ToolCallGuardrailConfig()
        self.reset_for_turn()

    def reset_for_turn(self) -> None:
        self._exact_failure_counts: dict[ToolCallSignature, int] = {}
        self._same_tool_failure_counts: dict[str, int] = {}
        self._no_progress: dict[ToolCallSignature, tuple[str, int]] = {}
        self._halt_decision: ToolGuardrailDecision | None = None
        self._browser_blocked_tools: dict[str, tuple[str, bool | None]] = {}
        self._browser_blocked_tool_hits: dict[str, int] = {}
        self._browser_snapshot_recoverable_tools: set[str] = set()
        self._browser_failure_codes: dict[tuple[str, str], int] = {}
        self._browser_last_failure_context: dict[str, dict[str, str]] = {}
        self._browser_snapshot: _BrowserProgressSnapshot | None = None
        # Total no-progress outcomes since the last verified browser/page/tab
        # change or executor-confirmed human-control boundary. This replaces
        # the old consecutive-three hard stop while remaining bounded within
        # one model turn.
        self._browser_consecutive_no_progress = 0
        self._browser_strategy_pivots_used = 0
        self._browser_path_no_progress: dict[
            ToolCallSignature, tuple[_BrowserProgressSnapshot | None, int]
        ] = {}
        self._browser_blocked_paths: dict[
            ToolCallSignature, _BrowserProgressSnapshot | None
        ] = {}
        self._browser_path_error_codes: dict[ToolCallSignature, str] = {}
        self._browser_method_error_counts: dict[
            tuple[str, str], tuple[_BrowserProgressSnapshot | None, int]
        ] = {}
        self._browser_blocked_method_errors: dict[
            tuple[str, str], _BrowserProgressSnapshot | None
        ] = {}
        self._browser_last_result_hash: dict[ToolCallSignature, str] = {}
        self._browser_seen_replan_evidence: set[str] = set()
        # A program that may already have produced an external effect must not
        # be replayed in the same model turn. This is intentionally separate
        # from page-level tool circuits: corrected code may continue, while
        # changing only intent/timeout cannot disguise the original program.
        self._browser_effectful_program_blocks: dict[
            ToolCallSignature, str
        ] = {}
        self._browser_effectful_program_block_hits: dict[
            ToolCallSignature, int
        ] = {}

    @property
    def halt_decision(self) -> ToolGuardrailDecision | None:
        return self._halt_decision

    def record_trusted_browser_control_boundary(self) -> None:
        """Reset browser stagnation after the executor confirms human resume.

        Browser results and model-authored program return values cannot call
        this boundary. In particular, ordinary per-tool control-lease revisions
        are not progress evidence. The exact effectful-program replay locks are
        intentionally outside ``_reset_browser_stagnation`` and survive.
        """

        self._reset_browser_stagnation(self._browser_snapshot)

    def before_call(
        self,
        tool_name: str,
        args: Mapping[str, Any] | None,
        *,
        browser_state: Mapping[str, Any] | None = None,
    ) -> ToolGuardrailDecision:
        args = _coerce_args(args)
        signature = ToolCallSignature.from_call(tool_name, args)
        browser_signature = (
            _browser_path_signature(tool_name, args)
            if tool_name.startswith("browser_")
            else signature
        )
        if tool_name.startswith("browser_"):
            current_snapshot = _browser_progress_snapshot(browser_state, None)
            if _browser_snapshot_changed(self._browser_snapshot, current_snapshot):
                self._reset_browser_stagnation(current_snapshot)
            if tool_name == "browser_run":
                program_signature = _browser_program_signature(args)
                replay_reason = self._browser_effectful_program_blocks.get(
                    program_signature
                )
                if replay_reason is not None:
                    blocked_hits = (
                        self._browser_effectful_program_block_hits.get(
                            program_signature, 0
                        )
                        + 1
                    )
                    self._browser_effectful_program_block_hits[
                        program_signature
                    ] = blocked_hits
                    if blocked_hits >= 2:
                        decision = ToolGuardrailDecision(
                            action="halt",
                            code="browser_program_effect_replay_repeated",
                            message=(
                                "Stopped browser_run: this program may already have "
                                "produced page or external side effects, but the model "
                                "is still trying to replay the same code. Write a new "
                                "recovery program from the latest snapshot instead of "
                                "submitting the original program again."
                            ),
                            tool_name=tool_name,
                            count=blocked_hits,
                            signature=program_signature,
                        )
                        self._halt_decision = decision
                        return decision
                    return ToolGuardrailDecision(
                        action="skip",
                        code="browser_program_effect_replay_blocked",
                        message=(
                            "Blocked browser_run: this exact program may already have "
                            f"produced an effect ({replay_reason}). Inspect the latest "
                            "snapshot and submit corrected code instead of replaying it."
                        ),
                        tool_name=tool_name,
                        count=blocked_hits,
                        signature=program_signature,
                    )
            blocked_snapshot = self._browser_blocked_paths.get(browser_signature)
            if browser_signature in self._browser_blocked_paths:
                if _browser_snapshot_changed(blocked_snapshot, current_snapshot):
                    self._browser_blocked_paths.pop(browser_signature, None)
                    self._browser_path_no_progress.pop(browser_signature, None)
                    self._browser_path_error_codes.pop(browser_signature, None)
                else:
                    count = self._browser_path_no_progress.get(
                        browser_signature,
                        (None, 0),
                    )[1]
                    return self._record_blocked_browser_attempt(
                        tool_name=tool_name,
                        args=args,
                        signature=browser_signature,
                        snapshot=current_snapshot or blocked_snapshot,
                        path_count=count,
                        method_family=_browser_method_family(
                            tool_name,
                            args,
                            None,
                        ),
                        error_code=self._browser_path_error_codes.get(
                            browser_signature
                        ),
                    )

            proposed_family = _browser_method_family(tool_name, args, None)
            blocked_method_key: tuple[str, str] | None = None
            if proposed_family:
                for candidate in self._browser_blocked_method_errors:
                    if candidate[0] == proposed_family:
                        blocked_method_key = candidate
                        break
            if blocked_method_key is not None:
                blocked_method_snapshot = self._browser_blocked_method_errors[
                    blocked_method_key
                ]
                if _browser_snapshot_changed(
                    blocked_method_snapshot,
                    current_snapshot,
                ):
                    self._browser_blocked_method_errors.pop(
                        blocked_method_key,
                        None,
                    )
                    self._browser_method_error_counts.pop(
                        blocked_method_key,
                        None,
                    )
                else:
                    count = self._browser_method_error_counts.get(
                        blocked_method_key,
                        (None, 0),
                    )[1]
                    return self._record_blocked_browser_attempt(
                        tool_name=tool_name,
                        args=args,
                        signature=browser_signature,
                        snapshot=current_snapshot or blocked_method_snapshot,
                        path_count=count,
                        method_family=blocked_method_key[0],
                        error_code=blocked_method_key[1],
                    )
        blocked = self._browser_blocked_tools.get(tool_name)
        if blocked:
            blocked_code, _retryable = blocked
            blocked_hits = self._browser_blocked_tool_hits.get(tool_name, 0) + 1
            self._browser_blocked_tool_hits[tool_name] = blocked_hits
            if blocked_hits >= 2:
                decision = ToolGuardrailDecision(
                    action="halt",
                    code="browser_no_progress_blocked_path_repeated",
                    message=(
                        f"Stopped {tool_name}: the tool path was closed because of "
                        f"{blocked_code}, but the model continues to request the same "
                        "path. Switch browser strategy or report the blocker honestly."
                    ),
                    tool_name=tool_name,
                    count=blocked_hits,
                    signature=signature,
                    user_context=(
                        self._browser_last_failure_context.get(tool_name)
                        or _browser_user_context(
                            tool_name,
                            args,
                            snapshot=current_snapshot,
                            error_code=blocked_code,
                        )
                    ),
                )
                self._halt_decision = decision
                return decision
            recovery = (
                "Call browser_snapshot once to establish the settled page state "
                "before choosing a new program."
                if tool_name in self._browser_snapshot_recoverable_tools
                else "Use a different tool or page strategy instead of retrying it."
            )
            return ToolGuardrailDecision(
                action="skip",
                code="browser_path_circuit_open",
                message=(
                    f"Blocked {tool_name}: this browser path already failed with {blocked_code}. "
                    f"{recovery}"
                ),
                tool_name=tool_name,
                signature=signature,
            )
        if not self.config.hard_stop_enabled:
            return ToolGuardrailDecision(tool_name=tool_name, signature=signature)

        exact_count = self._exact_failure_counts.get(signature, 0)
        if exact_count >= self.config.exact_failure_block_after:
            decision = ToolGuardrailDecision(
                action="block",
                code="repeated_exact_failure_block",
                message=(
                    f"Blocked {tool_name}: the same tool call failed {exact_count} "
                    "times with identical arguments. Stop retrying it unchanged; "
                    "change strategy or explain the blocker."
                ),
                tool_name=tool_name,
                count=exact_count,
                signature=signature,
            )
            self._halt_decision = decision
            return decision

        if self._is_idempotent(tool_name):
            record = self._no_progress.get(signature)
            if record is not None:
                _result_hash, repeat_count = record
                if repeat_count >= self.config.no_progress_block_after:
                    decision = ToolGuardrailDecision(
                        action="block",
                        code="idempotent_no_progress_block",
                        message=(
                            f"Blocked {tool_name}: this read-only call returned the same "
                            f"result {repeat_count} times. Stop repeating it unchanged; "
                            "use the result already provided or try a different query."
                        ),
                        tool_name=tool_name,
                        count=repeat_count,
                        signature=signature,
                    )
                    self._halt_decision = decision
                    return decision

        return ToolGuardrailDecision(tool_name=tool_name, signature=signature)

    def after_call(
        self,
        tool_name: str,
        args: Mapping[str, Any] | None,
        result: Any,
        *,
        failed: bool | None = None,
        browser_state_before: Mapping[str, Any] | None = None,
        browser_state_after: Mapping[str, Any] | None = None,
    ) -> ToolGuardrailDecision:
        args = _coerce_args(args)
        signature = ToolCallSignature.from_call(tool_name, args)
        browser_signature = (
            _browser_path_signature(tool_name, args)
            if tool_name.startswith("browser_")
            else signature
        )
        if failed is None:
            failed, _ = classify_tool_failure(tool_name, result)
        if failed and tool_name in _BROWSER_RECOVERY_TOOLS:
            error_code, _ = _browser_failure_metadata(result)
            if error_code in TRANSIENT_BROWSER_SETTLEMENT_CODES:
                # The exact previous effect still owns the session fence. A
                # recovery read is allowed to retry once that Promise settles;
                # counting this transient response as page stagnation would
                # close the only safe recovery path before it becomes usable.
                return ToolGuardrailDecision(
                    tool_name=tool_name,
                    signature=signature,
                )

        browser_decision = ToolGuardrailDecision(tool_name=tool_name, signature=signature)
        previous_browser_snapshot = self._browser_snapshot
        snapshot_recovers_unknown_effect = bool(
            tool_name == "browser_snapshot"
            and not failed
            and self._browser_snapshot_recoverable_tools
        )
        if tool_name == "browser_run":
            replay_reason = _browser_program_replay_reason(result)
            if replay_reason is not None:
                program_signature = _browser_program_signature(args)
                self._browser_effectful_program_blocks[
                    program_signature
                ] = replay_reason
                self._browser_effectful_program_block_hits.setdefault(
                    program_signature, 0
                )
        if tool_name.startswith("browser_"):
            browser_decision = self._record_browser_progress(
                tool_name,
                args,
                browser_signature,
                result,
                failed=bool(failed),
                state_before=browser_state_before,
                state_after=browser_state_after,
            )
            if browser_decision.should_halt:
                self._halt_decision = browser_decision
                return browser_decision

        if failed:
            exact_count = self._exact_failure_counts.get(signature, 0) + 1
            self._exact_failure_counts[signature] = exact_count
            self._no_progress.pop(signature, None)

            same_count = self._same_tool_failure_counts.get(tool_name, 0) + 1
            self._same_tool_failure_counts[tool_name] = same_count

            if tool_name.startswith("browser_"):
                error_code, retryable = _browser_failure_metadata(result)
                effective_error_code = error_code or "BROWSER_TOOL_FAILED"
                tool_error_key = (tool_name, effective_error_code)
                self._browser_failure_codes[tool_error_key] = (
                    self._browser_failure_codes.get(tool_error_key, 0) + 1
                )
                status = _browser_failure_status(result)
                failure_snapshot = _browser_progress_snapshot(
                    browser_state_after,
                    result,
                )
                failure_context = _browser_user_context(
                    tool_name,
                    args,
                    result=result,
                    snapshot=failure_snapshot,
                    status=status,
                    error_code=effective_error_code,
                )
                self._browser_last_failure_context[tool_name] = failure_context

                # A program with a page-level failure before or after an effect
                # may continue with corrected code. The exact effectful program
                # remains protected by the independent replay lock above.
                has_authoritative_final_snapshot = (
                    tool_name == "browser_run"
                    and _browser_program_has_authoritative_final_snapshot(result)
                )
                program_failure_allows_changed_input_recovery = (
                    tool_name == "browser_run"
                    and (
                        status == "failed_before_effect"
                        or (
                            status == "failed_after_effect"
                            and has_authoritative_final_snapshot
                        )
                    )
                    and effective_error_code not in PERSISTENT_BROWSER_ERROR_CODES
                )
                program_requires_snapshot_recovery = (
                    tool_name == "browser_run"
                    and (
                        status == "unknown_after_effect"
                        or (
                            status == "failed_after_effect"
                            and not has_authoritative_final_snapshot
                        )
                    )
                )
                persistent_capability_failure = (
                    effective_error_code in PERSISTENT_BROWSER_ERROR_CODES
                )
                legacy_nonretryable_tool_failure = (
                    tool_name != "browser_run"
                    and retryable is False
                    and not program_failure_allows_changed_input_recovery
                )
                if (
                    persistent_capability_failure
                    or program_requires_snapshot_recovery
                    or legacy_nonretryable_tool_failure
                ):
                    self._browser_blocked_tools[tool_name] = (
                        effective_error_code,
                        retryable,
                    )
                    self._browser_blocked_tool_hits[tool_name] = 0
                    if program_requires_snapshot_recovery:
                        self._browser_snapshot_recoverable_tools.add(tool_name)

            if self.config.hard_stop_enabled and same_count >= self.config.same_tool_failure_halt_after:
                decision = ToolGuardrailDecision(
                    action="halt",
                    code="same_tool_failure_halt",
                    message=(
                        f"Stopped {tool_name}: it failed {same_count} times this turn. "
                        "Stop retrying the same failing tool path and choose a different approach."
                    ),
                    tool_name=tool_name,
                    count=same_count,
                    signature=signature,
                )
                self._halt_decision = decision
                return decision

            if browser_decision.action == "warn":
                return browser_decision

            if self.config.warnings_enabled and exact_count >= self.config.exact_failure_warn_after:
                return ToolGuardrailDecision(
                    action="warn",
                    code="repeated_exact_failure_warning",
                    message=(
                        f"{tool_name} has failed {exact_count} times with identical arguments. "
                        "This looks like a loop; inspect the error and change strategy "
                        "instead of retrying it unchanged."
                    ),
                    tool_name=tool_name,
                    count=exact_count,
                    signature=signature,
                )

            if self.config.warnings_enabled and same_count >= self.config.same_tool_failure_warn_after:
                return ToolGuardrailDecision(
                    action="warn",
                    code="same_tool_failure_warning",
                    message=_tool_failure_recovery_hint(tool_name, same_count),
                    tool_name=tool_name,
                    count=same_count,
                    signature=signature,
                )

            return ToolGuardrailDecision(tool_name=tool_name, count=exact_count, signature=signature)

        self._exact_failure_counts.pop(signature, None)
        self._same_tool_failure_counts.pop(tool_name, None)
        if tool_name.startswith("browser_"):
            self._browser_blocked_tools.pop(tool_name, None)
            self._browser_blocked_tool_hits.pop(tool_name, None)
            self._browser_snapshot_recoverable_tools.discard(tool_name)
            self._browser_last_failure_context.pop(tool_name, None)
            for key in [item for item in self._browser_failure_codes if item[0] == tool_name]:
                self._browser_failure_codes.pop(key, None)
            if tool_name == "browser_snapshot":
                for recovered_tool in tuple(
                    self._browser_snapshot_recoverable_tools
                ):
                    record = self._browser_blocked_tools.get(recovered_tool)
                    self._browser_snapshot_recoverable_tools.discard(
                        recovered_tool
                    )
                    if (
                        record is None
                        or record[0] in PERSISTENT_BROWSER_ERROR_CODES
                    ):
                        continue
                    self._browser_blocked_tools.pop(recovered_tool, None)
                    self._browser_blocked_tool_hits.pop(recovered_tool, None)
                    for key in [
                        item
                        for item in self._browser_failure_codes
                        if item[0] == recovered_tool
                    ]:
                        self._browser_failure_codes.pop(key, None)
            browser_snapshot_changed = (
                tool_name == "browser_snapshot"
                and _browser_snapshot_changed(
                    previous_browser_snapshot,
                    self._browser_snapshot,
                )
            )
            if browser_snapshot_changed or tool_name in {
                    "browser_observe",
                    "browser_navigate",
                    "browser_back",
                    "browser_forward",
                    "browser_reload",
                    "browser_new_tab",
                    "browser_switch_tab",
                }:
                self._browser_blocked_tools = {
                    name: record
                    for name, record in self._browser_blocked_tools.items()
                    if (
                        record[0] in PERSISTENT_BROWSER_ERROR_CODES
                        or name in self._browser_snapshot_recoverable_tools
                    )
                }
                self._browser_failure_codes = {
                    key: count
                    for key, count in self._browser_failure_codes.items()
                    if (
                        key[1] in PERSISTENT_BROWSER_ERROR_CODES
                        or key[0] in self._browser_snapshot_recoverable_tools
                    )
                    and key[0] in self._browser_blocked_tools
                }
                self._browser_blocked_tool_hits = {
                    name: count
                    for name, count in self._browser_blocked_tool_hits.items()
                    if name in self._browser_blocked_tools
                }

        if snapshot_recovers_unknown_effect:
            self._no_progress.pop(signature, None)
            return browser_decision

        if not self._is_idempotent(tool_name):
            self._no_progress.pop(signature, None)
            return browser_decision

        result_hash = _result_hash(result)
        previous = self._no_progress.get(signature)
        repeat_count = 1
        if previous is not None and previous[0] == result_hash:
            repeat_count = previous[1] + 1
        self._no_progress[signature] = (result_hash, repeat_count)

        if browser_decision.action == "warn":
            return browser_decision

        if self.config.warnings_enabled and repeat_count >= self.config.no_progress_warn_after:
            return ToolGuardrailDecision(
                action="warn",
                code="idempotent_no_progress_warning",
                message=(
                    f"{tool_name} returned the same result {repeat_count} times. "
                    "Use the result already provided or change the query instead of "
                    "repeating it unchanged."
                ),
                tool_name=tool_name,
                count=repeat_count,
                signature=signature,
            )

        return ToolGuardrailDecision(tool_name=tool_name, count=repeat_count, signature=signature)

    def _record_browser_progress(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        signature: ToolCallSignature,
        result: Any,
        *,
        failed: bool,
        state_before: Mapping[str, Any] | None,
        state_after: Mapping[str, Any] | None,
    ) -> ToolGuardrailDecision:
        """Track browser progress by semantic state, not raw RPC success."""

        before = _browser_progress_snapshot(state_before, None)
        if before is None:
            before = self._browser_snapshot
        elif self._browser_snapshot is not None and not _browser_snapshot_changed(
            self._browser_snapshot,
            before,
        ):
            # The internal decision token intentionally carries no DOM. Reuse
            # the previous observation's DOM/URL only when its stable identity
            # still matches the token captured before this action.
            before = _merge_browser_snapshots(self._browser_snapshot, before)
        after = _browser_progress_snapshot(state_after, result) or before
        state_changed = _browser_snapshot_changed(before, after)
        if state_changed:
            self._reset_browser_stagnation(after)
        elif after is not None:
            self._browser_snapshot = _merge_browser_snapshots(self._browser_snapshot, after)

        result_hash = _browser_semantic_result_hash(result)
        repeated_result = self._browser_last_result_hash.get(signature) == result_hash
        self._browser_last_result_hash[signature] = result_hash

        flags = _browser_result_flags(result)
        replan_evidence_fingerprint = (
            _browser_replan_evidence_fingerprint(result)
            if flags["replan_required"]
            else None
        )
        replan_has_fresh_evidence = bool(
            replan_evidence_fingerprint
            and replan_evidence_fingerprint
            not in self._browser_seen_replan_evidence
        )
        if replan_evidence_fingerprint:
            self._browser_seen_replan_evidence.add(
                replan_evidence_fingerprint
            )
        explicit_no_progress = bool(
            failed
            or flags["executed_false"]
            or (flags["effects"] == {"none"})
        )

        has_state_context = before is not None or after is not None
        if flags["replan_required"] and replan_has_fresh_evidence:
            # State-change errors often carry the only authoritative new
            # snapshot/candidate/generation available to the model.  That
            # evidence must drive a new decision rather than consume a
            # stagnation step merely because the attempted action was skipped.
            outcome = "progress" if state_changed else "neutral"
        elif flags["replan_required"]:
            outcome = "no_progress" if has_state_context or repeated_result else "neutral"
        elif explicit_no_progress and not has_state_context:
            # Without a live browser identity we cannot prove that different
            # failures happened on the same page. Generic failure guardrails
            # still apply; semantic stagnation starts only once a repeated
            # result or real state snapshot is available.
            outcome = "no_progress" if repeated_result else "neutral"
        elif explicit_no_progress:
            outcome = "no_progress"
        elif (
            tool_name == "browser_snapshot"
            and self._browser_snapshot_recoverable_tools
        ):
            # This passive read is the required safety boundary after an
            # unknown effect. It establishes settled state even when the DOM
            # is unchanged, so it must not consume another stagnation step.
            outcome = "progress"
        elif state_changed:
            outcome = "progress"
        elif flags["same_snapshot_continue"]:
            # The executor intentionally postponed observation until the end
            # of a live-validated action sequence. Do not spend the stagnation
            # budget on a step whose final page evidence has not been sampled.
            outcome = "neutral"
        elif (
            tool_name in _BROWSER_VALUE_EFFECT_TOOLS
            and "value-only" in flags["effects"]
        ):
            outcome = "progress"
        elif (
            tool_name == "browser_select"
            and flags["selection_applied"]
            and not repeated_result
        ):
            # Native/custom select readback is direct control-state evidence.
            # A repeated identical selection is still stagnation.
            outcome = "progress"
        elif tool_name in _BROWSER_OUTPUT_TOOLS:
            outcome = "neutral"
        elif tool_name == "browser_run" and flags["program_output_only"]:
            outcome = "neutral"
        elif tool_name == "browser_run" and flags["program_recovery_only"]:
            # A first read-only program can produce useful evidence. Once a
            # browser path is already stalled, another observe/tabs/wait-only
            # program with the same page state is recovery, not progress.
            outcome = (
                "no_progress"
                if self._browser_consecutive_no_progress > 0 or repeated_result
                else "neutral"
            )
        elif tool_name in _BROWSER_INTERACTION_TOOLS:
            outcome = "no_progress"
        elif tool_name in _BROWSER_RECOVERY_TOOLS:
            outcome = (
                "no_progress"
                if self._browser_consecutive_no_progress > 0 or repeated_result
                else "neutral"
            )
        elif self._is_idempotent(tool_name):
            # A new read result can advance the task without mutating the page;
            # only the same read against the same state is stagnation.
            outcome = "no_progress" if repeated_result else "neutral"
        else:
            outcome = "neutral"

        if outcome == "progress":
            self._reset_browser_stagnation(after)
            # Keep the just-observed successful result as the new baseline.
            # Otherwise reset would make an identical select/click look novel
            # forever and a model could loop while claiming progress each time.
            self._browser_last_result_hash[signature] = result_hash
            return ToolGuardrailDecision(tool_name=tool_name, signature=signature)
        if outcome == "neutral":
            return ToolGuardrailDecision(tool_name=tool_name, signature=signature)

        self._browser_consecutive_no_progress += 1
        previous_path = self._browser_path_no_progress.get(signature)
        path_count = 1
        if previous_path is not None and not _browser_snapshot_changed(previous_path[0], after):
            path_count = previous_path[1] + 1
        self._browser_path_no_progress[signature] = (after, path_count)

        error_code, _ = _browser_failure_metadata(result)
        if error_code:
            self._browser_path_error_codes[signature] = error_code
        method_family = _browser_method_family(tool_name, args, result)
        if error_code and method_family:
            method_error_key = (method_family, error_code)
            previous_method_error = self._browser_method_error_counts.get(
                method_error_key
            )
            method_error_count = 1
            if (
                previous_method_error is not None
                and not _browser_snapshot_changed(
                    previous_method_error[0],
                    after,
                )
            ):
                method_error_count = previous_method_error[1] + 1
            self._browser_method_error_counts[method_error_key] = (
                after,
                method_error_count,
            )
            if (
                method_error_count
                >= self.config.browser_method_error_block_after
            ):
                self._browser_blocked_method_errors[
                    method_error_key
                ] = after

        if path_count >= self.config.browser_path_block_after:
            self._browser_blocked_paths[signature] = after

        return self._browser_no_progress_decision(
            tool_name=tool_name,
            args=args,
            signature=signature,
            result=result,
            snapshot=after,
            path_count=path_count,
            method_family=method_family,
            error_code=error_code,
            blocked_attempt=False,
        )

    def _record_blocked_browser_attempt(
        self,
        *,
        tool_name: str,
        args: Mapping[str, Any],
        signature: ToolCallSignature,
        snapshot: _BrowserProgressSnapshot | None,
        path_count: int,
        method_family: str | None,
        error_code: str | None,
    ) -> ToolGuardrailDecision:
        """Count a rejected repeat without dispatching another browser effect."""

        self._browser_consecutive_no_progress += 1
        next_path_count = max(
            path_count,
            self._browser_path_no_progress.get(signature, (None, 0))[1],
        ) + 1
        self._browser_path_no_progress[signature] = (
            snapshot,
            next_path_count,
        )
        self._browser_blocked_paths[signature] = snapshot
        if error_code:
            self._browser_path_error_codes[signature] = error_code
        decision = self._browser_no_progress_decision(
            tool_name=tool_name,
            args=args,
            signature=signature,
            result=None,
            snapshot=snapshot,
            path_count=next_path_count,
            method_family=method_family,
            error_code=error_code,
            blocked_attempt=True,
        )
        if decision.should_halt:
            self._halt_decision = decision
        return decision

    def _browser_no_progress_decision(
        self,
        *,
        tool_name: str,
        args: Mapping[str, Any],
        signature: ToolCallSignature,
        result: Any,
        snapshot: _BrowserProgressSnapshot | None,
        path_count: int,
        method_family: str | None,
        error_code: str | None,
        blocked_attempt: bool,
    ) -> ToolGuardrailDecision:
        total_count = self._browser_consecutive_no_progress
        recovery_context = self._browser_recovery_context(
            signature=signature,
            snapshot=snapshot,
            path_count=path_count,
            method_family=method_family,
            error_code=error_code,
        )

        if total_count >= self.config.browser_total_no_progress_budget:
            return ToolGuardrailDecision(
                action="halt",
                code="browser_no_progress_budget_exhausted",
                message=(
                    f"The browser accumulated {total_count} no-progress results in this "
                    f"turn and used {self._browser_strategy_pivots_used} strategy "
                    "pivots. Browser automation is stopping for this turn to prevent "
                    "another loop."
                ),
                tool_name=tool_name,
                count=total_count,
                signature=signature,
                user_context=_browser_user_context(
                    tool_name,
                    args,
                    result=result,
                    snapshot=snapshot,
                    status=_browser_failure_status(result) or "no_progress",
                    error_code=error_code,
                ),
                recovery_context=recovery_context,
            )

        next_pivot_at = (
            self.config.browser_strategy_pivot_after
            + (
                self._browser_strategy_pivots_used
                * self.config.browser_strategy_pivot_interval
            )
        )
        if (
            self._browser_strategy_pivots_used
            < self.config.browser_strategy_pivot_limit
            and total_count >= next_pivot_at
        ):
            self._browser_strategy_pivots_used += 1
            self._browser_blocked_paths[signature] = snapshot
            recovery_context = self._browser_recovery_context(
                signature=signature,
                snapshot=snapshot,
                path_count=path_count,
                method_family=method_family,
                error_code=error_code,
                strategy_pivot_required=True,
            )
            return ToolGuardrailDecision(
                action="skip" if blocked_attempt else "warn",
                code="strategy_pivot_required",
                message=(
                    "The current browser strategy produced no verifiable change, and "
                    "this path is now closed. Based on the current evidence, use a "
                    "different element, method family, tab, or navigation path. Do not "
                    "replay the same program."
                ),
                tool_name=tool_name,
                count=total_count,
                signature=signature,
                recovery_context=recovery_context,
            )

        if blocked_attempt:
            return ToolGuardrailDecision(
                action="skip",
                code="browser_path_blocked",
                message=(
                    f"Blocked {tool_name}: in the same browser state, this path has "
                    f"produced no verifiable change {path_count} times. Switch strategy "
                    "instead of repeating this call."
                ),
                tool_name=tool_name,
                count=total_count,
                signature=signature,
                recovery_context={
                    **recovery_context,
                    "strategy_pivot_required": True,
                },
            )

        if (
            path_count >= self.config.browser_path_block_after
            or total_count >= self.config.browser_no_progress_warn_after
        ):
            return ToolGuardrailDecision(
                action="warn",
                code="browser_no_progress_warning",
                message=(
                    f"The browser has accumulated {total_count} results without a "
                    "verifiable change in this turn. The repeated path is now closed; "
                    "use another element, method family, tab, or navigation route."
                ),
                tool_name=tool_name,
                count=total_count,
                signature=signature,
                recovery_context=recovery_context,
            )

        return ToolGuardrailDecision(
            tool_name=tool_name,
            count=total_count,
            signature=signature,
            recovery_context=recovery_context,
        )

    def _browser_recovery_context(
        self,
        *,
        signature: ToolCallSignature,
        snapshot: _BrowserProgressSnapshot | None,
        path_count: int,
        method_family: str | None,
        error_code: str | None,
        strategy_pivot_required: bool = False,
    ) -> dict[str, Any]:
        blocked_paths = sorted(
            (
                blocked_signature.to_metadata()
                for blocked_signature in self._browser_blocked_paths
            ),
            key=lambda item: (item["tool_name"], item["args_hash"]),
        )
        context: dict[str, Any] = {
            "strategy_pivot_required": strategy_pivot_required,
            "blocked_path": signature.to_metadata(),
            "blocked_paths": blocked_paths,
            "path_no_progress_count": path_count,
            "total_no_progress_count": self._browser_consecutive_no_progress,
            "strategy_pivots_used": self._browser_strategy_pivots_used,
            "remaining_strategy_pivots": max(
                0,
                self.config.browser_strategy_pivot_limit
                - self._browser_strategy_pivots_used,
            ),
            "remaining_no_progress_budget": max(
                0,
                self.config.browser_total_no_progress_budget
                - self._browser_consecutive_no_progress,
            ),
            "current_evidence": _browser_evidence_metadata(snapshot),
        }
        if method_family:
            context["method_family"] = method_family
        context["error_code"] = error_code or "NO_VERIFIED_PROGRESS"
        return context

    def _reset_browser_stagnation(
        self,
        snapshot: _BrowserProgressSnapshot | None,
    ) -> None:
        self._browser_snapshot = snapshot
        self._browser_consecutive_no_progress = 0
        self._browser_strategy_pivots_used = 0
        self._browser_path_no_progress.clear()
        self._browser_blocked_paths.clear()
        self._browser_path_error_codes.clear()
        self._browser_method_error_counts.clear()
        self._browser_blocked_method_errors.clear()
        self._browser_last_result_hash.clear()
        self._browser_seen_replan_evidence.clear()

    def _is_idempotent(self, tool_name: str) -> bool:
        if tool_name in self.config.mutating_tools:
            return False
        return tool_name in self.config.idempotent_tools


def toolguard_synthetic_result(decision: ToolGuardrailDecision) -> str:
    """Build a synthetic role=tool content string for a blocked tool call."""
    if decision.code == "strategy_pivot_required":
        return json.dumps(
            {
                "status": "needs_replan",
                "executed": False,
                "replan_required": True,
                "strategy_pivot_required": True,
                "message": decision.message,
                "guardrail": decision.to_metadata(),
            },
            ensure_ascii=False,
        )
    return json.dumps(
        {
            "error": decision.message,
            "status": "skipped",
            "executed": False,
            "guardrail": decision.to_metadata(),
        },
        ensure_ascii=False,
    )


def append_toolguard_guidance(result: Any, decision: ToolGuardrailDecision) -> Any:
    """Append runtime guidance to the current tool result content."""
    if decision.action not in {"warn", "halt"} or not decision.message:
        return result
    label = "Tool loop hard stop" if decision.action == "halt" else "Tool loop warning"
    decision_metadata = decision.to_metadata()
    pivot_required = decision.code == "strategy_pivot_required"
    metadata_suffix = ""
    if pivot_required:
        metadata_suffix = (
            "; recovery="
            + json.dumps(
                decision_metadata.get("recovery", {}),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    suffix = (
        f"\n\n[{label}: "
        f"{decision.code}; count={decision.count}; {decision.message}"
        f"{metadata_suffix}]"
    )

    def annotate_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
        annotated = dict(value)
        annotated["tool_loop_guardrail"] = decision_metadata
        if pivot_required:
            # This is an executor boundary, not prose for the model to infer.
            # Keep it top-level so mapping, multimodal, and JSON-string browser
            # results all open the same post-call replan barrier.
            annotated["replan_required"] = True
            annotated["strategy_pivot_required"] = True
        if annotated.get("_multimodal") is True:
            content = [dict(item) if isinstance(item, Mapping) else item for item in annotated.get("content", [])]
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    item["text"] = str(item.get("text") or "") + suffix
                    break
            else:
                content.insert(0, {"type": "text", "text": suffix.lstrip()})
            annotated["content"] = content
            annotated["text_summary"] = str(annotated.get("text_summary") or "") + suffix
        return annotated

    if isinstance(result, Mapping):
        return annotate_mapping(result)
    if isinstance(result, str):
        parsed = safe_json_loads(result)
        if isinstance(parsed, Mapping):
            return json.dumps(
                annotate_mapping(parsed),
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            )
    return _result_text(result) + suffix


def _tool_failure_recovery_hint(tool_name: str, count: int) -> str:
    """Action-oriented guidance for recovering from repeated tool failures."""
    common = (
        f"{tool_name} has failed {count} times this turn. This looks like a loop. "
        "Do not switch to text-only replies; keep using tools, but diagnose before retrying. "
        "First inspect the latest error/output and verify your assumptions. "
    )
    if tool_name == "terminal":
        return common + (
            "For terminal failures, run a small diagnostic such as `pwd && ls -la` "
            "in the same tool, then try an absolute path, a simpler command, a different "
            "working directory, or a different tool such as read_file/write_file/patch."
        )
    return common + (
        "Try different arguments, a narrower query/path, an absolute path when relevant, "
        "or a different tool that can make progress. If the blocker is external, report "
        "the blocker after one diagnostic attempt instead of repeating the same failing path."
    )


def _coerce_args(args: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return args if isinstance(args, Mapping) else {}


def _browser_program_signature(
    args: Mapping[str, Any] | None,
) -> ToolCallSignature:
    """Identify executable browser code independently from model narration."""

    args = _coerce_args(args)
    task_space_id = args.get("task_space_id")
    if task_space_id is None:
        task_space_id = args.get("taskSpaceId")
    return ToolCallSignature.from_call(
        "browser_run",
        {
            "code": str(args.get("code") or ""),
            "task_space_id": (
                str(task_space_id) if task_space_id is not None else None
            ),
        },
    )


def _browser_path_signature(
    tool_name: str,
    args: Mapping[str, Any] | None,
) -> ToolCallSignature:
    """Identify a browser path without letting narration disguise a replay."""

    if tool_name == "browser_run":
        return _browser_program_signature(args)
    return ToolCallSignature.from_call(tool_name, _coerce_args(args))


def _browser_method_family(
    tool_name: str,
    args: Mapping[str, Any] | None,
    result: Any,
) -> str | None:
    """Return the inner browser operation family hidden by ``browser_run``."""

    methods: list[str] = []
    if tool_name == "browser_run":
        parsed = _parsed_result(result)
        if isinstance(parsed, Mapping):
            traces: list[Any] = [parsed.get("trace")]
            nested_result = parsed.get("result")
            if isinstance(nested_result, Mapping):
                traces.append(nested_result.get("trace"))
            for trace in traces:
                if not isinstance(trace, (list, tuple)):
                    continue
                for item in trace:
                    if not isinstance(item, Mapping):
                        continue
                    method = item.get("method")
                    if isinstance(method, str) and method.strip():
                        methods.append(method.strip())
        if not methods:
            code = str(_coerce_args(args).get("code") or "")
            methods.extend(_FAN_METHOD_CALL_RE.findall(code))
    else:
        method = _BROWSER_ATOMIC_METHOD_NAMES.get(tool_name)
        if method:
            methods.append(method)

    families = {
        _FAN_METHOD_FAMILIES.get(method, method)
        for method in methods
        if method and method not in _FAN_NON_OPERATION_METHODS
    }
    if not families:
        return tool_name.removeprefix("browser_") or None

    # Passive observation/wait steps are commonly appended to an effectful
    # program.  They do not turn a click retry into a new method family.
    effectful_families = families.difference({"observation", "wait", "output"})
    if effectful_families:
        families = effectful_families
    return "+".join(sorted(families))


def _result_hash(result: Any) -> str:
    parsed = safe_json_loads(result or "") if isinstance(result, str) else result
    if isinstance(parsed, Mapping) and parsed.get("_multimodal") is True:
        parsed = {
            "_multimodal": True,
            "text_summary": parsed.get("text_summary"),
            "screenshot": parsed.get("screenshot"),
        }
    if parsed is not None:
        try:
            canonical = json.dumps(
                parsed,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            )
        except TypeError:
            canonical = str(parsed)
    else:
        canonical = result or ""
    if not isinstance(canonical, str):
        canonical = str(canonical)
    return _sha256(canonical)


def _browser_failure_metadata(result: Any) -> tuple[str | None, bool | None]:
    parsed = safe_json_loads(result or "") if isinstance(result, str) else result
    if not isinstance(parsed, Mapping):
        return None, None

    def walk(value: Mapping[str, Any]) -> tuple[str | None, bool | None]:
        code = value.get("code") or value.get("error_code") or value.get("errorCode")
        retryable = value.get("retryable")
        details = value.get("details") or value.get("error_details") or value.get("errorDetails")
        if isinstance(details, Mapping) and retryable is None:
            retryable = details.get("retryable")
        if code is not None or isinstance(retryable, bool):
            return (
                str(code) if code is not None else None,
                retryable if isinstance(retryable, bool) else None,
            )
        for key in ("result", "error"):
            nested = value.get(key)
            if isinstance(nested, Mapping):
                found = walk(nested)
                if found != (None, None):
                    return found
        return None, None

    return walk(parsed)


def _browser_failure_status(result: Any) -> str | None:
    parsed = _parsed_result(result)
    if not isinstance(parsed, Mapping):
        return None
    status = parsed.get("status")
    if status is None and isinstance(parsed.get("result"), Mapping):
        status = parsed["result"].get("status")
    return str(status).strip().lower() if status is not None else None


_BROWSER_USER_ACTIONS = {
    "browser_snapshot": "confirm the current page state",
    "browser_observe": "confirm whether the page has updated",
    "browser_wait": "wait for the page to finish loading",
    "browser_settle": "wait for page activity to settle",
    "browser_search": "search the page",
    "browser_search_page": "find content on the current page",
    "browser_find_elements": "find page controls",
    "browser_page_content": "read the current page content",
    "browser_navigate": "open the target webpage",
    "browser_click": "click the target control",
    "browser_type": "type into an input field",
    "browser_fill_form": "fill in the page form",
    "browser_scroll": "scroll the page",
    "browser_scroll_to_text": "scroll to the target content",
    "browser_back": "go back",
    "browser_forward": "go forward",
    "browser_reload": "reload the page",
    "browser_send_keys": "send keys to the page",
    "browser_select": "select a page option",
    "browser_find_visual": "find and operate a page target",
    "browser_new_tab": "open a new tab",
    "browser_switch_tab": "switch tabs",
    "browser_close_tab": "close a tab",
    "browser_dialog": "handle a page dialog",
    "browser_upload": "upload a file",
    "browser_mouse": "operate a page target",
    "browser_hover": "move the pointer over a target control",
    "browser_focus": "focus a target control",
    "browser_drag": "drag a page target",
    "browser_run": "complete the previous page operation",
}


def _browser_user_context(
    tool_name: str,
    args: Mapping[str, Any] | None,
    *,
    result: Any = None,
    snapshot: _BrowserProgressSnapshot | None = None,
    status: str | None = None,
    error_code: str | None = None,
) -> dict[str, str]:
    """Build bounded, non-sensitive context for a user-facing halt message."""

    args = _coerce_args(args)
    intent = ""
    if tool_name == "browser_run":
        intent = _bounded_one_line(args.get("intent"), limit=180)
    elif tool_name == "browser_handoff":
        intent = _bounded_one_line(args.get("reason"), limit=180)
    attempted_action = intent or _BROWSER_USER_ACTIONS.get(
        tool_name,
        "complete the previous unsuccessful browser operation",
    )

    result_status, result_code, result_message = _browser_result_error_context(
        result
    )
    context: dict[str, str] = {"attempted_action": attempted_action}
    effective_status = _bounded_one_line(status or result_status, limit=80)
    effective_code = _bounded_one_line(error_code or result_code, limit=120)
    if effective_status:
        context["status"] = effective_status
    if effective_code and effective_code != "BROWSER_TOOL_FAILED":
        context["error_code"] = effective_code
    if result_message:
        context["error_message"] = result_message
    if snapshot is not None and snapshot.url:
        safe_page_url = _safe_browser_page_url(snapshot.url)
        if safe_page_url:
            context["page_url"] = safe_page_url
    return context


def _browser_result_error_context(
    result: Any,
) -> tuple[str | None, str | None, str | None]:
    """Extract only explicit browser error/boundary fields, never page text."""

    parsed = _parsed_result(result)
    if not isinstance(parsed, Mapping):
        return None, None, None

    raw_status = parsed.get("status")
    status = (
        _bounded_one_line(raw_status, limit=80)
        if raw_status is not None
        else None
    )
    queue: list[Mapping[str, Any]] = [parsed]
    visited: set[int] = set()
    code: str | None = None
    message: str | None = None
    while queue:
        current = queue.pop(0)
        current_id = id(current)
        if current_id in visited:
            continue
        visited.add(current_id)

        if code is None:
            raw_code = (
                current.get("code")
                or current.get("error_code")
                or current.get("errorCode")
            )
            if raw_code is not None:
                code = _bounded_one_line(raw_code, limit=120) or None

        if message is None:
            for key in ("errorDescription", "message", "reason", "detail"):
                candidate = current.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    message = _bounded_one_line(candidate, limit=240) or None
                    break
            if message is None:
                raw_error = current.get("error")
                if isinstance(raw_error, str) and raw_error.strip():
                    message = _bounded_one_line(raw_error, limit=240) or None

        for key in ("error", "boundary", "details", "result"):
            nested = current.get(key)
            if isinstance(nested, Mapping):
                queue.append(nested)

    return status, code, message


def _bounded_one_line(value: Any, *, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _safe_browser_page_url(value: Any) -> str:
    """Keep page identity useful without echoing credentials or query tokens."""

    raw = _bounded_one_line(value, limit=2_000)
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
        hostname = parts.hostname or ""
        if not parts.scheme or not hostname:
            return ""
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        port = f":{parts.port}" if parts.port is not None else ""
        return _bounded_one_line(
            urlunsplit((parts.scheme, f"{hostname}{port}", parts.path, "", "")),
            limit=240,
        )
    except ValueError:
        return ""


def _browser_program_replay_reason(result: Any) -> str | None:
    """Return why the exact program must not be replayed this turn."""

    status = _browser_failure_status(result)
    if status in {"failed_after_effect", "unknown_after_effect"}:
        return status
    if status not in {"needs_replan", "needs_human"}:
        return None

    parsed = _parsed_result(result)
    if not isinstance(parsed, Mapping):
        return None
    run_effect = (
        parsed.get("run_effect")
        or parsed.get("runEffect")
        or parsed.get("effect")
    )
    if run_effect is None and isinstance(parsed.get("result"), Mapping):
        nested = parsed["result"]
        run_effect = (
            nested.get("run_effect")
            or nested.get("runEffect")
            or nested.get("effect")
        )
    if not isinstance(run_effect, Mapping):
        return None
    if run_effect.get("occurred") is True or run_effect.get("uncertain") is True:
        return status
    return None


def _browser_program_has_authoritative_final_snapshot(result: Any) -> bool:
    """Whether a program failure returned a fresh host-produced page snapshot."""

    parsed = _parsed_result(result)
    if not isinstance(parsed, Mapping):
        return False
    candidates = [
        parsed.get("final_snapshot"),
        parsed.get("finalSnapshot"),
    ]
    nested = parsed.get("result")
    if isinstance(nested, Mapping):
        candidates.extend(
            [
                nested.get("final_snapshot"),
                nested.get("finalSnapshot"),
            ]
        )
    for snapshot in candidates:
        if isinstance(snapshot, str) and "<page_observation" in snapshot:
            return True
        if isinstance(snapshot, Mapping) and snapshot:
            return True
    return False


def _browser_replan_evidence_fingerprint(result: Any) -> str | None:
    """Hash only decision-useful evidence carried by ``needs_replan``."""

    parsed = _parsed_result(result)
    if not isinstance(parsed, Mapping):
        return None

    evidence: dict[str, Any] = {}
    dom = _browser_dom_text(parsed)
    if dom:
        evidence["dom"] = _normalize_browser_dom(dom)

    mappings = list(_walk_mappings(parsed))
    structured: list[tuple[str, Any]] = []
    for value in mappings:
        for key in (
            "candidate",
            "candidates",
            "matches",
            "elements",
            "stateChanges",
            "state_changes",
        ):
            candidate = value.get(key)
            if isinstance(candidate, Mapping) and candidate:
                structured.append((key, candidate))
            elif isinstance(candidate, (list, tuple)) and candidate:
                structured.append((key, candidate))
            elif isinstance(candidate, str) and candidate.strip():
                structured.append((key, candidate.strip()))
    if structured:
        evidence["structured"] = structured

    identity: dict[str, str] = {}
    for field_name in _BROWSER_STATE_FIELDS:
        candidate = _first_mapping_value(mappings, field_name)
        if candidate is not None:
            identity[field_name] = str(candidate)
    if identity:
        evidence["identity"] = identity

    candidate_url = _first_mapping_value(mappings, "finalUrl", "url")
    if candidate_url is not None:
        candidate_url = str(candidate_url).strip()
        if candidate_url:
            evidence["url"] = candidate_url
    if not evidence:
        return None
    return _sha256(
        json.dumps(
            evidence,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    )


def _browser_evidence_metadata(
    snapshot: _BrowserProgressSnapshot | None,
) -> dict[str, Any]:
    """Return bounded state evidence without exposing page text or raw args."""

    if snapshot is None:
        return {}
    evidence: dict[str, Any] = {}
    identity = {
        key: value
        for key, value in snapshot.identity
        if key != "sessionId"
    }
    if identity:
        evidence["identity"] = identity
    if snapshot.url:
        safe_url = _safe_browser_page_url(snapshot.url)
        if safe_url:
            evidence["page_url"] = safe_url
    if snapshot.dom_hash:
        evidence["dom_fingerprint"] = snapshot.dom_hash[:16]
    if snapshot.position:
        evidence["position"] = dict(snapshot.position)
    return evidence


def _browser_progress_snapshot(
    state: Mapping[str, Any] | None,
    result: Any,
) -> _BrowserProgressSnapshot | None:
    state_map = state if isinstance(state, Mapping) else {}
    parsed = _parsed_result(result)
    mappings = list(_walk_mappings(parsed)) if isinstance(parsed, Mapping) else []

    identity: list[tuple[str, str]] = []
    for field_name in _BROWSER_STATE_FIELDS:
        value = state_map.get(field_name)
        if value is None:
            value = _first_mapping_value(mappings, field_name)
        if value is not None:
            identity.append((field_name, str(value)))

    dom = _browser_dom_text(parsed)
    url = _url_from_dom(dom)
    if not url:
        url_value = _first_mapping_value(mappings, "finalUrl", "url")
        url = str(url_value).strip() if url_value is not None else None

    position: list[tuple[str, str]] = []
    for field_name in ("scrollY", "scrollTop", "pagesAbove"):
        value = _first_mapping_value(mappings, field_name)
        if value is not None:
            position.append((field_name, str(value)))

    dom_hash = _sha256(_normalize_browser_dom(dom)) if dom else None
    if not identity and not url and not dom_hash and not position:
        return None
    return _BrowserProgressSnapshot(
        identity=tuple(identity),
        url=url,
        dom_hash=dom_hash,
        position=tuple(position),
    )


def _merge_browser_snapshots(
    previous: _BrowserProgressSnapshot | None,
    current: _BrowserProgressSnapshot,
) -> _BrowserProgressSnapshot:
    if previous is None:
        return current
    previous_identity = dict(previous.identity)
    previous_identity.update(dict(current.identity))
    previous_position = dict(previous.position)
    previous_position.update(dict(current.position))
    return _BrowserProgressSnapshot(
        identity=tuple(sorted(previous_identity.items())),
        url=current.url or previous.url,
        dom_hash=current.dom_hash or previous.dom_hash,
        position=tuple(sorted(previous_position.items())),
    )


def _browser_snapshot_changed(
    previous: _BrowserProgressSnapshot | None,
    current: _BrowserProgressSnapshot | None,
) -> bool:
    if previous is None or current is None:
        return False

    previous_identity = dict(previous.identity)
    current_identity = dict(current.identity)
    for field_name in _BROWSER_STATE_FIELDS:
        before = previous_identity.get(field_name)
        after = current_identity.get(field_name)
        if before is not None and after is not None and before != after:
            return True

    if previous.url and current.url and previous.url != current.url:
        return True
    if previous.dom_hash and current.dom_hash and previous.dom_hash != current.dom_hash:
        return True

    previous_position = dict(previous.position)
    current_position = dict(current.position)
    for field_name in set(previous_position).intersection(current_position):
        if previous_position[field_name] != current_position[field_name]:
            return True
    return False


def _browser_result_flags(result: Any) -> dict[str, Any]:
    parsed = _parsed_result(result)
    mappings = list(_walk_mappings(parsed)) if isinstance(parsed, Mapping) else []
    program_methods = {
        str(value.get("method")).strip()
        for value in mappings
        if isinstance(value.get("method"), str) and value.get("method").strip()
    }
    recovery_methods = {"observe", "tabs", "wait", "settle"}
    output_methods = {"saveScreenshot", "savePdf"}
    effects = {
        str(value.get("effect")).strip().lower()
        for value in mappings
        if isinstance(value.get("effect"), str) and value.get("effect").strip()
    }
    return {
        # Wrapper-owned top-level provenance: intermediate actions in one
        # live-validated selector batch intentionally defer a new observation.
        # They are neither proven business progress nor stagnation yet.
        "same_snapshot_continue": bool(
            isinstance(parsed, Mapping)
            and parsed.get("same_snapshot_continue") is True
        ),
        "selection_applied": any(
            value.get("selected") is not None
            and value.get("error") is None
            for value in mappings
        ),
        "executed_false": any(
            value.get("executed") is False
            or str(value.get("status") or "").strip().lower() in {"skipped", "cancelled"}
            for value in mappings
        ),
        "replan_required": any(
            value.get("replan_required") is True
            or value.get("replanRequired") is True
            for value in mappings
        ),
        "program_recovery_only": bool(
            program_methods and program_methods.issubset(recovery_methods)
        ),
        "program_output_only": bool(
            program_methods and program_methods.issubset(output_methods)
        ),
        "program_methods": program_methods,
        "effects": effects,
    }


def _browser_semantic_result_hash(result: Any) -> str:
    parsed = _parsed_result(result)
    dom = _browser_dom_text(parsed)
    if dom:
        return _sha256(_normalize_browser_dom(dom))
    return _result_hash(result)


def _parsed_result(result: Any) -> Any:
    if isinstance(result, str):
        parsed = safe_json_loads(result)
        return parsed if parsed is not None else result
    return result


def _walk_mappings(value: Any):
    if isinstance(value, Mapping):
        yield value
        for nested in value.values():
            yield from _walk_mappings(nested)
    elif isinstance(value, (list, tuple)):
        for nested in value:
            yield from _walk_mappings(nested)


def _first_mapping_value(
    mappings: list[Mapping[str, Any]],
    *field_names: str,
) -> Any:
    for mapping in mappings:
        for field_name in field_names:
            if mapping.get(field_name) is not None:
                return mapping.get(field_name)
    return None


def _browser_dom_text(parsed: Any) -> str:
    if not isinstance(parsed, Mapping):
        return ""
    for field_name in (
        "dom",
        "text_summary",
        "final_snapshot",
        "finalSnapshot",
        "snapshot",
    ):
        value = parsed.get(field_name)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, Mapping):
            found = _browser_dom_text(value)
            if found:
                return found
    content = parsed.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, Mapping) and item.get("type") == "text":
                value = item.get("text")
                if isinstance(value, str) and value.strip():
                    return value
    for nested in parsed.values():
        found = _browser_dom_text(nested)
        if found:
            return found
    return ""


def _normalize_browser_dom(dom: str) -> str:
    without_indexes = _DOM_INDEX_RE.sub("[]", str(dom or ""))
    return " ".join(without_indexes.split())


def _url_from_dom(dom: str) -> str | None:
    match = _PAGE_URL_RE.search(str(dom or ""))
    return match.group(1).strip() if match else None


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on", "enabled"}:
            return True
        if lowered in {"0", "false", "no", "off", "disabled"}:
            return False
    return default


def _positive_int(value: Any, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 1 else default


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
