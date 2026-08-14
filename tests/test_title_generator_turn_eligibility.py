import pytest

from agent.title_generator import set_auto_generated_title, should_auto_title_turn


def test_completed_opening_exchange_is_eligible_for_auto_title():
    assert should_auto_title_turn("complete", "帮我申请签证", "我先打开官网")


def test_interrupted_opening_exchange_is_still_eligible_for_auto_title():
    assert should_auto_title_turn(
        "interrupted",
        "帮我申请签证",
        "Operation interrupted.",
    )


def test_failed_or_empty_turn_is_not_eligible_for_auto_title():
    assert not should_auto_title_turn("error", "帮我申请签证", "Provider failed")
    assert not should_auto_title_turn("complete", "", "我先打开官网")
    assert not should_auto_title_turn("complete", "帮我申请签证", "   ")


class FakeSessionDb:
    def __init__(self, existing=()):
        self.titles = set(existing)

    def set_session_title(self, _session_id, title):
        if title in self.titles:
            raise ValueError(f"Title '{title}' is already in use")
        self.titles.add(title)
        return True


def test_auto_title_disambiguates_repeated_user_intents():
    db = FakeSessionDb({"新西兰网签申请", "新西兰网签申请 #2"})

    assert set_auto_generated_title(db, "session-3", "新西兰网签申请") == "新西兰网签申请 #3"


def test_auto_title_does_not_hide_non_uniqueness_validation_errors():
    class InvalidTitleDb(FakeSessionDb):
        def set_session_title(self, _session_id, _title):
            raise ValueError("Title contains invalid characters")

    with pytest.raises(ValueError, match="invalid characters"):
        set_auto_generated_title(InvalidTitleDb(), "session-1", "bad title")
