"""借鉴 #1「错误补救指引」的单元测试:_strip_runtime_error_shell / _enrich_error。

纯函数测试,既可 `pytest tests/test_electron_browser_tool.py`,也可直接
`python tests/test_electron_browser_tool.py` 运行(不依赖 pytest 是否安装)。
"""
import json
import os
import sys
import threading
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tools.electron_browser_tool as browser_tool
from tools.electron_browser_tool import _enrich_error, _strip_runtime_error_shell
from tools.approval import clear_session, reset_current_session_key, set_current_session_key
from tools.transient_values import protect_value


def test_configured_search_engine_defaults_to_baidu():
    from fan_cli.config import DEFAULT_CONFIG

    assert DEFAULT_CONFIG["browser"]["search_engine"] == "baidu"
    assert browser_tool._configured_search_engine({}) == "baidu"
    assert browser_tool._configured_search_engine({"browser": {}}) == "baidu"
    assert browser_tool._configured_search_engine(
        {"browser": {"search_engine": "bing"}}
    ) == "bing"
    assert browser_tool._configured_search_engine(
        {"browser": {"search_engine": "unknown"}}
    ) == "baidu"


def test_browser_allows_loopback_and_private_lan_without_global_ssrf_opt_out():
    with patch.object(browser_tool, "is_always_blocked_url", return_value=False) as floor:
        assert browser_tool._private_browser_url_error("http://localhost:8788/login") is None
        assert browser_tool._private_browser_url_error("http://127.0.0.1:8788/login") is None
        assert browser_tool._private_browser_url_error("http://192.168.1.20/admin") is None

    assert floor.call_count == 3


def test_browser_still_blocks_cloud_metadata_floor():
    with patch.object(browser_tool, "is_always_blocked_url", return_value=True):
        error = browser_tool._private_browser_url_error(
            "http://169.254.169.254/latest/meta-data/"
        )

    assert "cloud metadata" in error


def test_browser_allows_normal_local_file_but_blocks_file_safety_denylist():
    with patch("agent.file_safety.get_read_block_error", return_value=None) as read_guard:
        assert browser_tool._private_browser_url_error("file:///tmp/fan-test/index.html") is None
    assert read_guard.call_args.args[0].endswith("/tmp/fan-test/index.html")

    with patch(
        "agent.file_safety.get_read_block_error",
        return_value="Access denied: credential store",
    ):
        error = browser_tool._private_browser_url_error("file:///Users/test/.fan/auth.json")
    assert "protected credential" in error
    assert "another tool" in error

    with patch(
        "agent.file_safety.get_read_block_error",
        return_value="Access denied: credential store",
    ):
        assert browser_tool._expression_private_url(
            '() => fetch("file:///Users/test/.fan/auth.json")'
        ) == "file:///Users/test/.fan/auth.json"


def test_browser_rejects_remote_file_host():
    error = browser_tool._private_browser_url_error(
        "file://fileserver.example/share/test.html"
    )
    assert "remote/UNC" in error


def test_browser_blocks_generic_local_credentials_but_allows_normal_files():
    blocked = [
        Path.home() / ".ssh" / "id_rsa",
        Path.home() / ".gnupg" / "private-keys-v1.d" / "key",
        Path.home() / ".aws" / "credentials",
        Path.home() / ".npmrc",
        Path.home() / ".netrc",
        Path.home() / ".pypirc",
        Path("/tmp/fan-project/.env.secret"),
        Path("/tmp/fan-project/client-key.pem"),
    ]
    for target in blocked:
        error = browser_tool._private_browser_url_error(target.absolute().as_uri())
        assert error is not None, target
        assert "protected credential" in error

    for target in [
        Path("/tmp/fan-project/index.html"),
        Path("/tmp/fan-project/app.js"),
        Path("/tmp/fan-project/.env.example"),
    ]:
        assert browser_tool._private_browser_url_error(target.absolute().as_uri()) is None


def test_model_visible_page_guard_fails_closed_when_live_state_is_unavailable():
    class BrokenClient:
        def call(self, *_args, **_kwargs):
            raise RuntimeError("runtime unavailable")

    with patch.object(browser_tool, "_client", return_value=BrokenClient()):
        error = browser_tool._active_page_private_url_error({"task_id": "test"})

    assert "could not be safely verified" in error


def test_model_visible_page_guard_allows_verified_loopback_page():
    class LocalPageClient:
        def call(self, *_args, **_kwargs):
            return {
                "tabs": [
                    {"current": True, "url": "http://localhost:8788/#login"}
                ]
            }

    with (
        patch.object(browser_tool, "_client", return_value=LocalPageClient()),
        patch.object(browser_tool, "is_always_blocked_url", return_value=False),
    ):
        assert browser_tool._active_page_private_url_error({"task_id": "test"}) is None


# --- 剥壳:把 HTTP500 外壳 {"ok":false,"error":...} 拆出内层真错误 ---
def test_strip_http500_shell_extracts_inner_error():
    raw = 'Electron browser runtime HTTP 500: {"ok": false, "error": "Element index 5 is not available"}'
    assert _strip_runtime_error_shell(raw) == "Element index 5 is not available"


def test_strip_non_shell_unchanged():
    assert _strip_runtime_error_shell("plain runtime error") == "plain runtime error"


def test_strip_non_json_body_falls_back_to_body():
    raw = "Electron browser runtime HTTP 502: upstream gone"
    assert _strip_runtime_error_shell(raw) == "upstream gone"


# --- 指纹补救:命中追加 [怎么办],未命中只剥壳零噪声 ---
def test_enrich_index_not_available():
    raw = 'Electron browser runtime HTTP 500: {"ok": false, "error": "Element index 5 is not available"}'
    out = _enrich_error(raw)
    assert "Element index 5 is not available" in out  # 干净内层错误保留
    assert "[怎么办]" in out                            # 追加了补救指引
    assert "browser_observe" in out                          # 指向正确下一步
    assert "HTTP 500" not in out                        # JSON 外壳噪声被剥掉


def test_enrich_disabled():
    out = _enrich_error('Electron browser runtime HTTP 500: {"ok":false,"error":"Element index 3 is disabled"}')
    assert "is disabled" in out and "[怎么办]" in out


def test_enrich_timeout():
    out = _enrich_error("Browser runtime action 'click' timed out after 180000ms")
    assert "[怎么办]" in out and ("browser_wait" in out or "browser_settle" in out)


def test_enrich_tab_not_found():
    out = _enrich_error("tab not found: t9")
    assert "[怎么办]" in out and "browser_switch_tab" in out


def test_enrich_arrow_function():
    out = _enrich_error('expression must be an arrow function starting with "("')
    assert "[怎么办]" in out and "箭头函数" in out


def test_enrich_transport_request_failed():
    out = _enrich_error("Electron browser runtime request failed: <urlopen error [Errno 111] Connection refused>")
    assert "[怎么办]" in out and "重启" in out


def test_enrich_runtime_unavailable():
    out = _enrich_error(
        "Electron browser runtime is unavailable; missing ELECTRON_BROWSER_RUNTIME_URL/TOKEN"
    )
    assert "[怎么办]" in out and "重启" in out


def test_enrich_unknown_error_no_noise():
    # 无指纹命中:只剥壳、绝不追加任何"怎么办"
    raw = 'Electron browser runtime HTTP 500: {"ok":false,"error":"some brand new error"}'
    out = _enrich_error(raw)
    assert out == "some brand new error"
    assert "[怎么办]" not in out


def test_enrich_stale_index_skipped():
    # stale-index 由 _heal_or_error 专门重观测处理:_enrich_error 不得追加指引
    stale = "index 5 is stale (dom.documentUpdated) - page changed since last observation"
    out = _enrich_error(stale)
    assert out == stale
    assert "[怎么办]" not in out


def test_enrich_only_one_hint_appended():
    # 同一错误只追加一行(不重复/不叠加)
    out = _enrich_error("Element index 5 is not available")
    assert out.count("[怎么办]") == 1


def _fresh_page_observation():
    return {
        "browserUseText": "[9]<button>Fresh page</button>",
        "title": "Fresh",
        "url": "https://example.test/fresh",
        "tabs": [
            {
                "current": True,
                "stableId": "t1",
                "title": "Fresh",
                "url": "https://example.test/fresh",
            }
        ],
    }


def test_heal_marks_active_tab_transition_as_superseded_with_fresh_dom():
    stale = {
        "__error__": "Browser state changed after the model observed it (active-tab,selector-generation)",
        "__error_code__": "STALE_ELEMENT_REFERENCE",
        "__error_details__": {
            "reason": "active-tab,selector-generation",
            "stateChanges": ["active-tab", "selector-generation"],
        },
    }

    with patch.object(browser_tool, "_call", return_value=_fresh_page_observation()):
        healed = json.loads(browser_tool._heal_or_error(stale, {"task_id": "session-a"}))

    result = healed["result"]
    assert healed["effect"] == "snapshot-refresh"
    assert result["executed"] is False
    assert healed["recovery_outcome"] == "superseded_by_page_transition"
    assert result["state_changes"] == ["active-tab", "selector-generation"]
    assert "无需再次观测" in result["note"]
    assert "<page_observation>" in healed["dom"]


def test_heal_keeps_same_page_selector_refresh_as_a_real_replan():
    stale = {
        "__error__": "Browser state changed after the model observed it (selector-generation)",
        "__error_code__": "STALE_ELEMENT_REFERENCE",
        "__error_details__": {
            "reason": "selector-generation",
            "stateChanges": ["selector-generation"],
        },
    }

    with patch.object(browser_tool, "_call", return_value=_fresh_page_observation()):
        healed = json.loads(browser_tool._heal_or_error(stale, {"task_id": "session-a"}))

    result = healed["result"]
    assert result["state_changes"] == ["selector-generation"]
    assert "recovery_outcome" not in healed
    assert result["page_changed"] is False
    assert "页面已跳转" not in result["note"]
    assert "重新选择元素" in result["note"]


def test_heal_legacy_runtime_falls_back_to_structured_reason_string():
    stale = {
        "__error__": "Browser state changed after the model observed it (active-tab,tab-list-generation)",
        "__error_code__": "STALE_ELEMENT_REFERENCE",
        "__error_details__": {"reason": "active-tab,tab-list-generation"},
    }

    with patch.object(browser_tool, "_call", return_value=_fresh_page_observation()):
        healed = json.loads(browser_tool._heal_or_error(stale, {"task_id": "session-a"}))

    assert healed["result"]["state_changes"] == ["active-tab", "tab-list-generation"]
    assert healed["recovery_outcome"] == "superseded_by_page_transition"


def test_heal_does_not_mask_an_invalid_tab_reference_as_page_takeover():
    stale = {
        "__error__": "tab not found",
        "__error_code__": "TAB_NOT_FOUND",
        "__error_details__": {
            "reason": "active-tab,tab-list-generation",
            "stateChanges": ["active-tab", "tab-list-generation"],
        },
    }

    with patch.object(browser_tool, "_call", return_value=_fresh_page_observation()):
        healed = json.loads(browser_tool._heal_or_error(stale, {"task_id": "session-a"}))

    assert "recovery_outcome" not in healed
    assert "标签引用已经失效" in healed["result"]["note"]


def test_navigate_defaults_to_usable_page_load_without_network_idle():
    calls = []

    def fake_call(action, args, **_kwargs):
        calls.append((action, args))
        if action == "navigate":
            return {
                "navigated": "https://www.baidu.com/",
                "waitUntil": args["wait_until"],
                "loadCompleted": True,
                "pageUsable": True,
                "documentStable": True,
                "networkIdle": False,
                "pendingRequests": 1,
            }
        if action == "evaluateJavaScript":
            return {"value": False}
        if action == "observe":
            return _fresh_page_observation()
        raise AssertionError(action)

    with (
        patch.object(browser_tool, "_call", side_effect=fake_call),
        patch.object(browser_tool.time, "sleep") as sleep,
    ):
        result = json.loads(
            browser_tool._browser_navigate({"url": "https://www.baidu.com/"})
        )

    sleep.assert_not_called()
    assert calls[0] == (
        "navigate",
        {"url": "https://www.baidu.com/", "wait_until": "load"},
    )
    assert [action for action, _args in calls] == [
        "navigate",
        "evaluateJavaScript",
        "observe",
    ]
    assert result["result"]["waitUntil"] == "load"
    assert result["result"]["pageUsable"] is True
    assert result["result"]["networkIdle"] is False
    assert result["result"]["pendingRequests"] == 1


def test_navigate_preserves_explicit_settle_mode():
    calls = []

    def fake_call(action, args, **_kwargs):
        calls.append((action, args))
        if action == "navigate":
            return {
                "navigated": "https://example.test/",
                "waitUntil": args["wait_until"],
                "pageUsable": True,
                "networkIdle": True,
                "settled": True,
            }
        if action == "evaluateJavaScript":
            return {"value": False}
        if action == "observe":
            return _fresh_page_observation()
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        browser_tool._browser_navigate(
            {
                "url": "https://example.test/",
                "wait_until": "settle",
                "wait_timeout_ms": 4321,
            }
        )

    assert calls[0] == (
        "navigate",
        {
            "url": "https://example.test/",
            "wait_until": "settle",
            "wait_timeout_ms": 4321,
        },
    )


def test_navigate_preserves_structured_main_frame_network_failure_without_recovery():
    failure = {
        "__error__": "Navigation failed: ERR_CONNECTION_TIMED_OUT",
        "__error_code__": "NAVIGATION_FAILED",
        "__error_details__": {
            "networkErrorCode": -118,
            "errorDescription": "ERR_CONNECTION_TIMED_OUT",
            "requestedUrl": "https://immigration.example/",
            "validatedURL": "https://immigration.example/",
            "retryable": True,
        },
    }

    with (
        patch.object(browser_tool, "_call", return_value=failure) as runtime_call,
        patch.object(browser_tool.time, "sleep") as sleep,
    ):
        result = json.loads(
            browser_tool._browser_navigate({"url": "https://immigration.example/"})
        )

    runtime_call.assert_called_once()
    sleep.assert_not_called()
    assert result["code"] == "NAVIGATION_FAILED"
    assert result["errorCode"] == "NAVIGATION_FAILED"
    assert result["networkErrorCode"] == -118
    assert result["errorDescription"] == "ERR_CONNECTION_TIMED_OUT"
    assert result["requestedUrl"] == "https://immigration.example/"
    assert result["validatedUrl"] == "https://immigration.example/"
    assert result["retryable"] is True
    assert result["details"]["replanRequired"] is False


def test_navigate_treats_legacy_chrome_error_success_as_terminal_failure():
    false_success = {
        "navigated": "chrome-error://chromewebdata/",
        "requestedUrl": "http://localhost:8788/",
        "finalUrl": "chrome-error://chromewebdata/",
        "loadCompleted": True,
        "documentStable": True,
        "pageUsable": True,
        "networkIdle": True,
        "settled": True,
    }

    with (
        patch.object(browser_tool, "_call", return_value=false_success) as runtime_call,
        patch.object(browser_tool.time, "sleep") as sleep,
    ):
        result = json.loads(browser_tool._browser_navigate({"url": "http://localhost:8788/"}))

    runtime_call.assert_called_once()
    sleep.assert_not_called()
    assert result["errorCode"] == "NAVIGATION_FAILED"
    assert result["requestedUrl"] == "http://localhost:8788/"
    assert result["validatedUrl"] == "chrome-error://chromewebdata/"
    assert result["retryable"] is False
    assert "empty_page_reloaded" not in result


def test_navigate_accepts_nested_navigation_failure_during_runtime_rollout():
    nested_failure = {
        "result": {
            "navigationFailure": {
                "errorCode": "NAVIGATION_TIMEOUT",
                "networkErrorCode": -118,
                "errorDescription": "ERR_CONNECTION_TIMED_OUT",
                "requestedUrl": "https://slow.example/",
                "validatedUrl": "https://slow.example/",
                "retryable": False,
            }
        }
    }

    with patch.object(browser_tool, "_call", return_value=nested_failure) as runtime_call:
        result = json.loads(browser_tool._browser_navigate({"url": "https://slow.example/"}))

    runtime_call.assert_called_once()
    assert result["errorCode"] == "NAVIGATION_TIMEOUT"
    assert result["networkErrorCode"] == -118
    assert result["errorDescription"] == "ERR_CONNECTION_TIMED_OUT"
    assert result["requestedUrl"] == "https://slow.example/"


def test_observe_surfaces_chrome_error_instead_of_empty_spa_snapshot():
    error_page = {
        "browserUseText": "Page appears empty (SPA not loaded?)",
        "url": "chrome-error://chromewebdata/",
        "elements": [],
        "navigationFailure": {
            "networkErrorCode": -102,
            "errorDescription": "ERR_CONNECTION_REFUSED",
            "validatedUrl": "http://localhost:8788/",
        },
    }

    with patch.object(browser_tool, "_call", return_value=error_page) as runtime_call:
        result = json.loads(browser_tool._browser_observe({"include_screenshot": False}))

    runtime_call.assert_called_once()
    assert result["errorCode"] == "NAVIGATION_FAILED"
    assert result["networkErrorCode"] == -102
    assert result["errorDescription"] == "ERR_CONNECTION_REFUSED"
    assert result["validatedUrl"] == "http://localhost:8788/"
    assert "dom" not in result


def test_navigate_keeps_blank_spa_recovery_for_non_error_documents():
    calls = []

    def fake_call(action, _args, **_kwargs):
        calls.append(action)
        if action == "navigate":
            return {
                "navigated": "https://app.example/",
                "requestedUrl": "https://app.example/",
                "finalUrl": "https://app.example/",
                "pageUsable": True,
            }
        if action == "evaluateJavaScript":
            return {"value": True}
        if action == "reload":
            return {"reloaded": True}
        if action == "observe":
            return _fresh_page_observation()
        raise AssertionError(action)

    with (
        patch.object(browser_tool, "_call", side_effect=fake_call),
        patch.object(browser_tool.time, "sleep") as sleep,
    ):
        result = json.loads(browser_tool._browser_navigate({"url": "https://app.example/"}))

    sleep.assert_called_once_with(3.0)
    assert calls == [
        "navigate",
        "evaluateJavaScript",
        "evaluateJavaScript",
        "reload",
        "evaluateJavaScript",
        "observe",
    ]
    assert result["empty_page_reloaded"] is True
    assert "仍为空白" in result["warning"]


def test_enrich_dropdown_error_includes_structured_options():
    out = _enrich_error(
        "option not found",
        {
            "options": [
                {"text": "Blue", "value": "blue", "disabled": False},
                {"text": "Legacy", "value": "legacy", "disabled": True},
                "Red",
            ]
        },
    )
    assert "[可用选项]" in out
    assert "Blue (value=blue)" in out
    assert "Legacy (value=legacy) [disabled]" in out
    assert "Red" in out
    assert "browser_dropdown_options" in out
    assert "再用返回的原文重新调用 browser_select" in out


def test_observe_reuses_atomic_viewport_and_returns_jpeg():
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append(action)
        if action == "observe":
            return {
                "url": "https://example.test/",
                "title": "Example",
                "text": "[1]<button>Go",
                "elements": [],
                "viewport": {"width": 1200, "height": 800, "scrollX": 4, "scrollY": 9},
            }
        if action == "screenshot":
            return {"data": "b3JpZ2luYWw=", "format": "jpeg"}
        raise AssertionError(f"unexpected RPC: {action}")

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        with patch.object(browser_tool, "_paint_index_boxes", return_value=b"painted") as paint:
            result = browser_tool._browser_observe({}, task_id="session-1")

    assert calls == ["observe", "screenshot"]
    assert result["content"][1]["image_url"]["url"] == "data:image/jpeg;base64,cGFpbnRlZA=="
    assert paint.call_args.args[2:5] == (4.0, 9.0, 1200.0)
    assert paint.call_args.kwargs["output_format"] == "JPEG"


def test_observe_ignores_legacy_sensitive_page_flag_and_still_requests_screenshot():
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append(action)
        if action == "observe":
            return {
                "text": '[1]<input type="password" value="secret">',
                "sensitiveVisualRisk": True,
                "viewport": {"width": 1200, "height": 800, "scrollX": 0, "scrollY": 0},
            }
        if action == "screenshot":
            return {"data": "b3JpZ2luYWw=", "format": "jpeg"}
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = browser_tool._browser_observe({}, task_id="session-1")

    assert calls == ["observe", "screenshot"]
    assert result["_multimodal"] is True
    assert "secret" in result["text_summary"]


def test_observe_keeps_dom_and_surfaces_structured_screenshot_degradation():
    def fake_call(action, _args, **_kwargs):
        if action == "observe":
            return {"text": "[1]<button>Continue"}
        if action == "screenshot":
            return {
                "__error__": "capture failed",
                "__error_code__": "SCREENSHOT_CAPTURE_FAILED",
                "__error_details__": {"retryable": True},
            }
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = json.loads(browser_tool._browser_observe({}, task_id="session-1"))

    assert "[1]<button>Continue" in result["dom"]
    assert result["warnings"] == [{
        "code": "SCREENSHOT_CAPTURE_FAILED",
        "message": "capture failed",
        "details": {"retryable": True},
    }]


def test_type_resolves_collect_value_at_runtime_without_redacting_result():
    reference = protect_value("N12345678", field_type="passport")
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append((action, args))
        if action == "type":
            return {"typed": "N12345678"}
        if action == "observe":
            return {"text": '[1]<input value="N12345678">'}
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = browser_tool._browser_type({"index": 1, "value_ref": reference})

    assert calls[0] == ("type", {"index": 1, "text": "N12345678"})
    assert "N12345678" in result


def test_type_rejects_reference_from_another_session():
    reference = protect_value("private", owner="another-session")

    with patch.object(browser_tool, "_call") as call:
        result = browser_tool._browser_type({"index": 1, "value_ref": reference})

    assert "unavailable" in result
    call.assert_not_called()


def test_upload_resolves_collect_file_path_without_redacting_runtime_output():
    reference = protect_value("/Users/test/private-passport.pdf", field_type="file")
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append((action, args))
        if action == "upload":
            return {"path": "/Users/test/private-passport.pdf"}
        if action == "observe":
            return {"text": "Upload complete"}
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = browser_tool._browser_upload({"index": 7, "value_ref": reference})

    assert calls[0][1]["path"] == "/Users/test/private-passport.pdf"
    assert "sensitive" not in calls[0][1]
    assert "/Users/test/private-passport.pdf" in result


def test_select_resolves_collect_reference_without_sensitive_runtime_metadata():
    reference = protect_value("New Zealand", field_type="country")
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append((action, args))
        if action == "select":
            return {"selected": 3, "text": "New Zealand", "value": "NZ"}
        if action == "observe":
            return {"text": '[3]<select value="New Zealand">'}
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = browser_tool._browser_select({"index": 3, "value_ref": reference})

    assert calls[0] == (
        "select",
        {"index": 3, "text": "New Zealand"},
    )
    assert "New Zealand" in result


@pytest.mark.parametrize(
    ("wrapper", "args", "action"),
    [
        (browser_tool._browser_click, {"index": 7}, "click"),
        (browser_tool._browser_select, {"index": 3, "text": "Blue"}, "select"),
        (browser_tool._browser_type, {"index": 5, "text": "Ada"}, "type"),
    ],
)
def test_same_snapshot_indexed_action_preserves_map_and_defers_observation(
    wrapper,
    args,
    action,
):
    calls = []

    def fake_call(actual_action, payload, **_kwargs):
        calls.append((actual_action, payload))
        if actual_action == "observe":
            raise AssertionError("intermediate same-snapshot action must not observe")
        return {"effect": "value-only" if actual_action == "type" else "dom-structure", "ok": True}

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = json.loads(
            wrapper({**args, "_fan_same_snapshot_continue": True})
        )

    assert [name for name, _payload in calls] == [action]
    assert calls[0][1]["index"] == args["index"]
    assert calls[0][1]["preserveSelectorMap"] is True
    assert result["same_snapshot_continue"] is True
    assert result["effect"] in {"value-only", "dom-structure"}


def test_fill_form_resolves_all_values_in_one_rpc_and_reuses_final_observation():
    reference = protect_value("ada@example.test", field_type="email")
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append((action, args))
        assert kwargs.get("task_id") == "session-1"
        return {
            "status": "completed",
            "completedCount": 2,
            "effect": "value-only",
            "observation": {"text": "[9]<button>Submit"},
        }

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        result = browser_tool._browser_fill_form(
            {
                "fields": [
                    {"index": 1, "text": "Ada", "expected_label": "First name"},
                    {"index": 2, "value_ref": reference, "expected": {"label": "Email"}},
                ]
            },
            task_id="session-1",
        )

    assert calls == [
        (
            "fillForm",
            {
                "fields": [
                    {"index": 1, "text": "Ada", "clear": True, "expectedLabel": "First name"},
                    {
                        "index": 2,
                        "text": "ada@example.test",
                        "clear": True,
                        "expected": {"label": "Email"},
                    },
                ]
            },
        )
    ]
    parsed = json.loads(result)
    assert parsed["effect"] == "snapshot-refresh"
    assert parsed["result"]["completedCount"] == 2
    assert "[9]<button>Submit" in parsed["dom"]


def test_form_submit_transaction_uses_one_rpc_and_splits_success_results():
    calls = []

    def fake_call(action, args, **kwargs):
        calls.append((action, args, kwargs))
        return {
            "status": "completed",
            "completedCount": 1,
            "fields": [
                {
                    "index": 1,
                    "status": "completed",
                    "readback": {"matches": True},
                    "typingMode": "human",
                }
            ],
            "submit": {
                "index": 9,
                "status": "completed",
                "result": {"clicked": 9},
            },
            "observation": {"text": "[10]<button>Next</button>"},
            "effect": "dom-structure",
        }

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234", "typing_mode": "human"},
            {"index": 9, "expected_text": "Confirm"},
            task_id="session-1",
        )

    assert calls == [
        (
            "formSubmit",
            {
                "fields": [
                    {
                        "index": 1,
                        "text": "1234",
                        "clear": True,
                        "typingMode": "human",
                    }
                ],
                "submit": {
                    "index": 9,
                    "allowOccluded": False,
                    "expected": {"text": "Confirm"},
                },
            },
            {"task_id": "session-1"},
        )
    ]
    parsed_field = json.loads(field_result)
    parsed_click = json.loads(click_result)
    assert parsed_field["effect"] == "value-only"
    assert parsed_field["result"]["completedCount"] == 1
    assert parsed_click["effect"] == "snapshot-refresh"
    assert parsed_click["result"]["executed"] is True
    assert parsed_click["result"]["replan_required"] is False
    assert "[10]<button>Next" in parsed_click["dom"]


def test_form_submit_transaction_preserves_completed_fields_when_click_is_skipped():
    with patch.object(
        browser_tool,
        "_call",
        return_value={
            "status": "replan-required",
            "completedCount": 1,
            "fields": [{"index": 1, "status": "completed"}],
            "submit": {
                "index": 9,
                "status": "skipped",
                "reason": "The page changed after input",
                "errorCode": "FORM_PAGE_CHANGED",
            },
            "replanRequired": True,
            "observation": {"text": "[12]<button>New action</button>"},
            "effect": "dom-structure",
        },
    ):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_fill_form",
            {"fields": [{"index": 1, "text": "Ada"}]},
            {"index": 9},
        )

    parsed_field = json.loads(field_result)
    parsed_click = json.loads(click_result)
    assert parsed_field["result"]["status"] == "completed"
    assert parsed_click["result"] == {
        "index": 9,
        "status": "skipped",
        "reason": "The page changed after input",
        "errorCode": "FORM_PAGE_CHANGED",
        "executed": False,
        "replan_required": True,
        "code": "FORM_PAGE_CHANGED",
    }
    assert "[12]<button>New action" in parsed_click["dom"]


def test_form_submit_rpc_failure_marks_both_steps_unknown_and_non_retryable():
    call = patch.object(
        browser_tool,
        "_call",
        return_value={
            "__error__": "runtime unavailable",
            "__error_code__": "FORM_SUBMIT_FAILED",
            "__error_details__": {"retryable": False},
        },
    )
    with call as runtime_call:
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    runtime_call.assert_called_once()
    for result in (field_result, click_result):
        parsed = json.loads(result)["result"]
        assert parsed["status"] == "unknown"
        assert parsed["executed"] is None
        assert parsed["execution_state"] == "unknown"
        assert parsed["replan_required"] is True
        assert parsed["retryable"] is False
        assert parsed["do_not_retry"] is True
        assert parsed["code"] == "FORM_SUBMIT_FAILED"


def test_form_submit_explicit_before_dispatch_only_proves_click_was_skipped():
    with patch.object(
        browser_tool,
        "_call",
        return_value={
            "__error__": "submit target changed",
            "__error_code__": "CLICK_TARGET_MISMATCH",
            "__error_details__": {
                "beforeDispatch": True,
                "dispatchAttempted": False,
                "replanRequired": True,
            },
        },
    ):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    field = json.loads(field_result)["result"]
    click = json.loads(click_result)["result"]
    assert field["executed"] is None
    assert field["do_not_retry"] is True
    assert click["status"] == "skipped"
    assert click["executed"] is False
    assert click["code"] == "CLICK_TARGET_MISMATCH"


@pytest.mark.parametrize("invalid_result", [None, "invalid", []])
def test_form_submit_malformed_rpc_result_is_unknown(invalid_result):
    with patch.object(browser_tool, "_call", return_value=invalid_result):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    for result in (field_result, click_result):
        parsed = json.loads(result)["result"]
        assert parsed["status"] == "unknown"
        assert parsed["executed"] is None
        assert parsed["do_not_retry"] is True
        assert parsed["code"] == "FORM_SUBMIT_INVALID_RESULT"


@pytest.mark.parametrize(
    "invalid_result",
    [
        {
            "fields": [{"index": 1, "status": "completed"}],
            "submit": {"index": 9, "status": "completed"},
            "completedCount": 1,
        },
        {
            "fields": [
                {"index": 2, "status": "completed"},
                {"index": 1, "status": "completed"},
            ],
            "submit": {"index": 9, "status": "completed"},
            "completedCount": 2,
        },
        {
            "fields": [
                {"index": 1, "status": "completed"},
                {"index": 1, "status": "completed"},
            ],
            "submit": {"index": 9, "status": "completed"},
            "completedCount": 2,
        },
        {
            "fields": [
                {"index": 1, "status": "completed"},
                {"index": 2, "status": "completed"},
            ],
            "submit": {"index": 99, "status": "completed"},
            "completedCount": 2,
        },
        {
            "fields": [
                {"index": 1, "status": "completed"},
                {"index": 2, "status": "failed"},
            ],
            "submit": {"index": 9, "status": "skipped"},
            "completedCount": 2,
        },
        {
            "fields": [
                {"index": 1, "status": "completed"},
                {"index": 2, "status": "completed"},
            ],
            "submit": {"index": 9, "status": "completed"},
            "completedCount": True,
        },
    ],
)
def test_form_submit_mismatched_step_provenance_is_unknown(invalid_result):
    with patch.object(browser_tool, "_call", return_value=invalid_result):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_fill_form",
            {
                "fields": [
                    {"index": 1, "text": "Ada"},
                    {"index": 2, "text": "Lovelace"},
                ]
            },
            {"index": 9},
        )

    for result in (field_result, click_result):
        parsed = json.loads(result)["result"]
        assert parsed["status"] == "unknown"
        assert parsed["executed"] is None
        assert parsed["do_not_retry"] is True
        assert parsed["code"] == "FORM_SUBMIT_INVALID_PROVENANCE"


@pytest.mark.parametrize(
    "submit_status,top_level_provenance,submit_provenance",
    [
        ("completed", {}, {"beforeDispatch": True}),
        ("completed", {"dispatchAttempted": False}, {}),
        ("skipped", {}, {"dispatchAttempted": True}),
        ("skipped", {"beforeDispatch": False}, {}),
        (
            "failed",
            {},
            {"beforeDispatch": True, "dispatchAttempted": False},
        ),
        ("failed", {"dispatchAttempted": False}, {}),
        (
            "completed",
            {"beforeDispatch": False},
            {"beforeDispatch": True},
        ),
        ("completed", {}, {"dispatchAttempted": 1}),
    ],
)
def test_form_submit_contradictory_dispatch_provenance_is_unknown(
    submit_status,
    top_level_provenance,
    submit_provenance,
):
    runtime_result = {
        "fields": [{"index": 1, "status": "completed"}],
        "submit": {
            "index": 9,
            "status": submit_status,
            **submit_provenance,
        },
        "completedCount": 1,
        **top_level_provenance,
    }
    with patch.object(browser_tool, "_call", return_value=runtime_result):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    for result in (field_result, click_result):
        parsed = json.loads(result)["result"]
        assert parsed["status"] == "unknown"
        assert parsed["executed"] is None
        assert parsed["do_not_retry"] is True
        assert parsed["code"] == "FORM_SUBMIT_INVALID_PROVENANCE"


def test_form_submit_failed_dispatch_is_unknown_and_must_not_be_retried():
    with patch.object(
        browser_tool,
        "_call",
        return_value={
            "status": "replan-required",
            "completedCount": 1,
            "fields": [{"index": 1, "status": "completed"}],
            "submit": {
                "index": 9,
                "status": "failed",
                "reason": "mouse-dispatch-failed",
                "dispatchAttempted": True,
                "errorCode": "FORM_SUBMIT_FAILED",
            },
            "replanRequired": True,
            "error": "native mouse dispatch failed",
            "errorCode": "FORM_SUBMIT_FAILED",
            "effect": "dom-structure",
        },
    ):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    assert json.loads(field_result)["result"]["executed"] is True
    click = json.loads(click_result)["result"]
    assert click["status"] == "failed"
    assert click["executed"] is None
    assert click["execution_state"] == "unknown"
    assert click["retryable"] is False
    assert click["do_not_retry"] is True


def test_form_submit_timeout_pending_reports_unknown_and_forbids_blind_retry():
    with patch.object(
        browser_tool,
        "_call",
        return_value={
            "__error__": "Browser action timed out and is still settling",
            "__error_code__": "ACTION_TIMEOUT_PENDING",
            "__error_details__": {
                "retryable": False,
                "replanRequired": True,
                "action": "formSubmit",
            },
        },
    ):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    for result in (field_result, click_result):
        step = json.loads(result)["result"]
        assert step["status"] == "unknown"
        assert step["executed"] is None
        assert step["execution_state"] == "unknown"
        assert step["retryable"] is False
        assert step["do_not_retry"] is True
        assert step["code"] == "ACTION_TIMEOUT_PENDING"
        assert "Do not retry" in step["reason"]


def test_form_submit_private_final_observation_is_withheld_without_losing_click():
    private_url = "http://169.254.169.254/latest/meta-data/credentials"
    secret_dom = "cloud-secret-token"

    class Client:
        def call(self, action, **_kwargs):
            assert action == "formSubmit"
            return {
                "status": "completed",
                "fields": [{"index": 1, "status": "completed"}],
                "submit": {"index": 9, "status": "completed", "result": {"clicked": 9}},
                "completedCount": 1,
                "observation": {
                    "url": private_url,
                    "browserUseText": secret_dom,
                },
                "effect": "navigation",
            }

    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(browser_tool, "is_always_blocked_url", return_value=True),
    ):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    parsed_field = json.loads(field_result)
    parsed_click = json.loads(click_result)
    assert parsed_field["result"]["status"] == "completed"
    assert parsed_click["result"]["status"] == "completed"
    assert parsed_click["result"]["executed"] is True
    assert parsed_click["result"]["replan_required"] is True
    assert parsed_click["result"]["observation_blocked"]["code"] == (
        "BROWSER_PRIVATE_URL_BLOCKED"
    )
    assert "dom" not in parsed_click
    assert "observe_error" in parsed_click
    assert private_url not in field_result + click_result
    assert secret_dom not in field_result + click_result


def test_form_submit_final_observation_without_verifiable_url_is_withheld():
    secret_dom = "unverified-page-secret"

    class Client:
        def call(self, action, **_kwargs):
            assert action == "formSubmit"
            return {
                "status": "completed",
                "fields": [{"index": 1, "status": "completed"}],
                "submit": {"index": 9, "status": "completed", "result": {"clicked": 9}},
                "completedCount": 1,
                "observation": {
                    "browserUseText": secret_dom,
                    "tabs": [{"current": True, "title": "Unknown page"}],
                },
                "effect": "dom-structure",
            }

    with patch.object(browser_tool, "_client", return_value=Client()):
        field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9},
        )

    parsed_field = json.loads(field_result)
    parsed_click = json.loads(click_result)
    assert parsed_field["result"]["status"] == "completed"
    assert parsed_click["result"]["status"] == "completed"
    assert parsed_click["result"]["executed"] is True
    assert parsed_click["result"]["replan_required"] is True
    assert parsed_click["result"]["observation_blocked"]["code"] == (
        "BROWSER_OBSERVATION_URL_UNVERIFIED"
    )
    assert "dom" not in parsed_click
    assert "observe_error" in parsed_click
    assert secret_dom not in field_result + click_result


def test_private_form_submit_rejects_allow_occluded_before_rpc():
    with patch.object(browser_tool, "_call") as runtime_call:
        _field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234"},
            {"index": 9, "allow_occluded": True},
        )

    runtime_call.assert_not_called()
    click = json.loads(click_result)["result"]
    assert click["executed"] is False
    assert click["code"] == "INVALID_FORM_SUBMIT_TRANSACTION"
    assert "occluded" in click["reason"]


def test_form_submit_guard_observation_without_step_provenance_is_unknown():
    fresh_observation = {
        "browserUseText": "[14]<input aria-label=Code>\n[19]<button>Confirm</button>",
        "url": "https://example.test/verification-cleared",
        "captchaState": {"detected": False},
        "interventionPending": False,
    }
    calls = []

    class Client:
        def call(self, action, **_kwargs):
            calls.append(action)
            if action == "formSubmit":
                # Runtime dispatch was blocked before the transaction reached
                # InputOperations.formSubmit.
                return {
                    "status": "blocked",
                    "captchaState": {
                        "detected": True,
                        "kind": "behavioral",
                        "requiresUserInput": True,
                    },
                    "interventionPending": False,
                }
            if action == "observe":
                return dict(fresh_observation)
            raise AssertionError(action)

    browser_tool.set_verification_callback(cb=lambda _meta: "continue")
    try:
        with (
            patch.object(browser_tool, "_client", return_value=Client()),
            patch.object(browser_tool, "_active_page_private_url_error", return_value=None),
        ):
            field_result, click_result = browser_tool._browser_form_submit_transaction(
                "browser_type",
                {"index": 14, "text": "1234"},
                {"index": 19},
            )
    finally:
        browser_tool.set_verification_callback(cb=None)

    parsed_field = json.loads(field_result)
    parsed_click = json.loads(click_result)
    assert calls == ["formSubmit", "observe"]
    for parsed in (parsed_field, parsed_click):
        assert parsed["result"]["status"] == "unknown"
        assert parsed["result"]["executed"] is None
        assert parsed["result"]["do_not_retry"] is True
        assert parsed["result"]["code"] == "FORM_SUBMIT_INVALID_PROVENANCE"
    assert "completed" not in field_result


def test_form_submit_transaction_rejects_duplicate_or_nonpositive_indices_before_rpc():
    invalid_inputs = [
        (
            "browser_fill_form",
            {"fields": [{"index": 1, "text": "Ada"}, {"index": 1, "text": "Lovelace"}]},
            {"index": 9},
        ),
        ("browser_type", {"index": 0, "text": "1234"}, {"index": 9}),
        ("browser_type", {"index": 1, "text": "1234"}, {"index": 1}),
    ]

    with patch.object(browser_tool, "_call") as runtime_call:
        for tool_name, input_args, click_args in invalid_inputs:
            _field_result, click_result = browser_tool._browser_form_submit_transaction(
                tool_name,
                input_args,
                click_args,
            )
            assert json.loads(click_result)["result"]["executed"] is False

    runtime_call.assert_not_called()


def test_form_submit_transaction_rejects_autocomplete_intent_before_rpc():
    with patch.object(browser_tool, "_call") as runtime_call:
        _field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {
                "index": 1,
                "text": "San",
                "autocomplete_wait": True,
            },
            {"index": 9},
        )

    runtime_call.assert_not_called()
    assert "autocomplete" in json.loads(click_result)["result"]["reason"]


@pytest.mark.parametrize(
    "disabled_option",
    [
        {"autocomplete_wait": False},
        {"autocompleteWait": False},
        {"autocomplete_wait_ms": 0},
        {"autocompleteWaitMs": 0},
    ],
)
def test_form_submit_transaction_accepts_disabled_autocomplete_options(
    disabled_option,
):
    runtime_result = {
        "status": "completed",
        "completedCount": 1,
        "fields": [{"index": 1, "status": "completed"}],
        "submit": {"index": 9, "status": "completed"},
        "effect": "dom-structure",
    }
    with patch.object(
        browser_tool,
        "_call",
        return_value=runtime_result,
    ) as runtime_call:
        _field_result, click_result = browser_tool._browser_form_submit_transaction(
            "browser_type",
            {"index": 1, "text": "1234", **disabled_option},
            {"index": 9},
        )

    runtime_call.assert_called_once()
    assert json.loads(click_result)["result"]["executed"] is True


def test_form_submit_human_continue_preserves_transaction_and_replaces_observation():
    calls = []
    original_fields = [{"index": 1, "status": "completed"}]
    original_submit = {
        "index": 9,
        "status": "completed",
        "result": {"clicked": 9},
    }
    fresh_observation = {
        "url": "https://example.test/verification-cleared",
        "browserUseText": "[12]<button>Continue</button>",
        "captchaState": {"detected": False},
        "interventionPending": False,
    }

    class Client:
        def call(self, action, **_kwargs):
            calls.append(action)
            if action == "formSubmit":
                return {
                    "status": "completed",
                    "fields": original_fields,
                    "submit": original_submit,
                    "completedCount": 1,
                    "observation": {
                        "url": "https://example.test/verification",
                        "browserUseText": "old verification page",
                        "captchaState": {"detected": True},
                    },
                    "captchaState": {
                        "detected": True,
                        "kind": "behavioral",
                        "requiresUserInput": True,
                    },
                    "interventionPending": False,
                    "effect": "dom-structure",
                }
            if action == "observe":
                return dict(fresh_observation)
            raise AssertionError(action)

    browser_tool.set_verification_callback(cb=lambda _meta: "continue")
    try:
        with (
            patch.object(browser_tool, "_client", return_value=Client()),
            patch.object(browser_tool, "_active_page_private_url_error", return_value=None),
        ):
            result = browser_tool._call(
                "formSubmit",
                {"fields": [{"index": 1, "text": "1234"}], "submit": {"index": 9}},
                task_id="session-a",
            )
    finally:
        browser_tool.set_verification_callback(cb=None)

    assert calls == ["formSubmit", "observe"]
    assert result["fields"] == original_fields
    assert result["submit"] == original_submit
    assert result["status"] == "completed"
    assert result["observation"] == fresh_observation
    assert result["captchaState"] == {"detected": False}
    assert result["interventionPending"] is False


def test_form_submit_human_stop_preserves_completed_click_provenance():
    class Client:
        def call(self, action, **_kwargs):
            assert action == "formSubmit"
            return {
                "status": "completed",
                "fields": [{"index": 1, "status": "completed"}],
                "submit": {"index": 9, "status": "completed"},
                "observation": {
                    "url": "https://example.test/verification",
                    "browserUseText": "verification",
                },
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                },
            }

    browser_tool.set_verification_callback(cb=lambda _meta: "stop")
    try:
        with patch.object(browser_tool, "_client", return_value=Client()):
            field_result, click_result = browser_tool._browser_form_submit_transaction(
                "browser_type",
                {"index": 1, "text": "1234"},
                {"index": 9},
                task_id="session-a",
            )
    finally:
        browser_tool.set_verification_callback(cb=None)

    parsed_field = json.loads(field_result)
    parsed_click = json.loads(click_result)
    assert parsed_field["result"]["status"] == "completed"
    assert parsed_click["result"]["status"] == "completed"
    assert parsed_click["result"]["executed"] is True
    assert parsed_click["result"]["replan_required"] is True
    assert parsed_click["result"]["post_action_error"]["code"] == (
        "HUMAN_CONTROL_STOPPED"
    )


def test_browser_click_human_stop_does_not_observe_or_reopen_verification():
    runtime_calls = []
    callback_calls = []

    class Client:
        def call(self, action, **_kwargs):
            runtime_calls.append(action)
            if action != "click":
                raise AssertionError(f"unexpected trailing browser call: {action}")
            return {
                "clicked": 18,
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                    "challengeId": "slider-a",
                },
            }

    def stop_verification(meta):
        callback_calls.append(meta)
        return "stop"

    browser_tool.set_verification_callback(cb=stop_verification)
    try:
        with patch.object(browser_tool, "_client", return_value=Client()):
            result = json.loads(
                browser_tool._browser_click(
                    {"index": 18},
                    task_id="session-a",
                )
            )
    finally:
        browser_tool.set_verification_callback(cb=None)

    assert runtime_calls == ["click"]
    assert len(callback_calls) == 1
    assert callback_calls[0]["challenge_id"] == "slider-a"
    assert result["code"] == "HUMAN_CONTROL_STOPPED"
    assert result["retryable"] is False
    assert result["details"]["replanRequired"] is False


def test_inflight_browser_result_after_interrupt_does_not_open_verification():
    """Stop can land while the runtime click RPC is still returning."""

    from tools.interrupt import set_interrupt

    rpc_started = threading.Event()
    release_rpc = threading.Event()
    callback_calls = []
    result: list[dict] = []

    class Client:
        def call(self, action, **_kwargs):
            assert action == "click"
            rpc_started.set()
            assert release_rpc.wait(timeout=1)
            return {
                "clicked": 18,
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                    "challengeId": "late-slider",
                },
            }

    def run_click() -> None:
        browser_tool.set_verification_callback(
            cb=lambda meta: callback_calls.append(meta) or "continue"
        )
        try:
            result.append(
                json.loads(
                    browser_tool._browser_click(
                        {"index": 18},
                        task_id="session-a",
                    )
                )
            )
        finally:
            browser_tool.set_verification_callback(cb=None)
            set_interrupt(False)

    with patch.object(browser_tool, "_client", return_value=Client()):
        worker = threading.Thread(target=run_click)
        worker.start()
        assert rpc_started.wait(timeout=1)
        assert worker.ident is not None
        set_interrupt(True, worker.ident)
        release_rpc.set()
        worker.join(timeout=1)

    assert not worker.is_alive()
    assert callback_calls == []
    assert result[0]["code"] == "HUMAN_CONTROL_STOPPED"
    assert result[0]["retryable"] is False
    assert result[0]["details"]["replanRequired"] is False


def test_fill_form_human_continue_preserves_field_results():
    transaction = {
        "status": "completed",
        "fields": [{"index": 1, "status": "completed"}],
        "completedCount": 1,
        "observation": {
            "url": "https://example.test/verification",
            "browserUseText": "old verification",
        },
        "captchaState": {
            "detected": True,
            "requiresUserInput": True,
        },
    }
    fresh = {
        "url": "https://example.test/verification-cleared",
        "browserUseText": "[9]<button>Submit</button>",
        "captchaState": {"detected": False},
    }

    class Client:
        def call(self, action, **_kwargs):
            assert action == "fillForm"
            return dict(transaction)

    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(browser_tool, "_guard_human", return_value=fresh),
    ):
        result = browser_tool._call(
            "fillForm",
            {"fields": [{"index": 1, "text": "Ada"}]},
            task_id="session-a",
        )

    assert result["fields"] == transaction["fields"]
    assert result["completedCount"] == 1
    assert result["observation"] == fresh
    assert result["captchaState"] == {"detected": False}


def test_find_visual_treats_non_string_provider_result_as_unavailable():
    async def fake_vision_analyze_tool(**_kwargs):
        return {"success": False, "analysis": "provider unavailable"}

    def fake_call(action, _args, **_kwargs):
        if action == "observe":
            return {
                "text": "",
                "elements": [],
                "viewport": {"width": 1200, "height": 800, "scrollX": 0, "scrollY": 0},
            }
        if action == "screenshot":
            return {"data": "cG5n", "format": "png"}
        raise AssertionError(action)

    with patch.object(browser_tool, "_call", side_effect=fake_call):
        with patch.object(browser_tool, "_paint_index_boxes", return_value=b"painted"):
            with patch.object(browser_tool, "_fv_debug_dump"):
                with patch("tools.vision_tools.vision_analyze_tool", side_effect=fake_vision_analyze_tool):
                    result = json.loads(browser_tool._browser_find_visual({"description": "Submit"}))

    assert result["code"] == "VISION_PROVIDER_UNAVAILABLE"
    assert result["retryable"] is False


def test_future_observation_keeps_values_echoed_by_the_page():
    session_key = "observation-redaction-test"
    token = set_current_session_key(session_key)
    try:
        protect_value(
            "P1234567",
            field_type="passport",
            label="护照号",
        )

        formatted = browser_tool.format_observation_for_model(
            {
                "browserUseText": '[7]<input value="P1234567">',
                "title": "Application P1234567",
                "url": "https://example.test/apply?passport=P1234567",
                "tabs": [],
            }
        )

        assert "P1234567" in formatted
    finally:
        clear_session(session_key)
        reset_current_session_key(token)


if __name__ == "__main__":
    import traceback

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
