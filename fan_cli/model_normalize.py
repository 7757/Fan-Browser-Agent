"""Per-provider model name normalization.

Different LLM providers expect model identifiers in different formats:

- **Aggregators** (OpenRouter, AI Gateway, Kilo Code) use
  ``vendor/model`` slugs.
- **OpenCode Zen** preserves dots for GPT/GLM/Gemini/Kimi/MiniMax-style
  model IDs.
- **OpenCode Go** preserves dots in model names: ``minimax-m2.7``.
- **DeepSeek** currently exposes ``deepseek-v4-pro`` and
  ``deepseek-v4-flash``.  The retired ``deepseek-chat`` and
  ``deepseek-reasoner`` names are migrated to V4 Flash for existing local
  configurations, while new/unknown names are left intact so the provider can
  return a useful error instead of silently selecting a different model.
- **Custom** and remaining providers pass the name through as-is.

This module centralises that translation so callers can simply write::

    api_model = normalize_model_for_provider(user_input, provider)

"""

from __future__ import annotations

import re
from typing import Optional

# ---------------------------------------------------------------------------
# Vendor prefix mapping
# ---------------------------------------------------------------------------
# Maps the first hyphen-delimited token of a bare model name to the vendor
# slug used by aggregator APIs (OpenRouter, Kilo Code, etc.).
#
# Example: "qwen3.5-plus" -> first token "qwen" -> vendor "qwen"
#          -> aggregator slug: "qwen/qwen3.5-plus"

_VENDOR_PREFIXES: dict[str, str] = {
    "gpt": "openai",
    "o1": "openai",
    "o3": "openai",
    "o4": "openai",
    "gemini": "google",
    "gemma": "google",
    "deepseek": "deepseek",
    "glm": "z-ai",
    "kimi": "moonshotai",
    "minimax": "minimax",
    "grok": "x-ai",
    "qwen": "qwen",
    "mimo": "xiaomi",
    "trinity": "arcee-ai",
    "nemotron": "nvidia",
    "llama": "meta-llama",
    "step": "stepfun",
    "trinity": "arcee-ai",
}

# Providers whose APIs consume vendor/model slugs.
_AGGREGATOR_PROVIDERS: frozenset[str] = frozenset({
    "openrouter",
    "kilocode",
})

# Providers that want bare names with dots preserved.
_STRIP_VENDOR_ONLY_PROVIDERS: frozenset[str] = frozenset({
    "openai-codex",
})

# Providers whose native naming is authoritative -- pass through unchanged.
_AUTHORITATIVE_NATIVE_PROVIDERS: frozenset[str] = frozenset({
    "gemini",
    "huggingface",
})

# Direct providers that accept bare native names but should repair a matching
# provider/ prefix when users copy the aggregator form into config.yaml.
_MATCHING_PREFIX_STRIP_PROVIDERS: frozenset[str] = frozenset({
    "zai",
    "kimi-coding",
    "kimi-coding-cn",
    "minimax",
    "minimax-oauth",
    "minimax-cn",
    "alibaba",
    "qwen-oauth",
    "xiaomi",
    "arcee",
    "ollama-cloud",
    "custom",
})

# Providers whose APIs require lowercase model IDs.  Xiaomi's
# ``api.xiaomimimo.com`` rejects mixed-case names like ``MiMo-V2.5-Pro``
# that users might copy from marketing docs — it only accepts
# ``mimo-v2.5-pro``.  After stripping a matching provider prefix, these
# providers also get ``.lower()`` applied.
_LOWERCASE_MODEL_PROVIDERS: frozenset[str] = frozenset({
    "xiaomi",
})

# ---------------------------------------------------------------------------
# DeepSeek special handling
# ---------------------------------------------------------------------------
# DeepSeek's current API recognises exactly these two model identifiers.
_DEEPSEEK_CANONICAL_MODELS: frozenset[str] = frozenset({
    "deepseek-v4-pro",
    "deepseek-v4-flash",
})

_DEEPSEEK_RETIRED_MODELS: frozenset[str] = frozenset({
    "deepseek-chat",
    "deepseek-reasoner",
})

# First-class V-series IDs (``deepseek-v4-pro``, ``deepseek-v4-flash`` and
# future ``deepseek-v5-*`` variants) are preserved rather than silently
# folded into a different model.
_DEEPSEEK_V_SERIES_RE = re.compile(r"^deepseek-v\d+([-.].+)?$")


def _normalize_for_deepseek(model_name: str) -> str:
    """Map a model input to a DeepSeek-accepted identifier.

    Rules:
    - Already a current canonical (``deepseek-v4-pro`` or
      ``deepseek-v4-flash``) -> pass through.
    - Retired ``deepseek-chat`` / ``deepseek-reasoner`` ->
      ``deepseek-v4-flash`` for local-config compatibility.
    - Matches the V-series pattern ``deepseek-v<digit>...`` -> pass through
      (covers future ``deepseek-v5-*`` and dated variants without a release).
    - Everything else -> pass through, allowing the upstream validation error
      (and future model IDs) to remain visible.

    Args:
        model_name: The bare model name (vendor prefix already stripped).

    Returns:
        A DeepSeek-accepted model identifier.
    """
    bare = _strip_vendor_prefix(model_name).lower()

    if bare in _DEEPSEEK_CANONICAL_MODELS:
        return bare

    if bare in _DEEPSEEK_RETIRED_MODELS:
        return "deepseek-v4-flash"

    # V-series first-class IDs (v4-pro, v4-flash, future v5-*, dated variants)
    if _DEEPSEEK_V_SERIES_RE.match(bare):
        return bare

    return bare


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------

def _strip_vendor_prefix(model_name: str) -> str:
    """Remove a ``vendor/`` prefix if present.

    Examples::

        >>> _strip_vendor_prefix("qwen/qwen3.5-plus")
        'qwen3.5-plus'
        >>> _strip_vendor_prefix("qwen3.5-plus")
        'qwen3.5-plus'
        >>> _strip_vendor_prefix("meta-llama/llama-4-scout")
        'llama-4-scout'
    """
    if "/" in model_name:
        return model_name.split("/", 1)[1]
    return model_name


def _normalize_provider_alias(provider_name: str) -> str:
    """Resolve provider aliases to Fan' canonical ids."""
    raw = (provider_name or "").strip().lower()
    if not raw:
        return raw
    try:
        from fan_cli.providers import normalize_provider

        return normalize_provider(raw)
    except Exception:
        return raw


def _strip_matching_provider_prefix(model_name: str, target_provider: str) -> str:
    """Strip ``provider/`` only when the prefix matches the target provider.

    This prevents arbitrary slash-bearing model IDs from being mangled on
    native providers while still repairing manual config values like
    ``zai/glm-5.1`` for the ``zai`` provider.
    """
    if "/" not in model_name:
        return model_name

    prefix, remainder = model_name.split("/", 1)
    if not prefix.strip() or not remainder.strip():
        return model_name

    normalized_prefix = _normalize_provider_alias(prefix)
    normalized_target = _normalize_provider_alias(target_provider)
    if normalized_prefix and normalized_prefix == normalized_target:
        return remainder.strip()
    return model_name


def detect_vendor(model_name: str) -> Optional[str]:
    """Detect the vendor slug from a bare model name.

    Uses the first hyphen-delimited token of the model name to look up
    the corresponding vendor in ``_VENDOR_PREFIXES``.  Also handles
    case-insensitive matching and special patterns.

    Args:
        model_name: A model name, optionally already including a
            ``vendor/`` prefix.  If a prefix is present it is used
            directly.

    Returns:
        The vendor slug (e.g. ``"qwen"``, ``"openai"``) or ``None``
        if no vendor can be confidently detected.

    Examples::

        >>> detect_vendor("qwen3.5-plus")
        'qwen'
        >>> detect_vendor("gpt-5.4-mini")
        'openai'
        >>> detect_vendor("qwen/qwen3.5-plus")
        'qwen'
        >>> detect_vendor("my-custom-model")
    """
    name = model_name.strip()
    if not name:
        return None

    # If there's already a vendor/ prefix, extract it
    if "/" in name:
        return name.split("/", 1)[0].lower() or None

    name_lower = name.lower()

    # Try first hyphen-delimited token (exact match)
    first_token = name_lower.split("-")[0]
    if first_token in _VENDOR_PREFIXES:
        return _VENDOR_PREFIXES[first_token]

    # Handle patterns where the first token includes version digits,
    # e.g. "qwen3.5-plus" -> first token "qwen3.5", but prefix is "qwen"
    for prefix, vendor in _VENDOR_PREFIXES.items():
        if name_lower.startswith(prefix):
            return vendor

    return None


def _prepend_vendor(model_name: str) -> str:
    """Prepend the detected ``vendor/`` prefix if missing.

    Used for aggregator providers that require ``vendor/model`` format.
    If the name already contains a ``/``, it is returned as-is.
    If no vendor can be detected, the name is returned unchanged
    (aggregators may still accept it or return an error).

    Examples::

        >>> _prepend_vendor("qwen3.5-plus")
        'qwen/qwen3.5-plus'
        >>> _prepend_vendor("qwen/qwen3.5-plus")
        'qwen/qwen3.5-plus'
        >>> _prepend_vendor("my-custom-thing")
        'my-custom-thing'
    """
    if "/" in model_name:
        return model_name

    vendor = detect_vendor(model_name)
    if vendor:
        return f"{vendor}/{model_name}"
    return model_name


# ---------------------------------------------------------------------------
# Main normalisation entry point
# ---------------------------------------------------------------------------

def normalize_model_for_provider(model_input: str, target_provider: str) -> str:
    """Translate a model name into the format the target provider's API expects.

    This is the primary entry point for model name normalisation.  It
    accepts any user-facing model identifier and transforms it for the
    specific provider that will receive the API call.

    Args:
        model_input: The model name as provided by the user or config.
            It may be bare or vendor-prefixed.
        target_provider: The canonical model provider id, e.g.
            ``"openrouter"``, ``"alibaba"``, ``"openai-codex"``,
            ``"deepseek"``, ``"custom"``.  Should already be normalised
            via ``fan_cli.providers.normalize_provider()``.

    Returns:
        The model identifier string that the target provider's API
        expects.

    Raises:
        No exceptions -- always returns a best-effort string.

    Examples::

        >>> normalize_model_for_provider("qwen3.5-plus", "openrouter")
        'qwen/qwen3.5-plus'

        >>> normalize_model_for_provider("openai/gpt-5.4", "openai-codex")
        'gpt-5.4'

        >>> normalize_model_for_provider("minimax-m2.5-free", "opencode-zen")
        'minimax-m2.5-free'

        >>> normalize_model_for_provider("deepseek-chat", "deepseek")
        'deepseek-v4-flash'

        >>> normalize_model_for_provider("deepseek-v4-pro", "deepseek")
        'deepseek-v4-pro'

        >>> normalize_model_for_provider("my-model", "custom")
        'my-model'

        >>> normalize_model_for_provider("MiMo-V2.5-Pro", "xiaomi")
        'mimo-v2.5-pro'
    """
    name = (model_input or "").strip()
    if not name:
        return name

    provider = _normalize_provider_alias(target_provider)

    # --- Aggregators: need vendor/model format ---
    if provider in _AGGREGATOR_PROVIDERS:
        return _prepend_vendor(name)

    # --- OpenCode Zen / OpenCode Go: flat-namespace resellers.
    #     Their /v1/models API returns bare IDs only (no vendor prefix), and
    #     the inference endpoint rejects vendor-prefixed names with HTTP 401
    #     "Model not supported".  Strip ANY leading ``vendor/`` so config
    #     entries like ``minimax/minimax-m2.7`` or ``deepseek/deepseek-v4-flash``
    #     — commonly copied from aggregator slugs into fallback_model lists —
    #     resolve to bare ``minimax-m2.7`` / ``deepseek-v4-flash`` the API
    #     actually serves.  See PR reviewing opencode-go fallback 401s. ---
    if provider in {"opencode-zen", "opencode-go"}:
        if "/" in name:
            _, bare_after_slash = name.split("/", 1)
            name = bare_after_slash.strip() or name
        return name

    # --- openai-codex: strip matching provider prefix, keep dots ---
    if provider in _STRIP_VENDOR_ONLY_PROVIDERS:
        stripped = _strip_matching_provider_prefix(name, provider)
        if stripped == name and name.startswith("openai/"):
            # openai-codex maps openai/gpt-5.4 -> gpt-5.4
            return name.split("/", 1)[1]
        return stripped

    # --- DeepSeek: preserve current V-series names and migrate retired aliases ---
    if provider == "deepseek":
        bare = _strip_matching_provider_prefix(name, provider)
        if "/" in bare:
            return bare
        return _normalize_for_deepseek(bare)

    # --- Direct providers: repair matching provider prefixes only ---
    if provider in _MATCHING_PREFIX_STRIP_PROVIDERS:
        result = _strip_matching_provider_prefix(name, provider)
        # Some providers require lowercase model IDs (e.g. Xiaomi's API
        # rejects "MiMo-V2.5-Pro" but accepts "mimo-v2.5-pro").
        if provider in _LOWERCASE_MODEL_PROVIDERS:
            result = result.lower()
        return result

    # --- Authoritative native providers: preserve user-facing slugs as-is ---
    if provider in _AUTHORITATIVE_NATIVE_PROVIDERS:
        return name

    # --- Custom & all others: pass through as-is ---
    return name


# ---------------------------------------------------------------------------
# Batch / convenience helpers
# ---------------------------------------------------------------------------

