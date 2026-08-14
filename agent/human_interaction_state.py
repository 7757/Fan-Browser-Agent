"""Session-scoped signal for tool calls that pause for a human response.

The gateway and approval system block synchronously on the same execution
context as the tool that requested input, including copied worker contexts. A
monotonically increasing marker lets the parent tool executor detect that time
passed outside the agent's control and invalidate any browser snapshot the
model used before the pause.
"""

from __future__ import annotations

import threading


_resume_generations: dict[str, int] = {}
_lock = threading.RLock()


def _owner() -> str:
    """Return the session owner propagated into tool worker contexts."""

    try:
        from tools.approval import get_current_session_key

        session_key = get_current_session_key(default="")
        if session_key:
            return f"session:{session_key}"
    except Exception:
        pass
    return f"thread:{threading.get_ident()}"


def current_resume_generation() -> int:
    """Return the current session's human-resume generation."""

    with _lock:
        return _resume_generations.get(_owner(), 0)


def mark_human_interaction_resumed() -> int:
    """Record that a blocking human interaction reached a terminal state."""

    owner = _owner()
    with _lock:
        generation = _resume_generations.get(owner, 0) + 1
        _resume_generations[owner] = generation
        return generation


def clear_human_interaction_state(session_key: str) -> None:
    """Drop one ended session's generation marker."""

    key = str(session_key or "").strip()
    if not key:
        return
    with _lock:
        _resume_generations.pop(f"session:{key}", None)


__all__ = [
    "clear_human_interaction_state",
    "current_resume_generation",
    "mark_human_interaction_resumed",
]
