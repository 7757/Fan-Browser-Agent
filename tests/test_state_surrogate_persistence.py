from fan_state import SessionDB


DIRTY_TEXT = "scraped \ud835 price"
CLEAN_TEXT = "scraped \ufffd price"


def test_append_message_scrubs_lone_surrogates_from_text_fields(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("session-1", "test")
        db.append_message("session-1", role="user", content=DIRTY_TEXT)
        db.append_message(
            "session-1",
            role="assistant",
            content="answer",
            reasoning=DIRTY_TEXT,
            reasoning_content=DIRTY_TEXT,
        )

        messages = db.get_messages_as_conversation("session-1")
        assert messages[0]["content"] == CLEAN_TEXT
        assert messages[1]["reasoning"] == CLEAN_TEXT
        assert messages[1]["reasoning_content"] == CLEAN_TEXT
    finally:
        db.close()


def test_replace_messages_survives_poisoned_text_and_keeps_unicode(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("session-1", "test")
        db.replace_messages(
            "session-1",
            [
                {"role": "user", "content": DIRTY_TEXT},
                {
                    "role": "assistant",
                    "content": "正常文本 🚀 café",
                    "reasoning": DIRTY_TEXT,
                    "reasoning_content": DIRTY_TEXT,
                },
            ],
        )

        messages = db.get_messages_as_conversation("session-1")
        assert messages[0]["content"] == CLEAN_TEXT
        assert messages[1]["content"] == "正常文本 🚀 café"
        assert messages[1]["reasoning"] == CLEAN_TEXT
        assert messages[1]["reasoning_content"] == CLEAN_TEXT
    finally:
        db.close()
