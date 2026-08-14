import sqlite3

import fan_state
from fan_state import apply_wal_with_fallback


class TracingConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.executed = []

    def execute(self, sql, parameters=()):
        self.executed.append(sql)
        return super().execute(sql, parameters)


def test_macos_fresh_wal_enforces_full_synchronous(tmp_path, monkeypatch):
    monkeypatch.setattr(fan_state.sys, "platform", "darwin")
    connection = TracingConnection(str(tmp_path / "fresh.db"))
    try:
        assert apply_wal_with_fallback(connection) == "wal"
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert "PRAGMA checkpoint_fullfsync=1" in connection.executed
        assert "PRAGMA synchronous=FULL" in connection.executed
    finally:
        connection.close()


def test_macos_existing_wal_also_enforces_full_synchronous(tmp_path, monkeypatch):
    db_path = tmp_path / "existing.db"
    with sqlite3.connect(db_path) as seed:
        seed.execute("PRAGMA journal_mode=WAL")

    monkeypatch.setattr(fan_state.sys, "platform", "darwin")
    connection = TracingConnection(str(db_path))
    try:
        assert apply_wal_with_fallback(connection) == "wal"
        assert "PRAGMA synchronous=FULL" in connection.executed
        assert "PRAGMA journal_mode=WAL" not in connection.executed
    finally:
        connection.close()


def test_non_macos_wal_does_not_change_synchronous_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(fan_state.sys, "platform", "linux")
    connection = TracingConnection(str(tmp_path / "linux.db"))
    try:
        assert apply_wal_with_fallback(connection) == "wal"
        assert "PRAGMA checkpoint_fullfsync=1" not in connection.executed
        assert "PRAGMA synchronous=FULL" not in connection.executed
    finally:
        connection.close()


def test_macos_synchronous_full_is_best_effort(monkeypatch):
    class UnsupportedConnection:
        def execute(self, sql):
            raise sqlite3.OperationalError("unsupported pragma")

    monkeypatch.setattr(fan_state.sys, "platform", "darwin")

    fan_state._enforce_macos_synchronous_full(UnsupportedConnection())
