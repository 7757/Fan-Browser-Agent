import json

from tools.file_operations import SearchMatch, SearchResult


def _matches(count: int, path: str = "src/example.py") -> list[SearchMatch]:
    return [
        SearchMatch(path=path, line_number=index + 1, content=f"value {index}")
        for index in range(count)
    ]


def test_search_result_keeps_structured_default() -> None:
    result = SearchResult(matches=_matches(5), total_count=5).to_dict()

    assert "matches" in result
    assert "matches_text" not in result


def test_search_result_keeps_small_opted_in_results_structured() -> None:
    result = SearchResult(matches=_matches(4), total_count=4).to_dict(densify=True)

    assert "matches" in result
    assert "matches_text" not in result


def test_search_result_groups_consecutive_paths_without_losing_content() -> None:
    matches = [
        SearchMatch(path="src/a file.py", line_number=3, content="    indented"),
        SearchMatch(path="src/a file.py", line_number=8, content="trailing   "),
        SearchMatch(path="src/b.py", line_number=1, content=""),
        SearchMatch(path="src/b.py", line_number=2, content="emoji: 🔥"),
        SearchMatch(path="src/b.py", line_number=9, content='x = {"k": "v"}'),
    ]

    result = SearchResult(matches=matches, total_count=5).to_dict(densify=True)

    assert "matches" not in result
    assert result["matches_format"].startswith("path-grouped:")
    assert result["matches_text"] == (
        "src/a file.py\n"
        "  3:     indented\n"
        "  8: trailing   \n"
        "src/b.py\n"
        "  1: \n"
        "  2: emoji: 🔥\n"
        '  9: x = {"k": "v"}'
    )


def test_direct_search_tool_keeps_structured_contract(monkeypatch) -> None:
    from tools import file_tools

    class FakeFileOperations:
        def search(self, **_kwargs) -> SearchResult:
            return SearchResult(matches=_matches(5), total_count=5)

    monkeypatch.setattr(file_tools, "_get_file_ops", lambda _task_id: FakeFileOperations())

    payload = json.loads(file_tools.search_tool("value", task_id="direct-search-test"))

    assert "matches" in payload
    assert "matches_text" not in payload


def test_model_tool_densifies_but_execute_code_contract_stays_structured(
    monkeypatch,
) -> None:
    import model_tools
    from tools import file_tools

    class FakeFileOperations:
        def search(self, **_kwargs) -> SearchResult:
            return SearchResult(matches=_matches(5), total_count=5)

    monkeypatch.setattr(file_tools, "_get_file_ops", lambda _task_id: FakeFileOperations())

    structured_by_default = json.loads(
        model_tools.handle_function_call(
            "search_files", {"pattern": "value"}, task_id="model-search-test"
        )
    )
    compact = json.loads(
        model_tools.handle_function_call(
            "search_files",
            {"pattern": "value"},
            task_id="model-search-compact-test",
            result_mode="model",
        )
    )

    assert "matches_text" in compact
    assert "matches" not in compact
    assert "matches" in structured_by_default
    assert "matches_text" not in structured_by_default
