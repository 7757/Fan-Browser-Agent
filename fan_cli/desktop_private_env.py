"""Latch Electron desktop bootstrap values before extensible code can run.

``fan_cli.main`` imports this module immediately after ``os``/``sys`` (while
keeping ``fan_bootstrap`` as its required first import). Import-time capture is
intentional: dashboard plugin discovery may execute user code and spawn child
processes before ``web_server`` is imported. Removing the loopback session
token here keeps it out of every later inherited environment.
"""

from __future__ import annotations

import os


DESKTOP_SESSION_TOKEN_AT_STARTUP = os.environ.pop(
    "FAN_DESKTOP_SESSION_TOKEN",
    "",
)
__all__ = [
    "DESKTOP_SESSION_TOKEN_AT_STARTUP",
]
