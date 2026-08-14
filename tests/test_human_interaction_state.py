from __future__ import annotations

import contextvars
import threading

from agent.human_interaction_state import (
    clear_human_interaction_state,
    current_resume_generation,
    mark_human_interaction_resumed,
)
from tools.approval import reset_current_session_key, set_current_session_key


def test_worker_resume_is_visible_to_parent_session_context() -> None:
    session_key = "human-state-worker-test"
    token = set_current_session_key(session_key)
    clear_human_interaction_state(session_key)
    try:
        before = current_resume_generation()
        worker_context = contextvars.copy_context()
        worker = threading.Thread(
            target=lambda: worker_context.run(mark_human_interaction_resumed)
        )
        worker.start()
        worker.join(timeout=1)

        assert not worker.is_alive()
        assert current_resume_generation() == before + 1
    finally:
        clear_human_interaction_state(session_key)
        reset_current_session_key(token)


def test_resume_generations_are_isolated_by_session() -> None:
    first = "human-state-session-a"
    second = "human-state-session-b"
    clear_human_interaction_state(first)
    clear_human_interaction_state(second)
    first_token = set_current_session_key(first)
    try:
        mark_human_interaction_resumed()
        assert current_resume_generation() == 1
    finally:
        reset_current_session_key(first_token)

    second_token = set_current_session_key(second)
    try:
        assert current_resume_generation() == 0
    finally:
        clear_human_interaction_state(first)
        clear_human_interaction_state(second)
        reset_current_session_key(second_token)
