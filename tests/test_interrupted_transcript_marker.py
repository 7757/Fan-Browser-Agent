from agent.message_sanitization import close_interrupted_tool_sequence


def test_interrupted_tool_sequence_uses_stable_marker_and_reason():
    messages = [{"role": "tool", "content": "{}"}]

    assert close_interrupted_tool_sequence(messages) is True
    assert messages[-1] == {
        "role": "assistant",
        "content": "_[interrupted]_",
        "finish_reason": "interrupted",
    }
