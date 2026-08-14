"""Shared runtime resolution for configured model providers."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

from agent.credential_pool import (
    CredentialPool,
    PooledCredential,
    credential_pool_matches_provider,
    get_custom_provider_pool_key,
    load_pool,
)
from fan_cli.auth import (
    AuthError,
    PROVIDER_REGISTRY,
    format_auth_error,
    has_usable_secret,
    resolve_api_key_provider_credentials,
    resolve_provider,
)
from fan_cli.config import get_compatible_custom_providers, load_config, read_raw_config
from utils import base_url_host_matches, base_url_hostname

logger = logging.getLogger(__name__)

def _normalize_custom_provider_name(value: str) -> str:
    return value.strip().lower().replace(" ", "-")


def _loopback_hostname(host: str) -> bool:
    h = (host or "").lower().rstrip(".")
    return h in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _config_base_url_trustworthy_for_bare_custom(
    cfg_base_url: str,
    cfg_provider: str,
) -> bool:
    """Decide whether ``model.base_url`` may back bare custom resolution."""
    cfg_provider_norm = (cfg_provider or "").strip().lower()
    if not cfg_base_url:
        return False
    if cfg_provider_norm == "custom" or cfg_provider_norm.startswith("custom:"):
        return True
    if cfg_provider_norm in {"", "auto"}:
        return _auto_configured_base_url_is_custom(cfg_base_url)
    try:
        if resolve_provider(cfg_provider_norm) == "custom":
            return True
    except Exception:
        pass
    return _loopback_hostname(base_url_hostname(cfg_base_url))


def _auto_configured_base_url_is_custom(cfg_base_url: str) -> bool:
    """Whether an ``auto`` config endpoint must win over ambient credentials.

    An explicitly configured endpoint is a stronger user choice than a stray
    provider key inherited by the desktop process. Use host matching rather
    than substring tests so a look-alike host cannot inherit that treatment.
    """
    if not cfg_base_url:
        return False

    known_hosts = {"openrouter.ai", "anthropic.com", "openai.com"}
    for pconfig in PROVIDER_REGISTRY.values():
        host = base_url_hostname(pconfig.inference_base_url)
        if host:
            known_hosts.add(host)
    return not any(base_url_host_matches(cfg_base_url, host) for host in known_hosts)


def _detect_api_mode_for_url(base_url: str) -> Optional[str]:
    """Infer supported transports from custom endpoint URL conventions.

    Fan custom endpoints are OpenAI-compatible unless the user explicitly
    selects the Responses API.
    """
    return None


def _auto_detect_local_model(base_url: str) -> str:
    """Query a local server for its model name when only one model is loaded."""
    if not base_url:
        return ""
    try:
        import requests

        url = base_url.rstrip("/")
        if not url.endswith("/v1"):
            url += "/v1"
        resp = requests.get(url + "/models", timeout=5)
        if resp.ok:
            models = resp.json().get("data", [])
            if len(models) == 1:
                model_id = models[0].get("id", "")
                if model_id:
                    return model_id
    except Exception as exc:
        logger.debug("Auto-detect model from %s failed: %s", base_url, exc)
    return ""


def _get_model_config() -> Dict[str, Any]:
    config = load_config()
    model_cfg = config.get("model")
    if isinstance(model_cfg, dict):
        cfg = dict(model_cfg)
        if not cfg.get("default") and cfg.get("model"):
            cfg["default"] = cfg["model"]
        default = (cfg.get("default") or "").strip()
        base_url = (cfg.get("base_url") or "").strip()
        if not default and base_url and _loopback_hostname(base_url_hostname(base_url)):
            detected = _auto_detect_local_model(base_url)
            if detected:
                cfg["default"] = detected
        return cfg
    if isinstance(model_cfg, str) and model_cfg.strip():
        return {"default": model_cfg.strip()}
    return {}


def _provider_supports_explicit_api_mode(
    provider: Optional[str],
    configured_provider: Optional[str] = None,
) -> bool:
    normalized_provider = (provider or "").strip().lower()
    normalized_configured = (configured_provider or "").strip().lower()
    if not normalized_configured:
        return True
    if normalized_provider == "custom":
        return normalized_configured == "custom" or normalized_configured.startswith("custom:")
    return normalized_configured == normalized_provider


_VALID_API_MODES = {
    "chat_completions",
    "codex_responses",
}


def _parse_api_mode(raw: Any) -> Optional[str]:
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in _VALID_API_MODES:
            return normalized
        if normalized:
            raise AuthError(
                f"Unsupported API mode: {normalized}. Use chat_completions for OpenAI-compatible endpoints.",
                provider="custom",
                code="unsupported_api_mode",
            )
    return None


def _resolve_runtime_from_pool_entry(
    *,
    provider: str,
    entry: PooledCredential,
    requested_provider: str,
    model_cfg: Optional[Dict[str, Any]] = None,
    pool: Optional[CredentialPool] = None,
    target_model: Optional[str] = None,
) -> Dict[str, Any]:
    model_cfg = model_cfg or _get_model_config()
    base_url = (
        getattr(entry, "runtime_base_url", None)
        or getattr(entry, "base_url", None)
        or ""
    ).rstrip("/")
    api_key = getattr(entry, "runtime_api_key", None) or getattr(entry, "access_token", "")
    configured_provider = str(model_cfg.get("provider") or "").strip().lower()
    configured_mode = _parse_api_mode(model_cfg.get("api_mode"))
    api_mode = (
        configured_mode
        if configured_mode and _provider_supports_explicit_api_mode(provider, configured_provider)
        else _detect_api_mode_for_url(base_url) or "chat_completions"
    )

    pconfig = PROVIDER_REGISTRY.get(provider)
    if pconfig:
        pool_url_is_default = base_url.rstrip("/") == pconfig.inference_base_url.rstrip("/")
        if configured_provider == provider and pool_url_is_default:
            cfg_base_url = str(model_cfg.get("base_url") or "").strip().rstrip("/")
            if cfg_base_url:
                base_url = cfg_base_url

    runtime = {
        "provider": provider,
        "api_mode": api_mode,
        "base_url": base_url,
        "api_key": api_key,
        "source": getattr(entry, "source", "pool"),
        "credential_pool": pool,
        "requested_provider": requested_provider,
    }
    resolved_model = str(target_model or model_cfg.get("default") or "").strip()
    if resolved_model:
        runtime["model"] = resolved_model
    return runtime


def _raw_config_provider() -> str:
    """Return the first explicitly stored provider, including legacy keys."""
    try:
        config = read_raw_config()
    except Exception:
        return ""
    if not isinstance(config, dict):
        return ""

    model = config.get("model")
    candidates = []
    if isinstance(model, dict):
        candidates.append(model.get("provider"))
    # Match config migration precedence: canonical keys beat legacy selection
    # hints, and the nested canonical key beats its old root-level spelling.
    candidates.append(config.get("provider"))
    if isinstance(model, dict):
        candidates.extend((model.get("active_provider"), model.get("model_provider")))
    candidates.extend(
        (config.get("active_provider"), config.get("model_provider"))
    )
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip().lower()
    return ""


def resolve_requested_provider(requested: Optional[str] = None) -> str:
    """Resolve provider request from explicit arg, config, then env."""
    if requested and requested.strip():
        return requested.strip().lower()

    raw_provider = _raw_config_provider()
    if raw_provider:
        return raw_provider

    model_cfg = _get_model_config()
    cfg_provider = model_cfg.get("provider")
    if isinstance(cfg_provider, str) and cfg_provider.strip():
        return cfg_provider.strip().lower()

    env_provider = os.getenv("FAN_INFERENCE_PROVIDER", "").strip().lower()
    if env_provider:
        return env_provider

    return "auto"


def _try_resolve_from_custom_pool(
    base_url: str,
    provider_label: str,
    api_mode_override: Optional[str] = None,
    provider_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    pool_key = get_custom_provider_pool_key(base_url, provider_name=provider_name)
    if not pool_key:
        return None
    try:
        pool = load_pool(pool_key)
        if not pool.has_credentials():
            return None
        entry = pool.select()
        if entry is None:
            return None
        pool_api_key = getattr(entry, "runtime_api_key", None) or getattr(entry, "access_token", "")
        if not pool_api_key:
            return None
        return {
            "provider": provider_label,
            "api_mode": api_mode_override or _detect_api_mode_for_url(base_url) or "chat_completions",
            "base_url": base_url,
            "api_key": pool_api_key,
            "source": f"pool:{pool_key}",
            "credential_pool": pool,
        }
    except Exception:
        return None


def _get_named_custom_provider(requested_provider: str) -> Optional[Dict[str, Any]]:
    """Return a configured custom provider entry by key/display name."""
    requested_norm = _normalize_custom_provider_name(requested_provider or "")
    if not requested_norm or requested_norm == "auto":
        return None

    # Bare "custom" is normally an incomplete spec (canonical form is
    # "custom:<name>") owned by the model.base_url "bare custom" trust path.
    # BUT a user may literally name a ``providers:`` (or legacy
    # ``custom_providers:``) entry "custom" (e.g. providers.custom). We used to
    # early-return None here *before* scanning config, so such an entry was
    # never matched and resolution fell through to the global default. Fall
    # through to the config scan instead; if no entry is literally named
    # "custom" it still returns None at the end, preserving the trust path.
    # Bare "custom" is also exempt from the built-in shadow check below -- it
    # is not a built-in provider to defer to.
    if requested_norm != "custom" and not requested_norm.startswith("custom:"):
        try:
            canonical = resolve_provider(requested_norm)
        except AuthError:
            pass
        else:
            if (canonical or "").strip().lower() == requested_norm:
                return None

    config = load_config()
    providers = config.get("providers")
    if isinstance(providers, dict):
        for entry_key, entry in providers.items():
            if not isinstance(entry, dict):
                continue
            candidates = {
                entry_key,
                _normalize_custom_provider_name(entry_key),
                f"custom:{_normalize_custom_provider_name(entry_key)}",
            }
            display_name = str(entry.get("name") or "").strip()
            if display_name:
                display_norm = _normalize_custom_provider_name(display_name)
                candidates.update({display_name, display_norm, f"custom:{display_norm}"})
            if requested_norm not in candidates:
                continue
            base_url = entry.get("api") or entry.get("url") or entry.get("base_url") or ""
            if not isinstance(base_url, str) or not base_url.strip():
                continue
            key_env = str(entry.get("key_env") or "").strip()
            result: Dict[str, Any] = {
                "name": display_name or entry_key,
                "base_url": base_url.strip(),
                "api_key": os.getenv(key_env, "").strip() if key_env else str(entry.get("api_key") or "").strip(),
                "model": entry.get("default_model", "") or entry.get("model", ""),
            }
            if key_env:
                result["key_env"] = key_env
            api_mode = _parse_api_mode(entry.get("api_mode") or entry.get("transport"))
            if api_mode:
                result["api_mode"] = api_mode
            extra_body = entry.get("extra_body")
            if isinstance(extra_body, dict):
                result["extra_body"] = dict(extra_body)
            return result

    custom_providers = get_compatible_custom_providers(config)
    for entry in custom_providers or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        base_url = entry.get("base_url")
        if not isinstance(name, str) or not isinstance(base_url, str):
            continue
        name_norm = _normalize_custom_provider_name(name)
        provider_key = str(entry.get("provider_key", "") or "").strip()
        provider_key_norm = _normalize_custom_provider_name(provider_key) if provider_key else ""
        candidates = {name_norm, f"custom:{name_norm}"}
        if provider_key_norm:
            candidates.update({provider_key_norm, f"custom:{provider_key_norm}"})
        if requested_norm not in candidates:
            continue
        result = {
            "name": name.strip(),
            "base_url": base_url.strip(),
            "api_key": str(entry.get("api_key", "") or "").strip(),
        }
        key_env = str(entry.get("key_env", "") or "").strip()
        if key_env:
            result["key_env"] = key_env
            env_key = os.getenv(key_env, "").strip()
            if env_key:
                result["api_key"] = env_key
        api_mode = _parse_api_mode(entry.get("api_mode") or entry.get("transport"))
        if api_mode:
            result["api_mode"] = api_mode
        model_name = str(entry.get("model", "") or "").strip()
        if model_name:
            result["model"] = model_name
        extra_body = entry.get("extra_body")
        if isinstance(extra_body, dict):
            result["extra_body"] = dict(extra_body)
        return result

    return None


def _custom_provider_request_overrides(custom_provider: Dict[str, Any]) -> Dict[str, Any]:
    extra_body = custom_provider.get("extra_body")
    if isinstance(extra_body, dict) and extra_body:
        return {"extra_body": dict(extra_body)}
    return {}


def _custom_runtime_result(
    *,
    base_url: str,
    api_key: str,
    source: str,
    requested_provider: str,
    api_mode: Optional[str] = None,
    model: str = "",
    request_overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "provider": "custom",
        "api_mode": api_mode or _detect_api_mode_for_url(base_url) or "chat_completions",
        "base_url": base_url.rstrip("/"),
        "api_key": api_key if has_usable_secret(api_key) else "no-key-required",
        "source": source,
        "requested_provider": requested_provider,
    }
    if model:
        result["model"] = model
    if request_overrides:
        result["request_overrides"] = request_overrides
    return result


def _resolve_named_custom_runtime(
    *,
    requested_provider: str,
    explicit_api_key: Optional[str] = None,
    explicit_base_url: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    requested_norm = _normalize_custom_provider_name(requested_provider or "")
    if requested_norm and requested_norm != "custom":
        try:
            if resolve_provider(requested_norm) == "custom":
                requested_norm = "custom"
        except Exception:
            pass

    if requested_norm == "custom" and explicit_base_url:
        base_url = explicit_base_url.strip().rstrip("/")
        pool_result = _try_resolve_from_custom_pool(base_url, "custom", None)
        if pool_result:
            pool_result["source"] = "direct-alias"
            pool_result["requested_provider"] = requested_provider
            return pool_result
        return _custom_runtime_result(
            base_url=base_url,
            api_key=(explicit_api_key or "").strip(),
            source="direct-alias",
            requested_provider=requested_provider,
        )

    custom_provider = _get_named_custom_provider(requested_provider)
    if not custom_provider:
        return None

    base_url = (
        (explicit_base_url or "").strip()
        or str(custom_provider.get("base_url") or "").strip()
    ).rstrip("/")
    if not base_url:
        return None

    pool_result = _try_resolve_from_custom_pool(
        base_url,
        "custom",
        custom_provider.get("api_mode"),
        provider_name=custom_provider.get("name"),
    )
    if pool_result:
        if custom_provider.get("model"):
            pool_result["model"] = custom_provider["model"]
        request_overrides = _custom_provider_request_overrides(custom_provider)
        if request_overrides:
            pool_result["request_overrides"] = {
                **dict(pool_result.get("request_overrides") or {}),
                **request_overrides,
            }
        pool_result["requested_provider"] = requested_provider
        return pool_result

    key_env = str(custom_provider.get("key_env") or "").strip()
    env_key = os.getenv(key_env, "").strip() if key_env else ""
    return _custom_runtime_result(
        base_url=base_url,
        api_key=(explicit_api_key or "").strip()
        or env_key
        or str(custom_provider.get("api_key") or "").strip(),
        source=f"custom_provider:{custom_provider.get('name', requested_provider)}",
        requested_provider=requested_provider,
        api_mode=custom_provider.get("api_mode"),
        model=str(custom_provider.get("model") or ""),
        request_overrides=_custom_provider_request_overrides(custom_provider),
    )


def _resolve_bare_custom_runtime(
    *,
    requested_provider: str,
    explicit_api_key: Optional[str] = None,
    explicit_base_url: Optional[str] = None,
    model_cfg: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    model_cfg = model_cfg or _get_model_config()
    cfg_base_url = model_cfg.get("base_url") if isinstance(model_cfg.get("base_url"), str) else ""
    cfg_provider = model_cfg.get("provider") if isinstance(model_cfg.get("provider"), str) else ""
    cfg_api_key = ""
    for key in ("api_key", "api"):
        value = model_cfg.get(key)
        if isinstance(value, str) and value.strip():
            cfg_api_key = value.strip()
            break

    use_config_base_url = bool(
        cfg_base_url.strip()
        and not explicit_base_url
        and _config_base_url_trustworthy_for_bare_custom(cfg_base_url, cfg_provider)
    )
    base_url = (
        (explicit_base_url or "").strip()
        or os.getenv("CUSTOM_BASE_URL", "").strip()
        or (cfg_base_url.strip() if use_config_base_url else "")
    ).rstrip("/")
    if not base_url:
        raise AuthError(
            "Custom provider requires model.base_url, CUSTOM_BASE_URL, or an explicit base URL.",
            provider="custom",
            code="missing_custom_base_url",
        )

    pool_result = _try_resolve_from_custom_pool(
        base_url,
        "custom",
        _parse_api_mode(model_cfg.get("api_mode")),
        provider_name=requested_provider if requested_provider != "custom" else None,
    )
    if pool_result:
        pool_result["requested_provider"] = requested_provider
        return pool_result

    return _custom_runtime_result(
        base_url=base_url,
        api_key=(explicit_api_key or "").strip() or (cfg_api_key if use_config_base_url else ""),
        source="explicit" if (explicit_api_key or explicit_base_url) else "env/config",
        requested_provider=requested_provider,
        api_mode=_parse_api_mode(model_cfg.get("api_mode")),
    )


def _resolve_explicit_runtime(
    *,
    provider: str,
    requested_provider: str,
    model_cfg: Dict[str, Any],
    explicit_api_key: Optional[str] = None,
    explicit_base_url: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    explicit_api_key = str(explicit_api_key or "").strip()
    explicit_base_url = str(explicit_base_url or "").strip().rstrip("/")
    if not explicit_api_key and not explicit_base_url:
        return None

    pconfig = PROVIDER_REGISTRY.get(provider)
    if not pconfig or pconfig.auth_type != "api_key":
        return None

    env_url = ""
    if pconfig.base_url_env_var:
        env_url = os.getenv(pconfig.base_url_env_var, "").strip().rstrip("/")

    base_url = explicit_base_url or env_url or pconfig.inference_base_url
    api_key = explicit_api_key
    if not api_key:
        creds = resolve_api_key_provider_credentials(provider)
        api_key = creds.get("api_key", "")

    configured_mode = _parse_api_mode(model_cfg.get("api_mode"))
    api_mode = configured_mode or _detect_api_mode_for_url(base_url) or "chat_completions"
    return {
        "provider": provider,
        "api_mode": api_mode,
        "base_url": base_url.rstrip("/"),
        "api_key": api_key,
        "source": "explicit",
        "requested_provider": requested_provider,
    }


def resolve_runtime_provider(
    *,
    requested: Optional[str] = None,
    explicit_api_key: Optional[str] = None,
    explicit_base_url: Optional[str] = None,
    target_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Resolve runtime provider credentials for agent execution."""
    requested_provider = resolve_requested_provider(requested)
    model_cfg = _get_model_config()

    custom_runtime = _resolve_named_custom_runtime(
        requested_provider=requested_provider,
        explicit_api_key=explicit_api_key,
        explicit_base_url=explicit_base_url,
    )
    if custom_runtime:
        custom_runtime["requested_provider"] = requested_provider
        return custom_runtime

    # ``model.provider: auto`` together with a configured custom/local
    # ``model.base_url`` must not be shadowed by an inherited DashScope key or
    # stale ambient credentials. Resolve it as a custom OpenAI-compatible
    # runtime before ``resolve_provider()`` scans the environment.
    if not explicit_base_url and not explicit_api_key:
        cfg_provider = str(model_cfg.get("provider") or "").strip().lower()
        cfg_base_url = str(model_cfg.get("base_url") or "").strip()
        if (
            cfg_provider in {"", "auto"}
            and _auto_configured_base_url_is_custom(cfg_base_url)
        ):
            return _resolve_bare_custom_runtime(
                requested_provider=requested_provider,
                model_cfg=model_cfg,
            )

    provider = resolve_provider(
        requested_provider,
        explicit_api_key=explicit_api_key,
        explicit_base_url=explicit_base_url,
    )

    if provider == "custom":
        return _resolve_bare_custom_runtime(
            requested_provider=requested_provider,
            explicit_api_key=explicit_api_key,
            explicit_base_url=explicit_base_url,
            model_cfg=model_cfg,
        )

    explicit_runtime = _resolve_explicit_runtime(
        provider=provider,
        requested_provider=requested_provider,
        model_cfg=model_cfg,
        explicit_api_key=explicit_api_key,
        explicit_base_url=explicit_base_url,
    )
    if explicit_runtime:
        return explicit_runtime

    pool = None
    try:
        pool = load_pool(provider)
    except Exception:
        pool = None
    if pool and pool.has_credentials():
        entry = pool.select()
        pool_api_key = ""
        if entry is not None:
            pool_api_key = (
                getattr(entry, "runtime_api_key", None)
                or getattr(entry, "access_token", "")
            )
        if (
            entry is not None
            and pool_api_key
            and credential_pool_matches_provider(
                pool,
                provider,
                base_url=(
                    getattr(entry, "runtime_base_url", None)
                    or getattr(entry, "base_url", None)
                    or ""
                ),
            )
        ):
            return _resolve_runtime_from_pool_entry(
                provider=provider,
                entry=entry,
                requested_provider=requested_provider,
                model_cfg=model_cfg,
                pool=pool,
                target_model=target_model,
            )

    pconfig = PROVIDER_REGISTRY.get(provider)
    if pconfig and pconfig.auth_type == "api_key":
        creds = resolve_api_key_provider_credentials(provider)
        # A provider explicitly selected in ``model.provider`` is
        # authoritative.  Do not return an empty-key runtime and let a later
        # request/fallback make the selection look as if it silently changed.
        # Custom/local no-key endpoints are resolved above on their own path.
        if not has_usable_secret(creds.get("api_key")):
            env_names = ", ".join(pconfig.api_key_env_vars)
            hint = f" 请配置 {env_names}。" if env_names else ""
            raise AuthError(
                f"提供商 '{provider}' 没有可用凭据。{hint}",
                provider=provider,
                code="missing_api_key",
            )
        cfg_provider = str(model_cfg.get("provider") or "").strip().lower()
        cfg_base_url = ""
        if cfg_provider == provider:
            cfg_base_url = str(model_cfg.get("base_url") or "").strip().rstrip("/")
        base_url = cfg_base_url or creds.get("base_url", "").rstrip("/")
        configured_mode = _parse_api_mode(model_cfg.get("api_mode"))
        configured_provider = str(model_cfg.get("provider") or "").strip().lower()
        api_mode = (
            configured_mode
            if configured_mode and _provider_supports_explicit_api_mode(provider, configured_provider)
            else _detect_api_mode_for_url(base_url) or "chat_completions"
        )
        return {
            "provider": provider,
            "api_mode": api_mode,
            "base_url": base_url,
            "api_key": creds.get("api_key", ""),
            "source": creds.get("source", "env"),
            "requested_provider": requested_provider,
        }

    raise AuthError(
        f"Provider '{provider}' is not configured. Configure a supported model provider and API key.",
        provider=provider,
        code="no_provider_configured",
    )



def format_runtime_provider_error(error: Exception) -> str:
    if isinstance(error, AuthError):
        return format_auth_error(error)
    return str(error)
