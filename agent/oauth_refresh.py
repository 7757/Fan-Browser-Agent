"""Provider adapters for refreshing OAuth credentials in the generic pool."""

from __future__ import annotations

import importlib
import threading
from collections.abc import Callable
from typing import Any


class OAuthRefreshError(Exception):
    def __init__(self, message: str, *, terminal: bool, reason: str = "") -> None:
        super().__init__(message)
        self.terminal = terminal
        self.reason = reason


OAuthRefresher = Callable[[Any], dict[str, Any]]
_BUILTIN_REFRESHERS: dict[str, str] = {}
_refreshers: dict[str, OAuthRefresher] = {}
_lock = threading.Lock()


def register_oauth_refresher(provider: str, refresher: OAuthRefresher) -> None:
    with _lock:
        _refreshers[str(provider).strip().lower()] = refresher


def get_oauth_refresher(provider: str) -> OAuthRefresher | None:
    normalized = str(provider or "").strip().lower()
    with _lock:
        existing = _refreshers.get(normalized)
    if existing is not None:
        return existing
    target = _BUILTIN_REFRESHERS.get(normalized)
    if not target:
        return None
    module_name, function_name = target.split(":", 1)
    refresher = getattr(importlib.import_module(module_name), function_name)
    register_oauth_refresher(normalized, refresher)
    return refresher
