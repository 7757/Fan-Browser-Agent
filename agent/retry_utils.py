"""Retry utilities — jittered backoff for decorrelated retries.

Replaces fixed exponential backoff with jittered delays to prevent
thundering-herd retry spikes when multiple sessions hit the same
rate-limited provider concurrently.
"""

import random
import threading
import time
from typing import Any

# Monotonic counter for jitter seed uniqueness within the same process.
# Protected by a lock to avoid race conditions in concurrent retry paths
# (e.g. multiple gateway sessions retrying simultaneously).
_jitter_counter = 0
_jitter_lock = threading.Lock()

# Z.AI Coding Plan's GLM-5.2 endpoint returns a distinct overload 429 (code
# 1305) for an otherwise valid request. After a few normal retries, widen the
# wait window instead of hammering the same overloaded service.
_ZAI_CODING_OVERLOAD_LONG_BACKOFF = (30.0, 60.0, 90.0, 120.0)
_ZAI_CODING_OVERLOAD_SHORT_ATTEMPTS = 3


def jittered_backoff(
    attempt: int,
    *,
    base_delay: float = 5.0,
    max_delay: float = 120.0,
    jitter_ratio: float = 0.5,
) -> float:
    """Compute a jittered exponential backoff delay.

    Args:
        attempt: 1-based retry attempt number.
        base_delay: Base delay in seconds for attempt 1.
        max_delay: Maximum delay cap in seconds.
        jitter_ratio: Fraction of computed delay to use as random jitter
            range.  0.5 means jitter is uniform in [0, 0.5 * delay].

    Returns:
        Delay in seconds: min(base * 2^(attempt-1), max_delay) + jitter.

    The jitter decorrelates concurrent retries so multiple sessions
    hitting the same provider don't all retry at the same instant.
    """
    global _jitter_counter
    with _jitter_lock:
        _jitter_counter += 1
        tick = _jitter_counter

    exponent = max(0, attempt - 1)
    if exponent >= 63 or base_delay <= 0:
        delay = max_delay
    else:
        delay = min(base_delay * (2 ** exponent), max_delay)

    # Seed from time + counter for decorrelation even with coarse clocks.
    seed = (time.time_ns() ^ (tick * 0x9E3779B9)) & 0xFFFFFFFF
    rng = random.Random(seed)
    jitter = rng.uniform(0, jitter_ratio * delay)

    return delay + jitter


def _error_text(error: Any) -> str:
    """Return a best-effort flattened provider error for narrow retry rules."""
    parts = (
        error,
        getattr(error, "message", None),
        getattr(error, "body", None),
        getattr(error, "response", None),
    )
    return " ".join(str(part) for part in parts if part is not None).lower()


def is_zai_coding_overload_error(
    *, base_url: str | None, model: str | None, error: Any
) -> bool:
    """Match only Z.AI Coding Plan's transient GLM-5.2 overload response."""
    base = (base_url or "").lower()
    model_name = (model or "").lower()
    status = getattr(error, "status_code", None)
    text = _error_text(error)
    return (
        status == 429
        and "api.z.ai/api/coding/paas/v4" in base
        and "glm-5.2" in model_name
        and ("1305" in text or "temporarily overloaded" in text)
    )


def adaptive_rate_limit_backoff(
    attempt: int,
    *,
    base_url: str | None,
    model: str | None,
    error: Any,
    default_wait: float,
    short_attempts: int = _ZAI_CODING_OVERLOAD_SHORT_ATTEMPTS,
) -> tuple[float, str | None]:
    """Apply the Z.AI overload backoff schedule or retain ``default_wait``."""
    if not is_zai_coding_overload_error(
        base_url=base_url, model=model, error=error
    ):
        return default_wait, None
    if attempt <= short_attempts:
        return default_wait, "zai_coding_overload_short"

    index = min(
        attempt - short_attempts - 1,
        len(_ZAI_CODING_OVERLOAD_LONG_BACKOFF) - 1,
    )
    delay = _ZAI_CODING_OVERLOAD_LONG_BACKOFF[index]
    return (
        jittered_backoff(
            1,
            base_delay=delay,
            max_delay=delay,
            jitter_ratio=0.2,
        ),
        "zai_coding_overload_long",
    )


def zai_coding_overload_retry_ceiling(
    short_attempts: int = _ZAI_CODING_OVERLOAD_SHORT_ATTEMPTS,
) -> int:
    """Return a retry ceiling that makes every long overload wait reachable."""
    return short_attempts + len(_ZAI_CODING_OVERLOAD_LONG_BACKOFF) + 1
