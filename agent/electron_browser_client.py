"""Thin RPC client for the Electron-native browser runtime.

The Electron main process owns the browser runtime. This client intentionally
contains no browser automation logic; it only forwards model-facing tool calls
to the runtime endpoint injected into the Python backend environment.
"""

from __future__ import annotations

import errno
import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any


_EXPLICIT_PRE_DISPATCH_ERRNOS = frozenset(
    value
    for value in (
        getattr(errno, "ECONNREFUSED", None),
        getattr(errno, "ENETUNREACH", None),
        getattr(errno, "EHOSTUNREACH", None),
        getattr(errno, "ENETDOWN", None),
        getattr(errno, "EHOSTDOWN", None),
    )
    if isinstance(value, int)
)


class ElectronBrowserRuntimeError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        details: dict[str, Any] | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}
        self.status = status


def _runtime_error_from_payload(raw: str, *, status: int | None = None) -> ElectronBrowserRuntimeError:
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        message = str(parsed.get("error") or "Electron browser runtime error")
        code = parsed.get("errorCode")
        details = parsed.get("errorDetails")
        return ElectronBrowserRuntimeError(
            message,
            code=str(code) if code is not None else None,
            details=details if isinstance(details, dict) else None,
            status=status,
        )
    prefix = f"Electron browser runtime HTTP {status}: " if status is not None else ""
    return ElectronBrowserRuntimeError(prefix + (raw or "Electron browser runtime error"), status=status)


def _is_explicit_before_dispatch_failure(exc: BaseException) -> bool:
    """Return true only when the transport proves no request was dispatched."""
    reason = getattr(exc, "reason", None)
    candidates = (exc, reason) if isinstance(reason, BaseException) else (exc,)
    for candidate in candidates:
        if isinstance(candidate, (ConnectionRefusedError, socket.gaierror)):
            return True
        if (
            isinstance(candidate, OSError)
            and candidate.errno in _EXPLICIT_PRE_DISPATCH_ERRNOS
        ):
            return True
    return False


class ElectronBrowserClient:
    def __init__(self, url: str | None = None, token: str | None = None, timeout: float = 60.0) -> None:
        self.url = (url or os.environ.get("ELECTRON_BROWSER_RUNTIME_URL") or "").strip()
        self.token = (token or os.environ.get("ELECTRON_BROWSER_RUNTIME_TOKEN") or "").strip()
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.url and self.token)

    def call(
        self,
        action: str,
        *,
        workbench_id: str | None = None,
        params: dict[str, Any] | None = None,
        action_id: str | None = None,
        timeout: float | None = None,
    ) -> Any:
        if not self.available:
            raise ElectronBrowserRuntimeError(
                "Electron browser runtime is unavailable; missing ELECTRON_BROWSER_RUNTIME_URL/TOKEN",
                details={
                    "transportFailure": True,
                    "beforeDispatch": True,
                    "dispatchAttempted": False,
                },
            )
        payload = {
            "action": action,
            "id": str(workbench_id or "main"),
            "params": params or {},
        }
        if action_id:
            payload["actionId"] = str(action_id)
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise _runtime_error_from_payload(detail, status=exc.code) from exc
        except Exception as exc:
            reason = getattr(exc, "reason", None)
            timed_out = isinstance(exc, (TimeoutError, socket.timeout)) or isinstance(
                reason,
                (TimeoutError, socket.timeout),
            )
            code = "RUNTIME_REQUEST_TIMEOUT" if timed_out else None
            details = {"transportFailure": True}
            if _is_explicit_before_dispatch_failure(exc):
                details.update(
                    {
                        "beforeDispatch": True,
                        "dispatchAttempted": False,
                    }
                )
            raise ElectronBrowserRuntimeError(
                f"Electron browser runtime request failed: {exc}",
                code=code,
                details=details,
            ) from exc

        try:
            parsed = json.loads(raw)
        except Exception as exc:
            raise ElectronBrowserRuntimeError(
                f"Electron browser runtime returned invalid JSON: {raw[:200]}",
                details={
                    "transportFailure": True,
                    "responseReceived": True,
                },
            ) from exc

        if not parsed.get("ok"):
            raise _runtime_error_from_payload(raw)
        return parsed.get("result")
