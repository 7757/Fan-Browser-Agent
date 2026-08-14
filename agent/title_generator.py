"""Auto-generate short session titles from the first user/assistant exchange.

Runs asynchronously after the first response is delivered so it never
adds latency to the user-facing reply.
"""

import logging
import threading
from typing import Callable, Optional

from agent.auxiliary_client import call_llm

logger = logging.getLogger(__name__)

# Callback signature: (task_name, exception) -> None. Used to surface
# auxiliary failures to the user through AIAgent._emit_auxiliary_failure
# so silent-drops (e.g. OpenRouter 402 exhausting the fallback chain)
# become visible instead of piling up as NULL session titles.
FailureCallback = Callable[[str, BaseException], None]
TitleCallback = Callable[[str], None]


def should_auto_title_turn(status: str, user_message: str, assistant_response: str) -> bool:
    """Return whether a terminal desktop turn can seed an automatic title.

    An interrupted turn may already contain a useful, persisted opening
    exchange (for example after the browser has navigated).  Treating only a
    fully completed turn as eligible permanently strands those sessions with a
    NULL title, so the desktop falls back to the often-duplicated first prompt.
    Real failures remain ineligible; they should not be named from an error
    response.
    """
    return (
        status in {"complete", "interrupted"}
        and bool(user_message and user_message.strip())
        and bool(assistant_response and assistant_response.strip())
    )


def set_auto_generated_title(session_db, session_id: str, title: str) -> Optional[str]:
    """Persist an automatic title, disambiguating repeated user intents.

    Manual titles retain SessionDB's strict uniqueness contract. Automatic
    titles may naturally collide when a user retries the same task, so suffix
    only that path with ``#2``, ``#3``, and so on.
    """
    for sequence in range(1, 100):
        suffix = "" if sequence == 1 else f" #{sequence}"
        candidate = f"{title[: 100 - len(suffix)]}{suffix}"
        try:
            return candidate if session_db.set_session_title(session_id, candidate) else None
        except ValueError as exc:
            if "already in use" not in str(exc):
                raise
    return None

_TITLE_PROMPT = (
    "Generate a short conversation title for the opening exchange below — a few "
    "words (at most ~7), in the same language as the conversation.\n\n"
    "Judge the USER's intent from their own messages; the assistant's reply is only "
    "context, never the source of the topic. Match the title to what the user has "
    "actually expressed — do not inflate a greeting or small talk into a concrete "
    "task, and do not pull in topics the assistant merely offered, guessed, or "
    "suggested. Stay neutral and faithful: when the user hasn't raised anything "
    "specific yet, keep the title general instead of inventing a subject.\n\n"
    "Return ONLY the title text — no quotes, no trailing punctuation, no prefixes."
)


def generate_title(
    user_message: str,
    assistant_response: str,
    timeout: Optional[float] = None,
    failure_callback: Optional[FailureCallback] = None,
    main_runtime: dict = None,
) -> Optional[str]:
    """Generate a session title from the first exchange.

    Uses the main runtime's model when available, falling back to the
    auxiliary LLM client (cheapest/fastest available model).
    Returns the title string or None on failure.

    ``failure_callback`` is invoked with ``(task, exception)`` when the
    auxiliary call raises — the caller typically wires this to
    ``AIAgent._emit_auxiliary_failure`` so the user sees a warning instead
    of silently accumulating untitled sessions.
    """
    # Truncate long messages to keep the request small
    user_snippet = user_message[:500] if user_message else ""
    assistant_snippet = assistant_response[:500] if assistant_response else ""

    messages = [
        {"role": "system", "content": _TITLE_PROMPT},
        {"role": "user", "content": f"User: {user_snippet}\n\nAssistant: {assistant_snippet}"},
    ]

    try:
        response = call_llm(
            task="title_generation",
            messages=messages,
            max_tokens=500,
            temperature=0.3,
            timeout=timeout,
            main_runtime=main_runtime,
        )
        title = (response.choices[0].message.content or "").strip()
        # Clean up: remove quotes, trailing punctuation, prefixes like "Title: "
        title = title.strip('"\'')
        if title.lower().startswith("title:"):
            title = title[6:].strip()
        # Enforce reasonable length
        if len(title) > 80:
            title = title[:77] + "..."
        return title if title else None
    except Exception as e:
        # Log at WARNING so this shows up in agent.log without debug mode.
        # Full detail at debug level for operators who need the stack.
        logger.warning("Title generation failed: %s", e)
        logger.debug("Title generation traceback", exc_info=True)
        if failure_callback is not None:
            try:
                failure_callback("title generation", e)
            except Exception:
                logger.debug("Title generation failure_callback raised", exc_info=True)
        return None


def auto_title_session(
    session_db,
    session_id: str,
    user_message: str,
    assistant_response: str,
    failure_callback: Optional[FailureCallback] = None,
    main_runtime: dict = None,
    title_callback: Optional[TitleCallback] = None,
) -> None:
    """Generate and set a session title if one doesn't already exist.

    Called in a background thread after the first exchange completes.
    Silently skips if:
    - session_db is None
    - session already has a title (user-set or previously auto-generated)
    - title generation fails
    """
    if not session_db or not session_id:
        return

    # Check if title already exists (user may have set one via /title before first response)
    try:
        existing = session_db.get_session_title(session_id)
        if existing:
            return
    except Exception:
        return

    title = generate_title(
        user_message, assistant_response, failure_callback=failure_callback, main_runtime=main_runtime
    )
    if not title:
        return

    try:
        resolved_title = set_auto_generated_title(session_db, session_id, title)
        if not resolved_title:
            return
        logger.debug("Auto-generated session title: %s", resolved_title)
        if title_callback is not None:
            try:
                title_callback(resolved_title)
            except Exception:
                logger.debug("Auto-title callback failed", exc_info=True)
    except Exception as e:
        logger.debug("Failed to set auto-generated title: %s", e)


def maybe_auto_title(
    session_db,
    session_id: str,
    user_message: str,
    assistant_response: str,
    conversation_history: list,
    failure_callback: Optional[FailureCallback] = None,
    main_runtime: dict = None,
    title_callback: Optional[TitleCallback] = None,
) -> None:
    """Fire-and-forget title generation after the first exchange.

    Only generates a title when:
    - This appears to be the first user→assistant exchange
    - No title is already set
    """
    if not session_db or not session_id or not user_message or not assistant_response:
        return

    # Count user messages in history to detect first exchange.
    # conversation_history includes the exchange that just happened,
    # so for a first exchange we expect exactly 1 user message
    # (or 2 counting system). Be generous: generate on first 2 exchanges.
    user_msg_count = sum(1 for m in (conversation_history or []) if m.get("role") == "user")
    if user_msg_count > 2:
        return

    thread = threading.Thread(
        target=auto_title_session,
        args=(session_db, session_id, user_message, assistant_response),
        kwargs={
            "failure_callback": failure_callback,
            "main_runtime": main_runtime,
            "title_callback": title_callback,
        },
        daemon=True,
        name="auto-title",
    )
    thread.start()
