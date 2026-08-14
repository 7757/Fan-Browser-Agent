import json
import logging

from agent.transports.chat_completions import ChatCompletionsTransport
from agent.transports.codex import ResponsesApiTransport
from agent.agent_runtime_helpers import repair_message_sequence_with_cursor
from fan_state import db_persisted_marker_matches
from run_agent import AIAgent, _DB_PERSISTED_MARKER


class _RecordingSessionDB:
    def __init__(self, *, fail_once_on_content=None):
        self.rows = []
        self.fail_once_on_content = fail_once_on_content
        self.failed = False

    def append_message(self, **row):
        if (
            self.fail_once_on_content is not None
            and row.get("content") == self.fail_once_on_content
            and not self.failed
        ):
            self.failed = True
            raise RuntimeError("simulated session DB write failure")
        self.rows.append(row)
        return len(self.rows)


def _agent(db, session_id="session-a"):
    agent = AIAgent.__new__(AIAgent)
    agent._session_db = db
    agent._session_db_created = True
    agent._last_flushed_db_idx = 0
    agent._flushed_db_message_ids = set()
    agent._persist_user_message_idx = None
    agent._persist_user_message_override = None
    agent.session_id = session_id
    return agent


def test_stale_object_id_seed_cannot_suppress_a_new_message():
    db = _RecordingSessionDB()
    agent = _agent(db)
    message = {"role": "assistant", "content": "must be durable"}
    # Reproduce the dangerous state left by the old cross-turn id(msg) set.
    agent._flushed_db_message_ids = {id(message)}

    agent._flush_messages_to_session_db([message])

    assert [row["content"] for row in db.rows] == ["must be durable"]
    assert db_persisted_marker_matches(message, "session-a", db.rows[0])
    assert agent._flushed_db_message_ids == set()


def test_partial_write_failure_is_visible_and_unwritten_tail_retries(caplog):
    db = _RecordingSessionDB(fail_once_on_content="second")
    agent = _agent(db)
    messages = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "second"},
        {"role": "user", "content": "third"},
    ]

    with caplog.at_level(logging.WARNING, logger="run_agent"):
        agent._flush_messages_to_session_db(messages)

    assert [row["content"] for row in db.rows] == ["first"]
    assert db_persisted_marker_matches(messages[0], "session-a", db.rows[0])
    assert _DB_PERSISTED_MARKER not in messages[1]
    assert _DB_PERSISTED_MARKER not in messages[2]
    assert "simulated session DB write failure" in agent._session_db_last_write_error
    assert "Session DB append_message failed" in caplog.text

    # The next persistence point skips the committed prefix and retries the
    # exact failed tail; nothing is silently lost or duplicated.
    agent._flush_messages_to_session_db(messages, conversation_history=messages)

    assert [row["content"] for row in db.rows] == ["first", "second", "third"]
    assert all(
        db_persisted_marker_matches(message, "session-a", row)
        for message, row in zip(messages, db.rows)
    )
    assert agent._session_db_last_write_error is None


def test_session_scoped_marker_allows_compression_child_to_persist_context():
    db = _RecordingSessionDB()
    agent = _agent(db, "parent")
    message = {"role": "user", "content": "carry this context"}

    agent._flush_messages_to_session_db([message])
    agent.session_id = "child"
    agent._last_flushed_db_idx = 0  # compression rotation contract
    agent._flush_messages_to_session_db([message])

    assert [row["session_id"] for row in db.rows] == ["parent", "child"]
    assert db_persisted_marker_matches(message, "child", db.rows[-1])


def test_failed_new_user_survives_consecutive_user_sequence_repair():
    db = _RecordingSessionDB()
    agent = _agent(db)
    old_user = {"role": "user", "content": "old"}
    agent._flush_messages_to_session_db([old_user])

    db.fail_once_on_content = "new"
    messages = [old_user, {"role": "user", "content": "new"}]
    agent._flush_messages_to_session_db(messages, conversation_history=[old_user])
    assert [row["content"] for row in db.rows] == ["old"]

    assert repair_message_sequence_with_cursor(agent, messages) == 1
    assert messages == [
        {
            "role": "user",
            "content": "old\n\nnew",
            _DB_PERSISTED_MARKER: old_user[_DB_PERSISTED_MARKER],
        }
    ]

    # The row digest changed when repair merged in the failed message, so the
    # old marker cannot hide the new content on the recovery flush.
    agent._flush_messages_to_session_db(messages)
    assert [row["content"] for row in db.rows] == ["old", "old\n\nnew"]


def test_multimodal_base64_is_not_copied_into_sqlite_or_mutated_in_memory():
    db = _RecordingSessionDB()
    agent = _agent(db)
    data_uri = "data:image/png;base64," + ("A" * 256)
    content = [
        {"type": "text", "text": "describe this"},
        {"type": "image_url", "image_url": {"url": data_uri}},
    ]
    message = {"role": "user", "content": content}

    agent._flush_messages_to_session_db([message])

    assert db.rows[0]["content"] == "describe this\n[screenshot]"
    assert "base64" not in db.rows[0]["content"]
    assert message["content"] is content
    assert message["content"][1]["image_url"]["url"] == data_uri
    assert data_uri not in json.dumps(message[_DB_PERSISTED_MARKER])
    assert db_persisted_marker_matches(message, "session-a", db.rows[0])


def test_private_persistence_marker_never_reaches_model_transports():
    messages = [
        {
            "role": "user",
            "content": "hello",
            _DB_PERSISTED_MARKER: {
                "session_id": "session-a",
                "fingerprint": "private",
            },
        }
    ]

    chat_wire = ChatCompletionsTransport().convert_messages(messages, model="qwen")
    responses_wire = ResponsesApiTransport().convert_messages(messages)

    assert _DB_PERSISTED_MARKER not in chat_wire[0]
    assert _DB_PERSISTED_MARKER not in json.dumps(responses_wire)
    # Sanitization must not strip the marker from the live transcript; it is
    # still needed for the next persistence point.
    assert messages[0][_DB_PERSISTED_MARKER]["session_id"] == "session-a"
