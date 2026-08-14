"""DeepSeek official API provider profile."""

from __future__ import annotations

from typing import Any

from providers import register_provider
from providers.base import OMIT_TEMPERATURE, ProviderProfile


class DeepSeekProfile(ProviderProfile):
    """Translate Fan reasoning controls to DeepSeek V4's OpenAI wire format."""

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict | None = None,
        **ctx: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        enabled = True
        effort = ""
        if isinstance(reasoning_config, dict):
            enabled = reasoning_config.get("enabled") is not False
            effort = str(reasoning_config.get("effort") or "").strip().lower()

        extra_body = {
            "thinking": {"type": "enabled" if enabled else "disabled"},
        }
        top_level: dict[str, Any] = {}
        if enabled and effort:
            top_level["reasoning_effort"] = (
                "max" if effort in {"xhigh", "max", "ultra"} else "high"
            )
        return extra_body, top_level


deepseek = DeepSeekProfile(
    name="deepseek",
    aliases=("deepseek-api",),
    display_name="DeepSeek",
    description="DeepSeek official API",
    signup_url="https://platform.deepseek.com/api_keys",
    env_vars=("DEEPSEEK_API_KEY",),
    base_url="https://api.deepseek.com",
    models_url="https://api.deepseek.com/models",
    default_aux_model="deepseek-v4-flash",
    fallback_models=("deepseek-v4-flash", "deepseek-v4-pro"),
    fixed_temperature=OMIT_TEMPERATURE,
    supports_vision=False,
)

register_provider(deepseek)
