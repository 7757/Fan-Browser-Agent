import sqlite3

import pytest

from fan_state import (
    SessionDB,
    _DB_PERSISTED_MARKER,
    _FTS_HEALTH_PROBE_PREFIX,
    db_persisted_marker_matches,
    db_persisted_row_from_message,
)


def _build_db(path):
    db = SessionDB(path)
    db.create_session("session-1", "test")
    for index in range(4):
        db.append_message(
            "session-1",
            role="user",
            content=f"pizza message {index}",
        )
    db.close()


def test_fts_write_probe_always_rolls_back(tmp_path):
    db_path = tmp_path / "state.db"
    _build_db(db_path)
    db = SessionDB(db_path)
    try:
        before_messages = db.message_count("session-1")
        before_fts = db._conn.execute(
            "SELECT COUNT(*) FROM messages_fts"
        ).fetchone()[0]

        assert db._probe_fts_write_health() is None

        assert db.message_count("session-1") == before_messages
        assert db._conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE id LIKE ?",
            (f"{_FTS_HEALTH_PROBE_PREFIX}%",),
        ).fetchone()[0] == 0
        assert db._conn.execute(
            "SELECT COUNT(*) FROM messages_fts"
        ).fetchone()[0] == before_fts
    finally:
        db.close()


@pytest.mark.parametrize(
    "shadow_table",
    ["messages_fts_data", "messages_fts_trigram_data"],
)
def test_readable_but_unwritable_fts_is_rebuilt_without_canonical_loss(
    tmp_path, shadow_table
):
    db_path = tmp_path / "state.db"
    _build_db(db_path)

    conn = sqlite3.connect(str(db_path), isolation_level=None)
    try:
        canonical_before = conn.execute(
            "SELECT id, session_id, role, content FROM messages ORDER BY id"
        ).fetchall()
        # Canonical reads remain healthy while the derived FTS index is made
        # malformed, reproducing the silent write-loss corruption class.
        conn.execute(
            f"UPDATE {shadow_table} SET block = X'DEADBEEFDEADBEEF'"
        )
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 4
    finally:
        conn.close()

    # SessionDB startup runs the rolled-back write probe, rebuilds both Fan
    # indexes in place, and leaves canonical rows byte-for-byte unchanged.
    repaired = SessionDB(db_path)
    try:
        canonical_after = [
            tuple(row)
            for row in repaired._conn.execute(
                "SELECT id, session_id, role, content FROM messages ORDER BY id"
            ).fetchall()
        ]
        assert canonical_after == canonical_before
        assert repaired._probe_fts_write_health() is None

        repaired.append_message(
            "session-1", role="assistant", content="pizza after repair"
        )
        assert repaired.message_count("session-1") == 5
        assert repaired._conn.execute(
            "SELECT COUNT(*) FROM messages_fts "
            "WHERE messages_fts MATCH 'pizza'"
        ).fetchone()[0] == 5
        assert repaired._conn.execute(
            "SELECT COUNT(*) FROM messages_fts_trigram "
            "WHERE messages_fts_trigram MATCH 'pizza'"
        ).fetchone()[0] == 5
    finally:
        repaired.close()


def test_db_replay_marks_only_the_originating_session_as_durable(tmp_path):
    db_path = tmp_path / "state.db"
    _build_db(db_path)
    db = SessionDB(db_path)
    try:
        replay = db.get_messages_as_conversation("session-1")
        assert len(replay) == 4
        assert all(_DB_PERSISTED_MARKER in message for message in replay)
        assert all(
            db_persisted_marker_matches(
                message,
                "session-1",
                db_persisted_row_from_message(message),
            )
            for message in replay
        )
    finally:
        db.close()


def test_non_fts_write_failure_is_visible_and_never_triggers_rebuild(
    tmp_path, monkeypatch
):
    db_path = tmp_path / "state.db"
    _build_db(db_path)
    db = SessionDB(db_path)
    rebuilt = []
    try:
        monkeypatch.setattr(
            db,
            "_probe_fts_write_health",
            lambda: "database or disk is full",
        )
        monkeypatch.setattr(
            db,
            "_rebuild_fts_indexes_in_place",
            lambda: rebuilt.append(True),
        )

        with pytest.raises(sqlite3.DatabaseError, match="outside FTS"):
            db._ensure_fts_write_health()
        assert rebuilt == []
    finally:
        db.close()


def test_writer_lock_contention_retries_but_never_rebuilds(
    tmp_path, monkeypatch
):
    db_path = tmp_path / "state.db"
    _build_db(db_path)
    db = SessionDB(db_path)
    blocker = sqlite3.connect(str(db_path), isolation_level=None, timeout=0.05)
    rebuilt = []
    try:
        blocker.execute("BEGIN IMMEDIATE")
        monkeypatch.setattr(db, "_WRITE_MAX_RETRIES", 2)
        monkeypatch.setattr(db, "_WRITE_RETRY_MIN_S", 0.001)
        monkeypatch.setattr(db, "_WRITE_RETRY_MAX_S", 0.001)
        monkeypatch.setattr(
            db,
            "_rebuild_fts_indexes_in_place",
            lambda: rebuilt.append(True),
        )

        with pytest.raises(sqlite3.OperationalError, match="could not acquire"):
            db._ensure_fts_write_health()
        assert rebuilt == []
    finally:
        blocker.rollback()
        blocker.close()
        db.close()


def test_atomic_branch_copy_uses_compact_content_and_child_marker(tmp_path):
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path)
    try:
        db.create_session("child", "tui")
        data_uri = "data:image/png;base64," + ("A" * 512)
        db.replace_messages(
            "child",
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "branch image"},
                        {
                            "type": "image_url",
                            "image_url": {"url": data_uri},
                        },
                    ],
                }
            ],
        )

        replay = db.get_messages_as_conversation("child")
        assert replay[0]["content"] == "branch image\n[screenshot]"
        marker_row = db_persisted_row_from_message(replay[0])
        assert db_persisted_marker_matches(replay[0], "child", marker_row)
        stored = db._conn.execute(
            "SELECT content FROM messages WHERE session_id = 'child'"
        ).fetchone()[0]
        assert "base64" not in stored
    finally:
        db.close()
