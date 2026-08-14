from __future__ import annotations

import json

from agent.browser_action_outcome import (
    browser_action_failure_footer,
    record_browser_action_outcome,
)


def test_observe_does_not_clear_a_failed_click() -> None:
    state: dict = {}
    failed = record_browser_action_outcome(
        state,
        "browser_click",
        json.dumps({"error": "mouse dispatch failed"}),
        failed=True,
    )

    failed_payload = json.loads(failed)
    assert state["tool"] == "browser_click"
    assert failed_payload["browser_action_status"]["state"] == "failed"

    observed = record_browser_action_outcome(
        state,
        "browser_observe",
        json.dumps({"url": "https://www.v2ex.com/", "text": "current page"}),
        failed=False,
    )

    observed_payload = json.loads(observed)
    assert state["tool"] == "browser_click"
    assert observed_payload["browser_action_status"]["state"] == "unresolved"
    assert "不能作为该动作成功的证据" in observed_payload["browser_action_status"]["message"]
    assert "当前目标未验证完成" in browser_action_failure_footer(state)


def test_successful_retry_of_same_action_group_clears_failure() -> None:
    state = {"tool": "browser_click", "group": "click", "error_preview": "failed"}

    result = record_browser_action_outcome(
        state,
        "browser_find_visual",
        json.dumps({"clicked": True}),
        failed=False,
    )

    assert json.loads(result)["clicked"] is True
    assert state == {}
    assert browser_action_failure_footer(state) == ""
