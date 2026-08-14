"""Context-local identity for the Fan invocation currently calling tools.

The desktop gateway can run multiple conversations concurrently in one
process.  A process-wide environment variable therefore cannot be used as a
return address for asynchronous work: another conversation may overwrite it
before a tool runs.  This module keeps the durable conversation key and the
ephemeral desktop session id in a ``ContextVar`` that follows the agent turn
and is copied into tool-executor threads.

Only in-process Fan entrypoints bind this context.  CLI, cron and detached
workers that have no persistent desktop delivery channel intentionally read
``None`` and are not auto-subscribed to asynchronous Kanban notifications.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
import threading
import uuid


@dataclass(frozen=True, slots=True)
class InvocationSession:
    """Return address for the currently executing Fan agent invocation."""

    session_key: str
    ui_session_id: str = ""
    control_id: str = ""
    source: str = "desktop"
    cwd: str = ""


_CURRENT_INVOCATION_SESSION: ContextVar[InvocationSession | None] = ContextVar(
    "fan_current_invocation_session",
    default=None,
)

# Browser control is turn-scoped at the gateway boundary, but every mutating
# model tool needs its own lease identity.  The tool-start callback runs before
# the executor copies the invocation context into its worker, so it records the
# exact lease accepted by Electron under the stable (turn, tool-call) key.
# Keeping this tiny coordination table here avoids process-wide environment
# variables and lets a one-shot beginControl reconciliation choose generation
# 1 without the browser tool guessing which identity won.
_BROWSER_CONTROL_LEASES: dict[tuple[str, str], str] = {}
_BROWSER_CONTROL_LEASES_LOCK = threading.RLock()
_BROWSER_CONTROL_LEASES_LIMIT = 512


def derive_browser_control_lease_id(
    turn_control_id: str,
    tool_call_id: str,
    *,
    generation: int = 0,
) -> str:
    """Return the deterministic control lease for one model tool call."""

    turn_id = str(turn_control_id or "").strip()
    call_id = str(tool_call_id or "").strip()
    if not turn_id or not call_id:
        return turn_id
    seed = f"fan-browser-control:{turn_id}:{call_id}:{max(0, int(generation))}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def record_browser_control_lease(
    turn_control_id: str,
    tool_call_id: str,
    lease_id: str,
) -> None:
    """Publish the exact Electron-accepted lease for the pending tool."""

    key = (str(turn_control_id or "").strip(), str(tool_call_id or "").strip())
    value = str(lease_id or "").strip()
    if not all(key) or not value:
        return
    with _BROWSER_CONTROL_LEASES_LOCK:
        _BROWSER_CONTROL_LEASES[key] = value
        while len(_BROWSER_CONTROL_LEASES) > _BROWSER_CONTROL_LEASES_LIMIT:
            _BROWSER_CONTROL_LEASES.pop(next(iter(_BROWSER_CONTROL_LEASES)))


def browser_control_lease_for_tool(
    turn_control_id: str,
    tool_call_id: str,
) -> str:
    """Read the accepted lease, falling back to its generation-zero identity."""

    turn_id = str(turn_control_id or "").strip()
    call_id = str(tool_call_id or "").strip()
    if not turn_id or not call_id:
        return turn_id
    with _BROWSER_CONTROL_LEASES_LOCK:
        accepted = _BROWSER_CONTROL_LEASES.get((turn_id, call_id))
    return accepted or derive_browser_control_lease_id(turn_id, call_id)


def clear_browser_control_lease(
    turn_control_id: str,
    tool_call_id: str,
) -> None:
    """Forget a completed tool's short-lived lease coordination entry."""

    key = (str(turn_control_id or "").strip(), str(tool_call_id or "").strip())
    if not all(key):
        return
    with _BROWSER_CONTROL_LEASES_LOCK:
        _BROWSER_CONTROL_LEASES.pop(key, None)


def set_current_invocation_session(
    session_key: str,
    *,
    ui_session_id: str = "",
    control_id: str = "",
    source: str = "desktop",
    cwd: str = "",
) -> Token[InvocationSession | None]:
    """Bind a durable return address for the current execution context."""

    return _CURRENT_INVOCATION_SESSION.set(
        InvocationSession(
            session_key=str(session_key or ""),
            ui_session_id=str(ui_session_id or ""),
            control_id=str(control_id or ""),
            source=str(source or "desktop"),
            cwd=str(cwd or ""),
        )
    )


def reset_current_invocation_session(
    token: Token[InvocationSession | None],
) -> None:
    """Restore the invocation identity that preceded ``token``."""

    _CURRENT_INVOCATION_SESSION.reset(token)


def get_current_invocation_session() -> InvocationSession | None:
    """Return the current context-local session, if it has a return channel."""

    current = _CURRENT_INVOCATION_SESSION.get()
    if current is None or not current.session_key:
        return None
    return current
