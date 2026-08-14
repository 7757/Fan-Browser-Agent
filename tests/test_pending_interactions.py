from __future__ import annotations

import threading

from tui_gateway.pending_interactions import PendingInteractionRegistry


def test_pending_request_is_replayable_without_answer_data() -> None:
    registry = PendingInteractionRegistry()
    item = registry.create(
        "session-a",
        "collect.request",
        {"question": "Passport details", "fields": [{"name": "passport"}]},
        request_id="collect-1",
    )

    assert registry.pending_kind("session-a") == "collect"
    assert registry.pending_for_session("session-a") == [
        {
            "question": "Passport details",
            "fields": [{"name": "passport"}],
            "request_id": "collect-1",
            "session_id": "session-a",
            "event": "collect.request",
            "kind": "collect",
            "status": "waiting",
            "created_at": item.created_at,
            "interaction_revision": item.revision,
        }
    ]


def test_snapshot_revision_orders_creates_and_resolutions_atomically() -> None:
    registry = PendingInteractionRegistry()
    epoch, initial_revision, rows = registry.pending_snapshot("session-a")
    assert epoch == registry.epoch
    assert initial_revision == 0
    assert rows == []

    item = registry.create(
        "session-a", "collect.request", {"question": "Passport"}, request_id="one"
    )
    snapshot_epoch, create_revision, rows = registry.pending_snapshot("session-a")
    assert snapshot_epoch == epoch
    assert create_revision == item.revision == 1
    assert rows[0]["interaction_revision"] == create_revision

    registry.respond(item.request_id, "ok")
    _, resolved_revision, rows = registry.pending_snapshot("session-a")
    assert resolved_revision == item.revision == 2
    assert rows == []


def test_response_is_idempotent_and_consumed_value_is_not_retained() -> None:
    registry = PendingInteractionRegistry()
    registry.create("session-a", "collect.request", {}, request_id="collect-1")

    assert registry.respond("collect-1", "sensitive", status="submitted") == (
        "submitted",
        True,
    )
    assert registry.respond("collect-1", "different", status="submitted") == (
        "submitted",
        False,
    )
    assert registry.wait("collect-1", timeout=0).response == "sensitive"
    assert registry.get("collect-1").response == ""


def test_non_submitted_response_data_is_never_retained() -> None:
    registry = PendingInteractionRegistry()
    registry.create("session-a", "collect.request", {}, request_id="collect-1")

    assert registry.respond(
        "collect-1",
        '{"values":{"passport":"must-not-remain"}}',
        status="cancelled",
    ) == ("cancelled", True)
    assert registry.get("collect-1").response == ""
    assert registry.wait("collect-1", timeout=0).response == ""


def test_timeout_and_session_interrupt_are_distinct() -> None:
    registry = PendingInteractionRegistry()
    registry.create("session-a", "collect.request", {}, request_id="expired")
    registry.create("session-a", "control.request", {}, request_id="interrupted")
    registry.create("session-b", "collect.request", {}, request_id="other")

    assert registry.wait("expired", timeout=0).status == "expired"
    assert registry.cancel_session("session-a") == 1
    assert registry.wait("interrupted", timeout=0).status == "interrupted"
    assert registry.pending_kind("session-b") == "collect"


def test_completed_metadata_expires_but_waiting_requests_do_not() -> None:
    registry = PendingInteractionRegistry(completed_ttl_seconds=10)
    completed = registry.create("session-a", "collect.request", {}, request_id="done")
    waiting = registry.create("session-a", "collect.request", {}, request_id="waiting")
    registry.respond("done", "ok")

    assert registry.cleanup(now=(completed.finished_at or 0) + 11) == 1
    assert registry.get("done") is None
    assert registry.get(waiting.request_id) is waiting


def test_generated_request_ids_are_full_strength_uuid_hex() -> None:
    registry = PendingInteractionRegistry()

    item = registry.create("session-a", "collect.request")

    assert len(item.request_id) == 32
    int(item.request_id, 16)


def test_indefinite_wait_keeps_activity_alive_until_response() -> None:
    registry = PendingInteractionRegistry()
    item = registry.create("session-a", "approval.request")
    heartbeat_seen = threading.Event()
    outcome = []

    worker = threading.Thread(
        target=lambda: outcome.append(
            registry.wait(
                item.request_id,
                timeout=None,
                heartbeat=heartbeat_seen.set,
                poll_interval=0.05,
            )
        )
    )
    worker.start()
    assert heartbeat_seen.wait(timeout=1)

    registry.respond(item.request_id, "once")
    worker.join(timeout=1)

    assert not worker.is_alive()
    assert outcome[0].status == "submitted"
    assert outcome[0].response == "once"
