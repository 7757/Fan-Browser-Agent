"""Ollama Cloud provider profile."""

from __future__ import annotations

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile


class OllamaCloudProfile(ProviderProfile):
    """Map Fan reasoning effort to Ollama Cloud's top-level parameter."""

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict | None = None,
        **ctx: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        top_level: dict[str, Any] = {}
        if reasoning_config and isinstance(reasoning_config, dict):
            if reasoning_config.get("enabled", True) is False:
                return {}, {}
            effort = str(reasoning_config.get("effort") or "").strip().lower()
            if not effort or effort == "none":
                return {}, {}
            top_level["reasoning_effort"] = (
                "max" if effort in {"xhigh", "max"} else effort
            )
        return {}, top_level


ollama_cloud = OllamaCloudProfile(
    name="ollama-cloud",
    aliases=("ollama_cloud",),
    default_aux_model="nemotron-3-nano:30b",
    env_vars=("OLLAMA_API_KEY",),
    base_url="https://ollama.com/v1",
)

register_provider(ollama_cloud)
