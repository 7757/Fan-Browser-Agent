from agent import curator
from fan_cli.config import DEFAULT_CONFIG


def _stub_run_environment(monkeypatch):
    state = curator._default_state()

    def load_state():
        return dict(state)

    def save_state(next_state):
        state.clear()
        state.update(next_state)

    monkeypatch.setattr(curator, "load_state", load_state)
    monkeypatch.setattr(curator, "save_state", save_state)
    monkeypatch.setattr(
        curator,
        "apply_automatic_transitions",
        lambda now=None: {
            "checked": 1,
            "marked_stale": 0,
            "archived": 0,
            "reactivated": 0,
        },
    )
    monkeypatch.setattr(
        curator.skill_usage,
        "agent_created_report",
        lambda: [{"name": "custom-skill", "state": "active"}],
    )
    monkeypatch.setattr(curator, "_write_run_report", lambda **kwargs: None)
    monkeypatch.setattr(curator, "_build_rename_summary", lambda **kwargs: "")

    return state


def test_consolidation_defaults_off_in_runtime_and_config(monkeypatch):
    monkeypatch.setattr(curator, "_load_config", lambda: {})

    assert curator.get_consolidate() is False
    assert DEFAULT_CONFIG["curator"]["consolidate"] is False


def test_consolidation_can_be_enabled_in_config(monkeypatch):
    monkeypatch.setattr(curator, "_load_config", lambda: {"consolidate": True})

    assert curator.get_consolidate() is True


def test_default_review_records_prune_run_without_creating_llm_agent(monkeypatch):
    state = _stub_run_environment(monkeypatch)
    monkeypatch.setattr(curator, "_load_config", lambda: {})
    monkeypatch.setattr(
        curator,
        "_run_llm_review",
        lambda prompt: (_ for _ in ()).throw(AssertionError("LLM consolidation must be opt-in")),
    )
    summaries = []

    result = curator.run_curator_review(on_summary=summaries.append, synchronous=True)

    assert result["auto_transitions"]["checked"] == 1
    assert state["run_count"] == 1
    assert "consolidation off" in state["last_run_summary"]
    assert summaries and "consolidation off" in summaries[-1]


def test_explicit_consolidation_override_runs_llm_review(monkeypatch):
    _stub_run_environment(monkeypatch)
    calls = []

    def run_llm(prompt):
        calls.append(prompt)
        return {
            "final": "no changes",
            "summary": "no changes",
            "model": "test-model",
            "provider": "test-provider",
            "tool_calls": [],
            "error": None,
        }

    monkeypatch.setattr(curator, "_run_llm_review", run_llm)

    curator.run_curator_review(synchronous=True, consolidate=True)

    assert len(calls) == 1
    assert "custom-skill" in calls[0]
