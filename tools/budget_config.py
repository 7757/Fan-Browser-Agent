"""Configurable budget constants for tool result persistence.

Per-tool resolution: pinned > config overrides > registry > default.
"""

from dataclasses import dataclass, field
from typing import Dict

# Tools whose thresholds must never be overridden.
# read_file=inf prevents infinite persist->read->persist loops.
PINNED_THRESHOLDS: Dict[str, float] = {
    "read_file": float("inf"),
}

# Defaults matching the current hardcoded values in tool_result_storage.py.
# Kept here as the single source of truth; tool_result_storage.py imports these.
DEFAULT_RESULT_SIZE_CHARS: int = 100_000
DEFAULT_TURN_BUDGET_CHARS: int = 200_000
DEFAULT_PREVIEW_SIZE_CHARS: int = 1_500


@dataclass(frozen=True)
class BudgetConfig:
    """Immutable budget constants for the 3-layer tool result persistence system.

    Layer 2 (per-result): resolve_threshold(tool_name) -> threshold in chars.
    Layer 3 (per-turn):   turn_budget -> aggregate char budget across all tool
                          results in a single assistant turn.
    Preview:              preview_size -> inline snippet size after persistence.
    """

    default_result_size: int = DEFAULT_RESULT_SIZE_CHARS
    turn_budget: int = DEFAULT_TURN_BUDGET_CHARS
    preview_size: int = DEFAULT_PREVIEW_SIZE_CHARS
    tool_overrides: Dict[str, int] = field(default_factory=dict)

    def resolve_threshold(self, tool_name: str) -> int | float:
        """Resolve the persistence threshold for a tool.

        Priority: pinned -> tool_overrides -> registry per-tool -> default.
        """
        if tool_name in PINNED_THRESHOLDS:
            return PINNED_THRESHOLDS[tool_name]
        if tool_name in self.tool_overrides:
            return self.tool_overrides[tool_name]
        from tools.registry import registry
        registry_value = registry.get_max_result_size(
            tool_name,
            default=self.default_result_size,
        )
        if registry_value == float("inf"):
            return registry_value
        return min(registry_value, self.default_result_size)


# Default config -- matches current hardcoded behavior exactly.
DEFAULT_BUDGET = BudgetConfig()

_CHARS_PER_TOKEN = 4
_PER_RESULT_WINDOW_FRACTION = 0.15
_PER_TURN_WINDOW_FRACTION = 0.30
_MIN_RESULT_SIZE_CHARS = 8_000
_MIN_TURN_BUDGET_CHARS = 16_000


def budget_for_context_window(context_length: int | None) -> BudgetConfig:
    """Scale tool-output caps to the active model's context window.

    Large models retain the historical limits. Small models receive a
    proportional cap so one tool result or tool batch cannot consume most of
    the prompt before the next provider request.
    """
    if not context_length or context_length <= 0:
        return DEFAULT_BUDGET

    window_chars = context_length * _CHARS_PER_TOKEN
    result_size = int(window_chars * _PER_RESULT_WINDOW_FRACTION)
    turn_size = int(window_chars * _PER_TURN_WINDOW_FRACTION)
    result_size = max(
        _MIN_RESULT_SIZE_CHARS,
        min(result_size, DEFAULT_RESULT_SIZE_CHARS),
    )
    turn_size = max(
        _MIN_TURN_BUDGET_CHARS,
        min(turn_size, DEFAULT_TURN_BUDGET_CHARS),
    )
    return BudgetConfig(
        default_result_size=result_size,
        turn_budget=turn_size,
        preview_size=DEFAULT_PREVIEW_SIZE_CHARS,
    )
