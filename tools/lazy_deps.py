"""
Lazy dependency installer for opt-in Fan Agent backends.

Many Fan features (Mistral TTS, ElevenLabs TTS, Honcho memory, Bedrock,
etc.) require Python packages that not every user needs. The
historical approach was to bundle them all under ``pyproject.toml`` extras
(``fan-agent[all]``) and install them eagerly at setup time. That has
two problems:

1. **Fragility.** When one extra's transitive dependency becomes
   unavailable on PyPI (quarantined for malware, yanked, broken upload),
   the *entire* ``[all]`` resolve fails and fresh installs silently fall
   back to a stripped tier — losing 10+ unrelated extras at once.

2. **Bloat.** A user who only ever talks to one provider pulls hundreds
   of packages they will never import.

The lazy-install pattern fixes both. Backends call :func:`ensure` at the
top of their first-import path. If the deps are missing, ``ensure`` checks
the ``security.allow_lazy_installs`` config flag (default true) and runs
a venv-scoped pip install. If the user has explicitly disabled lazy
installs, ``ensure`` raises :class:`FeatureUnavailable` with a clear
remediation hint pointing at ``fan tools`` or the manual pip command.

Security model:

* **Venv-scoped only.** Installs target ``sys.executable`` in the active
  venv. We never touch the system Python.
* **PyPI by package name only.** Specs may be ``"package>=1.0,<2"`` etc.
  We do NOT support ``--index-url`` overrides, ``git+https://``, file:
  paths, or any other input that could be hijacked by a malicious config.
* **Allowlist.** Only specs that appear in :data:`LAZY_DEPS` can be
  installed via this path. A typo in feature name doesn't get the user
  install-anything semantics.
* **Opt-out.** Setting ``security.allow_lazy_installs: false`` in
  ``config.yaml`` disables runtime installs. Users in restricted networks
  or strict security postures can pin themselves to whatever was installed
  at setup time.
* **Offline detection.** If the install fails (offline, mirror down,
  PyPI 404 / quarantine), we surface the failure as
  :class:`FeatureUnavailable` with the actual pip stderr — no silent
  retries, no caching of bad state.

Adding a new backend:

1. Add an entry to :data:`LAZY_DEPS` with the package specs.
2. At the top of the backend module's import path, call
   ``ensure("feature.name")`` inside a try/except that converts
   :class:`FeatureUnavailable` to a useful runtime error.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


# =============================================================================
# Allowlist of lazy-installable backends.
#
# Keys are dot-separated feature names ("namespace.backend"). Values are
# tuples of pip-installable specs that match the corresponding extra in
# pyproject.toml. The framework enforces that only specs from this map
# can flow into the pip install command.
# =============================================================================


LAZY_DEPS: dict[str, tuple[str, ...]] = {
    # ─── Inference providers ───────────────────────────────────────────────
    # AWS Bedrock provider
    "provider.bedrock": ("boto3==1.42.89",),
    # Microsoft Foundry — Entra ID auth (managed identity, workload identity,
    # service principal, az login, VS Code, azd, PowerShell). Only loaded
    # when model.auth_mode=entra_id is selected; key-based azure-foundry
    # users never pay this import.
    "provider.azure_identity": ("azure-identity==1.25.3",),

    # ─── TTS providers ─────────────────────────────────────────────────────
    # Pinned to exact versions to match pyproject.toml's no-ranges policy
    # (see comment at top of [project.dependencies]). When bumping, update
    # both this map AND the corresponding extra in pyproject.toml.
    #
    # mistralai pin tracks the `mistral` extra in pyproject.toml. PyPI
    # quarantined the project 2026-05-12 (malicious 2.4.6, Mini Shai-Hulud);
    # 2.4.6 was removed and clean releases resumed (2.4.7, 2.4.8). Voxtral
    # STT + TTS share the same SDK.
    "tts.mistral": ("mistralai==2.4.8",),
    "tts.edge": ("edge-tts==7.2.7",),
    "tts.elevenlabs": ("elevenlabs==1.59.0",),

    # ─── Speech-to-text providers ──────────────────────────────────────────
    "stt.mistral": ("mistralai==2.4.8",),
    "stt.faster_whisper": (
        "faster-whisper==1.2.1",
        "sounddevice==0.5.5",
        "numpy==2.4.3",
    ),

    # ─── Image generation backends ─────────────────────────────────────────

    # ─── Memory providers ──────────────────────────────────────────────────
    "memory.honcho": ("honcho-ai==2.0.1",),
    "memory.hindsight": ("hindsight-client==0.6.1",),


    # ─── Skills ────────────────────────────────────────────────────────────
    "skill.google_workspace": (
        "google-api-python-client==2.194.0",
        "google-auth-oauthlib==1.3.1",
        "google-auth-httplib2==0.3.1",
    ),
    # ─── Tools ─────────────────────────────────────────────────────────────
    # ACP adapter (VS Code / Zed / JetBrains integration)
    "tool.acp": ("agent-client-protocol==0.9.0",),
    # Dashboard (`fan dashboard`)
    "tool.dashboard": (
        "fastapi==0.133.1",
        "uvicorn[standard]==0.41.0",
        "starlette==1.0.1",  # CVE-2026-48710 (BadHost) — keep lazy-install in sync with pyproject [web]
    ),
    # Vision image-resize recovery (Pillow). Soft dependency: vision_tools and
    # conversation_compression degrade gracefully without it, but the byte AND
    # pixel-dimension shrink paths no-op when it's absent, so an oversized
    # image can brick a session on a provider's non-retryable 400. Keep in sync
    # with pyproject [vision].
    "tool.vision": ("Pillow==12.2.0",),
}


# Conservative regex for spec validation — package name plus optional
# version range. Reject anything that looks like a URL, file path, or shell
# metacharacter.
_SAFE_SPEC = re.compile(
    r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*"        # package name
    r"(?:\[[A-Za-z0-9_,\-]+\])?"            # optional [extras]
    r"(?:[<>=!~]=?[A-Za-z0-9_.\-+,*<>=!~]+)?"  # optional version specifier
    r"$"
)


class FeatureUnavailable(RuntimeError):
    """A lazily-installable feature is missing and cannot be made available.

    Either the deps were never installed and the user has disabled lazy
    installs, or the install attempt failed.
    """

    def __init__(self, feature: str, missing: tuple[str, ...], reason: str):
        self.feature = feature
        self.missing = missing
        self.reason = reason
        super().__init__(self._format())

    def _format(self) -> str:
        spec_list = " ".join(repr(s) for s in self.missing)
        return (
            f"Feature {self.feature!r} unavailable: {self.reason}. "
            f"To enable manually: uv pip install {spec_list}  "
            f"(or: pip install {spec_list})."
        )


@dataclass(frozen=True)
class _InstallResult:
    success: bool
    stdout: str
    stderr: str


# =============================================================================
# Internals
# =============================================================================


def _allow_lazy_installs() -> bool:
    """Return the ``security.allow_lazy_installs`` config flag.

    Defaults to True. If config is unreadable we fail open (allow), because
    refusing to install would lock people out of their own backends; the
    decision to block is an explicit user opt-in.
    """
    if os.environ.get("FAN_DISABLE_LAZY_INSTALLS") == "1":
        return False
    try:
        from fan_cli.config import load_config
        cfg = load_config()
    except Exception:
        return True
    sec = cfg.get("security") or {}
    val = sec.get("allow_lazy_installs", True)
    return bool(val)


def _spec_is_safe(spec: str) -> bool:
    """Reject pip specs that contain URLs, paths, or shell metacharacters."""
    if not spec or len(spec) > 200:
        return False
    if any(ch in spec for ch in (";", "|", "&", "`", "$", "\n", "\r", "\t", "\\")):
        return False
    if spec.startswith(("-", "/", ".")) or "://" in spec or "@" in spec:
        return False
    return bool(_SAFE_SPEC.match(spec))


def _pkg_name_from_spec(spec: str) -> str:
    """Extract the bare package name from a pip spec.

    ``"httpx[socks]>=0.27,<1"`` → ``"httpx"``
    ``"boto3>=1.34"`` → ``"boto3"``
    """
    m = re.match(r"^([A-Za-z0-9_][A-Za-z0-9_.\-]*)", spec)
    return m.group(1) if m else spec


def _specifier_from_spec(spec: str) -> str:
    """Extract just the version-specifier portion of a pip spec.

    ``"honcho-ai==2.0.1"`` → ``"==2.0.1"``
    ``"mautrix[encryption]>=0.20,<1"`` → ``">=0.20,<1"``
    ``"package"`` → ``""`` (no version constraint)
    """
    # Strip the package name + optional [extras] block.
    m = re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*(?:\[[A-Za-z0-9_,\-]+\])?", spec)
    if not m:
        return ""
    return spec[m.end():]


def _is_satisfied(spec: str) -> bool:
    """Is ``spec`` already satisfied in the current env?

    Checks both presence AND version. If the package is installed at a
    version outside the spec's range, returns False so the caller will
    upgrade/downgrade to the pinned version. This is what makes
    ``fan update`` propagate pin bumps in :data:`LAZY_DEPS` to already-
    installed backends instead of silently leaving stale versions in place.

    If ``packaging`` is unavailable for any reason (it's a transitive of
    pip so this should never happen), we fall back to a presence-only check
    so we err on the side of "don't churn".
    """
    pkg = _pkg_name_from_spec(spec)
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:
        return False
    try:
        installed = version(pkg)
    except PackageNotFoundError:
        return False
    except Exception:
        return False

    spec_tail = _specifier_from_spec(spec)
    if not spec_tail:
        # Bare ``"package"`` — no version constraint, presence is enough.
        return True

    try:
        from packaging.specifiers import InvalidSpecifier, SpecifierSet
        from packaging.version import InvalidVersion, Version
    except ImportError:
        # packaging unavailable — fall back to "installed counts as satisfied".
        return True

    try:
        return Version(installed) in SpecifierSet(spec_tail)
    except (InvalidSpecifier, InvalidVersion, Exception):
        # Malformed spec or installed version we can't parse — don't churn.
        return True


def _is_present(spec: str) -> bool:
    """Cheap presence-only check (package name installed at any version).

    Used by :func:`active_features` to detect backends the user has
    previously activated, regardless of whether the version pin moved.
    """
    pkg = _pkg_name_from_spec(spec)
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:
        return False
    try:
        version(pkg)
        return True
    except PackageNotFoundError:
        return False
    except Exception:
        return False


def _venv_pip_install(specs: tuple[str, ...], *, timeout: int = 300) -> _InstallResult:
    """Install ``specs`` into the active venv using uv → pip → ensurepip ladder.

    Mirrors the strategy in ``fan_cli.tools_config._pip_install`` but
    kept independent here so this module has no CLI dependency.
    """
    if not specs:
        return _InstallResult(True, "", "")

    from agent.redact import redact_sensitive_text
    from tools.environments.local import fan_subprocess_env

    def _safe(text: object) -> str:
        return redact_sensitive_text(str(text or ""), force=True)

    venv_root = Path(sys.executable).parent.parent
    install_env = fan_subprocess_env(inherit_provider_credentials=False)
    install_env["VIRTUAL_ENV"] = str(venv_root)

    # Tier 1: uv (preferred — fast, doesn't need pip in the venv)
    uv_bin = shutil.which("uv")
    if uv_bin:
        try:
            r = subprocess.run(
                [uv_bin, "pip", "install", *specs],
                capture_output=True, text=True, timeout=timeout, env=install_env,
            )
            if r.returncode == 0:
                return _InstallResult(True, _safe(r.stdout), _safe(r.stderr))
            logger.debug("uv pip install failed: %s", _safe(r.stderr))
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            logger.debug("uv invocation failed: %s", e)

    # Tier 2: python -m pip (with ensurepip bootstrap if needed)
    pip_cmd = [sys.executable, "-m", "pip"]
    try:
        probe = subprocess.run(
            pip_cmd + ["--version"],
            capture_output=True, text=True, timeout=15,
            env=install_env,
        )
        if probe.returncode != 0:
            raise FileNotFoundError("pip not in venv")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        try:
            subprocess.run(
                [sys.executable, "-m", "ensurepip", "--upgrade", "--default-pip"],
                capture_output=True, text=True, timeout=120, check=True,
                env=install_env,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            return _InstallResult(False, "",
                                  f"pip not available and ensurepip failed: {_safe(e)}")

    try:
        r = subprocess.run(
            pip_cmd + ["install", *specs],
            capture_output=True, text=True, timeout=timeout, env=install_env,
        )
        return _InstallResult(r.returncode == 0, _safe(r.stdout), _safe(r.stderr))
    except subprocess.TimeoutExpired as e:
        return _InstallResult(False, "", f"pip install timed out: {_safe(e)}")
    except Exception as e:
        return _InstallResult(False, "", f"pip install failed: {_safe(e)}")


# =============================================================================
# Public API
# =============================================================================


def feature_specs(feature: str) -> tuple[str, ...]:
    """Return the registered specs for a feature, or raise KeyError."""
    if feature not in LAZY_DEPS:
        raise KeyError(f"Unknown lazy feature: {feature!r}")
    return LAZY_DEPS[feature]


def feature_missing(feature: str) -> tuple[str, ...]:
    """Return the subset of specs for ``feature`` not currently installed."""
    return tuple(s for s in feature_specs(feature) if not _is_satisfied(s))


def ensure(feature: str, *, prompt: bool = True) -> None:
    """Make sure all packages for ``feature`` are importable.

    If they're missing, attempts to install them in the active venv. Raises
    :class:`FeatureUnavailable` if the user has disabled lazy installs or
    if the install attempt fails.

    ``prompt``: when True (default) and stdin is a TTY, asks the user to
    confirm before installing. Non-interactive callers (gateway, cron,
    batch) get prompt=False and skip the confirmation — config flag is
    the gate in that case.
    """
    if feature not in LAZY_DEPS:
        raise FeatureUnavailable(
            feature, (), f"feature {feature!r} not in LAZY_DEPS allowlist"
        )

    missing = feature_missing(feature)
    if not missing:
        return

    # Validate every spec against the allowlist + safety regex. Belt and
    # braces — the keys-in-LAZY_DEPS check above already constrains this.
    for spec in missing:
        if not _spec_is_safe(spec):
            raise FeatureUnavailable(
                feature, missing,
                f"refusing to install unsafe spec {spec!r}"
            )

    if not _allow_lazy_installs():
        raise FeatureUnavailable(
            feature, missing,
            "lazy installs disabled (security.allow_lazy_installs=false)"
        )

    if prompt and sys.stdin.isatty() and sys.stdout.isatty():
        spec_list = ", ".join(missing)
        try:
            answer = input(
                f"\nFeature {feature!r} requires: {spec_list}\n"
                f"Install into the active venv now? [Y/n] "
            ).strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer and answer not in {"y", "yes"}:
            raise FeatureUnavailable(
                feature, missing, "user declined install at prompt"
            )

    logger.info("Lazy-installing %s for feature %r", " ".join(missing), feature)
    result = _venv_pip_install(missing)
    if not result.success:
        # Surface the actual pip error so the user can debug PyPI-side
        # issues (404 quarantine, network down, etc.).
        snippet = (result.stderr or result.stdout or "").strip()
        if snippet:
            # Clip to a readable size — pip can dump pages of resolution traces.
            snippet = snippet[-2000:]
        raise FeatureUnavailable(
            feature, missing,
            f"pip install failed: {snippet or 'no error output'}"
        )

    # Verify post-install. importlib.metadata caches per-process, so if we
    # just installed something the cache may not see it without a refresh.
    try:
        import importlib.metadata as _md
        if hasattr(_md, "_cache_clear"):
            _md._cache_clear()  # type: ignore[attr-defined]
    except Exception:
        pass

    still_missing = feature_missing(feature)
    if still_missing:
        raise FeatureUnavailable(
            feature, still_missing,
            "install reported success but packages still not importable "
            "(may require Python restart)"
        )

    logger.info("Lazy install complete for feature %r", feature)


def is_available(feature: str) -> bool:
    """Return True if the feature's deps are already satisfied."""
    if feature not in LAZY_DEPS:
        return False
    return not feature_missing(feature)



def active_features() -> list[str]:
    """Return the list of features the user has ever lazy-installed.

    A feature counts as "active" if at least one of its declared packages
    is currently installed in the venv (presence check, ignoring version).
    Features the user has never enabled stay quiet.

    Used by ``fan update`` to figure out which lazy backends need a
    refresh pass when pins move in :data:`LAZY_DEPS`.
    """
    active = []
    for feature, specs in LAZY_DEPS.items():
        if any(_is_present(s) for s in specs):
            active.append(feature)
    return active



def ensure_and_bind(
    feature: str,
    importer: Callable[[], dict[str, Any]],
    target_globals: dict,
    *,
    prompt: bool = False,
) -> bool:
    """Ensure a feature is installed, then rebind names into the caller's globals.

    Combines :func:`ensure` with a post-install import step that rebinds
    module-level names.  This eliminates the error-prone pattern of manually
    listing every global that needs updating after lazy-install.

    ``importer`` is a zero-arg callable that returns a dict of
    ``{name: value}`` for all symbols the caller needs rebound.  It is called
    only after :func:`ensure` succeeds (or if the packages are already
    installed).

    Returns True on success, False if deps couldn't be installed or imported.

    Example usage in a feature module::

        def check_voice_requirements() -> bool:
            if VOICE_AVAILABLE:
                return True
            def _import():
                import sounddevice
                return {"sounddevice": sounddevice, "VOICE_AVAILABLE": True}
            return ensure_and_bind("voice.local", _import, globals(), prompt=False)
    """
    try:
        ensure(feature, prompt=prompt)
    except (FeatureUnavailable, Exception):
        return False

    try:
        bindings = importer()
    except ImportError:
        return False

    target_globals.update(bindings)
    return True
