"""Reasoning-timeout detection and user-facing recovery guidance."""

from __future__ import annotations

from agent.reasoning_timeouts import get_reasoning_stale_timeout_floor


_TRANSPORT_KILL_MARKERS = (
    "broken pipe",
    "errno 32",
    "remote protocol",
    "connection reset",
    "connection lost",
    "peer closed",
    "server disconnected",
)


def is_thinking_timeout(classified: object, model: object, error_message: object) -> bool:
    """Whether a known reasoning model likely hit a proxy idle timeout."""
    reason = getattr(getattr(classified, "reason", None), "value", None)
    if reason != "timeout" or get_reasoning_stale_timeout_floor(model) is None:
        return False
    message = str(error_message or "").lower()
    return any(marker in message for marker in _TRANSPORT_KILL_MARKERS)


def build_thinking_timeout_guidance(provider: object, model: object) -> str:
    """Return a configuration-safe explanation for a terminal timeout."""
    provider_name = str(provider or "provider")
    model_name = str(model or "model")
    return (
        "\n\nThis reasoning model may have been interrupted by the upstream gateway's "
        "idle timeout before it produced its first result. This is not a context "
        "overflow. Try the following in order:\n"
        f"1. Set `stale_timeout_seconds: 900` for "
        f"`providers.{provider_name}.models.{model_name}` in `~/.fan/config.yaml`;\n"
        "2. Lower reasoning_budget or reasoning_effort;\n"
        "3. Use a faster or smaller reasoning model."
    )
