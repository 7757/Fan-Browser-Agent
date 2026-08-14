"""Pure argument normalization helpers for Electron browser tools."""

from __future__ import annotations

import json
from typing import Any


def _target_payload(args):
    target_id = (args.get("target_id") or args.get("targetId") or "").strip()
    tab_id = (args.get("tab_id") or args.get("tabId") or "").strip()
    if not target_id and not tab_id:
        return None
    payload: dict[str, Any] = {}
    if target_id:
        payload["targetId"] = target_id
    if tab_id:
        payload["tabId"] = tab_id
    return payload


def _tab_ref(args):
    ref = (
        args.get("tab_id")
        if args.get("tab_id") is not None
        else args.get("tabId")
        if args.get("tabId") is not None
        else args.get("index")
        if args.get("index") is not None
        else args.get("target_id") or args.get("targetId")
    )
    return "" if ref is None else str(ref).strip()


def _coerce_json_object(value, label: str):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    return value


def _coerce_headers(value):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    return {
        str(key): str(header_value)
        for key, header_value in value.items()
        if key and header_value is not None
    }


def _coerce_string_list(value):
    if value is None:
        return None
    if isinstance(value, str):
        return [part.strip() for part in value.replace(",", " ").split() if part.strip()]
    if isinstance(value, list):
        return [str(part).strip() for part in value if str(part).strip()]
    return None
