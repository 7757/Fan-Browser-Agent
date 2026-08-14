from __future__ import annotations

import copy
import json

from agent.api_context_projector import TurnStableToolResultProjector
from agent.context_compressor import ContextCompressor


def _assistant(call_id: str, name: str = "read_file", payload: str = "x") -> dict:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps({"path": f"/{call_id}.txt", "payload": payload}),
            },
        }],
    }


def _result(call_id: str, marker: str) -> dict:
    return {
        "role": "tool",
        "name": "read_file",
        "tool_call_id": call_id,
        "content": marker + ":" + (" content" * 300),
    }


def _compressor() -> ContextCompressor:
    return ContextCompressor(
        model="test-model",
        config_context_length=64_000,
        quiet_mode=True,
    )


def test_projection_is_api_only_and_keeps_recent_result_full():
    messages = []
    for index in range(8):
        call_id = f"old-{index}"
        messages.extend((_assistant(call_id), _result(call_id, call_id)))
    messages.append({"role": "user", "content": "continue"})
    original = copy.deepcopy(messages)

    projector = TurnStableToolResultProjector(
        protect_tail_count=3,
        protect_tail_tokens=1_024,
    )
    projected = projector.project(messages, turn_id="turn-1", compressor=_compressor())

    assert messages == original
    assert projected is not messages
    assert len(projected[1]["content"]) < len(messages[1]["content"])
    assert projected[-2]["content"] == messages[-2]["content"]
    assert projected[1]["tool_call_id"] == messages[1]["tool_call_id"]


def test_projection_boundary_is_frozen_during_the_turn():
    messages = []
    for index in range(6):
        call_id = f"history-{index}"
        messages.extend((_assistant(call_id), _result(call_id, call_id)))
    messages.append({"role": "user", "content": "do the task"})
    projector = TurnStableToolResultProjector(
        protect_tail_count=3,
        protect_tail_tokens=1_024,
    )
    compressor = _compressor()

    first = projector.project(messages, turn_id="turn-1", compressor=compressor)
    active_call = "active-call"
    expanded = messages + [_assistant(active_call), _result(active_call, "ACTIVE")]
    second = projector.project(expanded, turn_id="turn-1", compressor=compressor)

    assert first[1]["content"] == second[1]["content"]
    assert second[-1]["content"] == expanded[-1]["content"]
    assert "ACTIVE" in second[-1]["content"]


def test_later_user_turn_can_project_a_result_that_has_left_the_recent_tail():
    messages = []
    for index in range(6):
        call_id = f"history-{index}"
        messages.extend((_assistant(call_id), _result(call_id, call_id)))
    messages.append({"role": "user", "content": "first turn"})
    projector = TurnStableToolResultProjector(
        protect_tail_count=1,
        protect_tail_tokens=1_024,
    )
    compressor = _compressor()
    projector.project(messages, turn_id="turn-1", compressor=compressor)

    active_call = "previous-turn"
    expanded = messages + [
        _assistant(active_call),
        _result(active_call, "PREVIOUS"),
        {"role": "assistant", "content": "done"},
        _assistant("newer-call"),
        _result("newer-call", "NEWER"),
        {"role": "assistant", "content": "newer done"},
        _assistant("newest-call"),
        _result("newest-call", "NEWEST"),
        {"role": "assistant", "content": "newest done"},
        {"role": "user", "content": "next turn"},
    ]
    projected = projector.project(expanded, turn_id="turn-2", compressor=compressor)

    previous = next(
        message for message in projected
        if message.get("tool_call_id") == active_call
    )
    assert len(previous["content"]) < len(_result(active_call, "PREVIOUS")["content"])
