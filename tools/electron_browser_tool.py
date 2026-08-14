"""Electron-native browser runtime tools.

These wrappers deliberately contain no CDP or DOM logic; the Electron main
process owns the browser runtime.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
import re
import time
import uuid
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from agent.electron_browser_client import ElectronBrowserClient, ElectronBrowserRuntimeError
from agent.stale_observation_collapser import PAGE_OBSERVATION_BEGIN, PAGE_OBSERVATION_END
from tools.electron_browser_args import (
    _coerce_headers,
    _coerce_json_object,
    _coerce_string_list,
    _tab_ref,
    _target_payload,
)
from tools.electron_browser_context import (
    browser_callbacks as _browser_callbacks,
    browser_decision_state as _browser_decision_state,
    browser_guard_active as _guard_active,
    clear_browser_decision_context,
    current_browser_decision_token,
    current_browser_observation_token,
    refresh_browser_observation_token as _refresh_browser_observation_token,
    refresh_browser_decision_token as _refresh_browser_decision_token,
    set_browser_decision_context,
    set_browser_guard_active as _set_browser_guard_active,
    set_control_callback,
    set_verification_callback,
)
from tools.electron_browser_serialization import (
    _BROWSER_REPLAN_ERROR_CODES,
    _ERROR_HINTS,
    _OBS_MARKER_RE,
    _append_recent_events,
    _enrich_error,
    _format_structured_error_details,
    _is_blank_observation,
    _is_stale_index_error,
    _obs_page_header,
    _observe_text,
    _strip_runtime_error_shell,
    _tabs_prefix,
    format_observation_for_model,
)
from tools.electron_browser_tool_catalog import register_electron_browser_tools
from tools.electron_browser_visual import (
    VisualFindDependencies,
    _BOX_COLORS,
    _FV_MIN_SIDE_PX,
    _FV_OVERSIZE_VIEWPORT_FRAC,
    _ROLE_TO_TAG,
    _box_color_for,
    _crop_png_region,
    _fan_home_dir,
    _find_visual_dir,
    _fv_debug_dump,
    _fv_dump_composition,
    _fv_semantic_weight,
    _load_box_font,
    _meaningful_text,
    _paint_index_boxes,
    _prune_for_paint,
    _should_label,
    find_visual as _find_visual,
    observation_viewport as _visual_observation_viewport,
)
from tools.registry import registry, tool_error, tool_result
from tools.interrupt import is_interrupted as _is_interrupted
from tools.url_safety import is_always_blocked_url

logger = logging.getLogger(__name__)

_SEARCH_ENGINES = frozenset({"baidu", "bing", "duckduckgo", "google"})


def _configured_search_engine(config: dict | None = None) -> str:
    if config is None:
        try:
            from fan_cli.config import load_config_readonly

            config = load_config_readonly()
        except Exception:
            config = {}

    browser = config.get("browser") if isinstance(config, dict) else None
    engine = str((browser or {}).get("search_engine", "baidu") or "baidu").strip().lower()

    return engine if engine in _SEARCH_ENGINES else "baidu"


def _client() -> ElectronBrowserClient:
    return ElectronBrowserClient()


def _check() -> bool:
    return _client().available


def _check_visual() -> bool:
    if not _check():
        return False
    try:
        from tools.vision_tools import check_vision_requirements

        return bool(check_vision_requirements())
    except Exception:
        return False


def _task_id(kw: dict[str, Any]) -> str:
    return str(kw.get("task_id") or "main")


# The Electron runtime deliberately runs on the user's own machine while browser
# tool results may be sent to the configured remote model. Fan intentionally
# supports loopback/LAN/local-file automation here, but every model-visible
# content surface still enforces the cloud-metadata floor and Fan's shared local
# credential-file denylist.
_PRIVATE_PAGE_CONTENT_ACTIONS = frozenset({
    "observe",
    "searchPage",
    "findElements",
    "pageContent",
    "screenshot",
    "saveScreenshot",
    "savePdf",
    "har",
    "saveHar",
    "storageState",
    "saveStorageState",
    "evaluate",
    "evaluateJavaScript",
    "element",
    "cdp",
})
_POST_EXECUTION_URL_GUARD_ACTIONS = frozenset({"evaluate", "evaluateJavaScript", "element", "cdp"})
_JS_URL_LITERAL_RE = re.compile(r'''(?:https?|file)://[^\s'"`)\]<>]+''', re.IGNORECASE)

_MUTATING_RPC_ACTIONS = frozenset({
    "switchTarget", "closeTarget", "cdp", "loadStorageState", "grantPermissions",
    "setNetworkConfig", "setUrlPolicy", "acknowledgeIntervention", "flagIntervention",
    "saveStorageState", "saveHar", "saveScreenshot", "savePdf",
    "startScreencast", "stopScreencast", "highlight", "search", "navigate", "click",
    "type", "fillForm", "formSubmit", "scroll", "scrollToText", "dropdownOptions", "select", "mouse", "hover", "focus", "drag",
    "evaluate", "evaluateJavaScript", "element", "dialog", "setViewport", "upload",
    "sendKeys", "back", "forward", "reload", "newTab", "switchTab", "closeTab",
})
_RPC_TIMEOUT_SECONDS = {
    "fillForm": 190.0,
    "formSubmit": 190.0,
    "type": 80.0,
    "observe": 70.0,
    "settle": 190.0,
    "click": 35.0,
    "navigate": 50.0,
    "reload": 50.0,
    "upload": 50.0,
}

def _active_browser_url(kw: dict[str, Any]) -> str | None:
    """Read only the active-tab URL without asking the renderer for page data."""

    try:
        state = _client().call("liveState", workbench_id=_task_id(kw), params={})
    except Exception as exc:
        logger.warning("browser protected-url guard could not read live state: %s", exc)
        return None
    if not isinstance(state, dict):
        return None
    tabs = state.get("tabs")
    if isinstance(tabs, list):
        for tab in tabs:
            if isinstance(tab, dict) and tab.get("current"):
                url = str(tab.get("url") or "").strip()
                if url:
                    return url
    return str(state.get("url") or "").strip() or None


def _private_browser_url_error(url: str | None) -> str | None:
    """Block only Fan's non-negotiable cloud-metadata credential floor.

    The Electron browser is a user-machine automation surface, so loopback,
    private LAN and file:// pages are valid targets. Other server-side HTTP
    tools continue to use the full :func:`tools.url_safety.is_safe_url` policy.
    """

    value = str(url or "").strip()
    if not value:
        return None
    try:
        scheme = urlparse(value).scheme.lower()
    except Exception:
        return None
    if scheme == "file":
        try:
            parsed = urlparse(value)
            host = (parsed.hostname or "").strip().lower().rstrip(".")
            if host not in {"", "localhost"} or parsed.username or parsed.password:
                return "Blocked: remote/UNC file URLs are not local automation targets."
            raw_path = unquote(parsed.path or "")
            if not raw_path or "\x00" in raw_path:
                return "Blocked: the local file URL is invalid."
            local_path = Path(url2pathname(raw_path)).expanduser().resolve(strict=False)
            from agent.file_safety import get_read_block_error

            denied = get_read_block_error(str(local_path))
        except Exception as exc:
            logger.warning("browser local-file guard failed closed for %s: %s", value, exc)
            return "Blocked: the local file target could not be safely validated."
        if denied:
            return (
                "Blocked: this local file is protected credential or Fan authority state and "
                "cannot be exposed to browser automation. Do not retry through another tool."
            )
        return None
    if scheme not in {"http", "https"}:
        return None
    try:
        blocked = is_always_blocked_url(value)
    except Exception as exc:
        # The floor is fail-closed: a validation failure must not become an SSRF
        # bypass for the credential endpoints it is intended to protect.
        logger.warning("browser metadata guard failed closed for %s: %s", value, exc)
        return "Blocked: the browser target could not be safely validated."
    if not blocked:
        return None
    return (
        "Blocked: cloud metadata and link-local credential endpoints are never "
        "available to browser automation."
    )


def _active_page_private_url_error(kw: dict[str, Any]) -> str | None:
    active_url = _active_browser_url(kw)
    if not active_url:
        # Model-visible reads must never turn a runtime/teardown race into a
        # credential-boundary bypass. Navigation itself remains available so a
        # caller can recover by opening a known-safe URL.
        return (
            "Blocked: the active browser location could not be safely verified. "
            "Navigate to a known-safe page and retry."
        )
    return _private_browser_url_error(active_url)


def _expression_private_url(expression: str) -> str | None:
    """Best-effort preflight for fetch/XHR/location URL literals in model JS."""

    if not isinstance(expression, str):
        return None
    for match in _JS_URL_LITERAL_RE.findall(expression):
        candidate = match.rstrip(".,;")
        if _private_browser_url_error(candidate):
            return candidate
    return None


def _private_url_error_result(message: str) -> dict[str, Any]:
    return {
        "__error__": message,
        "__error_code__": "BROWSER_PRIVATE_URL_BLOCKED",
        "__error_details__": {"reason": "private_network_guard", "replanRequired": True},
    }


# Every page-specific RPC except explicit resynchronization/global diagnostics is
# bound to the snapshot the model saw.  Read-only calls are included: returning
# content from a different tab is still a grounding error even if it has no side
# effect.  ``observe`` is intentionally unbound and establishes a fresh token.
_STATE_BOUND_RPC_ACTIONS = frozenset({
    "targets", "targetInfo", "switchTarget", "closeTarget", "cdp",
    "storageState", "saveStorageState", "loadStorageState", "grantPermissions",
    "setNetworkConfig", "networkConfig", "setUrlPolicy", "urlPolicy", "har",
    "saveHar", "startScreencast", "stopScreencast", "highlight", "searchPage",
    "findElements", "pageContent", "search", "navigate", "click", "type", "fillForm", "formSubmit",
    "scroll", "scrollToText", "dropdownOptions", "select", "mouse", "hover",
    "focus", "drag", "evaluate", "evaluateJavaScript", "element", "dialog",
    "screenshot", "saveScreenshot", "savePdf", "setViewport", "upload",
    "sendKeys", "back", "forward", "reload", "wait", "settle", "newTab",
    "switchTab", "closeTab",
})


def _human_control_stopped_result() -> dict[str, Any]:
    return {
        "__error__": "Browser task was stopped by the user.",
        "__error_code__": "HUMAN_CONTROL_STOPPED",
        "__error_details__": {"retryable": False, "replanRequired": False},
    }


def _guard_human(result, kw):
    """Block the agent (approval-style) when the runtime reports a human-only
    situation on the current page. The runtime attaches ``captchaState`` /
    ``interventionPending`` to observe results; on detection we invoke the wired
    blocking callback — which suspends this agent thread until the user resolves
    it in the UI — then re-observe and hand back the fresh page so the same turn
    continues in place. A no-op when no callback is wired or nothing is flagged."""
    if not isinstance(result, dict):
        return result
    verification_cb, control_cb = _browser_callbacks()
    cap = result.get("captchaState")
    # requiresUserInput=False marks a TRANSCRIBABLE code (text/image/SMS) — the
    # agent collects the answer from the user and types it back (browser_agent
    # #11), so it must not block. Default True keeps old runtimes blocking.
    if (
        isinstance(cap, dict)
        and cap.get("detected")
        and cap.get("requiresUserInput", True)
        and verification_cb is not None
    ):
        # Stop may land while the browser RPC is still in flight.  In that
        # case its result must not enter the gateway callback and create a new
        # verification prompt after ``session.interrupt`` cleared the old one.
        if _is_interrupted():
            return _human_control_stopped_result()
        # A pointerdown can win the small race before the runtime has published
        # the behavioral captcha state. Once both flags arrive together, the
        # verification handshake owns that page interaction; clear only the
        # page-pointer takeover latch so it cannot reopen a second pause after
        # verification continues. A tab-strip takeover carries interventionMeta
        # and remains a separate, deliberate control handoff.
        imeta = result.get("interventionMeta")
        imeta = imeta if isinstance(imeta, dict) else {}
        if result.get("interventionPending") and not imeta.get("kind"):
            try:
                acknowledged = _client().call(
                    "acknowledgeIntervention",
                    workbench_id=_task_id(kw),
                    params={"restoreAnchor": False},
                )
                if isinstance(acknowledged, dict) and acknowledged.get("acknowledged"):
                    result["interventionPending"] = False
            except Exception as exc:
                logger.warning(
                    "browser verification could not coalesce pointer intervention: %s",
                    exc,
                )
        meta = {
            "kind": "verification",
            "captcha_type": cap.get("type") or cap.get("kind") or "",
            # Bind the blocking gateway request to the exact runtime challenge.
            # A previous document's delayed captcha.cleared event must never
            # auto-answer this newer request.
            "challenge_id": cap.get("challengeId") or cap.get("challenge_id") or "",
            "document_revision": cap.get("documentRevision")
            if cap.get("documentRevision") is not None
            else cap.get("document_revision"),
            "url": result.get("url") or "",
            "message": "Human verification is required. Complete it in the browser and the agent will continue afterward.",
        }
        return _resolve_block(result, kw, verification_cb, meta)
    if result.get("interventionPending") and control_cb is not None:
        if _is_interrupted():
            return _human_control_stopped_result()
        imeta = result.get("interventionMeta")
        imeta = imeta if isinstance(imeta, dict) else {}
        tab_kind = str(imeta.get("kind") or "")
        if tab_kind == "tab":
            message = "You interacted with a browser tab under agent control, so work is paused. Click Continue to return to the working tab."
        else:
            message = "Your page interaction was detected, so work is paused."
        meta = {
            "kind": "control",
            "url": result.get("url") or "",
            "message": message,
            # Passthrough for the renderer banner (tab-strip vs page-click takeover).
            "tabKind": tab_kind or None,
            "anchorTabId": imeta.get("anchorTabId"),
            "userTabId": imeta.get("userTabId"),
        }
        return _resolve_block(result, kw, control_cb, meta, ack="acknowledgeIntervention")
    return result


def _resolve_block(result, kw, callback, meta, ack: str | None = None):
    """Run the blocking callback, then settle only after an explicit continue.

    Stop, callback failures and failed anchor restoration are fail-closed: the
    runtime latch remains set and no follow-up page action is issued.
    """
    _set_browser_guard_active(True)
    fresh = None
    try:
        try:
            # Re-check immediately before callback admission. Runtime
            # coalescing above may have performed an RPC after the first check;
            # the gateway's turn-cancel latch closes the remaining check/call
            # race atomically.
            if _is_interrupted():
                return _human_control_stopped_result()
            answer = callback(meta)  # blocks until continue / stop / timeout
        except Exception as exc:
            return {
                "__error__": f"Human-control callback failed: {exc}",
                "__error_code__": "HUMAN_CONTROL_CALLBACK_FAILED",
                "__error_details__": {"retryable": False, "replanRequired": True},
            }
        normalized_answer = answer.strip().casefold() if isinstance(answer, str) else ""
        is_verification = isinstance(meta, dict) and meta.get("kind") == "verification"
        should_continue = normalized_answer == "continue" or (
            is_verification and normalized_answer == "auto"
        )
        if not should_continue:
            if normalized_answer == "stop":
                return _human_control_stopped_result()
            return result
        if ack:
            try:
                acknowledged = _client().call(
                    ack,
                    workbench_id=_task_id(kw),
                    params={"restoreAnchor": True},
                )
            except Exception as exc:
                return {
                    "__error__": f"Failed to acknowledge human control: {exc}",
                    "__error_code__": "HUMAN_CONTROL_ACK_FAILED",
                    "__error_details__": {"retryable": True, "replanRequired": True},
                }
            restore_required = bool(
                isinstance(meta, dict)
                and (meta.get("tabKind") == "tab" or meta.get("anchorTabId"))
            )
            if not isinstance(acknowledged, dict):
                return {
                    "__error__": "Human control was not acknowledged; execution remains paused.",
                    "__error_code__": "HUMAN_CONTROL_ACK_FAILED",
                    "__error_details__": {"retryable": True, "replanRequired": True},
                }
            if restore_required and not acknowledged.get("restored"):
                return {
                    "__error__": "The Agent working tab could not be restored; execution remains paused.",
                    "__error_code__": "HUMAN_CONTROL_RESTORE_FAILED",
                    "__error_details__": {"retryable": False, "replanRequired": True},
                }
            if not acknowledged.get("acknowledged"):
                return {
                    "__error__": "Human control was not acknowledged; execution remains paused.",
                    "__error_code__": "HUMAN_CONTROL_ACK_FAILED",
                    "__error_details__": {"retryable": True, "replanRequired": True},
                }
        fresh = _call("observe", {}, guard=False, **kw)
    finally:
        _set_browser_guard_active(False)
    if isinstance(fresh, dict) and not fresh.get("__error__"):
        return fresh
    return result


_FORM_TRANSACTION_ACTIONS = frozenset({"fillForm", "formSubmit"})
_FORM_TRANSACTION_HUMAN_STATE_KEYS = (
    "captchaState",
    "interventionPending",
    "interventionMeta",
)


def _has_form_transaction_provenance(action: str, result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    fields = result.get("fields")
    if not isinstance(fields, list) or not fields:
        return False
    return action == "fillForm" or (
        action == "formSubmit" and isinstance(result.get("submit"), dict)
    )


def _sanitize_form_transaction_observation(
    action: str,
    result: Any,
) -> Any:
    """Withhold a protected final page without erasing settled step evidence."""

    if action not in _FORM_TRANSACTION_ACTIONS or not isinstance(result, dict):
        return result
    observation = result.get("observation")
    if not isinstance(observation, dict):
        return result
    observation_url = str(observation.get("url") or "").strip()
    if not observation_url:
        tabs = observation.get("tabs")
        if isinstance(tabs, list):
            for tab in tabs:
                if isinstance(tab, dict) and tab.get("current"):
                    observation_url = str(tab.get("url") or "").strip()
                    if observation_url:
                        break
    if observation_url:
        privacy_error = _private_browser_url_error(observation_url)
        blocked_code = "BROWSER_PRIVATE_URL_BLOCKED"
    else:
        # Transaction observations contain model-visible DOM. If neither the
        # observation nor its current-tab summary identifies the page, there is
        # no evidence that the DOM is outside the protected credential boundary.
        # Withhold it rather than letting a runtime/teardown race fail open.
        privacy_error = (
            "Blocked: the final browser location could not be safely verified. "
            "Observe or navigate to a known-safe page before using its contents."
        )
        blocked_code = "BROWSER_OBSERVATION_URL_UNVERIFIED"
    if not privacy_error:
        return result

    sanitized = dict(result)
    sanitized.pop("observation", None)
    sanitized["observationError"] = (
        "The final form observation was withheld by the browser privacy policy."
    )
    sanitized["observationBlocked"] = {
        "code": blocked_code,
        "message": privacy_error,
    }
    sanitized["replanRequired"] = True
    for key in _FORM_TRANSACTION_HUMAN_STATE_KEYS:
        # Runtime human-state payloads may themselves contain the protected URL.
        sanitized.pop(key, None)
    return sanitized


def _call(action: str, args: dict[str, Any], *, guard: bool | None = None, **kw):
    params = dict(args or {})
    # Protect every model-visible page-content surface, not only the public
    # observe/screenshot wrappers.  This also closes alternate extraction paths
    # such as pageContent, CDP and element evaluation.
    if action in _PRIVATE_PAGE_CONTENT_ACTIONS:
        private_url_error = _active_page_private_url_error(kw)
        if private_url_error:
            return _private_url_error_result(private_url_error)
    if action in _STATE_BOUND_RPC_ACTIONS:
        decision_active, decision_required, decision_token = _browser_decision_state()
        if decision_active and not isinstance(decision_token, dict):
            if decision_required:
                return {
                    "__error__": (
                        "Browser decision snapshot is unavailable; the action was not executed. "
                        "Observe the page and replan before using browser tools."
                    ),
                    "__error_code__": "BROWSER_DECISION_TOKEN_MISSING",
                    "__error_details__": {"retryable": True, "replanRequired": True},
                }
        elif decision_active:
            params["_fanDecisionToken"] = decision_token
    action_id = str(uuid.uuid4()) if action in _MUTATING_RPC_ACTIONS else None
    try:
        result = _client().call(
            action,
            workbench_id=_task_id(kw),
            params=params,
            action_id=action_id,
            timeout=_RPC_TIMEOUT_SECONDS.get(action, 70.0),
        )
    except ElectronBrowserRuntimeError as exc:
        if exc.code == "RUNTIME_REQUEST_TIMEOUT" and action_id:
            try:
                status = _client().call(
                    "actionStatus",
                    workbench_id=_task_id(kw),
                    params={},
                    action_id=action_id,
                    timeout=5.0,
                )
                if isinstance(status, dict) and status.get("status") == "completed":
                    result = status.get("result")
                elif isinstance(status, dict) and status.get("status") == "failed":
                    failure = status.get("error") if isinstance(status.get("error"), dict) else {}
                    return {
                        "__error__": str(failure.get("error") or "Browser action failed after the client timed out."),
                        "__error_code__": failure.get("errorCode") or "BROWSER_ACTION_FAILED",
                        "__error_details__": (
                            failure.get("errorDetails")
                            if isinstance(failure.get("errorDetails"), dict)
                            else {"retryable": False, "action": action}
                        ),
                    }
                else:
                    return {
                        "__error__": "Browser action timed out and is still settling; it was not retried.",
                        "__error_code__": "ACTION_TIMEOUT_PENDING",
                        "__error_details__": {
                            "retryable": False,
                            "replanRequired": True,
                            "action": action,
                            "reason": "underlying-action-still-settling",
                        },
                    }
            except ElectronBrowserRuntimeError:
                return {
                    "__error__": "Browser action timed out; execution status is unknown, so it was not retried.",
                    "__error_code__": "ACTION_TIMEOUT_PENDING",
                    "__error_details__": {"retryable": False, "replanRequired": True, "action": action},
                }
        else:
            return {
                "__error__": str(exc),
                "__error_code__": exc.code,
                "__error_details__": exc.details,
            }
    # JS can navigate after the preflight above.  Do not return that evaluation
    # result if the active page has become a private/internal destination.
    if action in _POST_EXECUTION_URL_GUARD_ACTIONS:
        private_url_error = _active_page_private_url_error(kw)
        if private_url_error:
            return _private_url_error_result(private_url_error)
    result = _sanitize_form_transaction_observation(action, result)
    if isinstance(result, dict):
        fresh_token = result.pop("__fanDecisionToken", None)
        _refresh_browser_decision_token(fresh_token)
        if action == "observe" or (
            action in {"fillForm", "formSubmit"}
            and isinstance(result.get("observation"), dict)
        ):
            # These transactions perform their one authoritative observe inside
            # the runtime action. Bind that returned DOM to the fresh token so
            # the next model turn can safely use it without another observe.
            _refresh_browser_observation_token(fresh_token)
    # ``observe`` remains the captcha detection surface. Intervention state is
    # also attached to external actions' trailing observations, so those results
    # must enter the guard too. Auxiliary/recovery calls pass guard=False.
    captcha_state = result.get("captchaState") if isinstance(result, dict) else None
    behavioral_verification = bool(
        isinstance(captcha_state, dict)
        and captcha_state.get("detected")
        and captcha_state.get("requiresUserInput", True)
    )
    default_guard = (
        action == "observe"
        or behavioral_verification
        or (isinstance(result, dict) and bool(result.get("interventionPending")))
    )
    do_guard = default_guard if guard is None else guard
    if do_guard and not _guard_active():
        guarded = _guard_human(result, kw)
        has_transaction_provenance = _has_form_transaction_provenance(
            action,
            result,
        )
        if (
            has_transaction_provenance
            and guarded is not result
            and isinstance(guarded, dict)
            and guarded.get("__error__")
        ):
            # The browser transaction settled before its trailing observation
            # opened a human-control boundary. Preserve those physical facts;
            # the stop/callback/restore error is post-action provenance, not
            # evidence that the submit click never happened.
            merged = dict(result)
            merged["postActionError"] = {
                "message": str(guarded.get("__error__") or "Human control failed"),
                "code": str(
                    guarded.get("__error_code__")
                    or "HUMAN_CONTROL_POST_ACTION_FAILED"
                ),
                "details": guarded.get("__error_details__")
                if isinstance(guarded.get("__error_details__"), dict)
                else {},
            }
            merged["replanRequired"] = True
            return _sanitize_form_transaction_observation(action, merged)
        if (
            action in _FORM_TRANSACTION_ACTIONS
            and isinstance(result, dict)
            and isinstance(result.get("observation"), dict)
            and guarded is not result
            and isinstance(guarded, dict)
            and not guarded.get("__error__")
        ):
            # A continue response makes _guard_human re-observe and return that
            # fresh page. Keep the already-settled transaction steps (especially
            # formSubmit.submit) and replace only their trailing observation.
            # Stop/callback/restore errors carry __error__ and still propagate
            # unchanged, so an interrupted transaction is never reported as a
            # success. Human state must come exclusively from the fresh page.
            merged = dict(result)
            merged["observation"] = guarded
            merged.pop("observationError", None)
            for key in _FORM_TRANSACTION_HUMAN_STATE_KEYS:
                merged.pop(key, None)
                if key in guarded:
                    merged[key] = guarded[key]
            return _sanitize_form_transaction_observation(action, merged)
        return guarded
    return result


_NAVIGATION_FAILURE_CODES = frozenset({
    "NAVIGATION_FAILED",
    "NAVIGATION_TIMEOUT",
    "NAVIGATION_TIMED_OUT",
})
_NAVIGATION_FAILURE_KEYS = (
    "navigationFailure",
    "navigation_failure",
)
_NAVIGATION_URL_KEYS = (
    "url",
    "navigated",
    "finalUrl",
    "final_url",
    "validatedUrl",
    "validatedURL",
    "requestedUrl",
    "requested_url",
)


def _is_chrome_error_url(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower().startswith("chrome-error:")


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _integer_error_code(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
        return int(value.strip())
    return None


def _navigation_failure_details(
    result: Any,
    *,
    requested_url: str | None = None,
) -> dict[str, Any] | None:
    """Normalize runtime navigation failures without losing Chromium evidence.

    New runtimes throw a structured ``NAVIGATION_*`` RPC error.  During a
    rolling desktop/backend upgrade we can also receive the same information as
    ``navigationFailure`` on either the direct result or a nested ``result``.
    Older runtimes may incorrectly report a successful navigation whose final
    document is ``chrome-error://chromewebdata/``; that internal error document
    is terminal failure evidence, never a blank SPA eligible for reload.
    """

    if not isinstance(result, dict):
        return None

    containers = [result]
    nested_result = result.get("result")
    if isinstance(nested_result, dict):
        containers.append(nested_result)

    failure: dict[str, Any] | None = None
    explicit_failure = False
    for container in containers:
        for key in _NAVIGATION_FAILURE_KEYS:
            candidate = container.get(key)
            if isinstance(candidate, dict):
                failure = candidate
                explicit_failure = True
                break
        if failure is not None:
            break

    details_candidates: list[dict[str, Any]] = []
    for container in containers:
        for key in ("__error_details__", "errorDetails", "details"):
            candidate = container.get(key)
            if isinstance(candidate, dict):
                details_candidates.append(candidate)
    if isinstance(failure, dict):
        details_candidates.append(failure)
        for key in ("errorDetails", "details"):
            candidate = failure.get(key)
            if isinstance(candidate, dict):
                details_candidates.append(candidate)

    raw_product_code = _first_present(
        result.get("__error_code__"),
        *(container.get("productErrorCode") for container in containers),
        *((failure or {}).get(key) for key in ("productErrorCode", "code", "errorCode")),
        *(container.get("errorCode") for container in containers),
    )
    normalized_product_code = (
        str(raw_product_code).strip().upper()
        if _integer_error_code(raw_product_code) is None and raw_product_code is not None
        else ""
    )
    if normalized_product_code in _NAVIGATION_FAILURE_CODES:
        explicit_failure = True

    all_urls: list[str] = []
    for container in [*containers, failure or {}, *details_candidates]:
        for key in _NAVIGATION_URL_KEYS:
            value = container.get(key)
            if isinstance(value, str) and value.strip():
                all_urls.append(value.strip())
        tabs = container.get("tabs")
        if isinstance(tabs, list):
            for tab in tabs:
                if isinstance(tab, dict) and tab.get("current"):
                    value = tab.get("url")
                    if isinstance(value, str) and value.strip():
                        all_urls.append(value.strip())

    chrome_error_url = next((url for url in all_urls if _is_chrome_error_url(url)), None)
    if not explicit_failure and chrome_error_url is None:
        return None

    if "TIMEOUT" in normalized_product_code or "TIMED_OUT" in normalized_product_code:
        product_code = "NAVIGATION_TIMEOUT"
    else:
        product_code = "NAVIGATION_FAILED"

    def field(*keys: str) -> Any:
        for container in [failure or {}, *reversed(details_candidates), *reversed(containers)]:
            for key in keys:
                value = container.get(key)
                if value is not None and value != "":
                    return value
        return None

    network_error_code = _first_present(
        field("networkErrorCode", "netErrorCode", "chromiumErrorCode"),
        _integer_error_code(field("errorCode")),
    )
    network_error_code = _integer_error_code(network_error_code)
    error_description = field(
        "errorDescription",
        "error_description",
        "networkErrorDescription",
    )
    raw_error = _first_present(
        result.get("__error__"),
        field("error", "message"),
    )
    normalized_requested_url = _first_present(
        requested_url,
        field("requestedUrl", "requested_url"),
    )
    validated_url = _first_present(
        field("validatedUrl", "validatedURL", "validated_url"),
        chrome_error_url,
    )
    retryable_value = field("retryable")
    retryable = retryable_value if isinstance(retryable_value, bool) else False

    return {
        "errorCode": product_code,
        "networkErrorCode": network_error_code,
        "errorDescription": str(error_description) if error_description is not None else None,
        "requestedUrl": str(normalized_requested_url) if normalized_requested_url else None,
        "validatedUrl": str(validated_url) if validated_url else None,
        "retryable": retryable,
        "message": str(raw_error) if raw_error else None,
    }


def _navigation_failure_error(
    result: Any,
    *,
    requested_url: str | None = None,
) -> str | None:
    failure = _navigation_failure_details(result, requested_url=requested_url)
    if failure is None:
        return None

    description = failure.get("errorDescription")
    message = failure.pop("message", None)
    if not message:
        if description:
            message = f"Navigation failed: {description}"
        else:
            message = "Navigation failed: Chromium opened its internal network error page."
    public_failure = {key: value for key, value in failure.items() if value is not None}
    return tool_error(
        message,
        code=public_failure["errorCode"],
        **public_failure,
        details={
            **public_failure,
            "replanRequired": False,
        },
    )


def _heal_or_error(result, kw):
    """Shared post-action handler for index actions. On a stale-index failure
    (the page changed under us), re-observe the settled page and hand back fresh
    indices instead of burning the turn — but ONLY when the re-observe itself
    succeeds, and with a reason-accurate note (an in-place rewrite means the
    action did NOT register, so the model should retry it). Returns a tool_result
    on heal, a tool_error on any other failure, or None when there was no error."""
    navigation_failure = _navigation_failure_error(result)
    if navigation_failure is not None:
        return navigation_failure
    if not (isinstance(result, dict) and result.get("__error__")):
        return None
    err = result["__error__"]
    error_code = result.get("__error_code__")
    details = result.get("__error_details__")
    if not isinstance(details, dict):
        details = {}
    if not _is_stale_index_error(err, error_code):
        retryable = details.get("retryable")
        return tool_error(
            _enrich_error(err, details),
            code=error_code,
            retryable=retryable,
            details=details,
        )
    observed = _call("observe", {}, guard=False, **kw)
    if isinstance(observed, dict) and observed.get("__error__"):
        return tool_error("Failed to observe again after the page changed: " + _enrich_error(observed["__error__"]))
    import re

    reason_match = re.search(r"\(([^)]+)\)", err if isinstance(err, str) else "")
    reason = str(details.get("reason") or (reason_match.group(1) if reason_match else ""))
    raw_state_changes = details.get("stateChanges")
    if isinstance(raw_state_changes, list):
        state_changes = [
            str(change).strip()
            for change in raw_state_changes
            if str(change).strip()
        ]
    else:
        state_changes = [change.strip() for change in reason.split(",") if change.strip()]
    # Preserve the runtime's ordering while removing duplicates.  The list is
    # model/UI-facing evidence; unlike the prose note it is safe to classify.
    state_changes = list(dict.fromkeys(state_changes))
    tab_transition = "active-tab" in state_changes
    action_superseded = tab_transition and error_code in {
        None,
        "STALE_ELEMENT_REFERENCE",
    }
    if error_code == "BROWSER_DECISION_TOKEN_MISSING":
        note = "The browser decision snapshot is temporarily unavailable, so the action did not execute. A fresh observation was captured; replan from the latest page below."
    elif error_code == "ELEMENT_NOT_FOUND":
        note = "This index is not part of the page snapshot for this turn, so the action did not execute. Choose an index that exists on the latest page below."
    elif error_code == "TAB_NOT_FOUND":
        note = "This tab reference is stale, so the action did not execute. Use a current real tab ID from Open tabs below."
    elif action_superseded:
        note = "The page or tab changed, so the old page action was cancelled. Continue planning directly from the fresh observation below without observing again."
    elif reason in ("dom.documentUpdated", "reload"):
        note = "The page rerendered in place and the previous action may not have taken effect. Select the target again from the latest page below and retry the action."
    else:
        note = "The page state changed and the old action did not execute. Select an element again from the latest state below."
    page_changed = (
        bool(
            set(state_changes).intersection(
                {"active-tab", "document-revision", "page-generation"}
            )
        )
        if state_changes
        else error_code
        not in {"BROWSER_DECISION_TOKEN_MISSING", "ELEMENT_NOT_FOUND"}
    )
    action_result = {
        "executed": False,
        "replan_required": True,
        "code": error_code or "STALE_ELEMENT_REFERENCE",
        "page_changed": page_changed,
        "reason": reason,
        "state_changes": state_changes,
        "note": note,
    }
    payload = {
        "effect": "snapshot-refresh",
        "result": action_result,
        "dom": _observe_text(observed),
    }
    if action_superseded:
        # This marker is wrapper-owned top-level provenance.  Keeping it out of
        # ``result`` prevents page-returned evaluate/CDP objects from forging a
        # neutral recovery outcome in the desktop UI.
        payload["recovery_outcome"] = "superseded_by_page_transition"
    return tool_result(payload)


def _result_with_fresh_observation(payload: dict[str, Any], kw: dict[str, Any]) -> str:
    """Attach the post-action DOM required to safely replan after a barrier."""

    observed = _call("observe", {}, **kw)
    navigation_failure = _navigation_failure_error(observed)
    if navigation_failure is not None:
        return navigation_failure
    if isinstance(observed, dict) and observed.get("__error__"):
        payload = {
            **payload,
            "observe_error": _enrich_error(
                observed["__error__"],
                observed.get("__error_details__"),
            ),
            "replan_required": True,
        }
    else:
        # The action result and its trailing observation are two different
        # points in time. Human-control state belongs to the latter: retaining
        # an action's old captchaState beside a new page DOM produced exactly
        # the misleading "old homepage captcha + new slider page" result.
        human_state_keys = (
            "captchaState",
            "interventionPending",
            "interventionMeta",
        )
        action_result = payload.get("result")
        if isinstance(action_result, dict):
            action_result = {
                key: value
                for key, value in action_result.items()
                if key not in human_state_keys
            }
        fresh_human_state = {
            key: observed[key]
            for key in human_state_keys
            if isinstance(observed, dict) and key in observed
        }
        payload = {
            **payload,
            **({"result": action_result} if isinstance(action_result, dict) else {}),
            **fresh_human_state,
            "effect": "snapshot-refresh",
            "dom": _observe_text(observed),
        }
    return tool_result(payload)


def _result_after_indexed_action(
    payload: dict[str, Any],
    args: dict[str, Any],
    kw: dict[str, Any],
) -> str:
    """Defer observe only for an executor-approved same-snapshot sequence."""

    if args.get("_fan_same_snapshot_continue") is not True:
        return _result_with_fresh_observation(payload, kw)
    action_result = payload.get("result")
    effect = (
        action_result.get("effect")
        if isinstance(action_result, dict)
        else None
    )
    if effect not in {"none", "value-only", "dom-structure"}:
        # Modern runtimes always classify an action. Missing/transition effects
        # are not proof that the selector snapshot survived, so fail closed and
        # return the ordinary fresh observation instead.
        return _result_with_fresh_observation(payload, kw)
    return tool_result(
        {
            **payload,
            "effect": effect,
            "same_snapshot_continue": True,
        }
    )


def _log_llm_dom(result, dom):
    """端到端调试日志:把每次 observe【真正喂给 LLM 决策的 DOM 序列化】+【索引元素全量明细】
    落盘到 <FAN_HOME>/dom-llm-log.jsonl。dom 是 LLM 实际看到的文本(默认 browserUseText);
    elements 带 class/source(enhanced vs dom-document)/几何,用于核对"发送键 [N] 到底是真正
    有几何的 div 还是无几何的空 button"。失败静默(绝不影响主流程)。"""
    try:
        import json, os, datetime
        path = os.path.join(_fan_home_dir(), "dom-llm-log.jsonl")
        els = []
        if isinstance(result, dict):
            for e in (result.get("elements") or []):
                if not isinstance(e, dict):
                    continue
                a = e.get("attributes") or {}
                rect = e.get("rect")
                els.append({
                    "index": e.get("index"),
                    "tag": e.get("tag"),
                    "class": str(a.get("class") or "")[:48],
                    "role": a.get("role") or e.get("role"),
                    "ax_name": a.get("ax_name") or a.get("aria-label"),
                    "source": e.get("source"),
                    "backendNodeId": e.get("backendNodeId"),
                    "hasGeometry": bool(rect) or e.get("x") is not None,
                    "rect": rect,
                    "hasJsClickListener": e.get("hasJsClickListener"),
                })
        rec = {
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "url": result.get("url") if isinstance(result, dict) else None,
            "dom_len": len(dom or ""),
            "element_count": len(els),
            "truncated": result.get("truncated") if isinstance(result, dict) else None,
            "omittedInteractiveCount": result.get("omittedInteractiveCount") if isinstance(result, dict) else None,
            "maxElements": result.get("maxElements") if isinstance(result, dict) else None,
            "dom": dom or "",
            "elements": els,
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        logger.info("[browser_observe] dom-llm-log: %d elements, dom %d chars → %s", len(els), len(dom or ""), path)
    except Exception as ex:  # noqa: BLE001
        try:
            logger.warning("[browser_observe] dom-llm-log failed: %s", ex)
        except Exception:
            pass


def _browser_observe(args, **kw):
    args = args or {}
    result = _call("observe", args, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    dom = _observe_text(result, args.get("dom_format") or args.get("domFormat"))
    # include_recent_events:把 runtime 在 result 里给的 recentEvents(紧凑、体积小,不触 10 万字
    # 阈值)追加到 dom 末尾,救活这个之前只在 schema 注册、handler 从不消费的孤儿参数。
    if args.get("include_recent_events", args.get("includeRecentEvents")):
        dom = _append_recent_events(dom, result)
    _log_llm_dom(result, dom)
    # Default ON: every observe captures a screenshot with the indexed element
    # boxes overlaid, so the brain (a vision model natively, or a text brain via
    # the Qwen vision aux) can map visual controls — especially icon-only buttons
    # with no text label — to a clickable [index]. Callers may still pass
    # include_screenshot/highlight_screenshot = false to opt out.
    want_shot = args.get("include_screenshot", args.get("includeScreenshot", True))
    want_highlight = args.get("highlight_screenshot", args.get("highlightScreenshot", True))
    if want_shot:
        # 永远拍【纯】截图(不注入 DOM,杜绝页面闪框)。需要编号框时在【图片】上用 Python 画
        # (对齐 python_highlights),从不碰活页面。
        # JPEG keeps the same viewport pixels while substantially reducing the
        # base64 payload retained for the model. Quality 90 with 4:4:4 output in
        # _paint_index_boxes keeps small UI text and index labels crisp.
        screenshot = _call(
            "screenshot",
            {
                "format": "jpeg",
                "quality": 90,
                "captureBeyondViewport": False,
                "includeHighlights": False,
            },
            **kw,
        )
        if isinstance(screenshot, dict) and screenshot.get("__error__"):
            logger.warning("[browser_observe] screenshot failed: %s", screenshot["__error__"])
            return tool_result({
                "dom": dom,
                "warnings": [{
                    "code": screenshot.get("__error_code__") or "SCREENSHOT_FAILED",
                    "message": screenshot["__error__"],
                    "details": screenshot.get("__error_details__"),
                }],
            })
        data = screenshot.get("data") if isinstance(screenshot, dict) else None
        if data and bool(want_highlight):
            import base64 as _b64
            elements = result.get("elements") if isinstance(result, dict) else None
            sx, sy, iw, _ih = _observation_viewport(result, kw)
            painted = _paint_index_boxes(
                _b64.b64decode(data),
                elements,
                sx,
                sy,
                iw,
                output_format="JPEG",
            )
            if painted is not None:
                data = _b64.b64encode(painted).decode()
        if data:
            image_format = str(screenshot.get("format") or "jpeg").lower()
            image_mime = "image/jpeg" if image_format in {"jpg", "jpeg"} else f"image/{image_format}"
            logger.info("[browser_observe] screenshot captured: %d b64 chars, highlight=%s", len(data), bool(want_highlight))
            return {
                "_multimodal": True,
                "content": [
                    {"type": "text", "text": dom},
                    {"type": "image_url", "image_url": {"url": f"data:{image_mime};base64," + data}},
                ],
                "text_summary": dom,
                "screenshot": {key: value for key, value in screenshot.items() if key != "data"},
            }
    # 只返回紧凑的 dom(= value.text:snapshot + DOM + AX 三源合一的序列化)。
    # 切勿再把原始 observe value 当 `state` 打包进来——它带着完整 elements 数组 +
    # 4 份重复文本渲染 + 一堆元数据,体积约 30 倍,会顶爆 tool_result_storage.py 的
    # 10 万字阈值、被截成无用预览(2026-06-14 修复)。兄弟动作工具本就只回 _observe_text。
    return tool_result({"dom": dom})


def _browser_search_page(args, **kw):
    pattern = (args.get("pattern") or args.get("query") or "").strip()
    if not pattern:
        return tool_error("pattern required")
    payload = {
        "pattern": pattern,
        "regex": bool(args.get("regex", False)),
        "caseSensitive": bool(args.get("case_sensitive", args.get("caseSensitive", False))),
        "contextChars": args.get("context_chars", args.get("contextChars", 150)),
        "maxResults": args.get("max_results", args.get("maxResults", 25)),
    }
    if args.get("css_scope") or args.get("cssScope"):
        payload["cssScope"] = args.get("css_scope", args.get("cssScope"))
    result = _call("searchPage", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"result": result, "content": result.get("formatted") if isinstance(result, dict) else ""})


def _browser_find_elements(args, **kw):
    selector = (args.get("selector") or "").strip()
    if not selector:
        return tool_error("selector required")
    attributes = args.get("attributes")
    if isinstance(attributes, str):
        attributes = [part.strip() for part in attributes.split(",") if part.strip()]
    payload = {
        "selector": selector,
        "attributes": attributes if isinstance(attributes, list) else None,
        "maxResults": args.get("max_results", args.get("maxResults", 50)),
        "includeText": args.get("include_text", args.get("includeText", True)),
    }
    result = _call("findElements", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"result": result, "content": result.get("formatted") if isinstance(result, dict) else ""})


def _observation_viewport(result, kw):
    return _visual_observation_viewport(result, kw, call=_call)


def _browser_find_visual(args, _fv_attempt=0, **kw):
    deps = VisualFindDependencies(
        call=_call,
        crop_png_region=_crop_png_region,
        debug_dump=_fv_debug_dump,
        dump_composition=_fv_dump_composition,
        enrich_error=_enrich_error,
        find_visual_dir=_find_visual_dir,
        heal_or_error=_heal_or_error,
        observation_viewport=_observation_viewport,
        paint_index_boxes=_paint_index_boxes,
        prune_for_paint=_prune_for_paint,
        result_with_fresh_observation=_result_with_fresh_observation,
        retry=lambda retry_args, attempt, retry_kw: _browser_find_visual(
            retry_args, _fv_attempt=attempt, **retry_kw
        ),
        tool_error=tool_error,
        tool_result=tool_result,
    )
    return _find_visual(args, _fv_attempt=_fv_attempt, deps=deps, **kw)


def _browser_page_content(args, **kw):
    payload = {
        "format": args.get("format", "markdown"),
        "extractLinks": bool(args.get("extract_links", args.get("extractLinks", False))),
        "extractImages": bool(args.get("extract_images", args.get("extractImages", False))),
        "startFromChar": args.get("start_from_char", args.get("startFromChar", 0)),
        "maxChars": args.get("max_chars", args.get("maxChars", 100000)),
        "overlapLines": args.get("overlap_lines", args.get("overlapLines", 5)),
    }
    result = _call("pageContent", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"content": result.get("content") if isinstance(result, dict) else "", "stats": result.get("stats") if isinstance(result, dict) else {}})


def _browser_search(args, **kw):
    query = (args.get("query") or "").strip()
    if not query:
        return tool_error("query required")
    payload = {"query": query, "engine": (args.get("engine") or _configured_search_engine())}
    result = _call("search", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


# NAV-8:空白页检测(对齐 的导航后健康检查)。判定标准是可派生的二元信号——
# body 无可见文字 且 无任何交互元素/媒体 → 视为"未渲染/白屏",而非拍一个内容长度阈值。
# 只在真正一无所有时触发,避免对正常页面误判重载。
_EMPTY_PAGE_JS = (
    "(() => { const b = document.body; if (!b) return true;"
    " if ((b.innerText || '').trim().length > 0) return false;"
    " if (b.querySelector('a,button,input,textarea,select,[role=\"button\"],[role=\"link\"],[contenteditable]')) return false;"
    " if (b.querySelector('img,svg,canvas,video')) return false;"
    " return true; })()"
)


def _browser_page_is_empty(kw):
    try:
        res = _call("evaluateJavaScript", {"code": _EMPTY_PAGE_JS}, **kw)
    except Exception:
        return False
    if (
        not isinstance(res, dict)
        or res.get("__error__")
        or _navigation_failure_details(res) is not None
    ):
        return False
    text = str(res.get("text", res.get("value", ""))).strip().lower()
    return text == "true"


def _browser_navigate(args, **kw):
    url = (args.get("url") or "").strip()
    if not url:
        return tool_error("url required")
    private_url_error = _private_browser_url_error(url)
    if private_url_error:
        return tool_error(private_url_error)
    params = {
        "url": url,
        # Public navigation should return as soon as the requested document is
        # committed, ready and briefly stable. Long-lived/background requests
        # are not part of that usability gate; callers that need them can ask
        # for the stricter `settle` mode explicitly.
        "wait_until": str(args.get("wait_until") or "load"),
    }
    if args.get("wait_timeout_ms") is not None:
        params["wait_timeout_ms"] = int(args["wait_timeout_ms"])
    result = _call("navigate", params, **kw)
    navigation_failure = _navigation_failure_error(result, requested_url=url)
    if navigation_failure is not None:
        return navigation_failure
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    # NAV-8:空白页自愈。SPA 未渲染 / 反爬白屏时 readyState 可能已 complete
    # 但 body 一无所有。等 3s 重测,仍空则 reload,再空则在结果里给明确诊断(而非把白屏当成功)。
    extra = {}
    if args.get("empty_page_recovery", True) and _browser_page_is_empty(kw):
        time.sleep(3.0)
        if _browser_page_is_empty(kw):
            _call("reload", {}, **kw)
            extra["empty_page_reloaded"] = True
            if _browser_page_is_empty(kw):
                extra["warning"] = "The page remained blank after navigation and reload; the SPA may not have rendered or anti-bot measures may be blocking it."
    return _result_with_fresh_observation(
        {"navigated": url, "result": result, **extra},
        kw,
    )


def _browser_click(args, **kw):
    has_index = args.get("index") is not None
    has_coordinates = (
        args.get("coordinate_x") is not None
        and args.get("coordinate_y") is not None
    ) or (args.get("x") is not None and args.get("y") is not None)
    if not has_index and not has_coordinates:
        return tool_error("index or coordinate_x/coordinate_y required")
    payload = {"allowOccluded": bool(args.get("allow_occluded", False))}
    if has_index:
        payload["index"] = args.get("index")
    if has_coordinates:
        payload["coordinateX"] = args.get("coordinate_x", args.get("x"))
        payload["coordinateY"] = args.get("coordinate_y", args.get("y"))
        # CLK-4:模型(qwen3-vl)给的坐标是 0-1000 归一化;标记让 runtime 换算成 CSS 视口像素再 dispatch。
        payload["normalized"] = True
    if args.get("force") is not None:
        payload["force"] = bool(args.get("force"))
    if args.get("session_id"):
        payload["sessionId"] = args.get("session_id")
    if args.get("_fan_same_snapshot_continue") is True:
        payload["preserveSelectorMap"] = True
    expected = args.get("expected") if isinstance(args.get("expected"), dict) else {}
    for source, target in (
        ("expected_role", "role"),
        ("expected_name", "name"),
        ("expected_text", "text"),
        ("expected_tag", "tag"),
    ):
        if args.get(source) is not None:
            expected[target] = args.get(source)
    if expected:
        payload["expected"] = expected
    evidence = args.get("visual_evidence_token", args.get("visualEvidenceToken"))
    if evidence:
        payload["visualEvidenceToken"] = evidence
    result = _call("click", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_after_indexed_action({"result": result}, args, kw)


def _resolve_protected_browser_value(value) -> tuple[str, str | None]:
    """Resolve one collect value ref at the last local execution boundary."""
    if value is None:
        return "", None
    candidate = str(value)
    from tools.transient_values import is_value_ref, resolve_value_ref

    if not is_value_ref(candidate):
        return candidate, None
    resolved = resolve_value_ref(candidate)
    if resolved is None:
        return "", (
            "The collected value reference is unavailable or belongs to another "
            "session. Call collect again instead of guessing the value."
        )
    return resolved, None


def _browser_type(args, **kw):
    if args.get("index") is None:
        return tool_error("index required")
    value_arg = args.get("value_ref") or args.get("text", "")
    raw_text, protected_error = _resolve_protected_browser_value(value_arg)
    if protected_error:
        return tool_error(protected_error)
    if not raw_text:
        return tool_error("text or value_ref required")
    payload = {"index": args.get("index"), "text": raw_text}
    if "clear" in args:
        payload["clear"] = bool(args.get("clear"))
    if args.get("typing_mode") or args.get("typingMode"):
        payload["typingMode"] = args.get("typing_mode", args.get("typingMode"))
    if args.get("delay_ms") is not None or args.get("delayMs") is not None:
        payload["delayMs"] = args.get("delay_ms", args.get("delayMs"))
    if args.get("fast") is not None:
        payload["fast"] = bool(args.get("fast"))
    if args.get("autocomplete_wait") is not None or args.get("autocompleteWait") is not None:
        payload["autocompleteWait"] = bool(args.get("autocomplete_wait", args.get("autocompleteWait")))
    if args.get("autocomplete_wait_ms") is not None or args.get("autocompleteWaitMs") is not None:
        payload["autocompleteWaitMs"] = args.get("autocomplete_wait_ms", args.get("autocompleteWaitMs"))
    if args.get("_fan_same_snapshot_continue") is True:
        payload["preserveSelectorMap"] = True
    result = _call("type", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_after_indexed_action(
        {"result": result, "typed": raw_text},
        args,
        kw,
    )


def _browser_fill_form(args, **kw):
    fields = args.get("fields")
    if not isinstance(fields, list) or not fields:
        return tool_error("fields must be a non-empty array")
    resolved_fields = []
    for field in fields:
        if not isinstance(field, dict) or field.get("index") is None:
            return tool_error("each field requires an index")
        value_arg = field.get("value_ref") or field.get("text", "")
        raw_text, protected_error = _resolve_protected_browser_value(value_arg)
        if protected_error:
            return tool_error(protected_error)
        if not raw_text:
            return tool_error(f"field {field.get('index')} requires text or value_ref")
        resolved = {
            "index": field.get("index"),
            "text": raw_text,
            "clear": field.get("clear", True),
        }
        for source, target in (
            ("typing_mode", "typingMode"),
            ("delay_ms", "delayMs"),
            ("autocomplete_wait", "autocompleteWait"),
            ("autocomplete_wait_ms", "autocompleteWaitMs"),
            ("expected_label", "expectedLabel"),
        ):
            if field.get(source) is not None:
                resolved[target] = field.get(source)
        if isinstance(field.get("expected"), dict):
            resolved["expected"] = field.get("expected")
        resolved_fields.append(resolved)
    result = _call("fillForm", {"fields": resolved_fields}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    if not isinstance(result, dict):
        return tool_result({"result": result})
    observation = result.pop("observation", None)
    payload = {"result": result}
    if isinstance(observation, dict):
        payload["effect"] = "snapshot-refresh"
        payload["dom"] = _observe_text(observation)
    return tool_result(payload)


_FORM_SUBMIT_CLICK_KEYS = frozenset(
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
_FORM_SUBMIT_TYPE_KEYS = frozenset(
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
_FORM_SUBMIT_FIELD_KEYS = frozenset(
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
def _form_submit_autocomplete_intent(
    field: dict[str, Any],
) -> tuple[bool | None, str | None]:
    """Validate autocomplete options and identify a truly dynamic wait."""

    wait = field.get("autocomplete_wait", field.get("autocompleteWait"))
    if wait is not None:
        if not isinstance(wait, bool):
            return None, "autocomplete_wait must be a boolean"
        if wait:
            return True, None
    wait_ms = field.get("autocomplete_wait_ms", field.get("autocompleteWaitMs"))
    if wait_ms is not None:
        if (
            not isinstance(wait_ms, (int, float))
            or isinstance(wait_ms, bool)
            or wait_ms < 0
        ):
            return None, "autocomplete_wait_ms must be a non-negative number"
        if wait_ms > 0:
            return True, None
    return False, None


def _form_submit_fields(
    input_tool_name: str,
    args: dict[str, Any],
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Resolve one public type/fill call into the internal transaction shape."""

    if input_tool_name == "browser_type":
        if set(args).difference(_FORM_SUBMIT_TYPE_KEYS):
            return None, "browser_type contains options unsupported by formSubmit"
        raw_fields = [args]
    elif input_tool_name == "browser_fill_form":
        if set(args) != {"fields"}:
            return None, "browser_fill_form contains options unsupported by formSubmit"
        raw_fields = args.get("fields")
        if not isinstance(raw_fields, list) or not 1 <= len(raw_fields) <= 50:
            return None, "fields must contain between 1 and 50 entries"
    else:
        return None, "form submit transaction requires browser_type or browser_fill_form"

    resolved_fields: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    for field in raw_fields:
        allowed_keys = (
            _FORM_SUBMIT_TYPE_KEYS
            if input_tool_name == "browser_type"
            else _FORM_SUBMIT_FIELD_KEYS
        )
        if not isinstance(field, dict) or set(field).difference(allowed_keys):
            return None, "form field contains options unsupported by formSubmit"
        autocomplete_intent, autocomplete_error = _form_submit_autocomplete_intent(
            field
        )
        if autocomplete_error:
            return None, autocomplete_error
        if autocomplete_intent:
            return None, "autocomplete fields require observation before submit"
        index = field.get("index")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or index <= 0
        ):
            return None, "each field requires an index"
        if index in seen_indices:
            return None, f"form field index {index} is duplicated"
        seen_indices.add(index)
        value_arg = field.get("value_ref") or field.get("text", "")
        raw_text, protected_error = _resolve_protected_browser_value(value_arg)
        if protected_error:
            return None, protected_error
        if not raw_text:
            return None, f"field {field.get('index')} requires text or value_ref"
        resolved: dict[str, Any] = {
            "index": field.get("index"),
            "text": raw_text,
            "clear": field.get("clear", True),
        }
        for source, target in (
            ("typing_mode", "typingMode"),
            ("delay_ms", "delayMs"),
            ("autocomplete_wait", "autocompleteWait"),
            ("autocomplete_wait_ms", "autocompleteWaitMs"),
            ("expected_label", "expectedLabel"),
        ):
            if field.get(source) is not None:
                resolved[target] = field.get(source)
        if field.get("fast") is not None:
            resolved["typingMode"] = "fast" if field.get("fast") else resolved.get(
                "typingMode"
            )
            if resolved.get("typingMode") is None:
                resolved.pop("typingMode", None)
        if isinstance(field.get("expected"), dict):
            resolved["expected"] = field.get("expected")
        resolved_fields.append(resolved)
    return resolved_fields, None


def _form_submit_click(
    args: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Build the indexed click portion accepted by the private runtime RPC."""

    if set(args).difference(_FORM_SUBMIT_CLICK_KEYS):
        return None, "submit click contains options unsupported by formSubmit"
    index = args.get("index")
    if (
        not isinstance(index, int)
        or isinstance(index, bool)
        or index <= 0
    ):
        return None, "submit click requires index"
    if "expected" in args and not isinstance(args.get("expected"), dict):
        return None, "submit expected must be an object"
    allow_occluded = args.get("allow_occluded")
    if "allow_occluded" in args and not isinstance(allow_occluded, bool):
        return None, "submit allow_occluded must be a boolean"
    if allow_occluded is True:
        return None, "formSubmit refuses an occluded submit target"
    payload: dict[str, Any] = {
        "index": index,
        "allowOccluded": False,
    }
    expected = dict(args.get("expected")) if isinstance(args.get("expected"), dict) else {}
    for source, target in (
        ("expected_role", "role"),
        ("expected_name", "name"),
        ("expected_text", "text"),
        ("expected_tag", "tag"),
    ):
        if args.get(source) is not None:
            expected[target] = args.get(source)
    if expected:
        payload["expected"] = expected
    return payload, None


def _form_submit_skipped_result(
    reason: str,
    *,
    code: str = "BROWSER_REPLAN_REQUIRED",
    observation: dict[str, Any] | None = None,
    observation_error: str | None = None,
    effect: str | None = None,
) -> str:
    result = {
        "status": "skipped",
        "executed": False,
        "replan_required": True,
        "code": code,
        "reason": reason,
    }
    payload: dict[str, Any] = {
        "effect": "snapshot-refresh" if isinstance(observation, dict) else (effect or "dom-structure"),
        "result": result,
    }
    if isinstance(observation, dict):
        payload["dom"] = _observe_text(observation)
    if observation_error:
        payload["observe_error"] = observation_error
    return tool_result(payload)


def _form_submit_unknown_result(
    reason: str,
    *,
    code: str,
    details: dict[str, Any] | None = None,
) -> str:
    """Represent an action whose physical completion cannot be determined."""

    return tool_result(
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
                **({"details": details} if isinstance(details, dict) else {}),
            },
        }
    )


def _valid_form_submit_runtime_steps(
    result: dict[str, Any],
    *,
    expected_field_indices: list[int],
    expected_submit_index: int,
) -> bool:
    """Prove the private RPC settled the exact transaction that was requested."""

    fields = result.get("fields")
    submit = result.get("submit")
    if (
        not isinstance(fields, list)
        or len(fields) != len(expected_field_indices)
        or not fields
        or not isinstance(submit, dict)
    ):
        return False
    actual_field_indices: list[int] = []
    for field in fields:
        if not isinstance(field, dict):
            return False
        index = field.get("index")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or index <= 0
            or field.get("status") not in {"completed", "failed"}
        ):
            return False
        actual_field_indices.append(index)
    if (
        len(actual_field_indices) != len(set(actual_field_indices))
        or actual_field_indices != expected_field_indices
    ):
        return False

    if "completedCount" in result:
        completed_count = result.get("completedCount")
        actual_completed_count = sum(
            1 for field in fields if field.get("status") == "completed"
        )
        if (
            not isinstance(completed_count, int)
            or isinstance(completed_count, bool)
            or completed_count != actual_completed_count
        ):
            return False

    submit_index = submit.get("index")
    submit_status = submit.get("status")
    if not (
        isinstance(submit_index, int)
        and not isinstance(submit_index, bool)
        and submit_index == expected_submit_index
        and submit_status in {"completed", "skipped", "failed"}
    ):
        return False

    def consistent_boolean_provenance(key: str) -> tuple[bool, bool | None]:
        values: list[bool] = []
        for source in (result, submit):
            if key not in source:
                continue
            value = source.get(key)
            if not isinstance(value, bool):
                return False, None
            values.append(value)
        if len(set(values)) > 1:
            return False, None
        return True, values[0] if values else None

    before_valid, before_dispatch = consistent_boolean_provenance("beforeDispatch")
    attempted_valid, dispatch_attempted = consistent_boolean_provenance(
        "dispatchAttempted"
    )
    if not before_valid or not attempted_valid:
        return False

    # ``completed`` proves the click crossed its dispatch boundary. ``skipped``
    # proves it did not. ``failed`` is reserved for an attempted or otherwise
    # unknowable dispatch; a proven pre-dispatch failure must be ``skipped``.
    if submit_status == "completed":
        return before_dispatch is not True and dispatch_attempted is not False
    if submit_status == "skipped":
        return before_dispatch is not False and dispatch_attempted is not True
    return before_dispatch is not True and dispatch_attempted is not False


def _browser_form_submit_transaction(
    input_tool_name: str,
    input_args: dict[str, Any],
    click_args: dict[str, Any],
    **kw,
) -> tuple[str, str]:
    """Execute a stable form fill + indexed submit as one private RPC.

    The model-facing protocol remains two ordinary tool calls.  The sequential
    executor invokes this helper once, then settles the two original call ids
    with the returned field and submit results.
    """

    fields, fields_error = _form_submit_fields(input_tool_name, input_args)
    submit, submit_error = _form_submit_click(click_args)
    if (
        fields_error is None
        and submit_error is None
        and fields is not None
        and submit is not None
        and submit["index"] in {field["index"] for field in fields}
    ):
        submit_error = "submit index must be distinct from all form field indices"
    if fields_error or submit_error:
        message = fields_error or submit_error or "invalid form submit transaction"
        first = tool_error(message) if fields_error else tool_result(
            {"effect": "value-only", "result": {"status": "not-executed"}}
        )
        return first, _form_submit_skipped_result(
            message,
            code="INVALID_FORM_SUBMIT_TRANSACTION",
        )

    runtime_result = _call(
        "formSubmit",
        {"fields": fields, "submit": submit},
        **kw,
    )
    if not isinstance(runtime_result, dict):
        reason = (
            "Browser formSubmit returned an invalid result after dispatch may have "
            "begun. Do not retry input or submit blindly; observe and verify first."
        )
        unknown = _form_submit_unknown_result(
            reason,
            code="FORM_SUBMIT_INVALID_RESULT",
        )
        return unknown, unknown
    if runtime_result.get("__error__"):
        message = str(runtime_result.get("__error__") or "Browser formSubmit failed")
        details = runtime_result.get("__error_details__")
        code = str(runtime_result.get("__error_code__") or "FORM_SUBMIT_FAILED")
        details_dict = details if isinstance(details, dict) else None
        unknown_reason = (
            "The form transaction failed with an unknown execution state. Do not "
            "retry input or submit blindly; observe the page and verify what "
            "actually completed."
        )
        field_unknown = _form_submit_unknown_result(
            unknown_reason,
            code=code,
            details=details_dict,
        )
        if details_dict is not None and details_dict.get("beforeDispatch") is True:
            # This provenance is scoped to the irreversible submit boundary. It
            # proves the click did not happen, but fields may already have been
            # written while reaching that boundary and therefore remain unknown.
            return field_unknown, _form_submit_skipped_result(
                message,
                code=code,
            )
        submit_unknown = _form_submit_unknown_result(
            unknown_reason,
            code=code,
            details=details_dict,
        )
        return field_unknown, submit_unknown

    if not _valid_form_submit_runtime_steps(
        runtime_result,
        expected_field_indices=[field["index"] for field in fields],
        expected_submit_index=submit["index"],
    ):
        reason = (
            "Browser formSubmit returned no complete per-step provenance after "
            "dispatch may have begun. Do not retry input or submit blindly; "
            "observe and verify first."
        )
        unknown = _form_submit_unknown_result(
            reason,
            code="FORM_SUBMIT_INVALID_PROVENANCE",
        )
        return unknown, unknown

    field_steps = runtime_result.get("fields")
    field_steps = field_steps if isinstance(field_steps, list) else []
    completed_count = runtime_result.get("completedCount")
    if not isinstance(completed_count, int):
        completed_count = sum(
            1
            for field in field_steps
            if isinstance(field, dict) and field.get("status") == "completed"
        )
    field_failure = next(
        (
            field
            for field in field_steps
            if isinstance(field, dict) and field.get("status") == "failed"
        ),
        None,
    )
    field_result: dict[str, Any] = {
        "status": "completed" if field_failure is None else "failed",
        "completedCount": completed_count,
        "fields": field_steps,
        "executed": True if field_failure is None else None,
    }
    first_payload: dict[str, Any] = {
        "effect": "value-only",
        "result": field_result,
    }
    if field_failure is not None:
        field_code = str(
            field_failure.get("errorCode")
            or runtime_result.get("errorCode")
            or "FORM_FIELD_FAILED"
        )
        first_payload.update(
            {
                "error": str(runtime_result.get("error") or "Form field input failed"),
                "code": field_code,
            }
        )
        field_result.update(
            {
                "execution_state": "unknown",
                "replan_required": True,
                "retryable": False,
                "do_not_retry": True,
            }
        )

    observation = runtime_result.get("observation")
    observation = observation if isinstance(observation, dict) else None
    observation_error = runtime_result.get("observationError")
    observation_error = str(observation_error) if observation_error else None
    submit_step = runtime_result.get("submit")
    submit_step = dict(submit_step) if isinstance(submit_step, dict) else {}
    submit_status = str(submit_step.get("status") or "skipped")
    submit_before_dispatch = submit_step.get("beforeDispatch") is True
    if submit_status == "completed":
        submit_executed: bool | None = True
    elif submit_status == "skipped" or submit_before_dispatch:
        submit_executed = False
    else:
        # A failed native click can mean mousePressed/mouseReleased crossed the
        # irreversible boundary before transport or post-click work failed.
        submit_executed = None
    post_action_error = runtime_result.get("postActionError")
    post_action_error = (
        dict(post_action_error) if isinstance(post_action_error, dict) else None
    )
    observation_blocked = runtime_result.get("observationBlocked")
    observation_blocked = (
        dict(observation_blocked) if isinstance(observation_blocked, dict) else None
    )
    replan_required = (
        bool(runtime_result.get("replanRequired"))
        or post_action_error is not None
        or observation_blocked is not None
        or submit_executed is not True
    )
    submit_result: dict[str, Any] = {
        **submit_step,
        "executed": submit_executed,
        "replan_required": replan_required,
    }
    if submit_executed is None:
        submit_result.update(
            {
                "execution_state": "unknown",
                "retryable": False,
                "do_not_retry": True,
            }
        )
    if replan_required and not submit_result.get("code"):
        submit_result["code"] = str(
            submit_step.get("errorCode")
            or runtime_result.get("errorCode")
            or "BROWSER_REPLAN_REQUIRED"
        )
    if runtime_result.get("error") and not submit_result.get("reason"):
        submit_result["reason"] = str(runtime_result.get("error"))
    if post_action_error is not None:
        submit_result["post_action_error"] = post_action_error
    if observation_blocked is not None:
        submit_result["observation_blocked"] = observation_blocked

    second_payload: dict[str, Any] = {
        "effect": "snapshot-refresh" if observation is not None else str(
            runtime_result.get("effect") or "dom-structure"
        ),
        "result": submit_result,
    }
    if observation is not None:
        second_payload["dom"] = _observe_text(observation)
    if observation_error:
        second_payload["observe_error"] = observation_error
    for key in ("captchaState", "interventionPending", "interventionMeta"):
        if key in runtime_result:
            second_payload[key] = runtime_result[key]
        elif observation is not None and key in observation:
            second_payload[key] = observation[key]
    if submit_status == "failed":
        second_payload["error"] = str(
            runtime_result.get("error")
            or submit_step.get("reason")
            or "Form submit click failed"
        )
        second_payload["code"] = submit_result.get("code") or "FORM_SUBMIT_CLICK_FAILED"

    return tool_result(first_payload), tool_result(second_payload)


def _browser_scroll(args, **kw):
    payload = {"down": args.get("down", True), "pages": args.get("pages", 1)}
    if args.get("index") is not None:
        payload["index"] = args.get("index")
    result = _call("scroll", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_scroll_to_text(args, **kw):
    text = (args.get("text") or args.get("query") or "").strip()
    if not text:
        return tool_error("text required")
    payload = {
        "text": text,
        "exact": bool(args.get("exact", False)),
        "caseSensitive": bool(args.get("case_sensitive", args.get("caseSensitive", False))),
    }
    result = _call("scrollToText", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_back(args, **kw):
    result = _call("back", {}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_forward(args, **kw):
    result = _call("forward", {}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_reload(args, **kw):
    result = _call("reload", {"ignoreCache": bool(args.get("ignore_cache", args.get("ignoreCache", False)))}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_send_keys(args, **kw):
    keys = (args.get("keys") or "").strip()
    if not keys:
        return tool_error("keys required")
    result = _call("sendKeys", {"keys": keys}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_select(args, **kw):
    value_arg = args.get("value_ref") or args.get("text", "")
    text, protected_error = _resolve_protected_browser_value(value_arg)
    if protected_error:
        return tool_error(protected_error)
    if args.get("index") is None or not text:
        return tool_error("index and text/value_ref required")
    payload = {"index": args.get("index"), "text": text}
    if args.get("_fan_same_snapshot_continue") is True:
        payload["preserveSelectorMap"] = True
    result = _call("select", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_after_indexed_action({"result": result}, args, kw)


def _browser_dropdown_options(args, **kw):
    if args.get("index") is None:
        return tool_error("index required")
    result = _call("dropdownOptions", {"index": args.get("index")}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    # Reading a dropdown does not mutate the document or invalidate the
    # selector map. Returning a full trailing observation made a 213-option
    # native select look like a 250KB page result and unnecessarily opened a
    # replan barrier. Keep this contract compact and explicitly read-only.
    return tool_result({"effect": "none", "result": result})


def _browser_wait(args, **kw):
    # NAV-2:默认等待 3s,原 1s 偏短
    result = _call("wait", {"seconds": args.get("seconds", 3)}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_settle(args, **kw):
    payload = {
        "timeoutMs": args.get("timeoutMs", args.get("timeout_ms", 5000)),
        "networkIdleMs": args.get("networkIdleMs", args.get("network_idle_ms", 300)),
    }
    result = _call("settle", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_cdp(args, **kw):
    method = str(args.get("method") or "").strip()
    if not method:
        return tool_error("method required")
    params = args.get("params") or {}
    if not isinstance(params, dict):
        return tool_error("params must be an object")
    # Raw CDP is retained for advanced browser recovery, so protect the CDP
    # navigation/resource-loading variants as well as the Runtime JS variants.
    if method in {"Page.navigate", "Target.createTarget", "Network.loadNetworkResource"}:
        target_url = str(params.get("url") or "").strip()
        private_url_error = _private_browser_url_error(target_url)
        if private_url_error:
            return tool_error(private_url_error)
    # `browser_cdp` is intentionally an expert escape hatch, but Runtime.evaluate
    # and Runtime.callFunctionOn otherwise bypass the two first-class JS tools.
    # Preflight URL literals on those two CDP forms before an in-page fetch can
    # return private-network data directly to the model.
    if method in {"Runtime.evaluate", "Runtime.callFunctionOn"}:
        expression = str(params.get("expression") or params.get("functionDeclaration") or "")
        blocked_url = _expression_private_url(expression)
        if blocked_url:
            return tool_error(
                "Blocked: JavaScript targets a protected credential or metadata URL "
                f"({blocked_url}). This target is not available to browser automation."
            )
    result = _call("cdp", {"method": method, "params": params, "sessionId": args.get("session_id")}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"cdp_result": result}, kw)


def _browser_events(args, **kw):
    result = _call("events", {"limit": args.get("limit", 100)}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"events": result.get("events") if isinstance(result, dict) else result})


def _browser_targets(args, **kw):
    result = _call("targets", {}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"targets": result})


def _browser_target_info(args, **kw):
    payload = _target_payload(args or {}) or {}
    result = _call("targetInfo", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"target": result})


def _browser_new_tab(args, **kw):
    url = (args.get("url") or "").strip()
    target_url = url or "about:blank"
    private_url_error = _private_browser_url_error(target_url)
    if private_url_error:
        return tool_error(private_url_error)
    result = _call("newTab", {"url": target_url}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_switch_tab(args, **kw):
    ref = _tab_ref(args)
    if not ref:
        return tool_error("tab_id required (the tab index shown in the 'Open tabs' list)")
    result = _call("switchTab", {"tabId": ref}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_close_tab(args, **kw):
    ref = _tab_ref(args)
    if not ref:
        return tool_error("tab_id required (the tab index shown in the 'Open tabs' list)")
    result = _call("closeTab", {"tabId": ref}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    payload = {"result": result}
    if isinstance(result, dict) and result.get("closed") is False:
        payload["note"] = "Cannot close this tab because it is the session's only tab. The last tab cannot be closed; do not retry."
    return _result_with_fresh_observation(payload, kw)


def _browser_dialog(args, **kw):
    action = (args.get("action") or "").strip()
    if action not in {"accept", "dismiss"}:
        return tool_error("action must be 'accept' or 'dismiss'")
    result = _call(
        "dialog",
        {"action": action, "promptText": args.get("prompt_text")},
        **kw,
    )
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"dialog": result}, kw)


def _browser_upload(args, **kw):
    files = args.get("value_refs") or args.get("files")
    if isinstance(files, str):
        files = [files]
    path_arg = args.get("value_ref") or args.get("path") or args.get("file")
    path, protected_error = _resolve_protected_browser_value(path_arg)
    if protected_error:
        return tool_error(protected_error)
    resolved_files = []
    for file_arg in files or []:
        resolved, error = _resolve_protected_browser_value(file_arg)
        if error:
            return tool_error(error)
        if resolved:
            resolved_files.append(resolved)
    if args.get("index") is None or not (path or resolved_files):
        return tool_error("index and path/files/value_ref required")
    payload = {
        "index": args.get("index"),
        "path": path,
        "files": resolved_files or None,
    }
    result = _call(
        "upload",
        payload,
        **kw,
    )
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_screenshot(args, **kw):
    capture_beyond = args.get("captureBeyondViewport", args.get("capture_beyond_viewport", False))
    payload = {
        "format": args.get("format", "png"),
        "captureBeyondViewport": bool(capture_beyond or args.get("fullPage") or args.get("full_page")),
    }
    for key in ("index", "quality", "x", "y", "width", "height", "scale", "clip"):
        if key in args:
            payload[key] = args.get(key)
    if "include_highlights" in args or "includeHighlights" in args:
        payload["includeHighlights"] = bool(args.get("include_highlights", args.get("includeHighlights")))
    action = "saveScreenshot" if args.get("path") or args.get("file_name") or args.get("fileName") else "screenshot"
    if args.get("path"):
        payload["path"] = args.get("path")
    if args.get("file_name") or args.get("fileName"):
        payload["fileName"] = args.get("file_name", args.get("fileName"))
    result = _call(
        action,
        payload,
        **kw,
    )
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"screenshot": result})


def _browser_save_pdf(args, **kw):
    payload = {
        "fileName": args.get("file_name", args.get("fileName")),
        "printBackground": bool(args.get("print_background", args.get("printBackground", True))),
        "landscape": bool(args.get("landscape", False)),
        "scale": args.get("scale", 1.0),
        "paperFormat": args.get("paper_format", args.get("paperFormat", "Letter")),
    }
    result = _call("savePdf", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"pdf": result})


def _browser_har(args, **kw):
    args = args or {}
    payload: dict[str, Any] = {}
    if args.get("content_mode") or args.get("contentMode"):
        payload["contentMode"] = args.get("content_mode", args.get("contentMode"))
    if args.get("mode") or args.get("record_har_mode") or args.get("recordHarMode"):
        payload["mode"] = args.get("mode", args.get("record_har_mode", args.get("recordHarMode")))
    if args.get("clear") is not None:
        payload["clear"] = bool(args.get("clear"))
    result = _call("har", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    entry_count = len(result.get("log", {}).get("entries", [])) if isinstance(result, dict) else 0
    return tool_result({"har": result, "entry_count": entry_count})


def _browser_save_har(args, **kw):
    args = args or {}
    path = str(args.get("path") or "").strip()
    if not path:
        return tool_error("path required")
    payload: dict[str, Any] = {"path": path}
    if args.get("content_mode") or args.get("contentMode"):
        payload["contentMode"] = args.get("content_mode", args.get("contentMode"))
    if args.get("mode") or args.get("record_har_mode") or args.get("recordHarMode"):
        payload["mode"] = args.get("mode", args.get("record_har_mode", args.get("recordHarMode")))
    result = _call("saveHar", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"har": result})


def _browser_storage_state(args, **kw):
    args = args or {}
    payload: dict[str, Any] = {}
    if args.get("filter") is not None:
        cookie_filter = _coerce_json_object(args.get("filter"), "filter")
        if cookie_filter is None:
            return tool_error("filter must be an object or a JSON object string")
        payload["filter"] = cookie_filter
    result = _call("storageState", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"storage_state": result})


def _browser_save_storage_state(args, **kw):
    args = args or {}
    path = str(args.get("path") or "").strip()
    if not path:
        return tool_error("path required")
    payload: dict[str, Any] = {"path": path}
    if args.get("filter") is not None:
        cookie_filter = _coerce_json_object(args.get("filter"), "filter")
        if cookie_filter is None:
            return tool_error("filter must be an object or a JSON object string")
        payload["filter"] = cookie_filter
    result = _call("saveStorageState", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"storage_state": result})


def _browser_load_storage_state(args, **kw):
    args = args or {}
    payload: dict[str, Any] = {}
    path = str(args.get("path") or "").strip()
    if path:
        payload["path"] = path
    if args.get("state") is not None or args.get("storageState") is not None:
        state = _coerce_json_object(args.get("state", args.get("storageState")), "state")
        if state is None:
            return tool_error("state/storageState must be an object or a JSON object string")
        payload["state"] = state
    if not payload:
        return tool_error("path or state required")
    result = _call("loadStorageState", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"storage_state": result}, kw)


def _browser_grant_permissions(args, **kw):
    args = args or {}
    permissions = _coerce_string_list(args.get("permissions"))
    if permissions is None:
        return tool_error("permissions must be a list or comma/space-separated string")
    result = _call("grantPermissions", {"permissions": permissions}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"permissions": result}, kw)


def _browser_start_screencast(args, **kw):
    args = args or {}
    payload: dict[str, Any] = {}
    for source, target in (
        ("format", "format"),
        ("quality", "quality"),
        ("max_width", "maxWidth"),
        ("maxWidth", "maxWidth"),
        ("max_height", "maxHeight"),
        ("maxHeight", "maxHeight"),
        ("every_nth_frame", "everyNthFrame"),
        ("everyNthFrame", "everyNthFrame"),
        ("max_frames", "maxFrames"),
        ("maxFrames", "maxFrames"),
    ):
        if args.get(source) is not None:
            payload[target] = args.get(source)
    if args.get("capture_frames") is not None or args.get("captureFrames") is not None:
        payload["captureFrames"] = bool(args.get("capture_frames", args.get("captureFrames")))
    result = _call("startScreencast", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"screencast": result})


def _browser_stop_screencast(args, **kw):
    args = args or {}
    payload = {"includeFrames": bool(args.get("include_frames", args.get("includeFrames", False)))}
    result = _call("stopScreencast", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"screencast": result})


def _browser_set_viewport(args, **kw):
    if args.get("width") is None or args.get("height") is None:
        return tool_error("width and height required")
    payload = {
        "width": args.get("width"),
        "height": args.get("height"),
        "deviceScaleFactor": args.get("deviceScaleFactor", args.get("device_scale_factor", 1)),
        "mobile": bool(args.get("mobile", False)),
    }
    result = _call("setViewport", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_network_config(args, **kw):
    args = args or {}
    has_mutation = any(
        key in args
        for key in (
            "user_agent",
            "userAgent",
            "headers",
            "extra_http_headers",
            "extraHTTPHeaders",
            "clear",
            "clear_headers",
            "clearHeaders",
        )
    )
    if not has_mutation:
        result = _call("networkConfig", {}, **kw)
        if isinstance(result, dict) and result.get("__error__"):
            return tool_error(_enrich_error(result["__error__"]))
        return tool_result({"network": result})
    payload: dict[str, Any] = {}
    if "user_agent" in args or "userAgent" in args:
        payload["userAgent"] = args.get("user_agent", args.get("userAgent"))
    raw_headers = args.get("headers", args.get("extra_http_headers", args.get("extraHTTPHeaders")))
    headers = _coerce_headers(raw_headers)
    if raw_headers is not None and headers is None:
        return tool_error("headers must be an object or a JSON object string")
    if headers is not None:
        payload["headers"] = headers
    if args.get("clear") is not None:
        payload["clear"] = bool(args.get("clear"))
    if args.get("clear_headers") is not None or args.get("clearHeaders") is not None:
        payload["clearHeaders"] = bool(args.get("clear_headers", args.get("clearHeaders")))
    result = _call("setNetworkConfig", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"network": result})


def _browser_url_policy(args, **kw):
    args = args or {}
    has_mutation = any(
        key in args
        for key in (
            "allowed_domains",
            "allowedDomains",
            "prohibited_domains",
            "prohibitedDomains",
            "block_ip_addresses",
            "blockIPAddresses",
            "clear",
        )
    )
    if not has_mutation:
        result = _call("urlPolicy", {}, **kw)
        if isinstance(result, dict) and result.get("__error__"):
            return tool_error(_enrich_error(result["__error__"]))
        return tool_result({"policy": result})
    payload: dict[str, Any] = {}
    if "allowed_domains" in args or "allowedDomains" in args:
        allowed = _coerce_string_list(args.get("allowed_domains", args.get("allowedDomains")))
        if allowed is None:
            return tool_error("allowed_domains must be a list or comma/space-separated string")
        payload["allowedDomains"] = allowed
    if "prohibited_domains" in args or "prohibitedDomains" in args:
        prohibited = _coerce_string_list(args.get("prohibited_domains", args.get("prohibitedDomains")))
        if prohibited is None:
            return tool_error("prohibited_domains must be a list or comma/space-separated string")
        payload["prohibitedDomains"] = prohibited
    if "block_ip_addresses" in args or "blockIPAddresses" in args:
        payload["blockIPAddresses"] = bool(args.get("block_ip_addresses", args.get("blockIPAddresses")))
    if "clear" in args:
        payload["clear"] = bool(args.get("clear"))
    result = _call("setUrlPolicy", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"policy": result})


def _browser_evaluate(args, **kw):
    expression = (args.get("expression") or args.get("page_function") or args.get("pageFunction") or "").strip()
    if not expression:
        return tool_error("expression required")
    blocked_url = _expression_private_url(expression)
    if blocked_url:
        return tool_error(
            "Blocked: JavaScript targets a protected credential or metadata URL "
            f"({blocked_url}). This target is not available to browser automation."
        )
    payload = {
        "expression": expression,
        "args": args.get("args") if isinstance(args.get("args"), list) else [],
    }
    result = _call("evaluate", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation(
        {"result": result, "content": result.get("text") if isinstance(result, dict) else ""},
        kw,
    )


def _browser_evaluate_js(args, **kw):
    code = (args.get("code") or args.get("expression") or args.get("javascript") or "").strip()
    if not code:
        return tool_error("code required")
    blocked_url = _expression_private_url(code)
    if blocked_url:
        return tool_error(
            "Blocked: JavaScript targets a protected credential or metadata URL "
            f"({blocked_url}). This target is not available to browser automation."
        )
    payload = {"code": code}
    if args.get("max_chars") is not None or args.get("maxChars") is not None:
        payload["maxChars"] = args.get("max_chars", args.get("maxChars"))
    result = _call("evaluateJavaScript", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation(
        {
            "result": result,
            "content": result.get("text") if isinstance(result, dict) else "",
            "metadata": result.get("metadata") if isinstance(result, dict) else None,
        },
        kw,
    )


def _browser_mouse(args, **kw):
    # CLK-4:模型坐标 0-1000 归一化;runtime 仅在 x/y 有限时换算(scroll 纯 delta 不受影响)。
    result = _call("mouse", {**(args or {}), "normalized": True}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    # SEC-5:补尾随 observe,与 click/type 等其它交互工具一致——在动作边界刷新 captchaState
    # 并过一次人工接管/审批闸(对齐 BU 每步动作边界的 captcha 闸)。
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_hover(args, **kw):
    if args.get("index") is None:
        return tool_error("index required")
    result = _call("hover", args or {}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    # SEC-5:补尾随 observe(同 _browser_mouse,动作边界刷新 captcha/接管闸)。
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_focus(args, **kw):
    if args.get("index") is None:
        return tool_error("index required")
    result = _call("focus", args or {}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    # SEC-5:补尾随 observe(同 _browser_mouse,动作边界刷新 captcha/接管闸)。
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_drag(args, **kw):
    if args.get("index") is None and args.get("sourceIndex") is None and args.get("source_index") is None:
        return tool_error("index/sourceIndex required")
    # CLK-4:模型给的 toX/toY 是 0-1000 归一化;runtime 仅换算 toX/toY(source/targetIndex 是元素 CSS-px,不碰)。
    result = _call("drag", {**(args or {}), "normalized": True}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return _result_with_fresh_observation({"result": result}, kw)


def _browser_element(args, **kw):
    if args.get("index") is None:
        return tool_error("index required")
    result = _call("element", args or {}, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    payload = {"element": result}
    if str(args.get("operation") or "info").strip().lower() == "evaluate":
        return _result_with_fresh_observation(payload, kw)
    return tool_result(payload)


def _browser_highlight(args, **kw):
    payload: dict[str, Any] = {}
    if args.get("index") is not None:
        payload["index"] = args.get("index")
    if "limit" in args:
        payload["limit"] = args.get("limit")
    if "clear" in args:
        payload["clear"] = bool(args.get("clear"))
    if args.get("color"):
        payload["color"] = args.get("color")
    result = _call("highlight", payload, **kw)
    healed = _heal_or_error(result, kw)
    if healed is not None:
        return healed
    return tool_result({"result": result})


register_electron_browser_tools(
    registry,
    handlers={
        "_browser_observe": _browser_observe,
        "_browser_search_page": _browser_search_page,
        "_browser_find_elements": _browser_find_elements,
        "_browser_find_visual": _browser_find_visual,
        "_browser_page_content": _browser_page_content,
        "_browser_search": _browser_search,
        "_browser_navigate": _browser_navigate,
        "_browser_click": _browser_click,
        "_browser_type": _browser_type,
        "_browser_fill_form": _browser_fill_form,
        "_browser_scroll": _browser_scroll,
        "_browser_scroll_to_text": _browser_scroll_to_text,
        "_browser_back": _browser_back,
        "_browser_forward": _browser_forward,
        "_browser_reload": _browser_reload,
        "_browser_send_keys": _browser_send_keys,
        "_browser_select": _browser_select,
        "_browser_dropdown_options": _browser_dropdown_options,
        "_browser_wait": _browser_wait,
        "_browser_settle": _browser_settle,
        "_browser_cdp": _browser_cdp,
        "_browser_events": _browser_events,
        "_browser_targets": _browser_targets,
        "_browser_target_info": _browser_target_info,
        "_browser_new_tab": _browser_new_tab,
        "_browser_switch_tab": _browser_switch_tab,
        "_browser_close_tab": _browser_close_tab,
        "_browser_dialog": _browser_dialog,
        "_browser_upload": _browser_upload,
        "_browser_screenshot": _browser_screenshot,
        "_browser_save_pdf": _browser_save_pdf,
        "_browser_har": _browser_har,
        "_browser_save_har": _browser_save_har,
        "_browser_storage_state": _browser_storage_state,
        "_browser_save_storage_state": _browser_save_storage_state,
        "_browser_load_storage_state": _browser_load_storage_state,
        "_browser_grant_permissions": _browser_grant_permissions,
        "_browser_start_screencast": _browser_start_screencast,
        "_browser_stop_screencast": _browser_stop_screencast,
        "_browser_set_viewport": _browser_set_viewport,
        "_browser_network_config": _browser_network_config,
        "_browser_url_policy": _browser_url_policy,
        "_browser_evaluate": _browser_evaluate,
        "_browser_evaluate_js": _browser_evaluate_js,
        "_browser_mouse": _browser_mouse,
        "_browser_hover": _browser_hover,
        "_browser_focus": _browser_focus,
        "_browser_drag": _browser_drag,
        "_browser_element": _browser_element,
        "_browser_highlight": _browser_highlight,
    },
    check_fn=_check,
    check_visual_fn=_check_visual,
)
