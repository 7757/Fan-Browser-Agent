"""Shared auxiliary client router for side tasks.

Every side-task consumer (compression, search, extraction, title generation,
and vision) routes through this module. Auto mode reuses the live main runtime
first—including configured direct providers—then considers configured
custom/local endpoints and supported direct API-key providers.
"""

import contextlib
from contextvars import ContextVar as _ContextVar
import json
import logging
import os
import threading
import time
from pathlib import Path  # noqa: F401 — used by test mocks
from types import SimpleNamespace
from typing import Any, Dict, List, NamedTuple, Optional, Tuple, TYPE_CHECKING
from urllib.parse import urlparse, parse_qs, urlunparse

# NOTE: `from openai import OpenAI` is deliberately NOT at module top — the
# openai SDK pulls a large type tree (~240 ms cold, including responses/*,
# graders/*). We expose `OpenAI` here as a thin proxy that imports the SDK on
# first call and forwards, so:
#   (a) the 15+ in-module `OpenAI(...)` construction sites work unchanged
#       (Python's function-scope name lookup resolves `OpenAI` to the proxy
#       object bound in module globals here, without triggering any import);
#   (b) external code can still do `auxiliary_client.OpenAI` or
#       `patch("agent.auxiliary_client.OpenAI", ...)` — tests see the proxy,
#       and patch replaces the module attribute as usual;
#   (c) `OpenAI` as a type annotation resolves at runtime to the proxy class
#       (which is harmless — annotations aren't type-checked at runtime).
# See tests/agent/test_auxiliary_client.py for patch patterns this supports.
if TYPE_CHECKING:
    from openai import OpenAI  # noqa: F401 — type hints only

_OPENAI_CLS_CACHE: Optional[type] = None


def _load_openai_cls() -> type:
    """Import and cache ``openai.OpenAI``."""
    global _OPENAI_CLS_CACHE
    if _OPENAI_CLS_CACHE is None:
        from openai import OpenAI as _cls
        _OPENAI_CLS_CACHE = _cls
    return _OPENAI_CLS_CACHE


class _OpenAIProxy:
    """Module-level proxy that looks like the ``openai.OpenAI`` class.

    Forwards ``OpenAI(...)`` calls and ``isinstance(x, OpenAI)`` checks to the
    real SDK class, importing the SDK lazily on first use.
    """

    __slots__ = ()

    def __call__(self, *args, **kwargs):
        return _load_openai_cls()(*args, **kwargs)

    def __instancecheck__(self, obj):
        return isinstance(obj, _load_openai_cls())

    def __repr__(self):
        return "<lazy openai.OpenAI proxy>"


OpenAI = _OpenAIProxy()  # module-level name, resolves lazily on call/isinstance

from agent.credential_pool import load_pool
from agent.process_bootstrap import build_keepalive_http_client
from utils import base_url_host_matches, base_url_hostname, normalize_proxy_env_vars

logger = logging.getLogger(__name__)


def _resolve_aux_verify(base_url: Optional[str]) -> Any:
    """Resolve TLS verification consistently with the primary client."""
    try:
        from agent.ssl_verify import resolve_httpx_verify
        from fan_cli.config import (
            get_custom_provider_tls_settings,
            load_config_readonly,
        )

        tls = get_custom_provider_tls_settings(
            str(base_url or ""), config=load_config_readonly()
        )
        return resolve_httpx_verify(
            ca_bundle=tls.get("ssl_ca_cert"),
            ssl_verify=tls.get("ssl_verify"),
            base_url=str(base_url or ""),
        )
    except Exception:
        return True


def _openai_http_client_kwargs(
    base_url: Optional[str], *, async_mode: bool = False
) -> Dict[str, Any]:
    client = build_keepalive_http_client(
        str(base_url or ""),
        async_mode=async_mode,
        verify=_resolve_aux_verify(base_url),
    )
    return {"http_client": client} if client is not None else {}


def _create_openai_client(*, api_key: str, base_url: str, **kwargs: Any) -> Any:
    """Create a sync SDK client with Fan's explicit proxy policy."""
    options = {**_openai_http_client_kwargs(base_url), **kwargs}
    # Fan owns retry and fallback policy at the call boundary. Leaving the
    # OpenAI SDK default retries enabled silently multiplies a slow auxiliary
    # request's wall time before our own recovery logic can run.
    options.setdefault("max_retries", 0)
    return OpenAI(api_key=api_key, base_url=base_url, **options)


# Compression is an atomic auxiliary task: a normal gateway interrupt must not
# abort its in-flight handoff summary.  Thread-local scope keeps every other
# auxiliary task interruptible and does not affect timeout/process-exit paths.
_aux_interrupt_protection = threading.local()


def _aux_interrupt_protected() -> bool:
    return bool(getattr(_aux_interrupt_protection, "active", False))


@contextlib.contextmanager
def aux_interrupt_protection(active: bool = True):
    """Temporarily protect this thread's auxiliary call from soft interrupt."""
    previous = getattr(_aux_interrupt_protection, "active", False)
    _aux_interrupt_protection.active = active
    try:
        yield
    finally:
        _aux_interrupt_protection.active = previous


def _extract_url_query_params(url: str):
    """Extract query params from URL, return (clean_url, default_query dict or None)."""
    parsed = urlparse(url)
    if parsed.query:
        clean = urlunparse(parsed._replace(query=""))
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        return clean, params
    return url, None


# Module-level flag: only warn once per process about stale OPENAI_BASE_URL.
_stale_base_url_warned = False

_PROVIDER_ALIASES = {
    "deepseek-api": "deepseek",
    "ollama_cloud": "ollama-cloud",
    "dashscope": "alibaba",
    "aliyun": "alibaba",
    "aliyun-bailian": "alibaba",
    "alibaba-cloud": "alibaba",
    "qwen": "alibaba",
    "qwen-dashscope": "alibaba",
    "tongyi": "alibaba",
    "alibaba_coding": "alibaba-coding-plan",
    "alibaba-coding": "alibaba-coding-plan",
    "alibaba_coding_plan": "alibaba-coding-plan",
    "dashscope-coding": "alibaba-coding-plan",
    "local": "custom",
    "ollama": "custom",
    "vllm": "custom",
    "llamacpp": "custom",
    "llama.cpp": "custom",
    "llama-cpp": "custom",
}


def _normalize_aux_provider(provider: Optional[str]) -> str:
    normalized = (provider or "auto").strip().lower()
    if normalized.startswith("custom:"):
        suffix = normalized.split(":", 1)[1].strip()
        if not suffix:
            return "custom"
        normalized = suffix
    if normalized == "main":
        # Resolve to the user's actual main provider so named custom providers
        # and Alibaba work correctly.
        main_prov = (_read_main_provider() or "").strip().lower()
        if main_prov and main_prov not in {"auto", "main", ""}:
            normalized = main_prov
        else:
            return "custom"
    return _PROVIDER_ALIASES.get(normalized, normalized)


# Sentinel: when returned by _fixed_temperature_for_model(), callers must
# strip the ``temperature`` key from API kwargs entirely so the provider's
# server-side default applies. Kimi/Moonshot and DeepSeek V4 manage sampling
# server-side in thinking mode, so auxiliary calls omit temperature for them.
OMIT_TEMPERATURE: object = object()


def _is_kimi_model(model: Optional[str]) -> bool:
    """True for any Kimi / Moonshot model that manages temperature server-side."""
    bare = (model or "").strip().lower().rsplit("/", 1)[-1]
    return bare.startswith("kimi-") or bare == "kimi"


def _is_arcee_trinity_thinking(model: Optional[str]) -> bool:
    """True for Arcee Trinity Large Thinking (direct or via OpenRouter)."""
    bare = (model or "").strip().lower().rsplit("/", 1)[-1]
    return bare == "trinity-large-thinking"


def _is_deepseek_v4_model(model: Optional[str], base_url: Optional[str]) -> bool:
    """True for DeepSeek V4 direct calls that ignore sampling controls."""
    bare = (model or "").strip().lower().rsplit("/", 1)[-1]
    return bare.startswith("deepseek-v4-") or base_url_host_matches(
        base_url or "", "api.deepseek.com"
    )


def _fixed_temperature_for_model(
    model: Optional[str],
    base_url: Optional[str] = None,
) -> "Optional[float] | object":
    """Return a temperature directive for models with strict contracts.

    Returns:
        ``OMIT_TEMPERATURE`` — caller must remove the ``temperature`` key so the
            provider chooses its own default.  Used for all Kimi / Moonshot
            models whose gateway selects temperature server-side.
        ``float`` — a specific value the caller must use (reserved for future
            models with fixed-temperature contracts).
        ``None`` — no override; caller should use its own default.
    """
    if _is_kimi_model(model):
        logger.debug("Omitting temperature for Kimi model %r (server-managed)", model)
        return OMIT_TEMPERATURE
    if _is_deepseek_v4_model(model, base_url):
        logger.debug("Omitting temperature for DeepSeek V4 model %r", model)
        return OMIT_TEMPERATURE
    if _is_arcee_trinity_thinking(model):
        return 0.5
    return None


def _compression_threshold_for_model(model: Optional[str]) -> Optional[float]:
    """Return a context-compression threshold override for specific models.

    The threshold is the fraction of the model's context window that must be
    consumed before Fan triggers summarization.  Higher values delay
    compression and preserve more raw context.

    Returns a float in (0, 1] to override the global ``compression.threshold``
    config value, or ``None`` to leave the user's config value unchanged.
    """
    if _is_arcee_trinity_thinking(model):
        return 0.75
    return None

# Default auxiliary models for direct API-key providers (cheap/fast for side tasks)
def _get_aux_model_for_provider(provider_id: str) -> str:
    """Return the cheap auxiliary model for a provider.

    Reads from ProviderProfile.default_aux_model first, falling back to the
    legacy hardcoded dict for providers that predate the profiles system.
    """
    try:
        from providers import get_provider_profile
        _p = get_provider_profile(provider_id)
        if _p and _p.default_aux_model:
            return _p.default_aux_model
    except Exception:
        pass
    return _API_KEY_PROVIDER_AUX_MODELS_FALLBACK.get(provider_id, "")


# Fallback models for the locked built-in API-key providers.
_API_KEY_PROVIDER_AUX_MODELS_FALLBACK: Dict[str, str] = {
    "deepseek": "deepseek-v4-flash",
    "alibaba": "qwen3-vl-plus",
    "alibaba-coding-plan": "qwen3-vl-plus",
}

# Legacy alias — callers that haven't been updated to _get_aux_model_for_provider()
# can still use this dict directly. Kept in sync with _FALLBACK above.
_API_KEY_PROVIDER_AUX_MODELS: Dict[str, str] = _API_KEY_PROVIDER_AUX_MODELS_FALLBACK

# Vision-specific model overrides for direct providers.
# When the user's main provider has a dedicated vision/multimodal model that
# differs from their main chat model, map it here.  The vision auto-detect
# "exotic provider" branch checks this before falling back to the main model.
_PROVIDER_VISION_MODELS: Dict[str, str] = {
    "alibaba": "qwen3-vl-plus",
    "alibaba-coding-plan": "qwen3-vl-plus",
}

# Providers whose endpoint does not accept image input, even though the
# provider's broader ecosystem has vision models available elsewhere.  When
# `auxiliary.vision.provider: auto` sees one of these as the main provider,
# it must skip straight to the aggregator chain instead of returning a client
# that will 404 on every vision request.
#
_PROVIDERS_WITHOUT_VISION: frozenset = frozenset({"deepseek"})

# OpenRouter app attribution headers (base — always sent).
# `X-Title` is the canonical attribution header OpenRouter's dashboard
# reads; the previous `X-OpenRouter-Title` label was not recognized there.
_OR_HEADERS_BASE = {
    "X-Title": "Fan Agent",
    "X-OpenRouter-Categories": "productivity,cli-agent",
}

# Truthy values for boolean env-var parsing.
_TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "on"})


def _apply_user_default_headers(headers: dict | None) -> dict | None:
    """Merge user-configured ``model.default_headers`` onto resolved headers.

    User values take precedence over provider/SDK defaults, mirroring the main
    agent client (``AIAgent._apply_user_default_headers``). This lets a
    ``custom`` OpenAI-compatible endpoint behind a gateway/WAF that rejects the
    OpenAI SDK's identifying headers (``User-Agent: OpenAI/Python ...``,
    ``X-Stainless-*``) override them for auxiliary calls too — otherwise the
    main turn would succeed but title/compression/vision calls to the same
    endpoint would still fail. (#40033)

    Returns the merged dict, or the original ``headers`` (possibly ``None``)
    when nothing is configured. No allocation when there are no overrides.
    """
    try:
        from fan_cli.config import cfg_get, load_config
        user_headers = cfg_get(load_config(), "model", "default_headers")
    except Exception:
        return headers
    if not isinstance(user_headers, dict) or not user_headers:
        return headers
    merged = dict(headers or {})
    for key, value in user_headers.items():
        if value is None:
            continue
        merged[str(key)] = str(value)
    return merged or headers


def build_or_headers(or_config: dict | None = None) -> dict:
    """Build OpenRouter headers, optionally including response-cache headers.

    Precedence for response cache: env var > config.yaml > default (enabled).

    Environment variables:
        ``FAN_OPENROUTER_CACHE`` — truthy (``1``/``true``/``yes``/``on``)
            enables caching; ``0``/``false``/``no``/``off`` disables.
            Overrides ``openrouter.response_cache`` in config.yaml.
        ``FAN_OPENROUTER_CACHE_TTL`` — integer seconds (1-86400).
            Overrides ``openrouter.response_cache_ttl`` in config.yaml.

    *or_config* is the ``openrouter`` section from config.yaml.  When *None*,
    falls back to reading config from disk via ``load_config()``.
    """
    headers = dict(_OR_HEADERS_BASE)

    # Resolve config from disk if not provided.
    if or_config is None:
        try:
            from fan_cli.config import load_config
            or_config = load_config().get("openrouter", {})
        except Exception:
            or_config = {}

    # Determine cache enabled: env var overrides config.
    env_cache = os.environ.get("FAN_OPENROUTER_CACHE", "").strip().lower()
    if env_cache:
        cache_enabled = env_cache in _TRUTHY_ENV_VALUES
    else:
        cache_enabled = or_config.get("response_cache", False)

    if not cache_enabled:
        return headers

    headers["X-OpenRouter-Cache"] = "true"

    # Determine TTL: env var overrides config.
    env_ttl = os.environ.get("FAN_OPENROUTER_CACHE_TTL", "").strip()
    if env_ttl:
        if env_ttl.isdigit():
            ttl = int(env_ttl)
            if 1 <= ttl <= 86400:
                headers["X-OpenRouter-Cache-TTL"] = str(ttl)
    else:
        ttl = or_config.get("response_cache_ttl", 300)
        if isinstance(ttl, (int, float)) and 1 <= ttl <= 86400:
            headers["X-OpenRouter-Cache-TTL"] = str(int(ttl))

    return headers


# NVIDIA NIM cloud billing attribution.  Keep this host-gated because the
# nvidia provider also supports local/on-prem NIM endpoints via NVIDIA_BASE_URL.
_NVIDIA_NIM_CLOUD_HEADERS = {
    "X-BILLING-INVOKE-ORIGIN": "FanAgent",
}


def build_nvidia_nim_headers(base_url: str | None) -> dict:
    """Return NVIDIA NIM cloud attribution headers for build.nvidia.com traffic."""
    if base_url_host_matches(str(base_url or ""), "integrate.api.nvidia.com"):
        return dict(_NVIDIA_NIM_CLOUD_HEADERS)
    return {}



# Default auxiliary models per provider
_OPENROUTER_MODEL = "google/gemini-3-flash-preview"
# Codex OAuth endpoint used when a caller explicitly requests
# provider="openai-codex".  There is deliberately no hardcoded default
# model: the set of models OpenAI accepts on this endpoint for
# ChatGPT-account auth is an undocumented, shifting allow-list, and
# pinning one here has drifted silently twice (gpt-5.3-codex → gpt-5.2-codex
# → gpt-5.4 over 6 weeks in early 2026).  Callers must pass the model
# they want explicitly (from config.yaml model.model, auxiliary.<task>.model,
# or the user's active Codex model selection).
_CODEX_AUX_BASE_URL = "https://chatgpt.com/backend-api/codex"


def _codex_cloudflare_headers(access_token: str) -> Dict[str, str]:
    """Headers required to avoid Cloudflare 403s on chatgpt.com/backend-api/codex.

    The Cloudflare layer in front of the Codex endpoint whitelists a small set of
    first-party originators (``codex_cli_rs``, ``codex_vscode``, ``codex_sdk_ts``,
    anything starting with ``Codex``). Requests from non-residential IPs (VPS,
    server-hosted agents) that don't advertise an allowed originator are served
    a 403 with ``cf-mitigated: challenge`` regardless of auth correctness.

    We pin ``originator: codex_cli_rs`` to match the upstream codex-rs CLI, set
    ``User-Agent`` to a codex_cli_rs-shaped string (beats SDK fingerprinting),
    and extract ``ChatGPT-Account-ID`` (canonical casing, from codex-rs
    ``auth.rs``) out of the OAuth JWT's ``chatgpt_account_id`` claim.

    Malformed tokens are tolerated — we drop the account-ID header rather than
    raise, so a bad token still surfaces as an auth error (401) instead of a
    crash at client construction.
    """
    headers = {
        "User-Agent": "codex_cli_rs/0.0.0 (Fan Agent)",
        "originator": "codex_cli_rs",
    }
    if not isinstance(access_token, str) or not access_token.strip():
        return headers
    try:
        import base64
        parts = access_token.split(".")
        if len(parts) < 2:
            return headers
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        acct_id = claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
        if isinstance(acct_id, str) and acct_id:
            headers["ChatGPT-Account-ID"] = acct_id
    except Exception:
        pass
    return headers


def _to_openai_base_url(base_url: str) -> str:
    """Normalize an OpenAI-compatible base URL."""
    return str(base_url or "").strip().rstrip("/")


def _select_pool_entry(provider: str) -> Tuple[bool, Optional[Any]]:
    """Return (pool_exists_for_provider, selected_entry)."""
    try:
        pool = load_pool(provider)
    except Exception as exc:
        logger.debug("Auxiliary client: could not load pool for %s: %s", provider, exc)
        return False, None
    if not pool or not pool.has_credentials():
        return False, None
    try:
        return True, pool.select()
    except Exception as exc:
        logger.debug("Auxiliary client: could not select pool entry for %s: %s", provider, exc)
        return True, None


def _peek_pool_entry(provider: str) -> Optional[Any]:
    """Best-effort current/next pool entry without mutating selection order."""
    try:
        pool = load_pool(provider)
    except Exception as exc:
        logger.debug("Auxiliary client: could not load pool for %s (peek): %s", provider, exc)
        return None
    if not pool or not pool.has_credentials():
        return None
    try:
        current_fn = getattr(pool, "current", None)
        if callable(current_fn):
            current = current_fn()
            if current is not None:
                return current
        peek_fn = getattr(pool, "peek", None)
        if callable(peek_fn):
            return peek_fn()
    except Exception as exc:
        logger.debug("Auxiliary client: could not peek pool entry for %s: %s", provider, exc)
    return None


def _pool_runtime_api_key(entry: Any) -> str:
    if entry is None:
        return ""
    # Use the PooledCredential runtime view rather than its storage field.
    key = getattr(entry, "runtime_api_key", None) or getattr(entry, "access_token", "")
    return str(key or "").strip()


def _pool_runtime_base_url(entry: Any, fallback: str = "") -> str:
    if entry is None:
        return str(fallback or "").strip().rstrip("/")
    # Fall back through inference_base_url and base_url for non-PooledCredential entries.
    url = (
        getattr(entry, "runtime_base_url", None)
        or getattr(entry, "inference_base_url", None)
        or getattr(entry, "base_url", None)
        or fallback
    )
    return str(url or "").strip().rstrip("/")


# ── Codex Responses → chat.completions adapter ─────────────────────────────
# All auxiliary consumers call client.chat.completions.create(**kwargs) and
# read response.choices[0].message.content. This adapter translates those
# calls to the Codex Responses API so callers don't need any changes.


class _CodexCompletionsAdapter:
    """Drop-in shim that accepts chat.completions.create() kwargs and
    routes them through the Codex Responses streaming API."""

    def __init__(self, real_client: OpenAI, model: str):
        self._client = real_client
        self._model = model

    def create(self, **kwargs) -> Any:
        messages = kwargs.get("messages", [])
        model = kwargs.get("model", self._model)

        # Separate system/instructions from replayable conversation messages,
        # then route the rest through the SINGLE shared chat->Responses
        # converter used by the main agent transport
        # (agent/transports/codex.py). Maintaining a private conversion loop
        # here let chat-style messages with role="tool" leak straight into
        # Responses input[] — which the Responses API rejects with
        # "Invalid value: 'tool'. Supported values are: 'assistant', 'system',
        # 'developer', and 'user'." (issue #5709, hit hard by flush_memories()
        # / compression replaying real session history that includes assistant
        # tool_calls + role="tool" results). The shared converter encodes
        # assistant tool calls as `function_call` items and tool results as
        # `function_call_output` items with a valid call_id, so every
        # Responses path normalizes tool history identically and cannot drift.
        from agent.codex_responses_adapter import _chat_messages_to_responses_input
        from utils import base_url_host_matches

        instructions = "You are a helpful assistant."
        replay_messages: List[Dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content") or ""
            if role == "system":
                instructions = content if isinstance(content, str) else str(content)
            else:
                replay_messages.append(msg)

        # Copilot's replayed assistant ids are connection-scoped and expire
        # across restart/credential rotation.  Auxiliary Responses calls use
        # this independent adapter, so it must enforce the same policy as the
        # main Responses transport.
        base_url = str(getattr(self._client, "base_url", "") or "")
        input_items = _chat_messages_to_responses_input(
            replay_messages,
            is_github_responses=base_url_host_matches(base_url, "githubcopilot.com"),
        )

        resp_kwargs: Dict[str, Any] = {
            "model": model,
            "instructions": instructions,
            "input": input_items or [{"role": "user", "content": ""}],
            "store": False,
        }

        # Preserve the chat.completions timeout contract. This adapter is used
        # by auxiliary calls such as context compression; if the timeout is not
        # forwarded and enforced, a Codex Responses stream can sit behind a
        # dead-looking CLI until the user force-interrupts the whole session.
        timeout = kwargs.get("timeout")
        if timeout is not None:
            resp_kwargs["timeout"] = timeout

        # Note: the Codex endpoint (chatgpt.com/backend-api/codex) does NOT
        # support max_output_tokens or temperature — omit to avoid 400 errors.

        # Translate extra_body.reasoning (chat.completions shape) into the
        # Responses API's top-level reasoning + include fields.  Mirrors
        # agent/transports/codex.py::build_kwargs() so auxiliary callers
        # that configure reasoning via auxiliary.<task>.extra_body get the
        # same behavior as the main agent's Codex transport.
        extra_body = kwargs.get("extra_body") or {}
        if isinstance(extra_body, dict):
            reasoning_cfg = extra_body.get("reasoning")
            if isinstance(reasoning_cfg, dict):
                if reasoning_cfg.get("enabled") is False:
                    # Reasoning explicitly disabled — do not set reasoning
                    # or include.  The Codex backend still thinks by
                    # default, but we honor the caller's intent where the
                    # API allows it.
                    pass
                else:
                    # Truthy-only check mirrors agent/transports/codex.py
                    # build_kwargs(): falsy values (None, "", 0) fall back
                    # to the default rather than being forwarded to the
                    # Codex backend, which rejects e.g. {"effort": null}
                    # with a 400.
                    effort = reasoning_cfg.get("effort") or "medium"
                    # Codex backend rejects "minimal"; clamp to "low" to
                    # match the main-agent Codex transport behavior.
                    if effort == "minimal":
                        effort = "low"
                    resp_kwargs["reasoning"] = {
                        "effort": effort,
                        "summary": "auto",
                    }
                    resp_kwargs["include"] = ["reasoning.encrypted_content"]

        # Tools support for auxiliary callers that pass function schemas
        tools = kwargs.get("tools")
        if tools:
            # xAI's Responses endpoint rejects ``pattern`` and ``format`` JSON Schema
            # keywords (HTTP 400). Strip them here to match the parity guarantee that
            # chat_completion_helpers.py provides for the main-agent xAI path.
            #
            # Deep-copy before sanitizing — ``list(tools)`` is only a shallow
            # copy of the outer list, but the sanitizers mutate the inner
            # parameter dicts in place.  Without a deep copy the caller's
            # tool registry permanently loses its slash-containing enum
            # constraints after the first auxiliary xAI call.  See #27907.
            try:
                import copy as _copy
                from tools.schema_sanitizer import (
                    strip_pattern_and_format,
                    strip_slash_enum,
                )
                tools = _copy.deepcopy(list(tools))
                tools, _ = strip_pattern_and_format(tools)
                tools, _ = strip_slash_enum(tools)
            except Exception as exc:
                logger.warning(
                    "Auxiliary client: failed to sanitize tool schemas for "
                    "Codex/xAI Responses path: %s", exc,
                )
            converted = []
            for t in tools:
                fn = t.get("function", {}) if isinstance(t, dict) else {}
                name = fn.get("name")
                if not name:
                    continue
                converted.append({
                    "type": "function",
                    "name": name,
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {}),
                })
            if converted:
                resp_kwargs["tools"] = converted

        # Stream and collect the response
        text_parts: List[str] = []
        tool_calls_raw: List[Any] = []
        usage = None
        total_timeout = timeout if isinstance(timeout, (int, float)) and timeout > 0 else None
        deadline = time.monotonic() + float(total_timeout) if total_timeout else None
        timed_out = threading.Event()
        timeout_timer: Optional[threading.Timer] = None

        def _timeout_message() -> str:
            return f"Codex auxiliary Responses stream exceeded {float(total_timeout):.1f}s total timeout"

        def _close_client_on_timeout() -> None:
            timed_out.set()
            close = getattr(self._client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    logger.debug("Codex auxiliary: client close during timeout failed", exc_info=True)
            # The cached auxiliary client wraps this same ``self._client``
            # (or *is* a ``CodexAuxiliaryClient`` whose ``_real_client`` is
            # this instance).  After we close the httpx transport above, the
            # cache must drop that entry — otherwise the next auxiliary call
            # (compression retry, memory flush, etc.) reuses the dead client
            # and fails fast with a connection error.  See issue #23432.
            try:
                _evict_cached_client_instance(self._client)
            except Exception:
                logger.debug("Codex auxiliary: cache eviction on timeout failed", exc_info=True)

        def _check_cancelled() -> None:
            if deadline is not None and time.monotonic() >= deadline:
                if not timed_out.is_set():
                    _close_client_on_timeout()
                raise TimeoutError(_timeout_message())
            try:
                from tools.interrupt import is_interrupted
                if is_interrupted() and not _aux_interrupt_protected():
                    raise InterruptedError("Codex auxiliary Responses stream interrupted")
            except InterruptedError:
                raise
            except Exception:
                # Interrupt state is a best-effort UX hook; never make it a
                # new failure mode for auxiliary calls.
                pass

        try:
            if total_timeout:
                timeout_timer = threading.Timer(float(total_timeout), _close_client_on_timeout)
                timeout_timer.daemon = True
                timeout_timer.start()
            _check_cancelled()

            # Event-driven Responses streaming via the low-level
            # ``responses.create(stream=True)`` path.  The high-level
            # ``responses.stream(...)`` helper does post-hoc typed
            # reconstruction from ``response.completed.response.output``,
            # which the chatgpt.com Codex backend has been observed to
            # return as ``null`` (gpt-5.5, May 2026) — that crashes the SDK
            # with ``TypeError: 'NoneType' object is not iterable``.
            # Consuming raw events and assembling the final response
            # ourselves from ``response.output_item.done`` makes us
            # structurally immune to that drift.
            from agent.codex_runtime import _consume_codex_event_stream

            stream_kwargs = dict(resp_kwargs)
            stream_kwargs["stream"] = True

            def _on_each_event(_event: Any) -> None:
                # Re-check timeout/cancellation per event, matching the
                # cadence the old in-line ``_check_cancelled()`` used.
                _check_cancelled()

            event_stream = self._client.responses.create(**stream_kwargs)
            try:
                final = _consume_codex_event_stream(
                    event_stream,
                    model=resp_kwargs.get("model"),
                    on_event=_on_each_event,
                )
            finally:
                close_fn = getattr(event_stream, "close", None)
                if callable(close_fn):
                    try:
                        close_fn()
                    except Exception:
                        pass

            if final is None:
                raise RuntimeError("Codex auxiliary Responses stream did not return a final response")

            # Extract text and tool calls from the Responses output.
            # Items may be SimpleNamespace (raw-event path) or dicts
            # (some legacy fallback paths), so handle both shapes.
            def _item_get(obj: Any, key: str, default: Any = None) -> Any:
                val = getattr(obj, key, None)
                if val is None and isinstance(obj, dict):
                    val = obj.get(key, default)
                return val if val is not None else default

            for item in (getattr(final, "output", None) or []):
                item_type = _item_get(item, "type")
                if item_type == "message":
                    for part in (_item_get(item, "content") or []):
                        ptype = _item_get(part, "type")
                        if ptype in {"output_text", "text"}:
                            text_parts.append(_item_get(part, "text", ""))
                elif item_type == "function_call":
                    tool_calls_raw.append(SimpleNamespace(
                        id=_item_get(item, "call_id", ""),
                        type="function",
                        function=SimpleNamespace(
                            name=_item_get(item, "name", ""),
                            arguments=_item_get(item, "arguments", "{}"),
                        ),
                    ))

            resp_usage = getattr(final, "usage", None)
            if resp_usage:
                usage = SimpleNamespace(
                    prompt_tokens=getattr(resp_usage, "input_tokens", 0)
                        or (resp_usage.get("input_tokens", 0) if isinstance(resp_usage, dict) else 0),
                    completion_tokens=getattr(resp_usage, "output_tokens", 0)
                        or (resp_usage.get("output_tokens", 0) if isinstance(resp_usage, dict) else 0),
                    total_tokens=getattr(resp_usage, "total_tokens", 0)
                        or (resp_usage.get("total_tokens", 0) if isinstance(resp_usage, dict) else 0),
                )
        except Exception as exc:
            if timed_out.is_set():
                raise TimeoutError(_timeout_message()) from exc
            logger.debug("Codex auxiliary Responses API call failed: %s", exc)
            raise
        finally:
            if timeout_timer is not None:
                timeout_timer.cancel()

        content = "".join(text_parts).strip() or None

        # Build a response that looks like chat.completions
        message = SimpleNamespace(
            role="assistant",
            content=content,
            tool_calls=tool_calls_raw or None,
        )
        choice = SimpleNamespace(
            index=0,
            message=message,
            finish_reason="stop" if not tool_calls_raw else "tool_calls",
        )
        return SimpleNamespace(
            choices=[choice],
            model=model,
            usage=usage,
        )


class _CodexChatShim:
    """Wraps the adapter to provide client.chat.completions.create()."""

    def __init__(self, adapter: _CodexCompletionsAdapter):
        self.completions = adapter


class CodexAuxiliaryClient:
    """OpenAI-client-compatible wrapper that routes through Codex Responses API.

    Consumers can call client.chat.completions.create(**kwargs) as normal.
    Also exposes .api_key and .base_url for introspection by async wrappers.
    """

    def __init__(self, real_client: OpenAI, model: str):
        self._real_client = real_client
        adapter = _CodexCompletionsAdapter(real_client, model)
        self.chat = _CodexChatShim(adapter)
        self.api_key = real_client.api_key
        self.base_url = real_client.base_url

    def close(self):
        self._real_client.close()


class _AsyncCodexCompletionsAdapter:
    """Async version of the Codex Responses adapter.

    Wraps the sync adapter via asyncio.to_thread() so async consumers
    (e.g. session_search) can await it as normal.
    """

    def __init__(self, sync_adapter: _CodexCompletionsAdapter):
        self._sync = sync_adapter

    async def create(self, **kwargs) -> Any:
        import asyncio
        return await asyncio.to_thread(self._sync.create, **kwargs)


class _AsyncCodexChatShim:
    def __init__(self, adapter: _AsyncCodexCompletionsAdapter):
        self.completions = adapter


class AsyncCodexAuxiliaryClient:
    """Async-compatible wrapper matching AsyncOpenAI.chat.completions.create()."""

    def __init__(self, sync_wrapper: "CodexAuxiliaryClient"):
        sync_adapter = sync_wrapper.chat.completions
        async_adapter = _AsyncCodexCompletionsAdapter(sync_adapter)
        self.chat = _AsyncCodexChatShim(async_adapter)
        self.api_key = sync_wrapper.api_key
        self.base_url = sync_wrapper.base_url
        # Mirror the sync wrapper's _real_client so cache eviction by leaf
        # OpenAI client (e.g. _close_client_on_timeout in #23482) drops
        # this async entry too. Without this, sync and async cache entries
        # diverge on poisoning: the sync entry is evicted but the async
        # entry keeps reusing the closed transport, failing every
        # subsequent async aux call with 'Connection error' until the
        # gateway restarts.
        self._real_client = sync_wrapper._real_client




def _resolve_api_key_provider() -> Tuple[Optional[OpenAI], Optional[str]]:
    """Try each API-key provider in PROVIDER_REGISTRY order.

    Returns (client, model) for the first provider with usable runtime
    credentials, or (None, None) if none are configured.
    """
    try:
        from fan_cli.auth import PROVIDER_REGISTRY, resolve_api_key_provider_credentials
    except ImportError:
        logger.debug("Could not import PROVIDER_REGISTRY for API-key fallback")
        return None, None

    for provider_id, pconfig in PROVIDER_REGISTRY.items():
        if pconfig.auth_type != "api_key":
            continue
        if _is_provider_unhealthy(provider_id):
            logger.debug("Auxiliary api-key chain: %s is unhealthy, skipping", provider_id)
            continue

        pool_present, entry = _select_pool_entry(provider_id)
        if pool_present:
            api_key = _pool_runtime_api_key(entry)
            if not api_key:
                continue

            raw_base_url = _pool_runtime_base_url(entry, pconfig.inference_base_url) or pconfig.inference_base_url
            base_url = _to_openai_base_url(raw_base_url)
            model = _get_aux_model_for_provider(provider_id) or None
            if model is None:
                continue  # skip provider if we don't know a valid aux model
            logger.debug("Auxiliary text client: %s (%s) via pool", pconfig.name, model)
            extra = {}
            if base_url_host_matches(base_url, "integrate.api.nvidia.com"):
                extra["default_headers"] = build_nvidia_nim_headers(base_url)
            else:
                try:
                    from providers import get_provider_profile as _gpf_aux
                    _ph_aux = _gpf_aux(provider_id)
                    if _ph_aux and _ph_aux.default_headers:
                        extra["default_headers"] = dict(_ph_aux.default_headers)
                except Exception:
                    pass
            _merged_aux = _apply_user_default_headers(extra.get("default_headers"))
            if _merged_aux:
                extra["default_headers"] = _merged_aux
            _client = _create_openai_client(api_key=api_key, base_url=base_url, **extra)
            return _client, model

        creds = resolve_api_key_provider_credentials(provider_id)
        api_key = str(creds.get("api_key", "")).strip()
        if not api_key:
            continue

        raw_base_url = str(creds.get("base_url", "")).strip().rstrip("/") or pconfig.inference_base_url
        base_url = _to_openai_base_url(raw_base_url)
        model = _get_aux_model_for_provider(provider_id) or None
        if model is None:
            continue  # skip provider if we don't know a valid aux model
        logger.debug("Auxiliary text client: %s (%s)", pconfig.name, model)
        extra = {}
        if base_url_host_matches(base_url, "integrate.api.nvidia.com"):
            extra["default_headers"] = build_nvidia_nim_headers(base_url)
        else:
            try:
                from providers import get_provider_profile as _gpf_aux2
                _ph_aux2 = _gpf_aux2(provider_id)
                if _ph_aux2 and _ph_aux2.default_headers:
                    extra["default_headers"] = dict(_ph_aux2.default_headers)
            except Exception:
                pass
        _merged_aux2 = _apply_user_default_headers(extra.get("default_headers"))
        if _merged_aux2:
            extra["default_headers"] = _merged_aux2
        _client = _create_openai_client(api_key=api_key, base_url=base_url, **extra)
        return _client, model

    return None, None


# ── Provider resolution helpers ─────────────────────────────────────────────


class _RuntimeMain(NamedTuple):
    """One immutable, context-local snapshot of the active main runtime."""

    provider: str
    model: str
    base_url: str
    api_key: str
    api_mode: str


_EMPTY_RUNTIME_MAIN = _RuntimeMain("", "", "", "", "")
_runtime_main_context: "_ContextVar[_RuntimeMain]" = _ContextVar(
    "_runtime_main_context",
    default=_EMPTY_RUNTIME_MAIN,
)


def _runtime_main_snapshot() -> _RuntimeMain:
    """Return the runtime binding for the current turn/context only."""
    return _runtime_main_context.get()


def _read_main_model() -> str:
    """Read the user's configured main model from config.yaml.

    config.yaml model.default is the single source of truth for the active
    model. Environment variables are no longer consulted.

    Runtime override: when an AIAgent is active with a CLI/gateway-provided
    model that differs from config.yaml, ``set_runtime_main()`` records the
    override in a context-local snapshot. This is consulted FIRST so tools
    that gate on "the active main model" (e.g. ``vision_analyze``'s native
    fast path) see their turn's live runtime, not another session or the
    persisted config default.
    """
    override = _runtime_main_snapshot().model
    if isinstance(override, str) and override.strip():
        return override.strip()
    try:
        from fan_cli.config import load_config
        cfg = load_config()
        model_cfg = cfg.get("model", {})
        if isinstance(model_cfg, str) and model_cfg.strip():
            return model_cfg.strip()
        if isinstance(model_cfg, dict):
            default = model_cfg.get("default", "")
            if isinstance(default, str) and default.strip():
                return default.strip()
    except Exception:
        pass
    return ""


def _read_main_provider() -> str:
    """Read the user's configured main provider from config.yaml.

    Returns the lowercase provider id (e.g. "alibaba", "openrouter") or ""
    if not configured.

    Runtime override: see ``_read_main_model`` — same mechanism for the
    provider half of the runtime tuple.
    """
    override = _runtime_main_snapshot().provider
    if isinstance(override, str) and override.strip():
        return override.strip().lower()
    try:
        from fan_cli.config import load_config
        cfg = load_config()
        model_cfg = cfg.get("model", {})
        if isinstance(model_cfg, dict):
            provider = model_cfg.get("provider", "")
            if isinstance(provider, str) and provider.strip():
                return provider.strip().lower()
    except Exception:
        pass
    return ""


def _read_main_api_key() -> str:
    """Return the live/configured main key without widening its authority."""
    override = _runtime_main_snapshot().api_key
    if override:
        return override
    try:
        from fan_cli.config import load_config

        model_cfg = load_config().get("model", {})
        if isinstance(model_cfg, dict):
            value = model_cfg.get("api_key", "")
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        pass
    return ""


def _read_main_base_url() -> str:
    override = _runtime_main_snapshot().base_url
    if override:
        return override
    try:
        from fan_cli.config import load_config

        model_cfg = load_config().get("model", {})
        if isinstance(model_cfg, dict):
            value = model_cfg.get("base_url", "")
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        pass
    return ""


def _read_main_api_key_if_same_host(aux_base_url: str) -> str:
    """Reuse the main key only for an auxiliary endpoint on the same host."""
    aux_host = base_url_hostname(aux_base_url)
    main_host = base_url_hostname(_read_main_base_url())
    if not aux_host or not main_host or aux_host != main_host:
        return ""
    return _read_main_api_key()


def set_runtime_main(
    provider: str,
    model: str,
    *,
    base_url: str = "",
    api_key: str = "",
    api_mode: str = "",
) -> None:
    """Record the live runtime binding for the current AIAgent context.

    Called by ``run_agent.AIAgent._sync_runtime_main_for_aux_routing`` (or
    equivalent setter) at the top of each turn so that
    ``_read_main_provider`` / ``_read_main_model`` reflect CLI/gateway
    overrides instead of the stale config.yaml default.

    For ``custom:`` providers, ``base_url`` and ``api_key`` must also be
    recorded so that ``_resolve_auto`` can construct a valid client in
    Step 1 instead of falling through to the aggregator chain.
    """
    _runtime_main_context.set(
        _RuntimeMain(
            (provider or "").strip().lower(),
            (model or "").strip(),
            (base_url or "").strip(),
            api_key.strip() if isinstance(api_key, str) else "",
            (api_mode or "").strip(),
        )
    )


def clear_runtime_main() -> None:
    """Clear the runtime override in the current context."""
    _runtime_main_context.set(_EMPTY_RUNTIME_MAIN)


def _resolve_custom_runtime() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Resolve the active custom/main endpoint the same way the main CLI does.

    This covers both env-driven OPENAI_BASE_URL setups and config-saved custom
    endpoints where the base URL lives in config.yaml instead of the live
    environment.
    """
    try:
        from fan_cli.runtime_provider import resolve_runtime_provider

        runtime = resolve_runtime_provider(requested="custom")
    except Exception as exc:
        logger.debug("Auxiliary client: custom runtime resolution failed: %s", exc)
        runtime = None

    if not isinstance(runtime, dict):
        openai_base = os.getenv("OPENAI_BASE_URL", "").strip().rstrip("/")
        openai_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not openai_base:
            return None, None, None
        runtime = {
            "base_url": openai_base,
            "api_key": openai_key,
        }

    custom_base = runtime.get("base_url")
    custom_key = runtime.get("api_key")
    custom_mode = runtime.get("api_mode")
    if not isinstance(custom_base, str) or not custom_base.strip():
        return None, None, None

    custom_base = custom_base.strip().rstrip("/")
    if base_url_host_matches(custom_base, "openrouter.ai"):
        # requested='custom' falls back to OpenRouter when no custom endpoint is
        # configured. Treat that as "no custom endpoint" for auxiliary routing.
        return None, None, None

    # Local servers (Ollama, llama.cpp, vLLM, LM Studio) don't require auth.
    # Use a placeholder key — the OpenAI SDK requires a non-empty string but
    # local servers ignore the Authorization header.  Same fix as cli.py
    # _ensure_runtime_credentials() (PR #2556).
    if not isinstance(custom_key, str) or not custom_key.strip():
        custom_key = "no-key-required"

    if not isinstance(custom_mode, str) or not custom_mode.strip():
        custom_mode = None

    return custom_base, custom_key.strip(), custom_mode


def _current_custom_base_url() -> str:
    custom_base, _, _ = _resolve_custom_runtime()
    return custom_base or ""


def _validate_proxy_env_urls() -> None:
    """Fail fast with a clear error when proxy env vars have malformed URLs.

    Common cause: shell config (e.g. .zshrc) with a typo like
    ``export HTTP_PROXY=http://127.0.0.1:6153export NEXT_VAR=...``
    which concatenates 'export' into the port number.  Without this
    check the OpenAI/httpx client raises a cryptic ``Invalid port``
    error that doesn't name the offending env var.
    """
    from urllib.parse import urlparse

    normalize_proxy_env_vars()

    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
                "https_proxy", "http_proxy", "all_proxy"):
        value = str(os.environ.get(key) or "").strip()
        if not value:
            continue
        try:
            parsed = urlparse(value)
            if parsed.scheme:
                _ = parsed.port          # raises ValueError for e.g. '6153export'
        except ValueError as exc:
            raise RuntimeError(
                f"Malformed proxy environment variable {key}={value!r}. "
                "Fix or unset your proxy settings and try again."
            ) from exc


def _validate_base_url(base_url: str) -> None:
    """Reject obviously broken custom endpoint URLs before they reach httpx."""
    from urllib.parse import urlparse

    candidate = str(base_url or "").strip()
    if not candidate or candidate.startswith("acp://"):
        return
    try:
        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"}:
            _ = parsed.port              # raises ValueError for malformed ports
    except ValueError as exc:
        raise RuntimeError(
            f"Malformed custom endpoint URL: {candidate!r}. "
            "Run `fan setup` or `fan model` and enter a valid http(s) base URL."
        ) from exc


def _try_custom_endpoint() -> Tuple[Optional[Any], Optional[str]]:
    runtime = _resolve_custom_runtime()
    if len(runtime) == 2:
        custom_base, custom_key = runtime
        custom_mode = None
    else:
        custom_base, custom_key, custom_mode = runtime
    if not custom_base or not custom_key:
        return None, None
    if custom_base.lower().startswith(_CODEX_AUX_BASE_URL.lower()):
        return None, None
    model = _read_main_model() or "gpt-4o-mini"
    logger.debug("Auxiliary client: custom endpoint (%s, api_mode=%s)", model, custom_mode or "chat_completions")
    _clean_base, _dq = _extract_url_query_params(custom_base)
    _extra = {"default_query": _dq} if _dq else {}
    # User-configured model.default_headers override the SDK's identifying
    # headers (User-Agent: OpenAI/Python ..., X-Stainless-*) on this custom
    # endpoint's auxiliary calls too — matching the main agent client so the
    # whole session reaches a gateway/WAF that rejects the SDK fingerprint. (#40033)
    _custom_headers = _apply_user_default_headers(None)
    if _custom_headers:
        _extra["default_headers"] = _custom_headers
    if custom_mode == "codex_responses":
        real_client = _create_openai_client(
            api_key=custom_key, base_url=_clean_base, **_extra
        )
        return CodexAuxiliaryClient(real_client, model), model
    return _create_openai_client(api_key=custom_key, base_url=_clean_base, **_extra), model




_AUTO_PROVIDER_LABELS = {
    "_try_custom_endpoint": "local/custom",
    "_resolve_api_key_provider": "api-key",
}

_MAIN_RUNTIME_FIELDS = ("provider", "model", "base_url", "api_key", "api_mode", "auth_mode")


def _normalize_main_runtime(main_runtime: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Return a sanitized copy of a live main-runtime override.

    Most fields are stripped strings. ``api_key`` may legitimately be a
    zero-arg callable (Azure Foundry Entra ID token provider) — preserve
    those as-is so auxiliary clients inherit the same authentication
    surface as the main agent. The OpenAI SDK accepts ``Callable[[], str]``
    for ``api_key`` and calls it before every request.
    """
    if not isinstance(main_runtime, dict):
        return {}
    normalized: Dict[str, Any] = {}
    for field in _MAIN_RUNTIME_FIELDS:
        value = main_runtime.get(field)
        # Preserve a callable api_key (Entra ID bearer provider) unchanged.
        if field == "api_key" and callable(value) and not isinstance(value, str):
            normalized[field] = value
            continue
        if isinstance(value, str) and value.strip():
            normalized[field] = value.strip()
    provider = normalized.get("provider")
    if isinstance(provider, str):
        normalized["provider"] = provider.lower()
    return normalized


def _get_provider_chain() -> List[tuple]:
    """Return the supported auxiliary fallback chain."""
    return [
        ("local/custom", _try_custom_endpoint),
        ("api-key", _resolve_api_key_provider),
    ]


# ── Auxiliary unhealthy-provider cache ─────────────────────────────────────
#
# When an auxiliary provider returns an unrecoverable capacity or credential
# error, retrying it on every subsequent aux call is wasteful — the provider
# stays unavailable, but the chain re-tries it as the FIRST entry on every
# compression/title-gen/session-search call, burns ~1 RTT, then falls back.
#
# Solution: when ANY caller observes a payment error against a provider,
# mark it unhealthy for ``_AUX_UNHEALTHY_TTL_SECONDS``. ``_resolve_auto``
# Step-2 and ``_try_payment_fallback`` both consult this cache and skip
# unhealthy entries (logging once per skip-reason so the user sees what
# happened). Entries auto-expire so a topped-up account recovers without
# manual intervention.
#
# Failure isolation: the cache is in-process only. A second fan process won't
# inherit the unhealthy mark, so separate launches with different provider
# credentials or routing overrides remain isolated.

_AUX_UNHEALTHY_TTL_SECONDS = 600  # 10 minutes
_aux_unhealthy_until: Dict[str, float] = {}
_aux_unhealthy_logged_at: Dict[str, float] = {}

# Map provider names that show up in resolved_provider / explicit-config
# back to the chain labels used by _get_provider_chain(). Keep in sync
# with the alias map in _try_payment_fallback below.
_AUX_UNHEALTHY_LABEL_ALIASES = {
    "custom": "local/custom",
    "local/custom": "local/custom",
}


def _normalize_chain_label(provider: str) -> str:
    """Normalize a resolved_provider value to a chain label used by
    ``_get_provider_chain()``. Falls back to the lowercased input for
    direct API-key providers (alibaba, alibaba-coding-plan, etc.) which
    each report their own provider name from the api-key chain.
    """
    if not provider:
        return ""
    p = str(provider).strip().lower()
    return _AUX_UNHEALTHY_LABEL_ALIASES.get(p, p)


def _mark_provider_unhealthy(provider: str, ttl: Optional[float] = None) -> None:
    """Hide a failed auxiliary provider from fallback iteration for one TTL."""
    label = _normalize_chain_label(provider)
    if not label:
        return
    expires_at = time.time() + (ttl if ttl is not None else _AUX_UNHEALTHY_TTL_SECONDS)
    _aux_unhealthy_until[label] = expires_at
    logger.warning(
        "Auxiliary: marking %s unhealthy for %ds (capacity / credential error). "
        "Subsequent auxiliary calls will skip it until %s.",
        label,
        int(ttl if ttl is not None else _AUX_UNHEALTHY_TTL_SECONDS),
        time.strftime("%H:%M:%S", time.localtime(expires_at)),
    )


def _is_provider_unhealthy(label: str) -> bool:
    """True iff ``label`` is in the unhealthy cache and the TTL hasn't expired.
    Lazily evicts expired entries so the cache stays small.
    """
    label = _normalize_chain_label(label)
    if not label:
        return False
    expires_at = _aux_unhealthy_until.get(label)
    if expires_at is None:
        return False
    if time.time() >= expires_at:
        _aux_unhealthy_until.pop(label, None)
        _aux_unhealthy_logged_at.pop(label, None)
        return False
    return True


def _log_skip_unhealthy(label: str, task: Optional[str] = None) -> None:
    """Emit a single info-level log per minute when we skip an unhealthy
    provider. Avoids spamming the log on bursty sessions while still
    giving the user a trail.
    """
    label = _normalize_chain_label(label)
    if not label:
        return
    now = time.time()
    last = _aux_unhealthy_logged_at.get(label, 0.0)
    if now - last >= 60:
        _aux_unhealthy_logged_at[label] = now
        expires_at = _aux_unhealthy_until.get(label, now)
        logger.info(
            "Auxiliary %s: skipping %s (recent capacity or credential error, retry in %ds)",
            task or "call", label, max(0, int(expires_at - now)),
        )



def _is_payment_error(exc: Exception) -> bool:
    """Detect payment/credit/quota exhaustion errors.

    Returns True for HTTP 402 (Payment Required) and for 429/other errors
    whose message indicates billing exhaustion or daily quota exhaustion
    rather than transient rate limiting.

    Daily token quota errors (e.g. Bedrock "Too many tokens per day",
    Vertex AI "quota exceeded") are functionally equivalent to credit
    exhaustion — the provider cannot serve the request until the quota
    resets — and should trigger the same provider-fallback logic.
    """
    status = getattr(exc, "status_code", None)
    if status == 402:
        return True
    err_lower = str(exc).lower()
    # OpenRouter and other providers include "credits" or "afford" in 402 bodies,
    # but sometimes wrap them in 429 or other codes.
    # Daily quota exhaustion from Bedrock, Vertex AI, and similar providers
    # uses different language but is semantically identical to credit exhaustion.
    if status in {402, 403, 404, 429, None}:
        if any(kw in err_lower for kw in (
            "credits", "insufficient funds",
            "can only afford", "billing",
            "payment required",
            "out of funds", "run out of funds",
            "balance_depleted", "no usable credits",
            "model_not_supported_on_free_tier",
            "not available on the free tier",
            "requires a subscription", "upgrade for access",
            "upgrade for higher limits", "reached your session usage limit",
            # Daily / monthly / weekly quota exhaustion keywords
            "quota exceeded", "quota_exceeded",
            "too many tokens per day", "daily limit",
            "tokens per day", "daily quota",
            "resource exhausted",  # Vertex AI / gRPC quota errors
            "weekly usage limit", "weekly limit",  # OpenCode Go weekly subscription cap
        )):
            return True
    return False


def _is_rate_limit_error(exc: Exception) -> bool:
    """Detect rate-limit errors that warrant provider fallback.

    Returns True for HTTP 429 errors whose message indicates rate limiting
    (as opposed to billing/quota exhaustion, which _is_payment_error handles).
    Also catches OpenAI SDK RateLimitError instances that may not set
    .status_code on the exception object.
    """
    status = getattr(exc, "status_code", None)
    err_lower = str(exc).lower()

    # OpenAI SDK's RateLimitError sometimes omits .status_code —
    # detect by class name so we don't miss these.  (PR #8023 pattern)
    if type(exc).__name__ == "RateLimitError":
        return True

    if status == 429:
        # Distinguish rate-limit from billing: billing keywords are handled
        # by _is_payment_error, everything else on 429 is a rate limit.
        if any(kw in err_lower for kw in (
            "rate limit", "rate_limit", "too many requests",
            "try again", "retry after", "resets in",
        )):
            return True
        # Generic 429 without billing keywords = likely a rate limit
        if not any(kw in err_lower for kw in (
            "credits", "insufficient funds", "billing",
            "payment required", "can only afford",
            "out of funds", "run out of funds",
            "balance_depleted", "no usable credits",
            "model_not_supported_on_free_tier",
            "not available on the free tier",
        )):
            return True
    return False


def _is_timeout_error(exc: Exception) -> bool:
    """Return whether *exc* consumed a full request-timeout budget."""
    try:
        from openai import APITimeoutError

        if isinstance(exc, APITimeoutError):
            return True
    except ImportError:
        pass
    if "Timeout" in type(exc).__name__:
        return True
    return "timed out" in str(exc).lower()


def _is_connection_error(exc: Exception) -> bool:
    """Detect connection/network errors that warrant provider fallback.

    Returns True for errors indicating the provider endpoint is unreachable
    (DNS failure, connection refused, TLS errors, timeouts).  These are
    distinct from API errors (4xx/5xx) which indicate the provider IS
    reachable but returned an error.
    """
    try:
        from openai import APIConnectionError, APITimeoutError
        if isinstance(exc, (APIConnectionError, APITimeoutError)):
            return True
    except ImportError:
        pass
    # urllib3 / httpx / httpcore connection errors
    err_type = type(exc).__name__
    if any(kw in err_type for kw in ("Connection", "Timeout", "DNS", "SSL")):
        return True
    err_lower = str(exc).lower()
    if any(kw in err_lower for kw in (
        "connection refused", "name or service not known",
        "no route to host", "network is unreachable",
        "timed out", "connection reset",
        # httpcore / httpx streaming premature-close errors.  These surface
        # when a proxy or provider drops the connection mid-stream and are
        # transient by nature — the request should be retried or rerouted.
        # See issue #18458.
        "incomplete chunked read",
        "peer closed connection",
        "response ended prematurely",
        "unexpected eof",
        "remoteprotocolerror",
        "localprotocolerror",
    )):
        return True
    return False


def _is_model_incompatible_error(exc: Exception) -> bool:
    """Return True when a route authenticates but cannot serve this model."""
    status = getattr(exc, "status_code", None)
    if status not in {400, None}:
        return False
    message = str(exc).lower()
    # Billing/quota failures use the existing capacity path and must not be
    # relabelled as model capability errors merely because their provider uses
    # a 400 response.
    if any(marker in message for marker in (
        "credits", "insufficient funds", "billing", "out of funds",
        "balance_depleted", "no usable credits", "payment required",
        "free tier", "free-tier", "quota",
    )):
        return False
    return any(marker in message for marker in (
        "is not supported when using",
        "model is not supported",
        "not supported with this",
        "not supported for this account",
        "model_not_supported",
        "does not support this model",
        "unsupported model",
    ))


def _is_invalid_aux_response_error(exc: Exception) -> bool:
    """Detect authenticated provider replies that cannot serve aux callers.

    Some OpenAI-compatible routes return a successful but empty or malformed
    ChatCompletion.  Auxiliary callers require ``choices[0].message``; treat
    that shape failure as a route/model capability failure so existing
    fallbacks can keep the user-facing operation moving.
    """
    if not isinstance(exc, RuntimeError):
        return False
    message = str(exc).lower()
    return (
        "auxiliary " in message
        and "llm returned invalid response" in message
        and "choices[0].message" in message
    )


def _is_transient_transport_error(exc: Exception) -> bool:
    """Return True for a transient transport blip worth retrying on the
    same provider before any provider/model fallback.

    Covers connection/streaming-close errors (via the canonical
    ``_is_connection_error`` detector, shared so the two cannot drift) plus a
    pure 5xx/408 HTTP status. Deliberately narrow: this is the "retry the
    same target once" gate, distinct from ``_is_payment_error`` /
    ``_is_auth_error`` / ``_is_rate_limit_error`` which the except-chain
    handles by switching provider, refreshing creds, or rotating the pool.
    """
    if _is_connection_error(exc):
        return True
    status = getattr(exc, "status_code", None) or getattr(
        getattr(exc, "response", None), "status_code", None
    )
    return isinstance(status, int) and (status == 408 or 500 <= status < 600)


_DEFAULT_TRANSIENT_RETRIES = 2
_TRANSIENT_RETRY_BACKOFF_BASE = 1.0


def _transient_retry_count() -> int:
    """Return the bounded number of same-provider transient retries."""
    try:
        from fan_cli.config import cfg_get, load_config

        value = cfg_get(load_config(), "auxiliary", "transient_retries")
        if value is None:
            return _DEFAULT_TRANSIENT_RETRIES
        return max(0, min(int(value), 6))
    except Exception:
        return _DEFAULT_TRANSIENT_RETRIES


def _is_auth_error(exc: Exception) -> bool:
    """Detect auth failures that should trigger provider-specific refresh."""
    status = getattr(exc, "status_code", None)
    if status == 401:
        return True
    err_lower = str(exc).lower()
    if "error code: 401" in err_lower or "authenticationerror" in type(exc).__name__.lower():
        return True
    # xAI returns HTTP 403 with "unauthenticated:bad-credentials" when an OAuth2
    # access token has expired or is invalid — semantically a 401 auth failure,
    # even though the status code is 403 (PermissionDenied).
    if status == 403 and "bad-credentials" in err_lower:
        return True
    if "unauthenticated" in err_lower and "bad-credentials" in err_lower:
        return True
    return False


def _is_unsupported_parameter_error(exc: Exception, param: str) -> bool:
    """Detect provider 400s for an unsupported request parameter.

    Different OpenAI-compatible endpoints phrase the same class of error a few
    ways: ``Unsupported parameter: X``, ``unsupported_parameter`` with a
    ``param`` field, ``X is not supported``, ``unknown parameter: X``,
    ``unrecognized request argument: X``.  We match on both the parameter
    name and a generic "unsupported/unknown/unrecognized parameter" marker so
    call sites can reactively retry without the offending key instead of
    surfacing a noisy auxiliary failure.

    Generalizes the temperature-specific detector that originally shipped
    with PR #15621 so the same retry strategy can cover ``max_tokens``,
    ``seed``, ``top_p``, and any future quirk. Credit @nicholasrae (PR #15416)
    for the generalization pattern.
    """
    param_lower = (param or "").lower()
    if not param_lower:
        return False
    err_lower = str(exc).lower()
    if param_lower not in err_lower:
        return False
    return any(marker in err_lower for marker in (
        "unsupported parameter",
        "unsupported_parameter",
        "not supported",
        "does not support",
        "unknown parameter",
        "unrecognized request argument",
        "unrecognized parameter",
        "invalid parameter",
    ))


def _is_unsupported_temperature_error(exc: Exception) -> bool:
    """Back-compat wrapper: detect API errors where the model rejects ``temperature``.

    Delegates to :func:`_is_unsupported_parameter_error`; kept as a separate
    public symbol because existing tests and call sites import it by name.
    """
    return _is_unsupported_parameter_error(exc, "temperature")



def _evict_cached_clients(provider: str) -> None:
    """Drop cached auxiliary clients for a provider so fresh creds are used."""
    normalized = _normalize_aux_provider(provider)
    with _client_cache_lock:
        stale_keys = [
            key for key in _client_cache
            if _normalize_aux_provider(str(key[0])) == normalized
        ]
        for key in stale_keys:
            client = _client_cache.get(key, (None, None, None))[0]
            if client is not None:
                _force_close_async_httpx(client)
                try:
                    close_fn = getattr(client, "close", None)
                    if callable(close_fn):
                        close_fn()
                except Exception:
                    pass
            _client_cache.pop(key, None)


def _evict_cached_client_instance(target: Any) -> bool:
    """Drop the cache entry whose stored client is *target*.

    Used when a specific cached client has been poisoned (closed httpx
    transport after a timeout, broken streaming session, etc.) so the next
    auxiliary call rebuilds rather than reusing the dead instance.

    Walks both sync and async wrappers (``CodexAuxiliaryClient``,
    ``AsyncCodexAuxiliaryClient``, etc.) via
    their ``_real_client`` attribute so a timeout that closes the underlying
    ``OpenAI`` (or native provider) client evicts every cached shim that
    exposed it. Async wrappers must mirror their sync sibling's
    ``_real_client`` for this to work — otherwise the sync entry is evicted
    but the async entry survives and keeps reusing the dead transport.

    Returns True when at least one entry was evicted.
    """
    if target is None:
        return False
    evicted = False
    with _client_cache_lock:
        for key in list(_client_cache.keys()):
            entry = _client_cache.get(key)
            if entry is None:
                continue
            cached = entry[0]
            if cached is None:
                continue
            real = getattr(cached, "_real_client", None)
            if cached is target or real is target:
                del _client_cache[key]
                evicted = True
    return evicted


def _pool_cache_hint(
    provider: str,
    *,
    main_runtime: Optional[Dict[str, Any]] = None,
) -> str:
    """Return a stable cache discriminator for pooled providers."""
    normalized = _normalize_aux_provider(provider)
    if normalized == "auto":
        runtime = _normalize_main_runtime(main_runtime)
        normalized = _normalize_aux_provider(runtime.get("provider") or _read_main_provider())
    if normalized in {"", "auto", "custom"}:
        return ""
    entry = _peek_pool_entry(normalized)
    if entry is None:
        return ""
    entry_id = str(getattr(entry, "id", "") or "").strip()
    if not entry_id:
        return ""
    return f"{normalized}:{entry_id}"


def _pool_error_context(exc: Exception) -> Dict[str, Any]:
    status = getattr(exc, "status_code", None)
    payload: Dict[str, Any] = {"message": str(exc)}
    if status is not None:
        payload["status_code"] = status
    return payload


def _recoverable_pool_provider(
    resolved_provider: str,
    client: Any,
    main_runtime: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Infer which provider pool can recover the current auxiliary client."""
    normalized = _normalize_aux_provider(resolved_provider)
    if normalized not in {"", "auto", "custom"}:
        return normalized
    base = str(getattr(client, "base_url", "") or "")
    if base_url_host_matches(base, "chatgpt.com"):
        return "openai-codex"
    if base_url_host_matches(base, "openrouter.ai"):
        return "openrouter"
    if base_url_host_matches(base, "api.githubcopilot.com"):
        return "copilot"
    if base_url_host_matches(base, "api.kimi.com"):
        return "kimi-coding"
    if base_url_host_matches(base, "api.x.ai"):
        return "xai-oauth"
    # For api_key providers not in the hardcoded list (e.g. opencode-go), match
    # the client base URL against all registered api_key providers so that
    # credential-pool rotation works for any provider the user configured.
    if main_runtime:
        rt = _normalize_main_runtime(main_runtime)
        rt_provider = rt.get("provider", "")
        if rt_provider and rt_provider not in {"", "auto", "custom"}:
            try:
                from fan_cli.auth import PROVIDER_REGISTRY
                pconfig = PROVIDER_REGISTRY.get(rt_provider)
                if pconfig and getattr(pconfig, "auth_type", None) == "api_key":
                    rt_base = str(getattr(pconfig, "inference_base_url", "") or "").rstrip("/")
                    if rt_base and base_url_host_matches(base, base_url_hostname(rt_base)):
                        return rt_provider
            except Exception:
                pass
    return None


def _recover_provider_pool(provider: str, exc: Exception, *, failed_api_key: str = "") -> bool:
    """Try same-provider credential-pool recovery for auxiliary calls.

    ``failed_api_key`` is the API key that was actually used for the failing
    request.  Passing it lets mark_exhausted_and_rotate identify the correct
    pool entry even when another process has already rotated the pool (which
    would leave current() as None, causing the wrong entry to be marked).
    """
    normalized = _normalize_aux_provider(provider)
    try:
        pool = load_pool(normalized)
    except Exception as load_exc:
        logger.debug("Auxiliary client: could not load pool for %s recovery: %s", normalized, load_exc)
        return False
    if not pool or not pool.has_credentials():
        return False

    status_code = getattr(exc, "status_code", None)
    error_context = _pool_error_context(exc)
    hint = failed_api_key or None

    if _is_auth_error(exc):
        refreshed = pool.try_refresh_current()
        if refreshed is not None:
            _evict_cached_clients(normalized)
            return True
        next_entry = pool.mark_exhausted_and_rotate(
            status_code=status_code if status_code is not None else 401,
            error_context=error_context,
            api_key_hint=hint,
        )
        if next_entry is not None:
            _evict_cached_clients(normalized)
            return True
        return False

    if _is_payment_error(exc) or _is_rate_limit_error(exc):
        fallback_status = 402 if _is_payment_error(exc) else 429
        next_entry = pool.mark_exhausted_and_rotate(
            status_code=status_code if status_code is not None else fallback_status,
            error_context=error_context,
            api_key_hint=hint,
        )
        if next_entry is not None:
            _evict_cached_clients(normalized)
            return True
    return False


def _retry_same_provider_sync(
    *,
    task: Optional[str],
    resolved_provider: str,
    resolved_model: Optional[str],
    resolved_base_url: Optional[str],
    resolved_api_key: Optional[str],
    resolved_api_mode: Optional[str],
    main_runtime: Optional[Dict[str, Any]],
    final_model: Optional[str],
    messages: list,
    temperature: Optional[float],
    max_tokens: Optional[int],
    tools: Optional[list],
    effective_timeout: float,
    effective_extra_body: dict,
) -> Any:
    if task == "vision":
        _, retry_client, retry_model = resolve_vision_provider_client(
            provider=resolved_provider,
            model=final_model,
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            async_mode=False,
        )
    else:
        retry_client, retry_model = _get_cached_client(
            resolved_provider,
            resolved_model,
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            api_mode=resolved_api_mode,
            main_runtime=main_runtime,
        )
    if retry_client is None:
        raise RuntimeError(
            f"Auxiliary {task or 'call'}: provider {resolved_provider} could not be rebuilt after recovery"
        )

    retry_base = str(getattr(retry_client, "base_url", "") or "")
    retry_kwargs = _build_call_kwargs(
        resolved_provider,
        retry_model or final_model,
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        tools=tools,
        timeout=effective_timeout,
        extra_body=effective_extra_body,
        base_url=retry_base or resolved_base_url,
    )
    return _validate_llm_response(
        retry_client.chat.completions.create(**retry_kwargs), task,
    )


async def _retry_same_provider_async(
    *,
    task: Optional[str],
    resolved_provider: str,
    resolved_model: Optional[str],
    resolved_base_url: Optional[str],
    resolved_api_key: Optional[str],
    resolved_api_mode: Optional[str],
    final_model: Optional[str],
    messages: list,
    temperature: Optional[float],
    max_tokens: Optional[int],
    tools: Optional[list],
    effective_timeout: float,
    effective_extra_body: dict,
) -> Any:
    if task == "vision":
        _, retry_client, retry_model = resolve_vision_provider_client(
            provider=resolved_provider,
            model=final_model,
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            async_mode=True,
        )
    else:
        retry_client, retry_model = _get_cached_client(
            resolved_provider,
            resolved_model,
            async_mode=True,
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            api_mode=resolved_api_mode,
        )
    if retry_client is None:
        raise RuntimeError(
            f"Auxiliary {task or 'call'}: provider {resolved_provider} could not be rebuilt after recovery"
        )

    retry_base = str(getattr(retry_client, "base_url", "") or "")
    retry_kwargs = _build_call_kwargs(
        resolved_provider,
        retry_model or final_model,
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        tools=tools,
        timeout=effective_timeout,
        extra_body=effective_extra_body,
        base_url=retry_base or resolved_base_url,
    )
    return _validate_llm_response(
        await retry_client.chat.completions.create(**retry_kwargs), task,
    )


def _refresh_provider_credentials(provider: str) -> bool:
    """Return False: configured auxiliary providers use static API keys."""
    return False


def _try_payment_fallback(
    failed_provider: str,
    task: str = None,
    reason: str = "payment error",
) -> Tuple[Optional[Any], Optional[str], str]:
    """Try alternative providers after a payment/credit or connection error.

    Iterates the standard auto-detection chain, skipping the provider that
    failed.

    Returns:
        (client, model, provider_label) or (None, None, "") if no fallback.
    """
    # Normalise the failed provider label for matching.
    skip = failed_provider.lower().strip()
    # Also skip Step-1 main-provider path if it maps to the same backend.
    # (e.g. main_provider="openrouter" → skip "openrouter" in chain)
    main_provider = _read_main_provider()
    skip_labels = {skip}
    if main_provider and main_provider.lower() in skip:
        skip_labels.add(main_provider.lower())
    # Map common resolved_provider values back to chain labels.
    _alias_to_label = {"openrouter": "openrouter",
                       "openai-codex": "openai-codex", "codex": "openai-codex",
                       "custom": "local/custom", "local/custom": "local/custom"}
    skip_chain_labels = {_alias_to_label.get(s, s) for s in skip_labels}

    tried = []
    for label, try_fn in _get_provider_chain():
        if label in skip_chain_labels:
            continue
        if _is_provider_unhealthy(label):
            _log_skip_unhealthy(label, task)
            tried.append(f"{label} (unhealthy)")
            continue
        client, model = try_fn()
        if client is not None:
            if _fallback_context_is_too_small(
                task,
                label,
                model,
                base_url=str(getattr(client, "base_url", "") or ""),
                api_key=getattr(client, "api_key", ""),
            ):
                tried.append(f"{label} (context too small)")
                continue
            logger.info(
                "Auxiliary %s: %s on %s — falling back to %s (%s)",
                task or "call", reason, failed_provider, label, model or "default",
            )
            return client, model, label
        tried.append(label)

    logger.warning(
        "Auxiliary %s: %s on %s and no fallback available (tried: %s)",
        task or "call", reason, failed_provider, ", ".join(tried),
    )
    return None, None, ""


def _try_main_agent_model_fallback(
    failed_provider: str,
    task: str = None,
    reason: str = "error",
) -> Tuple[Optional[Any], Optional[str], str]:
    """Last-resort fallback to the user's main agent provider + model.

    Used after the configured fallback_chain is exhausted (or empty) for
    users with an explicit auxiliary provider.  This is the "safety net"
    layer: if nothing the user asked for can serve the request, try the
    main chat model before giving up.

    Skips when the failed provider already IS the main provider (no point
    retrying the same backend that just failed).

    Returns:
        (client, model, provider_label) or (None, None, "") if no fallback.
    """
    main_provider = (_read_main_provider() or "").strip()
    main_model = (_read_main_model() or "").strip()
    if not main_provider or not main_model or main_provider.lower() in {"auto", ""}:
        return None, None, ""

    skip = (failed_provider or "").lower().strip()
    if main_provider.lower() == skip:
        # The thing that failed IS the main model — nothing to fall back to.
        return None, None, ""
    if _is_provider_unhealthy(main_provider):
        _log_skip_unhealthy(main_provider, task)
        return None, None, ""

    try:
        client, resolved_model = resolve_provider_client(
            provider=main_provider, model=main_model,
        )
    except Exception:
        client, resolved_model = None, None

    if client is None:
        return None, None, ""

    label = f"main-agent({main_provider})"
    logger.info(
        "Auxiliary %s: %s on %s — falling back to main agent model %s (%s)",
        task or "call", reason, failed_provider, label, resolved_model or main_model,
    )
    return client, resolved_model or main_model, label


def _task_minimum_context_length(task: Optional[str]) -> Optional[int]:
    """Return the context floor required by a side task, if any."""
    if task != "compression":
        return None
    from agent.model_metadata import MINIMUM_CONTEXT_LENGTH

    return MINIMUM_CONTEXT_LENGTH


def _fallback_context_is_too_small(
    task: Optional[str],
    provider: str,
    model: Optional[str],
    *,
    base_url: str = "",
    api_key: Any = "",
) -> bool:
    """Return whether a known fallback cannot run the compression payload.

    Unknown/custom context windows remain eligible.  A fallback is useful only
    if it can actually receive the task; selecting a known sub-64K model for a
    compression handoff merely converts a recoverable provider failure into a
    later context-length error.
    """
    minimum = _task_minimum_context_length(task)
    if minimum is None or not model:
        return False
    try:
        from agent.model_metadata import get_model_context_length

        key = "" if callable(api_key) and not isinstance(api_key, str) else str(api_key or "")
        context_length = get_model_context_length(
            model,
            base_url=base_url,
            api_key=key,
            provider=provider,
        )
    except Exception as exc:  # Best effort: unknown models must remain usable.
        logger.debug(
            "Auxiliary %s: could not resolve fallback context for %s/%s: %s",
            task,
            provider,
            model,
            exc,
        )
        return False
    if isinstance(context_length, int) and context_length > 0 and context_length < minimum:
        logger.info(
            "Auxiliary %s: skipping %s/%s (context=%d < required=%d)",
            task,
            provider,
            model,
            context_length,
            minimum,
        )
        return True
    return False


def _try_configured_fallback_chain(
    task: str,
    failed_provider: str,
    reason: str = "error",
) -> Tuple[Optional[Any], Optional[str], str]:
    """Try user-configured fallback_chain for a specific auxiliary task.

    Reads auxiliary.<task>.fallback_chain from config.yaml and tries each
    entry in order.  Each entry must have at least ``provider``; ``model``,
    ``base_url``, and ``api_key`` are optional.

    Returns:
        (client, model, provider_label) or (None, None, "") if no fallback.
    """
    if not task:
        return None, None, ""

    task_config = _get_auxiliary_task_config(task)
    chain = task_config.get("fallback_chain")
    if not chain or not isinstance(chain, list):
        return None, None, ""

    skip = failed_provider.lower().strip()
    tried = []

    for i, entry in enumerate(chain):
        if not isinstance(entry, dict):
            continue
        fb_provider = str(entry.get("provider", "")).strip()
        if not fb_provider or fb_provider.lower() == skip:
            continue
        fb_model = str(entry.get("model", "")).strip() or None
        fb_base_url = str(entry.get("base_url", "")).strip() or None
        fb_api_key = str(entry.get("api_key", "")).strip() or None

        label = f"fallback_chain[{i}]({fb_provider})"
        if _is_provider_unhealthy(fb_provider):
            _log_skip_unhealthy(fb_provider, task)
            tried.append(f"{label} (unhealthy)")
            continue

        try:
            fb_client = _resolve_single_provider(
                fb_provider, fb_model, fb_base_url, fb_api_key)
        except Exception:
            fb_client = None

        if fb_client is not None:
            if _fallback_context_is_too_small(
                task,
                fb_provider,
                fb_model,
                base_url=fb_base_url or str(getattr(fb_client, "base_url", "") or ""),
                api_key=fb_api_key or "",
            ):
                tried.append(f"{label} (context too small)")
                continue
            logger.info(
                "Auxiliary %s: %s on %s — configured fallback to %s (%s)",
                task, reason, failed_provider, label, fb_model or "default",
            )
            return fb_client, fb_model, label
        tried.append(label)

    if tried:
        logger.debug(
            "Auxiliary %s: configured fallback_chain exhausted (tried: %s)",
            task, ", ".join(tried),
        )
    return None, None, ""


def _try_configured_fallback_for_unavailable_client(
    task: Optional[str],
    failed_provider: str,
) -> Tuple[Optional[Any], Optional[str], str]:
    """Try a per-task fallback before failing an explicit aux provider.

    This is the no-client counterpart to request-time fallback: a missing key
    or an unavailable credential pool should not prevent compression from
    using an explicitly configured alternate route.
    """
    explicit = (failed_provider or "").strip().lower()
    if not task or not explicit or explicit == "auto":
        return None, None, ""
    return _try_configured_fallback_chain(task, explicit, reason="provider unavailable")


def _fallback_candidate_provider(label: str, client: Any) -> str:
    """Return the chain key to quarantine after a fallback candidate 401s.

    Configured candidates are labelled for diagnostics (for example,
    ``fallback_chain[1](custom)``), while the auto chain uses its own stable
    keys (``local/custom`` and ``api-key``).  Normalize both forms so a stale
    candidate is skipped when the chain is walked again.
    """
    text = str(label or "").strip()
    if "(" in text and text.endswith(")"):
        candidate = text.rsplit("(", 1)[-1][:-1].strip()
        if candidate:
            return _normalize_chain_label(candidate)
    normalized = _normalize_chain_label(text)
    if normalized:
        return normalized
    return _recoverable_pool_provider("auto", client) or ""


def _call_fallback_candidate_sync(
    fb_client: Any,
    fb_model: Optional[str],
    fb_label: str,
    *,
    task: Optional[str],
    messages: list,
    temperature: Optional[float],
    max_tokens: Optional[int],
    tools: Optional[list],
    effective_timeout: float,
    effective_extra_body: dict,
) -> Optional[Any]:
    """Run one auxiliary fallback without letting its stale key abort recovery.

    Fan's retained auxiliary routes use static API keys, so an auth failure
    cannot be refreshed in place.  Quarantine that candidate and return
    ``None`` so the caller can continue to the next configured or automatic
    fallback rather than abandoning a compression/recovery task.
    """
    fb_base = str(getattr(fb_client, "base_url", "") or "")
    fb_kwargs = _build_call_kwargs(
        fb_label,
        fb_model,
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        tools=tools,
        timeout=effective_timeout,
        extra_body=effective_extra_body,
        base_url=fb_base,
    )
    try:
        return _validate_llm_response(
            fb_client.chat.completions.create(**fb_kwargs), task
        )
    except Exception as fallback_error:
        if not _is_auth_error(fallback_error):
            raise
        candidate = _fallback_candidate_provider(fb_label, fb_client)
        _mark_provider_unhealthy(candidate)
        logger.warning(
            "Auxiliary %s: fallback candidate %s has an unrefreshable "
            "credential; trying the next candidate",
            task or "call",
            fb_label,
        )
        return None


async def _call_fallback_candidate_async(
    fb_client: Any,
    fb_model: Optional[str],
    fb_label: str,
    *,
    task: Optional[str],
    messages: list,
    temperature: Optional[float],
    max_tokens: Optional[int],
    tools: Optional[list],
    effective_timeout: float,
    effective_extra_body: dict,
) -> Optional[Any]:
    """Async counterpart of :func:`_call_fallback_candidate_sync`."""
    fb_base = str(getattr(fb_client, "base_url", "") or "")
    fb_kwargs = _build_call_kwargs(
        fb_label,
        fb_model,
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        tools=tools,
        timeout=effective_timeout,
        extra_body=effective_extra_body,
        base_url=fb_base,
    )
    try:
        return _validate_llm_response(
            await fb_client.chat.completions.create(**fb_kwargs), task
        )
    except Exception as fallback_error:
        if not _is_auth_error(fallback_error):
            raise
        candidate = _fallback_candidate_provider(fb_label, fb_client)
        _mark_provider_unhealthy(candidate)
        logger.warning(
            "Auxiliary %s (async): fallback candidate %s has an "
            "unrefreshable credential; trying the next candidate",
            task or "call",
            fb_label,
        )
        return None


def _resolve_single_provider(
    provider: str,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[Any]:
    """Resolve a single provider entry from fallback_chain to an OpenAI client.

    Uses the existing provider resolution infrastructure where possible.
    """
    # Reuse resolve_provider_client which handles provider→client mapping
    client, resolved_model = resolve_provider_client(
        provider=provider,
        model=model,
        base_url=base_url,
        api_key=api_key,
    )
    return client

def _resolve_auto(main_runtime: Optional[Dict[str, Any]] = None) -> Tuple[Optional[OpenAI], Optional[str]]:
    """Full auto-detection chain.

    Priority:
      1. User's main provider + main model, regardless of provider type.
         This means auxiliary tasks (compression, vision, web extraction,
         session search, etc.) use the same model the user configured for
         chat. Users on any configured API-key or custom provider get their
         chosen chat model. Running aux tasks on the
         user's picked model keeps behavior predictable — no surprise
         switches to a cheap fallback model for side tasks.
      2. Custom endpoint → API-key providers (fallback chain, only used when
         the main provider has no working client).
    """
    global _stale_base_url_warned
    runtime = _normalize_main_runtime(main_runtime)
    runtime_provider = runtime.get("provider", "")
    runtime_model = str(runtime.get("model") or "")
    runtime_base_url = str(runtime.get("base_url") or "")
    runtime_api_key = runtime.get("api_key", "")
    runtime_api_mode = str(runtime.get("api_mode") or "")

    # Fall back to the current turn's context-local runtime when main_runtime
    # was not provided or was incomplete. Keeping the five values in one
    # immutable snapshot prevents another gateway session from mixing its
    # provider/model/credentials into this turn.
    active_runtime = _runtime_main_snapshot()
    if not runtime_base_url and active_runtime.base_url:
        runtime_base_url = active_runtime.base_url
    if not runtime_api_key and active_runtime.api_key:
        runtime_api_key = active_runtime.api_key
    if not runtime_api_mode and active_runtime.api_mode:
        runtime_api_mode = active_runtime.api_mode

    # ── Warn once if OPENAI_BASE_URL is set but config.yaml uses a named
    #    provider (not 'custom').  This catches the common "env poisoning"
    #    scenario where a user switches providers via `fan model` but the
    #    old OPENAI_BASE_URL lingers in ~/.fan/.env. ──
    if not _stale_base_url_warned:
        _env_base = os.getenv("OPENAI_BASE_URL", "").strip()
        _cfg_provider = runtime_provider or _read_main_provider()
        if (_env_base and _cfg_provider
                and _cfg_provider != "custom"
                and not _cfg_provider.startswith("custom:")):
            logger.warning(
                "OPENAI_BASE_URL is set (%s) but model.provider is '%s'. "
                "Auxiliary clients may route to the wrong endpoint. "
                "Run: fan model to reconfigure, or remove "
                "OPENAI_BASE_URL from ~/.fan/.env",
                _env_base, _cfg_provider,
            )
            _stale_base_url_warned = True

    # ── Step 1: main provider + main model → use them directly ──
    #
    # This is the primary aux backend for every user.  "auto" means
    # "use my main chat model for side tasks as well" — including users
    # on aggregators who previously got routed to a cheap provider-side
    # default. Explicit per-task overrides set via
    # config.yaml (auxiliary.<task>.provider) still win over this.
    main_provider = str(runtime_provider or _read_main_provider() or "")
    main_model = str(runtime_model or _read_main_model() or "")
    if (main_provider and main_model
            and main_provider not in {"auto", ""}):
        resolved_provider = main_provider
        explicit_base_url = runtime_base_url or None
        explicit_api_key = None
        if runtime_base_url and (main_provider == "custom" or main_provider.startswith("custom:")):
            resolved_provider = "custom"
            explicit_base_url = runtime_base_url
            explicit_api_key = runtime_api_key or None
        elif runtime_api_key:
            # Pin auxiliary to the same api_key as the active main chat session
            # so that a working key is reused instead of re-selecting from the pool
            # (which might pick a different, potentially exhausted key).
            explicit_api_key = runtime_api_key
        # Skip Step-1 if the main provider was recently 402'd. The unhealthy
        # cache TTL bounds how long we bypass it, so a topped-up account
        # recovers automatically. If we tried Step-1 anyway, every aux call
        # on a depleted main provider would pay one doomed 402 RTT before
        # falling to Step-2.
        main_chain_label = _normalize_chain_label(resolved_provider)
        if main_chain_label and _is_provider_unhealthy(main_chain_label):
            _log_skip_unhealthy(main_chain_label)
        else:
            client, resolved = resolve_provider_client(
                resolved_provider,
                main_model,
                explicit_base_url=explicit_base_url,
                explicit_api_key=explicit_api_key,
                api_mode=runtime_api_mode or None,
            )
            if client is not None:
                logger.info("Auxiliary auto-detect: using main provider %s (%s)",
                            main_provider, resolved or main_model)
                return client, resolved or main_model

    # ── Step 2: aggregator / fallback chain ──────────────────────────────
    tried = []
    for label, try_fn in _get_provider_chain():
        if _is_provider_unhealthy(label):
            _log_skip_unhealthy(label)
            tried.append(f"{label} (unhealthy)")
            continue
        client, model = try_fn()
        if client is not None:
            if tried:
                logger.info("Auxiliary auto-detect: using %s (%s) — skipped: %s",
                            label, model or "default", ", ".join(tried))
            else:
                logger.info("Auxiliary auto-detect: using %s (%s)", label, model or "default")
            return client, model
        tried.append(label)
    logger.warning("Auxiliary auto-detect: no provider available (tried: %s). "
                   "Compression, summarization, and memory flush will not work. "
                   "Set OPENROUTER_API_KEY or configure a local model in config.yaml.",
                   ", ".join(tried))
    return None, None


# ── Centralized Provider Router ─────────────────────────────────────────────
#
# resolve_provider_client() is the single entry point for creating a properly
# configured client given a (provider, model) pair.  It handles auth lookup,
# base URL resolution, provider-specific headers, and API format differences
# (Chat Completions vs Responses API for Codex).
#
# All auxiliary consumer code should go through this or the public helpers
# below — never look up auth env vars ad-hoc.


# 本次异步调用内新建的 AsyncOpenAI 客户端登记簿(ContextVar,随 await 链传播)。
# _to_async_client 每次都新建 AsyncOpenAI(异步 httpx 客户端绑定其首次运行的事件循环,
# 不能跨 asyncio.run 的循环缓存),但过去从不关闭——循环结束后 GC 在【别的】循环上调度
# aclose(),对着已关闭循环的传输层抛 "RuntimeError: Event loop is closed"(真机噪声,
# find_visual 每次视觉调用后必现)。所有权规则:创建处登记,调用边界(async_call_llm)
# 在同一循环内统一 close——根除泄漏,而非压制 __del__。
_owned_async_clients: "_ContextVar[list | None]" = _ContextVar("_owned_async_clients", default=None)


def _to_async_client(sync_client, model: str, is_vision: bool = False):
    """Convert a sync client to its async counterpart, preserving Codex routing.

    When ``is_vision=True`` and the underlying base URL is Copilot, the
    resulting async client carries the ``Copilot-Vision-Request: true``
    header so the request is routed to Copilot's vision-capable
    infrastructure (otherwise vision payloads silently time out).
    """
    from openai import AsyncOpenAI

    if isinstance(sync_client, CodexAuxiliaryClient):
        return AsyncCodexAuxiliaryClient(sync_client), model
    try:
        from agent.copilot_acp_client import CopilotACPClient
        if isinstance(sync_client, CopilotACPClient):
            return sync_client, model
    except ImportError:
        pass

    async_kwargs = {
        "api_key": sync_client.api_key,
        "base_url": str(sync_client.base_url),
    }
    sync_base_url = str(sync_client.base_url)
    if base_url_host_matches(sync_base_url, "openrouter.ai"):
        async_kwargs["default_headers"] = build_or_headers()
    elif base_url_host_matches(sync_base_url, "integrate.api.nvidia.com"):
        async_kwargs["default_headers"] = build_nvidia_nim_headers(sync_base_url)
    else:
        # Fall back to profile.default_headers for providers that declare
        # client-level headers on their ProviderProfile (e.g. attribution
        # User-Agent strings). Provider is inferred from the hostname.
        try:
            from agent.model_metadata import _infer_provider_from_url
            from providers import get_provider_profile as _gpf_async
            _inferred = _infer_provider_from_url(sync_base_url)
            if _inferred:
                _ph_async = _gpf_async(_inferred)
                if _ph_async and _ph_async.default_headers:
                    async_kwargs["default_headers"] = dict(_ph_async.default_headers)
        except Exception:
            pass
    _merged_async = _apply_user_default_headers(async_kwargs.get("default_headers"))
    if _merged_async:
        async_kwargs["default_headers"] = _merged_async
    async_kwargs = {
        **_openai_http_client_kwargs(sync_base_url, async_mode=True),
        **async_kwargs,
    }
    async_kwargs.setdefault("max_retries", 0)
    client = AsyncOpenAI(**async_kwargs)
    bucket = _owned_async_clients.get()
    if bucket is not None:
        bucket.append(client)  # 登记:调用边界(async_call_llm)负责在同一循环内 close
    return client, model


def _normalize_resolved_model(model_name: Optional[str], provider: str) -> Optional[str]:
    """Normalize a resolved model for the provider that will receive it."""
    if not model_name:
        return model_name
    try:
        from fan_cli.model_normalize import normalize_model_for_provider

        return normalize_model_for_provider(model_name, provider)
    except Exception:
        return model_name


def resolve_provider_client(
    provider: str,
    model: str = None,
    async_mode: bool = False,
    raw_codex: bool = False,
    explicit_base_url: str = None,
    explicit_api_key: str = None,
    api_mode: str = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    is_vision: bool = False,
) -> Tuple[Optional[Any], Optional[str]]:
    """Central router: given a provider name and optional model, return a
    configured client with the correct auth, base URL, and API format.

    The returned client always exposes ``.chat.completions.create()`` — for
    Codex/Responses API providers, an adapter handles the translation
    transparently.

    Args:
        provider: Provider identifier.  One of:
            "deepseek", "alibaba", "alibaba-coding-plan", "ollama-cloud",
            "custom" (OPENAI_BASE_URL + OPENAI_API_KEY),
            "auto" (full auto-detection chain).
        model: Model slug override.  If None, uses the provider's default
               auxiliary model.
        async_mode: If True, return an async-compatible client.
        raw_codex: If True, return a raw OpenAI client for Codex providers
            instead of wrapping in CodexAuxiliaryClient.  Use this when
            the caller needs direct access to responses.stream() (e.g.,
            the main agent loop).
        explicit_base_url: Optional direct OpenAI-compatible endpoint.
        explicit_api_key: Optional API key paired with explicit_base_url.
        api_mode: API mode override.  One of "chat_completions",
            "codex_responses", or None (auto-detect).  When set to
            "codex_responses", the client is wrapped in
            CodexAuxiliaryClient to route through the Responses API.

    Returns:
        (client, resolved_model) or (None, None) if auth is unavailable.
    """
    _validate_proxy_env_urls()
    # Preserve the original provider name before alias normalization so a
    # user-declared ``custom_providers`` entry whose name coincidentally
    # matches a built-in alias (e.g. user names their custom provider "kimi"
    # which aliases to "kimi-coding") is still reachable via the named-custom
    # branch below.
    original_provider = (provider or "").strip().lower()
    # Normalise aliases
    provider = _normalize_aux_provider(provider)

    # Universal model-resolution fallback chain.  Callers (notably title
    # generation, vision, session search, and other auxiliary tasks) can
    # reach this function without an explicit model — the user picked their
    # main provider, didn't bother configuring a per-task ``auxiliary.<task>.model``,
    # and just expects "use my main model for side tasks too."  Resolve in
    # this order, stopping at the first non-empty answer:
    #
    #   1. ``model`` argument (caller knew what they wanted)
    #   2. Provider's catalog default — cheap/fast model the provider
    #      registered via ``ProviderProfile.default_aux_model`` or the
    #      legacy ``_API_KEY_PROVIDER_AUX_MODELS_FALLBACK`` dict.  Empty
    #      string for OAuth-gated providers (openai-codex, xai-oauth)
    #      whose accepted-model lists drift on the backend, so we don't
    #      pin a default that can silently rot.
    #   3. User's main model from ``model.model`` in config.yaml.  This is
    #      the load-bearing step for OAuth providers: an xai-oauth user
    #      with grok-4.3 configured gets grok-4.3 for title generation
    #      instead of silently dropping to whatever Step-2 fallback (#31845).
    #
    # Each provider branch below sees a non-empty ``model`` whenever the
    # user has *anything* configured — no provider-specific empty-model
    # guards needed.  When the user has NOTHING configured (fresh install,
    # main_model also empty), the branches still hit their own
    # missing-credentials returns and ``_resolve_auto`` falls through to
    # the Step-2 chain as before.
    if not model:
        model = _get_aux_model_for_provider(provider) or _read_main_model() or model

    supported_provider_ids = {
        "auto", "custom", "deepseek", "alibaba", "alibaba-coding-plan",
        "ollama-cloud",
    }
    if provider not in supported_provider_ids:
        custom_entry = None
        try:
            from fan_cli.runtime_provider import _get_named_custom_provider

            if original_provider and original_provider != provider:
                custom_entry = _get_named_custom_provider(original_provider)
            if custom_entry is None:
                custom_entry = _get_named_custom_provider(provider)
        except Exception:
            custom_entry = None
        if custom_entry is None:
            logger.warning(
                "resolve_provider_client: provider %r is not supported by this Fan build",
                provider,
            )
            return None, None

    def _needs_codex_wrap(client_obj, base_url_str: str, model_str: str) -> bool:
        """Decide if a plain OpenAI client should be wrapped for Responses API.

        Returns True when api_mode is explicitly "codex_responses", or when
        auto-detection (api.openai.com + codex-family model) suggests it.
        Already-wrapped clients (CodexAuxiliaryClient) are skipped.
        """
        if isinstance(client_obj, CodexAuxiliaryClient):
            return False
        if raw_codex:
            return False
        if api_mode == "codex_responses":
            return True
        # Auto-detect: api.openai.com + codex model name pattern
        if api_mode and api_mode != "codex_responses":
            return False  # explicit non-codex mode
        if base_url_hostname(base_url_str) == "api.openai.com":
            model_lower = (model_str or "").lower()
            if "codex" in model_lower:
                return True
        return False

    def _wrap_if_needed(client_obj, final_model_str: str, base_url_str: str = "",
                        api_key_str: str = ""):
        """Wrap a plain OpenAI client in the correct transport adapter.

        Wraps in ``CodexAuxiliaryClient`` when the endpoint needs the Responses
        API (explicit ``api_mode=codex_responses`` or api.openai.com + codex
        model name).  Clients that are already specialized wrappers pass through
        unchanged.
        """
        if _needs_codex_wrap(client_obj, base_url_str, final_model_str):
            logger.debug(
                "resolve_provider_client: wrapping client in CodexAuxiliaryClient "
                "(api_mode=%s, model=%s, base_url=%s)",
                api_mode or "auto-detected", final_model_str,
                base_url_str[:60] if base_url_str else "")
            return CodexAuxiliaryClient(client_obj, final_model_str)
        return client_obj

    # ── Auto: try all providers in priority order ────────────────────
    if provider == "auto":
        client, resolved = _resolve_auto(main_runtime=main_runtime)
        if client is None:
            return None, None
        # When auto-detection lands on a non-OpenRouter provider (e.g. a
        # local server), an OpenRouter-formatted model override like
        # "google/gemini-3-flash-preview" won't work.  Drop it and use
        # the provider's own default model instead.
        if model and "/" in model and resolved and "/" not in resolved:
            logger.debug(
                "Dropping OpenRouter-format model %r for non-OpenRouter "
                "auxiliary provider (using %r instead)", model, resolved)
            model = None
        final_model = model or resolved
        return (_to_async_client(client, final_model, is_vision=is_vision) if async_mode
                else (client, final_model))

    # ── OpenRouter ───────────────────────────────────────────
    # ── OpenAI Codex (OAuth → Responses API) ─────────────────────────
    # ── xAI Grok OAuth (loopback PKCE → Responses API) ───────────────
    # Custom endpoint (OPENAI_BASE_URL + OPENAI_API_KEY).
    if provider == "custom":
        custom_base = ""
        custom_key = ""
        if explicit_base_url:
            custom_base = _to_openai_base_url(explicit_base_url).strip()
            custom_key = (
                (explicit_api_key or "").strip()
                or os.getenv("OPENAI_API_KEY", "").strip()
                # A task may intentionally target another model behind the
                # same self-hosted gateway. Reuse the main credential only
                # for that exact host; never leak it to an arbitrary aux URL.
                or _read_main_api_key_if_same_host(custom_base)
                or "no-key-required"  # local servers don't need auth
            )
            if not custom_base:
                logger.warning(
                    "resolve_provider_client: explicit custom endpoint requested "
                    "but base_url is empty"
                )
                return None, None
        elif main_runtime:
            # The main agent may have resolved a named custom provider
            # (``custom:<name>``) whose credentials cannot be recovered from
            # the bare ``custom`` alias. Reuse that concrete runtime instead
            # of silently routing side tasks to an unrelated fallback.
            runtime_base = str(main_runtime.get("base_url") or "").strip().rstrip("/")
            runtime_key = str(main_runtime.get("api_key") or "").strip()
            if runtime_base and runtime_key:
                custom_base = runtime_base
                custom_key = runtime_key

        if custom_base and custom_key:
            final_model = _normalize_resolved_model(
                model or (main_runtime.get("model") if main_runtime else None) or "gpt-4o-mini",
                provider,
            )
            extra = {}
            _clean_base, _dq = _extract_url_query_params(custom_base)
            if _dq:
                extra["default_query"] = _dq
            if base_url_host_matches(custom_base, "integrate.api.nvidia.com"):
                extra["default_headers"] = build_nvidia_nim_headers(custom_base)
            else:
                # Fall back to profile.default_headers for providers that
                # declare client-level attribution headers on their profile.
                try:
                    from providers import get_provider_profile as _gpf_custom
                    _ph_custom = _gpf_custom(provider)
                    if _ph_custom and _ph_custom.default_headers:
                        extra["default_headers"] = dict(_ph_custom.default_headers)
                except Exception:
                    pass
            _merged_custom = _apply_user_default_headers(extra.get("default_headers"))
            if _merged_custom:
                extra["default_headers"] = _merged_custom
            client = _create_openai_client(
                api_key=custom_key, base_url=_clean_base, **extra
            )
            client = _wrap_if_needed(client, final_model, custom_base, custom_key)
            return (_to_async_client(client, final_model, is_vision=is_vision) if async_mode
                    else (client, final_model))
        # Try custom first, then API-key providers (Codex excluded here:
        # falling through to Codex with no model is a stale-constant trap).
        for try_fn in (_try_custom_endpoint, _resolve_api_key_provider):
            client, default = try_fn()
            if client is not None:
                final_model = _normalize_resolved_model(model or default, provider)
                _cbase = str(getattr(client, "base_url", "") or "")
                # ``client.api_key`` may be a callable (Azure Foundry Entra
                # bearer provider). Pass empty string for the wrapper-detection
                # path — wrapping decisions are based on base_url + api_mode.
                _raw_ckey = getattr(client, "api_key", "")
                _ckey = "" if (callable(_raw_ckey) and not isinstance(_raw_ckey, str)) else str(_raw_ckey or "")
                client = _wrap_if_needed(client, final_model, _cbase, _ckey)
                return (_to_async_client(client, final_model, is_vision=is_vision) if async_mode
                        else (client, final_model))
        logger.warning("resolve_provider_client: custom/main requested "
                       "but no endpoint credentials found")
        return None, None

    # ── Named custom providers (config.yaml providers dict / custom_providers list) ───
    try:
        from fan_cli.runtime_provider import _get_named_custom_provider
        # When the raw requested name is an alias (``kimi`` → ``kimi-coding``)
        # and the user defined a ``custom_providers`` entry under that alias
        # name, the custom entry is the intended target — the built-in alias
        # rewriting would otherwise hijack the request.  Only preferred when
        # the raw name is an alias (not a canonical provider name) so custom
        # entries that coincide with a canonical provider still defer to the
        # built-in per `_get_named_custom_provider`'s guard.
        custom_entry = None
        if original_provider and original_provider != provider:
            custom_entry = _get_named_custom_provider(original_provider)
        if custom_entry is None:
            custom_entry = _get_named_custom_provider(provider)
        if custom_entry:
            # A hand-edited custom provider may explicitly set either field
            # to YAML null.  ``dict.get(..., "")`` preserves that None, so
            # normalize before calling string methods.
            custom_base = (custom_entry.get("base_url") or "").strip()
            custom_key = (custom_entry.get("api_key") or "").strip()
            custom_key_env = (custom_entry.get("key_env") or custom_entry.get("api_key_env") or "").strip()
            if not custom_key and custom_key_env:
                custom_key = os.getenv(custom_key_env, "").strip()
            custom_key = custom_key or "no-key-required"
            if custom_key == "no-key-required":
                logger.warning(
                    "resolve_provider_client: named custom provider %r has no resolvable "
                    "api_key — request will be sent with placeholder no-key-required "
                    "and will 401 on auth-required endpoints",
                    custom_entry.get("name") or provider,
                )
            # An explicit per-task api_mode override (from _resolve_task_provider_model)
            # wins; otherwise fall back to what the provider entry declared.
            entry_api_mode = (api_mode or custom_entry.get("api_mode") or "").strip()
            if custom_base:
                final_model = _normalize_resolved_model(
                    model
                    or custom_entry.get("model")
                    or (main_runtime.get("model") if main_runtime else None)
                    or _read_main_model()
                    or "gpt-4o-mini",
                    provider,
                )
                # OpenAI-wire paths (chat_completions / codex_responses) need
                # the /v1 equivalent base URL.
                openai_base = _to_openai_base_url(custom_base)
                raw_base_for_wrap = custom_base
                _clean_base2, _dq2 = _extract_url_query_params(openai_base)
                _extra2 = {"default_query": _dq2} if _dq2 else {}
                _headers2 = _apply_user_default_headers(_extra2.get("default_headers"))
                if _headers2:
                    _extra2["default_headers"] = _headers2
                logger.debug(
                    "resolve_provider_client: named custom provider %r (%s, api_mode=%s)",
                    provider, final_model, entry_api_mode or "chat_completions")
                client = _create_openai_client(
                    api_key=custom_key, base_url=_clean_base2, **_extra2
                )
                # codex_responses or inherited auto-detect (via _wrap_if_needed).
                # _wrap_if_needed reads the closed-over `api_mode` (the task-level
                # override). Named-provider entry api_mode=codex_responses also
                # flows through here.
                if entry_api_mode == "codex_responses" and not isinstance(
                    client, CodexAuxiliaryClient
                ):
                    client = CodexAuxiliaryClient(client, final_model)
                else:
                    client = _wrap_if_needed(client, final_model, raw_base_for_wrap, custom_key)
                return (_to_async_client(client, final_model, is_vision=is_vision) if async_mode
                        else (client, final_model))
            logger.warning(
                "resolve_provider_client: named custom provider %r has no base_url",
                provider)
            return None, None
    except ImportError:
        pass


    # ── API-key providers from PROVIDER_REGISTRY ─────────────────────
    try:
        from fan_cli.auth import (
            PROVIDER_REGISTRY,
            resolve_api_key_provider_credentials,
        )
    except ImportError:
        logger.debug("fan_cli.auth not available for provider %s", provider)
        return None, None

    pconfig = PROVIDER_REGISTRY.get(provider)
    if pconfig is None:
        logger.warning("resolve_provider_client: unknown provider %r", provider)
        return None, None

    if pconfig.auth_type == "api_key":
        creds = resolve_api_key_provider_credentials(provider)
        api_key = str(creds.get("api_key", "")).strip()
        # Honour an explicit api_key override (e.g. from a fallback_model entry
        # or a custom_providers entry) so callers that pass an explicit
        # credential can authenticate against endpoints where no built-in
        # credential is registered for this provider alias.
        if explicit_api_key:
            api_key = explicit_api_key.strip() or api_key
        if not api_key:
            tried_sources = list(pconfig.api_key_env_vars)
            if provider == "copilot":
                tried_sources.append("gh auth token")
            logger.debug("resolve_provider_client: provider %s has no API "
                         "key configured (tried: %s)",
                         provider, ", ".join(tried_sources))
            return None, None

        raw_base_url = str(creds.get("base_url", "")).strip().rstrip("/") or pconfig.inference_base_url
        base_url = _to_openai_base_url(raw_base_url)
        # Honour an explicit base_url override from the caller — used when a
        # fallback_model entry (or custom_providers lookup) routes through a
        # built-in provider name but targets a user-specified endpoint.
        if explicit_base_url:
            base_url = _to_openai_base_url(explicit_base_url.strip().rstrip("/"))

        default_model = _get_aux_model_for_provider(provider)
        final_model = _normalize_resolved_model(model or default_model, provider)

        # Provider-specific headers
        headers = {}
        if base_url_host_matches(base_url, "integrate.api.nvidia.com"):
            headers.update(build_nvidia_nim_headers(base_url))
        else:
            # Fall back to profile.default_headers for providers that declare
            # client-level attribution headers on their profile (e.g. GMI
            # User-Agent for traffic identification).
            try:
                from providers import get_provider_profile as _gpf_main
                _ph_main = _gpf_main(provider)
                if _ph_main and _ph_main.default_headers:
                    headers.update(_ph_main.default_headers)
            except Exception:
                pass
        _merged_main = _apply_user_default_headers(headers)
        if _merged_main:
            headers = _merged_main
        client = _create_openai_client(
            api_key=api_key,
            base_url=base_url,
            **({"default_headers": headers} if headers else {}),
        )

        # Honor api_mode for any API-key provider (e.g. direct OpenAI with
        # codex-family models).  Wraps in CodexAuxiliaryClient when the
        # endpoint needs the Responses API (#6800).
        client = _wrap_if_needed(client, final_model, raw_base_url, api_key)

        logger.debug("resolve_provider_client: %s (%s)", provider, final_model)
        return (_to_async_client(client, final_model, is_vision=is_vision) if async_mode
                else (client, final_model))

    logger.warning("resolve_provider_client: unhandled auth_type %s for %s",
                   pconfig.auth_type, provider)
    return None, None


# ── Public API ──────────────────────────────────────────────────────────────

def get_text_auxiliary_client(
    task: str = "",
    *,
    main_runtime: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[OpenAI], Optional[str]]:
    """Return (client, default_model_slug) for text-only auxiliary tasks.

    Args:
        task: Optional task name ("compression", "web_extract") to check
              for a task-specific provider override.

    Callers may override the returned model via config.yaml
    (e.g. auxiliary.compression.model, auxiliary.web_extract.model).
    """
    provider, model, base_url, api_key, api_mode = _resolve_task_provider_model(task or None)
    return resolve_provider_client(
        provider,
        model=model,
        explicit_base_url=base_url,
        explicit_api_key=api_key,
        api_mode=api_mode,
        main_runtime=main_runtime,
    )



_VISION_AUTO_PROVIDER_ORDER: tuple[str, ...] = ()


def _main_model_supports_vision(provider: str, model: Optional[str]) -> bool:
    """Return True when ``provider``/``model`` is known to accept image input.

    Used by the vision auto-detect chain to skip the user's main provider
    when it's known to be text-only (e.g. DeepSeek, gpt-oss without vision).
    Without this guard, ``resolve_vision_provider_client(provider="auto")``
    would happily return the main-provider client and any subsequent image
    payload would surface as a cryptic provider-side error
    (``unknown variant `image_url`, expected `text```, #31179).

    Returns True when capability lookup is unknown — preserves the historical
    behaviour of attempting the call, so providers we haven't catalogued yet
    don't silently regress to text-only.
    """
    try:
        from agent.image_routing import _lookup_supports_vision
        from fan_cli.config import load_config
    except ImportError:
        return True
    try:
        supports = _lookup_supports_vision(provider, model, load_config())
    except Exception:  # pragma: no cover - defensive
        return True
    if supports is None:
        # No capability data — keep current behaviour and let the call attempt
        # happen rather than silently skipping. This avoids false-positive
        # skips for new/custom providers.
        return True
    return bool(supports)


def _normalize_vision_provider(provider: Optional[str]) -> str:
    return _normalize_aux_provider(provider)


def _resolve_strict_vision_backend(
    provider: str,
    model: Optional[str] = None,
) -> Tuple[Optional[Any], Optional[str]]:
    provider = _normalize_vision_provider(provider)
    if provider == "custom":
        return _try_custom_endpoint()
    return None, None



def resolve_vision_provider_client(
    provider: Optional[str] = None,
    model: Optional[str] = None,
    *,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    async_mode: bool = False,
) -> Tuple[Optional[str], Optional[Any], Optional[str]]:
    """Resolve the client actually used for vision tasks.

    Direct endpoint overrides take precedence over provider selection. Explicit
    provider overrides still use the generic provider router for non-standard
    backends, so users can intentionally force experimental providers. Auto mode
    stays conservative and only tries vision backends known to work today.
    """
    requested, resolved_model, resolved_base_url, resolved_api_key, resolved_api_mode = _resolve_task_provider_model(
        "vision", provider, model, base_url, api_key
    )
    requested = _normalize_vision_provider(requested)
    supported_provider_ids = {
        "auto", "custom", "deepseek", "alibaba", "alibaba-coding-plan",
        "ollama-cloud",
    }
    if requested not in supported_provider_ids and not resolved_base_url:
        logger.warning(
            "resolve_vision_provider_client: provider %r is not supported by this Fan build",
            requested,
        )
        return requested, None, None

    def _finalize(
        resolved_provider: str,
        sync_client: Any,
        default_model: Optional[str],
        *,
        prefer_default_model: bool = False,
    ):
        if sync_client is None:
            return resolved_provider, None, None
        if prefer_default_model:
            final_model = default_model or resolved_model
        else:
            final_model = resolved_model or default_model
        if async_mode:
            async_client, async_model = _to_async_client(sync_client, final_model, is_vision=True)
            return resolved_provider, async_client, async_model
        return resolved_provider, sync_client, final_model

    if resolved_base_url:
        provider_for_base_override = (
            requested if requested and requested not in {"", "auto"} else "custom"
        )
        client, final_model = resolve_provider_client(
            provider_for_base_override,
            model=resolved_model,
            async_mode=async_mode,
            explicit_base_url=resolved_base_url,
            explicit_api_key=resolved_api_key,
            api_mode=resolved_api_mode,
        )
        if client is None:
            return provider_for_base_override, None, None
        return provider_for_base_override, client, final_model

    if requested == "auto":
        # Vision auto-detection order:
        #   1. User's main provider + main model (including aggregators).
        #      _PROVIDER_VISION_MODELS provides per-provider vision model
        #      overrides when the provider has a dedicated multimodal model
        #      that differs from the chat model (e.g. xiaomi → mimo-v2-omni,
        #      zai → glm-5v-turbo).
        #   2. Fall through to explicitly configured vision candidates.
        #   3. Stop
        main_provider = _read_main_provider()
        main_model = _read_main_model()
        if main_provider and main_provider not in {"auto", ""}:
            vision_model = resolved_model or _PROVIDER_VISION_MODELS.get(
                main_provider, main_model
            )
            if main_provider in _PROVIDERS_WITHOUT_VISION:
                # This provider endpoint does not accept image input. Skip it
                # and fall through to the configured vision provider chain.
                logger.debug(
                    "Vision auto-detect: skipping main provider %s (no "
                    "vision support) — falling through to aggregator chain",
                    main_provider,
                )
            elif not vision_model or not _main_model_supports_vision(
                main_provider, vision_model
            ):
                # The main model is known to be text-only (e.g. DeepSeek V4,
                # gpt-oss-120b without vision). Building a client and sending
                # an image would produce a cryptic provider-side error like
                # ``unknown variant `image_url`, expected `text``` (#31179).
                # Fall through to the aggregator chain instead.
                #
                # Only log the provider name (not the model) — mirrors the
                # sibling _PROVIDERS_WITHOUT_VISION branch above, and avoids
                # CodeQL py/clear-text-logging-sensitive-data heuristic false
                # positives on multi-value interpolations.
                logger.debug(
                    "Vision auto-detect: skipping main provider %s "
                    "(reports no vision capability) — falling through to "
                    "aggregator chain",
                    main_provider,
                )
            else:
                # A named custom main provider carries its live endpoint and
                # credential on the running agent, not necessarily in the
                # generic ``custom`` config slot.  Reuse that runtime binding
                # for vision auto-detection so it does not fall through to an
                # unrelated auxiliary backend.
                rpc_provider = main_provider
                rpc_base_url = None
                rpc_api_key = None
                rpc_api_mode = resolved_api_mode
                if main_provider == "custom" or main_provider.startswith("custom:"):
                    active_runtime = _runtime_main_snapshot()
                    if active_runtime.base_url:
                        rpc_provider = "custom"
                        rpc_base_url = active_runtime.base_url
                        rpc_api_key = active_runtime.api_key or None
                        rpc_api_mode = (
                            resolved_api_mode or active_runtime.api_mode or None
                        )
                    else:
                        custom_base, custom_key, custom_mode = _resolve_custom_runtime()
                        if custom_base:
                            rpc_provider = "custom"
                            rpc_base_url = custom_base
                            rpc_api_key = custom_key
                            rpc_api_mode = resolved_api_mode or custom_mode or None
                rpc_client, rpc_model = resolve_provider_client(
                    rpc_provider,
                    vision_model,
                    api_mode=rpc_api_mode,
                    explicit_base_url=rpc_base_url,
                    explicit_api_key=rpc_api_key,
                    is_vision=True,
                )
                if rpc_client is not None:
                    logger.info(
                        "Vision auto-detect: using main provider %s (%s)",
                        main_provider, rpc_model or vision_model,
                    )
                    return _finalize(
                        main_provider,
                        rpc_client,
                        rpc_model or vision_model,
                        prefer_default_model=False,
                    )

        # Fall back through aggregators (uses their dedicated vision model,
        # not the user's main model) when main provider has no client.
        for candidate in _VISION_AUTO_PROVIDER_ORDER:
            if candidate == main_provider:
                continue  # already tried above
            sync_client, default_model = _resolve_strict_vision_backend(candidate)
            if sync_client is not None:
                return _finalize(candidate, sync_client, default_model)

        logger.debug("Auxiliary vision client: none available")
        return None, None, None

    if requested in _VISION_AUTO_PROVIDER_ORDER:
        sync_client, default_model = _resolve_strict_vision_backend(
            requested, resolved_model
        )
        return _finalize(requested, sync_client, default_model)

    client, final_model = _get_cached_client(requested, resolved_model, async_mode,
                                             api_mode=resolved_api_mode,
                                             is_vision=True)
    if client is None:
        return requested, None, None
    return requested, client, final_model


def get_auxiliary_extra_body() -> dict:
    """Return extra_body kwargs for auxiliary API calls.

    No provider currently injects extra_body for auxiliary calls, so this
    returns an empty dict. Kept as a stable hook for callers
    (kanban_decompose, kanban_specify, goals).
    """
    return {}



_client_cache: Dict[tuple, tuple] = {}
_client_cache_lock = threading.Lock()
_CLIENT_CACHE_MAX_SIZE = 64  # safety belt — evict oldest when exceeded


def _client_cache_key(
    provider: str,
    *,
    async_mode: bool,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    api_mode: Optional[str] = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    is_vision: bool = False,
    model: Optional[str] = None,
) -> tuple:
    runtime = _normalize_main_runtime(main_runtime)
    runtime_key = tuple(runtime.get(field, "") for field in _MAIN_RUNTIME_FIELDS) if provider == "auto" else ()
    pool_hint = _pool_cache_hint(provider, main_runtime=main_runtime)
    # Different models sharing an endpoint can issue concurrent auxiliary
    # requests. Keep separate cached clients so one cache miss cannot replace
    # and close the sibling's in-flight transport.
    return (
        provider, async_mode, base_url or "", api_key or "", api_mode or "",
        runtime_key, is_vision, pool_hint, model or "",
    )



def neuter_async_httpx_del() -> None:
    """Monkey-patch ``AsyncHttpxClientWrapper.__del__`` to be a no-op.

    The OpenAI SDK's ``AsyncHttpxClientWrapper.__del__`` schedules
    ``self.aclose()`` via ``asyncio.get_running_loop().create_task()``.
    When an ``AsyncOpenAI`` client is garbage-collected while
    prompt_toolkit's event loop is running (the common CLI idle state),
    the ``aclose()`` task runs on prompt_toolkit's loop but the
    underlying TCP transport is bound to a *different* loop (the worker
    thread's loop that the client was originally created on).  If that
    loop is closed or its thread is dead, the transport's
    ``self._loop.call_soon()`` raises ``RuntimeError("Event loop is
    closed")``, which prompt_toolkit surfaces as "Unhandled exception
    in event loop ... Press ENTER to continue...".

    Neutering ``__del__`` is safe because:
    - Cached clients are explicitly cleaned via ``_force_close_async_httpx``
      on stale-loop detection and ``shutdown_cached_clients`` on exit.
    - Uncached clients' TCP connections are cleaned up by the OS when the
      process exits.
    - The OpenAI SDK itself marks this as a TODO (``# TODO(someday):
      support non asyncio runtimes here``).

    Call this once at CLI startup, before any ``AsyncOpenAI`` clients are
    created.
    """
    try:
        from openai._base_client import AsyncHttpxClientWrapper
        AsyncHttpxClientWrapper.__del__ = lambda self: None  # type: ignore[assignment]
    except (ImportError, AttributeError):
        pass  # Graceful degradation if the SDK changes its internals


def _force_close_async_httpx(client: Any) -> None:
    """Mark the httpx AsyncClient inside an AsyncOpenAI client as closed.

    This prevents ``AsyncHttpxClientWrapper.__del__`` from scheduling
    ``aclose()`` on a (potentially closed) event loop, which causes
    ``RuntimeError: Event loop is closed`` → prompt_toolkit's
    "Press ENTER to continue..." handler.

    We intentionally do NOT run the full async close path — the
    connections will be dropped by the OS when the process exits.
    """
    try:
        from httpx._client import ClientState
        inner = getattr(client, "_client", None)
        if inner is not None and not getattr(inner, "is_closed", True):
            inner._state = ClientState.CLOSED
    except Exception:
        pass


def shutdown_cached_clients() -> None:
    """Close all cached clients (sync and async) to prevent event-loop errors.

    Call this during CLI shutdown, *before* the event loop is closed, to
    avoid ``AsyncHttpxClientWrapper.__del__`` raising on a dead loop.
    """
    import inspect

    with _client_cache_lock:
        for key, entry in list(_client_cache.items()):
            client = entry[0]
            if client is None:
                continue
            # Mark any async httpx transport as closed first (prevents __del__
            # from scheduling aclose() on a dead event loop).
            _force_close_async_httpx(client)
            # Sync clients: close the httpx connection pool cleanly.
            # Async clients: skip — we already neutered __del__ above.
            try:
                close_fn = getattr(client, "close", None)
                if close_fn and not inspect.iscoroutinefunction(close_fn):
                    close_fn()
            except Exception:
                pass
        _client_cache.clear()


def cleanup_stale_async_clients() -> None:
    """Force-close cached async clients whose event loop is closed.

    Call this after each agent turn to proactively clean up stale clients
    before GC can trigger ``AsyncHttpxClientWrapper.__del__`` on them.
    This is defense-in-depth — the primary fix is ``neuter_async_httpx_del``
    which disables ``__del__`` entirely.
    """
    with _client_cache_lock:
        stale_keys = []
        for key, entry in _client_cache.items():
            client, _default, cached_loop = entry
            if cached_loop is not None and cached_loop.is_closed():
                _force_close_async_httpx(client)
                stale_keys.append(key)
        for key in stale_keys:
            del _client_cache[key]


def _is_openrouter_client(client: Any) -> bool:
    for obj in (client, getattr(client, "_client", None), getattr(client, "client", None)):
        if obj and base_url_host_matches(str(getattr(obj, "base_url", "") or ""), "openrouter.ai"):
            return True
    return False


def _cached_client_accepts_slash_models(client: Any, cached_default: Optional[str]) -> bool:
    """Best-effort check for cached clients that accept ``vendor/model`` IDs."""
    if _is_openrouter_client(client):
        return True
    return bool(cached_default and "/" in cached_default)


def _compat_model(client: Any, model: Optional[str], cached_default: Optional[str]) -> Optional[str]:
    """Keep slash-bearing model IDs only for cached clients that support them.

    Mirrors the guard in resolve_provider_client() which is skipped on cache hits.
    """
    if model and "/" in model and not _cached_client_accepts_slash_models(client, cached_default):
        return cached_default
    return model or cached_default


def _get_cached_client(
    provider: str,
    model: str = None,
    async_mode: bool = False,
    base_url: str = None,
    api_key: str = None,
    api_mode: str = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    is_vision: bool = False,
) -> Tuple[Optional[Any], Optional[str]]:
    """Get or create a cached client for the given provider.

    Async clients (AsyncOpenAI) use httpx.AsyncClient internally, which
    binds to the event loop that was current when the client was created.
    Using such a client on a *different* loop causes deadlocks or
    RuntimeError.  To prevent cross-loop issues, the cache validates on
    every async hit that the cached loop is the *current, open* loop.
    If the loop changed (e.g. a new gateway worker-thread loop), the stale
    entry is replaced in-place rather than creating an additional entry.

    This keeps cache size bounded to one entry per unique provider config,
    preventing the fd-exhaustion that previously occurred in long-running
    gateways where recycled worker threads created unbounded entries (#10200).
    """
    # Resolve the current event loop for async clients so we can validate
    # cached entries.  Loop identity is NOT in the cache key — instead we
    # check at hit time whether the cached loop is still current and open.
    # This prevents unbounded cache growth from recycled worker-thread loops
    # while still guaranteeing we never reuse a client on the wrong loop
    # (which causes deadlocks, see #2681).
    current_loop = None
    if async_mode:
        try:
            import asyncio as _aio
            current_loop = _aio.get_event_loop()
        except RuntimeError:
            pass
    runtime = _normalize_main_runtime(main_runtime)
    cache_key = _client_cache_key(
        provider,
        async_mode=async_mode,
        base_url=base_url,
        api_key=api_key,
        api_mode=api_mode,
        main_runtime=main_runtime,
        is_vision=is_vision,
        model=model,
    )
    with _client_cache_lock:
        if cache_key in _client_cache:
            cached_client, cached_default, cached_loop = _client_cache[cache_key]
            if async_mode:
                # Validate: the cached client must be bound to the CURRENT,
                # OPEN loop.  If the loop changed or was closed, the httpx
                # transport inside is dead — force-close and replace.
                loop_ok = (
                    cached_loop is not None
                    and cached_loop is current_loop
                    and not cached_loop.is_closed()
                )
                if loop_ok:
                    effective = _compat_model(cached_client, model, cached_default)
                    return cached_client, effective
                # Stale — evict and fall through to create a new client.
                _force_close_async_httpx(cached_client)
                del _client_cache[cache_key]
            else:
                effective = _compat_model(cached_client, model, cached_default)
                return cached_client, effective
    # Build outside the lock.
    # For pool-backed api_key providers, derive the active API key from the
    # pool entry rather than from env vars.  resolve_api_key_provider_credentials
    # always prefers env vars (first-entry bias), which bypasses pool rotation:
    # after key #1 is marked exhausted the retry would still get key #1 from
    # the env var and fail again, causing the retry2_err handler to mark key #2.
    effective_api_key = api_key
    if not effective_api_key:
        _pe = _peek_pool_entry(_normalize_aux_provider(provider))
        if _pe is not None:
            _pk = _pool_runtime_api_key(_pe)
            if _pk:
                effective_api_key = _pk
    client, default_model = resolve_provider_client(
        provider,
        model,
        async_mode,
        explicit_base_url=base_url,
        explicit_api_key=effective_api_key,
        api_mode=api_mode,
        main_runtime=runtime,
        is_vision=is_vision,
    )
    if client is not None:
        # For async clients, remember which loop they were created on so we
        # can detect stale entries later.
        bound_loop = current_loop
        with _client_cache_lock:
            if cache_key not in _client_cache:
                # Safety belt: if the cache has grown beyond the max, evict
                # the oldest entries (FIFO — dict preserves insertion order).
                while len(_client_cache) >= _CLIENT_CACHE_MAX_SIZE:
                    evict_key, evict_entry = next(iter(_client_cache.items()))
                    _force_close_async_httpx(evict_entry[0])
                    del _client_cache[evict_key]
                _client_cache[cache_key] = (client, default_model, bound_loop)
            else:
                client, default_model, _ = _client_cache[cache_key]
    return client, model or default_model


# Aliases that target direct REST APIs not modeled as first-class providers
# in PROVIDER_REGISTRY. Used for ``auxiliary.<task>.provider`` so users can
# write the obvious name and have it resolve to a working ``custom`` endpoint
# without needing to know our internal provider IDs.
#
# Why these specifically: PROVIDER_REGISTRY has ``openai-codex`` (OAuth) and
# ``custom`` (manual base_url + OPENAI_API_KEY) but no plain ``openai`` for
# direct API-key access. Users predictably type ``provider: openai`` and
# expect it to use OPENAI_API_KEY against api.openai.com. Previously this
# silently fell back to the user's main provider, sending OpenAI model names
# to e.g. DeepSeek and producing cryptic ``unknown variant 'image_url'``
# errors (issue #31179).
_AUX_DIRECT_API_BASE_URLS: Dict[str, str] = {}


def _resolve_task_provider_model(
    task: str = None,
    provider: str = None,
    model: str = None,
    base_url: str = None,
    api_key: str = None,
) -> Tuple[str, Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Determine provider + model for a call.

    Priority:
      1. Explicit provider/model/base_url/api_key args (always win)
      2. Config file (auxiliary.{task}.provider/model/base_url)
      3. "auto" (full auto-detection chain)

    Returns (provider, model, base_url, api_key, api_mode) where model may
    be None (use provider default). When base_url is set, provider is forced
    to "custom" and the task uses that direct endpoint. api_mode is one of
    "chat_completions", "codex_responses", or None (auto-detect).
    """
    cfg_provider = None
    cfg_model = None
    cfg_base_url = None
    cfg_api_key = None
    cfg_api_mode = None

    if task:
        task_config = _get_auxiliary_task_config(task)
        cfg_provider = str(task_config.get("provider", "")).strip() or None
        cfg_model = str(task_config.get("model", "")).strip() or None
        cfg_base_url = str(task_config.get("base_url", "")).strip() or None
        cfg_api_key = str(task_config.get("api_key", "")).strip() or None
        cfg_api_mode = str(task_config.get("api_mode", "")).strip() or None

    resolved_model = model or cfg_model
    resolved_api_mode = cfg_api_mode

    # Convenience aliases for direct API-key endpoints that aren't first-class
    # providers (e.g. ``provider: openai`` → custom + api.openai.com/v1).
    # Applied to both explicit args and config-derived values. When the user
    # has already supplied a base_url we keep their endpoint but still rewrite
    # the provider to ``custom`` so resolution doesn't hit the
    # PROVIDER_REGISTRY-only path (which has no ``openai`` entry).
    def _expand_direct_api_alias(prov: Optional[str], existing_base: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if not prov:
            return prov, existing_base
        target_base = _AUX_DIRECT_API_BASE_URLS.get(prov.strip().lower())
        if target_base is None:
            return prov, existing_base
        return "custom", existing_base or target_base

    if provider:
        provider, base_url = _expand_direct_api_alias(provider, base_url)
    if cfg_provider:
        cfg_provider, cfg_base_url = _expand_direct_api_alias(cfg_provider, cfg_base_url)

    # Passing an explicit provider (for example, a title/compression caller)
    # must not discard the task's configured endpoint and key. ``auto`` still
    # means inherit/resolve normally; a concrete provider adopts the matching
    # per-task endpoint when the caller did not supply one.
    if (
        provider
        and provider != "auto"
        and not base_url
        and cfg_base_url
        and cfg_provider in (None, provider)
    ):
        base_url = cfg_base_url
        if not api_key:
            api_key = cfg_api_key

    if base_url:
        return "custom", resolved_model, base_url, api_key, resolved_api_mode
    if provider:
        return provider, resolved_model, base_url, api_key, resolved_api_mode

    if task:
        # Config.yaml is the primary source for per-task overrides.
        if cfg_base_url and cfg_api_key:
            # Both base_url and api_key explicitly set → custom endpoint.
            return "custom", resolved_model, cfg_base_url, cfg_api_key, resolved_api_mode
        if cfg_base_url and cfg_provider and cfg_provider != "auto":
            # base_url set without api_key but with a known provider — use
            # the provider so it can resolve credentials from env vars
            # (e.g. OPENROUTER_API_KEY) instead of locking into "custom".
            return cfg_provider, resolved_model, cfg_base_url, None, resolved_api_mode
        if cfg_provider and cfg_provider != "auto":
            return cfg_provider, resolved_model, cfg_base_url, cfg_api_key, resolved_api_mode

        return "auto", resolved_model, None, None, resolved_api_mode

    return "auto", resolved_model, None, None, resolved_api_mode


_DEFAULT_AUX_TIMEOUT = 30.0

# Compression can ask a reasoning model to summarize a long transcript. Its
# config timeout must leave enough time for that work; otherwise the compressor
# needlessly drops to its fallback marker after the ordinary 120-second
# auxiliary deadline. Explicit per-call deadlines remain authoritative.
_COMPRESSION_TIMEOUT_FLOOR_SECONDS = 300.0


def _get_auxiliary_task_config(task: str) -> Dict[str, Any]:
    """Return the config dict for auxiliary.<task>, or {} when unavailable.

    For plugin-registered auxiliary tasks (see
    :meth:`fan_cli.plugins.PluginContext.register_auxiliary_task`) the
    plugin's declared *defaults* are layered underneath the user's config
    so an unconfigured plugin task still works:

        plugin defaults  ←  config.yaml auxiliary.<task>  (user wins)

    Built-in tasks ignore this path (their defaults live in DEFAULT_CONFIG).
    """
    if not task:
        return {}
    try:
        from fan_cli.config import load_config
        config = load_config()
    except ImportError:
        return {}
    aux = config.get("auxiliary", {}) if isinstance(config, dict) else {}
    task_config = aux.get(task, {}) if isinstance(aux, dict) else {}
    if not isinstance(task_config, dict):
        task_config = {}

    # Layer plugin-declared defaults underneath user config so
    # ctx.register_auxiliary_task(defaults={...}) takes effect without
    # forcing the user to write config.yaml entries.
    try:
        from fan_cli.plugins import get_plugin_auxiliary_tasks
        for _entry in get_plugin_auxiliary_tasks():
            if _entry.get("key") == task:
                _defaults = _entry.get("defaults") or {}
                if isinstance(_defaults, dict):
                    merged = dict(_defaults)
                    merged.update(task_config)
                    return merged
                break
    except Exception:
        # Plugin discovery failure must not break aux task config reads.
        pass

    return task_config


def _get_task_timeout(task: str, default: float = _DEFAULT_AUX_TIMEOUT) -> float:
    """Read timeout from auxiliary.{task}.timeout in config, falling back to *default*."""
    if not task:
        return default
    task_config = _get_auxiliary_task_config(task)
    raw = task_config.get("timeout")
    if raw is not None:
        try:
            return float(raw)
        except (ValueError, TypeError):
            pass
    return default


def _effective_aux_timeout(task: str, timeout: Optional[float]) -> float:
    """Resolve an auxiliary timeout while protecting compression reliability.

    Only configuration-derived compression timeouts receive the bounded
    floor. A caller that passes ``timeout=`` has made an intentional deadline
    choice and is never overridden.
    """
    effective = timeout if timeout is not None else _get_task_timeout(task)
    if timeout is None and task == "compression":
        effective = max(effective, _COMPRESSION_TIMEOUT_FLOOR_SECONDS)
    return effective


def _get_task_extra_body(task: str) -> Dict[str, Any]:
    """Read auxiliary.<task>.extra_body and return a shallow copy when valid."""
    task_config = _get_auxiliary_task_config(task)
    raw = task_config.get("extra_body")
    if isinstance(raw, dict):
        return dict(raw)
    return {}



def _build_call_kwargs(
    provider: str,
    model: str,
    messages: list,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    tools: Optional[list] = None,
    timeout: float = 30.0,
    extra_body: Optional[dict] = None,
    base_url: Optional[str] = None,
) -> dict:
    """Build kwargs for .chat.completions.create() with model/provider adjustments."""
    kwargs: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "timeout": timeout,
    }

    fixed_temperature = _fixed_temperature_for_model(model, base_url)
    if fixed_temperature is OMIT_TEMPERATURE:
        temperature = None  # strip — let server choose
    elif fixed_temperature is not None:
        temperature = fixed_temperature

    if temperature is not None:
        kwargs["temperature"] = temperature

    # Deliberately omit max_tokens for generic compatible endpoints: they
    # disagree on the accepted parameter name and the native output cap is the
    # safest auxiliary default. NVIDIA NIM is the exception: some NIM models
    # return an empty choices payload when no output cap is supplied.
    if max_tokens is not None:
        effective_base = base_url or ""
        provider_norm = str(provider or "").strip().lower()
        is_nvidia_nim = (
            provider_norm in {"nvidia", "nvidia-nim", "nim", "build-nvidia", "nemotron"}
            or base_url_host_matches(effective_base, "integrate.api.nvidia.com")
        )
        if is_nvidia_nim:
            kwargs["max_tokens"] = max_tokens

    if tools:
        # Defensive dedup: providers like Google Vertex, Azure, and Bedrock
        # reject requests with duplicate tool names (HTTP 400).  The upstream
        # injection paths (run_agent.py) already dedup, but this guard
        # converts a hard API failure into a warning if an upstream regression
        # reintroduces duplicates.  See: #18478
        _seen: set = set()
        _deduped: list = []
        for _t in tools:
            _tname = (_t.get("function") or {}).get("name", "")
            if _tname and _tname in _seen:
                logger.warning(
                    "_build_call_kwargs: duplicate tool name '%s' removed "
                    "(provider=%s model=%s)",
                    _tname, provider, model,
                )
                continue
            if _tname:
                _seen.add(_tname)
            _deduped.append(_t)
        kwargs["tools"] = _deduped

    # Provider-specific extra_body
    merged_extra = dict(extra_body or {})
    if merged_extra:
        kwargs["extra_body"] = merged_extra

    return kwargs


def _validate_llm_response(response: Any, task: str = None) -> Any:
    """Validate that an LLM response has the expected .choices[0].message shape.

    Fails fast with a clear error instead of letting malformed payloads
    propagate to downstream consumers where they crash with misleading
    AttributeError (e.g. "'str' object has no attribute 'choices'").

    See #7264.
    """
    if response is None:
        raise RuntimeError(
            f"Auxiliary {task or 'call'}: LLM returned None response"
        )
    # Allow SimpleNamespace responses from adapters (CodexAuxiliaryClient) —
    # they have .choices[0].message.
    try:
        choices = response.choices
        if not choices or not hasattr(choices[0], "message"):
            raise AttributeError("missing choices[0].message")
    except (AttributeError, TypeError, IndexError) as exc:
        recovered = _recover_aux_response_message(response)
        if recovered is not None:
            return recovered
        response_type = type(response).__name__
        response_preview = str(response)[:120]
        raise RuntimeError(
            f"Auxiliary {task or 'call'}: LLM returned invalid response "
            f"(type={response_type}): {response_preview!r}. "
            f"Expected object with .choices[0].message — check provider "
            f"adapter or custom endpoint compatibility."
        ) from exc
    try:  # 全量辅助脑(qwen 视觉等)响应日志
        from agent.llm_io_log import log_response_obj
        log_response_obj(f"aux:{task or 'call'}", response)
    except Exception:
        pass
    return response


def _recover_aux_response_message(response: Any) -> Optional[Any]:
    """Normalize Responses-style text fields to chat-completions shape."""
    text = _extract_aux_response_text(response)
    if not text:
        return None

    choice = SimpleNamespace(
        message=SimpleNamespace(content=text),
        finish_reason=getattr(response, "finish_reason", None) or "stop",
    )
    try:
        response.choices = [choice]
        return response
    except Exception:
        return SimpleNamespace(
            id=getattr(response, "id", ""),
            model=getattr(response, "model", ""),
            object=getattr(response, "object", "chat.completion"),
            choices=[choice],
            usage=getattr(response, "usage", None),
        )


def _extract_aux_response_text(response: Any) -> str:
    output_text = _obj_get(response, "output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    output = _obj_get(response, "output")
    if not isinstance(output, list):
        return ""

    parts: List[str] = []
    for item in output:
        item_type = _obj_get(item, "type")
        if item_type and item_type != "message":
            continue
        for part in (_obj_get(item, "content") or []):
            part_type = _obj_get(part, "type")
            if part_type in {"output_text", "text", None}:
                text = _obj_get(part, "text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
    return "\n".join(parts).strip()


def _obj_get(obj: Any, key: str, default: Any = None) -> Any:
    value = getattr(obj, key, default)
    if value is default and isinstance(obj, dict):
        value = obj.get(key, default)
    return value


def call_llm(
    task: str = None,
    *,
    provider: str = None,
    model: str = None,
    base_url: str = None,
    api_key: str = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    messages: list,
    temperature: float = None,
    max_tokens: int = None,
    tools: list = None,
    timeout: float = None,
    extra_body: dict = None,
) -> Any:
    """Centralized synchronous LLM call.

    Resolves provider + model (from task config, explicit args, or auto-detect),
    handles auth, request formatting, and model-specific arg adjustments.

    Args:
        task: Auxiliary task name ("compression", "vision", "web_extract",
              "session_search", "mcp", "title_generation").
              Reads provider:model from config/env. Ignored if provider is set.
        provider: Explicit provider override.
        model: Explicit model override.
        messages: Chat messages list.
        temperature: Sampling temperature (None = provider default).
        max_tokens: Max output tokens (handles max_tokens vs max_completion_tokens).
        tools: Tool definitions (for function calling).
        timeout: Request timeout in seconds (None = read from auxiliary.{task}.timeout config).
        extra_body: Additional request body fields.

    Returns:
        Response object with .choices[0].message.content

    Raises:
        RuntimeError: If no provider is configured.
    """
    resolved_provider, resolved_model, resolved_base_url, resolved_api_key, resolved_api_mode = _resolve_task_provider_model(
        task, provider, model, base_url, api_key)
    effective_extra_body = _get_task_extra_body(task)
    effective_extra_body.update(extra_body or {})

    if task == "vision":
        effective_provider, client, final_model = resolve_vision_provider_client(
            provider=resolved_provider if resolved_provider != "auto" else provider,
            model=resolved_model or model,
            base_url=resolved_base_url or base_url,
            api_key=resolved_api_key or api_key,
            async_mode=False,
        )
        if client is None and resolved_provider != "auto" and not resolved_base_url:
            logger.warning(
                "Vision provider %s unavailable, falling back to auto vision backends",
                resolved_provider,
            )
            effective_provider, client, final_model = resolve_vision_provider_client(
                provider="auto",
                model=resolved_model,
                async_mode=False,
            )
        if client is None:
            raise RuntimeError(
                f"No LLM provider configured for task={task} provider={resolved_provider}. "
                f"Run: fan setup"
            )
        resolved_provider = effective_provider or resolved_provider
    else:
        client, final_model = _get_cached_client(
            resolved_provider,
            resolved_model,
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            api_mode=resolved_api_mode,
            main_runtime=main_runtime,
        )
        if client is None:
            # When the user explicitly chose a non-OpenRouter provider but no
            # credentials were found, fail fast instead of silently routing
            # through OpenRouter (which causes confusing 404s).
            _explicit = (resolved_provider or "").strip().lower()
            if _explicit and _explicit not in {"auto", "custom"}:
                fb_client, fb_model, fb_label = _try_configured_fallback_for_unavailable_client(
                    task,
                    _explicit,
                )
                if fb_client is not None:
                    client, final_model = fb_client, fb_model
                    resolved_provider = fb_label or resolved_provider
                else:
                    raise RuntimeError(
                        f"Provider '{_explicit}' is set in config.yaml but no API key "
                        f"was found. Set the {_explicit.upper()}_API_KEY environment "
                        f"variable, or switch to a different provider with `fan model`."
                    )
            # For auto/custom with no credentials, try the full auto chain
            # rather than hardcoding OpenRouter (which may be depleted).
            # Pass model=None so each provider uses its own default —
            # resolved_model may be an OpenRouter-format slug that doesn't
            # work on other providers.
            if client is None and not resolved_base_url:
                logger.info("Auxiliary %s: provider %s unavailable, trying auto-detection chain",
                            task or "call", resolved_provider)
                client, final_model = _get_cached_client("auto", main_runtime=main_runtime)
        if client is None:
            raise RuntimeError(
                f"No LLM provider configured for task={task} provider={resolved_provider}. "
                f"Run: fan setup")

    effective_timeout = _effective_aux_timeout(task, timeout)

    # Log what we're about to do — makes auxiliary operations visible
    _base_info = str(getattr(client, "base_url", resolved_base_url) or "")
    if task:
        logger.info("Auxiliary %s: using %s (%s)%s",
                     task, resolved_provider or "auto", final_model or "default",
                     f" at {_base_info}" if _base_info and "openrouter" not in _base_info else "")

    # Pass the client's actual base_url (not just resolved_base_url) so
    # endpoint-specific temperature overrides can distinguish
    # api.moonshot.ai vs api.kimi.com/coding even on auto-detected routes.
    kwargs = _build_call_kwargs(
        resolved_provider, final_model, messages,
        temperature=temperature, max_tokens=max_tokens,
        tools=tools, timeout=effective_timeout, extra_body=effective_extra_body,
        base_url=_base_info or resolved_base_url)

    try:  # 全量辅助脑请求日志(qwen 视觉等)
        from agent.llm_io_log import log_request
        log_request(f"aux:{task or 'call'}", model=kwargs.get("model", final_model),
                    messages=kwargs.get("messages", messages), tools=kwargs.get("tools"))
    except Exception:
        pass


    # Handle unsupported temperature, max_tokens vs max_completion_tokens retry,
    # then payment fallback.
    try:
        transient_retries = _transient_retry_count()
        for attempt in range(transient_retries + 1):
            try:
                return _validate_llm_response(
                    client.chat.completions.create(**kwargs), task)
            except Exception as transient_err:
                if (
                    not _is_transient_transport_error(transient_err)
                    or attempt >= transient_retries
                ):
                    raise
                # Compression is a blocking recovery path. A full timeout is
                # expensive to repeat against the same provider, so hand it to
                # the configured auxiliary fallback immediately; fast network
                # blips still use the normal same-provider retry.
                if task == "compression" and _is_timeout_error(transient_err):
                    logger.info(
                        "Auxiliary compression timed out; skipping same-provider retry"
                    )
                    raise
                delay = _TRANSIENT_RETRY_BACKOFF_BASE * (2 ** attempt)
                logger.info(
                    "Auxiliary %s: transient transport error; retrying %d/%d "
                    "on the same provider in %.1fs: %s",
                    task or "call", attempt + 1, transient_retries, delay,
                    transient_err,
                )
                time.sleep(delay)
    except Exception as first_err:
        if "temperature" in kwargs and _is_unsupported_temperature_error(first_err):
            retry_kwargs = dict(kwargs)
            retry_kwargs.pop("temperature", None)
            logger.info(
                "Auxiliary %s: provider rejected temperature; retrying once without it",
                task or "call",
            )
            try:
                return _validate_llm_response(
                    client.chat.completions.create(**retry_kwargs), task)
            except Exception as retry_err:
                retry_err_str = str(retry_err)
                # If retry still fails, fall through to the max_tokens /
                # payment / auth chains below using the temperature-stripped
                # kwargs.  Re-raise only if the retry hit something those
                # chains won't handle.
                if not (
                    _is_payment_error(retry_err)
                    or _is_connection_error(retry_err)
                    or _is_auth_error(retry_err)
                    or _is_model_incompatible_error(retry_err)
                    or "max_tokens" in retry_err_str
                    or "unsupported_parameter" in retry_err_str
                ):
                    raise
                first_err = retry_err
                kwargs = retry_kwargs

        err_str = str(first_err)
        # ZAI vision models (glm-4v-flash etc.) return error code 1210
        # ("API 调用参数有误") when max_tokens is passed on multimodal
        # calls.  The error message does NOT contain "max_tokens" so the
        # generic retry below never fires.  Detect the ZAI-specific error
        # and strip max_tokens before retrying.
        _is_zai_param_error = (
            "1210" in err_str
            and "bigmodel" in str(getattr(client, "base_url", ""))
        )
        if max_tokens is not None and (
            "max_tokens" in err_str
            or "unsupported_parameter" in err_str
            or _is_unsupported_parameter_error(first_err, "max_tokens")
            or _is_zai_param_error
        ):
            kwargs.pop("max_tokens", None)
            kwargs.pop("max_completion_tokens", None)
            try:
                return _validate_llm_response(
                    client.chat.completions.create(**kwargs), task)
            except Exception as retry_err:
                # If the max_tokens retry also hits a payment or connection
                # error, fall through to the fallback chain below.
                if not (
                    _is_payment_error(retry_err)
                    or _is_connection_error(retry_err)
                    or _is_rate_limit_error(retry_err)
                    or _is_model_incompatible_error(retry_err)
                ):
                    raise
                first_err = retry_err

        # ── Auth refresh retry ───────────────────────────────────────
        if (_is_auth_error(first_err)
                and resolved_provider not in {"auto", "", None}):
            if _refresh_provider_credentials(resolved_provider):
                logger.info(
                    "Auxiliary %s: refreshed %s credentials after auth error, retrying",
                    task or "call", resolved_provider,
                )
                return _retry_same_provider_sync(
                    task=task,
                    resolved_provider=resolved_provider,
                    resolved_model=resolved_model,
                    resolved_base_url=resolved_base_url,
                    resolved_api_key=resolved_api_key,
                    resolved_api_mode=resolved_api_mode,
                    main_runtime=main_runtime,
                    final_model=final_model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    effective_timeout=effective_timeout,
                    effective_extra_body=effective_extra_body,
                )

        # ── Same-provider credential-pool recovery ─────────────────────
        pool_provider = _recoverable_pool_provider(resolved_provider, client, main_runtime=main_runtime)
        # Capture the exact API key used so mark_exhausted_and_rotate can find
        # the correct pool entry even when another process rotated the pool
        # between this call and recovery (which leaves current()=None and makes
        # _select_unlocked() return the NEXT key by mistake).
        _client_api_key = str(getattr(client, "api_key", "") or "")
        if pool_provider and (_is_auth_error(first_err) or _is_payment_error(first_err) or _is_rate_limit_error(first_err)):
            recovery_err = first_err
            # Skip the extra retry for clear payment/quota errors — the endpoint
            # won't accept another request with the same exhausted key.
            if _is_rate_limit_error(first_err) and not _is_payment_error(first_err):
                try:
                    return _validate_llm_response(
                        client.chat.completions.create(**kwargs), task)
                except Exception as retry_err:
                    if not (_is_auth_error(retry_err) or _is_payment_error(retry_err) or _is_rate_limit_error(retry_err)):
                        raise
                    recovery_err = retry_err
            if _recover_provider_pool(pool_provider, recovery_err, failed_api_key=_client_api_key):
                logger.info(
                    "Auxiliary %s: recovered %s via credential-pool rotation after %s",
                    task or "call", pool_provider, type(recovery_err).__name__,
                )
                try:
                    return _retry_same_provider_sync(
                        task=task,
                        resolved_provider=resolved_provider,
                        resolved_model=resolved_model,
                        resolved_base_url=resolved_base_url,
                        resolved_api_key=resolved_api_key,
                        resolved_api_mode=resolved_api_mode,
                        main_runtime=main_runtime,
                        final_model=final_model,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        tools=tools,
                        effective_timeout=effective_timeout,
                        effective_extra_body=effective_extra_body,
                    )
                except Exception as retry2_err:
                    # The rotated key also hit a quota/auth wall.  Mark it
                    # immediately so concurrent processes don't make a
                    # redundant API call to discover it's exhausted too.
                    # Then fall through to the payment fallback below so
                    # alternative providers can still serve the request.
                    if (_is_payment_error(retry2_err) or _is_auth_error(retry2_err)
                            or _is_rate_limit_error(retry2_err)):
                        _recover_provider_pool(pool_provider, retry2_err)
                        first_err = retry2_err
                    else:
                        raise

        # ── Payment / credit exhaustion fallback ──────────────────────
        # When the resolved provider returns 402 or a credit-related error,
        # try alternative providers instead of giving up.  This handles the
        # common case where a user runs out of OpenRouter credits but has
        # Codex OAuth or another provider available.
        #
        # ── Connection error fallback ────────────────────────────────
        # When a provider endpoint is unreachable (DNS failure, connection
        # refused, timeout), try alternative providers.  This handles stale
        # Codex/OAuth tokens that authenticate but whose endpoint is down,
        # and providers the user never configured that got picked up by
        # the auto-detection chain.
        #
        # ── Rate-limit fallback (#13579) ─────────────────────────────
        # When the provider returns a 429 rate-limit (not billing), fall
        # back to an alternative provider instead of exhausting retries
        # against the same rate-limited endpoint.
        #
        # ── Auth error fallback ──────────────────────────────────────
        # A 401 that could not be refreshed must not silently drop an
        # auto-routed auxiliary operation such as compression.  Authentication
        # is deliberately not a capacity error: an explicitly configured
        # provider still fails visibly instead of being replaced behind the
        # user's back.
        should_fallback = (
            _is_auth_error(first_err)
            or _is_payment_error(first_err)
            or _is_connection_error(first_err)
            or _is_rate_limit_error(first_err)
            or _is_model_incompatible_error(first_err)
            or _is_invalid_aux_response_error(first_err)
        )
        # Respect explicit provider choice for transient errors (auth, request
        # validation, etc.) but allow fallback when the provider clearly cannot
        # serve the request due to capacity: payment/quota exhaustion and
        # connection failures are capacity problems, not request constraints.
        # See #26803: daily token quota (429 + "too many tokens per day") must
        # fall back just like a 402 credit error.
        is_auto = resolved_provider in {"auto", "", None}
        # Capacity errors bypass the explicit-provider gate: the provider
        # literally cannot serve this request regardless of user intent.
        is_capacity_error = (
            _is_payment_error(first_err)
            or _is_connection_error(first_err)
            or _is_rate_limit_error(first_err)
            or _is_model_incompatible_error(first_err)
            or _is_invalid_aux_response_error(first_err)
        )
        if should_fallback and (is_auto or is_capacity_error):
            if _is_auth_error(first_err):
                reason = "auth error"
            elif _is_payment_error(first_err):
                reason = "payment error"
                # Resolve the actual provider label (resolved_provider may be
                # "auto"; the client's base_url tells us which backend got the
                # 402). Mark THAT label unhealthy so subsequent aux calls
                # skip it instead of paying another doomed RTT.
                _mark_provider_unhealthy(
                    _recoverable_pool_provider(resolved_provider, client, main_runtime=main_runtime) or resolved_provider
                )
            elif _is_rate_limit_error(first_err):
                reason = "rate limit"
            elif _is_model_incompatible_error(first_err):
                reason = "model incompatible with route"
            elif _is_invalid_aux_response_error(first_err):
                reason = "invalid provider response"
            else:
                reason = "connection error"
            logger.info("Auxiliary %s: %s on %s (%s), trying fallback",
                        task or "call", reason, resolved_provider, first_err)

            # Fallback order (#26882, #26803):
            #   1. User-configured fallback_chain (per-task) if set
            #   2. Main agent model (last-resort safety net)
            # For auto users (no explicit aux provider), use the full
            # auto-detection chain instead — its Step 1 IS the main agent
            # model, so users on `auto` already get main-model fallback.
            fb_client, fb_model, fb_label = (None, None, "")
            if is_auto:
                fb_client, fb_model, fb_label = _try_payment_fallback(
                    resolved_provider, task, reason=reason)
            else:
                fb_client, fb_model, fb_label = _try_configured_fallback_chain(
                    task, resolved_provider or "auto", reason=reason)
                if fb_client is None:
                    fb_client, fb_model, fb_label = _try_main_agent_model_fallback(
                        resolved_provider, task, reason=reason)

            if fb_client is not None:
                fb_response = _call_fallback_candidate_sync(
                    fb_client,
                    fb_model,
                    fb_label,
                    task=task,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    effective_timeout=effective_timeout,
                    effective_extra_body=effective_extra_body,
                )
                if fb_response is not None:
                    return fb_response

                # A fallback's credential can be stale independently of the
                # provider that triggered recovery. Re-select after
                # quarantining it so another configured/automatic candidate
                # can still complete the auxiliary task.
                if is_auto:
                    fb_client, fb_model, fb_label = _try_payment_fallback(
                        resolved_provider,
                        task,
                        reason="stale fallback credential",
                    )
                else:
                    fb_client, fb_model, fb_label = _try_configured_fallback_chain(
                        task,
                        resolved_provider or "auto",
                        reason="stale fallback credential",
                    )
                    if fb_client is None:
                        fb_client, fb_model, fb_label = _try_main_agent_model_fallback(
                            resolved_provider,
                            task,
                            reason="stale fallback credential",
                        )
                if fb_client is not None:
                    fb_response = _call_fallback_candidate_sync(
                        fb_client,
                        fb_model,
                        fb_label,
                        task=task,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        tools=tools,
                        effective_timeout=effective_timeout,
                        effective_extra_body=effective_extra_body,
                    )
                    if fb_response is not None:
                        return fb_response
            # All fallback layers exhausted — emit a single user-visible
            # warning so the operator knows aux task is about to fail.
            # (#26882) The error itself is re-raised below.
            logger.warning(
                "Auxiliary %s: %s on %s and all fallbacks exhausted "
                "(fallback_chain + main agent model). Raising original error.",
                task or "call", reason, resolved_provider,
            )
        # Connection/timeout errors leave the cached client poisoned (closed
        # httpx transport, half-read stream, dead async loop).  Drop it from
        # the cache regardless of whether we found a fallback above so the
        # next auxiliary call rebuilds a fresh client instead of reusing the
        # dead one.  See issue #23432.
        if _is_connection_error(first_err):
            try:
                _evict_cached_client_instance(client)
            except Exception:
                logger.debug("Auxiliary: cache eviction after connection error failed",
                             exc_info=True)
        raise


def extract_content_or_reasoning(response) -> str:
    """Extract content from an LLM response, falling back to reasoning fields.

    Mirrors the main agent loop's behavior when a reasoning model (DeepSeek-R1,
    Qwen-QwQ, etc.) returns ``content=None`` with reasoning in structured fields.

    Resolution order:
      1. ``message.content`` — strip inline think/reasoning blocks, check for
         remaining non-whitespace text.
      2. ``message.reasoning`` / ``message.reasoning_content`` — direct
         structured reasoning fields (DeepSeek, Moonshot, NovitaAI, etc.).
      3. ``message.reasoning_details`` — OpenRouter unified array format.

    Returns the best available text, or ``""`` if nothing found.
    """
    import re

    msg = response.choices[0].message
    content = (msg.content or "").strip()

    if content:
        # Strip inline think/reasoning blocks (mirrors _strip_think_blocks)
        cleaned = re.sub(
            r"<(?:think|thinking|reasoning|thought|REASONING_SCRATCHPAD)>"
            r".*?"
            r"</(?:think|thinking|reasoning|thought|REASONING_SCRATCHPAD)>",
            "", content, flags=re.DOTALL | re.IGNORECASE,
        ).strip()
        if cleaned:
            return cleaned

    # Content is empty or reasoning-only — try structured reasoning fields
    reasoning_parts: list[str] = []
    for field in ("reasoning", "reasoning_content"):
        val = getattr(msg, field, None)
        if val and isinstance(val, str) and val.strip() and val not in reasoning_parts:
            reasoning_parts.append(val.strip())

    details = getattr(msg, "reasoning_details", None)
    if details and isinstance(details, list):
        for detail in details:
            if isinstance(detail, dict):
                summary = (
                    detail.get("summary")
                    or detail.get("content")
                    or detail.get("text")
                )
                if summary and summary not in reasoning_parts:
                    reasoning_parts.append(summary.strip() if isinstance(summary, str) else str(summary))

    if reasoning_parts:
        return "\n\n".join(reasoning_parts)

    return ""


async def async_call_llm(
    task: str = None,
    *,
    provider: str = None,
    model: str = None,
    base_url: str = None,
    api_key: str = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    messages: list,
    temperature: float = None,
    max_tokens: int = None,
    tools: list = None,
    timeout: float = None,
    extra_body: dict = None,
) -> Any:
    """Centralized asynchronous LLM call.

    Same as call_llm() but async. See call_llm() for full documentation.

    所有权边界:本次调用期间由 ``_to_async_client`` 新建的每个 AsyncOpenAI
    (vision 主路 + 各 fallback 路)都会登记进 ``_owned_async_clients``,
    并在此处、【同一事件循环内】统一 close。缓存客户端(_get_cached_client)
    不经 _to_async_client 新建,不受影响。
    """
    bucket: list = []
    token = _owned_async_clients.set(bucket)
    try:
        return await _async_call_llm_impl(
            task,
            provider=provider, model=model, base_url=base_url, api_key=api_key,
            main_runtime=main_runtime, messages=messages, temperature=temperature,
            max_tokens=max_tokens, tools=tools, timeout=timeout, extra_body=extra_body,
        )
    finally:
        _owned_async_clients.reset(token)
        for owned in bucket:
            try:
                await owned.close()
            except Exception:  # noqa: BLE001 — close 尽力而为,绝不吞掉主结果/主异常
                pass


async def _async_call_llm_impl(
    task: str = None,
    *,
    provider: str = None,
    model: str = None,
    base_url: str = None,
    api_key: str = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    messages: list,
    temperature: float = None,
    max_tokens: int = None,
    tools: list = None,
    timeout: float = None,
    extra_body: dict = None,
) -> Any:
    """async_call_llm 的实现体(客户端解析/调用/重试/fallback 链)。"""
    resolved_provider, resolved_model, resolved_base_url, resolved_api_key, resolved_api_mode = _resolve_task_provider_model(
        task, provider, model, base_url, api_key)
    effective_extra_body = _get_task_extra_body(task)
    effective_extra_body.update(extra_body or {})

    if task == "vision":
        effective_provider, client, final_model = resolve_vision_provider_client(
            provider=resolved_provider if resolved_provider != "auto" else provider,
            model=resolved_model or model,
            base_url=resolved_base_url or base_url,
            api_key=resolved_api_key or api_key,
            async_mode=True,
        )
        if client is None and resolved_provider != "auto" and not resolved_base_url:
            logger.warning(
                "Vision provider %s unavailable, falling back to auto vision backends",
                resolved_provider,
            )
            effective_provider, client, final_model = resolve_vision_provider_client(
                provider="auto",
                model=resolved_model,
                async_mode=True,
            )
        if client is None:
            raise RuntimeError(
                f"No LLM provider configured for task={task} provider={resolved_provider}. "
                f"Run: fan setup"
            )
        resolved_provider = effective_provider or resolved_provider
    else:
        client, final_model = _get_cached_client(
            resolved_provider,
            resolved_model,
            async_mode=True,
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            api_mode=resolved_api_mode,
        )
        if client is None:
            _explicit = (resolved_provider or "").strip().lower()
            if _explicit and _explicit not in {"auto", "custom"}:
                fb_client, fb_model, fb_label = _try_configured_fallback_for_unavailable_client(
                    task,
                    _explicit,
                )
                if fb_client is not None:
                    client, final_model = _to_async_client(
                        fb_client,
                        fb_model or "",
                        is_vision=(task == "vision"),
                    )
                    resolved_provider = fb_label or resolved_provider
                else:
                    raise RuntimeError(
                        f"Provider '{_explicit}' is set in config.yaml but no API key "
                        f"was found. Set the {_explicit.upper()}_API_KEY environment "
                        f"variable, or switch to a different provider with `fan model`."
                    )
            if client is None and not resolved_base_url:
                logger.info("Auxiliary %s: provider %s unavailable, trying auto-detection chain",
                            task or "call", resolved_provider)
                client, final_model = _get_cached_client("auto", async_mode=True)
        if client is None:
            raise RuntimeError(
                f"No LLM provider configured for task={task} provider={resolved_provider}. "
                f"Run: fan setup")

    effective_timeout = _effective_aux_timeout(task, timeout)

    # Pass the client's actual base_url (not just resolved_base_url) so
    # endpoint-specific temperature overrides can distinguish
    # api.moonshot.ai vs api.kimi.com/coding even on auto-detected routes.
    _client_base = str(getattr(client, "base_url", "") or "")
    kwargs = _build_call_kwargs(
        resolved_provider, final_model, messages,
        temperature=temperature, max_tokens=max_tokens,
        tools=tools, timeout=effective_timeout, extra_body=effective_extra_body,
        base_url=_client_base or resolved_base_url)

    try:  # 全量辅助脑请求日志(async)
        from agent.llm_io_log import log_request
        log_request(f"aux:{task or 'call'}", model=kwargs.get("model", final_model),
                    messages=kwargs.get("messages", messages), tools=kwargs.get("tools"))
    except Exception:
        pass


    try:
        transient_retries = _transient_retry_count()
        for attempt in range(transient_retries + 1):
            try:
                return _validate_llm_response(
                    await client.chat.completions.create(**kwargs), task)
            except Exception as transient_err:
                if (
                    not _is_transient_transport_error(transient_err)
                    or attempt >= transient_retries
                ):
                    raise
                if task == "compression" and _is_timeout_error(transient_err):
                    logger.info(
                        "Auxiliary compression (async) timed out; skipping same-provider retry"
                    )
                    raise
                delay = _TRANSIENT_RETRY_BACKOFF_BASE * (2 ** attempt)
                logger.info(
                    "Auxiliary %s (async): transient transport error; retrying "
                    "%d/%d on the same provider in %.1fs: %s",
                    task or "call", attempt + 1, transient_retries, delay,
                    transient_err,
                )
                import asyncio as _asyncio

                await _asyncio.sleep(delay)
    except Exception as first_err:
        if "temperature" in kwargs and _is_unsupported_temperature_error(first_err):
            retry_kwargs = dict(kwargs)
            retry_kwargs.pop("temperature", None)
            logger.info(
                "Auxiliary %s (async): provider rejected temperature; retrying once without it",
                task or "call",
            )
            try:
                return _validate_llm_response(
                    await client.chat.completions.create(**retry_kwargs), task)
            except Exception as retry_err:
                retry_err_str = str(retry_err)
                if not (
                    _is_payment_error(retry_err)
                    or _is_connection_error(retry_err)
                    or _is_auth_error(retry_err)
                    or _is_model_incompatible_error(retry_err)
                    or "max_tokens" in retry_err_str
                    or "unsupported_parameter" in retry_err_str
                ):
                    raise
                first_err = retry_err
                kwargs = retry_kwargs

        err_str = str(first_err)
        # ZAI vision models (glm-4v-flash etc.) return error code 1210
        # ("API 调用参数有误") when max_tokens is passed on multimodal
        # calls.  The error message does NOT contain "max_tokens" so the
        # generic retry below never fires.  Detect the ZAI-specific error
        # and strip max_tokens before retrying.
        _is_zai_param_error = (
            "1210" in err_str
            and "bigmodel" in str(getattr(client, "base_url", ""))
        )
        if max_tokens is not None and (
            "max_tokens" in err_str
            or "unsupported_parameter" in err_str
            or _is_unsupported_parameter_error(first_err, "max_tokens")
            or _is_zai_param_error
        ):
            kwargs.pop("max_tokens", None)
            kwargs.pop("max_completion_tokens", None)
            try:
                return _validate_llm_response(
                    await client.chat.completions.create(**kwargs), task)
            except Exception as retry_err:
                # If the max_tokens retry also hits a payment or connection
                # error, fall through to the fallback chain below.
                if not (
                    _is_payment_error(retry_err)
                    or _is_connection_error(retry_err)
                    or _is_rate_limit_error(retry_err)
                    or _is_model_incompatible_error(retry_err)
                ):
                    raise
                first_err = retry_err

        # ── Auth refresh retry (mirrors sync call_llm) ───────────────
        if (_is_auth_error(first_err)
                and resolved_provider not in {"auto", "", None}):
            if _refresh_provider_credentials(resolved_provider):
                logger.info(
                    "Auxiliary %s (async): refreshed %s credentials after auth error, retrying",
                    task or "call", resolved_provider,
                )
                return await _retry_same_provider_async(
                    task=task,
                    resolved_provider=resolved_provider,
                    resolved_model=resolved_model,
                    resolved_base_url=resolved_base_url,
                    resolved_api_key=resolved_api_key,
                    resolved_api_mode=resolved_api_mode,
                    final_model=final_model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    effective_timeout=effective_timeout,
                    effective_extra_body=effective_extra_body,
                )

        # ── Same-provider credential-pool recovery (mirrors sync) ─────
        pool_provider = _recoverable_pool_provider(resolved_provider, client, main_runtime=main_runtime)
        _client_api_key = str(getattr(client, "api_key", "") or "")
        if pool_provider and (_is_auth_error(first_err) or _is_payment_error(first_err) or _is_rate_limit_error(first_err)):
            recovery_err = first_err
            # Skip the extra retry for clear payment/quota errors — the endpoint
            # won't accept another request with the same exhausted key.
            if _is_rate_limit_error(first_err) and not _is_payment_error(first_err):
                try:
                    return _validate_llm_response(
                        await client.chat.completions.create(**kwargs), task)
                except Exception as retry_err:
                    if not (_is_auth_error(retry_err) or _is_payment_error(retry_err) or _is_rate_limit_error(retry_err)):
                        raise
                    recovery_err = retry_err
            if _recover_provider_pool(pool_provider, recovery_err, failed_api_key=_client_api_key):
                logger.info(
                    "Auxiliary %s (async): recovered %s via credential-pool rotation after %s",
                    task or "call", pool_provider, type(recovery_err).__name__,
                )
                try:
                    return await _retry_same_provider_async(
                        task=task,
                        resolved_provider=resolved_provider,
                        resolved_model=resolved_model,
                        resolved_base_url=resolved_base_url,
                        resolved_api_key=resolved_api_key,
                        resolved_api_mode=resolved_api_mode,
                        final_model=final_model,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        tools=tools,
                        effective_timeout=effective_timeout,
                        effective_extra_body=effective_extra_body,
                    )
                except Exception as retry2_err:
                    if (_is_payment_error(retry2_err) or _is_auth_error(retry2_err)
                            or _is_rate_limit_error(retry2_err)):
                        _recover_provider_pool(pool_provider, retry2_err)
                        first_err = retry2_err
                    else:
                        raise

        # ── Payment / connection / rate-limit/auth fallback (mirrors sync) ──
        # An unrecoverable 401 follows fallbacks only in auto mode; it remains
        # distinct from capacity failures so an explicit provider choice is
        # never silently overridden.
        should_fallback = (
            _is_auth_error(first_err)
            or _is_payment_error(first_err)
            or _is_connection_error(first_err)
            or _is_rate_limit_error(first_err)
            or _is_model_incompatible_error(first_err)
            or _is_invalid_aux_response_error(first_err)
        )
        # Capacity errors (payment/quota/connection) bypass the explicit-provider
        # gate — the provider cannot serve the request regardless of user intent.
        # See #26803: daily token quota must fall back like a 402 credit error.
        is_auto = resolved_provider in {"auto", "", None}
        is_capacity_error = (
            _is_payment_error(first_err)
            or _is_connection_error(first_err)
            or _is_rate_limit_error(first_err)
            or _is_model_incompatible_error(first_err)
            or _is_invalid_aux_response_error(first_err)
        )
        if should_fallback and (is_auto or is_capacity_error):
            if _is_auth_error(first_err):
                reason = "auth error"
            elif _is_payment_error(first_err):
                reason = "payment error"
                _mark_provider_unhealthy(
                    _recoverable_pool_provider(resolved_provider, client) or resolved_provider
                )
            elif _is_rate_limit_error(first_err):
                reason = "rate limit"
            elif _is_model_incompatible_error(first_err):
                reason = "model incompatible with route"
            elif _is_invalid_aux_response_error(first_err):
                reason = "invalid provider response"
            else:
                reason = "connection error"
            logger.info("Auxiliary %s (async): %s on %s (%s), trying fallback",
                        task or "call", reason, resolved_provider, first_err)

            # Fallback order (#26882, #26803):
            #   1. User-configured fallback_chain (per-task) if set
            #   2. Main agent model (last-resort safety net)
            # Auto users get the full auto-detection chain instead — its
            # Step 1 IS the main agent model.
            fb_client, fb_model, fb_label = (None, None, "")
            if is_auto:
                fb_client, fb_model, fb_label = _try_payment_fallback(
                    resolved_provider, task, reason=reason)
            else:
                fb_client, fb_model, fb_label = _try_configured_fallback_chain(
                    task, resolved_provider or "auto", reason=reason)
                if fb_client is None:
                    fb_client, fb_model, fb_label = _try_main_agent_model_fallback(
                        resolved_provider, task, reason=reason)

            if fb_client is not None:
                # Convert sync fallback client to async
                async_fb, async_fb_model = _to_async_client(
                    fb_client, fb_model or "", is_vision=(task == "vision")
                )
                fb_response = await _call_fallback_candidate_async(
                    async_fb,
                    async_fb_model or fb_model,
                    fb_label,
                    task=task,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    effective_timeout=effective_timeout,
                    effective_extra_body=effective_extra_body,
                )
                if fb_response is not None:
                    return fb_response

                if is_auto:
                    fb_client, fb_model, fb_label = _try_payment_fallback(
                        resolved_provider,
                        task,
                        reason="stale fallback credential",
                    )
                else:
                    fb_client, fb_model, fb_label = _try_configured_fallback_chain(
                        task,
                        resolved_provider or "auto",
                        reason="stale fallback credential",
                    )
                    if fb_client is None:
                        fb_client, fb_model, fb_label = _try_main_agent_model_fallback(
                            resolved_provider,
                            task,
                            reason="stale fallback credential",
                        )
                if fb_client is not None:
                    async_fb, async_fb_model = _to_async_client(
                        fb_client, fb_model or "", is_vision=(task == "vision")
                    )
                    fb_response = await _call_fallback_candidate_async(
                        async_fb,
                        async_fb_model or fb_model,
                        fb_label,
                        task=task,
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        tools=tools,
                        effective_timeout=effective_timeout,
                        effective_extra_body=effective_extra_body,
                    )
                    if fb_response is not None:
                        return fb_response
            # All fallback layers exhausted — warn before re-raising. (#26882)
            logger.warning(
                "Auxiliary %s (async): %s on %s and all fallbacks exhausted "
                "(fallback_chain + main agent model). Raising original error.",
                task or "call", reason, resolved_provider,
            )
        # Mirror the sync path: drop poisoned clients on connection/timeout
        # so the next aux call rebuilds.  See issue #23432.
        if _is_connection_error(first_err):
            try:
                _evict_cached_client_instance(client)
            except Exception:
                logger.debug("Auxiliary (async): cache eviction after connection error failed",
                             exc_info=True)
        raise
