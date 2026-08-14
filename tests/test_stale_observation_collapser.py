from __future__ import annotations

import copy
import json

from agent.stale_observation_collapser import (
    PAGE_OBSERVATION_BEGIN,
    PAGE_OBSERVATION_END,
    StaleBrowserObservationCollapser,
    release_superseded_observation_images,
)


def _assistant_call(name: str, arguments: dict, call_id: str) -> dict:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
            }
        ],
    }


def _observation(call_id: str, page: str) -> dict:
    return {
        "role": "tool",
        "name": "browser_click",
        "tool_call_id": call_id,
        "content": f"{PAGE_OBSERVATION_BEGIN}\n[page: {page}]\nDOM\n{PAGE_OBSERVATION_END}",
    }


def test_single_observation_preserves_valid_browser_tool_call_arguments():
    messages = [
        _assistant_call(
            "browser_click",
            {"index": 142, "coordinate_x": 500, "coordinate_y": 300, "force": False},
            "click-1",
        ),
        _observation("click-1", "new page"),
    ]
    original = copy.deepcopy(messages)

    transformed = StaleBrowserObservationCollapser().collapse(messages)

    assert transformed is messages
    assert messages == original
    arguments = json.loads(transformed[0]["tool_calls"][0]["function"]["arguments"])
    assert arguments["index"] == 142
    assert arguments["coordinate_x"] == 500
    assert arguments["coordinate_y"] == 300
    assert arguments["force"] is False


def test_old_observations_collapse_without_mutating_any_tool_call_schema():
    messages = [
        _assistant_call("read_file", {"index": 8, "path": "notes.txt"}, "read-1"),
        _observation("obs-1", "old page"),
        _assistant_call("browser_switch_tab", {"tab_id": "t1"}, "switch-1"),
        _observation("switch-1", "new page"),
    ]

    transformed = StaleBrowserObservationCollapser().collapse(messages)

    read_args = json.loads(transformed[0]["tool_calls"][0]["function"]["arguments"])
    switch_args = json.loads(transformed[2]["tool_calls"][0]["function"]["arguments"])
    assert read_args["index"] == 8
    assert switch_args["tab_id"] == "t1"
    assert "superseded=\"true\"" in transformed[1]["content"]
    assert "历史动作:browser_click" in transformed[1]["content"]
    assert "selector map" in transformed[1]["content"]
    assert PAGE_OBSERVATION_BEGIN in transformed[3]["content"]


def test_skipped_browser_call_keeps_required_arguments_without_a_new_observation():
    messages = [
        _assistant_call("browser_click", {"index": 144, "force": False}, "click-skipped"),
        {
            "role": "tool",
            "name": "browser_click",
            "tool_call_id": "click-skipped",
            "content": json.dumps(
                {
                    "status": "skipped",
                    "executed": False,
                    "replan_required": True,
                    "code": "BROWSER_REPLAN_REQUIRED",
                }
            ),
        },
    ]

    transformed = StaleBrowserObservationCollapser().collapse(messages)

    assert transformed is messages
    arguments = json.loads(transformed[0]["tool_calls"][0]["function"]["arguments"])
    assert arguments["index"] == 144
    assert arguments["force"] is False


def test_multiple_successful_clicks_never_become_empty_argument_examples():
    messages = [
        _assistant_call("browser_click", {"index": 370}, "click-1"),
        _observation("click-1", "old page"),
        _assistant_call("browser_click", {"index": 396}, "click-2"),
        _observation("click-2", "new page"),
    ]

    transformed = StaleBrowserObservationCollapser().collapse(messages)

    first_args = json.loads(transformed[0]["tool_calls"][0]["function"]["arguments"])
    second_args = json.loads(transformed[2]["tool_calls"][0]["function"]["arguments"])
    assert first_args == {"index": 370}
    assert second_args == {"index": 396}


def test_collapse_does_not_deepcopy_latest_screenshot_payload():
    old = _observation("obs-1", "old page")
    latest = _observation("obs-2", "new page")
    latest["content"] = [
        {"type": "text", "text": latest["content"]},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,large"}},
    ]
    messages = [old, latest]

    transformed = StaleBrowserObservationCollapser().collapse(messages)

    assert transformed is not messages
    assert transformed[1] is latest
    assert transformed[1]["content"] is latest["content"]
    assert transformed[0] is not old


def test_new_observation_releases_only_superseded_browser_images():
    old = _observation("obs-1", "old page")
    old["content"] = [
        {"type": "text", "text": old["content"]},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,old"}},
    ]
    user_image = {
        "role": "user",
        "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,user"}}],
    }
    messages = [old, user_image]
    incoming = [
        {"type": "text", "text": _observation("obs-2", "new page")["content"]},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,new"}},
    ]

    released = release_superseded_observation_images(messages, incoming)

    assert released == 1
    assert all(part.get("type") != "image_url" for part in messages[0]["content"])
    assert messages[1] is user_image
    assert incoming[1]["image_url"]["url"].endswith("new")
