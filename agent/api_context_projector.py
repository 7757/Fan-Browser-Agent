"""Cache-stable projection of old tool output for provider requests.

The canonical transcript is the product record: it feeds SQLite, resume, and
the desktop UI.  It must therefore retain the complete tool output.  The model
request does not need every old multi-kilobyte DOM/file/search result on every
iteration, though.

This projector computes the set of old results to compact once at the start of
each *user turn*.  The mapping is then frozen for every API call in that turn.
That detail matters for implicit prefix caches: a sliding token boundary would
rewrite one older message after every tool call and repeatedly invalidate the
cached suffix.  New results produced by the active turn are never added to the
frozen mapping, so the model still receives them in full.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class TurnStableToolResultProjector:
    """Project old tool results without mutating canonical conversation state."""

    def __init__(
        self,
        *,
        protect_tail_count: int = 12,
        protect_tail_tokens: int = 16_000,
    ) -> None:
        self.protect_tail_count = max(1, int(protect_tail_count))
        self.protect_tail_tokens = max(1_024, int(protect_tail_tokens))
        self._turn_id: str | None = None
        self._tool_content_by_call_id: dict[str, Any] = {}
        self._tool_args_by_call_id: dict[str, str] = {}

    @staticmethod
    def _tool_call_id(message: dict[str, Any]) -> str:
        value = message.get("tool_call_id")
        return str(value) if value not in (None, "") else ""

    @staticmethod
    def _assistant_calls(message: dict[str, Any]) -> list[Any]:
        calls = message.get("tool_calls")
        return calls if isinstance(calls, list) else []

    @staticmethod
    def _dict_call_parts(call: Any) -> tuple[str, str] | None:
        if not isinstance(call, dict):
            return None
        call_id = str(call.get("id") or "")
        function = call.get("function")
        if not call_id or not isinstance(function, dict):
            return None
        arguments = function.get("arguments")
        return call_id, arguments if isinstance(arguments, str) else ""

    def _freeze_turn_mapping(
        self,
        api_messages: list[dict[str, Any]],
        *,
        turn_id: str,
        compressor: Any,
    ) -> None:
        self._turn_id = turn_id
        self._tool_content_by_call_id = {}
        self._tool_args_by_call_id = {}

        prune = getattr(compressor, "_prune_old_tool_results", None)
        if not callable(prune):
            return

        projected, _count = prune(
            api_messages,
            protect_tail_count=self.protect_tail_count,
            protect_tail_tokens=self.protect_tail_tokens,
        )
        if not isinstance(projected, list) or len(projected) != len(api_messages):
            return

        for original, compacted in zip(api_messages, projected):
            if not isinstance(original, dict) or not isinstance(compacted, dict):
                continue
            role = original.get("role")
            if role == "tool" and original.get("content") != compacted.get("content"):
                call_id = self._tool_call_id(original)
                if call_id:
                    self._tool_content_by_call_id[call_id] = compacted.get("content")
                continue
            if role != "assistant":
                continue

            original_calls = {
                parts[0]: parts[1]
                for call in self._assistant_calls(original)
                if (parts := self._dict_call_parts(call)) is not None
            }
            for call in self._assistant_calls(compacted):
                parts = self._dict_call_parts(call)
                if parts is None:
                    continue
                call_id, arguments = parts
                if call_id in original_calls and arguments != original_calls[call_id]:
                    self._tool_args_by_call_id[call_id] = arguments

        changed = len(self._tool_content_by_call_id) + len(self._tool_args_by_call_id)
        if changed:
            logger.info(
                "[context-cost] froze %d old tool projection(s) for turn %s; "
                "tail=%d messages/~%d tokens",
                changed,
                turn_id,
                self.protect_tail_count,
                self.protect_tail_tokens,
            )

    def project(
        self,
        api_messages: list[dict[str, Any]],
        *,
        turn_id: str | None,
        compressor: Any,
    ) -> list[dict[str, Any]]:
        """Return an API-only projection, stable for all calls in ``turn_id``."""
        if not isinstance(api_messages, list) or not api_messages:
            return api_messages

        stable_turn_id = str(turn_id or "")
        # A missing turn identifier cannot safely share state with a later call.
        # Recomputing is conservative and only affects non-standard callers.
        if not stable_turn_id or stable_turn_id != self._turn_id:
            self._freeze_turn_mapping(
                api_messages,
                turn_id=stable_turn_id,
                compressor=compressor,
            )

        if not self._tool_content_by_call_id and not self._tool_args_by_call_id:
            return api_messages

        transformed: list[dict[str, Any]] | None = None
        for index, message in enumerate(api_messages):
            if not isinstance(message, dict):
                continue
            replacement: dict[str, Any] | None = None
            if message.get("role") == "tool":
                call_id = self._tool_call_id(message)
                if call_id in self._tool_content_by_call_id:
                    replacement = {
                        **message,
                        "content": self._tool_content_by_call_id[call_id],
                    }
            elif message.get("role") == "assistant" and message.get("tool_calls"):
                calls: list[Any] = []
                changed = False
                for call in self._assistant_calls(message):
                    parts = self._dict_call_parts(call)
                    if parts is None or parts[0] not in self._tool_args_by_call_id:
                        calls.append(call)
                        continue
                    function = call["function"]
                    calls.append({
                        **call,
                        "function": {
                            **function,
                            "arguments": self._tool_args_by_call_id[parts[0]],
                        },
                    })
                    changed = True
                if changed:
                    replacement = {**message, "tool_calls": calls}

            if replacement is None:
                continue
            if transformed is None:
                transformed = list(api_messages)
            transformed[index] = replacement

        return transformed if transformed is not None else api_messages
