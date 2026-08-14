"""Model-facing tools for the Electron browser program runtime.

The Electron process owns snapshots, browser actions, the Worker, leases, and
the action ledger.  This module is intentionally a thin transport and
serialization boundary: it keeps Fan's existing decision-token contract and
page-observation envelope without exposing the legacy atomic-tool schemas.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
import uuid
from typing import Any

from agent.electron_browser_client import (
    ElectronBrowserClient,
    ElectronBrowserRuntimeError,
)
from tools.electron_browser_context import (
    browser_callbacks as _browser_callbacks,
    current_browser_decision_token,
    refresh_browser_decision_token,
    refresh_browser_observation_token,
)
from tools.electron_browser_serialization import (
    _enrich_error,
    format_observation_for_model,
)
from tools.electron_browser_visual import _paint_index_boxes
from tools.registry import registry, tool_error, tool_result


logger = logging.getLogger(__name__)


_DEFAULT_TIMEOUT_MS = 180_000
_MAX_TIMEOUT_MS = 600_000
_MAX_CODE_BYTES = 64 * 1024
_MAX_PROGRAM_VALUE_REFS = 32
_PROGRAM_VALUE_ALIAS_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
_PROGRAM_VALUE_ALIAS_RE = re.compile(_PROGRAM_VALUE_ALIAS_PATTERN)
_RESERVED_PROGRAM_VALUE_ALIASES = frozenset(
    {"__proto__", "constructor", "prototype"}
)
_RECENT_VERIFICATION_COMPLETION_TTL_S = 120.0
_RUN_STATUS_VALUES = frozenset(
    {
        "completed",
        "needs_replan",
        "needs_human",
        "failed_before_effect",
        "failed_after_effect",
        "unknown_after_effect",
    }
)

_PROGRAM_TOOL_NAME_REPLACEMENTS = (
    ("browser_dropdown_options", "fan.dropdownOptions"),
    ("browser_scroll_to_text", "fan.scrollToText"),
    ("browser_switch_tab", "fan.switchTab"),
    ("browser_fill_form", "fan.fillForm"),
    ("browser_send_keys", "fan.keys"),
    ("browser_close_tab", "fan.closeTab"),
    ("browser_new_tab", "fan.newTab"),
    ("browser_save_pdf", "fan.savePdf"),
    ("browser_screenshot", "fan.saveScreenshot"),
    ("browser_navigate", "fan.navigate"),
    ("browser_observe", "fan.observe"),
    ("browser_select", "fan.select"),
    ("browser_scroll", "fan.scroll"),
    ("browser_settle", "fan.settle"),
    ("browser_upload", "fan.upload"),
    ("browser_reload", "fan.reload"),
    ("browser_forward", "fan.forward"),
    ("browser_search", "fan.search"),
    ("browser_click", "fan.click"),
    ("browser_type", "fan.type"),
    ("browser_hover", "fan.hover"),
    ("browser_focus", "fan.focus"),
    ("browser_drag", "fan.drag"),
    ("browser_back", "fan.back"),
    ("browser_wait", "fan.wait"),
)

_HUMAN_STATE_METADATA_KEYS = (
    "url",
    "title",
    "tabs",
    "documentRevision",
    "document_revision",
    "snapshotGeneration",
    "snapshot_generation",
    "selectorGeneration",
    "selector_generation",
    "controlState",
    "control_state",
    "captchaState",
    "interventionPending",
    "interventionMeta",
    "controlSettling",
    "settlementError",
)

# A behavioural challenge is detected, handed off, and resumed inside one
# browser_run call. Keep a short one-shot receipt so a model that ignores the
# fresh BROWSER_HUMAN_CONTROL_RESUMED snapshot cannot immediately open a second
# generic control prompt for the same completed challenge. Browser calls run on
# the gateway turn thread, matching the callback/decision context below.
_recent_verification_completion = threading.local()


def _client() -> ElectronBrowserClient:
    return ElectronBrowserClient()


def _check() -> bool:
    return _client().available


def _task_id(kw: dict[str, Any]) -> str:
    return str(kw.get("task_id") or "main")


def _desktop_control_id(kw: dict[str, Any]) -> str:
    try:
        from fan_cli.invocation_context import (
            browser_control_lease_for_tool,
            get_current_invocation_session,
        )

        invocation = get_current_invocation_session()
    except Exception:
        return ""
    if invocation is None or invocation.source != "desktop":
        return ""
    turn_control_id = str(getattr(invocation, "control_id", "") or "").strip()
    tool_call_id = str(kw.get("tool_call_id") or "").strip()
    return browser_control_lease_for_tool(turn_control_id, tool_call_id)


def _clear_recent_verification_completion() -> None:
    try:
        delattr(_recent_verification_completion, "receipt")
    except AttributeError:
        pass


def _mark_recent_verification_completion(kw: dict[str, Any]) -> None:
    _recent_verification_completion.receipt = {
        "task_id": _task_id(kw),
        "user_task": str(kw.get("user_task") or ""),
        "completed_at": time.monotonic(),
    }


def _consume_recent_verification_completion(kw: dict[str, Any]) -> bool:
    receipt = getattr(_recent_verification_completion, "receipt", None)
    _clear_recent_verification_completion()
    if not isinstance(receipt, dict):
        return False
    if receipt.get("task_id") != _task_id(kw):
        return False
    receipt_user_task = str(receipt.get("user_task") or "")
    current_user_task = str(kw.get("user_task") or "")
    if receipt_user_task and current_user_task != receipt_user_task:
        return False
    completed_at = receipt.get("completed_at")
    if not isinstance(completed_at, (int, float)):
        return False
    return (time.monotonic() - completed_at) <= (
        _RECENT_VERIFICATION_COMPLETION_TTL_S
    )


def _stable_action_id(action: str, kw: dict[str, Any]) -> str:
    """Derive a retry-stable UUID from the model tool call when available."""

    tool_call_id = str(kw.get("tool_call_id") or "").strip()
    if not tool_call_id:
        return str(uuid.uuid4())
    seed = f"{_task_id(kw)}:{action}:{tool_call_id}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def _runtime_error(exc: ElectronBrowserRuntimeError) -> str:
    from tools.transient_values import redact_active_values

    return tool_error(
        _program_runtime_text(
            redact_active_values(_enrich_error(exc, exc.details))
        ),
        code=exc.code,
        details=redact_active_values(exc.details),
        retryable=exc.details.get("retryable")
        if isinstance(exc.details, dict)
        else None,
    )


def _program_runtime_text(value: Any) -> str:
    """Remove legacy public-tool names from program-interface guidance."""

    text = str(value or "")
    replacements = {
        "Use browser_events to find the completion event's savePath, then read it with read_file.": (
            "Get savePath from the download result returned by the program, then read it with read_file."
        ),
        "用 browser_events 找完成事件里的 savePath 再 read_file": (
            "Get savePath from the download result returned by the program, then read it with read_file."
        ),
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    for old, new in _PROGRAM_TOOL_NAME_REPLACEMENTS:
        text = text.replace(old, new)
    return text


def _program_observation_text(snapshot: dict[str, Any]) -> str:
    """Render the canonical observation without legacy public-tool hints."""

    text = format_observation_for_model(snapshot)
    replacements = {
        "switch with fan.switchTab <tab id>": (
            "inside a browser program use fan.switchTab(<tab id>)"
        ),
        "Call fan.wait, then fan.observe.": (
            "Inside a browser program, call fan.settle() and then fan.observe()."
        ),
        "建议先 fan.wait 再 fan.observe": (
            "Inside a browser program, call fan.settle() and then fan.observe()."
        ),
        "fan.scroll up to reveal": (
            "fan.scroll({up: true, pages: 1})"
        ),
        "fan.scroll down to reveal": (
            "fan.scroll({down: true, pages: 1})"
        ),
    }
    text = _program_runtime_text(text)
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def _snapshot_payload(
    result: Any,
) -> tuple[
    dict[str, Any] | None,
    dict[str, Any],
    dict[str, Any] | None,
    dict[str, Any] | None,
]:
    """Extract an observation, public metadata, private token, and screenshot."""

    if not isinstance(result, dict):
        return None, {}, None, None

    outer = dict(result)
    nested = outer.pop("snapshot", None)
    direct_observation = any(
        key in result
        for key in (
            "browserUseText",
            "browserUseDomTreeText",
            "text",
            "elements",
        )
    )
    if direct_observation:
        snapshot: dict[str, Any] | None = dict(result)
    elif isinstance(nested, dict):
        snapshot = dict(nested)
    else:
        snapshot = None

    raw_screenshot = snapshot.pop("screenshot", None) if snapshot else None
    if raw_screenshot is None:
        raw_screenshot = outer.pop("screenshot", None)
    screenshot = (
        dict(raw_screenshot)
        if isinstance(raw_screenshot, dict)
        else None
    )

    raw_token = snapshot.pop("__fanDecisionToken", None) if snapshot else None
    if raw_token is None:
        raw_token = outer.pop("__fanDecisionToken", None)
    token = raw_token if isinstance(raw_token, dict) else None

    metadata: dict[str, Any] = {}
    for key in (
        "profileId",
        "profile_id",
        "taskSpaceId",
        "task_space_id",
        "pageId",
        "page_id",
        "url",
        "title",
        "tabs",
        "documentRevision",
        "document_revision",
        "snapshotGeneration",
        "snapshot_generation",
        "selectorGeneration",
        "selector_generation",
        "controlState",
        "control_state",
        "captchaState",
        "interventionPending",
        "interventionMeta",
        "controlSettling",
        "settlementError",
    ):
        value = outer.get(key, snapshot.get(key) if snapshot else None)
        if value is not None:
            metadata[key] = value
    from tools.transient_values import redact_active_values

    snapshot = redact_active_values(snapshot)
    metadata = redact_active_values(metadata)
    return snapshot, metadata, token, screenshot


def _resolve_program_value_refs(
    raw_refs: Any,
) -> tuple[dict[str, str] | None, str | None]:
    """Resolve collect refs without putting raw values in model-authored code."""

    if raw_refs is None:
        return {}, None
    if not isinstance(raw_refs, dict):
        return None, tool_error(
            "value_refs must be an object mapping aliases to fan-value:// references",
            code="BROWSER_PROGRAM_VALUE_REFS_INVALID",
        )
    if len(raw_refs) > _MAX_PROGRAM_VALUE_REFS:
        return None, tool_error(
            f"value_refs accepts at most {_MAX_PROGRAM_VALUE_REFS} aliases",
            code="BROWSER_PROGRAM_VALUE_REFS_INVALID",
        )

    from tools.transient_values import is_value_ref, resolve_value_ref

    resolved: dict[str, str] = {}
    unavailable: list[str] = []
    for raw_alias, reference in raw_refs.items():
        alias = str(raw_alias or "")
        if (
            not _PROGRAM_VALUE_ALIAS_RE.fullmatch(alias)
            or alias in _RESERVED_PROGRAM_VALUE_ALIASES
        ):
            return None, tool_error(
                f"value_refs alias is invalid: {alias[:64] or '(empty)'}",
                code="BROWSER_PROGRAM_VALUE_ALIAS_INVALID",
            )
        if not is_value_ref(reference):
            return None, tool_error(
                f"value_refs.{alias} must be an opaque fan-value:// reference",
                code="BROWSER_PROGRAM_VALUE_REF_INVALID",
            )
        value = resolve_value_ref(reference)
        if value is None:
            unavailable.append(alias)
            continue
        resolved[alias] = value

    if unavailable:
        return None, tool_error(
            "One or more protected values are unavailable, expired, or belong "
            "to another session; collect them again. Aliases: "
            + ", ".join(sorted(unavailable)),
            code="BROWSER_PROGRAM_VALUE_REF_UNAVAILABLE",
        )
    return resolved, None


def _bind_observation_token(token: dict[str, Any] | None) -> None:
    if not isinstance(token, dict):
        return
    refresh_browser_decision_token(token)
    refresh_browser_observation_token(token)


def _public_screenshot_metadata(
    screenshot: dict[str, Any],
    *,
    visual_evidence_ref: str | None = None,
) -> dict[str, Any]:
    """Return only model-usable metadata for an attached screenshot.

    A runtime screenshot may carry one opaque coordinate-action reference.
    Expose it under a purpose-specific structure rather than presenting it as
    an image URL or a handle that ``vision_analyze`` can resolve.
    """

    public = {
        key: screenshot[key]
        for key in (
            "format",
            "width",
            "height",
            "clip",
            "clipSource",
            "includeHighlights",
            "indexAnnotations",
            "annotationKind",
            "annotationScope",
        )
        if key in screenshot
    }
    public.update(
        {
            "imageAttached": True,
            "reusableImageSource": False,
            "visionUsage": (
                "Inspect the attached pixels directly. If a separate "
                "vision_analyze call is needed, save a screenshot with a bare "
                "filename and pass the exact path returned by "
                "fan.saveScreenshot."
            ),
        }
    )
    if isinstance(visual_evidence_ref, str) and visual_evidence_ref.strip():
        public["coordinateAction"] = {
            "evidenceRef": visual_evidence_ref,
            "coordinateSpace": {
                "type": "normalized-viewport",
                "minimum": 0,
                "maximum": 1000,
                "origin": "top-left",
                "xDirection": "left-to-right",
                "yDirection": "top-to-bottom",
            },
            "actions": ["click", "drag"],
            "singleUse": True,
            "usage": (
                "Copy evidenceRef to the next browser_run.visual_evidence_ref "
                "and use exactly one fan.clickPoint({x,y}) or "
                "fan.dragPoint({x,y},{x,y}) call."
            ),
        }
    return public


def _annotate_numbered_screenshot(
    screenshot_data: str,
    snapshot: dict[str, Any],
    *,
    image_format: str,
) -> str:
    """Draw snapshot indexes onto a screenshot without mutating the live page."""

    viewport = (
        snapshot.get("viewport")
        if isinstance(snapshot.get("viewport"), dict)
        else {}
    )
    try:
        scroll_x = float(viewport.get("scrollX", 0) or 0)
        scroll_y = float(viewport.get("scrollY", 0) or 0)
        viewport_width = float(viewport.get("width", 0) or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("Browser snapshot viewport metadata is invalid") from exc
    if viewport_width <= 0:
        raise ValueError(
            "Browser snapshot has no viewport width for numbered screenshot annotation"
        )

    try:
        image_bytes = base64.b64decode(screenshot_data, validate=True)
    except Exception as exc:
        raise ValueError("Browser screenshot payload is not valid base64") from exc

    output_format = (
        "JPEG"
        if str(image_format or "").strip().lower() in {"jpg", "jpeg"}
        else "PNG"
    )
    annotated = _paint_index_boxes(
        image_bytes,
        snapshot.get("elements") if isinstance(snapshot.get("elements"), list) else [],
        scroll_x,
        scroll_y,
        viewport_width,
        filter_labels=False,
        output_format=output_format,
    )
    if annotated is None:
        raise RuntimeError(
            "Numbered screenshot annotation requires the packaged vision image support"
        )
    return base64.b64encode(annotated).decode("ascii")


def _call_program(
    action: str,
    *,
    params: dict[str, Any],
    kw: dict[str, Any],
    action_id: str | None = None,
    timeout: float,
) -> Any:
    return _client().call(
        action,
        workbench_id=_task_id(kw),
        params=params,
        action_id=action_id,
        timeout=timeout,
    )


def _read_program_snapshot(kw: dict[str, Any]) -> Any:
    return _call_program(
        "programSnapshot",
        params={
            "scope": "active_page",
            "includeScreenshot": False,
        },
        kw=kw,
        timeout=75.0,
    )


def _human_state(result: Any) -> dict[str, Any]:
    """Extract only runtime-authored handoff metadata, never page content."""

    _snapshot, metadata, _token, _screenshot = _snapshot_payload(result)
    cap = metadata.get("captchaState")
    cap = dict(cap) if isinstance(cap, dict) else None
    if cap is not None and (
        cap.get("documentRevision") is None
        and cap.get("document_revision") is None
    ):
        document_revision = metadata.get("documentRevision")
        if document_revision is None:
            document_revision = metadata.get("document_revision")
        if document_revision is not None:
            cap["documentRevision"] = document_revision
    intervention_meta = metadata.get("interventionMeta")
    intervention_meta = (
        dict(intervention_meta)
        if isinstance(intervention_meta, dict)
        else None
    )
    return {
        "captchaState": cap,
        "interventionPending": bool(metadata.get("interventionPending")),
        "interventionMeta": intervention_meta,
        "controlSettling": bool(metadata.get("controlSettling")),
        "settlementError": (
            dict(metadata["settlementError"])
            if isinstance(metadata.get("settlementError"), dict)
            else None
        ),
        "url": str(metadata.get("url") or ""),
    }


def _merge_human_state(
    primary: dict[str, Any],
    fallback: dict[str, Any],
) -> dict[str, Any]:
    fallback_cap = fallback.get("captchaState")
    primary_cap = primary.get("captchaState")
    cap: dict[str, Any] | None = None
    if isinstance(fallback_cap, dict):
        cap = dict(fallback_cap)
    if isinstance(primary_cap, dict):
        cap = {**(cap or {}), **primary_cap}
    fallback_intervention = fallback.get("interventionMeta")
    primary_intervention = primary.get("interventionMeta")
    intervention_meta: dict[str, Any] | None = None
    if isinstance(fallback_intervention, dict):
        intervention_meta = dict(fallback_intervention)
    if isinstance(primary_intervention, dict):
        intervention_meta = {
            **(intervention_meta or {}),
            **primary_intervention,
        }
    return {
        "captchaState": cap,
        "interventionPending": bool(
            primary.get("interventionPending")
            or fallback.get("interventionPending")
        ),
        "interventionMeta": intervention_meta,
        "controlSettling": bool(
            primary.get("controlSettling")
            or fallback.get("controlSettling")
        ),
        "settlementError": (
            primary.get("settlementError")
            if isinstance(primary.get("settlementError"), dict)
            else fallback.get("settlementError")
            if isinstance(fallback.get("settlementError"), dict)
            else None
        ),
        "url": str(primary.get("url") or fallback.get("url") or ""),
    }


def _captcha_requires_human(cap: Any) -> bool:
    return bool(
        isinstance(cap, dict)
        and cap.get("detected")
        and cap.get("requiresUserInput", True)
    )


def _behavioral_captcha(cap: Any) -> bool:
    if not _captcha_requires_human(cap):
        return False
    kind = str(cap.get("kind") or cap.get("type") or "").strip().casefold()
    return kind == "behavioral"


def _browser_program_boundary_code(public: dict[str, Any]) -> str:
    for key in ("error", "boundary"):
        value = public.get(key)
        if isinstance(value, dict):
            code = str(value.get("code") or "").strip()
            if code:
                return code
    return ""


def _browser_program_needs_verification(public: dict[str, Any]) -> bool:
    if _captcha_requires_human(public.get("captchaState")):
        return True
    return _browser_program_boundary_code(public) == (
        "BROWSER_HUMAN_VERIFICATION_REQUIRED"
    )


def _verification_meta(
    state: dict[str, Any],
    *,
    message: str | None = None,
) -> dict[str, Any]:
    cap = state.get("captchaState")
    cap = cap if isinstance(cap, dict) else {}
    return {
        "kind": "verification",
        "captcha_type": cap.get("type") or cap.get("kind") or "",
        "challenge_id": cap.get("challengeId") or cap.get("challenge_id") or "",
        "document_revision": (
            cap.get("documentRevision")
            if cap.get("documentRevision") is not None
            else cap.get("document_revision")
        ),
        "url": state.get("url") or "",
        "message": (
            str(message or "").strip()
            or "Human verification is required. Complete it in the browser and the agent will continue afterward."
        )[:2_000],
    }


def _control_meta(
    state: dict[str, Any],
    *,
    message: str | None = None,
) -> dict[str, Any]:
    intervention = state.get("interventionMeta")
    intervention = intervention if isinstance(intervention, dict) else {}
    return {
        "kind": "control",
        "url": state.get("url") or "",
        "settling": bool(state.get("controlSettling")),
        "tabKind": str(intervention.get("kind") or ""),
        "anchorTabId": str(intervention.get("anchorTabId") or ""),
        "userTabId": str(intervention.get("userTabId") or ""),
        "interventionId": str(intervention.get("interventionId") or ""),
        "inputKind": str(
            intervention.get("inputKind")
            or intervention.get("kind")
            or ""
        ),
        "interventionTimestamp": intervention.get("timestamp"),
        "message": (
            str(message or "").strip()
            or "This step requires you to operate the browser. When finished, click Continue and the agent will resume from the current page."
        )[:2_000],
    }


def _human_failure_result(
    public: dict[str, Any],
    *,
    code: str,
    message: str,
) -> str:
    """Fail closed without losing an already-settled program's provenance."""

    run_effect = public.get("run_effect")
    effect_occurred = bool(
        isinstance(run_effect, dict) and run_effect.get("occurred") is True
    )
    effect_uncertain = bool(
        isinstance(run_effect, dict) and run_effect.get("uncertain") is True
    )
    failed: dict[str, Any] = {
        "status": (
            "unknown_after_effect"
            if effect_uncertain
            else "failed_after_effect"
            if effect_occurred
            else "failed_before_effect"
        ),
        "error": {
            "code": code,
            "message": message,
        },
        "do_not_retry": True,
        "retryable": False,
    }
    original_cause = public.get("boundary") or public.get("error")
    if isinstance(original_cause, dict):
        failed["cause"] = dict(original_cause)
    elif original_cause:
        failed["cause"] = {"message": str(original_cause)}
    failed["secondary_error"] = dict(failed["error"])
    for key in ("run_id", "run_effect"):
        if key in public:
            failed[key] = public[key]
    return tool_result(failed)


def _resumed_snapshot_result(
    public: dict[str, Any],
    raw_snapshot: Any,
    *,
    interaction_kind: str,
    intervention_id: str = "",
    boundary_code: str = "BROWSER_HUMAN_CONTROL_RESUMED",
    boundary_message: str | None = None,
) -> str:
    snapshot, metadata, token, _screenshot = _snapshot_payload(raw_snapshot)
    if snapshot is None:
        return _human_failure_result(
            public,
            code="BROWSER_HUMAN_RESUME_SNAPSHOT_MISSING",
            message=(
                "Human browser control ended, but Fan could not read the new "
                "page state. The previous browser program must not be replayed."
            ),
        )
    if not isinstance(token, dict):
        return _human_failure_result(
            public,
            code="BROWSER_HUMAN_RESUME_TOKEN_MISSING",
            message=(
                "Human browser control ended, but the fresh page snapshot had "
                "no authoritative decision token. Execution remains stopped."
            ),
        )

    _bind_observation_token(token)
    logger.info(
        "[browser-takeover:%s] fresh_snapshot.bound kind=%s",
        intervention_id or "unknown",
        interaction_kind,
    )
    resumed = dict(public)
    for key in _HUMAN_STATE_METADATA_KEYS:
        resumed.pop(key, None)
    resumed.pop("error", None)
    resumed.pop("boundary", None)
    # A return value produced before the human-only boundary is no longer an
    # authoritative completion signal. The fresh snapshot is the sole basis
    # for the next model decision.
    resumed.pop("value", None)
    resumed.pop("valueProjection", None)
    resumed["status"] = "needs_replan"
    resumed["replan_required"] = True
    resumed["effect"] = "snapshot-refresh"
    resumed["final_snapshot"] = _program_observation_text(snapshot)
    resumed.update(metadata)
    resumed["human_step"] = {
        "kind": interaction_kind,
        "status": "completed",
        "completed": True,
        "authoritative": True,
        **(
            {"verificationCleared": True}
            if interaction_kind == "verification"
            else {}
        ),
    }
    resumed["boundary"] = {
        "code": boundary_code,
        "message": (
            boundary_message
            or (
                "The user completed the human-only browser step. Replan from "
                "this fresh snapshot; do not replay the previous browser "
                "program."
            )
        ),
        "kind": interaction_kind,
    }
    return tool_result(resumed)


def _block_for_human(
    public: dict[str, Any],
    *,
    kw: dict[str, Any],
    initial_state: dict[str, Any],
    prefer_verification: bool,
    message: str | None = None,
) -> str:
    """Wait on the existing gateway callbacks, then return only fresh state."""

    verification_cb, control_cb = _browser_callbacks()
    state = dict(initial_state)
    interaction_kind = "verification" if prefer_verification else "control"
    intervention = state.get("interventionMeta")
    intervention_id = (
        str(intervention.get("interventionId") or "")
        if isinstance(intervention, dict)
        else ""
    )

    while True:
        if interaction_kind == "verification":
            callback = verification_cb
            meta = _verification_meta(state, message=message)
        else:
            callback = control_cb
            meta = _control_meta(state, message=message)

        if callback is None:
            return _human_failure_result(
                public,
                code="BROWSER_HUMAN_CALLBACK_UNAVAILABLE",
                message=(
                    "The browser requires human input, but this session has no "
                    "human-control callback. Execution remains stopped."
                ),
            )
        try:
            answer = callback(meta)
        except Exception:
            return _human_failure_result(
                public,
                code="BROWSER_HUMAN_CALLBACK_FAILED",
                message=(
                    "Human-control callback failed. Execution remains stopped."
                ),
            )

        normalized = answer.strip().casefold() if isinstance(answer, str) else ""
        can_continue = normalized == "continue" or (
            interaction_kind == "verification" and normalized == "auto"
        )
        if not can_continue:
            if normalized == "stop":
                return _human_failure_result(
                    public,
                    code="HUMAN_CONTROL_STOPPED",
                    message="Browser task was stopped by the user.",
                )
            return _human_failure_result(
                public,
                code="BROWSER_HUMAN_RESPONSE_INVALID",
                message=(
                    "Human browser control ended without an explicit continue "
                    "or stop response. Execution remains stopped."
                ),
            )

        if state.get("interventionPending"):
            try:
                acknowledgement = _call_program(
                    "acknowledgeIntervention",
                    params={"restoreAnchor": True},
                    kw=kw,
                    action_id=_stable_action_id(
                        "acknowledgeIntervention",
                        kw,
                    ),
                    timeout=15.0,
                )
            except ElectronBrowserRuntimeError as exc:
                return _human_failure_result(
                    public,
                    code=exc.code or "BROWSER_INTERVENTION_ACK_FAILED",
                    message=(
                        "The user handed browser control back, but Fan could "
                        "not restore the Agent browsing context."
                    ),
                )
            if not isinstance(acknowledgement, dict) or (
                acknowledgement.get("acknowledged") is not True
            ):
                return _human_failure_result(
                    public,
                    code=(
                        "BROWSER_AGENT_ANCHOR_TAB_CLOSED"
                        if isinstance(acknowledgement, dict)
                        and acknowledgement.get("tabClosed") is True
                        else "BROWSER_INTERVENTION_ACK_REJECTED"
                    ),
                    message=(
                        "The Agent working tab was closed during manual "
                        "control; Fan will not guess a replacement tab."
                        if isinstance(acknowledgement, dict)
                        and acknowledgement.get("tabClosed") is True
                        else "Fan could not acknowledge the browser hand-back."
                    ),
                )
            logger.info(
                "[browser-takeover:%s] anchor.restored restored=%s",
                intervention_id or str(acknowledgement.get("interventionId") or "unknown"),
                acknowledgement.get("restored") is True,
            )

        try:
            fresh = _read_program_snapshot(kw)
        except ElectronBrowserRuntimeError as exc:
            return _human_failure_result(
                public,
                code=exc.code or "BROWSER_HUMAN_RESUME_SNAPSHOT_FAILED",
                message=(
                    "Human browser control ended, but Fan could not verify the "
                    "new page state. Execution remains stopped."
                ),
            )

        fresh_state = _human_state(fresh)
        fresh_cap = fresh_state.get("captchaState")
        if _captcha_requires_human(fresh_cap):
            # Clicking Continue before the challenge has actually disappeared
            # must not release the tool call back to the model. Open a fresh
            # blocking verification request instead; each loop iteration
            # requires a new human response and performs no browser action.
            state = fresh_state
            interaction_kind = "verification"
            message = (
                "Web verification is still incomplete. Complete it in the browser, then click Continue."
            )
            continue
        if (
            interaction_kind == "verification"
            and _snapshot_payload(fresh)[0] is not None
        ):
            _mark_recent_verification_completion(kw)
        return _resumed_snapshot_result(
            public,
            fresh,
            interaction_kind=interaction_kind,
            intervention_id=intervention_id,
        )


def _browser_snapshot(args: dict[str, Any] | None, **kw) -> str | dict:
    # Any explicit observation is a new model decision point. A later handoff
    # may therefore describe a genuinely new human-only step.
    _clear_recent_verification_completion()
    args = args or {}
    highlight_screenshot = bool(args.get("highlight_screenshot", False))
    scope = str(args.get("scope") or "active_page").strip()
    if scope != "active_page":
        return tool_error(
            "scope must be 'active_page' in Fan 0.4.0",
            code="BROWSER_SNAPSHOT_SCOPE_UNSUPPORTED",
        )

    try:
        result = _call_program(
            "programSnapshot",
            params={
                "scope": scope,
                "includeScreenshot": bool(
                    args.get("include_screenshot", False)
                    or highlight_screenshot
                ),
            },
            kw=kw,
            timeout=75.0,
        )
    except ElectronBrowserRuntimeError as exc:
        return _runtime_error(exc)

    snapshot, metadata, token, screenshot = _snapshot_payload(result)
    if snapshot is None:
        return tool_error(
            "Electron browser runtime returned no page snapshot",
            code="BROWSER_SNAPSHOT_MISSING",
        )
    _bind_observation_token(token)
    public = {
        "status": "completed",
        "effect": "snapshot-refresh",
        **metadata,
        "snapshot": _program_observation_text(snapshot),
    }
    raw_visual_evidence_ref = (
        screenshot.pop("visualEvidenceToken", None) if screenshot else None
    )
    visual_evidence_ref = (
        raw_visual_evidence_ref
        if (
            isinstance(raw_visual_evidence_ref, str)
            and raw_visual_evidence_ref.strip()
        )
        else None
    )
    screenshot_data = screenshot.pop("data", None) if screenshot else None
    if not isinstance(screenshot_data, str) or not screenshot_data:
        if highlight_screenshot:
            return tool_error(
                "Electron browser runtime returned no screenshot to annotate",
                code="BROWSER_SCREENSHOT_ANNOTATION_UNAVAILABLE",
                retryable=False,
                details={"reason": "numbered-screenshot-missing"},
            )
        return tool_result(public)

    image_format = str(screenshot.get("format") or "jpeg").lower()
    if highlight_screenshot:
        try:
            screenshot_data = _annotate_numbered_screenshot(
                screenshot_data,
                snapshot,
                image_format=image_format,
            )
        except (RuntimeError, ValueError) as exc:
            return tool_error(
                str(exc),
                code="BROWSER_SCREENSHOT_ANNOTATION_UNAVAILABLE",
                retryable=False,
                details={"reason": "numbered-screenshot-annotation-failed"},
            )
        screenshot["indexAnnotations"] = True
        screenshot["annotationKind"] = "numbered-interactive-elements"
        screenshot["annotationScope"] = "visible-viewport"
    image_mime = (
        "image/jpeg"
        if image_format in {"jpg", "jpeg"}
        else f"image/{image_format}"
    )
    public_screenshot = _public_screenshot_metadata(
        screenshot,
        visual_evidence_ref=visual_evidence_ref,
    )
    summary = tool_result(
        {
            **public,
            "screenshot": public_screenshot,
        }
    )
    return {
        "_multimodal": True,
        "content": [
            {"type": "text", "text": summary},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{image_mime};base64,{screenshot_data}",
                },
            },
        ],
        "text_summary": summary,
        "screenshot": public_screenshot,
    }


def _normalize_timeout_ms(value: Any) -> int | None:
    if value is None:
        return _DEFAULT_TIMEOUT_MS
    if isinstance(value, bool):
        return None
    try:
        timeout_ms = int(value)
    except (TypeError, ValueError):
        return None
    if timeout_ms <= 0 or timeout_ms > _MAX_TIMEOUT_MS:
        return None
    return timeout_ms


def _program_transport_failure_is_ambiguous(
    exc: ElectronBrowserRuntimeError,
) -> bool:
    """Whether a failed request may already have reached the program runtime."""

    if exc.code == "RUNTIME_REQUEST_TIMEOUT":
        return True
    if exc.status is not None:
        return False
    details = exc.details if isinstance(exc.details, dict) else {}
    if (
        details.get("beforeDispatch") is True
        and details.get("dispatchAttempted") is False
    ):
        return False
    return bool(
        details.get("transportFailure") is True
        or exc.code is None
        or str(exc.code).startswith("RUNTIME_")
    )


def _transport_status_result(
    *,
    action_id: str,
    kw: dict[str, Any],
    cause: ElectronBrowserRuntimeError,
) -> Any:
    timed_out = cause.code == "RUNTIME_REQUEST_TIMEOUT"
    try:
        status = _call_program(
            "actionStatus",
            params={},
            kw=kw,
            action_id=action_id,
            timeout=5.0,
        )
    except ElectronBrowserRuntimeError:
        status = None

    if isinstance(status, dict) and status.get("status") == "completed":
        completed = status.get("result")
        if (
            isinstance(completed, dict)
            and str(completed.get("status") or "").strip() in _RUN_STATUS_VALUES
        ):
            return completed
    if isinstance(status, dict) and status.get("status") == "failed":
        failure = status.get("error")
        failure = failure if isinstance(failure, dict) else {}
        details = (
            failure.get("errorDetails")
            if isinstance(failure.get("errorDetails"), dict)
            else {}
        )
        if (
            details.get("beforeDispatch") is True
            and details.get("dispatchAttempted") is False
        ):
            return {
                "runId": action_id,
                "status": "failed_before_effect",
                "effect": {
                    "occurred": False,
                    "uncertain": False,
                    "kinds": [],
                },
                "error": {
                    "message": str(
                        failure.get("error")
                        or "Browser program failed before it dispatched."
                    ),
                    "code": failure.get("errorCode")
                    or "BROWSER_PROGRAM_FAILED_BEFORE_DISPATCH",
                    "details": details,
                },
            }
        return {
            "runId": action_id,
            "status": "unknown_after_effect",
            "doNotRetry": True,
            "error": str(
                failure.get("error")
                or (
                    "Browser program failed after the client timed out."
                    if timed_out
                    else "Browser program failed after its transport disconnected."
                )
            ),
            "errorCode": failure.get("errorCode")
            or (
                "BROWSER_PROGRAM_TIMEOUT_STATUS_FAILED"
                if timed_out
                else "BROWSER_PROGRAM_TRANSPORT_STATUS_FAILED"
            ),
            "errorDetails": details,
        }
    if isinstance(status, dict) and status.get("status") in {
        "queued",
        "running",
    }:
        # The host normally times out and terminates its Worker before the
        # client's slightly larger timeout expires. If transport/main-thread
        # trouble leaves it running, stop admission immediately so an
        # already-returned unknown result cannot keep producing new effects.
        try:
            _call_program(
                "programStop",
                params={
                    "reason": (
                        "Browser program client timed out"
                        if timed_out
                        else "Browser program transport failed"
                    ),
                    "code": (
                        "BROWSER_PROGRAM_CLIENT_TIMEOUT"
                        if timed_out
                        else "BROWSER_PROGRAM_TRANSPORT_FAILED"
                    ),
                },
                kw=kw,
                timeout=5.0,
            )
        except ElectronBrowserRuntimeError:
            pass
    return {
        "runId": action_id,
        "status": "unknown_after_effect",
        "doNotRetry": True,
        "error": (
            (
                "Browser program timed out and its execution status is unknown. "
                if timed_out
                else (
                    "The browser program transport failed and its execution "
                    "status is unknown. "
                )
            )
            + "Do not replay it automatically; inspect the final page first."
        ),
        "errorCode": (
            "BROWSER_PROGRAM_TIMEOUT_UNKNOWN"
            if timed_out
            else "BROWSER_PROGRAM_TRANSPORT_UNKNOWN"
        ),
    }


def _browser_run(args: dict[str, Any] | None, **kw) -> str:
    # A new browser transaction supersedes the one-shot verification receipt.
    _clear_recent_verification_completion()
    args = args or {}
    intent = str(args.get("intent") or "").strip()
    code = args.get("code")
    if not intent:
        return tool_error("intent is required", code="BROWSER_PROGRAM_INTENT_REQUIRED")
    if not isinstance(code, str) or not code.strip():
        return tool_error("code is required", code="BROWSER_PROGRAM_CODE_REQUIRED")
    from tools.transient_values import VALUE_REF_PREFIX

    if VALUE_REF_PREFIX in code:
        return tool_error(
            "Do not place a fan-value:// reference inside browser_run code. "
            "Put it in the top-level value_refs object and use "
            'fan.protectedValue("alias") only as the value passed to '
            "fan.type, fan.fillForm, fan.formSubmit, fan.select, fan.dialog, "
            "or fan.upload.",
            code="BROWSER_PROGRAM_VALUE_REF_IN_CODE",
        )
    protected_values, protected_error = _resolve_program_value_refs(
        args.get("value_refs")
    )
    if protected_error:
        return protected_error
    raw_visual_evidence_ref = args.get("visual_evidence_ref")
    if raw_visual_evidence_ref is None:
        visual_evidence_ref = None
    elif (
        isinstance(raw_visual_evidence_ref, str)
        and raw_visual_evidence_ref.strip()
    ):
        visual_evidence_ref = raw_visual_evidence_ref
    else:
        return tool_error(
            "visual_evidence_ref must be a non-empty evidenceRef from the "
            "latest browser_snapshot",
            code="BROWSER_PROGRAM_VISUAL_EVIDENCE_INVALID",
        )
    if len(code.encode("utf-8")) > _MAX_CODE_BYTES:
        return tool_error(
            "code exceeds the 64 KiB browser program limit",
            code="BROWSER_PROGRAM_CODE_TOO_LARGE",
        )
    timeout_ms = _normalize_timeout_ms(args.get("timeout_ms"))
    if timeout_ms is None:
        return tool_error(
            "timeout_ms must be between 1 and 600000",
            code="BROWSER_PROGRAM_TIMEOUT_INVALID",
        )

    action_id = _stable_action_id("programRun", kw)
    params: dict[str, Any] = {
        "intent": intent,
        "code": code,
        "timeoutMs": timeout_ms,
    }
    if protected_values:
        params["_fanProtectedValues"] = protected_values
    if visual_evidence_ref is not None:
        params["_fanVisualEvidenceRef"] = visual_evidence_ref
    decision_token = current_browser_decision_token()
    if isinstance(decision_token, dict):
        params["_fanDecisionToken"] = decision_token
    control_id = _desktop_control_id(kw)
    if control_id:
        params["_fanControlId"] = control_id

    try:
        result = _call_program(
            "programRun",
            params=params,
            kw=kw,
            action_id=action_id,
            timeout=(timeout_ms / 1000.0) + 15.0,
        )
    except ElectronBrowserRuntimeError as exc:
        if not _program_transport_failure_is_ambiguous(exc):
            return _runtime_error(exc)
        result = _transport_status_result(
            action_id=action_id,
            kw=kw,
            cause=exc,
        )

    if not isinstance(result, dict):
        return tool_error(
            "Electron browser runtime returned an invalid program result",
            code="BROWSER_PROGRAM_RESULT_INVALID",
        )

    public = dict(result)
    raw_final = public.pop("finalSnapshot", None)
    if raw_final is None:
        raw_final = public.pop("final_snapshot", None)
    final_snapshot, final_metadata, token, _final_screenshot = _snapshot_payload(
        {"snapshot": raw_final}
        if isinstance(raw_final, dict)
        else {}
    )
    outer_token = public.pop("__fanDecisionToken", None)
    if token is None and isinstance(outer_token, dict):
        token = outer_token
    from tools.transient_values import redact_active_values

    public = redact_active_values(public)
    camel_run_effect = public.pop("runEffect", None)
    if "run_effect" not in public and isinstance(camel_run_effect, dict):
        public["run_effect"] = camel_run_effect
    if "run_effect" not in public and isinstance(public.get("effect"), dict):
        # Electron always reports the program's effect provenance as an
        # object. Normalize it even when needs_human intentionally omits a
        # final snapshot; otherwise the Python replay guard cannot distinguish
        # a passive handoff from a submit that triggered verification.
        public["run_effect"] = public.pop("effect")
    if final_snapshot is not None:
        _bind_observation_token(token)
        public["final_snapshot"] = _program_observation_text(final_snapshot)
        public["effect"] = "snapshot-refresh"
        for key, value in final_metadata.items():
            public.setdefault(key, value)

    status = str(public.get("status") or "").strip()
    if status not in _RUN_STATUS_VALUES:
        return tool_error(
            f"Electron browser runtime returned unknown program status: {status or '(missing)'}",
            code="BROWSER_PROGRAM_STATUS_INVALID",
        )
    public["run_id"] = str(
        public.pop("runId", None)
        or public.get("run_id")
        or action_id
    )
    captcha_state = public.get("captchaState")
    needs_human = status == "needs_human" or _captcha_requires_human(
        captcha_state
    )
    if needs_human:
        verification_boundary = _browser_program_needs_verification(public)
        try:
            handoff = _call_program(
                "programHandoff",
                params={
                    "reason": (
                        "Human browser verification is required"
                        if verification_boundary
                        else "Human browser control is required"
                    ),
                    "instructions": (
                        "Complete the human-only step in the browser, then continue."
                    ),
                },
                kw=kw,
                action_id=_stable_action_id("programRunHandoff", kw),
                timeout=10.0,
            )
        except ElectronBrowserRuntimeError as exc:
            return _human_failure_result(
                public,
                code=exc.code or "BROWSER_PROGRAM_HANDOFF_FAILED",
                message=(
                    "Fan could not release browser control for the human-only "
                    "step. Execution remains stopped."
                ),
            )

        state = _human_state(public)
        state = _merge_human_state(state, _human_state(handoff))
        cap = state.get("captchaState")
        challenge_id = (
            cap.get("challengeId") or cap.get("challenge_id")
            if isinstance(cap, dict)
            else ""
        )
        if not challenge_id or not state.get("url"):
            # Older runtimes omitted challenge metadata from needs_human. Read
            # the current page after relinquishing control and consume only its
            # explicit captcha/url metadata before opening the prompt.
            try:
                current = _read_program_snapshot(kw)
            except ElectronBrowserRuntimeError:
                current = None
            if current is not None:
                state = _merge_human_state(state, _human_state(current))
        return _block_for_human(
            public,
            kw=kw,
            initial_state=state,
            prefer_verification=(
                verification_boundary
                or _captcha_requires_human(state.get("captchaState"))
            ),
        )
    if status in {"needs_replan", "needs_human"} and "error" in public:
        # These are intentional information/control boundaries, not failed tool
        # calls. Preserve the runtime explanation without triggering Fan's
        # generic {"error": ...} failure classifier.
        public["boundary"] = public.pop("error")
    if status == "needs_replan":
        public["replan_required"] = True
    if status == "unknown_after_effect":
        public["do_not_retry"] = True
        public["recovery"] = {
            "required": True,
            "tool": "browser_snapshot",
            "reason": "establish-settled-page-state",
        }
    if status.startswith("failed_") and "error" not in public:
        public["error"] = "Browser program failed."
    return tool_result(public)


def _browser_handoff(args: dict[str, Any] | None, **kw) -> str:
    args = args or {}
    reason = str(args.get("reason") or "").strip()
    if not reason:
        return tool_error("reason is required", code="BROWSER_HANDOFF_REASON_REQUIRED")
    params: dict[str, Any] = {"reason": reason}
    instructions = str(args.get("instructions") or "").strip()
    if instructions:
        params["instructions"] = instructions

    action_id = _stable_action_id("programHandoff", kw)
    if _consume_recent_verification_completion(kw):
        try:
            current = _read_program_snapshot(kw)
        except ElectronBrowserRuntimeError:
            current = None
        current_state = _human_state(current)
        if (
            current is not None
            and not _captcha_requires_human(current_state.get("captchaState"))
            and not current_state.get("interventionPending")
        ):
            return _resumed_snapshot_result(
                {
                    "status": "needs_replan",
                    "reason": reason,
                },
                current,
                interaction_kind="verification",
                boundary_code="BROWSER_REDUNDANT_HANDOFF_SKIPPED",
                boundary_message=(
                    "The previous browser verification is already complete. "
                    "No new human-control prompt was opened. Continue from this "
                    "fresh snapshot."
                ),
            )

    try:
        result = _call_program(
            "programHandoff",
            params=params,
            kw=kw,
            action_id=action_id,
            timeout=10.0,
        )
    except ElectronBrowserRuntimeError as exc:
        return _runtime_error(exc)

    state = _human_state(result)
    try:
        current = _read_program_snapshot(kw)
    except ElectronBrowserRuntimeError:
        current = None
    if current is not None:
        state = _merge_human_state(state, _human_state(current))

    public = {
        "status": "needs_human",
        "run_id": action_id,
        "reason": reason,
    }
    return _block_for_human(
        public,
        kw=kw,
        initial_state=state,
        prefer_verification=_behavioral_captcha(state.get("captchaState")),
        message=instructions or reason,
    )


registry.register(
    name="browser_snapshot",
    toolset="browser_program",
    schema={
        "name": "browser_snapshot",
        "description": (
            "Read the active embedded browser page as a compact numbered Fan "
            "snapshot. This is a passive read and establishes the references "
            "available to the next browser transaction."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["active_page"],
                    "default": "active_page",
                    "description": "Snapshot scope. Fan 0.4.0 supports active_page.",
                },
                "include_screenshot": {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "Attach the visible page pixels to this tool result. "
                        "When the runtime supplies current coordinate evidence, "
                        "screenshot.coordinateAction.evidenceRef authorizes one "
                        "normalized click or drag in the next browser_run. It "
                        "is not a reusable image path."
                    ),
                },
                "highlight_screenshot": {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "Attach a screenshot with every visible numbered "
                        "interactive element outlined and labeled with the "
                        "same [index] used by the snapshot. This implies "
                        "include_screenshot and does not modify the live page."
                    ),
                },
            },
            "additionalProperties": False,
        },
    },
    handler=_browser_snapshot,
    check_fn=_check,
    emoji="🌐",
)

registry.register(
    name="browser_run",
    toolset="browser_program",
    schema={
        "name": "browser_run",
        "description": (
            "Run one browser transaction as an async JavaScript function body. "
            "Every call has a fresh isolated scope; variables from an earlier "
            "browser_run never persist. "
            "The sandbox exposes only the flat fan API; it has no Node, "
            "Electron, filesystem, network, Page, Locator, or Expect objects. "
            "Auto-detected human verification blocks and resumes inside this "
            "call; a returned human_step with status=completed and "
            "verificationCleared=true is authoritative completion evidence for "
            "that verification step."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "intent": {
                    "type": "string",
                    "description": "Concrete goal of this browser transaction.",
                },
                "code": {
                    "type": "string",
                    "maxLength": _MAX_CODE_BYTES,
                    "description": (
                        "Async JavaScript function body. Declare every variable "
                        "in this body. To read structured current-page data, "
                        "first use `const snapshot = await fan.observe()` in "
                        "this same call. Use the injected flat fan.* API and "
                        "return a JSON-serializable value."
                    ),
                },
                "value_refs": {
                    "type": "object",
                    "maxProperties": _MAX_PROGRAM_VALUE_REFS,
                    "additionalProperties": {
                        "type": "string",
                        "pattern": r"^fan-value://",
                    },
                    "description": (
                        "Optional aliases for opaque fan-value:// references "
                        "returned by collect. Keep every reference outside "
                        "code, then use fan.protectedValue(\"alias\") only as "
                        "an input to fan.type, fan.fillForm, fan.formSubmit, "
                        "fan.select, fan.dialog, or fan.upload. Raw values stay "
                        "outside model-authored JavaScript."
                    ),
                },
                "visual_evidence_ref": {
                    "type": "string",
                    "minLength": 1,
                    "description": (
                        "Optional opaque evidenceRef copied exactly from the "
                        "latest browser_snapshot screenshot.coordinateAction. "
                        "Pass it outside code to authorize exactly one "
                        "fan.clickPoint({x,y}) or "
                        "fan.dragPoint({x,y},{x,y}) call with normalized "
                        "viewport coordinates from 0 through 1000."
                    ),
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _MAX_TIMEOUT_MS,
                    "default": _DEFAULT_TIMEOUT_MS,
                    "description": "Whole-transaction timeout in milliseconds.",
                },
            },
            "required": ["intent", "code"],
            "additionalProperties": False,
        },
    },
    handler=_browser_run,
    check_fn=_check,
    emoji="🌐",
    max_result_size_chars=160_000,
)

registry.register(
    name="browser_handoff",
    toolset="browser_program",
    schema={
        "name": "browser_handoff",
        "description": (
            "Stop the active browser transaction and hand the visible browser "
            "to the user only for a new human-only step currently visible, "
            "such as login or permission. Auto-detected verification already "
            "blocks and resumes inside browser_run. After "
            "BROWSER_HUMAN_CONTROL_RESUMED, continue from its fresh snapshot "
            "instead of calling browser_handoff again."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why human browser control is required.",
                },
                "instructions": {
                    "type": "string",
                    "description": "Short instructions shown to the user.",
                },
            },
            "required": ["reason"],
            "additionalProperties": False,
        },
    },
    handler=_browser_handoff,
    check_fn=_check,
    emoji="🌐",
)


__all__ = [
    "_browser_handoff",
    "_browser_run",
    "_browser_snapshot",
]
