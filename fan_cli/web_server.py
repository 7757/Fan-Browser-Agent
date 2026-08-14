"""
Fan Agent — Web UI server.

Provides a FastAPI backend serving the Vite/React frontend and REST API
endpoints for managing configuration, environment variables, and sessions.

Usage:
    fan dashboard --no-open             # Start on http://127.0.0.1:9119
    fan dashboard --no-open --port 8080
"""

import asyncio
import base64
import hmac
import importlib.util
import json
import logging
import mimetypes
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

# ``fan_cli.main`` imports this latch immediately after os/sys, before enabled
# plugins or lazy dependency installers can execute and spawn children. Direct
# web_server imports (tests/embedding) trigger the same one-time capture here.
from fan_cli.desktop_private_env import (
    DESKTOP_SESSION_TOKEN_AT_STARTUP as _DESKTOP_SESSION_TOKEN_AT_STARTUP,
)

import yaml

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fan_cli import __version__, __release_date__
from fan_cli.config import (
    cfg_get,
    DEFAULT_CONFIG,
    OPTIONAL_ENV_VARS,
    ensure_provider_config_migrated,
    get_config_path,
    get_fan_home,
    load_config,
    load_env,
    read_raw_config,
    save_config,
    save_env_value,
    remove_env_value,
    redact_key,
    _deep_merge,
)
from fan_cli.providers import (
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_MODELS,
    normalize_provider,
)
from utils import env_var_enabled

try:
    from fastapi import FastAPI, HTTPException, Request, WebSocket
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel
except ImportError:
    # First try lazy-installing the dashboard extras. Only the user actually
    # running `fan dashboard` needs fastapi+uvicorn; lazy install keeps
    # them out of every other install path. After install, re-import.
    try:
        from tools.lazy_deps import ensure as _lazy_ensure
        _lazy_ensure("tool.dashboard", prompt=False)
        from fastapi import FastAPI, HTTPException, Request, WebSocket
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
        from fastapi.staticfiles import StaticFiles
        from pydantic import BaseModel
    except Exception:
        raise SystemExit(
            "Web UI requires fastapi and uvicorn.\n"
            f"Install with: {sys.executable} -m pip install 'fastapi' 'uvicorn[standard]'"
        )

WEB_DIST = Path(os.environ["FAN_WEB_DIST"]) if "FAN_WEB_DIST" in os.environ else Path(__file__).parent / "web_dist"
_log = logging.getLogger(__name__)

app = FastAPI(title="Fan Agent", version=__version__)


@app.on_event("startup")
async def _install_websocket_teardown_noise_filter() -> None:
    """Avoid error-log floods when a desktop WebSocket hangs up mid-write."""
    # Normalize local provider configuration before the gateway builds an agent.
    try:
        ensure_provider_config_migrated()
    except Exception:
        _log.exception("provider config migration failed")
    try:
        from tui_gateway.loop_noise import install_loop_noise_filter

        loop = asyncio.get_running_loop()
        install_loop_noise_filter(loop)

        # The desktop gateway is loopback-only.  A GIL-heavy turn can starve
        # this loop longer than Uvicorn's normal WS ping window even though
        # the local socket is healthy.  Record the stall for diagnosis rather
        # than presenting it as a mysterious client disconnect.
        heartbeat_interval = 2.0
        stall_threshold = 5.0

        def _loop_heartbeat(expected: float) -> None:
            now = loop.time()
            drift = now - expected
            if drift > stall_threshold:
                _log.warning("event loop stalled %.1fs (GIL pressure suspected)", drift)
            loop.call_later(
                heartbeat_interval,
                _loop_heartbeat,
                now + heartbeat_interval,
            )

        loop.call_later(
            heartbeat_interval,
            _loop_heartbeat,
            loop.time() + heartbeat_interval,
        )
    except Exception as exc:
        _log.debug("event-loop teardown noise filter unavailable: %s", exc)

# ---------------------------------------------------------------------------
# Session token for protecting sensitive endpoints (reveal).
# The desktop shell mints the token and injects it via
# FAN_DESKTOP_SESSION_TOKEN so its main process can authenticate the
# /api calls it makes on the user's behalf; otherwise we generate one fresh
# on every server start. Either way it dies when the process exits.
# ---------------------------------------------------------------------------
_SESSION_TOKEN = _DESKTOP_SESSION_TOKEN_AT_STARTUP or secrets.token_urlsafe(32)
_SESSION_HEADER_NAME = "X-Fan-Session-Token"


del _DESKTOP_SESSION_TOKEN_AT_STARTUP

# Electron drives the agent over `/api/ws`.
# Keep this as a module-level constant so the WS endpoint and SPA token
# injection share a single, testable flag.
_ELECTRON_GATEWAY_WS_ENABLED = True

# Simple rate limiter for the reveal endpoint
_reveal_timestamps: List[float] = []
_REVEAL_MAX_PER_WINDOW = 5
_REVEAL_WINDOW_SECONDS = 30

# CORS: restrict to localhost origins only.  The web UI is intended to run
# locally; binding to 0.0.0.0 with allow_origins=["*"] would let any website
# read/modify config and secrets.

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Endpoints that do NOT require the session token.  Everything else under
# /api/ is gated by the auth middleware below.
#
# The list lives in ``fan_cli.dashboard_auth.public_paths`` as the single
# source of truth for the loopback-token gate.  Keep it minimal — only truly
# non-sensitive, read-only endpoints belong there.
# ---------------------------------------------------------------------------
from fan_cli.dashboard_auth.public_paths import (
    PUBLIC_API_PATHS as _PUBLIC_API_PATHS,
)


def _has_valid_session_token(request: Request) -> bool:
    """True if the request carries a valid dashboard session token.

    The dedicated session header avoids collisions with reverse proxies that
    already use ``Authorization`` (for example Caddy ``basic_auth``). We still
    accept the legacy Bearer path for backward compatibility with older
    dashboard bundles.
    """
    session_header = request.headers.get(_SESSION_HEADER_NAME, "")
    if session_header and hmac.compare_digest(
        session_header.encode(),
        _SESSION_TOKEN.encode(),
    ):
        return True

    auth = request.headers.get("authorization", "")
    expected = f"Bearer {_SESSION_TOKEN}"
    return hmac.compare_digest(auth.encode(), expected.encode())


def _require_token(request: Request) -> None:
    """Validate the ephemeral session token.  Raises 401 on mismatch."""
    if not _has_valid_session_token(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


# Accepted Host header values for loopback binds. DNS rebinding attacks
# point a victim browser at an attacker-controlled hostname (evil.test)
# which resolves to 127.0.0.1 after a TTL flip — bypassing same-origin
# checks because the browser now considers evil.test and our dashboard
# "same origin". Validating the Host header at the app layer rejects any
# request whose Host isn't one we bound for. See GHSA-ppp5-vxwm-4cf7.
_LOOPBACK_HOST_VALUES: frozenset = frozenset({
    "localhost", "127.0.0.1", "::1",
})


def _is_accepted_host(host_header: str, bound_host: str) -> bool:
    """True if the Host header targets the interface we bound to.

    Accepts:
    - Exact bound host (with or without port suffix)
    - Loopback aliases when bound to loopback
    """
    if not host_header:
        return False
    # Strip port suffix. IPv6 addresses use bracket notation:
    #   [::1]         — no port
    #   [::1]:9119    — with port
    # Plain hosts/v4:
    #   localhost:9119
    #   127.0.0.1:9119
    h = host_header.strip()
    if h.startswith("["):
        # IPv6 bracketed — port (if any) follows "]:"
        close = h.find("]")
        if close != -1:
            host_only = h[1:close]  # strip brackets
        else:
            host_only = h.strip("[]")
    else:
        host_only = h.rsplit(":", 1)[0] if ":" in h else h
    host_only = host_only.lower()

    # Loopback bind: accept the loopback names
    bound_lc = bound_host.lower()
    if bound_lc in _LOOPBACK_HOST_VALUES:
        return host_only in _LOOPBACK_HOST_VALUES

    # Explicit non-loopback bind: require exact host match
    return host_only == bound_lc


@app.middleware("http")
async def host_header_middleware(request: Request, call_next):
    """Reject requests whose Host header doesn't match the bound interface.

    Defends against DNS rebinding: a victim browser on a localhost
    dashboard is tricked into fetching from an attacker hostname that
    TTL-flips to 127.0.0.1. CORS and same-origin checks don't help —
    the browser now treats the attacker origin as same-origin with the
    dashboard. Host-header validation at the app layer catches it.

    See GHSA-ppp5-vxwm-4cf7.
    """
    # Store the bound host on app.state so this middleware can read it —
    # set by start_server() at listen time.
    bound_host = getattr(app.state, "bound_host", None)
    if bound_host:
        host_header = request.headers.get("host", "")
        if not _is_accepted_host(host_header, bound_host):
            return JSONResponse(
                status_code=400,
                content={
                    "detail": (
                        "Invalid Host header. Dashboard requests must use "
                        "the hostname the server was bound to."
                    ),
                },
            )
    return await call_next(request)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Require the loopback session token on all /api/ routes except the public list."""
    path = request.url.path
    if path.startswith("/api/") and path not in _PUBLIC_API_PATHS:
        if not _has_valid_session_token(request):
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized"},
            )
    return await call_next(request)


# ---------------------------------------------------------------------------
# Config schema — auto-generated from DEFAULT_CONFIG
# ---------------------------------------------------------------------------

# Manual overrides for fields that need select options or custom types
_SCHEMA_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "model": {
        "type": "string",
        "description": "Default model (e.g. qwen3.5-plus)",
        "category": "general",
    },
    "model_context_length": {
        "type": "number",
        "description": "Context window override (0 = auto-detect from model metadata)",
        "category": "general",
    },
    "terminal.backend": {
        "type": "select",
        "description": "Terminal execution backend (local only — remote backends removed)",
        "options": ["local"],
    },
    "stt.provider": {
        "type": "select",
        "description": "Speech-to-text provider",
        # "mistral" temporarily removed — mistralai PyPI package quarantined
        # (malicious 2.4.6 release on 2026-05-12). Restore once available.
        "options": ["local", "groq", "openai", "xai", "elevenlabs"],
    },
    "stt.elevenlabs.model_id": {
        "type": "select",
        "description": "ElevenLabs Scribe model",
        "options": ["scribe_v2", "scribe_v1"],
    },
    "display.skin": {
        "type": "select",
        "description": "CLI visual theme",
        "options": ["default", "ares", "mono", "slate"],
    },
    "display.language": {
        "type": "select",
        "description": "Desktop interface language",
        "options": ["zh", "en"],
    },
    "dashboard.theme": {
        "type": "select",
        "description": "Web dashboard visual theme",
        "options": ["default", "midnight", "ember", "mono", "cyberpunk", "rose"],
    },
    "display.resume_display": {
        "type": "select",
        "description": "How resumed sessions display history",
        "options": ["minimal", "full", "off"],
    },
    "display.busy_input_mode": {
        "type": "select",
        "description": "Input behavior while agent is running",
        "options": ["interrupt", "queue", "steer"],
    },
    "memory.provider": {
        "type": "select",
        "description": "Memory provider plugin",
        "options": ["builtin", "honcho"],
    },
    "approvals.mode": {
        "type": "select",
        "description": "Dangerous command approval mode",
        "options": ["manual", "smart", "off"],
    },
    "context.engine": {
        "type": "select",
        "description": "Context management engine",
        "options": ["default", "custom"],
    },
    "human_delay.mode": {
        "type": "select",
        "description": "Simulated typing delay mode",
        "options": ["off", "typing", "fixed"],
    },
    "logging.level": {
        "type": "select",
        "description": "Log level for agent.log",
        "options": ["DEBUG", "INFO", "WARNING", "ERROR"],
    },
    "agent.service_tier": {
        "type": "select",
        "description": "API service tier",
        "options": ["", "auto", "default", "flex"],
    },
    "delegation.reasoning_effort": {
        "type": "select",
        "description": "Reasoning effort for delegated subagents",
        "options": ["", "low", "medium", "high"],
    },
}

# Categories with fewer fields get merged into "general" to avoid tab sprawl.
_CATEGORY_MERGE: Dict[str, str] = {
    "privacy": "security",
    "context": "agent",
    "skills": "agent",
    "cron": "agent",
    "network": "agent",
    "checkpoints": "agent",
    "approvals": "security",
    "human_delay": "display",
    "dashboard": "display",
    "code_execution": "agent",
    "prompt_caching": "agent",
    "onboarding": "agent",  # profile_build is the only schema-surfaced field
    "goals": "agent",
    "updates": "general",
}

# Display order for tabs — unlisted categories sort alphabetically after these.
_CATEGORY_ORDER = [
    "general", "agent", "terminal", "display", "delegation",
    "memory", "compression", "security", "browser",
    "logging", "auxiliary",
]


def _infer_type(value: Any) -> str:
    """Infer a UI field type from a Python value."""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "number"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return "string"


def _build_schema_from_config(
    config: Dict[str, Any],
    prefix: str = "",
) -> Dict[str, Dict[str, Any]]:
    """Walk DEFAULT_CONFIG and produce a flat dot-path → field schema dict."""
    schema: Dict[str, Dict[str, Any]] = {}
    for key, value in config.items():
        full_key = f"{prefix}.{key}" if prefix else key

        # Skip internal / version keys
        if full_key in {"_config_version",}:
            continue

        # Category is the first path component for nested keys, or "general"
        # for top-level scalar fields (model, toolsets, timezone, etc.).
        if prefix:
            category = prefix.split(".")[0]
        elif isinstance(value, dict):
            category = key
        else:
            category = "general"

        if isinstance(value, dict):
            # Recurse into nested dicts
            schema.update(_build_schema_from_config(value, full_key))
        else:
            entry: Dict[str, Any] = {
                "type": _infer_type(value),
                "description": full_key.replace(".", " → ").replace("_", " ").title(),
                "category": category,
            }
            # Apply manual overrides
            if full_key in _SCHEMA_OVERRIDES:
                entry.update(_SCHEMA_OVERRIDES[full_key])
            # Merge small categories
            entry["category"] = _CATEGORY_MERGE.get(entry["category"], entry["category"])
            schema[full_key] = entry
    return schema


CONFIG_SCHEMA = _build_schema_from_config(DEFAULT_CONFIG)

# Inject virtual fields that don't live in DEFAULT_CONFIG but are surfaced
# by the normalize/denormalize cycle.  Insert model_context_length right after
# the "model" key so it renders adjacent in the frontend.
_mcl_entry = _SCHEMA_OVERRIDES["model_context_length"]
_ordered_schema: Dict[str, Dict[str, Any]] = {}
for _k, _v in CONFIG_SCHEMA.items():
    _ordered_schema[_k] = _v
    if _k == "model":
        _ordered_schema["model_context_length"] = _mcl_entry
CONFIG_SCHEMA = _ordered_schema


class ConfigUpdate(BaseModel):
    config: dict


class EnvVarUpdate(BaseModel):
    key: str
    value: str


class EnvVarDelete(BaseModel):
    key: str


class EnvVarReveal(BaseModel):
    key: str


class ModelProviderUpdate(BaseModel):
    provider: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None


# Marker page each embedded browser WebContentsView loads on open. The desktop
# agent's browser tools find the view by this ``/start?ws=<id>`` URL (the CDP
# target id is captured once at bind time, then stays stable across navigation).
# Ports desktop/server.py's proven marker-bind into the dashboard.
#
# DELIBERATELY a public, non-``/api`` path: the embedded WebContentsView is a
# separate session with NO dashboard token, so it must load this page without
# auth. ``/api/*`` routes are token-gated by the dashboard auth middleware, so
# the marker cannot live there.
_BROWSER_START_HTML = (
    '<!doctype html><html><head><meta charset="utf-8"><title>浏览器工作台</title>'
    "<style>html,body{height:100%;margin:0;display:flex;align-items:center;"
    "justify-content:center;font-family:system-ui,sans-serif;background:#fafafa;"
    "color:#9aa0a6}</style></head><body><div style=\"text-align:center\">"
    '<div style="font-size:42px">🌐</div>'
    '<div style="margin-top:10px;font-size:15px">浏览器工作台 — 在上方输入网址,或让 agent 帮你操作。</div>'
    "</div></body></html>"
)


@app.get("/start")
async def browser_workspace_marker(ws: str = "main"):
    return HTMLResponse(_BROWSER_START_HTML)


# ---------------------------------------------------------------------------
# Read-only filesystem API (desktop file browser / preview backend).
#Every /api/fs/* route sits behind the
# global auth_middleware (loopback session token) + host_header_middleware, so
# this read surface is not exposed beyond the authenticated dashboard.
# NOTE: no in-app (Electron) consumer is wired yet in our fork — additive and
# dormant until a renderer file viewer calls it.
# ---------------------------------------------------------------------------
_FS_READDIR_HIDDEN = {
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
}


def _is_sensitive_filename(name: str) -> bool:
    """Return whether *name* is an environment file that may hold secrets."""
    lowered = str(name or "").lower()
    return lowered == ".env" or lowered.startswith(".env.")


_FS_DATA_URL_MAX_BYTES = 16 * 1024 * 1024
_FS_TEXT_SOURCE_MAX_BYTES = 64 * 1024 * 1024
_FS_TEXT_PREVIEW_MAX_BYTES = 512 * 1024
_FS_PREVIEW_LANGUAGE_BY_EXT = {
    ".c": "c",
    ".conf": "ini",
    ".cpp": "cpp",
    ".css": "css",
    ".csv": "csv",
    ".go": "go",
    ".graphql": "graphql",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".kt": "kotlin",
    ".lua": "lua",
    ".md": "markdown",
    ".mjs": "javascript",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".sql": "sql",
    ".svg": "xml",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".txt": "text",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zsh": "shell",
}
_FS_MIME_TYPES = {
    ".avi": "video/x-msvideo",
    ".bmp": "image/bmp",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg; codecs=opus",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
}


def _fs_path(raw_path: str) -> Path:
    raw = str(raw_path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Path is required")
    if "\0" in raw:
        raise HTTPException(status_code=400, detail="Invalid path")
    try:
        if raw.lower().startswith("file:"):
            parsed = urllib.parse.urlparse(raw)
            if parsed.netloc and parsed.netloc not in {"", "localhost"}:
                raise ValueError
            raw = urllib.request.url2pathname(parsed.path)
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        return candidate.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path")


def _fs_mime_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in _FS_MIME_TYPES:
        return _FS_MIME_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def _fs_looks_binary(data: bytes) -> bool:
    if not data:
        return False
    if b"\0" in data:
        return True
    suspicious = sum(1 for byte in data if byte < 32 and byte not in {9, 10, 13})
    return suspicious / len(data) > 0.12


def _fs_regular_file(path: Path) -> tuple[Path, os.stat_result]:
    target = _fs_path(str(path))
    try:
        st = target.stat()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except NotADirectoryError:
        raise HTTPException(status_code=404, detail="File not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="File is not readable")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc) or "Invalid path")
    if stat.S_ISDIR(st.st_mode):
        raise HTTPException(status_code=400, detail="Path points to a directory")
    if not stat.S_ISREG(st.st_mode):
        raise HTTPException(status_code=400, detail="Only regular files can be read")
    return target, st


def _fs_find_git_root(start: Path) -> str | None:
    directory = start
    for _ in range(50):
        try:
            if (directory / ".git").exists():
                return str(directory)
        except OSError:
            return None
        parent = directory.parent
        if parent == directory:
            return None
        directory = parent
    return None


def _fs_default_cwd() -> str:
    cfg_terminal = load_config().get("terminal") or {}
    raw = str(cfg_terminal.get("cwd") or os.environ.get("TERMINAL_CWD") or "").strip()
    if raw and raw not in {".", "auto", "cwd"}:
        try:
            candidate = Path(raw).expanduser().resolve(strict=False)
            if candidate.is_dir():
                return str(candidate)
        except (OSError, RuntimeError):
            pass
    return str(Path.cwd())


def _fs_git_branch(cwd: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "branch", "--show-current"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


@app.get("/api/fs/list")
async def fs_list(path: str):
    target = _fs_path(path)
    try:
        entries = []
        with os.scandir(target) as scan:
            for entry in scan:
                if entry.name in _FS_READDIR_HIDDEN or _is_sensitive_filename(entry.name):
                    continue
                entries.append({
                    "name": entry.name,
                    "path": str(target / entry.name),
                    "isDirectory": entry.is_dir(follow_symlinks=False),
                })
        entries.sort(key=lambda item: (not item["isDirectory"], item["name"].lower(), item["name"]))
        return {"entries": entries}
    except FileNotFoundError:
        return {"entries": [], "error": "ENOENT"}
    except NotADirectoryError:
        return {"entries": [], "error": "ENOTDIR"}
    except PermissionError:
        return {"entries": [], "error": "EACCES"}
    except OSError as exc:
        return {"entries": [], "error": getattr(exc, "strerror", None) or "read-error"}


@app.get("/api/fs/read-text")
async def fs_read_text(path: str):
    target, st = _fs_regular_file(_fs_path(path))
    if _is_sensitive_filename(target.name):
        raise HTTPException(status_code=403, detail="Access to sensitive files is not allowed")
    if st.st_size > _FS_TEXT_SOURCE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    bytes_to_read = min(st.st_size, _FS_TEXT_PREVIEW_MAX_BYTES)
    try:
        with target.open("rb") as handle:
            data = handle.read(bytes_to_read)
    except PermissionError:
        raise HTTPException(status_code=403, detail="File is not readable")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc) or "File read failed")
    return {
        "binary": _fs_looks_binary(data[:4096]),
        "byteSize": st.st_size,
        "language": _FS_PREVIEW_LANGUAGE_BY_EXT.get(target.suffix.lower(), "text"),
        "mimeType": _fs_mime_type(target),
        "path": str(target),
        "text": data.decode("utf-8", errors="replace"),
        "truncated": st.st_size > _FS_TEXT_PREVIEW_MAX_BYTES,
    }


@app.get("/api/fs/read-data-url")
async def fs_read_data_url(path: str):
    target, st = _fs_regular_file(_fs_path(path))
    if _is_sensitive_filename(target.name):
        raise HTTPException(status_code=403, detail="Access to sensitive files is not allowed")
    if st.st_size > _FS_DATA_URL_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    try:
        encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    except PermissionError:
        raise HTTPException(status_code=403, detail="File is not readable")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc) or "File read failed")
    return {"dataUrl": f"data:{_fs_mime_type(target)};base64,{encoded}"}


@app.get("/api/fs/git-root")
async def fs_git_root(path: str):
    target = _fs_path(path)
    try:
        st = target.stat()
        start = target if stat.S_ISDIR(st.st_mode) else target.parent
    except OSError:
        start = target
    return {"root": _fs_find_git_root(start)}


@app.get("/api/fs/default-cwd")
async def fs_default_cwd():
    cwd = _fs_default_cwd()
    return {"cwd": cwd, "branch": _fs_git_branch(cwd)}


@app.get("/api/status")
async def get_status():
    """Liveness probe (in ``PUBLIC_API_PATHS``): version only.

    The Electron shell polls this during boot (``waitForFan``) and only cares
    about the 200. The old System settings panel that rendered gateway state,
    session counts and log tails is gone — end users never see raw internals.
    """
    return {"version": __version__, "release_date": __release_date__}


_WINDOWS_11_MIN_BUILD = 22000


def _windows_build_number(version: str, platform_label: str) -> Optional[int]:
    """Extract the Windows NT build number from stdlib platform strings."""
    for value in (version or "", platform_label or ""):
        match = re.search(r"(?:^|[^\d])10\.0\.(\d{5,})(?:[^\d]|$)", value)
        if not match:
            continue
        try:
            return int(match.group(1))
        except ValueError:
            continue
    return None


def _display_system_platform(
    *,
    system: str,
    release: str,
    version: str,
    platform_label: str,
) -> Dict[str, str]:
    """Return host OS fields for display while preserving stdlib detail."""
    if system == "Windows" and release == "10":
        build = _windows_build_number(version, platform_label)
        if build is not None and build >= _WINDOWS_11_MIN_BUILD:
            platform_label = re.sub(
                r"^Windows-10(?=-)",
                "Windows-11",
                platform_label,
                count=1,
            )
            release = "11"

    return {
        "os": system,
        "os_release": release,
        "os_version": version,
        "platform": platform_label,
    }


@app.get("/api/system/stats")
async def get_system_stats():
    """Host + process system stats for the System page.

    OS / Python / host identity from stdlib; CPU / memory / disk / uptime from
    psutil when available, with graceful degradation when it isn't.  Read-only
    and non-sensitive (no env values, no paths beyond the fan home root).
    """
    import platform as _platform

    info: Dict[str, Any] = {
        **_display_system_platform(
            system=_platform.system(),
            release=_platform.release(),
            version=_platform.version(),
            platform_label=_platform.platform(),
        ),
        "arch": _platform.machine(),
        "hostname": _platform.node(),
        "python_version": _platform.python_version(),
        "python_impl": _platform.python_implementation(),
        "fan_version": __version__,
        "cpu_count": os.cpu_count(),
    }

    # psutil enriches the picture when present; everything below is optional.
    try:
        import psutil  # type: ignore

        vm = psutil.virtual_memory()
        info["memory"] = {
            "total": vm.total,
            "available": vm.available,
            "used": vm.used,
            "percent": vm.percent,
        }
        try:
            du = psutil.disk_usage(str(get_fan_home()))
            info["disk"] = {
                "total": du.total,
                "used": du.used,
                "free": du.free,
                "percent": du.percent,
            }
        except Exception:
            pass
        try:
            info["cpu_percent"] = psutil.cpu_percent(interval=0.1)
            la = getattr(psutil, "getloadavg", None)
            if la:
                info["load_avg"] = list(la())
        except Exception:
            pass
        try:
            boot = psutil.boot_time()
            info["uptime_seconds"] = int(time.time() - boot)
        except Exception:
            pass
        try:
            proc = psutil.Process()
            info["process"] = {
                "pid": proc.pid,
                "rss": proc.memory_info().rss,
                "create_time": int(proc.create_time()),
                "num_threads": proc.num_threads(),
            }
        except Exception:
            pass
        info["psutil"] = True
    except Exception:
        info["psutil"] = False
        # stdlib-only fallbacks for load average + uptime where the kernel
        # exposes them.
        try:
            info["load_avg"] = list(os.getloadavg())
        except (OSError, AttributeError):
            pass

    return info


# ---------------------------------------------------------------------------
# Curator endpoints — background skill-maintenance status + controls.
#
# The curator periodically reviews skills (archive stale, prune, pin).  The
# dashboard surfaces its state and the pause/resume/run-now controls that
# `fan curator` exposes.
# ---------------------------------------------------------------------------


@app.get("/api/curator")
async def get_curator_status():
    try:
        from agent import curator
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Curator unavailable: {exc}")
    try:
        state = curator.load_state()
    except Exception:
        state = {}
    return {
        "enabled": _safe_call(curator, "is_enabled", True),
        "paused": _safe_call(curator, "is_paused", False),
        "interval_hours": _safe_call(curator, "get_interval_hours", None),
        "last_run_at": state.get("last_run_at"),
        "min_idle_hours": _safe_call(curator, "get_min_idle_hours", None),
        "stale_after_days": _safe_call(curator, "get_stale_after_days", None),
        "archive_after_days": _safe_call(curator, "get_archive_after_days", None),
        "consolidate": _safe_call(curator, "get_consolidate", False),
    }


class CuratorPause(BaseModel):
    paused: bool


@app.put("/api/curator/paused")
async def set_curator_paused(body: CuratorPause):
    from agent import curator

    curator.set_paused(bool(body.paused))
    return {"ok": True, "paused": bool(body.paused)}




def _safe_call(mod, fn_name: str, default):
    try:
        fn = getattr(mod, fn_name, None)
        return fn() if callable(fn) else default
    except Exception:
        return default


def _elevenlabs_voice_label(voice: Dict[str, Any]) -> str:
    name = str(voice.get("name") or voice.get("voice_id") or "Voice").strip()
    category = str(voice.get("category") or "").strip()

    return f"{name} ({category})" if category else name


@app.get("/api/audio/elevenlabs/voices")
async def get_elevenlabs_voices():
    """Return ElevenLabs voices when an API key is configured.

    The desktop UI uses this for the ``tts.elevenlabs.voice_id`` dropdown.
    Only non-secret voice metadata is returned; the API key stays server-side.
    """
    api_key = (load_env().get("ELEVENLABS_API_KEY") or os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not api_key:
        return {"available": False, "voices": []}

    request = urllib.request.Request(
        "https://api.elevenlabs.io/v1/voices",
        headers={
            "Accept": "application/json",
            "xi-api-key": api_key,
        },
    )

    try:
        loop = asyncio.get_running_loop()

        def _fetch() -> Dict[str, Any]:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))

        payload = await loop.run_in_executor(None, _fetch)
    except Exception as exc:
        _log.warning("ElevenLabs voice list failed: %s", exc)
        raise HTTPException(status_code=502, detail="Could not load ElevenLabs voices")

    voices = []
    for voice in payload.get("voices") or []:
        if not isinstance(voice, dict):
            continue

        voice_id = str(voice.get("voice_id") or "").strip()
        if not voice_id:
            continue

        voices.append({
            "voice_id": voice_id,
            "name": str(voice.get("name") or voice_id),
            "label": _elevenlabs_voice_label(voice),
        })

    voices.sort(key=lambda item: str(item.get("label") or "").lower())
    return {"available": True, "voices": voices}


@app.get("/api/sessions")
async def get_sessions(
    limit: int = 20,
    offset: int = 0,
    min_messages: int = 0,
    archived: str = "exclude",
    order: str = "created",
):
    """List sessions.

    ``archived`` controls how soft-archived sessions are treated:
    ``exclude`` (default) hides them, ``only`` returns just the archived ones
    (used by the desktop "Archived sessions" settings panel), and ``include``
    returns both.

    ``order`` controls pagination order: ``created`` (default, by original
    start time) or ``recent`` (by latest activity across the compression
    chain). ``recent`` keeps a long-running conversation on the first page
    after it auto-compresses into a fresh continuation id.
    """
    if archived not in ("exclude", "only", "include"):
        raise HTTPException(
            status_code=400,
            detail="archived must be one of: exclude, only, include",
        )
    if order not in ("created", "recent"):
        raise HTTPException(
            status_code=400,
            detail="order must be one of: created, recent",
        )

    def _read_sessions() -> dict:
        from fan_state import SessionDB

        db = SessionDB()
        try:
            min_message_count = max(0, min_messages)
            archived_only = archived == "only"
            include_archived = archived == "include"
            sessions = db.list_sessions_rich(
                limit=limit,
                offset=offset,
                min_message_count=min_message_count,
                include_archived=include_archived,
                archived_only=archived_only,
                order_by_last_active=order == "recent",
            )
            total = db.session_count(
                min_message_count=min_message_count,
                include_archived=include_archived,
                archived_only=archived_only,
                exclude_children=True,
            )
            now = time.time()
            for session in sessions:
                session["is_active"] = (
                    session.get("ended_at") is None
                    and (now - session.get("last_active", session.get("started_at", 0))) < 300
                )
                # Session-list cards never use the full system prompt. Keeping
                # it out of this high-frequency payload avoids copying a large
                # static blob for every row.
                session.pop("system_prompt", None)
                # SQLite stores the flag as 0/1; expose a real JSON boolean.
                session["archived"] = bool(session.get("archived"))
            return {"sessions": sessions, "total": total, "limit": limit, "offset": offset}
        finally:
            db.close()

    try:
        return await asyncio.to_thread(_read_sessions)
    except Exception:
        _log.exception("GET /api/sessions failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/sessions/search")
async def search_sessions(q: str = "", limit: int = 20):
    """Search sessions by ID plus full-text message content using FTS5.

    Direct session-id matches are surfaced first, then FTS message-content
    matches. Results are deduped by compression lineage, not by raw
    ``session_id``. Auto-compression rotates a conversation onto a fresh
    session id (and leaves the old segment's messages in the FTS index), so one
    logical chat can own many ``sessions`` rows that all match the same query.
    Branches also use ``parent_session_id``, but they are real alternate
    conversations; don't collapse branch-specific hits back into the parent.
    """
    if not q or not q.strip():
        return {"results": []}
    try:
        from fan_state import SessionDB
        db = SessionDB()
        try:
            safe_limit = max(1, min(int(limit or 20), 100))

            # Walk parent_session_id to the compression root, memoized so a
            # chain of compression segments only costs one walk. We deliberately
            # stop at branch/delegate edges: those sessions may diverge from the
            # parent and should remain searchable on their own.
            root_cache: dict = {}

            def compression_root(session_id: str) -> str:
                if not session_id:
                    return session_id
                if session_id in root_cache:
                    return root_cache[session_id]
                chain = []
                cur = session_id
                visited = set()
                root = session_id
                while cur and cur not in visited:
                    visited.add(cur)
                    chain.append(cur)
                    if cur in root_cache:
                        root = root_cache[cur]
                        break
                    try:
                        s = db.get_session(cur)
                    except Exception:
                        s = None
                    if not s:
                        root = cur
                        break
                    parent = s.get("parent_session_id") if isinstance(s, dict) else None
                    if not parent:
                        root = cur
                        break
                    try:
                        parent_session = db.get_session(parent)
                    except Exception:
                        parent_session = None
                    if not parent_session:
                        root = cur
                        break
                    parent_ended_at = parent_session.get("ended_at")
                    started_at = s.get("started_at")
                    is_compression_edge = (
                        parent_session.get("end_reason") == "compression"
                        and parent_ended_at is not None
                        and started_at is not None
                        and started_at >= parent_ended_at
                    )
                    if not is_compression_edge:
                        root = cur
                        break
                    cur = parent
                for node in chain:
                    root_cache[node] = root
                return root

            tip_cache: dict = {}

            def lineage_tip(root_id: str) -> str:
                if root_id in tip_cache:
                    return tip_cache[root_id]
                tip = root_id
                try:
                    resolved = db.get_compression_tip(root_id)
                    if resolved:
                        tip = resolved
                except Exception:
                    pass
                tip_cache[root_id] = tip
                return tip

            # Both ID matches and content matches share one keyspace, keyed by
            # compression lineage root, so an id-hit and a content-hit on the
            # same logical conversation collapse to a single result. The first
            # hit for a lineage wins; ID matches run first and take priority.
            seen: dict = {}

            def add_lineage_result(raw_sid: str, payload: dict) -> None:
                if not raw_sid:
                    return
                root = compression_root(raw_sid)
                if root in seen or len(seen) >= safe_limit:
                    return
                payload = dict(payload)
                payload["session_id"] = lineage_tip(root)
                payload["lineage_root"] = root
                seen[root] = payload

            # Direct ID matches first: users often paste a session id from CLI,
            # logs, or another Fan surface. FTS can't find those unless the
            # id happens to appear in message text. search_sessions_by_id is
            # SQL-bounded, so this stays cheap even with thousands of sessions.
            for row in db.search_sessions_by_id(q, limit=safe_limit, include_archived=True):
                sid = row.get("id")
                preview = (row.get("preview") or "").strip()
                snippet = preview or f"Session ID: {sid}"
                add_lineage_result(
                    sid,
                    {
                        "snippet": snippet,
                        "role": None,
                        "source": row.get("source"),
                        "model": row.get("model"),
                        "session_started": row.get("started_at"),
                    },
                )

            # Auto-add prefix wildcards so partial words match
            # e.g. "nimb" → "nimb*" matches "nimby"
            # Preserve quoted phrases and existing wildcards as-is
            import re
            terms = []
            for token in re.findall(r'"[^"]*"|\S+', q.strip()):
                if token.startswith('"') or token.endswith("*"):
                    terms.append(token)
                else:
                    terms.append(token + "*")
            prefix_query = " ".join(terms)
            # Over-fetch so lineage dedup can still surface `limit` distinct
            # conversations even when several hits collapse onto one root.
            fetch_limit = max(safe_limit * 5, 50)
            matches = db.search_messages(query=prefix_query, limit=fetch_limit)

            for m in matches:
                if len(seen) >= safe_limit:
                    break
                add_lineage_result(
                    m["session_id"],
                    {
                        "snippet": m.get("snippet", ""),
                        "role": m.get("role"),
                        "source": m.get("source"),
                        "model": m.get("model"),
                        "session_started": m.get("session_started"),
                    },
                )
            return {"results": list(seen.values())}
        finally:
            db.close()
    except Exception:
        _log.exception("GET /api/sessions/search failed")
        raise HTTPException(status_code=500, detail="Search failed")


def _normalize_config_for_web(config: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize config for the web UI.

    Fan supports ``model`` as either a bare string (``"qwen3.5-plus"``)
    or a dict (``{default: ..., provider: ..., base_url: ...}``).  The schema is built
    from DEFAULT_CONFIG where ``model`` is a string, but user configs often have the
    dict form.  Normalize to the string form so the frontend schema matches.

    Also surfaces ``model_context_length`` as a top-level field so the web UI can
    display and edit it.  A value of 0 means "auto-detect".
    """
    config = dict(config)  # shallow copy
    model_val = config.get("model")
    if isinstance(model_val, dict):
        # Extract context_length before flattening the dict
        ctx_len = model_val.get("context_length", 0)
        config["model"] = model_val.get("default", model_val.get("name", ""))
        config["model_context_length"] = ctx_len if isinstance(ctx_len, int) else 0
    else:
        config["model_context_length"] = 0
    return config


@app.get("/api/config")
async def get_config():
    config = _normalize_config_for_web(load_config())
    # Strip internal keys that the frontend shouldn't see or send back
    return {k: v for k, v in config.items() if not k.startswith("_")}


@app.get("/api/config/defaults")
async def get_defaults():
    return DEFAULT_CONFIG


@app.get("/api/config/schema")
async def get_schema():
    return {"fields": CONFIG_SCHEMA, "category_order": _CATEGORY_ORDER}


_EMPTY_MODEL_INFO: dict = {
    "model": "",
    "provider": "",
    "base_url": "",
}


@app.get("/api/model/info")
def get_model_info():
    """Return the resolved provider/model for the currently configured model.

    Provider discovery and credential status live at ``/api/model/providers``;
    this compact endpoint remains for existing dashboard consumers.
    """
    try:
        cfg = load_config()
        model_cfg = cfg.get("model", "")

        # Extract provider/model/base_url from the resolved config.
        if isinstance(model_cfg, dict):
            model_name = model_cfg.get("default", model_cfg.get("name", "")) or ""
            provider = model_cfg.get("provider", "") or ""
            base_url = model_cfg.get("base_url", "") or ""
        else:
            model_name = str(model_cfg) if model_cfg else ""
            provider = ""
            base_url = ""

        return {
            "model": model_name,
            "provider": provider,
            "base_url": base_url,
        }
    except Exception:
        _log.exception("GET /api/model/info failed")
        return dict(_EMPTY_MODEL_INFO)


_MODEL_PROVIDER_IDS: Tuple[str, ...] = (
    "deepseek",
    "alibaba",
    "alibaba-coding-plan",
    "ollama-cloud",
    "custom",
)

_MODEL_PROVIDER_DESCRIPTIONS: Dict[str, str] = {
    "deepseek": "DeepSeek official API",
    "alibaba": "Alibaba Bailian / DashScope",
    "alibaba-coding-plan": "Alibaba Cloud Coding Plan",
    "ollama-cloud": "Ollama Cloud",
    "custom": "Custom OpenAI-compatible endpoint",
}


def _mask_provider_key(value: str) -> str:
    """Return a stable, non-secret key hint suitable for JSON responses."""
    secret = str(value or "").strip()
    if not secret:
        return ""
    if len(secret) <= 8:
        return "••••••••"
    return f"{secret[:3]}••••{secret[-4:]}"


def _configured_model_selection() -> Tuple[Optional[str], Optional[str]]:
    raw = read_raw_config()
    model_cfg = raw.get("model")
    if isinstance(model_cfg, dict):
        provider = str(model_cfg.get("provider") or "").strip().lower()
        model = str(
            model_cfg.get("default")
            or model_cfg.get("model")
            or model_cfg.get("name")
            or ""
        ).strip()
    else:
        provider = ""
        model = str(model_cfg or "").strip()
    if provider not in _MODEL_PROVIDER_IDS:
        provider = ""
    return provider or None, model or None


def _custom_provider_values() -> Tuple[str, str, str]:
    raw = read_raw_config()
    model_cfg = raw.get("model")
    if not isinstance(model_cfg, dict):
        return "", "", ""
    if str(model_cfg.get("provider") or "").strip().lower() != "custom":
        return "", "", ""
    from fan_cli.config import get_env_value_prefer_dotenv

    raw_key = str(model_cfg.get("api_key") or model_cfg.get("api") or "").strip()
    key = str(get_env_value_prefer_dotenv("CUSTOM_API_KEY") or "").strip()
    if not key and raw_key and not raw_key.startswith("${"):
        key = raw_key
    return (
        str(model_cfg.get("base_url") or "").strip(),
        key,
        str(model_cfg.get("default") or "").strip(),
    )


def _provider_info(provider_id: str) -> Dict[str, Any]:
    from fan_cli.auth import PROVIDER_REGISTRY, resolve_api_key_provider_credentials

    if provider_id == "custom":
        base_url, api_key, configured_model = _custom_provider_values()
        return {
            "id": "custom",
            "name": "Custom endpoint",
            "description": _MODEL_PROVIDER_DESCRIPTIONS["custom"],
            "auth_type": "custom",
            "env_var": None,
            "configured": bool(base_url and configured_model),
            "masked_key": _mask_provider_key(api_key),
            "models": [],
            "default_model": configured_model,
            "base_url": base_url,
            "recommended": False,
            "requires_base_url": True,
        }

    pconfig = PROVIDER_REGISTRY[provider_id]
    credentials = resolve_api_key_provider_credentials(provider_id)
    api_key = str(credentials.get("api_key") or "")
    models = PROVIDER_MODELS.get(provider_id, ())
    return {
        "id": provider_id,
        "name": pconfig.name,
        "description": _MODEL_PROVIDER_DESCRIPTIONS.get(provider_id, pconfig.name),
        "auth_type": "api_key",
        "env_var": pconfig.api_key_env_vars[0] if pconfig.api_key_env_vars else None,
        "configured": bool(api_key),
        "masked_key": _mask_provider_key(api_key),
        "models": [
            {"id": model_id, "label": model_id}
            for model_id in models
        ],
        "default_model": PROVIDER_DEFAULT_MODELS.get(provider_id, ""),
        "base_url": str(credentials.get("base_url") or pconfig.inference_base_url),
        "recommended": provider_id == "deepseek",
        "requires_base_url": False,
    }


@app.get("/api/model/providers")
async def get_model_providers():
    """Return safe provider setup metadata; full API keys are never returned."""
    try:
        ensure_provider_config_migrated()
        configured_provider, configured_model = _configured_model_selection()
        return {
            "configured_provider": configured_provider,
            "configured_model": configured_model,
            "providers": [
                _provider_info(provider_id)
                for provider_id in _MODEL_PROVIDER_IDS
            ],
        }
    except Exception:
        _log.exception("GET /api/model/providers failed")
        raise HTTPException(status_code=500, detail="Unable to read model provider configuration")


def _validate_custom_base_url(value: str) -> str:
    base_url = str(value or "").strip().rstrip("/")
    try:
        parsed = urllib.parse.urlparse(base_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Custom base_url is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(
            status_code=400,
            detail="Custom base_url must be an absolute http(s) URL",
        )
    if parsed.username or parsed.password or parsed.fragment:
        raise HTTPException(
            status_code=400,
            detail="Custom base_url must not contain credentials or a fragment",
        )
    return base_url


def _verify_provider_models(base_url: str, api_key: str) -> None:
    """Verify an OpenAI-compatible credential via its models endpoint."""
    from fan_cli import __version__ as version
    from fan_cli.urllib_security import open_credentialed_url

    request = urllib.request.Request(base_url.rstrip("/") + "/models")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", f"fan-cli/{version}")
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    try:
        with open_credentialed_url(request, timeout=12.0) as response:
            if response.status < 200 or response.status >= 300:
                raise HTTPException(
                    status_code=400,
                    detail="Provider credential validation failed",
                )
            # Bound the read and parse JSON so an HTML/proxy success page is
            # not accepted as a provider response.
            payload = json.loads(response.read(1_048_577).decode("utf-8"))
            if not isinstance(payload, (dict, list)):
                raise ValueError("unexpected response")
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            detail = "API key was rejected by the provider"
            status_code = 400
        else:
            detail = f"Provider validation failed with HTTP {exc.code}"
            status_code = 502
        raise HTTPException(status_code=status_code, detail=detail) from exc
    except HTTPException:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail="Provider is unreachable") from exc
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Provider returned an invalid models response") from exc


def _persist_custom_provider(*, base_url: str, api_key: str, model: str) -> None:
    config_path = get_config_path()
    from fan_cli.config import (
        atomic_config_write,
        clear_model_endpoint_credentials,
        require_readable_config_before_write,
    )

    require_readable_config_before_write(config_path)
    config = read_raw_config()
    for legacy_key in ("provider", "active_provider", "model_provider"):
        config.pop(legacy_key, None)
    current = config.get("model")
    model_cfg = dict(current) if isinstance(current, dict) else {}
    clear_model_endpoint_credentials(model_cfg)
    model_cfg.update(
        {
            "provider": "custom",
            "default": model,
            "base_url": base_url,
            "api_mode": "chat_completions",
        }
    )
    if api_key:
        model_cfg["api_key"] = "${CUSTOM_API_KEY}"
    config["model"] = model_cfg
    from fan_cli.config import get_env_value, remove_env_value

    old_value = get_env_value("CUSTOM_API_KEY")
    if api_key:
        save_env_value("CUSTOM_API_KEY", api_key)
    try:
        atomic_config_write(config_path, config, sort_keys=False)
    except BaseException:
        if api_key:
            try:
                if old_value is None:
                    remove_env_value("CUSTOM_API_KEY")
                else:
                    save_env_value("CUSTOM_API_KEY", old_value)
            except Exception:
                _log.exception("Failed to roll back CUSTOM_API_KEY")
        raise

    from fan_cli.auth import deactivate_provider

    deactivate_provider()


@app.post("/api/model/provider")
async def set_model_provider(body: ModelProviderUpdate):
    """Validate and persist a provider selection without returning its secret."""
    from fan_cli.auth import (
        AuthError,
        PROVIDER_REGISTRY,
        configure_api_key_provider,
        has_usable_secret,
        resolve_api_key_provider_credentials,
    )

    requested = str(body.provider or "").strip().lower()
    provider_id = normalize_provider(requested)
    if provider_id not in {*PROVIDER_REGISTRY.keys(), "custom"}:
        raise HTTPException(status_code=400, detail=f"Unsupported provider: {requested}")

    model = str(body.model or PROVIDER_DEFAULT_MODELS.get(provider_id, "")).strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    if provider_id == "custom":
        old_base_url, old_api_key, _old_model = _custom_provider_values()
        base_url = _validate_custom_base_url(body.base_url or old_base_url)
        api_key = str(body.api_key or "").strip() or old_api_key
        await asyncio.to_thread(_verify_provider_models, base_url, api_key)
        try:
            _persist_custom_provider(base_url=base_url, api_key=api_key, model=model)
        except Exception:
            _log.exception("Failed to persist custom provider")
            raise HTTPException(status_code=500, detail="Unable to save provider configuration")
    else:
        pconfig = PROVIDER_REGISTRY[provider_id]
        supplied_key = str(body.api_key or "").strip()
        existing = resolve_api_key_provider_credentials(provider_id)
        api_key = supplied_key or str(existing.get("api_key") or "")
        if not has_usable_secret(api_key):
            env_var = pconfig.api_key_env_vars[0] if pconfig.api_key_env_vars else "API key"
            raise HTTPException(status_code=400, detail=f"{env_var} is required")
        if provider_id == "deepseek" and model not in PROVIDER_MODELS["deepseek"]:
            raise HTTPException(
                status_code=400,
                detail="DeepSeek model must be deepseek-v4-flash or deepseek-v4-pro",
            )
        base_url = pconfig.inference_base_url.rstrip("/")
        await asyncio.to_thread(_verify_provider_models, base_url, api_key)
        try:
            configure_api_key_provider(
                provider_id,
                api_key=api_key,
                model=model,
                base_url=base_url,
            )
        except AuthError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception:
            _log.exception("Failed to persist provider %s", provider_id)
            raise HTTPException(status_code=500, detail="Unable to save provider configuration")

    return {
        "ok": True,
        "verified": True,
        "configured_provider": provider_id,
        "configured_model": model,
        "provider": _provider_info(provider_id),
    }


# ---------------------------------------------------------------------------
# Auxiliary task slots — per-task overrides for the selected main provider.
#
# The main provider is selected through /api/model/provider. This read endpoint
# lets the dashboard display per-task assignments.
# ---------------------------------------------------------------------------

# Canonical auxiliary task slots. Keep in sync with DEFAULT_CONFIG["auxiliary"]
# in fan_cli/config.py — listed here for deterministic ordering in the UI.
_AUX_TASK_SLOTS: Tuple[str, ...] = (
    "vision",
    "compression",
    "approval",
    "mcp",
    "title_generation",
    "triage_specifier",
    "kanban_decomposer",
    "curator",
)


def _denormalize_config_from_web(config: Dict[str, Any]) -> Dict[str, Any]:
    """Reverse _normalize_config_for_web before saving.

    Reconstructs ``model`` as a dict by reading the current on-disk config
    to recover model subkeys (provider, base_url, api_mode, etc.) that were
    stripped from the GET response.  The frontend only sees model as a flat
    string; the rest is preserved transparently.

    Also handles ``model_context_length`` — writes it back into the model dict
    as ``context_length``.  A value of 0 or absent means "auto-detect" (omitted
    from the dict so get_model_context_length() uses its normal resolution).
    """
    config = dict(config)
    # Remove any _model_meta that might have leaked in (shouldn't happen
    # with the stripped GET response, but be defensive)
    config.pop("_model_meta", None)

    # Extract and remove model_context_length before processing model
    ctx_override = config.pop("model_context_length", 0)
    if not isinstance(ctx_override, int):
        try:
            ctx_override = int(ctx_override)
        except (TypeError, ValueError):
            ctx_override = 0

    model_val = config.get("model")
    if isinstance(model_val, str) and model_val:
        # Read the current disk config to recover model subkeys
        try:
            disk_config = load_config()
            disk_model = disk_config.get("model")
            if isinstance(disk_model, dict):
                # Preserve all subkeys, update default with the new value
                disk_model["default"] = model_val
                # Write context_length into the model dict (0 = remove/auto)
                if ctx_override > 0:
                    disk_model["context_length"] = ctx_override
                else:
                    disk_model.pop("context_length", None)
                config["model"] = disk_model
            # Model was previously a bare string — upgrade to dict if
            # user is setting a context_length override
            elif ctx_override > 0:
                config["model"] = {
                    "default": model_val,
                    "context_length": ctx_override,
                }
        except Exception:
            pass  # can't read disk config — just use the string form
    return config


@app.put("/api/config")
async def update_config(body: ConfigUpdate):
    try:
        # The editor is schema-driven, so it never submits every supported
        # config key.  Merge the explicit update over the raw user layer
        # instead of replacing that layer and silently discarding unrelated
        # settings such as custom providers or advanced agent options.
        existing = read_raw_config()
        incoming = _denormalize_config_from_web(body.config)
        save_config(_deep_merge(existing, incoming))
        # Static gateway messages cache display.language for hot paths. The
        # desktop language switch must take effect without restarting Fan.
        from agent.i18n import reset_language_cache

        reset_language_cache()
        return {"ok": True}
    except Exception:
        _log.exception("PUT /api/config failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/env")
async def get_env_vars():
    env_on_disk = load_env()
    result = {}
    for var_name, info in OPTIONAL_ENV_VARS.items():
        value = env_on_disk.get(var_name)
        result[var_name] = {
            "is_set": bool(value),
            "redacted_value": redact_key(value) if value else None,
            "description": info.get("description", ""),
            "url": info.get("url"),
            "category": info.get("category", ""),
            "is_password": info.get("password", False),
            "tools": info.get("tools", []),
            "advanced": info.get("advanced", False),
        }
    return result


@app.put("/api/env")
async def set_env_var(body: EnvVarUpdate):
    try:
        save_env_value(body.key, body.value)
        return {"ok": True, "key": body.key}
    except ValueError as exc:
        # save_env_value raises ValueError for invalid names and for keys
        # on the denylist (LD_PRELOAD, PATH, PYTHONPATH, …). Surface the
        # message to the SPA so the user understands why the write was
        # refused instead of seeing an opaque 500.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        _log.exception("PUT /api/env failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.delete("/api/env")
async def remove_env_var(body: EnvVarDelete):
    try:
        removed = remove_env_value(body.key)
        if not removed:
            raise HTTPException(status_code=404, detail=f"{body.key} not found in .env")
        return {"ok": True, "key": body.key}
    except HTTPException:
        raise
    except ValueError as exc:
        # remove_env_value raises ValueError for invalid key names. Surface
        # the message to the SPA so the user understands why the delete was
        # refused instead of seeing an opaque 500. Mirrors PUT /api/env.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        _log.exception("DELETE /api/env failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/api/env/reveal")
async def reveal_env_var(body: EnvVarReveal, request: Request):
    """Return the real (unredacted) value of a single env var.

    Protected by:
    - Ephemeral session token (generated per server start, injected into SPA)
    - Rate limiting (max 5 reveals per 30s window)
    - Audit logging
    """
    # --- Token check ---
    _require_token(request)

    # Provider keys are write-only through the provider setup API. Keeping
    # them out of the generic reveal surface guarantees provider responses can
    # never return a full model credential.
    try:
        from fan_cli.auth import PROVIDER_REGISTRY

        provider_secret_names = {
            env_var
            for provider in PROVIDER_REGISTRY.values()
            for env_var in provider.api_key_env_vars
        }
    except Exception:
        provider_secret_names = set()
    if body.key in provider_secret_names:
        raise HTTPException(status_code=403, detail="Provider API keys are write-only")
    if body.key == "CUSTOM_API_KEY":
        raise HTTPException(status_code=403, detail="Provider API keys are write-only")

    # --- Rate limit ---
    now = time.time()
    cutoff = now - _REVEAL_WINDOW_SECONDS
    _reveal_timestamps[:] = [t for t in _reveal_timestamps if t > cutoff]
    if len(_reveal_timestamps) >= _REVEAL_MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many reveal requests. Try again shortly.")
    _reveal_timestamps.append(now)

    # --- Reveal ---
    env_on_disk = load_env()
    value = env_on_disk.get(body.key)
    if value is None:
        raise HTTPException(status_code=404, detail=f"{body.key} not found in .env")

    _log.info("env/reveal: %s", body.key)
    return {"key": body.key, "value": value}


# ---------------------------------------------------------------------------
# Session detail endpoints
# ---------------------------------------------------------------------------



def _session_latest_descendant(session_id: str):
    """Resolve a session id to the newest child leaf session.

    /model may create child sessions. Dashboard refresh should continue the
    newest child instead of reopening the old parent.
    """
    from fan_state import SessionDB

    def row_get(row, key, index):
        if isinstance(row, dict):
            return row.get(key)
        try:
            return row[key]
        except Exception:
            try:
                return row[index]
            except Exception:
                return None

    db = SessionDB()
    try:
        sid = db.resolve_session_id(session_id)
        if not sid or not db.get_session(sid):
            return None, []

        conn = (
            getattr(db, "conn", None)
            or getattr(db, "_conn", None)
            or getattr(db, "connection", None)
            or getattr(db, "_connection", None)
        )

        rows = []
        if conn is not None:
            raw_rows = conn.execute(
                "SELECT id, parent_session_id, started_at FROM sessions"
            ).fetchall()
            for row in raw_rows:
                rows.append({
                    "id": row_get(row, "id", 0),
                    "parent_session_id": row_get(row, "parent_session_id", 1),
                    "started_at": row_get(row, "started_at", 2),
                })
        else:
            rows = db.list_sessions_rich(limit=10000, offset=0)

        children = {}
        for row in rows:
            rid = row.get("id")
            parent = row.get("parent_session_id")
            if rid and parent:
                children.setdefault(parent, []).append(row)

        def started(row):
            try:
                return float(row.get("started_at") or 0)
            except Exception:
                return 0.0

        current = sid
        path = [sid]
        seen = {sid}

        while children.get(current):
            candidates = [r for r in children[current] if r.get("id") not in seen]
            if not candidates:
                break
            candidates.sort(key=started, reverse=True)
            current = candidates[0]["id"]
            path.append(current)
            seen.add(current)

        return current, path
    finally:
        db.close()


# CRITICAL — every literal-path route below MUST be declared BEFORE the
# templated ``/api/sessions/{session_id}`` family that follows. FastAPI/
# Starlette match routes in registration order, and the ``{session_id}``
# pattern is unconstrained — it would otherwise swallow e.g.
# ``DELETE /api/sessions/empty``, ``POST /api/sessions/bulk-delete``, or
# ``GET /api/sessions/stats`` as "operate on the session with id
# 'empty'" / "'bulk-delete'" / "'stats'", which would 404 (or worse,
# succeed and delete the wrong row). Same story as the older
# ``/api/sessions/search`` endpoint up at line ~1191. If you split or
# reorder this block, move every route in it together.
class BulkDeleteSessions(BaseModel):
    ids: List[str]


@app.post("/api/sessions/bulk-delete")
async def bulk_delete_sessions_endpoint(body: BulkDeleteSessions):
    """Delete every session in ``body.ids`` in a single DB transaction.

    Backs the dashboard's bulk-select-and-delete flow on the sessions
    page. POST (not DELETE) because most HTTP clients refuse to send a
    request body on DELETE and a body is the natural shape for a list
    of IDs — Starlette accepts both, but POSTing a list keeps proxies,
    curl, and the browser ``fetch`` API consistent.

    Per-row contract matches :meth:`SessionDB.delete_sessions`:

    * Unknown IDs are silently skipped (the response ``deleted`` count
      reflects what really happened, not the input length). This is
      deliberate — UI selection state can race against another tab's
      delete, and we'd rather succeed-on-the-rest than fail-the-whole-
      batch.
    * Children of every deleted parent are orphaned, not cascade-
      deleted.
    * Active and archived sessions ARE deleted when explicitly
      selected — unlike ``DELETE /api/sessions/empty``, the user
      hand-picked the rows so we trust the selection.
    * Like the other session-delete endpoints, this does NOT pass a
      ``sessions_dir`` through; on-disk transcript / request-dump
      cleanup runs at the CLI/agent layer on the next prune pass.

    The response carries the actual deleted count, so the dashboard
    can surface it in a toast. The IDs that were removed are not
    echoed back because the client already knows what it asked to
    delete (unknown IDs are silently skipped — see contract above)
    and can prune its in-memory list directly from the request.
    """
    # Enforce a hard cap so a runaway/typo'd selection can't lock the
    # DB writer for an extended window. The dashboard pages 20 rows
    # at a time; 500 covers a "select all on every page in a
    # reasonable scrollback" worst case without opening the door to
    # multi-thousand-row transactions.
    if len(body.ids) > 500:
        raise HTTPException(
            status_code=400,
            detail="ids must contain at most 500 entries",
        )
    from fan_state import SessionDB
    db = SessionDB()
    try:
        deleted = db.delete_sessions(body.ids)
        return {"ok": True, "deleted": deleted}
    finally:
        db.close()


@app.get("/api/sessions/empty/count")
async def count_empty_sessions_endpoint():
    """Return the number of empty, ended, non-archived sessions.

    Drives the dashboard's "Delete empty (N)" button — when N is 0 the
    UI hides the affordance so users aren't presented with a button
    that does nothing. Cheap, single-COUNT query.
    """
    from fan_state import SessionDB
    db = SessionDB()
    try:
        return {"count": db.count_empty_sessions()}
    finally:
        db.close()


@app.delete("/api/sessions/empty")
async def delete_empty_sessions_endpoint():
    """Delete every empty (``message_count == 0``), ended,
    non-archived session in a single transaction.

    Safety contract mirrors :meth:`SessionDB.delete_empty_sessions`:

    * Active sessions are skipped (``ended_at IS NULL``) so a live
      agent isn't yanked mid-handshake.
    * Archived sessions are skipped — the user explicitly chose to
      keep those rows.
    * Children of deleted parents are orphaned, not cascade-deleted.

    Like the single-session ``DELETE /api/sessions/{id}`` endpoint
    below, this doesn't pass a ``sessions_dir`` through — the on-disk
    transcript / request-dump cleanup is wired at the CLI/agent layer
    but the web server historically leaves file cleanup to the next
    prune-on-startup pass. Matching that pre-existing trade-off keeps
    the two delete endpoints' DB-vs-disk behaviour consistent.
    """
    from fan_state import SessionDB
    db = SessionDB()
    try:
        deleted = db.delete_empty_sessions()
        return {"ok": True, "deleted": deleted}
    finally:
        db.close()


@app.get("/api/sessions/stats")
async def get_session_stats():
    """Session-store statistics for the Sessions page (mirrors `fan sessions stats`).

    Registered before ``/api/sessions/{session_id}`` so the literal ``stats``
    path isn't captured as a session id by the parameterized route.
    """
    from fan_state import SessionDB

    db = SessionDB()
    try:
        total = db.session_count(include_archived=True)
        active_store = db.session_count(include_archived=False)
        archived = db.session_count(archived_only=True)
        messages = db.message_count()
        by_source: Dict[str, int] = {}
        try:
            for s in db.list_sessions_rich(limit=10000, include_archived=True):
                src = str(s.get("source") or "cli")
                by_source[src] = by_source.get(src, 0) + 1
        except Exception:
            pass
        return {
            "total": total,
            "active_store": active_store,
            "archived": archived,
            "messages": messages,
            "by_source": by_source,
        }
    finally:
        db.close()


def _open_session_db():
    """Open the current backend's SessionDB."""
    from fan_state import SessionDB
    return SessionDB()


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str):
    db = _open_session_db()
    try:
        sid = db.resolve_session_id(session_id)
        session = db.get_session(sid) if sid else None
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        return session
    finally:
        db.close()



@app.get("/api/sessions/{session_id}/latest-descendant")
async def get_session_latest_descendant(session_id: str):
    latest, path = _session_latest_descendant(session_id)
    if not latest:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "requested_session_id": path[0] if path else session_id,
        "session_id": latest,
        "path": path,
        "changed": bool(path and latest != path[0]),
    }

@app.get("/api/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: str,
    limit: int | None = None,
    offset: int = 0,
):
    """Return a session transcript, optionally as an offset page.

    Existing desktop callers omit both pagination parameters and retain the
    complete-transcript response. Consumers that render long histories can
    opt into bounded pages without changing the session identity contract.
    """
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be non-negative")
    if limit is not None and not 1 <= limit <= 1000:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")

    def _read_messages() -> dict | None:
        db = _open_session_db()
        try:
            sid = db.resolve_session_id(session_id)
            if not sid:
                return None
            sid = db.resolve_resume_session_id(sid)
            messages = db.get_messages(sid)
            total = len(messages)
            if limit is not None:
                messages = messages[offset : offset + limit]
            elif offset:
                messages = messages[offset:]
            return {
                "session_id": sid,
                "messages": messages,
                "total": total,
                "limit": limit,
                "offset": offset,
            }
        finally:
            db.close()

    result = await asyncio.to_thread(_read_messages)
    if result is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return result


@app.delete("/api/sessions/{session_id}")
async def delete_session_endpoint(session_id: str):
    from fan_state import SessionDB
    db = SessionDB()
    try:
        # Match the rest of the session API by accepting exact ids and unique
        # prefixes. DELETE is idempotent: if concurrent cleanup already removed
        # the row, the requested end state has already been reached.
        sid = db.resolve_session_id(session_id)
        if not sid:
            return {"ok": True, "already_absent": True}
        db.delete_session(sid)
        return {"ok": True}
    finally:
        db.close()


class SessionRename(BaseModel):
    title: Optional[str] = None
    archived: Optional[bool] = None


@app.patch("/api/sessions/{session_id}")
async def rename_session_endpoint(session_id: str, body: SessionRename):
    """Update a session: rename (or clear its title) and/or archive it.

    ``title`` renames (empty/null clears the title); ``archived`` soft-hides or
    restores the session. Either field may be omitted.
    """
    db = _open_session_db()
    try:
        sid = db.resolve_session_id(session_id)
        if not sid:
            raise HTTPException(status_code=404, detail="Session not found")
        if body.title is None and body.archived is None:
            raise HTTPException(
                status_code=400,
                detail="Nothing to update; provide 'title' and/or 'archived'.",
            )
        if body.title is not None:
            try:
                db.set_session_title(sid, body.title or "")
            except ValueError as e:
                # Title too long, invalid characters, or already in use.
                raise HTTPException(status_code=400, detail=str(e))
        if body.archived is not None:
            db.set_session_archived(sid, body.archived)
        result = {"ok": True, "title": db.get_session_title(sid) or ""}
        if body.archived is not None:
            result["archived"] = bool(body.archived)
        return result
    finally:
        db.close()


@app.get("/api/sessions/{session_id}/export")
async def export_session_endpoint(session_id: str):
    """Export a single session (metadata + messages) as JSON."""
    from fan_state import SessionDB

    db = SessionDB()
    try:
        sid = db.resolve_session_id(session_id)
        if not sid:
            raise HTTPException(status_code=404, detail="Session not found")
        data = db.export_session(sid)
        if data is None:
            raise HTTPException(status_code=404, detail="Session not found")
        return data
    finally:
        db.close()


class SessionPrune(BaseModel):
    older_than_days: int = 90
    source: Optional[str] = None


@app.post("/api/sessions/prune")
async def prune_sessions_endpoint(body: SessionPrune):
    """Delete ended sessions older than N days (mirrors `fan sessions prune`)."""
    if body.older_than_days < 1:
        raise HTTPException(status_code=400, detail="older_than_days must be >= 1")
    from fan_state import SessionDB

    db = SessionDB()
    try:
        sessions_dir = get_fan_home() / "sessions"
        removed = db.prune_sessions(
            older_than_days=body.older_than_days,
            source=(body.source or None),
            sessions_dir=sessions_dir if sessions_dir.exists() else None,
        )
        return {"ok": True, "removed": removed}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Log viewer endpoint
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Cron job management endpoints
# ---------------------------------------------------------------------------


class CronJobCreate(BaseModel):
    prompt: str
    schedule: str
    name: str = ""
    skills: Optional[List[str]] = None


class CronJobUpdate(BaseModel):
    updates: dict


_CRON_LOCK = threading.RLock()


def _annotate_cron_job(job: Dict[str, Any]) -> Dict[str, Any]:
    annotated = dict(job)
    try:
        from fan_constants import get_fan_home

        annotated["fan_home"] = str(get_fan_home())
    except Exception:
        pass
    return annotated


def _call_cron(func_name: str, *args, **kwargs):
    """Run cron.jobs helpers against the current Fan home."""
    with _CRON_LOCK:
        from cron import jobs as cron_jobs

        result = getattr(cron_jobs, func_name)(*args, **kwargs)

    if isinstance(result, list):
        return [_annotate_cron_job(j) for j in result]
    if isinstance(result, dict):
        return _annotate_cron_job(result)
    return result


@app.get("/api/cron/jobs")
async def list_cron_jobs():
    return _call_cron("list_jobs", True)


@app.get("/api/cron/jobs/{job_id}")
async def get_cron_job(job_id: str):
    job = _call_cron("get_job", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs")
async def create_cron_job(body: CronJobCreate):
    try:
        return _call_cron(
            "create_job",
            prompt=body.prompt,
            schedule=body.schedule,
            name=body.name,
            skills=body.skills,
        )
    except Exception as e:
        _log.exception("POST /api/cron/jobs failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/cron/jobs/{job_id}")
async def update_cron_job(job_id: str, body: CronJobUpdate):
    try:
        job = _call_cron("update_job", job_id, body.updates)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs/{job_id}/pause")
async def pause_cron_job(job_id: str):
    job = _call_cron("pause_job", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs/{job_id}/resume")
async def resume_cron_job(job_id: str):
    job = _call_cron("resume_job", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/api/cron/jobs/{job_id}/trigger")
async def trigger_cron_job(job_id: str):
    job = _call_cron("trigger_job", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.delete("/api/cron/jobs/{job_id}")
async def delete_cron_job(job_id: str):
    try:
        removed = _call_cron("remove_job", job_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# MCP server endpoints — list / add / remove / test.
#
# Wraps the same config data layer the CLI uses (fan_cli.mcp_config), so
# servers managed here show up under `fan mcp list` and vice versa.  Secrets
# in stdio `env` blocks are redacted on read; the agent picks them up from
# config.yaml at session start exactly as with CLI-added servers.
# ---------------------------------------------------------------------------


class MCPServerCreate(BaseModel):
    name: str
    url: Optional[str] = None
    command: Optional[str] = None
    args: List[str] = []
    # env: KEY=VALUE map for stdio servers (API keys, etc.)
    env: Dict[str, str] = {}
    # auth: "oauth" | "header" | None
    auth: Optional[str] = None


def _redact_mcp_env(env: Dict[str, Any]) -> Dict[str, str]:
    """Mask secret-shaped MCP env values for read responses."""
    out: Dict[str, str] = {}
    for k, v in (env or {}).items():
        try:
            out[str(k)] = redact_key(str(v)) if v else ""
        except Exception:
            out[str(k)] = "***"
    return out


def _mcp_server_summary(name: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    transport = "http" if cfg.get("url") else ("stdio" if cfg.get("command") else "unknown")
    return {
        "name": name,
        "transport": transport,
        "url": cfg.get("url"),
        "command": cfg.get("command"),
        "args": list(cfg.get("args") or []),
        "env": _redact_mcp_env(cfg.get("env") or {}),
        "auth": cfg.get("auth"),
        "enabled": cfg.get("enabled", True) is not False,
        # Tool selection: list of enabled tool names, or None = all.
        "tools": cfg.get("tools"),
    }


@app.get("/api/mcp/servers")
async def list_mcp_servers():
    from fan_cli.mcp_config import _get_mcp_servers

    servers = _get_mcp_servers()
    return {
        "servers": [
            _mcp_server_summary(name, cfg) for name, cfg in sorted(servers.items())
        ]
    }


@app.post("/api/mcp/servers")
async def add_mcp_server(body: MCPServerCreate):
    from fan_cli.mcp_config import _get_mcp_servers, _save_mcp_server

    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Server name is required")
    if name in _get_mcp_servers():
        raise HTTPException(status_code=409, detail=f"Server '{name}' already exists")
    if not body.url and not body.command:
        raise HTTPException(
            status_code=400,
            detail="Provide either a URL (HTTP/SSE server) or a command (stdio server)",
        )

    server_config: Dict[str, Any] = {}
    if body.url:
        server_config["url"] = body.url.strip()
    if body.command:
        server_config["command"] = body.command.strip()
        if body.args:
            server_config["args"] = list(body.args)
    if body.env:
        server_config["env"] = dict(body.env)
    if body.auth:
        server_config["auth"] = body.auth

    try:
        if not _save_mcp_server(name, server_config):
            raise HTTPException(
                status_code=400,
                detail=f"Server '{name}' rejected: suspicious command/args configuration",
            )
    except HTTPException:
        raise
    except Exception as exc:
        _log.exception("POST /api/mcp/servers failed")
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _mcp_server_summary(name, server_config)


@app.delete("/api/mcp/servers/{name}")
async def remove_mcp_server(name: str):
    from fan_cli.mcp_config import _remove_mcp_server

    if not _remove_mcp_server(name):
        raise HTTPException(status_code=404, detail=f"Server '{name}' not found")
    return {"ok": True}


@app.post("/api/mcp/servers/{name}/test")
async def test_mcp_server(name: str):
    """Connect to the server, list its tools, disconnect.  Returns tool list."""
    from fan_cli.mcp_config import _get_mcp_servers, _probe_single_server

    servers = _get_mcp_servers()
    if name not in servers:
        raise HTTPException(status_code=404, detail=f"Server '{name}' not found")

    try:
        # Probe blocks on a dedicated MCP event loop — run in a thread so the
        # FastAPI event loop is never blocked.
        tools = await asyncio.to_thread(_probe_single_server, name, servers[name])
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "tools": [],
        }
    return {
        "ok": True,
        "tools": [{"name": t, "description": d} for t, d in tools],
    }


class MCPEnabledToggle(BaseModel):
    enabled: bool


@app.put("/api/mcp/servers/{name}/enabled")
async def set_mcp_server_enabled(name: str, body: MCPEnabledToggle):
    """Enable or disable an MCP server (takes effect on next session/gateway).

    Toggles the ``enabled`` key on the server's config.yaml entry — the same
    flag the agent reads at startup.  Disabled servers stay in config so they
    can be re-enabled without re-entering their settings.
    """
    cfg = load_config()
    servers = cfg.get("mcp_servers")
    if not isinstance(servers, dict) or name not in servers:
        raise HTTPException(status_code=404, detail=f"Server '{name}' not found")
    if not isinstance(servers[name], dict):
        raise HTTPException(status_code=400, detail="Malformed server config")
    servers[name]["enabled"] = bool(body.enabled)
    save_config(cfg)
    return {"ok": True, "name": name, "enabled": bool(body.enabled)}


@app.get("/api/mcp/catalog")
async def list_mcp_catalog():
    """Browse the Nous-approved MCP catalog (the optional-mcps/ manifests).

    Each entry reports whether it's already installed and enabled so the UI
    can show install / enabled state inline.  This is the same catalog
    `fan mcp catalog` / `fan mcp install` read.
    """
    try:
        from fan_cli import mcp_catalog
    except Exception as exc:
        _log.exception("mcp_catalog import failed")
        raise HTTPException(status_code=500, detail=f"Catalog unavailable: {exc}")

    entries = []
    try:
        for entry in mcp_catalog.list_catalog():
            auth = entry.auth
            entries.append({
                "name": entry.name,
                "description": entry.description,
                "source": entry.source,
                "transport": entry.transport.type,
                "auth_type": getattr(auth, "type", "none"),
                # Env vars the user must supply (names + prompts only, never values).
                "required_env": [
                    {"name": e.name, "prompt": e.prompt, "required": e.required}
                    for e in getattr(auth, "env", []) or []
                ],
                "needs_install": entry.install is not None,
                "installed": mcp_catalog.is_installed(entry.name),
                "enabled": mcp_catalog.is_enabled(entry.name),
            })
    except Exception:
        _log.exception("list_mcp_catalog failed")

    diagnostics = []
    try:
        diagnostics = [
            {"name": n, "kind": k, "message": m}
            for (n, k, m) in mcp_catalog.catalog_diagnostics()
        ]
    except Exception:
        pass

    return {"entries": entries, "diagnostics": diagnostics}


class MCPCatalogInstall(BaseModel):
    name: str
    # env: KEY=VALUE map for catalog entries that declare required env vars.
    env: Dict[str, str] = {}
    enable: bool = True




# ---------------------------------------------------------------------------
# Credential pool endpoints — list / add / remove rotation keys.
#
# The credential pool (auth.json -> credential_pool.<provider>[]) holds the
# rotating API keys the agent round-robins through.  Secrets are redacted on
# read; only the agent ever sees the raw values at session start.
# ---------------------------------------------------------------------------


class CredentialPoolAdd(BaseModel):
    provider: str
    # API key stored in the generic provider credential pool.
    api_key: str
    label: Optional[str] = None


def _pool_entry_summary(entry: Any, index: int) -> Dict[str, Any]:
    """Redacted, display-safe view of one PooledCredential.

    ``index`` is 1-based to match CredentialPool.remove_index().
    """
    token = getattr(entry, "access_token", "") or ""
    return {
        "index": index,
        "id": getattr(entry, "id", None),
        "label": getattr(entry, "label", None),
        "auth_type": getattr(entry, "auth_type", None),
        "source": getattr(entry, "source", None),
        "priority": getattr(entry, "priority", 0),
        "last_status": getattr(entry, "last_status", None),
        "request_count": getattr(entry, "request_count", 0),
        "token_preview": redact_key(token) if token else "",
        "has_refresh": bool(getattr(entry, "refresh_token", None)),
    }


def _registered_credential_pool_providers() -> frozenset[str]:
    """Providers whose API keys may be managed through the pool API."""
    from fan_cli.auth import PROVIDER_REGISTRY

    return frozenset(PROVIDER_REGISTRY)


@app.get("/api/credentials/pool")
async def list_credential_pool():
    from agent.credential_pool import load_pool
    from fan_cli.auth import read_credential_pool

    providers = []
    # read_credential_pool(None) lists every provider that has pooled entries;
    # load_pool() then gives us the rich PooledCredential objects per provider.
    raw_pool = read_credential_pool()
    registered = _registered_credential_pool_providers()
    for provider_id in sorted(raw_pool.keys() & registered):
        try:
            pool = load_pool(provider_id)
        except Exception:
            _log.exception("load_pool(%s) failed", provider_id)
            continue
        entries = pool.entries()
        if not entries:
            continue
        providers.append({
            "provider": provider_id,
            "entries": [
                _pool_entry_summary(e, i) for i, e in enumerate(entries, start=1)
            ],
        })
    return {"providers": providers}


@app.post("/api/credentials/pool")
async def add_credential_pool_entry(body: CredentialPoolAdd):
    import uuid as _uuid
    from agent.credential_pool import (
        load_pool,
        PooledCredential,
        AUTH_TYPE_API_KEY,
        SOURCE_MANUAL,
    )

    provider = (body.provider or "").strip().lower()
    api_key = (body.api_key or "").strip()
    if not provider or not api_key:
        raise HTTPException(status_code=400, detail="provider and api_key are required")
    if provider not in _registered_credential_pool_providers():
        raise HTTPException(status_code=400, detail="Unsupported credential provider")
    try:
        pool = load_pool(provider)
        label = (body.label or "").strip() or f"key #{len(pool.entries()) + 1}"
        entry = PooledCredential(
            provider=provider,
            id=_uuid.uuid4().hex[:6],
            label=label,
            auth_type=AUTH_TYPE_API_KEY,
            priority=0,
            source=SOURCE_MANUAL,
            access_token=api_key,
        )
        pool.add_entry(entry)
    except Exception as exc:
        _log.exception("POST /api/credentials/pool failed")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "provider": provider, "count": len(pool.entries())}


@app.delete("/api/credentials/pool/{provider}/{index}")
async def remove_credential_pool_entry(provider: str, index: int):
    """Remove a pool entry.  ``index`` is 1-based (matches the list response)."""
    from agent.credential_pool import load_pool

    provider = (provider or "").strip().lower()
    if provider not in _registered_credential_pool_providers():
        raise HTTPException(status_code=404, detail="Credential provider not found")
    try:
        pool = load_pool(provider)
        removed = pool.remove_index(index)
    except Exception as exc:
        _log.exception("DELETE /api/credentials/pool failed")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if removed is None:
        raise HTTPException(status_code=404, detail="No pool entry at that index")
    return {"ok": True, "provider": provider, "count": len(pool.entries())}


# ---------------------------------------------------------------------------
# Memory provider endpoints — status / list providers / select / disable / reset.
#
# Selecting a provider only writes config.memory.provider (full interactive
# provider setup, with its API-key prompts, stays on the CLI via
# `fan memory setup`).  The dashboard covers the common admin actions:
# see which provider is active, switch the built-in store on/off, and wipe
# built-in memory files.
# ---------------------------------------------------------------------------


class MemoryProviderSelect(BaseModel):
    # "" or "built-in" disables the external provider (built-in only).
    provider: str


def _resolve_memory_provider_selection(value: Optional[str]) -> str:
    """Validate a desktop memory-provider selection before persisting it.

    A provider that discovery can see but cannot initialize would otherwise be
    saved successfully and then silently disappear when a new agent starts.
    Route every dashboard selection surface through the same readiness and
    name boundary instead.
    """
    provider = (value or "").strip()
    if provider.lower() in {"built-in", "builtin", "none"}:
        return ""
    if not provider:
        return ""

    from plugins.memory import (
        discover_memory_providers,
        is_valid_memory_provider_name,
    )

    if not is_valid_memory_provider_name(provider):
        raise HTTPException(status_code=400, detail="Invalid memory provider name.")

    providers = {
        name: bool(is_available)
        for name, _description, is_available in discover_memory_providers()
    }
    if provider not in providers:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown memory provider '{provider}'. "
                "Choose an installed memory provider first."
            ),
        )
    if not providers[provider]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Memory provider '{provider}' is not ready. "
                "Configure its dependencies before selecting it."
            ),
        )
    return provider


class MemoryReset(BaseModel):
    # "all" | "memory" | "user"
    target: str = "all"


@app.get("/api/memory")
async def get_memory_status():
    from plugins.memory import discover_memory_providers

    cfg = load_config()
    active = ""
    mem = cfg.get("memory")
    if isinstance(mem, dict):
        active = str(mem.get("provider") or "")

    providers = []
    try:
        for name, description, configured in discover_memory_providers():
            providers.append({
                "name": name,
                "description": description,
                "configured": bool(configured),
            })
    except Exception:
        _log.exception("discover_memory_providers failed")

    # Built-in memory file sizes (so the UI can show what a reset would erase).
    mem_dir = get_fan_home() / "memories"
    files = {}
    for fname, key in (("MEMORY.md", "memory"), ("USER.md", "user")):
        path = mem_dir / fname
        files[key] = path.stat().st_size if path.exists() else 0

    return {
        "active": active,
        "providers": providers,
        "builtin_files": files,
    }


@app.put("/api/memory/provider")
async def set_memory_provider(body: MemoryProviderSelect):
    provider = _resolve_memory_provider_selection(body.provider)

    cfg = load_config()
    if not isinstance(cfg.get("memory"), dict):
        cfg["memory"] = {}
    cfg["memory"]["provider"] = provider
    save_config(cfg)
    return {"ok": True, "active": provider}


@app.post("/api/memory/reset")
async def reset_memory(body: MemoryReset):
    target = (body.target or "all").strip().lower()
    if target not in {"all", "memory", "user"}:
        raise HTTPException(status_code=400, detail="target must be all, memory, or user")

    mem_dir = get_fan_home() / "memories"
    deleted = []
    targets = []
    if target in {"all", "memory"}:
        targets.append("MEMORY.md")
    if target in {"all", "user"}:
        targets.append("USER.md")
    for fname in targets:
        path = mem_dir / fname
        if path.exists():
            try:
                path.unlink()
                deleted.append(fname)
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"Could not delete {fname}: {exc}")
    return {"ok": True, "deleted": deleted}


# ---------------------------------------------------------------------------
# Operations endpoints — doctor / security audit /
# checkpoints / hooks.
#
# Diagnostic and maintenance commands. Long-running text-output actions are
# spawned as
# background actions whose logs the dashboard tails via
# /api/actions/{name}/status — same pattern as gateway restart and update.
# The cheap, structured reads (hooks list, checkpoints list) return JSON
# directly.
# ---------------------------------------------------------------------------






@app.get("/api/ops/hooks")
async def list_hooks():
    """List configured shell hooks from config.yaml with consent + health.

    Reports each hook's allowlist (consent) status and whether the script is
    currently executable, plus the set of valid hook events so the create
    form can offer them.
    """
    from fan_cli.config import load_config as _load_config
    from agent import shell_hooks

    try:
        from fan_cli.plugins import VALID_HOOKS
        valid_events = sorted(VALID_HOOKS)
    except Exception:
        valid_events = []

    specs = []
    try:
        specs = shell_hooks.iter_configured_hooks(_load_config())
    except Exception:
        _log.exception("iter_configured_hooks failed")

    out = []
    for spec in specs:
        entry = None
        try:
            entry = shell_hooks.allowlist_entry_for(spec.event, spec.command)
        except Exception:
            pass
        executable = False
        try:
            executable = shell_hooks.script_is_executable(spec.command)
        except Exception:
            pass
        out.append({
            "event": spec.event,
            "matcher": spec.matcher,
            "command": spec.command,
            "timeout": spec.timeout,
            "allowed": entry is not None,
            "approved_at": (entry or {}).get("approved_at"),
            "executable": executable,
        })

    return {"hooks": out, "valid_events": valid_events}


class HookCreate(BaseModel):
    event: str
    command: str
    matcher: Optional[str] = None
    timeout: Optional[int] = None
    # approve: write the consent allowlist entry too (the operator using the
    # authenticated dashboard is giving consent). Without it the hook is
    # configured but won't fire until approved.
    approve: bool = True


@app.post("/api/ops/hooks")
async def create_hook(body: HookCreate):
    """Add a shell hook to config.yaml (and optionally approve it).

    Shell hooks run arbitrary commands, so this is a privileged action: it
    writes to the ``hooks:`` config block and, when ``approve`` is set, records
    consent in the allowlist so the hook actually fires.  Takes effect on the
    next session / gateway restart.
    """
    from agent import shell_hooks

    event = (body.event or "").strip()
    command = (body.command or "").strip()
    if not event or not command:
        raise HTTPException(status_code=400, detail="event and command are required")

    try:
        from fan_cli.plugins import VALID_HOOKS
        if event not in VALID_HOOKS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown event '{event}'. Valid: {', '.join(sorted(VALID_HOOKS))}",
            )
    except HTTPException:
        raise
    except Exception:
        pass

    cfg = load_config()
    hooks_cfg = cfg.get("hooks")
    if not isinstance(hooks_cfg, dict):
        hooks_cfg = {}
        cfg["hooks"] = hooks_cfg
    entries = hooks_cfg.get(event)
    if not isinstance(entries, list):
        entries = []
        hooks_cfg[event] = entries

    new_entry: Dict[str, Any] = {"command": command}
    if body.matcher:
        new_entry["matcher"] = body.matcher
    if body.timeout is not None:
        new_entry["timeout"] = int(body.timeout)
    entries.append(new_entry)
    save_config(cfg)

    approved = False
    if body.approve:
        try:
            shell_hooks._record_approval(event, command)
            approved = True
        except Exception:
            _log.exception("hook consent record failed")

    return {"ok": True, "event": event, "command": command, "approved": approved}


class HookDelete(BaseModel):
    event: str
    command: str


@app.delete("/api/ops/hooks")
async def delete_hook(body: HookDelete):
    """Remove a hook from config.yaml and revoke its consent allowlist entry."""
    from agent import shell_hooks

    event = (body.event or "").strip()
    command = (body.command or "").strip()
    if not event or not command:
        raise HTTPException(status_code=400, detail="event and command are required")

    cfg = load_config()
    hooks_cfg = cfg.get("hooks")
    removed = False
    if isinstance(hooks_cfg, dict) and isinstance(hooks_cfg.get(event), list):
        before = len(hooks_cfg[event])
        hooks_cfg[event] = [
            e for e in hooks_cfg[event]
            if not (isinstance(e, dict) and e.get("command") == command)
        ]
        removed = len(hooks_cfg[event]) < before
        if not hooks_cfg[event]:
            del hooks_cfg[event]
        if not hooks_cfg:
            cfg.pop("hooks", None)
        save_config(cfg)

    # Revoke consent regardless so a re-add re-prompts.
    try:
        shell_hooks.revoke(command)
    except Exception:
        pass

    if not removed:
        raise HTTPException(status_code=404, detail="No matching hook found")
    return {"ok": True}


@app.get("/api/ops/checkpoints")
async def list_checkpoints():
    """List the /rollback shadow store checkpoints (read-only)."""
    # Checkpoints live under <fan_home>/checkpoints/.  Surface a count +
    # total size so the dashboard can show what a prune would reclaim; the
    # actual prune is a spawned action so confirmation/pruning logic stays
    # in one place (the CLI).
    cp_dir = get_fan_home() / "checkpoints"
    sessions = []
    total_bytes = 0
    if cp_dir.is_dir():
        for child in sorted(cp_dir.iterdir()):
            if not child.is_dir():
                continue
            size = 0
            count = 0
            for f in child.rglob("*"):
                if f.is_file():
                    try:
                        size += f.stat().st_size
                        count += 1
                    except OSError:
                        pass
            total_bytes += size
            sessions.append({
                "session": child.name,
                "files": count,
                "bytes": size,
            })
    return {"sessions": sessions, "total_bytes": total_bytes}




# ---------------------------------------------------------------------------
# Local Skills & Tools endpoints
# ---------------------------------------------------------------------------


class SkillToggle(BaseModel):
    name: str
    enabled: bool


@app.get("/api/skills")
async def get_skills():
    from tools.skills_tool import _find_all_skills
    from fan_cli.skills_config import get_disabled_skills
    from tools import skill_usage

    config = load_config()
    disabled = get_disabled_skills(config)
    usage = skill_usage.load_usage()

    def _skill_origin(name: str) -> str:
        record = usage.get(name) or {}
        if record.get("created_by") == "agent" or record.get("agent_created") is True:
            return "agent"
        if skill_usage.is_bundled(name):
            return "bundled"
        return "local"

    skills = _find_all_skills(skip_disabled=True)
    for s in skills:
        name = s["name"]
        record = usage.get(name) or {}
        s["enabled"] = s["name"] not in disabled
        s["origin"] = _skill_origin(name)
        s["created_by"] = record.get("created_by")
        s["created_at"] = record.get("created_at")
    return skills


@app.put("/api/skills/toggle")
async def toggle_skill(body: SkillToggle):
    from fan_cli.skills_config import get_disabled_skills, save_disabled_skills
    config = load_config()
    disabled = get_disabled_skills(config)
    if body.enabled:
        disabled.discard(body.name)
    else:
        disabled.add(body.name)
    save_disabled_skills(config, disabled)
    return {"ok": True, "name": body.name, "enabled": body.enabled}


class SkillCreate(BaseModel):
    name: str
    content: str
    category: Optional[str] = None


class SkillContentUpdate(BaseModel):
    name: str
    content: str


def _clear_skills_prompt_cache() -> None:
    """Best-effort: invalidate the skills system-prompt snapshot after a write.

    Mirrors what ``skill_manage`` does so a locally authored skill is picked
    up by the next session without a manual cache reset.
    """
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        pass


@app.get("/api/skills/content")
async def get_skill_content(name: str):
    """Return the raw SKILL.md text for a skill, for the dashboard editor."""
    from tools.skill_manager_tool import _find_skill

    found = _find_skill(name)
    if not found:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found.")
    skill_md = found["path"] / "SKILL.md"
    if not skill_md.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{name}' has no SKILL.md.")
    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"name": name, "content": content, "path": str(skill_md)}


@app.post("/api/skills")
async def create_skill(body: SkillCreate):
    """Create a new custom skill (SKILL.md) from the dashboard editor.

    Calls the same validated write path as the agent's ``skill_manage`` tool
    (frontmatter validation, name/category validation, size limit, optional
    security scan). A write from the authenticated dashboard IS the user
    acting directly, so it does not pass through the agent write-approval gate
    (single-profile: de-profiled from upstream's _profile_scope wrapper).
    """
    from tools.skill_manager_tool import _create_skill

    result = _create_skill(body.name, body.content, body.category or None)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to create skill."))
    _clear_skills_prompt_cache()
    return result


@app.put("/api/skills/content")
async def update_skill_content(body: SkillContentUpdate):
    """Replace the SKILL.md of an existing skill (full rewrite) from the editor."""
    from tools.skill_manager_tool import _edit_skill

    result = _edit_skill(body.name, body.content)
    if not result.get("success"):
        err = result.get("error", "Failed to update skill.")
        status = 404 if "not found" in str(err).lower() else 400
        raise HTTPException(status_code=status, detail=err)
    _clear_skills_prompt_cache()
    return result


@app.get("/api/tools/toolsets")
async def get_toolsets():
    from fan_cli.tools_config import (
        _get_effective_configurable_toolsets,
        _get_platform_tools,
        _toolset_has_keys,
        gui_toolset_label,
    )
    from toolsets import resolve_toolset

    config = load_config()
    enabled_toolsets = _get_platform_tools(
        config,
        "cli",
        include_default_mcp_servers=False,
    )
    result = []
    for name, label, desc in _get_effective_configurable_toolsets():
        try:
            tools = sorted(set(resolve_toolset(name)))
        except Exception:
            tools = []
        is_enabled = name in enabled_toolsets
        result.append({
            "name": name,
            "label": gui_toolset_label(label),
            "description": desc,
            "enabled": is_enabled,
            "available": is_enabled,
            "configured": _toolset_has_keys(name, config),
            "tools": tools,
        })
    return result


class ToolsetToggle(BaseModel):
    enabled: bool


@app.put("/api/tools/toolsets/{name}")
async def toggle_toolset(name: str, body: ToolsetToggle):
    """Enable/disable a configurable toolset for the desktop (cli) platform.

    Persists to ``platform_toolsets.cli`` via the same ``_save_platform_tools``
    helper the CLI ``fan tools`` picker uses, so the GUI and CLI stay in
    lockstep. Returns 400 for unknown toolset keys.
    """
    from fan_cli.tools_config import (
        _get_effective_configurable_toolsets,
        _get_platform_tools,
        _save_platform_tools,
    )

    valid = {ts_key for ts_key, _, _ in _get_effective_configurable_toolsets()}
    if name not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown toolset: {name}")

    config = load_config()
    enabled = set(
        _get_platform_tools(config, "cli", include_default_mcp_servers=False)
    )
    if body.enabled:
        enabled.add(name)
    else:
        enabled.discard(name)
    _save_platform_tools(config, "cli", enabled)
    return {"ok": True, "name": name, "enabled": body.enabled}


@app.get("/api/tools/toolsets/{name}/config")
async def get_toolset_config(name: str):
    """Return the provider matrix + key status for a toolset's config panel.

    Surfaces the same provider rows the CLI ``fan tools`` picker shows
    (via ``_visible_providers``), each with its ``env_vars`` annotated with
    current ``is_set`` state so the GUI can render provider selection + key
    entry. Toolsets without a ``TOOL_CATEGORIES`` entry return an empty
    provider list and ``has_category: false``. Returns 400 for unknown keys.
    """
    from fan_cli.tools_config import (
        TOOL_CATEGORIES,
        _get_effective_configurable_toolsets,
        _is_provider_active,
        _visible_providers,
    )
    from fan_cli.config import get_env_value

    valid = {ts_key for ts_key, _, _ in _get_effective_configurable_toolsets()}
    if name not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown toolset: {name}")

    config = load_config()
    cat = TOOL_CATEGORIES.get(name)
    providers = []
    active_provider = None
    if cat:
        for prov in _visible_providers(cat, config, force_fresh=True):
            env_vars = [
                {
                    "key": e["key"],
                    "prompt": e.get("prompt", e["key"]),
                    "url": e.get("url"),
                    "default": e.get("default"),
                    "is_set": bool(get_env_value(e["key"])),
                }
                for e in prov.get("env_vars", [])
            ]
            # Surface the same active-provider determination the CLI picker
            # uses (``_is_provider_active``) so the GUI highlights the provider
            # actually written to config, not just the first
            # keyless one in the list.
            is_active = _is_provider_active(prov, config, force_fresh=True)
            if is_active and active_provider is None:
                active_provider = prov["name"]
            providers.append({
                "name": prov["name"],
                "badge": prov.get("badge", ""),
                "tag": prov.get("tag", ""),
                "env_vars": env_vars,
                "post_setup": prov.get("post_setup"),
                "is_active": is_active,
            })
    return {
        "name": name,
        "has_category": cat is not None,
        "providers": providers,
        "active_provider": active_provider,
    }


class ToolsetProviderSelect(BaseModel):
    provider: str


@app.put("/api/tools/toolsets/{name}/provider")
async def select_toolset_provider(name: str, body: ToolsetProviderSelect):
    """Persist a provider selection for a toolset (no key prompting).

    Delegates to ``apply_provider_selection`` — the shared, non-interactive
    core extracted from the CLI configurator — so the GUI and ``fan tools``
    write identical config keys.
    API keys and post-setup flows are handled by separate endpoints. Returns
    400 for unknown toolset or provider names.
    """
    from fan_cli.tools_config import (
        apply_provider_selection,
        _get_effective_configurable_toolsets,
    )

    valid = {ts_key for ts_key, _, _ in _get_effective_configurable_toolsets()}
    if name not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown toolset: {name}")

    config = load_config()
    try:
        apply_provider_selection(name, body.provider, config)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc).strip('"'))
    save_config(config)
    return {"ok": True, "name": name, "provider": body.provider}


# ---------------------------------------------------------------------------
# Raw YAML config endpoint
# ---------------------------------------------------------------------------


class RawConfigUpdate(BaseModel):
    yaml_text: str


@app.get("/api/config/raw")
async def get_config_raw():
    path = get_config_path()
    if not path.exists():
        return {"yaml": ""}
    return {"yaml": path.read_text(encoding="utf-8")}


@app.put("/api/config/raw")
async def update_config_raw(body: RawConfigUpdate):
    try:
        parsed = yaml.safe_load(body.yaml_text)
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=400, detail="YAML must be a mapping")
        save_config(parsed)
        return {"ok": True}
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")


# ---------------------------------------------------------------------------
# Starlette's TestClient reports the peer as "testclient"; treat it as
# loopback so tests don't need to rewrite request scope.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})



def _ws_client_is_allowed(ws: "WebSocket") -> bool:
    """Check if the WebSocket client IP is acceptable.

    The server only binds to loopback, so only loopback peers may upgrade.
    The query token remains mandatory and is checked separately.
    """
    client_host = ws.client.host if ws.client else ""
    if not client_host:
        return False
    return client_host in _LOOPBACK_HOSTS


def _ws_host_origin_reason(ws: "WebSocket") -> Optional[str]:
    """Return a Host/Origin rejection reason, or None when allowed.

    Mirrors :func:`_ws_host_origin_is_allowed` but yields a short
    machine-parseable token (``host_mismatch …`` / ``origin_mismatch …``)
    on rejection so the close path can log *why* the upgrade was refused.
    """
    bound_host = getattr(app.state, "bound_host", None)
    if not bound_host:
        return None

    host_header = ws.headers.get("host", "")
    if not _is_accepted_host(host_header, bound_host):
        return f"host_mismatch host={host_header or '?'} bound={bound_host}"

    origin = ws.headers.get("origin", "")
    if not origin:
        return None

    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme not in {"http", "https"}:
        # Non-web origin (packaged Electron: file://, null, app://). The
        # upstream credential check is the real auth boundary; trust it.
        # See _ws_host_origin_is_allowed for the full rationale.
        return None

    if not parsed.netloc:
        return f"origin_mismatch origin={origin} bound={bound_host}"

    if not _is_accepted_host(parsed.netloc, bound_host):
        return f"origin_mismatch origin={origin} bound={bound_host}"
    return None


def _ws_host_origin_is_allowed(ws: "WebSocket") -> bool:
    """Apply the dashboard Host/Origin guard to WebSocket upgrades.

    FastAPI HTTP middleware does not run for WebSocket routes, so the
    DNS-rebinding Host check used for normal dashboard HTTP requests must be
    repeated here before accepting the upgrade.  Browsers also send an Origin
    header on WebSocket handshakes; when present, require it to target the
    same bound dashboard host.
    """
    return _ws_host_origin_reason(ws) is None



def _ws_request_is_allowed(ws: "WebSocket") -> bool:
    """Return True when the WebSocket upgrade matches dashboard boundaries."""
    return _ws_host_origin_is_allowed(ws) and _ws_client_is_allowed(ws)


def _ws_auth_reason(ws: "WebSocket") -> tuple[Optional[str], str]:
    """Validate WS-upgrade auth; return ``(reason, credential)``.

    ``reason`` is None when the credential is accepted, else a short
    machine-parseable token explaining the rejection (``no_credential``,
    ``token_mismatch``). ``credential`` names which credential type was
    presented (``token`` or ``none``) so the accepted path can log *how* a
    peer authed, not just that it did.

    The dashboard is loopback-only: the ``?token=<_SESSION_TOKEN>`` query
    parameter is constant-time compared against the per-process session
    token. (The remote/OAuth ticket + internal-credential paths were removed
    along with the local API token gate.)
    """
    token = ws.query_params.get("token", "")
    if not token:
        return "no_credential", "none"
    if hmac.compare_digest(token.encode(), _SESSION_TOKEN.encode()):
        return None, "token"
    return "token_mismatch", "token"


def _ws_auth_ok(ws: "WebSocket") -> bool:
    """True when the WS-upgrade credential is accepted. See _ws_auth_reason."""
    return _ws_auth_reason(ws)[0] is None

# ---------------------------------------------------------------------------
# /api/ws -- JSON-RPC WebSocket endpoint for the Electron desktop app.
#
# Drives the `tui_gateway.dispatch` surface over an authenticated WebSocket.
# Electron renders the transcript, slash launcher, tool approvals, collect /
# sudo / secret prompts, browser binding, and session metadata from these
# JSON-RPC responses and events.
# ---------------------------------------------------------------------------


@app.websocket("/api/ws")
async def gateway_ws(ws: WebSocket) -> None:
    if not _ELECTRON_GATEWAY_WS_ENABLED:
        await ws.close(code=4403)
        return

    if not _ws_auth_ok(ws):
        await ws.close(code=4401)
        return

    if not _ws_request_is_allowed(ws):
        await ws.close(code=4403)
        return

    from tui_gateway.ws import handle_ws

    await handle_ws(ws)


def _normalise_prefix(raw: Optional[str]) -> str:
    """Normalise an ``X-Forwarded-Prefix`` header value.

    Used only when the loopback dashboard is served behind a path-prefix
    reverse proxy (rare for the local product). Returns a cleaned prefix
    like ``/fan`` (leading slash, no trailing slash) or ``""`` when the
    header is absent or malformed.

    Rejects anything that isn't a simple absolute path segment: empty/root,
    values with whitespace, control chars, quote/angle characters, ``..``
    traversal, or backslashes. A rejected value yields ``""`` so the SPA is
    served at root rather than breaking on a hostile/garbled header.
    """
    if not raw:
        return ""
    value = raw.strip()
    if not value or value == "/":
        return ""
    if not value.startswith("/"):
        value = "/" + value
    value = value.rstrip("/")
    if not value:
        return ""
    # Reject obviously unsafe / non-path content.
    if any(c.isspace() or ord(c) < 0x20 for c in value):
        return ""
    if any(c in value for c in ('"', "'", "<", ">", "\\", "\x7f")):
        return ""
    if ".." in value.split("/"):
        return ""
    return value


def mount_spa(application: FastAPI):
    """Mount the built SPA. Falls back to index.html for client-side routing.

    The session token is injected into index.html via a ``<script>`` tag so
    the SPA can authenticate against protected API endpoints without a
    separate (unauthenticated) token-dispensing endpoint.

    When served behind a path-prefix reverse proxy (e.g.
    ``mission-control.tilos.com/fan/*`` -> local Caddy -> :9119), the
    proxy injects ``X-Forwarded-Prefix: /fan`` on every request. We
    rewrite the served ``index.html`` so absolute asset URLs (``/assets/...``)
    and the SPA's runtime ``__FAN_BASE_PATH__`` honour that prefix
    without rebuilding the bundle.
    """
    if not WEB_DIST.exists():
        @application.get("/{full_path:path}")
        async def no_frontend(full_path: str):
            return JSONResponse(
                {"error": "Frontend not built. Run: cd web && npm run build"},
                status_code=404,
            )
        return

    _index_path = WEB_DIST / "index.html"

    def _serve_index(prefix: str = ""):
        """Return index.html with the session token + base-path injected.

        ``prefix`` is the normalised ``X-Forwarded-Prefix`` (e.g. ``/fan``)
        or empty string when served at root.

        The dashboard is loopback-only, so the per-process ``_SESSION_TOKEN``
        is always injected and the SPA authenticates every API/WS call with
        it. ``__FAN_AUTH_REQUIRED__`` is kept (always ``false``) so the
        existing bundle's auth-scheme branch stays valid.
        """
        html = _index_path.read_text(encoding="utf-8")
        bootstrap_script = (
            f'<script>window.__FAN_SESSION_TOKEN__="{_SESSION_TOKEN}";'
            f'window.__FAN_BASE_PATH__="{prefix}";'
            f"window.__FAN_AUTH_REQUIRED__=false;"
            f"</script>"
        )
        if prefix:
            # Rewrite absolute asset URLs baked into the Vite build so the
            # browser fetches them through the same proxy prefix.
            html = html.replace('href="/assets/', f'href="{prefix}/assets/')
            html = html.replace('src="/assets/', f'src="{prefix}/assets/')
            html = html.replace('href="/favicon.ico"', f'href="{prefix}/favicon.ico"')
            html = html.replace('href="/fonts/', f'href="{prefix}/fonts/')
            html = html.replace('href="/ds-assets/', f'href="{prefix}/ds-assets/')
            html = html.replace('src="/ds-assets/', f'src="{prefix}/ds-assets/')
        html = html.replace("</head>", f"{bootstrap_script}</head>", 1)
        return HTMLResponse(
            html,
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )

    # When served behind a path-prefix proxy, the built CSS contains
    # absolute ``url(/fonts/...)`` and ``url(/ds-assets/...)`` references.
    # Browsers resolve those against the document origin, which means
    # under ``/fan`` they'd hit ``mission-control.tilos.com/fonts/...``
    # (the MC Pages app), not the Fan backend. Intercept CSS asset
    # requests BEFORE the StaticFiles mount and rewrite the absolute paths
    # when a prefix is in play.
    @application.get("/assets/{filename}.css")
    async def serve_css(filename: str, request: Request):
        css_path = WEB_DIST / "assets" / f"{filename}.css"
        if not css_path.is_file() or not css_path.resolve().is_relative_to(
            WEB_DIST.resolve()
        ):
            return JSONResponse({"error": "not found"}, status_code=404)
        prefix = _normalise_prefix(request.headers.get("x-forwarded-prefix"))
        css = css_path.read_text(encoding="utf-8")
        if prefix:
            for asset_dir in ("/fonts/", "/fonts-terminal/", "/ds-assets/", "/assets/"):
                css = css.replace(f"url({asset_dir}", f"url({prefix}{asset_dir}")
                css = css.replace(f"url(\"{asset_dir}", f"url(\"{prefix}{asset_dir}")
                css = css.replace(f"url('{asset_dir}", f"url('{prefix}{asset_dir}")
        return Response(content=css, media_type="text/css")

    application.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @application.get("/{full_path:path}")
    async def serve_spa(full_path: str, request: Request):
        prefix = _normalise_prefix(request.headers.get("x-forwarded-prefix"))
        # An unmatched /api/* path is a missing/renamed endpoint, NOT a
        # client-side route. Falling through to index.html here returns
        # `<!doctype html>` with status 200, which makes JSON clients (the
        # desktop app's fetchJson, dashboard fetch wrappers) blow up with an
        # opaque `SyntaxError: Unexpected token '<'`. Return a real 404 JSON
        # so the caller sees a clear "no such endpoint" instead.
        if full_path == "api" or full_path.startswith("api/"):
            return JSONResponse(
                {"detail": f"No such API endpoint: /{full_path}"},
                status_code=404,
            )
        file_path = WEB_DIST / full_path
        # Prevent path traversal via url-encoded sequences (%2e%2e/)
        if (
            full_path
            and file_path.resolve().is_relative_to(WEB_DIST.resolve())
            and file_path.exists()
            and file_path.is_file()
        ):
            return FileResponse(file_path)
        return _serve_index(prefix)


# ---------------------------------------------------------------------------
# Dashboard theme endpoints
# ---------------------------------------------------------------------------

# Built-in dashboard themes — label + description only.  The actual color
# definitions live in the frontend (web/src/themes/presets.ts).
_BUILTIN_DASHBOARD_THEMES = [
    {"name": "default",       "label": "Fan Teal",         "description": "Classic dark teal — the canonical Fan look"},
    {"name": "default-large", "label": "Fan Teal (Large)", "description": "Fan Teal with bigger fonts and roomier spacing"},
    {"name": "nous-blue",     "label": "Nous Blue",           "description": "Light mode — vivid Nous-blue accents on cream canvas"},
    {"name": "midnight",      "label": "Midnight",            "description": "Deep blue-violet with cool accents"},
    {"name": "ember",     "label": "Ember",          "description": "Warm crimson and bronze — forge vibes"},
    {"name": "mono",      "label": "Mono",           "description": "Clean grayscale — minimal and focused"},
    {"name": "cyberpunk", "label": "Cyberpunk",      "description": "Neon green on black — matrix terminal"},
    {"name": "rose",      "label": "Rosé",           "description": "Soft pink and warm ivory — easy on the eyes"},
]


def _parse_theme_layer(value: Any, default_hex: str, default_alpha: float = 1.0) -> Optional[Dict[str, Any]]:
    """Normalise a theme layer spec from YAML into `{hex, alpha}` form.

    Accepts shorthand (a bare hex string) or full dict form.  Returns
    ``None`` on garbage input so the caller can fall back to a built-in
    default rather than blowing up.
    """
    if value is None:
        return {"hex": default_hex, "alpha": default_alpha}
    if isinstance(value, str):
        return {"hex": value, "alpha": default_alpha}
    if isinstance(value, dict):
        hex_val = value.get("hex", default_hex)
        alpha_val = value.get("alpha", default_alpha)
        if not isinstance(hex_val, str):
            return None
        try:
            alpha_f = float(alpha_val)
        except (TypeError, ValueError):
            alpha_f = default_alpha
        return {"hex": hex_val, "alpha": max(0.0, min(1.0, alpha_f))}
    return None


_THEME_DEFAULT_TYPOGRAPHY: Dict[str, str] = {
    "fontSans": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    "fontMono": 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
    "baseSize": "15px",
    "lineHeight": "1.55",
    "letterSpacing": "0",
}

_THEME_DEFAULT_LAYOUT: Dict[str, str] = {
    "radius": "0.5rem",
    "density": "comfortable",
}

_THEME_OVERRIDE_KEYS = {
    "card", "cardForeground", "popover", "popoverForeground",
    "primary", "primaryForeground", "secondary", "secondaryForeground",
    "muted", "mutedForeground", "accent", "accentForeground",
    "destructive", "destructiveForeground", "success", "warning",
    "border", "input", "ring",
}

# Well-known named asset slots themes can populate.  Any other keys under
# ``assets.custom`` are exposed as ``--theme-asset-custom-<key>`` CSS vars
# for plugin/shell use.
_THEME_NAMED_ASSET_KEYS = {"bg", "hero", "logo", "crest", "sidebar", "header"}

# Component-style buckets themes can override.  The value under each bucket
# is a mapping from camelCase property name to CSS string; each pair emits
# ``--component-<bucket>-<kebab-property>`` on :root.  The frontend's shell
# components (Card, App header, Backdrop, etc.) consume these vars so themes
# can restyle chrome (clip-path, border-image, segmented progress, etc.)
# without shipping their own CSS.
_THEME_COMPONENT_BUCKETS = {
    "card", "header", "footer", "sidebar", "tab",
    "progress", "badge", "backdrop", "page",
}

_THEME_LAYOUT_VARIANTS = {"standard", "cockpit", "tiled"}

# Cap on customCSS length so a malformed/oversized theme YAML can't blow up
# the response payload or the <style> tag.  32 KiB is plenty for every
# practical reskin (the Strike Freedom demo is ~2 KiB).
_THEME_CUSTOM_CSS_MAX = 32 * 1024


def _normalise_theme_definition(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Normalise a user theme YAML into the wire format `ThemeProvider`
    expects.  Returns ``None`` if the theme is unusable.

    Accepts both the full schema (palette/typography/layout) and a loose
    form with bare hex strings, so hand-written YAMLs stay friendly.
    """
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    # Palette
    palette_src = data.get("palette", {}) if isinstance(data.get("palette"), dict) else {}
    # Allow top-level `colors.background` as a shorthand too.
    colors_src = data.get("colors", {}) if isinstance(data.get("colors"), dict) else {}

    def _layer(key: str, default_hex: str, default_alpha: float = 1.0) -> Dict[str, Any]:
        spec = palette_src.get(key, colors_src.get(key))
        parsed = _parse_theme_layer(spec, default_hex, default_alpha)
        return parsed if parsed is not None else {"hex": default_hex, "alpha": default_alpha}

    palette = {
        "background": _layer("background", "#041c1c", 1.0),
        "midground": _layer("midground", "#ffe6cb", 1.0),
        "foreground": _layer("foreground", "#ffffff", 0.0),
        "warmGlow": palette_src.get("warmGlow") or data.get("warmGlow") or "rgba(255, 189, 56, 0.35)",
        "noiseOpacity": 1.0,
    }
    raw_noise = palette_src.get("noiseOpacity", data.get("noiseOpacity"))
    try:
        palette["noiseOpacity"] = float(raw_noise) if raw_noise is not None else 1.0
    except (TypeError, ValueError):
        palette["noiseOpacity"] = 1.0

    # Typography
    typo_src = data.get("typography", {}) if isinstance(data.get("typography"), dict) else {}
    typography = dict(_THEME_DEFAULT_TYPOGRAPHY)
    for key in ("fontSans", "fontMono", "fontDisplay", "fontUrl", "baseSize", "lineHeight", "letterSpacing"):
        val = typo_src.get(key)
        if isinstance(val, str) and val.strip():
            typography[key] = val

    # Layout
    layout_src = data.get("layout", {}) if isinstance(data.get("layout"), dict) else {}
    layout = dict(_THEME_DEFAULT_LAYOUT)
    radius = layout_src.get("radius")
    if isinstance(radius, str) and radius.strip():
        layout["radius"] = radius
    density = layout_src.get("density")
    if isinstance(density, str) and density in {"compact", "comfortable", "spacious"}:
        layout["density"] = density

    # Color overrides — keep only valid keys with string values.
    overrides_src = data.get("colorOverrides", {})
    color_overrides: Dict[str, str] = {}
    if isinstance(overrides_src, dict):
        for key, val in overrides_src.items():
            if key in _THEME_OVERRIDE_KEYS and isinstance(val, str) and val.strip():
                color_overrides[key] = val

    # Assets — named slots + arbitrary user-defined keys.  Values must be
    # strings (URLs or CSS ``url(...)``/``linear-gradient(...)`` expressions).
    # We don't fetch remote assets here; the frontend just injects them as
    # CSS vars.  Empty values are dropped so a theme can explicitly clear a
    # slot by setting ``hero: ""``.
    assets_out: Dict[str, Any] = {}
    assets_src = data.get("assets", {}) if isinstance(data.get("assets"), dict) else {}
    for key in _THEME_NAMED_ASSET_KEYS:
        val = assets_src.get(key)
        if isinstance(val, str) and val.strip():
            assets_out[key] = val
    custom_assets_src = assets_src.get("custom")
    if isinstance(custom_assets_src, dict):
        custom_assets: Dict[str, str] = {}
        for key, val in custom_assets_src.items():
            if (
                isinstance(key, str)
                and key.replace("-", "").replace("_", "").isalnum()
                and isinstance(val, str)
                and val.strip()
            ):
                custom_assets[key] = val
        if custom_assets:
            assets_out["custom"] = custom_assets

    # Custom CSS — raw CSS text the frontend injects as a scoped <style>
    # tag on theme apply.  Clipped to _THEME_CUSTOM_CSS_MAX to keep the
    # payload bounded.  We intentionally do NOT parse/sanitise the CSS
    # here — the dashboard is localhost-only and themes are user-authored
    # YAML in ~/.fan/, same trust level as the config file itself.
    custom_css_val = data.get("customCSS")
    custom_css: Optional[str] = None
    if isinstance(custom_css_val, str) and custom_css_val.strip():
        custom_css = custom_css_val[:_THEME_CUSTOM_CSS_MAX]

    # Component style overrides — per-bucket dicts of camelCase CSS
    # property -> CSS string.  The frontend converts these into CSS vars
    # that shell components (Card, App header, Backdrop) consume.
    component_styles_src = data.get("componentStyles", {})
    component_styles: Dict[str, Dict[str, str]] = {}
    if isinstance(component_styles_src, dict):
        for bucket, props in component_styles_src.items():
            if bucket not in _THEME_COMPONENT_BUCKETS or not isinstance(props, dict):
                continue
            clean: Dict[str, str] = {}
            for prop, value in props.items():
                if (
                    isinstance(prop, str)
                    and prop.replace("-", "").replace("_", "").isalnum()
                    and isinstance(value, (str, int, float))
                    and str(value).strip()
                ):
                    clean[prop] = str(value)
            if clean:
                component_styles[bucket] = clean

    layout_variant_src = data.get("layoutVariant")
    layout_variant = (
        layout_variant_src
        if isinstance(layout_variant_src, str) and layout_variant_src in _THEME_LAYOUT_VARIANTS
        else "standard"
    )

    result: Dict[str, Any] = {
        "name": name,
        "label": data.get("label") or name,
        "description": data.get("description", ""),
        "palette": palette,
        "typography": typography,
        "layout": layout,
        "layoutVariant": layout_variant,
    }
    if color_overrides:
        result["colorOverrides"] = color_overrides
    if assets_out:
        result["assets"] = assets_out
    if custom_css is not None:
        result["customCSS"] = custom_css
    if component_styles:
        result["componentStyles"] = component_styles
    return result


def _discover_user_themes() -> list:
    """Scan ~/.fan/dashboard-themes/*.yaml for user-created themes.

    Returns a list of fully-normalised theme definitions ready to ship
    to the frontend, so the client can apply them without a secondary
    round-trip or a built-in stub.
    """
    themes_dir = get_fan_home() / "dashboard-themes"
    if not themes_dir.is_dir():
        return []
    result = []
    for f in sorted(themes_dir.glob("*.yaml")):
        try:
            data = yaml.safe_load(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        normalised = _normalise_theme_definition(data)
        if normalised is not None:
            result.append(normalised)
    return result


@app.get("/api/dashboard/themes")
async def get_dashboard_themes():
    """Return available themes and the currently active one.

    Built-in entries ship name/label/description only (the frontend owns
    their full definitions in `web/src/themes/presets.ts`).  User themes
    from `~/.fan/dashboard-themes/*.yaml` ship with their full
    normalised definition under `definition`, so the client can apply
    them without a stub.
    """
    config = load_config()
    active = cfg_get(config, "dashboard", "theme", default="default")
    user_themes = _discover_user_themes()
    seen = set()
    themes = []
    for t in _BUILTIN_DASHBOARD_THEMES:
        seen.add(t["name"])
        themes.append(t)
    for t in user_themes:
        if t["name"] in seen:
            continue
        themes.append({
            "name": t["name"],
            "label": t["label"],
            "description": t["description"],
            "definition": t,
        })
        seen.add(t["name"])
    return {"themes": themes, "active": active}


class ThemeSetBody(BaseModel):
    name: str


@app.put("/api/dashboard/theme")
async def set_dashboard_theme(body: ThemeSetBody):
    """Set the active dashboard theme (persists to config.yaml)."""
    config = load_config()
    if "dashboard" not in config:
        config["dashboard"] = {}
    config["dashboard"]["theme"] = body.name
    save_config(config)
    return {"ok": True, "theme": body.name}


# Curated font-override ids. Kept in sync with FONT_CHOICES in
# web/src/themes/fonts.ts — the frontend owns the stacks + webfont URLs;
# the backend only needs the id allow-list so it can reject anything not
# in the vetted catalog (the font's webfont URL is injected as a <link>,
# so we never accept an arbitrary user-supplied id/URL here).
# NOTE: the matching frontend font catalog/picker lives in the desktop UI
# (not ported here) — this backend persists the choice and is dormant until
# a renderer surfaces the picker.
_FONT_DEFAULT_ID = "theme"
_FONT_CHOICES = frozenset({
    "system-sans", "system-serif", "system-mono",
    "inter", "ibm-plex-sans", "work-sans", "atkinson-hyperlegible", "dm-sans",
    "spectral", "fraunces", "source-serif",
    "jetbrains-mono", "ibm-plex-mono", "space-mono",
})


@app.get("/api/dashboard/font")
async def get_dashboard_font():
    """Return the active font override (``"theme"`` = use the theme's font)."""
    config = load_config()
    font = cfg_get(config, "dashboard", "font", default=_FONT_DEFAULT_ID)
    if font not in _FONT_CHOICES:
        font = _FONT_DEFAULT_ID
    return {"font": font}


class FontSetBody(BaseModel):
    font: str


@app.put("/api/dashboard/font")
async def set_dashboard_font(body: FontSetBody):
    """Set the dashboard font override (persists to config.yaml).

    Accepts any id in the curated catalog, or ``"theme"`` to clear the
    override and fall back to the active theme's own font. Unknown ids are
    coerced to ``"theme"`` rather than 400'd so a stale client can't wedge
    the picker.
    """
    font = body.font if body.font in _FONT_CHOICES else _FONT_DEFAULT_ID
    config = load_config()
    if "dashboard" not in config:
        config["dashboard"] = {}
    config["dashboard"]["font"] = font
    save_config(config)
    return {"ok": True, "font": font}


# ---------------------------------------------------------------------------
# Dashboard plugin system
# ---------------------------------------------------------------------------

def _safe_plugin_api_relpath(api_field: Any, *, dashboard_dir: Path) -> Optional[str]:
    """Validate the manifest's ``api`` field for the plugin loader.

    The web server later imports this file as a Python module via
    ``importlib.util.spec_from_file_location`` (arbitrary code
    execution by design — that's how plugins extend the backend).
    Pre-#29156 the field was used as-is, which meant:

    * An absolute path swallowed the plugin's dashboard directory
      entirely — ``Path('safe/dashboard') / '/tmp/evil.py'`` resolves
      to ``/tmp/evil.py``, so any attacker-controlled manifest could
      point the import at any Python file on disk (GHSA-5qr3-c538-wm9j).
    * A ``../..`` traversal could climb out of the plugin into
      neighbouring directories on the search path.

    Return the original string when the resolved path stays under
    ``dashboard_dir``; return ``None`` (with a warning logged at the
    call site) otherwise so the plugin still loads its static JS/CSS
    but its backend ``api`` is rejected.
    """
    if not isinstance(api_field, str) or not api_field.strip():
        return None
    candidate = Path(api_field)
    if candidate.is_absolute():
        return None
    try:
        resolved = (dashboard_dir / candidate).resolve()
        base = dashboard_dir.resolve()
    except (OSError, RuntimeError):
        return None
    try:
        resolved.relative_to(base)
    except ValueError:
        return None
    return api_field


def _discover_dashboard_plugins() -> list:
    """Scan plugins/*/dashboard/manifest.json for dashboard extensions.

    Checks three plugin sources (same as fan_cli.plugins):
    1. User plugins:    ~/.fan/plugins/<name>/dashboard/manifest.json
    2. Bundled plugins: <repo>/plugins/<name>/dashboard/manifest.json  (memory/, etc.)
    3. Project plugins: ./.fan/plugins/  (only if FAN_ENABLE_PROJECT_PLUGINS)
    """
    plugins = []
    seen_names: set = set()

    from fan_cli.plugins import get_bundled_plugins_dir
    bundled_root = get_bundled_plugins_dir()
    search_dirs = [
        (get_fan_home() / "plugins", "user"),
        (bundled_root / "memory", "bundled"),
        (bundled_root, "bundled"),
    ]
    # GHSA-5qr3-c538-wm9j (#29156): the previous ``os.environ.get(...)``
    # check treated *any* non-empty string as truthy, so ``=0``, ``=false``,
    # and ``=no`` — all of which the agent loader and operators correctly
    # read as "disabled" — silently *enabled* the untrusted project source
    # in the web server.  Combined with the absolute-path RCE primitive on
    # the manifest's ``api`` field (now patched below), this turned the
    # opt-in into a sticky always-on switch.  Use the shared truthy
    # semantics (``1`` / ``true`` / ``yes`` / ``on``) so the gate matches
    # ``fan_cli/plugins.py`` and the documented user contract.
    if env_var_enabled("FAN_ENABLE_PROJECT_PLUGINS"):
        search_dirs.append((Path.cwd() / ".fan" / "plugins", "project"))

    for plugins_root, source in search_dirs:
        if not plugins_root.is_dir():
            continue
        for child in sorted(plugins_root.iterdir()):
            if not child.is_dir():
                continue
            manifest_file = child / "dashboard" / "manifest.json"
            if not manifest_file.exists():
                continue
            try:
                data = json.loads(manifest_file.read_text(encoding="utf-8"))
                name = data.get("name", child.name)
                if name in seen_names:
                    continue
                seen_names.add(name)
                # Tab options: ``path`` + ``position`` for a new tab, optional
                # ``override`` to replace a built-in route, and ``hidden`` to
                # register the plugin component/slots without adding a tab
                # (useful for slot-only plugins like a header-crest injector).
                raw_tab = data.get("tab", {}) if isinstance(data.get("tab"), dict) else {}
                tab_info = {
                    "path": raw_tab.get("path", f"/{name}"),
                    "position": raw_tab.get("position", "end"),
                }
                override_path = raw_tab.get("override")
                if isinstance(override_path, str) and override_path.startswith("/"):
                    tab_info["override"] = override_path
                if bool(raw_tab.get("hidden")):
                    tab_info["hidden"] = True
                # Slots: list of named slot locations this plugin populates.
                # The frontend exposes ``registerSlot(pluginName, slotName, Component)``
                # on window; plugins with non-empty slots call it from their JS bundle.
                slots_src = data.get("slots")
                slots: List[str] = []
                if isinstance(slots_src, list):
                    slots = [s for s in slots_src if isinstance(s, str) and s]
                # Validate ``api`` at discovery time so the value cached
                # on the plugin entry is already safe to feed into the
                # importer.  An attacker-controlled manifest can name
                # any absolute path or ``..`` traversal here — the
                # web server then imports that file as a Python module
                # (RCE, GHSA-5qr3-c538-wm9j).
                raw_api = data.get("api")
                dashboard_dir = child / "dashboard"
                safe_api = _safe_plugin_api_relpath(raw_api, dashboard_dir=dashboard_dir)
                if raw_api and safe_api is None:
                    _log.warning(
                        "Plugin %s: refusing unsafe api path %r (must be a "
                        "relative file inside the plugin's dashboard/ "
                        "directory); backend routes from this plugin will "
                        "not be mounted",
                        name, raw_api,
                    )
                plugins.append({
                    "name": name,
                    "label": data.get("label", name),
                    "description": data.get("description", ""),
                    "icon": data.get("icon", "Puzzle"),
                    "version": data.get("version", "0.0.0"),
                    "tab": tab_info,
                    "slots": slots,
                    "entry": data.get("entry", "dist/index.js"),
                    "css": data.get("css"),
                    "has_api": bool(safe_api),
                    "source": source,
                    "_dir": str(dashboard_dir),
                    "_api_file": safe_api,
                })
            except Exception as exc:
                _log.warning("Bad dashboard plugin manifest %s: %s", manifest_file, exc)
                continue
    return plugins


# Cache discovered plugins per-process (refresh on explicit re-scan).
_dashboard_plugins_cache: Optional[list] = None


def _get_dashboard_plugins(force_rescan: bool = False) -> list:
    global _dashboard_plugins_cache
    if _dashboard_plugins_cache is None or force_rescan:
        _dashboard_plugins_cache = _discover_dashboard_plugins()
    elif _dashboard_plugins_cache:
        if any(not Path(p["_dir"]).is_dir() for p in _dashboard_plugins_cache):
            _dashboard_plugins_cache = _discover_dashboard_plugins()
    return _dashboard_plugins_cache


def _dashboard_plugin_is_enabled(plugin: dict) -> bool:
    """Apply the explicit plugin enable/disable policy to dashboard code."""
    try:
        config = load_config()
        plugins_cfg = config.get("plugins") or {}
        if not isinstance(plugins_cfg, dict):
            plugins_cfg = {}
        enabled = set(plugins_cfg.get("enabled") or [])
        disabled = set(plugins_cfg.get("disabled") or [])
    except Exception:
        # Fail closed for user code; bundled UI remains available unless an
        # explicit readable deny-list says otherwise.
        return plugin.get("source") == "bundled"

    name = str(plugin.get("name") or "")
    if not name or name in disabled:
        return False
    if plugin.get("source") == "user":
        return name in enabled
    return True


@app.get("/api/dashboard/plugins")
async def get_dashboard_plugins():
    """Return discovered dashboard plugins (excludes user-hidden ones)."""
    plugins = _get_dashboard_plugins()
    # Read user's hidden plugins list from config.
    config = load_config()
    hidden: list = cfg_get(config, "dashboard", "hidden_plugins", default=[]) or []
    # Strip internal fields before sending to frontend and filter out hidden.
    return [
        {k: v for k, v in p.items() if not k.startswith("_")}
        for p in plugins
        if p["name"] not in hidden and _dashboard_plugin_is_enabled(p)
    ]


@app.get("/api/dashboard/plugins/rescan")
async def rescan_dashboard_plugins():
    """Force re-scan of dashboard plugins."""
    plugins = _get_dashboard_plugins(force_rescan=True)
    return {"ok": True, "count": len(plugins)}


class _AgentPluginInstallBody(BaseModel):
    identifier: str
    force: bool = False
    enable: bool = True


def _strip_dashboard_manifest(p: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def _merged_plugins_hub() -> Dict[str, Any]:
    """Agent discovery + dashboard manifests + optional provider picker metadata."""
    from fan_cli.plugins_cmd import (
        _discover_all_plugins,
        _get_current_context_engine,
        _get_current_memory_provider,
        _discover_context_engines,
        _discover_memory_providers,
        _get_disabled_set,
        _get_enabled_set,
        _read_manifest as _read_plugin_manifest_at,
    )

    dashboard_list = _get_dashboard_plugins()
    dash_by_name = {str(p["name"]): p for p in dashboard_list}

    disabled_set = _get_disabled_set()
    enabled_set = _get_enabled_set()

    # Read user-hidden plugins from config for the user_hidden field.
    config = load_config()
    hidden_plugins: list = cfg_get(config, "dashboard", "hidden_plugins", default=[]) or []

    plugins_root_resolved = (get_fan_home() / "plugins").resolve()
    rows: List[Dict[str, Any]] = []

    for name, version, description, source, dir_str in _discover_all_plugins():
        if name in disabled_set:
            runtime_status = "disabled"
        elif name in enabled_set:
            runtime_status = "enabled"
        else:
            runtime_status = "inactive"

        dir_path = Path(dir_str)
        dm = dash_by_name.get(name)
        has_dash_manifest = dm is not None or (dir_path / "dashboard" / "manifest.json").exists()

        under_user_tree = False
        try:
            dir_path.resolve().relative_to(plugins_root_resolved)
            under_user_tree = True
        except ValueError:
            pass

        can_remove_update = (
            source in {"user", "git"} and under_user_tree and Path(dir_str).is_dir()
        )

        # Check if this plugin provides tools that need separate credentials.
        auth_required = False
        auth_command = ""
        manifest_data = _read_plugin_manifest_at(dir_path)
        provides_tools = manifest_data.get("provides_tools") or []
        if provides_tools:
            try:
                from tools.registry import registry
                for tname in provides_tools:
                    entry = registry.get_entry(tname)
                    if entry and entry.check_fn and not entry.check_fn():
                        auth_required = True
                        auth_command = "Configure the plugin credential"
                        break
            except Exception:
                pass

        rows.append({
            "name": name,
            "version": version or "",
            "description": description or "",
            "source": source,
            "runtime_status": runtime_status,
            "has_dashboard_manifest": has_dash_manifest,
            "dashboard_manifest": _strip_dashboard_manifest(dm) if dm else None,
            "path": dir_str,
            "can_remove": can_remove_update,
            "can_update_git": can_remove_update and (Path(dir_str) / ".git").exists(),
            "auth_required": auth_required,
            "auth_command": auth_command,
            "user_hidden": name in hidden_plugins,
        })

    agent_names = {r["name"] for r in rows}
    orphan_dashboard = [
        _strip_dashboard_manifest(p)
        for p in dashboard_list
        if str(p["name"]) not in agent_names
    ]

    memory_providers: List[Dict[str, str]] = []
    try:
        for n, desc in _discover_memory_providers():
            memory_providers.append({"name": n, "description": desc})
    except Exception:
        memory_providers = []

    context_engines: List[Dict[str, str]] = []
    try:
        for n, desc in _discover_context_engines():
            context_engines.append({"name": n, "description": desc})
    except Exception:
        context_engines = []

    return {
        "plugins": rows,
        "orphan_dashboard_plugins": orphan_dashboard,
        "providers": {
            "memory_provider": _get_current_memory_provider() or "",
            "memory_options": memory_providers,
            "context_engine": _get_current_context_engine(),
            "context_options": context_engines,
        },
    }


@app.get("/api/dashboard/plugins/hub")
async def get_plugins_hub(request: Request):
    """Unified agent plugins + dashboard extension metadata (session protected)."""
    _require_token(request)
    try:
        return _merged_plugins_hub()
    except Exception as exc:
        _log.warning("plugins/hub failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to build plugins hub.") from exc


@app.post("/api/dashboard/agent-plugins/install")
async def post_agent_plugin_install(request: Request, body: _AgentPluginInstallBody):
    _require_token(request)
    from fan_cli.plugins_cmd import dashboard_install_plugin

    result = dashboard_install_plugin(
        body.identifier.strip(),
        force=body.force,
        enable=body.enable,
    )
    if not result.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=result.get("error") or "Install failed.",
        )
    _get_dashboard_plugins(force_rescan=True)
    # Strip internal paths from the response
    result.pop("after_install_path", None)
    return result


def _validate_plugin_name(name: str) -> str:
    """Reject path-traversal attempts in plugin name URL parameters."""
    name = name.strip("/")
    if not name or ".." in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid plugin name.")
    return name


@app.post("/api/dashboard/agent-plugins/{name:path}/enable")
async def post_agent_plugin_enable(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from fan_cli.plugins_cmd import dashboard_set_agent_plugin_enabled

    result = dashboard_set_agent_plugin_enabled(name, enabled=True)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Enable failed.")
    return result


@app.post("/api/dashboard/agent-plugins/{name:path}/disable")
async def post_agent_plugin_disable(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from fan_cli.plugins_cmd import dashboard_set_agent_plugin_enabled

    result = dashboard_set_agent_plugin_enabled(name, enabled=False)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Disable failed.")
    return result


@app.post("/api/dashboard/agent-plugins/{name:path}/update")
async def post_agent_plugin_update(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from fan_cli.plugins_cmd import dashboard_update_user_plugin

    result = dashboard_update_user_plugin(name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Update failed.")
    _get_dashboard_plugins(force_rescan=True)
    return result


@app.delete("/api/dashboard/agent-plugins/{name:path}")
async def delete_agent_plugin(request: Request, name: str):
    _require_token(request)
    name = _validate_plugin_name(name)
    from fan_cli.plugins_cmd import dashboard_remove_user_plugin

    result = dashboard_remove_user_plugin(name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Remove failed.")
    _get_dashboard_plugins(force_rescan=True)
    return result


class _PluginProvidersPutBody(BaseModel):
    memory_provider: Optional[str] = None
    context_engine: Optional[str] = None


@app.put("/api/dashboard/plugin-providers")
async def put_plugin_providers(request: Request, body: _PluginProvidersPutBody):
    """Persist memory provider / context engine selection (writes config.yaml)."""
    _require_token(request)
    from fan_cli.plugins_cmd import (
        _save_context_engine,
        _save_memory_provider,
    )

    if body.memory_provider is not None:
        _save_memory_provider(_resolve_memory_provider_selection(body.memory_provider))
    if body.context_engine is not None:
        _save_context_engine(body.context_engine)
    return {"ok": True}


class _PluginVisibilityBody(BaseModel):
    hidden: bool


@app.post("/api/dashboard/plugins/{name:path}/visibility")
async def post_plugin_visibility(request: Request, name: str, body: _PluginVisibilityBody):
    """Toggle a plugin's sidebar visibility (persists to config.yaml dashboard.hidden_plugins)."""
    _require_token(request)
    name = _validate_plugin_name(name)

    config = load_config()
    if "dashboard" not in config or not isinstance(config.get("dashboard"), dict):
        config["dashboard"] = {}
    hidden_list: list = config["dashboard"].get("hidden_plugins") or []
    if not isinstance(hidden_list, list):
        hidden_list = []

    if body.hidden and name not in hidden_list:
        hidden_list.append(name)
    elif not body.hidden and name in hidden_list:
        hidden_list.remove(name)

    config["dashboard"]["hidden_plugins"] = hidden_list
    save_config(config)
    return {"ok": True, "name": name, "hidden": body.hidden}


@app.get("/dashboard-plugins/{plugin_name}/{file_path:path}")
async def serve_plugin_asset(plugin_name: str, file_path: str):
    """Serve static assets from a dashboard plugin directory.

    Only serves files from the plugin's ``dashboard/`` subdirectory.
    Path traversal is blocked by checking ``resolve().is_relative_to()``.

    Restricted to a browser-fetchable suffix allowlist (JS/CSS/JSON/HTML/
    SVG/PNG/JPG/WOFF). The dashboard loads plugin JS via ``<script src>``
    and CSS via ``<link href>``, neither of which can attach a custom
    auth header — so this route stays unauthenticated to keep the SPA
    working. But user-installed plugins ship a ``plugin_api.py``
    backend module that the browser never fetches; it's only imported
    by :func:`_mount_plugin_api_routes` at startup. Without a suffix
    allowlist, anyone on the loopback port can curl the ``.py`` source
    of a private third-party plugin. Reject everything outside the
    browser-asset set.
    """
    plugins = _get_dashboard_plugins()
    plugin = next(
        (
            p for p in plugins
            if p["name"] == plugin_name and _dashboard_plugin_is_enabled(p)
        ),
        None,
    )
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")

    base = Path(plugin["_dir"])
    target = (base / file_path).resolve()

    if not target.is_relative_to(base.resolve()):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # Browser-asset suffix allowlist. Everything outside this set is
    # rejected with 404 so we don't leak ``.py`` backend sources, README
    # files, ``.env.example`` templates, etc. — none of which the SPA
    # actually fetches. Add to this set deliberately when a new asset
    # type comes up; do NOT change the default fallback.
    suffix = target.suffix.lower()
    content_types = {
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".html": "text/html",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
        ".map": "application/json",
    }
    if suffix not in content_types:
        raise HTTPException(
            status_code=404,
            detail="File not found",
        )
    media_type = content_types[suffix]
    return FileResponse(
        target,
        media_type=media_type,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


def _mount_plugin_api_routes():
    """Import and mount backend API routes from plugins that declare them.

    Each plugin's ``api`` field points to a Python file that must expose
    a ``router`` (FastAPI APIRouter).  Routes are mounted under
    ``/api/plugins/<name>/``.

    Backend import is restricted to ``bundled`` and ``user`` sources.
    Project plugins (``./.fan/plugins/``) ship with the CWD and are
    therefore attacker-controlled in any threat model where the user
    opens a malicious repo; they can extend the dashboard UI via
    static JS/CSS but their Python ``api`` file is never auto-imported
    by the web server.  See GHSA-5qr3-c538-wm9j (#29156).
    """
    for plugin in _get_dashboard_plugins():
        if not _dashboard_plugin_is_enabled(plugin):
            continue
        api_file_name = plugin.get("_api_file")
        if not api_file_name:
            continue
        if plugin.get("source") == "project":
            _log.warning(
                "Plugin %s: ignoring backend api=%s (project plugins may "
                "not auto-import Python code; move the plugin to "
                "~/.fan/plugins/ if you trust it)",
                plugin["name"], api_file_name,
            )
            continue
        dashboard_dir = Path(plugin["_dir"])
        api_path = dashboard_dir / api_file_name
        try:
            resolved_api = api_path.resolve()
            resolved_base = dashboard_dir.resolve()
            resolved_api.relative_to(resolved_base)
        except (OSError, RuntimeError, ValueError):
            # Discovery already filters this, but re-check here in case
            # ``_dir`` was tampered with after caching or a future caller
            # bypasses the validator.  Defence in depth keeps the import
            # primitive contained even if the upstream check regresses.
            _log.warning(
                "Plugin %s: refusing to import api file outside its "
                "dashboard directory (%s)", plugin["name"], api_path,
            )
            continue
        if not api_path.exists():
            _log.warning("Plugin %s declares api=%s but file not found", plugin["name"], api_file_name)
            continue
        try:
            module_name = f"fan_dashboard_plugin_{plugin['name']}"
            spec = importlib.util.spec_from_file_location(module_name, api_path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            # Register in sys.modules BEFORE exec_module so pydantic/FastAPI
            # can resolve forward references (e.g. models defined in a file
            # that uses `from __future__ import annotations`). Without this,
            # TypeAdapter lazy-build fails at first request with
            # "is not fully defined" because the module namespace isn't
            # reachable by name for string-annotation resolution.
            sys.modules[module_name] = mod
            try:
                spec.loader.exec_module(mod)
            except Exception:
                sys.modules.pop(module_name, None)
                raise
            router = getattr(mod, "router", None)
            if router is None:
                _log.warning("Plugin %s api file has no 'router' attribute", plugin["name"])
                continue
            app.include_router(router, prefix=f"/api/plugins/{plugin['name']}")
            _log.info("Mounted plugin API routes: /api/plugins/%s/", plugin["name"])
        except Exception as exc:
            _log.warning("Failed to load plugin %s API routes: %s", plugin["name"], exc)


# Mount plugin API routes before the SPA catch-all.
_mount_plugin_api_routes()

mount_spa(app)


def start_server(
    host: str = "127.0.0.1",
    port: int = 9119,
    open_browser: bool = True,
):
    """Start the web UI server."""
    import uvicorn

    normalized_host = str(host or "").strip().lower().strip("[]")
    if normalized_host not in _LOOPBACK_HOST_VALUES:
        raise RuntimeError(
            "Fan dashboard is loopback-only and refuses a non-local bind: "
            f"{host!r}."
        )

    # Record the bound host so host_header_middleware can validate incoming
    # Host headers against it. Defends against DNS rebinding (GHSA-ppp5-vxwm-4cf7).
    # bound_port is stashed so WebSocket auth and origin checks can validate
    # the Electron `/api/ws` gateway endpoint consistently.
    app.state.bound_host = host
    app.state.bound_port = port

    # In-process cron ticker — the dashboard is the product's long-lived
    # process, so due cron jobs fire here automatically. tick() holds a
    # cross-process file lock, so a second instance or a manual
    # `fan cron tick` overlapping is harmless.
    try:
        from cron.scheduler import start_background_ticker

        start_background_ticker()
    except Exception as exc:
        _log.warning("cron ticker failed to start — jobs need manual `fan cron tick`: %s", exc)

    # Fan retains Kanban/Agent-cluster workflows, so the desktop backend owns
    # the long-lived dispatcher. A machine-level advisory lock prevents this
    # process and the standalone compatibility daemon from dispatching the
    # same board concurrently.
    try:
        from fan_cli.kanban_dispatcher import start_embedded_dispatcher

        start_embedded_dispatcher()
    except Exception as exc:
        _log.error("kanban dispatcher failed to start: %s", exc)

    if open_browser:
        import webbrowser

        # On headless Linux (no DISPLAY or WAYLAND_DISPLAY) some registered
        # browsers are TUI programs (links, lynx, www-browser) that try to
        # take over the terminal.  That can send SIGHUP to the server process
        # and cause an immediate exit even though uvicorn bound successfully.
        # Skip the auto-open attempt on headless systems and let the user
        # open the URL manually.  macOS and Windows are always considered
        # display-capable.
        _has_display = (
            sys.platform != "linux"
            or bool(os.environ.get("DISPLAY"))
            or bool(os.environ.get("WAYLAND_DISPLAY"))
        )

        if _has_display:
            def _open():
                try:
                    time.sleep(1.0)
                    webbrowser.open(f"http://{host}:{port}")
                except Exception:
                    pass

            threading.Thread(target=_open, daemon=True).start()
        else:
            _log.debug(
                "Skipping browser-open: no DISPLAY or WAYLAND_DISPLAY detected "
                "(headless Linux). Pass --no-open to suppress this detection."
            )

    print(f"  Fan Web UI → http://{host}:{port}")
    # proxy_headers stays False so _ws_client_is_allowed sees the real
    # connection peer rather than X-Forwarded-For's rewritten value (which
    # would defeat the loopback gate behind a reverse proxy).
    try:
        uvicorn.run(
            app, host=host, port=port, log_level="warning",
            proxy_headers=False,
            # A loopback desktop socket has no tunnel idle deadline and must
            # survive temporarily GIL-starved agent/delegation turns.
            ws_ping_interval=30.0 if normalized_host in _LOOPBACK_HOST_VALUES else 20.0,
            ws_ping_timeout=60.0 if normalized_host in _LOOPBACK_HOST_VALUES else 20.0,
        )
    finally:
        try:
            from fan_cli.kanban_dispatcher import stop_embedded_dispatcher

            stop_embedded_dispatcher()
        except Exception:
            _log.debug("kanban dispatcher shutdown failed", exc_info=True)
