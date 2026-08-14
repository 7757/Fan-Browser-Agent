"""Thread-local execution context for Electron browser tools."""

from __future__ import annotations

import threading
from typing import Any


# These values are scoped to one agent turn. Browser tool execution happens on
# the same thread that wires the callbacks and decision snapshot.
_cb_tls = threading.local()
_guard_state = threading.local()
_decision_state = threading.local()


def set_browser_decision_context(token: Any, *, required: bool = True) -> None:
    """Bind internal RPCs for one model-emitted tool to its decision snapshot."""

    _decision_state.active = True
    _decision_state.required = bool(required)
    _decision_state.token = dict(token) if isinstance(token, dict) else None
    _decision_state.observation_token = None


def clear_browser_decision_context() -> None:
    for name in ("active", "required", "token", "observation_token"):
        try:
            delattr(_decision_state, name)
        except AttributeError:
            pass


def current_browser_decision_token() -> dict[str, Any] | None:
    token = getattr(_decision_state, "token", None)
    return dict(token) if isinstance(token, dict) else None


def current_browser_observation_token() -> dict[str, Any] | None:
    """Return the token attached to the latest observe RPC in this tool call."""

    token = getattr(_decision_state, "observation_token", None)
    return dict(token) if isinstance(token, dict) else None


def browser_decision_state() -> tuple[bool, bool, dict[str, Any] | None]:
    """Return the raw decision state consumed by the facade's ``_call``."""

    token = getattr(_decision_state, "token", None)
    return (
        bool(getattr(_decision_state, "active", False)),
        bool(getattr(_decision_state, "required", False)),
        token if isinstance(token, dict) else None,
    )


def refresh_browser_decision_token(token: Any) -> None:
    if isinstance(token, dict) and getattr(_decision_state, "active", False):
        _decision_state.token = token


def refresh_browser_observation_token(token: Any) -> None:
    if isinstance(token, dict) and getattr(_decision_state, "active", False):
        _decision_state.observation_token = token


def set_verification_callback(cb) -> None:
    """Set the blocking human-verification callback for the current turn."""

    _cb_tls.verification = cb


def set_control_callback(cb) -> None:
    """Set the blocking manual-control callback for the current turn."""

    _cb_tls.control = cb


def browser_callbacks():
    return (
        getattr(_cb_tls, "verification", None),
        getattr(_cb_tls, "control", None),
    )


def browser_guard_active() -> bool:
    return bool(getattr(_guard_state, "active", False))


def set_browser_guard_active(active: bool) -> None:
    _guard_state.active = bool(active)
