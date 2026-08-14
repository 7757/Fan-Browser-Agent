from run_agent import AIAgent


def _agent_with_override(override: str) -> AIAgent:
    agent = AIAgent.__new__(AIAgent)
    agent._persist_user_message_idx = 0
    agent._persist_user_message_override = override
    return agent


def test_persistence_override_rewrites_plain_text_user_turn():
    agent = _agent_with_override("用户看到的正文")
    messages = [{"role": "user", "content": "API 专用前缀\n用户看到的正文"}]

    agent._apply_persist_user_message_override(messages)

    assert messages == [{"role": "user", "content": "用户看到的正文"}]


def test_persistence_override_preserves_multimodal_user_turn_for_model_dispatch():
    agent = _agent_with_override("这是什么颜色？[图片附件]")
    multimodal_content = [
        {"type": "text", "text": "这是什么颜色？"},
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,AAAA"},
        },
    ]
    messages = [{"role": "user", "content": multimodal_content}]

    agent._apply_persist_user_message_override(messages)

    assert messages == [{"role": "user", "content": multimodal_content}]
    assert messages[0]["content"] is multimodal_content
