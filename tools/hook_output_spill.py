"""Spill oversized hook-injected context to disk with a bounded preview.

``pre_llm_call`` hook output is injected into every API request of a turn.
When a hook returns a debug dump or other large blob, retain the full output
on disk and keep only a useful head/tail preview in the model context.
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_MAX_CHARS = 10_000
DEFAULT_PREVIEW_HEAD = 500
DEFAULT_PREVIEW_TAIL = 500
DEFAULT_ENABLED = True


def _coerce_positive_int(value: Any, default: int) -> int:
    try:
        integer = int(value)
    except (TypeError, ValueError):
        return default
    return integer if integer > 0 else default


def _coerce_non_negative_int(value: Any, default: int) -> int:
    try:
        integer = int(value)
    except (TypeError, ValueError):
        return default
    return integer if integer >= 0 else default


def get_spill_config() -> Dict[str, Any]:
    """Return resolved ``hooks.output_spill`` configuration without raising."""
    section: Dict[str, Any] = {}
    try:
        from fan_cli.config import load_config

        config = load_config() or {}
        hooks = config.get("hooks") if isinstance(config, dict) else None
        if isinstance(hooks, dict):
            configured = hooks.get("output_spill")
            if isinstance(configured, dict):
                section = configured
    except Exception:
        section = {}

    enabled_raw = section.get("enabled", DEFAULT_ENABLED)
    directory = section.get("directory")
    if directory is not None and not isinstance(directory, str):
        directory = None

    return {
        "enabled": bool(enabled_raw) if enabled_raw is not None else DEFAULT_ENABLED,
        "max_chars": _coerce_positive_int(
            section.get("max_chars"), DEFAULT_MAX_CHARS
        ),
        "preview_head": _coerce_non_negative_int(
            section.get("preview_head"), DEFAULT_PREVIEW_HEAD
        ),
        "preview_tail": _coerce_non_negative_int(
            section.get("preview_tail"), DEFAULT_PREVIEW_TAIL
        ),
        "directory": directory,
    }


def _resolve_spill_dir(
    directory_override: Optional[str], session_id: Optional[str]
) -> Path:
    """Return the session-scoped directory that stores full hook outputs."""
    if directory_override:
        base = Path(os.path.expanduser(directory_override))
    else:
        try:
            from fan_constants import get_fan_home

            base = Path(get_fan_home()) / "hook_outputs"
        except Exception:
            base = Path(
                os.environ.get("FAN_HOME") or os.path.expanduser("~/.fan")
            ) / "hook_outputs"

    session_segment = (session_id or "no-session").replace("/", "_")
    session_segment = session_segment.replace("\\", "_").replace("..", "_")
    return base / session_segment


def _build_preview(
    text: str,
    head: int,
    tail: int,
    saved_path: Optional[str],
    *,
    source: str,
) -> str:
    total = len(text)
    head_chunk = text[:head] if head > 0 else ""
    tail_chunk = text[-tail:] if tail > 0 and total > head else ""
    parts = [
        f"[{source} output truncated — {total:,} chars; full content "
        + (
            f"saved to {saved_path}]"
            if saved_path
            else "unavailable — spill write failed]"
        ),
    ]
    if head_chunk:
        parts.extend(("--- head ---", head_chunk))
    if tail_chunk:
        parts.extend(("--- tail ---", tail_chunk))
    return "\n".join(parts)


def spill_if_oversized(
    text: str,
    *,
    session_id: Optional[str] = None,
    source: str = "hook",
    config: Optional[Dict[str, Any]] = None,
) -> str:
    """Return *text* unchanged or spill it and return a bounded preview."""
    if text is None:
        return ""
    if not isinstance(text, str):
        try:
            text = str(text)
        except Exception:
            return ""

    resolved = config if config is not None else get_spill_config()
    if not resolved.get("enabled", True):
        return text

    max_chars = int(resolved.get("max_chars") or DEFAULT_MAX_CHARS)
    if len(text) <= max_chars:
        return text

    head = int(resolved.get("preview_head") or 0)
    tail = int(resolved.get("preview_tail") or 0)
    saved_path: Optional[str] = None
    try:
        spill_dir = _resolve_spill_dir(resolved.get("directory"), session_id)
        spill_dir.mkdir(parents=True, exist_ok=True)
        spill_path = spill_dir / f"{uuid.uuid4().hex}.txt"
        spill_path.write_text(
            text if text.endswith("\n") else text + "\n", encoding="utf-8"
        )
        saved_path = str(spill_path)
    except Exception as exc:
        logger.warning("hook output spill failed: %s", exc)

    return _build_preview(text, head, tail, saved_path, source=source)


__all__ = [
    "DEFAULT_ENABLED",
    "DEFAULT_MAX_CHARS",
    "DEFAULT_PREVIEW_HEAD",
    "DEFAULT_PREVIEW_TAIL",
    "get_spill_config",
    "spill_if_oversized",
]
