"""Known reasoning-model stale-timeout floors.

Reasoning models can legitimately spend several minutes before emitting their
first visible token.  The floor is only used when a user has not configured a
provider/model timeout explicitly; it prevents Fan's generic stale detector
from treating normal thinking time as a hung request.
"""

from __future__ import annotations

import re
from typing import Optional


# Keep the match set narrow and slug-anchored.  A model that merely contains
# ``o1``/``o3`` in the middle of its name must not inherit a long timeout.
_REASONING_STALE_TIMEOUT_FLOORS: tuple[tuple[str, int], ...] = (
    ("nemotron-3-ultra", 600),
    ("nemotron-3-super", 600),
    ("nemotron-3-nano", 300),
    ("deepseek-r1", 600),
    ("deepseek-reasoner", 600),
    ("deepseek-v4-flash", 600),
    ("deepseek-v4-pro", 600),
    ("qwq-32b", 300),
    ("qwen3", 180),
    ("o1-pro", 600),
    ("o1-preview", 600),
    ("o1-mini", 600),
    ("o1", 600),
    ("o3-pro", 600),
    ("o3-mini", 300),
    ("o3", 600),
    ("o4-mini", 300),
    ("claude-opus-4", 240),
    ("claude-sonnet-4.5", 180),
    ("claude-sonnet-4.6", 180),
    ("grok-4-fast-reasoning", 300),
    ("grok-4.20-reasoning", 300),
    ("grok-4-fast-non-reasoning", 180),
)


def get_reasoning_stale_timeout_floor(model: object) -> Optional[float]:
    """Return a safe stale-timeout floor for a known reasoning model.

    Provider/aggregator prefixes are ignored, so both ``openai/o3-mini`` and
    ``o3-mini`` match.  ``None`` means the generic timeout policy applies.
    """
    if not isinstance(model, str):
        return None
    slug = model.strip().lower().rsplit("/", 1)[-1]
    if not slug:
        return None
    for name, floor in sorted(_REASONING_STALE_TIMEOUT_FLOORS, key=lambda item: -len(item[0])):
        if re.match(rf"^{re.escape(name)}(?:$|[-._])", slug):
            return float(floor)
    return None
