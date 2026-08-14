from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.electron_browser_visual import _prune_for_paint, observation_viewport


def test_observation_viewport_reuses_atomic_snapshot_without_rpc():
    calls = []

    result = observation_viewport(
        {
            "viewport": {
                "width": 1200,
                "height": 800,
                "scrollX": 12,
                "scrollY": 24,
            }
        },
        {"task_id": "session-a"},
        call=lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    assert result == (12.0, 24.0, 1200.0, 800.0)
    assert calls == []


def test_observation_viewport_keeps_legacy_runtime_fallback():
    calls = []

    def call(action, params, **kw):
        calls.append((action, params, kw))
        return {"value": '{"sx":3,"sy":4,"iw":900,"ih":600}'}

    result = observation_viewport({}, {"task_id": "session-a"}, call=call)

    assert result == (3.0, 4.0, 900.0, 600.0)
    assert calls[0][0] == "evaluateJavaScript"
    assert calls[0][2] == {"task_id": "session-a"}


def test_prune_for_paint_removes_noise_but_keeps_semantic_leaf():
    container = {
        "index": 1,
        "tag": "div",
        "rect": {"left": 0, "top": 0, "width": 300, "height": 200},
    }
    weak_leaf = {
        "index": 2,
        "tag": "span",
        "rect": {"left": 20, "top": 20, "width": 40, "height": 40},
    }
    semantic_leaf = {
        "index": 3,
        "tag": "button",
        "attributes": {"id": "submit"},
        "rect": {"left": 20, "top": 20, "width": 40, "height": 40},
    }
    tiny_noise = {
        "index": 4,
        "tag": "span",
        "rect": {"left": 5, "top": 5, "width": 4, "height": 4},
    }

    result = _prune_for_paint(
        [container, weak_leaf, semantic_leaf, tiny_noise], vw=1000, vh=800
    )

    assert result == [semantic_leaf]


if __name__ == "__main__":
    tests = [
        value
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\n{len(tests)}/{len(tests)} passed")
