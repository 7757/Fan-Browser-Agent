from __future__ import annotations

import json

from tools.collect_tool import COLLECT_SCHEMA, FIELD_TYPES, collect_tool
from tools.transient_values import is_value_ref, resolve_value_ref


def _result(payload: dict) -> str:
    return collect_tool(
        question=payload.get("question", ""),
        choices=payload.get("choices"),
        fields=payload.get("fields"),
        questions=payload.get("questions"),
        submit_label=payload.get("submit_label"),
        skip_label=payload.get("skip_label"),
        submitted_label=payload.get("submitted_label"),
        skipped_label=payload.get("skipped_label"),
        callback=payload["callback"],
    )


def test_schema_exposes_multistep_questionnaire() -> None:
    properties = COLLECT_SCHEMA["parameters"]["properties"]

    assert "questions" in properties
    assert {"submit_label", "skip_label", "submitted_label", "skipped_label"}.issubset(properties)
    assert properties["questions"]["maxItems"] == 12
    assert set(properties["fields"]["items"]["properties"]["type"]["enum"]) == set(
        FIELD_TYPES
    )
    assert {
        "date_range", "datetime", "datetime_range", "time", "time_range"
    }.issubset(FIELD_TYPES)
    step_description = properties["fields"]["items"]["properties"]["step"]["description"]
    assert "days for date/date_range" in step_description
    assert "seconds for time" in step_description


def test_temporal_range_normalizes_constraints_and_protects_both_values() -> None:
    captured: list[dict] = []
    result = collect_tool(
        question="选择预约时间段",
        fields=[{
            "name": "appointment_start",
            "end_name": "appointment_end",
            "end_label": "结束时间",
            "label": "预约时段",
            "type": "datetime_range",
            "min": "2026-07-27T09:00",
            "max": "2026-07-31T17:00",
            "step": 1800,
            "timezone": "Asia/Shanghai",
            "disabled_dates": ["2026-07-28"],
            "disabled_weekdays": [0, 6],
        }],
        callback=lambda payload: captured.append(payload) or json.dumps({
            "status": "submitted",
            "values": {
                "appointment_start": "2026-07-27T09:00",
                "appointment_end": "2026-07-27T10:00",
            },
        }),
    )

    field = captured[0]["fields"][0]
    assert field["end_name"] == "appointment_end"
    assert field["disabled_weekdays"] == [0, 6]
    parsed = json.loads(result)
    assert is_value_ref(parsed["values"]["appointment_start"])
    assert is_value_ref(parsed["values"]["appointment_end"])
    assert resolve_value_ref(parsed["values"]["appointment_end"]) == "2026-07-27T10:00"


def test_temporal_range_requires_end_name() -> None:
    parsed = json.loads(collect_tool(
        question="选择日期范围",
        fields=[{"name": "start", "label": "日期", "type": "date_range"}],
        callback=lambda _payload: "",
    ))

    assert "requires non-empty `end_name`" in parsed["error"]


def test_temporal_constraints_are_rejected_before_prompting_user() -> None:
    cases = [
        (
            {"name": "day", "label": "日期", "type": "date", "min": "2026-02-29"},
            "min must be a valid ISO date value",
        ),
        (
            {
                "name": "day",
                "label": "日期",
                "type": "date",
                "min": "2026-08-01",
                "max": "2026-07-01",
            },
            "min must not be later than max",
        ),
        (
            {
                "name": "time",
                "label": "时间",
                "type": "time",
                "disabled_dates": ["2026-07-27"],
            },
            "disabled_dates is not valid for time fields",
        ),
        (
            {
                "name": "time",
                "label": "时间",
                "type": "time",
                "disabled_weekdays": [1],
            },
            "disabled_weekdays is not valid for time fields",
        ),
        (
            {
                "name": "day",
                "label": "日期",
                "type": "date",
                "disabled_dates": ["2026-02-29"],
            },
            "disabled_dates contains invalid ISO date",
        ),
        (
            {
                "name": "day",
                "label": "日期",
                "type": "date",
                "step": float("nan"),
            },
            "step must be a positive number",
        ),
    ]

    for field, expected_error in cases:
        parsed = json.loads(collect_tool(
            question="选择时间",
            fields=[field],
            callback=lambda _payload: "",
        ))

        assert expected_error in parsed["error"]


def test_backend_discards_invalid_temporal_values_before_protection() -> None:
    invalid_values = {
        "appointment_day": "2026-02-29",
        "appointment_time": "25:99",
        "appointment_at": "2026-04-31T10:00",
    }
    parsed = json.loads(collect_tool(
        question="选择预约时间",
        fields=[
            {
                "name": "appointment_day",
                "label": "预约日期",
                "type": "date",
            },
            {
                "name": "appointment_time",
                "label": "预约时间",
                "type": "time",
            },
            {
                "name": "appointment_at",
                "label": "预约日期时间",
                "type": "datetime",
            },
        ],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": invalid_values,
        }),
    ))

    assert parsed["invalid_fields"] == sorted(invalid_values)
    assert parsed["requires_recollection"] is True
    assert parsed["missing_fields"] == sorted(invalid_values)
    assert "values" not in parsed
    assert all(value not in json.dumps(parsed) for value in invalid_values.values())


def test_structured_temporal_form_discards_undeclared_answer_echo() -> None:
    invalid_date = "2026-02-29"
    parsed = json.loads(collect_tool(
        question="选择预约日期",
        fields=[{
            "name": "appointment_day",
            "label": "预约日期",
            "type": "date",
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answer": invalid_date,
            "values": {"appointment_day": invalid_date},
        }),
    ))

    assert parsed["user_response"] == ""
    assert parsed["invalid_fields"] == ["appointment_day"]
    assert parsed["requires_recollection"] is True
    assert invalid_date not in json.dumps(parsed)


def test_questionnaire_temporal_form_discards_undeclared_answer_echo() -> None:
    invalid_date = "2026-02-29"
    parsed = json.loads(collect_tool(
        question="预约信息",
        questions=[{
            "id": "appointment",
            "question": "选择预约日期",
            "fields": [{
                "name": "appointment_day",
                "label": "预约日期",
                "type": "date",
            }],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {
                "appointment": {
                    "answer": invalid_date,
                    "values": {"appointment_day": invalid_date},
                },
            },
        }),
    ))

    assert parsed["invalid_fields"] == ["appointment_day"]
    assert parsed["requires_recollection"] is True
    assert invalid_date not in json.dumps(parsed)


def test_backend_enforces_temporal_step_and_disabled_weekday() -> None:
    parsed = json.loads(collect_tool(
        question="选择预约日期和时间",
        fields=[
            {
                "name": "appointment_day",
                "label": "预约日期",
                "type": "date",
                "min": "2026-07-27",
                "step": 2,
            },
            {
                "name": "appointment_time",
                "label": "预约时间",
                "type": "time",
                "min": "09:00",
                "step": 1800,
            },
            {
                "name": "blocked_day",
                "label": "不可选日期",
                "type": "date",
                "disabled_weekdays": [3],
            },
        ],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {
                "appointment_day": "2026-07-28",
                "appointment_time": "09:15",
                "blocked_day": "2026-07-29",
            },
        }),
    ))

    assert parsed["invalid_fields"] == [
        "appointment_day",
        "appointment_time",
        "blocked_day",
    ]
    assert parsed["requires_recollection"] is True
    assert "values" not in parsed


def test_optional_temporal_range_is_empty_or_complete() -> None:
    parsed = json.loads(collect_tool(
        question="可选日期范围",
        fields=[{
            "name": "start_day",
            "end_name": "end_day",
            "label": "日期范围",
            "type": "date_range",
            "required": False,
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {"start_day": "2026-07-27"},
        }),
    ))

    assert parsed["invalid_fields"] == ["end_day", "start_day"]
    assert parsed["requires_recollection"] is True
    assert "values" not in parsed
    assert "missing_fields" not in parsed


def test_backend_discards_both_range_values_when_one_endpoint_is_invalid() -> None:
    parsed = json.loads(collect_tool(
        question="日期范围",
        fields=[{
            "name": "start_day",
            "end_name": "end_day",
            "label": "日期范围",
            "type": "date_range",
            "min": "2026-07-27",
            "step": 2,
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {
                "start_day": "2026-07-27",
                "end_day": "2026-07-28",
            },
        }),
    ))

    assert parsed["invalid_fields"] == ["end_day", "start_day"]
    assert parsed["missing_fields"] == ["end_day", "start_day"]
    assert parsed["requires_recollection"] is True
    assert "values" not in parsed


def test_top_level_select_accepts_only_declared_options() -> None:
    valid = json.loads(collect_tool(
        question="选择部门",
        fields=[{
            "name": "department",
            "label": "部门",
            "type": "select",
            "options": ["技术部", "市场部", "财务部"],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {"department": "技术部"},
        }, ensure_ascii=False),
    ))

    department_ref = valid["values"]["department"]
    assert is_value_ref(department_ref)
    assert resolve_value_ref(department_ref) == "技术部"
    assert "requires_recollection" not in valid

    invalid_result = collect_tool(
        question="选择部门",
        fields=[{
            "name": "department",
            "label": "部门",
            "type": "select",
            "options": ["技术部", "市场部", "财务部"],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {"department": "营销部门"},
        }, ensure_ascii=False),
    )
    invalid = json.loads(invalid_result)

    assert invalid["invalid_fields"] == ["department"]
    assert invalid["missing_fields"] == ["department"]
    assert invalid["requires_recollection"] is True
    assert "values" not in invalid
    assert "营销部门" not in invalid_result


def test_questionnaire_select_rejects_value_outside_declared_options() -> None:
    result = collect_tool(
        question="填写资料",
        questions=[{
            "id": "profile",
            "question": "选择部门",
            "fields": [{
                "name": "department",
                "label": "部门",
                "type": "select",
                "options": ["技术部", "市场部", "财务部"],
            }],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {
                "profile": {"values": {"department": "营销部门"}},
            },
        }, ensure_ascii=False),
    )
    parsed = json.loads(result)

    assert parsed["invalid_fields"] == ["department"]
    assert parsed["missing_fields"] == ["department"]
    assert parsed["requires_recollection"] is True
    assert parsed["answers"]["profile"] == {}
    assert "营销部门" not in result


def test_question_choices_are_closed_by_default_and_allow_explicit_other() -> None:
    captured: list[dict] = []
    closed_result = collect_tool(
        question="选择部门",
        questions=[{
            "id": "department",
            "question": "请选择部门",
            "choices": ["技术部", "市场部", "财务部"],
        }],
        callback=lambda payload: captured.append(payload) or json.dumps({
            "status": "submitted",
            "answers": {"department": {"answer": "营销部门"}},
        }, ensure_ascii=False),
    )
    closed = json.loads(closed_result)

    assert captured[0]["questions"][0]["allow_other"] is False
    assert closed["invalid_questions"] == ["department"]
    assert closed["missing_questions"] == ["department"]
    assert closed["requires_recollection"] is True
    assert "营销部门" not in closed_result

    open_result = collect_tool(
        question="选择部门",
        questions=[{
            "id": "department",
            "question": "请选择或填写部门",
            "choices": ["技术部", "市场部", "财务部"],
            "allow_other": True,
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {"department": {"answer": "营销部门"}},
        }, ensure_ascii=False),
    )
    opened = json.loads(open_result)

    assert opened["answers"]["department"]["answer"] == "营销部门"
    assert "invalid_questions" not in opened
    assert "requires_recollection" not in opened


def test_closed_question_enforces_single_and_multiple_cardinality() -> None:
    single = json.loads(collect_tool(
        question="选择部门",
        questions=[{
            "id": "department",
            "question": "请选择一个部门",
            "choices": ["技术部", "市场部"],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {"department": {"answer": ["技术部", "市场部"]}},
        }, ensure_ascii=False),
    ))

    assert single["invalid_questions"] == ["department"]
    assert single["requires_recollection"] is True

    multiple = json.loads(collect_tool(
        question="选择部门",
        questions=[{
            "id": "department",
            "question": "请选择部门",
            "choices": ["技术部", "市场部"],
            "multiple": True,
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {"department": {"answer": ["技术部", "市场部"]}},
        }, ensure_ascii=False),
    ))

    assert multiple["answers"]["department"]["answer"] == ["技术部", "市场部"]
    assert "requires_recollection" not in multiple


def test_required_question_cannot_be_bypassed_with_per_question_skip() -> None:
    result = collect_tool(
        question="填写资料",
        questions=[{
            "id": "profile",
            "question": "选择部门",
            "fields": [{
                "name": "department",
                "label": "部门",
                "type": "select",
                "options": ["技术部", "市场部"],
            }],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {
                "profile": {
                    "skipped": True,
                    "answer": "营销部门",
                    "values": {"department": "营销部门"},
                },
            },
        }, ensure_ascii=False),
    )
    parsed = json.loads(result)

    assert parsed["missing_questions"] == ["profile"]
    assert parsed["missing_fields"] == ["department"]
    assert parsed["requires_recollection"] is True
    assert "values" not in parsed
    assert parsed["answers"]["profile"] == {"skipped": True}
    assert "营销部门" not in result


def test_optional_skipped_question_discards_attached_select_values() -> None:
    result = collect_tool(
        question="补充资料",
        questions=[{
            "id": "profile",
            "question": "选择部门",
            "required": False,
            "fields": [{
                "name": "department",
                "label": "部门",
                "type": "select",
                "options": ["技术部", "市场部"],
            }],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "answers": {
                "profile": {
                    "skipped": True,
                    "answer": "营销部门",
                    "values": {"department": "营销部门"},
                },
            },
        }, ensure_ascii=False),
    )
    parsed = json.loads(result)

    assert parsed["answers"]["profile"] == {"skipped": True}
    assert "values" not in parsed
    assert "invalid_fields" not in parsed
    assert "missing_fields" not in parsed
    assert "requires_recollection" not in parsed
    assert "营销部门" not in result


def test_required_and_optional_empty_selects_have_distinct_recollection_semantics() -> None:
    required = json.loads(collect_tool(
        question="选择部门",
        fields=[{
            "name": "department",
            "label": "部门",
            "type": "select",
            "options": ["技术部", "市场部"],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {},
        }),
    ))

    assert required["missing_fields"] == ["department"]
    assert required["requires_recollection"] is True

    optional = json.loads(collect_tool(
        question="选择部门",
        fields=[{
            "name": "department",
            "label": "部门",
            "type": "select",
            "required": False,
            "options": ["技术部", "市场部"],
        }],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {},
        }),
    ))

    assert "missing_fields" not in optional
    assert "requires_recollection" not in optional


def test_select_and_temporal_invalid_fields_are_merged() -> None:
    result = collect_tool(
        question="选择部门和日期",
        fields=[
            {
                "name": "department",
                "label": "部门",
                "type": "select",
                "options": ["技术部", "市场部"],
            },
            {
                "name": "appointment_day",
                "label": "预约日期",
                "type": "date",
            },
        ],
        callback=lambda _payload: json.dumps({
            "status": "submitted",
            "values": {
                "department": "营销部门",
                "appointment_day": "2026-02-29",
            },
        }, ensure_ascii=False),
    )
    parsed = json.loads(result)

    assert parsed["invalid_fields"] == ["appointment_day", "department"]
    assert parsed["missing_fields"] == ["appointment_day", "department"]
    assert parsed["requires_recollection"] is True
    assert "values" not in parsed
    assert "营销部门" not in result
    assert "2026-02-29" not in result


def test_questionnaire_is_normalized_before_platform_callback() -> None:
    captured: list[dict] = []

    result = _result(
        {
            "question": "签证申请资料",
            "questions": [
                {
                    "id": "purpose",
                    "question": "出行目的是什么？",
                    "choices": ["旅游", {"label": "商务"}],
                },
                {
                    "id": "passport",
                    "question": "请提供护照信息",
                    "fields": [
                        {
                            "name": "passport_number",
                            "label": "护照号",
                            "type": "passport",
                        }
                    ],
                },
                {
                    "id": "company",
                    "question": "请提供邀请公司",
                    "depends_on": {
                        "question_id": "purpose",
                        "operator": "equals",
                        "value": "商务",
                    },
                    "fields": [
                        {
                            "name": "company_name",
                            "label": "公司名称",
                            "type": "text",
                        }
                    ],
                },
            ],
            "submit_label": "提交全部资料",
            "skip_label": "稍后填写",
            "submitted_label": "资料已提供",
            "skipped_label": "资料暂未填写",
            "callback": lambda payload: captured.append(payload)
            or json.dumps(
                {
                    "status": "submitted",
                    "answers": {
                        "purpose": {"answer": "旅游"},
                        "passport": {
                            "values": {"passport_number": "N1234567"}
                        },
                    },
                },
                ensure_ascii=False,
            ),
        }
    )

    request = captured[0]
    assert request["questions"][0]["choices"] == ["旅游", "商务"]
    assert request["questions"][2]["depends_on"]["question_id"] == "purpose"
    assert request["submit_label"] == "提交全部资料"
    assert request["skip_label"] == "稍后填写"
    assert request["submitted_label"] == "资料已提供"
    assert request["skipped_label"] == "资料暂未填写"

    parsed = json.loads(result)
    assert parsed["status"] == "submitted"
    passport_ref = parsed["values"]["passport_number"]
    assert is_value_ref(passport_ref)
    assert resolve_value_ref(passport_ref) == "N1234567"
    assert parsed["answers"]["passport"]["values"]["passport_number"] == passport_ref
    assert parsed["values_protected"] is True
    assert "company_name" not in parsed.get("missing_fields", [])


def test_questionnaire_rejects_forward_dependency() -> None:
    result = collect_tool(
        question="资料",
        questions=[
            {
                "id": "later-dependent",
                "question": "条件题",
                "depends_on": {
                    "question_id": "future",
                    "operator": "equals",
                    "value": "yes",
                },
            },
            {"id": "future", "question": "前置题"},
        ],
        callback=lambda _payload: "",
    )

    assert "before it is defined" in json.loads(result)["error"]


def test_questionnaire_reports_only_visible_required_answers() -> None:
    result = collect_tool(
        question="资料",
        questions=[
            {
                "id": "has_companion",
                "question": "有同行人吗？",
                "choices": ["有", "没有"],
            },
            {
                "id": "companion",
                "question": "同行人姓名",
                "depends_on": {
                    "question_id": "has_companion",
                    "operator": "equals",
                    "value": "有",
                },
            },
            {"id": "email", "question": "联系邮箱"},
        ],
        callback=lambda _payload: json.dumps(
            {
                "status": "submitted",
                "answers": {
                    "has_companion": {"answer": "没有"},
                },
            },
            ensure_ascii=False,
        ),
    )

    parsed = json.loads(result)
    assert parsed["missing_questions"] == ["email"]
    assert "companion" not in parsed["missing_questions"]


def test_interrupted_interaction_is_not_reported_as_skip() -> None:
    result = collect_tool(
        question="护照号",
        callback=lambda _payload: json.dumps(
            {"status": "interrupted", "skipped": False}
        ),
    )

    parsed = json.loads(result)
    assert parsed["status"] == "interrupted"
    assert parsed["skipped"] is False
    assert "interrupted" in parsed["error"]


def test_per_question_skip_is_explicit_and_not_reported_missing() -> None:
    result = collect_tool(
        question="资料",
        questions=[{
            "id": "optional_by_user",
            "question": "可否提供公司名称？",
            "required": False,
        }],
        callback=lambda _payload: json.dumps(
            {
                "status": "submitted",
                "answers": {"optional_by_user": {"skipped": True}},
            }
        ),
    )

    parsed = json.loads(result)
    assert parsed["answers"]["optional_by_user"] == {"skipped": True}
    assert "missing_questions" not in parsed


def test_hidden_branch_and_descendants_are_removed_from_submitted_data() -> None:
    result = collect_tool(
        question="资料",
        questions=[
            {
                "id": "purpose",
                "question": "出行目的",
                "choices": ["旅游", "商务"],
            },
            {
                "id": "company",
                "question": "邀请公司",
                "depends_on": {
                    "question_id": "purpose",
                    "operator": "equals",
                    "value": "商务",
                },
                "fields": [
                    {"name": "company_name", "label": "公司", "type": "text"}
                ],
            },
            {
                "id": "contact",
                "question": "公司联系人",
                "depends_on": {
                    "question_id": "company",
                    "operator": "not_empty",
                },
                "fields": [
                    {"name": "contact_name", "label": "联系人", "type": "text"}
                ],
            },
        ],
        callback=lambda _payload: json.dumps(
            {
                "status": "submitted",
                "answers": {
                    "purpose": {"answer": "旅游"},
                    "company": {"values": {"company_name": "Old Company"}},
                    "contact": {"values": {"contact_name": "Old Contact"}},
                },
                "values": {
                    "company_name": "Old Company",
                    "contact_name": "Old Contact",
                    "injected": "must disappear",
                },
            },
            ensure_ascii=False,
        ),
    )

    parsed = json.loads(result)
    assert parsed["answers"] == {"purpose": {"answer": "旅游"}}
    assert "values" not in parsed
    assert "missing_fields" not in parsed


def test_non_submitted_response_discards_attached_user_data() -> None:
    for status in ("skipped", "cancelled", "expired", "interrupted"):
        secret = f"must-not-leak-{status}"
        result = collect_tool(
            question="资料",
            fields=[{"name": "passport", "label": "护照号", "type": "passport"}],
            callback=lambda _payload, status=status, secret=secret: json.dumps(
                {
                    "status": status,
                    "answer": secret,
                    "values": {"passport": secret},
                    "answers": {
                        "injected": {
                            "answer": secret,
                            "values": {"passport": secret},
                        }
                    },
                }
            ),
        )

        parsed = json.loads(result)
        assert parsed["status"] == status
        assert parsed["user_response"] == ""
        assert "values" not in parsed
        assert "answers" not in parsed
        assert secret not in result


def test_unknown_explicit_response_status_fails_closed() -> None:
    secret = "must-not-leak-invalid-status"
    result = collect_tool(
        question="资料",
        fields=[{"name": "passport", "label": "护照号", "type": "passport"}],
        callback=lambda _payload: json.dumps(
            {
                "status": "done",
                "answer": secret,
                "values": {"passport": secret},
            }
        ),
    )

    parsed = json.loads(result)
    assert parsed["status"] == "cancelled"
    assert parsed["error"] == "Collect interaction returned an invalid status."
    assert secret not in result


def test_required_question_with_choices_and_fields_requires_both() -> None:
    result = collect_tool(
        question="购买选项",
        questions=[
            {
                "id": "plan",
                "question": "选择套餐并填写联系人",
                "choices": ["专业版", "企业版"],
                "fields": [
                    {"name": "contact", "label": "联系人", "type": "text"}
                ],
            }
        ],
        callback=lambda _payload: json.dumps(
            {
                "status": "submitted",
                "answers": {"plan": {"values": {"contact": "Fan User"}}},
            },
            ensure_ascii=False,
        ),
    )

    parsed = json.loads(result)
    assert parsed["missing_questions"] == ["plan"]
    assert "missing_fields" not in parsed


def test_optional_untouched_question_does_not_require_its_fields() -> None:
    result = collect_tool(
        question="补充资料",
        questions=[
            {
                "id": "optional_company",
                "question": "公司资料",
                "required": False,
                "fields": [
                    {"name": "company", "label": "公司", "type": "text"},
                    {"name": "title", "label": "职位", "type": "text"},
                ],
            }
        ],
        callback=lambda _payload: json.dumps(
            {"status": "submitted", "answers": {}}
        ),
    )

    parsed = json.loads(result)
    assert "missing_fields" not in parsed
    assert "missing_questions" not in parsed


def test_optional_question_requires_remaining_fields_once_started() -> None:
    result = collect_tool(
        question="补充资料",
        questions=[
            {
                "id": "optional_company",
                "question": "公司资料",
                "required": False,
                "fields": [
                    {"name": "company", "label": "公司", "type": "text"},
                    {"name": "title", "label": "职位", "type": "text"},
                ],
            }
        ],
        callback=lambda _payload: json.dumps(
            {
                "status": "submitted",
                "answers": {
                    "optional_company": {"values": {"company": "Fan"}}
                },
            }
        ),
    )

    parsed = json.loads(result)
    assert parsed["missing_fields"] == ["title"]
