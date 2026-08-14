"""Provider identity helpers for the open-source Browser Agent build.

Built-in model providers use OpenAI-compatible transports.  User-defined
``providers`` and ``custom_providers`` entries remain supported for explicit
custom endpoints.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


DEEPSEEK_PROVIDER_ID = "deepseek"
DEEPSEEK_API_BASE = "https://api.deepseek.com"
DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"


@dataclass(frozen=True)
class ProviderOverlay:
    """Built-in provider transport metadata."""

    transport: str = "openai_chat"
    is_aggregator: bool = False
    auth_type: str = "api_key"
    extra_env_vars: Tuple[str, ...] = ()
    base_url_override: str = ""
    base_url_env_var: str = ""


PROVIDER_OVERLAYS: Dict[str, ProviderOverlay] = {
    "alibaba": ProviderOverlay(
        transport="openai_chat",
        base_url_override="https://dashscope.aliyuncs.com/compatible-mode/v1",
        base_url_env_var="DASHSCOPE_BASE_URL",
    ),
    "alibaba-coding-plan": ProviderOverlay(
        transport="openai_chat",
        base_url_override="https://coding-intl.dashscope.aliyuncs.com/v1",
        base_url_env_var="ALIBABA_CODING_PLAN_BASE_URL",
    ),
    "ollama-cloud": ProviderOverlay(
        transport="openai_chat",
        base_url_override="https://ollama.com/v1",
    ),
    DEEPSEEK_PROVIDER_ID: ProviderOverlay(
        transport="openai_chat",
        base_url_override=DEEPSEEK_API_BASE,
        base_url_env_var="DEEPSEEK_BASE_URL",
    ),
    "custom": ProviderOverlay(
        transport="openai_chat",
        base_url_env_var="CUSTOM_BASE_URL",
    ),
}


@dataclass
class ProviderDef:
    """Complete provider definition used by config/model helpers."""

    id: str
    name: str
    transport: str
    api_key_env_vars: Tuple[str, ...]
    base_url: str = ""
    base_url_env_var: str = ""
    is_aggregator: bool = False
    auth_type: str = "api_key"
    doc: str = ""
    source: str = ""


ALIASES: Dict[str, str] = {
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
    "ollama_cloud": "ollama-cloud",
    "deepseek-api": DEEPSEEK_PROVIDER_ID,
    "local": "custom",
    "ollama": "custom",
    "vllm": "custom",
    "llamacpp": "custom",
    "llama.cpp": "custom",
    "llama-cpp": "custom",
}


_LABEL_OVERRIDES: Dict[str, str] = {
    "alibaba": "Alibaba Bailian / DashScope",
    "alibaba-coding-plan": "Alibaba Cloud (Coding Plan)",
    "ollama-cloud": "Ollama Cloud",
    DEEPSEEK_PROVIDER_ID: "DeepSeek",
    "custom": "Custom endpoint",
}


_ENV_VARS: Dict[str, Tuple[str, ...]] = {
    "alibaba": ("DASHSCOPE_API_KEY",),
    "alibaba-coding-plan": (
        "ALIBABA_CODING_PLAN_API_KEY",
        "DASHSCOPE_API_KEY",
    ),
    "ollama-cloud": ("OLLAMA_API_KEY",),
    DEEPSEEK_PROVIDER_ID: (DEEPSEEK_API_KEY_ENV,),
}


PROVIDER_MODELS: Dict[str, Tuple[str, ...]] = {
    "alibaba": ("qwen3-vl-plus", "qwen3.7-max"),
    "alibaba-coding-plan": ("qwen3-vl-plus", "qwen3.7-max"),
    "ollama-cloud": ("nemotron-3-nano:30b",),
    DEEPSEEK_PROVIDER_ID: ("deepseek-v4-flash", "deepseek-v4-pro"),
    "custom": (),
}


PROVIDER_DEFAULT_MODELS: Dict[str, str] = {
    provider_id: models[0]
    for provider_id, models in PROVIDER_MODELS.items()
    if models
}


TRANSPORT_TO_API_MODE: Dict[str, str] = {
    "openai_chat": "chat_completions",
    "codex_responses": "codex_responses",
}


def normalize_provider(name: str) -> str:
    key = (name or "").strip().lower()
    return ALIASES.get(key, key)


def get_provider(name: str) -> Optional[ProviderDef]:
    canonical = normalize_provider(name)
    overlay = PROVIDER_OVERLAYS.get(canonical)
    if overlay is None:
        return None
    return ProviderDef(
        id=canonical,
        name=_LABEL_OVERRIDES.get(canonical, canonical),
        transport=overlay.transport,
        api_key_env_vars=_ENV_VARS.get(canonical, ()) + overlay.extra_env_vars,
        base_url=overlay.base_url_override,
        base_url_env_var=overlay.base_url_env_var,
        is_aggregator=overlay.is_aggregator,
        auth_type=overlay.auth_type,
        source="builtin",
    )


def get_label(provider_id: str) -> str:
    canonical = normalize_provider(provider_id)
    if canonical in _LABEL_OVERRIDES:
        return _LABEL_OVERRIDES[canonical]
    pdef = get_provider(canonical)
    return pdef.name if pdef else canonical


def is_aggregator(provider: str) -> bool:
    pdef = get_provider(provider)
    return pdef.is_aggregator if pdef else False


def determine_api_mode(provider: str, base_url: str = "") -> str:
    pdef = get_provider(provider)
    if pdef is not None:
        return TRANSPORT_TO_API_MODE.get(pdef.transport, "chat_completions")
    return "chat_completions"


def resolve_user_provider(name: str, user_config: Dict[str, Any]) -> Optional[ProviderDef]:
    if not user_config or not isinstance(user_config, dict):
        return None
    entry = user_config.get(name)
    if not isinstance(entry, dict):
        return None

    display_name = entry.get("name", "") or name
    api_url = entry.get("api", "") or entry.get("url", "") or entry.get("base_url", "") or ""
    key_env = entry.get("key_env", "") or ""
    env_vars: List[str] = [key_env] if key_env else []

    return ProviderDef(
        id=name,
        name=display_name,
        transport="openai_chat",
        api_key_env_vars=tuple(env_vars),
        base_url=api_url,
        is_aggregator=False,
        auth_type="api_key",
        source="user-config",
    )


def custom_provider_slug(display_name: str) -> str:
    return "custom:" + display_name.strip().lower().replace(" ", "-")


def resolve_custom_provider(
    name: str,
    custom_providers: Optional[List[Dict[str, Any]]],
) -> Optional[ProviderDef]:
    if not custom_providers or not isinstance(custom_providers, list):
        return None

    requested = (name or "").strip().lower()
    if not requested:
        return None

    bare_custom_fallback = requested == "custom"
    first_valid = None

    for entry in custom_providers:
        if not isinstance(entry, dict):
            continue
        display_name = (entry.get("name") or "").strip()
        api_url = (
            entry.get("base_url", "")
            or entry.get("url", "")
            or entry.get("api", "")
            or ""
        ).strip()
        if not display_name or not api_url:
            continue
        if first_valid is None:
            first_valid = (display_name, api_url)
        slug = custom_provider_slug(display_name)
        if requested not in {display_name.lower(), slug}:
            continue
        return ProviderDef(
            id=slug,
            name=display_name,
            transport="openai_chat",
            api_key_env_vars=(),
            base_url=api_url,
            is_aggregator=False,
            auth_type="api_key",
            source="user-config",
        )

    if bare_custom_fallback and first_valid:
        display_name, api_url = first_valid
        return ProviderDef(
            id=custom_provider_slug(display_name),
            name=display_name,
            transport="openai_chat",
            api_key_env_vars=(),
            base_url=api_url,
            is_aggregator=False,
            auth_type="api_key",
            source="user-config",
        )

    return None


def resolve_provider_full(
    name: str,
    user_providers: Optional[Dict[str, Any]] = None,
    custom_providers: Optional[List[Dict[str, Any]]] = None,
) -> Optional[ProviderDef]:
    raw = (name or "").strip().lower()
    canonical = normalize_provider(raw)

    if user_providers:
        user_pdef = resolve_user_provider(raw, user_providers)
        if user_pdef is not None:
            return user_pdef

    pdef = get_provider(canonical)
    if pdef is not None:
        return pdef

    if user_providers:
        user_pdef = resolve_user_provider(canonical, user_providers)
        if user_pdef is not None:
            return user_pdef

    return resolve_custom_provider(name, custom_providers)
