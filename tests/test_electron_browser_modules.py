from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tools.electron_browser_args as browser_args
import tools.electron_browser_context as browser_context
import tools.electron_browser_serialization as browser_serialization
import tools.electron_browser_tool as browser_tool


def _decision_token(generation: int) -> dict:
    return {
        "version": 1,
        "sessionId": "session-a",
        "activeTabId": "session-a",
        "viewEpoch": 2,
        "documentRevision": 3,
        "pageGeneration": 1,
        "selectorGeneration": generation,
        "tabListGeneration": 0,
    }


def test_facade_reexports_extracted_browser_helpers():
    assert (
        browser_tool.set_browser_decision_context
        is browser_context.set_browser_decision_context
    )
    assert browser_tool.set_verification_callback is browser_context.set_verification_callback
    assert browser_tool.set_control_callback is browser_context.set_control_callback
    assert browser_tool._observe_text is browser_serialization._observe_text
    assert browser_tool._enrich_error is browser_serialization._enrich_error
    assert browser_tool._target_payload is browser_args._target_payload
    assert browser_tool._coerce_headers is browser_args._coerce_headers


def test_browser_callbacks_remain_thread_local():
    main_verification = object()
    main_control = object()
    browser_context.set_verification_callback(main_verification)
    browser_context.set_control_callback(main_control)
    observed: queue.Queue[tuple[object | None, object | None]] = queue.Queue()

    def inspect_worker_context():
        observed.put(browser_context.browser_callbacks())
        browser_context.set_verification_callback("worker-verification")
        browser_context.set_control_callback("worker-control")
        observed.put(browser_context.browser_callbacks())

    worker = threading.Thread(target=inspect_worker_context)
    worker.start()
    worker.join(timeout=2)
    try:
        assert not worker.is_alive()
        assert observed.get_nowait() == (None, None)
        assert observed.get_nowait() == ("worker-verification", "worker-control")
        assert browser_context.browser_callbacks() == (main_verification, main_control)
    finally:
        browser_context.set_verification_callback(None)
        browser_context.set_control_callback(None)


def test_call_uses_context_decision_token_and_refreshes_it():
    class Client:
        def __init__(self):
            self.params = None

        def call(self, _action, *, params, **_kwargs):
            self.params = params
            return {"clicked": 3, "__fanDecisionToken": _decision_token(9)}

    client = Client()
    browser_tool.set_browser_decision_context(_decision_token(8), required=True)
    try:
        with patch.object(browser_tool, "_client", return_value=client):
            assert browser_tool._call("click", {"index": 3}, task_id="session-a") == {
                "clicked": 3
            }
        assert client.params["_fanDecisionToken"] == _decision_token(8)
        assert browser_tool.current_browser_decision_token() == _decision_token(9)
    finally:
        browser_tool.clear_browser_decision_context()


def test_human_guard_reads_callback_and_guard_state_from_context():
    observed = {}

    def verification_callback(meta):
        observed["meta"] = meta
        observed["guard_active"] = browser_context.browser_guard_active()
        return "continue"

    browser_tool.set_verification_callback(cb=verification_callback)
    try:
        with patch.object(browser_tool, "_call", return_value={"text": "fresh"}):
            result = browser_tool._guard_human(
                {
                    "url": "https://example.test/verify",
                    "captchaState": {
                        "detected": True,
                        "type": "image",
                        "challengeId": "challenge-7",
                        "documentRevision": 4,
                    },
                },
                {"task_id": "session-a"},
            )
        assert result == {"text": "fresh"}
        assert observed["meta"]["kind"] == "verification"
        assert observed["meta"]["challenge_id"] == "challenge-7"
        assert observed["meta"]["document_revision"] == 4
        assert observed["guard_active"] is True
        assert browser_context.browser_guard_active() is False
    finally:
        browser_tool.set_verification_callback(cb=None)


def test_control_stop_and_callback_failure_do_not_ack_or_observe():
    def callback_error(_meta):
        raise RuntimeError("interrupted")

    cases = [
        ("stop", lambda _meta: "stop", "HUMAN_CONTROL_STOPPED"),
        ("exception", callback_error, "HUMAN_CONTROL_CALLBACK_FAILED"),
    ]

    for label, callback, error_code in cases:
        calls = []

        class Client:
            def call(self, action, *, workbench_id, params):
                calls.append((action, workbench_id, params))
                return {"acknowledged": True}

        with (
            patch.object(browser_tool, "_client", return_value=Client()),
            patch.object(browser_tool, "_call") as observe,
        ):
            result = browser_tool._resolve_block(
                {"interventionPending": True},
                {"task_id": "session-a"},
                callback,
                {"kind": "control"},
                ack="acknowledgeIntervention",
            )

        assert result["__error_code__"] == error_code, label
        assert calls == [], label
        observe.assert_not_called()


def test_control_continue_restores_anchor_and_observes_once():
    calls = []

    class Client:
        def call(self, action, *, workbench_id, params):
            calls.append((action, workbench_id, params))
            return {"acknowledged": True, "restored": True}

    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(
            browser_tool, "_call", return_value={"url": "https://example.test/fresh"}
        ) as observe,
    ):
        result = browser_tool._resolve_block(
            {"interventionPending": True},
            {"task_id": "session-a"},
            lambda _meta: "  ConTinue  ",
            {"kind": "control", "tabKind": "tab", "anchorTabId": "tab-a"},
            ack="acknowledgeIntervention",
        )

    assert result == {"url": "https://example.test/fresh"}
    assert calls == [
        ("acknowledgeIntervention", "session-a", {"restoreAnchor": True})
    ]
    observe.assert_called_once_with("observe", {}, guard=False, task_id="session-a")


def test_control_continue_fails_closed_when_anchor_restore_fails():
    class Client:
        def call(self, _action, *, workbench_id, params):
            assert workbench_id == "session-a"
            assert params == {"restoreAnchor": True}
            return {"acknowledged": False, "restored": False, "tabClosed": True}

    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(browser_tool, "_call") as observe,
    ):
        result = browser_tool._resolve_block(
            {"interventionPending": True},
            {"task_id": "session-a"},
            lambda _meta: "continue",
            {"kind": "control", "tabKind": "tab", "anchorTabId": "tab-a"},
            ack="acknowledgeIntervention",
        )

    assert result["__error_code__"] == "HUMAN_CONTROL_RESTORE_FAILED"
    observe.assert_not_called()


def test_verification_auto_observes_once():
    with patch.object(
        browser_tool,
        "_call",
        return_value={"url": "https://example.test/verified"},
    ) as observe:
        result = browser_tool._resolve_block(
            {"captchaState": {"detected": True}},
            {"task_id": "session-a"},
            lambda _meta: " AUTO ",
            {"kind": "verification"},
        )

    assert result == {"url": "https://example.test/verified"}
    observe.assert_called_once_with("observe", {}, guard=False, task_id="session-a")


def test_call_guards_intervention_from_non_observe_action_by_default():
    intervention = {
        "interventionPending": True,
        "url": "https://example.test/paused",
    }

    class Client:
        def call(self, _action, **_kwargs):
            return intervention

    guarded = {"guarded": True}
    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(browser_tool, "_guard_human", return_value=guarded) as human_guard,
    ):
        result = browser_tool._call("click", {"index": 2}, task_id="session-a")

    assert result == guarded
    human_guard.assert_called_once_with(intervention, {"task_id": "session-a"})


def test_call_guards_behavioral_verification_from_non_observe_action_by_default():
    verification = {
        "captchaState": {
            "detected": True,
            "kind": "behavioral",
            "requiresUserInput": True,
        },
        "url": "https://example.test/verify",
    }

    class Client:
        def call(self, _action, **_kwargs):
            return verification

    guarded = {"guarded": True}
    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(browser_tool, "_guard_human", return_value=guarded) as human_guard,
    ):
        result = browser_tool._call("wait", {"seconds": 30}, task_id="session-a")

    assert result == guarded
    human_guard.assert_called_once_with(verification, {"task_id": "session-a"})


def test_post_action_observation_replaces_stale_human_state():
    observed = {
        "browserUseText": "[647]<div>拖动滑块</div>",
        "captchaState": {
            "detected": True,
            "kind": "behavioral",
            "requiresUserInput": True,
            "url": "https://example.test/slider",
        },
        "interventionPending": False,
    }
    payload = {
        "result": {
            "clicked": 172,
            "captchaState": {
                "detected": True,
                "kind": "transcribable",
                "requiresUserInput": False,
                "url": "https://example.test/",
            },
            "interventionPending": True,
        }
    }

    with patch.object(browser_tool, "_call", return_value=observed):
        result = browser_tool._result_with_fresh_observation(
            payload,
            {"task_id": "session-a"},
        )

    decoded = json.loads(result)
    assert decoded["captchaState"] == observed["captchaState"]
    assert decoded["interventionPending"] is False
    assert "captchaState" not in decoded["result"]
    assert "interventionPending" not in decoded["result"]
    assert "拖动滑块" in decoded["dom"]


def test_dropdown_options_returns_compact_read_only_result_without_observing():
    dropdown = {
        "index": 3777,
        "type": "select",
        "source": "native-select",
        "optionCount": 213,
        "options": [
            {"index": 0, "text": "CHINA P. R.", "value": "112", "disabled": False}
        ],
    }

    with patch.object(browser_tool, "_call", return_value=dropdown) as call:
        decoded = json.loads(
            browser_tool._browser_dropdown_options(
                {"index": 3777}, task_id="session-a"
            )
        )

    call.assert_called_once_with(
        "dropdownOptions", {"index": 3777}, task_id="session-a"
    )
    assert decoded == {"effect": "none", "result": dropdown}
    assert "dom" not in decoded


def test_call_guard_false_skips_intervention_guard_for_internal_recovery():
    intervention = {"interventionPending": True}

    class Client:
        def call(self, action, **_kwargs):
            if action == "liveState":
                return {"url": "https://example.test/current"}
            return intervention

    with (
        patch.object(browser_tool, "_client", return_value=Client()),
        patch.object(browser_tool, "_guard_human") as human_guard,
    ):
        result = browser_tool._call(
            "observe",
            {},
            guard=False,
            task_id="session-a",
        )

    assert result == intervention
    human_guard.assert_not_called()


def test_argument_normalizers_preserve_aliases_and_coercion():
    assert browser_args._target_payload({"target_id": " frame-1 ", "tabId": " tab-2 "}) == {
        "targetId": "frame-1",
        "tabId": "tab-2",
    }
    assert browser_args._tab_ref({"index": 0}) == "0"
    assert browser_args._coerce_json_object('{"domain": "example.test"}', "filter") == {
        "domain": "example.test"
    }
    assert browser_args._coerce_headers('{"X-Count": 3, "Drop": null}') == {
        "X-Count": "3"
    }
    assert browser_args._coerce_string_list("a.test, b.test") == ["a.test", "b.test"]


def test_serialization_module_matches_facade_output():
    observation = {
        "browserUseText": "[1]<button>Continue",
        "title": "Checkout",
        "url": "https://example.test/checkout",
        "tabs": [{"stableId": "t1", "current": True, "title": "Checkout"}],
        "recentEvents": [{"type": "download", "savePath": "/tmp/report.pdf"}],
    }

    direct = browser_serialization._observe_text(observation)
    assert direct == browser_tool.format_observation_for_model(observation)
    assert "[page: Checkout · https://example.test/checkout]" in direct
    assert browser_serialization._append_recent_events(direct, observation).endswith(
        "[最近事件]\n- download: /tmp/report.pdf"
    )


if __name__ == "__main__":
    tests = [
        value
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception:
            failures += 1
            print(f"FAIL {test.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    raise SystemExit(1 if failures else 0)
