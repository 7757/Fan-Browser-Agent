from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent import agent_runtime_helpers


class _RequestError(RuntimeError):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.status_code = 400
        self.request_id = "request-123"
        self.code = "invalid_request"
        self.param = "messages"
        self.body = {"detail": "PRIVATE ERROR BODY"}
        self.response = SimpleNamespace(
            status_code=400,
            text="PRIVATE RESPONSE BODY",
        )


def _request_body() -> dict:
    return {
        "model": "test-model",
        "messages": [
            {"role": "system", "content": "PRIVATE SYSTEM PROMPT"},
            {"role": "user", "content": "PRIVATE USER MESSAGE"},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "browser_run",
                    "description": "PRIVATE TOOL SCHEMA",
                },
            }
        ],
        "stream": True,
        "timeout": 30,
        "unused": None,
    }


def _agent(logs_dir: Path):
    notices: list[str] = []
    agent = SimpleNamespace(
        api_mode="chat_completions",
        base_url="https://provider.example/v1",
        client=SimpleNamespace(api_key="sk-private-key"),
        log_prefix="[test] ",
        logs_dir=logs_dir,
        model="fallback-model",
        provider="test-provider",
        session_id="session/unsafe",
        verbose_logging=False,
        _mask_api_key_for_logs=lambda _key: "masked-key",
        _vprint=notices.append,
    )
    return agent, notices


@pytest.fixture(autouse=True)
def _isolated_dump_environment(monkeypatch):
    monkeypatch.delenv("FAN_DUMP_REQUESTS", raising=False)
    monkeypatch.delenv("FAN_DUMP_REQUEST_STDOUT", raising=False)
    runtime = SimpleNamespace(
        _safe_session_filename_component=lambda _value: "session-safe",
        logger=SimpleNamespace(debug=lambda *_args, **_kwargs: None),
    )
    monkeypatch.setattr(agent_runtime_helpers, "_ra", lambda: runtime)


def test_request_failure_dump_is_metadata_only_by_default(tmp_path):
    agent, notices = _agent(tmp_path)
    request_body = _request_body()
    private_error_message = "PRIVATE ERROR MESSAGE " + ("x" * 2200)
    error = _RequestError(private_error_message)

    dump_path = agent_runtime_helpers.dump_api_request_debug(
        agent,
        request_body,
        reason="non_retryable_client_error",
        error=error,
    )

    assert dump_path is not None
    raw_dump = dump_path.read_text(encoding="utf-8")
    payload = json.loads(raw_dump)
    request = payload["request"]
    error_record = payload["error"]

    normalized_body = {
        key: value
        for key, value in request_body.items()
        if key != "timeout" and value is not None
    }
    encoded_body = json.dumps(
        normalized_body,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")

    assert payload["contains_full_request"] is False
    assert request == {
        "method": "POST",
        "url": "https://provider.example/v1/chat/completions",
        "provider": "test-provider",
        "api_mode": "chat_completions",
        "model": "test-model",
        "body_keys": ["messages", "model", "stream", "tools"],
        "body_bytes": len(encoded_body),
        "body_sha256": hashlib.sha256(encoded_body).hexdigest(),
        "message_count": 2,
        "tool_count": 1,
    }
    encoded_error_message = private_error_message.encode("utf-8")
    assert "message" not in error_record
    assert error_record["message_bytes"] == len(encoded_error_message)
    assert error_record["message_sha256"] == hashlib.sha256(
        encoded_error_message
    ).hexdigest()
    assert error_record["status_code"] == 400
    assert error_record["request_id"] == "request-123"
    assert "body" not in error_record
    assert "response_text" not in error_record
    assert error_record["body_bytes"] > 0
    assert len(error_record["body_sha256"]) == 64
    assert error_record["response_bytes"] > 0
    assert len(error_record["response_sha256"]) == 64
    assert "PRIVATE SYSTEM PROMPT" not in raw_dump
    assert "PRIVATE USER MESSAGE" not in raw_dump
    assert "PRIVATE TOOL SCHEMA" not in raw_dump
    assert "PRIVATE ERROR MESSAGE" not in raw_dump
    assert "PRIVATE ERROR BODY" not in raw_dump
    assert "PRIVATE RESPONSE BODY" not in raw_dump
    assert notices and "request failure metadata" in notices[-1]
    assert not list(tmp_path.glob("*.tmp"))
    if os.name == "posix":
        assert stat.S_IMODE(dump_path.stat().st_mode) == 0o600


def test_full_request_dump_requires_explicit_opt_in(tmp_path, monkeypatch):
    monkeypatch.setenv("FAN_DUMP_REQUESTS", "1")
    agent, notices = _agent(tmp_path)
    request_body = _request_body()
    error = _RequestError("full provider error")

    dump_path = agent_runtime_helpers.dump_api_request_debug(
        agent,
        request_body,
        reason="max_retries_exhausted",
        error=error,
    )

    assert dump_path is not None
    raw_dump = dump_path.read_text(encoding="utf-8")
    payload = json.loads(raw_dump)
    request = payload["request"]
    error_record = payload["error"]

    assert payload["contains_full_request"] is True
    assert request["body"]["messages"] == request_body["messages"]
    assert request["body"]["tools"] == request_body["tools"]
    assert "timeout" not in request["body"]
    assert "unused" not in request["body"]
    assert "headers" in request
    assert "sk-private-key" not in raw_dump
    assert error_record["body"] == {"detail": "PRIVATE ERROR BODY"}
    assert error_record["response_text"] == "PRIVATE RESPONSE BODY"
    assert notices and "full request debug" in notices[-1]


def test_stdout_flag_prints_the_same_metadata_and_still_writes_file(
    tmp_path,
    monkeypatch,
    capsys,
):
    monkeypatch.setenv("FAN_DUMP_REQUEST_STDOUT", "1")
    agent, _notices = _agent(tmp_path)

    dump_path = agent_runtime_helpers.dump_api_request_debug(
        agent,
        _request_body(),
        reason="non_retryable_client_error",
    )

    assert dump_path is not None
    assert dump_path.exists()
    file_content = dump_path.read_text(encoding="utf-8")
    stdout = capsys.readouterr().out
    assert file_content in stdout
    assert '"contains_full_request": false' in stdout
    assert "PRIVATE USER MESSAGE" not in stdout


def test_request_dumps_use_exclusive_private_temp_files_and_keep_latest_ten(
    tmp_path,
    monkeypatch,
):
    old_dumps = []
    for index in range(10):
        old_dump = tmp_path / f"request_dump_old_{index:02d}.json"
        old_dump.write_text("{}", encoding="utf-8")
        os.utime(old_dump, (index + 1, index + 1))
        old_dumps.append(old_dump)

    open_calls = []
    real_open = os.open

    def recording_open(path, flags, mode=0o777):
        open_calls.append((Path(path), flags, mode))
        return real_open(path, flags, mode)

    monkeypatch.setattr(agent_runtime_helpers.os, "open", recording_open)
    agent, _notices = _agent(tmp_path)

    dump_path = agent_runtime_helpers.dump_api_request_debug(
        agent,
        _request_body(),
        reason="max_retries_exhausted",
    )

    assert dump_path is not None
    assert open_calls
    temp_path, flags, mode = open_calls[-1]
    assert temp_path.name == dump_path.name + ".tmp"
    assert flags & os.O_EXCL
    if getattr(os, "O_NOFOLLOW", 0):
        assert flags & os.O_NOFOLLOW
    assert mode == 0o600
    assert dump_path.exists()
    assert not temp_path.exists()

    retained = sorted(tmp_path.glob("request_dump_*.json"))
    assert len(retained) == 10
    assert not old_dumps[0].exists()
    if os.name == "posix":
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in retained)
