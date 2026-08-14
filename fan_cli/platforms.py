"""
Shared platform registry for Fan Agent.

Single source of truth for platform metadata consumed by both
skills_config (label display) and tools_config (default toolset
resolution).  Import ``PLATFORMS`` from here instead of maintaining
duplicate dicts in each module.
"""

from collections import OrderedDict
from typing import NamedTuple


class PlatformInfo(NamedTuple):
    """Metadata for a single platform entry."""
    label: str
    default_toolset: str


# Ordered so that TUI menus are deterministic.
# Built-in entries are local runtime surfaces only.
PLATFORMS: OrderedDict[str, PlatformInfo] = OrderedDict([
    ("cli",            PlatformInfo(label="🖥️  CLI",            default_toolset="fan-cli")),
    ("api_server",     PlatformInfo(label="🌐 API Server",      default_toolset="fan-api-server")),
    ("cron",           PlatformInfo(label="⏰ Cron",            default_toolset="fan-cron")),
])


def platform_label(key: str, default: str = "") -> str:
    """Return the display label for a platform key, or *default*.

    The registry contains the supported local runtime surfaces.
    """
    info = PLATFORMS.get(key)
    if info is not None:
        return info.label
    return default

