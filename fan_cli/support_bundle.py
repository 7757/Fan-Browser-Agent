"""Privacy-bounded diagnostic bundles for local user export.

This module only creates a local, redacted ZIP after the user has selected the
diagnostic contents.  It never uploads a bundle and deliberately excludes
configuration, credentials, sessions, prompts, tool arguments and conversation
databases. Upload and delivery are deliberately outside this module's scope.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import stat
import time
import uuid
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Optional

from fan_constants import get_fan_home

SCHEMA_VERSION = 1
DEFAULT_PER_LOG_BYTES = 256 * 1024
DEFAULT_TOTAL_LOG_BYTES = 2 * 1024 * 1024
DEFAULT_LOG_NAMES = (
    "errors.log",
    "desktop.log",
    "gateway_crash.log",
)
ALLOWED_LOG_NAMES = DEFAULT_LOG_NAMES + ("gateway.log", "gui.log", "agent.log")

_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9._%+-])"
)
_MAC_HOME_RE = re.compile(r"/Users/[^/\s]+/")
_LINUX_HOME_RE = re.compile(r"/home/[^/\s]+/")
_WINDOWS_HOME_RE = re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+\\", re.IGNORECASE)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_AUTH_HEADER_RE = re.compile(r"\bAuthorization\s*:[^\r\n]*", re.IGNORECASE)
_COOKIE_HEADER_RE = re.compile(r"\b(?:Set-)?Cookie\s*:[^\r\n]*", re.IGNORECASE)
_GITHUB_TOKEN_RE = re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", re.IGNORECASE)
_AWS_ACCESS_KEY_RE = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b")
_KEY_VALUE_RE = re.compile(
    r"\b(api[_-]?key|authorization|cookie|token|password)\s*[:=]\s*([^\s,;]+)",
    re.IGNORECASE,
)
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#]+)\?[^\s#]*", re.IGNORECASE)
_SENSITIVE_CONTENT_RE = re.compile(
    r"(?i)(\b(?:prompt|conversation(?:_content)?|messages?|tool[_ -]?(?:args?|arguments?|result|output)|"
    r"request[_ -]?body|response[_ -]?body|input[_ -]?text|output[_ -]?text|user[_ -]?message|"
    r"assistant[_ -]?message)\b\s*[:=])([^\r\n]*)"
)
_LOG_TIMESTAMP_RE = re.compile(
    r"\b(20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)?)\b"
)


@dataclass(frozen=True)
class SupportBundleContext:
    diagnostic_id: Optional[str] = None
    app_version: Optional[str] = None
    build_commit: Optional[str] = None
    reason: Optional[str] = None
    captured_at: Optional[str] = None


@dataclass(frozen=True)
class SupportBundleFile:
    name: str
    source_bytes: int
    included_bytes: int
    truncated: bool
    sha256: str


@dataclass(frozen=True)
class SupportBundleResult:
    path: Path
    size_bytes: int
    files: tuple[SupportBundleFile, ...]


def _safe_scalar(value: object, limit: int = 256) -> Optional[str]:
    if value is None:
        return None
    text = str(value).replace("\x00", "").strip()
    if not text:
        return None
    return text[:limit]


def _safe_context_value(value: object, limit: int) -> Optional[str]:
    raw = _safe_scalar(value, limit)
    if raw is None:
        return None
    redacted = redact_support_text(raw)
    if redacted != raw or not re.fullmatch(r"[A-Za-z0-9._:+/@-]{1,%d}" % limit, redacted):
        return "[REDACTED]"
    return redacted


def redact_support_text(text: str) -> str:
    """Force the project's credential redactor, then remove identity paths."""
    from agent.redact import redact_sensitive_text

    # Replace complete high-value credential shapes before the shared redactor,
    # which intentionally keeps small prefixes/suffixes for local debugging.
    safe = _GITHUB_TOKEN_RE.sub("[REDACTED_TOKEN]", text)
    safe = _AWS_ACCESS_KEY_RE.sub("[REDACTED_AWS_KEY]", safe)
    safe = _JWT_RE.sub("[REDACTED_JWT]", safe)
    safe = redact_sensitive_text(safe, force=True)
    safe = _AUTH_HEADER_RE.sub("Authorization: [REDACTED]", safe)
    safe = _COOKIE_HEADER_RE.sub("Cookie: [REDACTED]", safe)
    safe = _BEARER_RE.sub("Bearer [REDACTED]", safe)
    safe = _KEY_VALUE_RE.sub(r"\1=[REDACTED]", safe)
    safe = _EMAIL_RE.sub("[REDACTED_EMAIL]", safe)
    safe = _URL_QUERY_RE.sub(r"\1?[REDACTED]", safe)
    safe = _MAC_HOME_RE.sub("~/", safe)
    safe = _LINUX_HOME_RE.sub("~/", safe)
    safe = _WINDOWS_HOME_RE.sub(lambda _match: "~\\", safe)
    return safe.replace("\x00", "")


def sanitize_support_log(text: str) -> str:
    """Remove explicit prompt/conversation/tool payloads from selected logs.

    Regex redaction can never prove that arbitrary human text is absent, so the
    bundle manifest remains honest and the UI must show the exact selected
    files.  This pass nevertheless removes every known structured content field
    rather than merely masking credentials inside it.
    """
    safe = redact_support_text(text)
    return _SENSITIVE_CONTENT_RE.sub(lambda match: f"{match.group(1)}[CONTENT REDACTED]", safe)


def _regular_log_file(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except OSError:
        return False
    return stat.S_ISREG(mode) and not stat.S_ISLNK(mode)


def _read_log_tail(path: Path, max_bytes: int) -> tuple[str, int, bool, float]:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb", closefd=True) as stream:
        file_stat = os.fstat(stream.fileno())
        if not stat.S_ISREG(file_stat.st_mode):
            raise OSError("support log is not a regular file")
        source_bytes = file_stat.st_size
        offset = max(0, source_bytes - max_bytes)
        stream.seek(offset)
        data = stream.read(max_bytes)
    return data.decode("utf-8", errors="replace"), source_bytes, offset > 0, file_stat.st_mtime


def preview_support_logs(
    *,
    fan_home: Optional[Path] = None,
    log_names: Iterable[str] = DEFAULT_LOG_NAMES,
    per_log_bytes: int = DEFAULT_PER_LOG_BYTES,
) -> list[dict]:
    """Return the exact file names and maximum bytes the consent UI will show."""
    home = Path(fan_home) if fan_home is not None else get_fan_home()
    log_dir = home / "logs"
    preview: list[dict] = []
    for name in _normalize_log_names(log_names):
        path = log_dir / name
        if not _regular_log_file(path):
            continue
        try:
            raw_text, source_bytes, truncated, modified_at = _read_log_tail(path, per_log_bytes)
        except OSError:
            continue
        timestamps = _LOG_TIMESTAMP_RE.findall(raw_text)
        preview.append(
            {
                "name": name,
                "sourceBytes": source_bytes,
                "selectedBytes": min(source_bytes, per_log_bytes),
                "truncated": truncated,
                "modifiedAt": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ",
                    time.gmtime(modified_at),
                ),
                "timeRangeStart": timestamps[0] if timestamps else None,
                "timeRangeEnd": timestamps[-1] if timestamps else None,
            }
        )
    return preview


def _normalize_log_names(log_names: Iterable[str]) -> tuple[str, ...]:
    allowed = set(ALLOWED_LOG_NAMES)
    normalized: list[str] = []
    for raw in log_names:
        name = str(raw or "").strip()
        if name not in allowed:
            raise ValueError(f"Unsupported support log: {name}")
        if name not in normalized:
            normalized.append(name)
    return tuple(normalized)


def create_support_bundle(
    context: SupportBundleContext,
    *,
    fan_home: Optional[Path] = None,
    log_names: Iterable[str] = DEFAULT_LOG_NAMES,
    per_log_bytes: int = DEFAULT_PER_LOG_BYTES,
    total_log_bytes: int = DEFAULT_TOTAL_LOG_BYTES,
    now: Optional[float] = None,
) -> SupportBundleResult:
    """Create an atomic, owner-only ZIP containing only redacted log tails."""
    if per_log_bytes <= 0 or per_log_bytes > DEFAULT_TOTAL_LOG_BYTES:
        raise ValueError("per_log_bytes is outside the safe range")
    if total_log_bytes <= 0 or total_log_bytes > 10 * 1024 * 1024:
        raise ValueError("total_log_bytes is outside the safe range")

    home = Path(fan_home) if fan_home is not None else get_fan_home()
    staging_dir = home / "support" / "staging"
    staging_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    timestamp = time.time() if now is None else now
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "", context.diagnostic_id or "")[:64] or "manual"
    filename = f"diagnostic-{safe_id}-{int(timestamp)}-{uuid.uuid4().hex[:10]}.zip"
    target = staging_dir / filename
    temporary = target.with_suffix(".zip.tmp")
    remaining = total_log_bytes
    included: list[SupportBundleFile] = []

    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in _normalize_log_names(log_names):
                if remaining <= 0:
                    break
                source = home / "logs" / name
                if not _regular_log_file(source):
                    continue
                read_limit = min(per_log_bytes, remaining)
                try:
                    raw_text, source_bytes, truncated, _modified_at = _read_log_tail(source, read_limit)
                except OSError:
                    # Rotation, deletion, permission changes and symlink swaps are
                    # all safe reasons to omit one log without failing the bundle.
                    continue
                safe_text = sanitize_support_log(raw_text)
                encoded = safe_text.encode("utf-8")
                if len(encoded) > remaining:
                    encoded = encoded[-remaining:]
                    safe_text = encoded.decode("utf-8", errors="replace")
                    encoded = safe_text.encode("utf-8")
                    truncated = True
                archive.writestr(f"logs/{name}", encoded)
                included.append(
                    SupportBundleFile(
                        name=name,
                        source_bytes=source_bytes,
                        included_bytes=len(encoded),
                        truncated=truncated,
                        sha256=hashlib.sha256(encoded).hexdigest(),
                    )
                )
                remaining -= len(encoded)

            manifest = {
                "schemaVersion": SCHEMA_VERSION,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp)),
                "diagnostic": {
                    "id": _safe_context_value(context.diagnostic_id, 80),
                    "appVersion": _safe_context_value(context.app_version, 64),
                    "buildCommit": _safe_context_value(context.build_commit, 64),
                    "reason": _safe_context_value(context.reason, 64),
                    "capturedAt": _safe_context_value(context.captured_at, 64),
                },
                "runtime": {
                    "os": _safe_scalar(platform.system(), 32),
                    "osRelease": _safe_scalar(platform.release(), 128),
                    "arch": _safe_scalar(platform.machine(), 32),
                    "python": _safe_scalar(platform.python_version(), 32),
                },
                "files": [asdict(item) for item in included],
                "privacy": {
                    "redactionForced": True,
                    "sourceExclusions": [
                        "configuration",
                        "credentials",
                        "environment",
                        "sessions",
                    ],
                    "contentPolicy": "known prompt, conversation and tool payload fields are removed",
                    "mayContainUserProvidedText": True,
                },
            }
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        os.replace(temporary, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    return SupportBundleResult(path=target, size_bytes=target.stat().st_size, files=tuple(included))


__all__ = [
    "DEFAULT_LOG_NAMES",
    "SupportBundleContext",
    "SupportBundleFile",
    "SupportBundleResult",
    "create_support_bundle",
    "preview_support_logs",
    "redact_support_text",
    "sanitize_support_log",
]
