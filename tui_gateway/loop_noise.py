"""Filter harmless WebSocket peer-hangup teardown noise from asyncio logs."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

_log = logging.getLogger(__name__)
_BENIGN_TEARDOWN_ERRORS = (
    ConnectionResetError,
    ConnectionAbortedError,
    BrokenPipeError,
)


def _is_benign_teardown(context: dict[str, Any]) -> bool:
    """Return whether *context* is a peer disconnect during transport cleanup."""
    exc = context.get("exception")
    if not isinstance(exc, _BENIGN_TEARDOWN_ERRORS):
        return False
    marker = "_call_connection_lost"
    return marker in repr(context.get("callback")) or marker in repr(context.get("handle"))


def install_loop_noise_filter(loop: asyncio.AbstractEventLoop) -> None:
    """Install a narrow, idempotent asyncio exception filter.

    Only the known connection-lost callback flood is suppressed; all other
    loop exceptions keep their existing handler and visibility.
    """
    if getattr(loop, "_fan_noise_filter_installed", False):
        return
    previous = loop.get_exception_handler()

    def handler(active_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        if _is_benign_teardown(context):
            _log.debug("WebSocket peer hangup during teardown (suppressed): %s", context.get("exception"))
            return
        if previous is not None:
            previous(active_loop, context)
        else:
            active_loop.default_exception_handler(context)

    loop.set_exception_handler(handler)
    try:
        loop._fan_noise_filter_installed = True  # type: ignore[attr-defined]
    except (AttributeError, TypeError):
        pass
