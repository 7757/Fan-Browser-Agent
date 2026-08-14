from tui_gateway import server


def test_default_nullable_top_level_values_are_not_reported_as_empty_sections():
    warning = server._probe_config_health(
        {
            "max_concurrent_sessions": None,
            "context_file_max_chars": None,
        }
    )

    assert warning == ""


def test_null_mapping_section_is_still_reported():
    warning = server._probe_config_health(
        {"agent": None},
        effective_cfg={"agent": {"personalities": {}}},
    )

    assert "`agent`" in warning
