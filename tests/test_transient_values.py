from __future__ import annotations

from tools.transient_values import TransientValueStore, is_value_ref


def test_reference_is_owner_scoped_and_never_contains_value() -> None:
    store = TransientValueStore(ttl_seconds=60)
    reference = store.put("session-a", "N12345678", field_type="passport")

    assert is_value_ref(reference)
    assert "N12345678" not in reference
    assert store.resolve("session-a", reference) == "N12345678"
    assert store.resolve("session-b", reference) is None


def test_reference_expires_and_session_cleanup_removes_values() -> None:
    store = TransientValueStore(ttl_seconds=1)
    first = store.put("session-a", "secret-a")
    second = store.put("session-b", "secret-b")

    assert store.cleanup(now=10**12) == 2
    assert store.resolve("session-a", first) is None
    assert store.resolve("session-b", second) is None

    third = store.put("session-a", "secret-c")
    assert store.clear_owner("session-a") == 1
    assert store.resolve("session-a", third) is None


def test_reference_survives_durable_session_key_rotation() -> None:
    store = TransientValueStore(ttl_seconds=60)
    reference = store.put("session-old", "P1234567", field_type="passport")

    assert store.transfer_owner("session-old", "session-new") == 1
    assert store.resolve("session-old", reference) is None
    assert store.resolve("session-new", reference) == "P1234567"


def test_redaction_removes_exact_and_formatted_browser_echoes() -> None:
    store = TransientValueStore(ttl_seconds=60)
    store.put(
        "session-a",
        "13800138000",
        field_type="phone",
        label="手机号",
    )
    store.put(
        "session-a",
        "User@Example.com",
        field_type="email",
        label="邮箱",
    )

    redacted = store.redact(
        "session-a",
        {
            "value": "138 0013 8000",
            "text": "账号 user@example.com 已填写",
            "other": "public",
        },
    )

    assert redacted == {
        "value": "[PROTECTED:手机号]",
        "text": "账号 [PROTECTED:邮箱] 已填写",
        "other": "public",
    }


def test_short_values_are_only_redacted_on_exact_match() -> None:
    store = TransientValueStore(ttl_seconds=60)
    store.put("session-a", "US", field_type="country", label="国家")

    assert store.redact("session-a", "US") == "[PROTECTED:国家]"
    assert store.redact("session-a", "STATUS: READY") == "STATUS: READY"
