#!/usr/bin/env python3
"""
Collect Tool - Unified user-information collection.

One tool, three shapes, chosen by the model per situation:

1. **Question / choices**: ask a question, optionally with up
   to 12 predefined choices. The user picks one or types a free-form answer.
2. **Structured fields**: request typed values the agent is missing —
   phone numbers, SMS OTP codes, text captchas, credit-card numbers, ID
   numbers, invoice numbers, files for upload, arbitrary form data. The
   desktop renders a typed form (masking, validation, local encrypted
   remember-vault) and returns a `{name: fan-value://...}` map whose opaque
   references can only be resolved at the local browser-action boundary.
3. **Questionnaire**: a multi-step `questions` list with conditional branches,
   per-step choices/free text/typed fields, progress, and one final submission.

The user-interaction logic lives in the platform layer (the desktop gateway
blocks on `collect.respond`). This module defines the schema, validation, and
a thin dispatcher delegating to the platform callback.
"""

import json
import math
import re
from datetime import date as Date
from typing import Any, Dict, List, Optional, Callable

# A free-text "Other" option can be offered by the UI in addition to these.
MAX_CHOICES = 12
MAX_QUESTIONS = 12

# Field types the desktop form knows how to render/validate. `otp` and
# `captcha` are one-time values and are never persisted by the renderer vault.
FIELD_TYPES = frozenset({
    "text", "textarea", "phone", "otp", "captcha", "credit_card",
    "id_number", "passport", "document_number", "email", "number",
    "date", "date_range", "datetime", "datetime_range", "time", "time_range",
    "select", "country", "address", "file", "secret", "consent",
})
RANGE_FIELD_TYPES = frozenset({"date_range", "datetime_range", "time_range"})
TEMPORAL_FIELD_TYPES = frozenset({
    "date", "date_range", "datetime", "datetime_range", "time", "time_range"
})

CONDITION_OPERATORS = frozenset(
    {"equals", "not_equals", "includes", "not_empty"}
)


def _flatten_choice(value: Any) -> str:
    """Return only the user-facing text from a model-emitted option value."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("label", "description", "text", "title", "value"):
            nested = value.get(key)
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(
            part for part in (_flatten_choice(item) for item in value) if part
        ).strip()
    return str(value).strip()


def _normalize_fields(
    fields: Any,
    *,
    seen_names: Optional[set[str]] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Validate/normalize the `fields` argument. Returns None when absent,
    raises ValueError with a model-actionable message when malformed."""
    if fields is None:
        return None
    if not isinstance(fields, list):
        raise ValueError("fields must be a list of field objects.")

    normalized: List[Dict[str, Any]] = []
    known_names = seen_names if seen_names is not None else set()
    for raw in fields:
        if not isinstance(raw, dict):
            raise ValueError("each field must be an object.")
        name = str(raw.get("name") or "").strip()
        if not name:
            raise ValueError("each field requires a non-empty `name`.")
        if name in known_names:
            raise ValueError(f"duplicate field name: {name}")
        known_names.add(name)

        ftype = str(raw.get("type") or "text").strip().lower()
        if ftype not in FIELD_TYPES:
            raise ValueError(
                f"field `{name}` has unknown type `{ftype}`; "
                f"valid types: {', '.join(sorted(FIELD_TYPES))}"
            )
        end_name = str(raw.get("end_name") or raw.get("endName") or "").strip()
        if ftype in RANGE_FIELD_TYPES:
            if not end_name:
                raise ValueError(f"range field `{name}` requires non-empty `end_name`.")
            if end_name in known_names:
                raise ValueError(f"duplicate field name: {end_name}")
            known_names.add(end_name)

        field: Dict[str, Any] = {
            "name": name,
            "label": str(raw.get("label") or name).strip(),
            "type": ftype,
            "required": bool(raw.get("required", True)),
        }
        placeholder = str(raw.get("placeholder") or "").strip()
        if placeholder:
            field["placeholder"] = placeholder
        if end_name:
            field["end_name"] = end_name
            end_label = str(raw.get("end_label") or raw.get("endLabel") or "").strip()
            if end_label:
                field["end_label"] = end_label
        if ftype in TEMPORAL_FIELD_TYPES:
            base_type = _temporal_base_type(ftype)
            for key in ("min", "max", "timezone"):
                value = str(raw.get(key) or "").strip()
                if value:
                    field[key] = value
            for key in ("min", "max"):
                if field.get(key) and _temporal_scalar(
                    str(base_type), str(field[key])
                ) is None:
                    raise ValueError(
                        f"temporal field `{name}` {key} must be a valid ISO "
                        f"{base_type} value."
                    )
            if field.get("min") and field.get("max") and _temporal_scalar(
                str(base_type), str(field["min"])
            ) > _temporal_scalar(str(base_type), str(field["max"])):
                raise ValueError(
                    f"temporal field `{name}` min must not be later than max."
                )
            step = raw.get("step")
            if step is not None:
                if (
                    isinstance(step, bool)
                    or not isinstance(step, (int, float))
                    or not math.isfinite(step)
                    or step <= 0
                ):
                    raise ValueError(f"temporal field `{name}` step must be a positive number.")
                field["step"] = step
            disabled_dates = raw.get("disabled_dates", raw.get("disabledDates"))
            if disabled_dates is not None:
                if not isinstance(disabled_dates, list):
                    raise ValueError(f"temporal field `{name}` disabled_dates must be a list.")
                normalized_dates = [
                    value for value in (_flatten_choice(item) for item in disabled_dates)
                    if value
                ]
                if normalized_dates and base_type == "time":
                    raise ValueError(
                        f"temporal field `{name}` disabled_dates is not valid for time fields."
                    )
                invalid_date = next(
                    (value for value in normalized_dates if _date_parts(value) is None),
                    None,
                )
                if invalid_date:
                    raise ValueError(
                        f"temporal field `{name}` disabled_dates contains invalid "
                        f"ISO date `{invalid_date}`."
                    )
                if normalized_dates:
                    field["disabled_dates"] = list(dict.fromkeys(normalized_dates))
            disabled_weekdays = raw.get(
                "disabled_weekdays", raw.get("disabledWeekdays")
            )
            if disabled_weekdays is not None:
                if not isinstance(disabled_weekdays, list) or any(
                    isinstance(day, bool)
                    or not isinstance(day, int)
                    or day < 0
                    or day > 6
                    for day in disabled_weekdays
                ):
                    raise ValueError(
                        f"temporal field `{name}` disabled_weekdays must contain integers 0-6."
                    )
                if disabled_weekdays and base_type == "time":
                    raise ValueError(
                        f"temporal field `{name}` disabled_weekdays is not valid for time fields."
                    )
                if disabled_weekdays:
                    field["disabled_weekdays"] = list(dict.fromkeys(disabled_weekdays))
        if ftype == "select":
            options = raw.get("options")
            if not isinstance(options, list):
                raise ValueError(f"select field `{name}` requires non-empty `options`.")
            # Strip BEFORE the emptiness check — all-whitespace options must be
            # rejected, not silently forwarded as `options: []`.
            options = [text for text in (_flatten_choice(o) for o in options) if text]
            if not options:
                raise ValueError(f"select field `{name}` requires non-empty `options`.")
            field["options"] = options
        normalized.append(field)

    return normalized or None


def _normalize_dependency(
    raw: Any,
    *,
    known_question_ids: set[str],
) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("depends_on must be an object.")
    question_id = str(raw.get("question_id") or "").strip()
    if not question_id:
        raise ValueError("depends_on requires `question_id`.")
    if question_id not in known_question_ids:
        raise ValueError(
            f"depends_on references `{question_id}` before it is defined; "
            "conditions may reference earlier questions only."
        )
    operator = str(raw.get("operator") or "equals").strip().lower()
    if operator not in CONDITION_OPERATORS:
        raise ValueError(
            f"depends_on has unknown operator `{operator}`; valid operators: "
            f"{', '.join(sorted(CONDITION_OPERATORS))}"
        )
    dependency: Dict[str, Any] = {
        "question_id": question_id,
        "operator": operator,
    }
    if operator != "not_empty":
        value = _flatten_choice(raw.get("value"))
        if not value:
            raise ValueError(f"depends_on operator `{operator}` requires `value`.")
        dependency["value"] = value
    return dependency


def _normalize_questions(questions: Any) -> Optional[List[Dict[str, Any]]]:
    if questions is None:
        return None
    if not isinstance(questions, list):
        raise ValueError("questions must be a list of question objects.")
    if not questions:
        raise ValueError("questions must contain at least one question.")
    if len(questions) > MAX_QUESTIONS:
        raise ValueError(f"questions supports at most {MAX_QUESTIONS} steps.")

    normalized: List[Dict[str, Any]] = []
    question_ids: set[str] = set()
    field_names: set[str] = set()
    for raw in questions:
        if not isinstance(raw, dict):
            raise ValueError("each question must be an object.")
        question_id = str(raw.get("id") or "").strip()
        if not question_id:
            raise ValueError("each question requires a stable non-empty `id`.")
        if question_id in question_ids:
            raise ValueError(f"duplicate question id: {question_id}")
        prompt = str(raw.get("question") or raw.get("label") or "").strip()
        if not prompt:
            raise ValueError(f"question `{question_id}` requires non-empty text.")

        choices = raw.get("choices")
        if choices is not None:
            if not isinstance(choices, list):
                raise ValueError(f"question `{question_id}` choices must be a list.")
            choices = [
                text for text in (_flatten_choice(choice) for choice in choices) if text
            ][:MAX_CHOICES]
            if not choices:
                choices = None

        fields = _normalize_fields(raw.get("fields"), seen_names=field_names)
        dependency = _normalize_dependency(
            raw.get("depends_on"),
            known_question_ids=question_ids,
        )
        question: Dict[str, Any] = {
            "id": question_id,
            "question": prompt,
            "required": bool(raw.get("required", True)),
        }
        description = str(raw.get("description") or "").strip()
        if description:
            question["description"] = description
        if choices:
            question["choices"] = choices
            # Finite choices are closed unless arbitrary text is explicitly
            # valid for the downstream field or decision.
            question["allow_other"] = raw.get("allow_other") is True
            question["multiple"] = raw.get("multiple") is True
        if fields:
            question["fields"] = fields
        if dependency:
            question["depends_on"] = dependency
        normalized.append(question)
        question_ids.add(question_id)

    return normalized


def _normalize_response_values(raw_values: Any) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not isinstance(raw_values, dict):
        return values
    for key, value in raw_values.items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif not isinstance(value, str):
            value = str(value)
        if value.strip():
            values[str(key)] = value
    return values


def _normalize_response_answers(raw_answers: Any) -> Dict[str, Dict[str, Any]]:
    answers: Dict[str, Dict[str, Any]] = {}
    if not isinstance(raw_answers, dict):
        return answers
    for question_id, raw in raw_answers.items():
        question_key = str(question_id).strip()
        if not question_key:
            continue
        skipped = False
        if isinstance(raw, dict):
            skipped = bool(raw.get("skipped", False))
            raw_answer = raw.get("answer")
            if isinstance(raw_answer, list):
                answer: Any = [
                    text for text in (_flatten_choice(item) for item in raw_answer) if text
                ]
            else:
                answer = _flatten_choice(raw_answer)
            values = _normalize_response_values(raw.get("values"))
        else:
            answer = _flatten_choice(raw)
            values = {}
        row: Dict[str, Any] = {}
        if skipped:
            row["skipped"] = True
        if answer:
            row["answer"] = answer
        if values:
            row["values"] = values
        answers[question_key] = row
    return answers


def _discard_structured_answer_echoes(
    answer: str,
    values: Dict[str, str],
    answers: Dict[str, Dict[str, Any]],
    *,
    choices: Optional[List[str]],
    fields: Optional[List[Dict[str, Any]]],
    questions: Optional[List[Dict[str, Any]]],
) -> str:
    """Prevent structured field values from escaping through free-text answers.

    Field-only Collect forms never render a separate answer input, so any
    renderer-supplied answer in that shape is undeclared. Mixed choice/field
    forms keep their declared choice answer unless it exactly echoes a raw
    field value.
    """

    raw_values = {value for value in values.values() if value}
    if questions or (fields and (not choices or answer in raw_values)):
        answer = ""

    questions_by_id = {
        str(question.get("id") or ""): question for question in questions or []
    }
    for question_id, row in answers.items():
        question = questions_by_id.get(question_id)
        if not question or not question.get("fields"):
            continue
        if not question.get("choices"):
            row.pop("answer", None)
            continue

        row_answer = row.get("answer")
        if isinstance(row_answer, list):
            filtered = [
                item for item in row_answer if str(item).strip() not in raw_values
            ]
            if filtered:
                row["answer"] = filtered
            else:
                row.pop("answer", None)
        elif str(row_answer or "").strip() in raw_values:
            row.pop("answer", None)

    return answer


def _drop_invalid_enumerated_responses(
    values: Dict[str, str],
    answers: Dict[str, Dict[str, Any]],
    *,
    fields: Optional[List[Dict[str, Any]]],
    questions: Optional[List[Dict[str, Any]]],
) -> tuple[List[str], List[str]]:
    """Remove values outside declared Select/choice option sets.

    The renderer normally constrains these controls, but an older or forged
    response must not turn a finite website enum into arbitrary text. This
    runs before branch visibility is resolved so an invalid answer cannot
    activate a conditional question.
    """

    invalid_fields: set[str] = set()
    invalid_questions: List[str] = []

    def reject_invalid_select(
        field: Dict[str, Any],
        row_values: Optional[Dict[str, str]] = None,
    ) -> None:
        if field.get("type") != "select":
            return

        name = str(field.get("name") or "")
        options = set(field.get("options") or [])
        candidates = [
            mapping[name]
            for mapping in (values, row_values)
            if isinstance(mapping, dict) and name in mapping
        ]
        if not candidates or all(candidate in options for candidate in candidates):
            return

        values.pop(name, None)
        if isinstance(row_values, dict):
            row_values.pop(name, None)
        invalid_fields.add(name)

    for field in fields or []:
        reject_invalid_select(field)

    visible_question_ids: set[str] = set()
    for question in questions or []:
        question_id = question["id"]
        dependency = question.get("depends_on")
        if dependency and (
            str(dependency.get("question_id") or "") not in visible_question_ids
            or not _condition_matches(dependency, answers)
        ):
            answers.pop(question_id, None)
            continue
        visible_question_ids.add(question_id)

        row = answers.get(question_id)
        if not isinstance(row, dict):
            continue
        if row.get("skipped"):
            # A skipped step carries no answer or field data. Remove both the
            # nested values and their flattened copies before protection.
            for field in question.get("fields") or []:
                values.pop(field["name"], None)
                if field.get("end_name"):
                    values.pop(field["end_name"], None)
            row.clear()
            row["skipped"] = True
            continue

        choices = question.get("choices") or []
        if choices and not question.get("allow_other", False):
            raw_answer = row.get("answer")
            answer_values = (
                raw_answer if isinstance(raw_answer, list) else [raw_answer]
            )
            submitted = [
                str(value).strip()
                for value in answer_values
                if value is not None and str(value).strip()
            ]
            violates_cardinality = (
                not question.get("multiple", False) and len(submitted) > 1
            )
            if submitted and (
                violates_cardinality
                or any(value not in choices for value in submitted)
            ):
                row.pop("answer", None)
                invalid_questions.append(question_id)

        row_values = row.get("values")
        if not isinstance(row_values, dict):
            row_values = None
        for field in question.get("fields") or []:
            reject_invalid_select(field, row_values)
        if isinstance(row_values, dict) and not row_values:
            row.pop("values", None)

    return sorted(invalid_fields), list(dict.fromkeys(invalid_questions))


def _temporal_base_type(field_type: Any) -> Optional[str]:
    normalized = str(field_type or "").strip().lower()
    if normalized.endswith("_range"):
        normalized = normalized[: -len("_range")]
    return normalized if normalized in {"date", "datetime", "time"} else None


def _date_parts(value: str) -> Optional[tuple[int, int, int]]:
    matched = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
    if not matched:
        return None
    parts = tuple(int(part) for part in matched.groups())
    try:
        Date(*parts)
    except ValueError:
        return None
    return parts


def _time_parts(value: str) -> Optional[tuple[int, int, int]]:
    matched = re.fullmatch(r"(\d{2}):(\d{2})(?::(\d{2}))?", value)
    if not matched:
        return None
    hours = int(matched.group(1))
    minutes = int(matched.group(2))
    seconds = int(matched.group(3) or 0)
    if hours > 23 or minutes > 59 or seconds > 59:
        return None
    return hours, minutes, seconds


def _temporal_scalar(base_type: str, value: str) -> Optional[int]:
    if base_type == "date":
        parts = _date_parts(value)
        return Date(*parts).toordinal() if parts else None
    if base_type == "time":
        parts = _time_parts(value)
        return parts[0] * 3600 + parts[1] * 60 + parts[2] if parts else None
    if base_type == "datetime":
        if value.count("T") != 1:
            return None
        date_value, time_value = value.split("T", 1)
        date_parts = _date_parts(date_value)
        time_parts = _time_parts(time_value)
        if not date_parts or not time_parts:
            return None
        return (
            Date(*date_parts).toordinal() * 86400
            + time_parts[0] * 3600
            + time_parts[1] * 60
            + time_parts[2]
        )
    return None


def _temporal_value_valid(
    field: Dict[str, Any],
    value: str,
    *,
    minimum_override: Optional[str] = None,
) -> bool:
    base_type = _temporal_base_type(field.get("type"))
    if base_type is None:
        return True

    scalar = _temporal_scalar(base_type, value)
    if scalar is None:
        return False

    minimum = str(
        minimum_override if minimum_override is not None else field.get("min") or ""
    ).strip()
    maximum = str(field.get("max") or "").strip()
    minimum_scalar = _temporal_scalar(base_type, minimum) if minimum else None
    maximum_scalar = _temporal_scalar(base_type, maximum) if maximum else None
    if minimum and minimum_scalar is None:
        return False
    if maximum and maximum_scalar is None:
        return False
    if minimum_scalar is not None and scalar < minimum_scalar:
        return False
    if maximum_scalar is not None and scalar > maximum_scalar:
        return False

    step = field.get("step")
    if isinstance(step, (int, float)) and not isinstance(step, bool) and step > 0:
        step_base = minimum_scalar
        if step_base is None:
            step_base = Date(1970, 1, 1).toordinal() if base_type == "date" else 0
            if base_type == "datetime":
                step_base = Date(1970, 1, 1).toordinal() * 86400
        quotient = (scalar - step_base) / step
        if abs(quotient - round(quotient)) > 1e-9:
            return False

    if base_type != "time":
        date_value = value.split("T", 1)[0]
        if date_value in set(field.get("disabled_dates") or []):
            return False
        date_parts = _date_parts(date_value)
        if date_parts:
            # Python Monday=0; the Collect protocol uses Sunday=0.
            weekday = (Date(*date_parts).weekday() + 1) % 7
            if weekday in set(field.get("disabled_weekdays") or []):
                return False
    return True


def _discard_invalid_temporal_values(
    values: Dict[str, str],
    answers: Dict[str, Dict[str, Any]],
    *,
    fields: Optional[List[Dict[str, Any]]],
    questions: Optional[List[Dict[str, Any]]],
) -> List[str]:
    invalid: set[str] = set()
    declared_fields = list(fields or [])
    for question in questions or []:
        declared_fields.extend(question.get("fields") or [])

    for field in declared_fields:
        if _temporal_base_type(field.get("type")) is None:
            continue
        start_name = field["name"]
        start_value = values.get(start_name, "")
        end_name = str(field.get("end_name") or "").strip()
        end_value = values.get(end_name, "") if end_name else ""
        if end_name and bool(start_value) != bool(end_value):
            invalid.update({start_name, end_name})
            continue
        start_invalid = bool(start_value) and not _temporal_value_valid(
            field, start_value
        )
        end_invalid = False
        if end_name and end_value:
            effective_minimum = start_value or str(field.get("min") or "")
            end_invalid = not _temporal_value_valid(
                field,
                end_value,
                minimum_override=effective_minimum,
            )
        if end_name and (start_invalid or end_invalid):
            invalid.update({start_name, end_name})
        elif start_invalid:
            invalid.add(start_name)

    if not invalid:
        return []

    for name in invalid:
        values.pop(name, None)
    for row in answers.values():
        row_values = row.get("values")
        if not isinstance(row_values, dict):
            continue
        for name in invalid:
            row_values.pop(name, None)
        if not row_values:
            row.pop("values", None)
    return sorted(invalid)


def _condition_matches(
    condition: Dict[str, Any],
    answers: Dict[str, Dict[str, Any]],
) -> bool:
    prior = answers.get(str(condition.get("question_id") or ""), {})
    raw_answer = prior.get("answer", "")
    answer_values = raw_answer if isinstance(raw_answer, list) else [raw_answer]
    texts = [str(item).strip() for item in answer_values if str(item).strip()]
    operator = condition.get("operator", "equals")
    expected = str(condition.get("value") or "").strip()
    if operator == "not_empty":
        return bool(texts or prior.get("values"))
    if operator == "includes":
        return expected in texts
    if operator == "not_equals":
        return bool(texts) and expected not in texts
    return expected in texts


def _visible_questions(
    questions: List[Dict[str, Any]],
    answers: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Resolve conditions in declaration order, including hidden ancestors."""

    visible: List[Dict[str, Any]] = []
    visible_ids: set[str] = set()
    for question in questions:
        dependency = question.get("depends_on")
        if dependency:
            dependency_id = str(dependency.get("question_id") or "")
            if dependency_id not in visible_ids or not _condition_matches(
                dependency, answers
            ):
                continue
        visible.append(question)
        visible_ids.add(question["id"])
    return visible


def _filter_submitted_values(
    values: Dict[str, str],
    answers: Dict[str, Dict[str, Any]],
    *,
    fields: Optional[List[Dict[str, Any]]],
    questions: Optional[List[Dict[str, Any]]],
) -> tuple[Dict[str, str], Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """Accept only fields declared on currently visible questions."""

    if questions:
        visible = _visible_questions(questions, answers)
        visible_ids = {question["id"] for question in visible}
        filtered_answers = {
            question_id: dict(row)
            for question_id, row in answers.items()
            if question_id in visible_ids
        }
        allowed_by_question = {
            question["id"]: {
                value_name
                for field in question.get("fields") or []
                for value_name in (
                    field["name"],
                    *([field["end_name"]] if field.get("end_name") else []),
                )
            }
            for question in visible
        }
        allowed_names = set().union(*allowed_by_question.values()) if allowed_by_question else set()
        filtered_values = {
            name: value for name, value in values.items() if name in allowed_names
        }
        for question_id, row in filtered_answers.items():
            row_values = row.get("values")
            if not isinstance(row_values, dict):
                continue
            allowed = allowed_by_question.get(question_id, set())
            row["values"] = {
                name: value for name, value in row_values.items() if name in allowed
            }
            if not row["values"]:
                row.pop("values", None)
            for name, value in (row.get("values") or {}).items():
                filtered_values[name] = value
        return filtered_values, filtered_answers, visible

    allowed_names = {
        value_name
        for field in fields or []
        for value_name in (
            field["name"],
            *([field["end_name"]] if field.get("end_name") else []),
        )
    }
    return (
        {name: value for name, value in values.items() if name in allowed_names},
        {},
        [],
    )


def _protect_collected_values(
    values: Dict[str, str],
    answers: Dict[str, Dict[str, Any]],
    *,
    fields: Optional[List[Dict[str, Any]]],
    questions: Optional[List[Dict[str, Any]]],
) -> None:
    """Replace submitted field values with session-scoped in-memory refs.

    Validation runs before this function. From this point forward the tool
    result, gateway event, LLM context, and session database see only refs.
    """
    metadata: Dict[str, Dict[str, str]] = {}
    for field in fields or []:
        metadata[field["name"]] = {
            "type": str(field.get("type") or "text"),
            "label": str(field.get("label") or field["name"]),
        }
        if field.get("end_name"):
            metadata[field["end_name"]] = {
                "type": str(field.get("type") or "text"),
                "label": str(field.get("end_label") or field["end_name"]),
            }
    for question in questions or []:
        for field in question.get("fields") or []:
            metadata[field["name"]] = {
                "type": str(field.get("type") or "text"),
                "label": str(field.get("label") or field["name"]),
            }
            if field.get("end_name"):
                metadata[field["end_name"]] = {
                    "type": str(field.get("type") or "text"),
                    "label": str(field.get("end_label") or field["end_name"]),
                }

    from tools.transient_values import protect_value

    references: Dict[str, str] = {}
    for name, raw_value in list(values.items()):
        field = metadata.get(name, {"type": "text", "label": name})
        try:
            references[name] = protect_value(
                raw_value,
                field_type=field["type"],
                label=field["label"],
            )
        except Exception:
            # This boundary must fail closed: never allow a storage failure to
            # put the raw value back into logs/model/session history.
            references[name] = "fan-value://unavailable"

    values.update(references)
    for row in answers.values():
        row_values = row.get("values")
        if not isinstance(row_values, dict):
            continue
        for name in list(row_values):
            if name in references:
                row_values[name] = references[name]


def collect_tool(
    question: str = "",
    choices: Optional[List[str]] = None,
    fields: Optional[List[Dict[str, Any]]] = None,
    questions: Optional[List[Dict[str, Any]]] = None,
    submit_label: Optional[str] = None,
    skip_label: Optional[str] = None,
    submitted_label: Optional[str] = None,
    skipped_label: Optional[str] = None,
    callback: Optional[Callable] = None,
) -> str:
    """Ask one question or run one structured, conditional questionnaire."""
    try:
        normalized_questions = _normalize_questions(questions)
        if normalized_questions and (choices is not None or fields is not None):
            raise ValueError(
                "Use either `questions` or the legacy `choices`/`fields` shape, not both."
            )
        fields = _normalize_fields(fields)
    except ValueError as exc:
        return tool_error(str(exc))

    question = str(question or "").strip()
    if not question:
        if normalized_questions:
            question = "Provide the information needed to complete this step"
        else:
            return tool_error("Question text is required.")

    if choices is not None:
        if not isinstance(choices, list):
            return tool_error("choices must be a list of strings.")
        choices = [text for text in (_flatten_choice(c) for c in choices) if text]
        choices = choices[:MAX_CHOICES] or None

    if callback is None:
        return json.dumps(
            {"error": "Collect tool is not available in this execution context."},
            ensure_ascii=False,
        )

    payload: Dict[str, Any] = {"question": question}
    if normalized_questions:
        payload["questions"] = normalized_questions
    else:
        if choices:
            payload["choices"] = choices
        if fields:
            payload["fields"] = fields
    for key, value in {
        "submit_label": submit_label,
        "skip_label": skip_label,
        "submitted_label": submitted_label,
        "skipped_label": skipped_label,
    }.items():
        text = str(value or "").strip()
        if text:
            payload[key] = text

    try:
        raw = callback(payload)
    except Exception as exc:
        return json.dumps(
            {"error": f"Failed to get user input: {exc}"},
            ensure_ascii=False,
        )

    raw = str(raw or "").strip()
    answer = ""
    values: Dict[str, str] = {}
    answers: Dict[str, Dict[str, Any]] = {}
    status = "cancelled" if not raw else "submitted"
    skipped = False
    invalid_status = False
    if raw:
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            parsed_status = str(parsed.get("status") or "").strip().lower()
            if parsed_status in {
                "submitted", "skipped", "cancelled", "expired", "interrupted"
            }:
                status = parsed_status
            elif "status" in parsed:
                # A renderer response with an explicit but unknown status is
                # malformed. Fail closed instead of treating attached values
                # as a successful submission.
                status = "cancelled"
                invalid_status = True
            elif bool(parsed.get("skipped", False)):
                status = "skipped"
            skipped = status == "skipped"
            if status == "submitted":
                answer = _flatten_choice(parsed.get("answer"))
                values = _normalize_response_values(parsed.get("values"))
                answers = _normalize_response_answers(parsed.get("answers"))
                for row in answers.values():
                    for key, value in row.get("values", {}).items():
                        values.setdefault(key, value)
        else:
            answer = raw

    answer = _discard_structured_answer_echoes(
        answer,
        values,
        answers,
        choices=choices,
        fields=fields,
        questions=normalized_questions,
    )
    enumerated_invalid_fields, invalid_questions = (
        _drop_invalid_enumerated_responses(
            values,
            answers,
            fields=fields,
            questions=normalized_questions,
        )
        if status == "submitted"
        else ([], [])
    )
    values, answers, active_questions = _filter_submitted_values(
        values,
        answers,
        fields=fields,
        questions=normalized_questions,
    )
    temporal_invalid_fields = (
        _discard_invalid_temporal_values(
            values,
            answers,
            fields=fields,
            questions=active_questions,
        )
        if status == "submitted"
        else []
    )
    invalid_fields = sorted(
        set(enumerated_invalid_fields) | set(temporal_invalid_fields)
    )

    result: Dict[str, Any] = {
        "question": question,
        "user_response": answer,
        "status": status,
        "skipped": skipped,
    }
    if choices:
        result["choices_offered"] = choices
    if values:
        result["values"] = values
    if answers:
        result["answers"] = answers
    if invalid_fields:
        result["invalid_fields"] = invalid_fields
    if invalid_questions:
        result["invalid_questions"] = invalid_questions

    missing_fields: List[str] = []
    missing_questions: List[str] = []
    if fields and status == "submitted":
        for field in fields:
            if not field.get("required"):
                continue
            for value_name in (
                field["name"],
                *([field["end_name"]] if field.get("end_name") else []),
            ):
                if not values.get(value_name):
                    missing_fields.append(value_name)
    if normalized_questions and status == "submitted":
        for item in active_questions:
            row = answers.get(item["id"], {})
            if row.get("skipped"):
                if item.get("required"):
                    missing_questions.append(item["id"])
                    for field in item.get("fields") or []:
                        if not field.get("required"):
                            continue
                        missing_fields.append(field["name"])
                        if field.get("end_name"):
                            missing_fields.append(field["end_name"])
                continue
            item_fields = item.get("fields") or []
            row_values = row.get("values") or {}
            has_answer = bool(row.get("answer"))
            has_values = any(
                row_values.get(field["name"]) or values.get(field["name"])
                for field in item_fields
            )
            if not item.get("required") and not has_answer and not has_values:
                continue
            if (
                item.get("required")
                and (item.get("choices") or not item_fields)
                and not has_answer
            ):
                missing_questions.append(item["id"])
            for field in item_fields:
                if not field.get("required"):
                    continue
                for value_name in (
                    field["name"],
                    *([field["end_name"]] if field.get("end_name") else []),
                ):
                    if not row_values.get(value_name) and not values.get(value_name):
                        missing_fields.append(value_name)
    if missing_fields:
        result["missing_fields"] = sorted(set(missing_fields))
    if missing_questions:
        result["missing_questions"] = missing_questions
    if invalid_fields or invalid_questions or missing_fields or missing_questions:
        result["requires_recollection"] = True
    if status == "submitted" and values:
        _protect_collected_values(
            values,
            answers,
            fields=fields,
            questions=normalized_questions,
        )
        result["values_protected"] = True
    if status in {"cancelled", "expired", "interrupted"}:
        result["error"] = (
            "Collect interaction returned an invalid status."
            if invalid_status
            else f"User interaction ended with status: {status}."
        )
    return json.dumps(result, ensure_ascii=False)


def check_collect_requirements() -> bool:
    """No external requirements — always available."""
    return True


# =============================================================================
# OpenAI Function-Calling Schema
# =============================================================================

FIELD_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {
            "type": "string",
            "description": "Stable unique key for the value (e.g. passport_number).",
        },
        "label": {"type": "string", "description": "User-facing label."},
        "type": {"type": "string", "enum": sorted(FIELD_TYPES)},
        "required": {"type": "boolean", "default": True},
        "placeholder": {"type": "string"},
        "options": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Required for type=select.",
        },
        "end_name": {
            "type": "string",
            "description": "Required for *_range types; stable key for the end value.",
        },
        "end_label": {"type": "string"},
        "min": {"type": "string", "description": "Minimum ISO date/time value."},
        "max": {"type": "string", "description": "Maximum ISO date/time value."},
        "step": {
            "type": "number",
            "exclusiveMinimum": 0,
            "description": (
                "Selection interval: days for date/date_range; seconds for "
                "time, datetime, time_range, and datetime_range."
            ),
        },
        "timezone": {"type": "string"},
        "disabled_dates": {
            "type": "array",
            "items": {"type": "string"},
            "description": "ISO dates unavailable for selection.",
        },
        "disabled_weekdays": {
            "type": "array",
            "items": {"type": "integer", "minimum": 0, "maximum": 6},
            "description": "Unavailable weekdays, Sunday=0 through Saturday=6.",
        },
    },
    "required": ["name", "label"],
}

COLLECT_SCHEMA = {
    "name": "collect",
    "description": (
        "Ask the user a question OR collect information/values you are missing. "
        "This is the ONLY way to obtain user-specific data — never guess, "
        "fabricate, or scrape personal values.\n\n"
        "Modes (choose one):\n"
        "1. **Question** — `question` alone for open-ended, or with up to 12 "
        "`choices` for a decision (the UI adds a free-text option).\n"
        "2. **Form fields** — `fields` for typed values: phone numbers, SMS "
        "one-time codes (`otp`), text/image captcha answers (`captcha`), "
        "credit cards, ID numbers, invoice numbers, emails, dates, times, "
        "date/time ranges, files, "
        "secrets. Use `type: select` with the webpage's exact `options` for a "
        "closed dropdown. Every field, including `file`, returns an opaque reference. The "
        "answers come back as `values: {name: value_ref}`. Pass each opaque "
        "`fan-value://...` reference only through the destination tool's documented "
        "protected-value channel. Never paste a reference into an ordinary text "
        "argument or executable code, never ask the user again, and never try to "
        "decode it.\n"
        "3. **Questionnaire** — `question` is the card title and `questions` "
        "contains 1-12 steps. Each step has its own choices/free text/fields; "
        "`depends_on` can show a later step based on an earlier answer. The UI "
        "shows progress and submits all answers once. Questionnaire choices "
        "are closed by default; set `allow_other: true` only when arbitrary "
        "text is a valid answer. Prefer this when two or more related questions "
        "are needed. Do not mix `questions` with the "
        "legacy top-level `choices` or `fields`.\n\n"
        "CRITICAL: whenever you offer selectable options, put each option "
        "only in the `choices` array. Keep `question` to the question itself; "
        "never enumerate options inside it, because question text is not "
        "rendered as clickable choices. Omit `choices` only for a genuinely "
        "open-ended question or pure field collection.\n\n"
        "CRITICAL TEMPORAL UI: whenever asking for a date, time, date-time, "
        "or range, use the corresponding typed field (`date`, `time`, "
        "`datetime`, `date_range`, `time_range`, `datetime_range`). Never ask "
        "the user to type a temporal value into a plain question or textarea. "
        "Range fields require `end_name`; use min/max and disabled constraints "
        "when the website provides them. `step` is measured in days for date "
        "fields and seconds for time/date-time fields.\n\n"
        "MUST use this tool when a web form needs user-personal data (phone "
        "number, verification code, bank card, identity document, invoice number, "
        "account information, etc.): collect first, then fill the "
        "page through the enabled browser tool's protected-value channel. If no "
        "such channel is available, do not type the opaque reference itself. For a "
        "text or image captcha that is visibly active on the current page and has "
        "a current input control, describe it and collect the answer "
        "(`type: captcha`) — the user "
        "sees the embedded browser, so do NOT screenshot it; only behavioral "
        "challenges (slider/drag/click-puzzle) require human takeover instead. "
        "If this tool reports `requires_recollection`, collect only its "
        "`invalid_fields`, `invalid_questions`, `missing_fields`, or "
        "`missing_questions` again before continuing the original task. "
        "Do NOT use this for yes/no confirmation of dangerous commands (the "
        "terminal tool handles approval). Prefer sensible defaults for "
        "low-stakes decisions instead of asking."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "What you need and why — shown as the card title. Keep it "
                    "short and concrete (e.g. 'An SMS code is required to log in'). Put "
                    "selectable answers in `choices`, never in this text."
                ),
            },
            "choices": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": MAX_CHOICES,
                "description": (
                    "Required whenever selectable answers are offered: put "
                    "each distinct option in its own array element (up to 12). "
                    "Omit only for an open-ended question or pure field collection."
                ),
            },
            "fields": {
                "type": "array",
                "description": (
                    "Typed fields to collect. Each: {name, label, type, "
                    "required?, placeholder?, options?, end_name?, min?, max?, "
                    "step?, timezone?, disabled_dates?, disabled_weekdays?}. Use passport or "
                    "document_number for international identity documents, "
                    "textarea/address for long text, and consent for a checkbox."
                ),
                "items": FIELD_ITEM_SCHEMA,
            },
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_QUESTIONS,
                "description": (
                    "Multi-step questionnaire. Conditions may reference earlier "
                    "question ids only. A step with choices lets the user select "
                    "an answer; a step with fields collects typed values; a step "
                    "with neither accepts free text."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Stable unique id used by depends_on and answers.",
                        },
                        "question": {"type": "string"},
                        "description": {"type": "string"},
                        "required": {"type": "boolean", "default": True},
                        "choices": {
                            "type": "array",
                            "items": {"type": "string"},
                            "maxItems": MAX_CHOICES,
                        },
                        "allow_other": {
                            "type": "boolean",
                            "default": False,
                            "description": (
                                "Whether text outside `choices` is valid. "
                                "Keep false for webpage enums and other closed sets."
                            ),
                        },
                        "multiple": {"type": "boolean", "default": False},
                        "fields": {"type": "array", "items": FIELD_ITEM_SCHEMA},
                        "depends_on": {
                            "type": "object",
                            "properties": {
                                "question_id": {"type": "string"},
                                "operator": {
                                    "type": "string",
                                    "enum": sorted(CONDITION_OPERATORS),
                                    "default": "equals",
                                },
                                "value": {"type": "string"},
                            },
                            "required": ["question_id", "operator"],
                        },
                    },
                    "required": ["id", "question"],
                },
            },
            "submit_label": {
                "type": "string",
                "description": "Optional primary action label, e.g. Submit or Send code and continue.",
            },
            "skip_label": {
                "type": "string",
                "description": "Optional skip action label suited to this request.",
            },
            "submitted_label": {
                "type": "string",
                "description": "Optional compact success label shown after submitted data is accepted.",
            },
            "skipped_label": {
                "type": "string",
                "description": "Optional compact label shown after the user skips this collection.",
            },
        },
        "required": ["question"],
    },
}


# --- Registry ---
from tools.registry import registry, tool_error

registry.register(
    name="collect",
    toolset="collect",
    schema=COLLECT_SCHEMA,
    handler=lambda args, **kw: collect_tool(
        question=args.get("question", ""),
        choices=args.get("choices"),
        fields=args.get("fields"),
        questions=args.get("questions"),
        submit_label=args.get("submit_label"),
        skip_label=args.get("skip_label"),
        submitted_label=args.get("submitted_label"),
        skipped_label=args.get("skipped_label"),
        callback=kw.get("callback")),
    check_fn=check_collect_requirements,
    emoji="📝",
)
