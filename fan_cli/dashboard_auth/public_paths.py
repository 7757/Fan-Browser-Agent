"""Shared allowlist of ``/api/*`` paths that bypass the dashboard token gate.

``fan_cli.web_server.auth_middleware`` enforces the loopback session
token (the ephemeral ``_SESSION_TOKEN``) on every ``/api/*`` route except
the paths listed here.

Keep this list minimal — only truly non-sensitive, read-only endpoints
belong here. As a sanity check, every entry should be safe to expose to:

  * external uptime / liveness probes,
  * the dashboard SPA before it has the session token,
  * anyone who happens to ``curl`` the hostname.

If a new endpoint doesn't pass all three tests, it should be gated.
"""
from __future__ import annotations

PUBLIC_API_PATHS: frozenset[str] = frozenset({
    # Liveness probe target. Returns version + release date only — no host
    # metadata, session content, or secrets.
    "/api/status",
    # Read-only config-defaults / schema feeds for the SPA's Config page.
    "/api/config/defaults",
    "/api/config/schema",
    # Read-only model metadata (context windows, etc.) — same shape as
    # provider catalogs already exposed on the public internet.
    "/api/model/info",
    # Read-only theme + plugin manifests for the dashboard skin engine.
    "/api/dashboard/themes",
    "/api/dashboard/plugins",
})
