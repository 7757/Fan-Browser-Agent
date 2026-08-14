"""OpenAI Chat Completions transport.

Handles the default api_mode ('chat_completions') used by ~16 OpenAI-compatible
providers (OpenRouter, NVIDIA, Qwen, Ollama, DeepSeek, xAI, Kimi, etc.).

Messages and tools are already in OpenAI format — convert_messages and
convert_tools are near-identity.  The complexity lives in build_kwargs
which has provider-specific conditionals for max_tokens defaults,
reasoning configuration, temperature handling, and extra_body assembly.
"""

import copy
from typing import Any, Dict

from agent.lmstudio_reasoning import resolve_lmstudio_effort
from agent.moonshot_schema import is_moonshot_model, sanitize_moonshot_tools
from agent.transports.base import ProviderTransport
from agent.transports.types import NormalizedResponse, ToolCall, Usage


def _reasoning_config_for_model(model: str, reasoning_config: dict | None) -> dict | None:
    """Return a provider-wire-compatible reasoning config for this model."""
    if not isinstance(reasoning_config, dict):
        return reasoning_config
    if (
        "gpt-5.6" in (model or "").lower()
        and str(reasoning_config.get("effort") or "").strip().lower() == "ultra"
    ):
        normalized = dict(reasoning_config)
        # Ultra is a Fan product tier; the compatible wire value is max.
        normalized["effort"] = "max"
        return normalized
    return reasoning_config


def _build_gemini_thinking_config(model: str, reasoning_config: dict | None) -> dict | None:
    """Translate Fan/OpenRouter-style reasoning config to Gemini thinkingConfig."""
    if reasoning_config is None or not isinstance(reasoning_config, dict):
        return None

    normalized_model = (model or "").strip().lower()
    if normalized_model.startswith("google/"):
        normalized_model = normalized_model.split("/", 1)[1]

    # ``thinking_config`` is a Gemini-only request parameter. The same
    # ``gemini`` provider also serves Gemma (and historically PaLM/Bard);
    # those reject the field with HTTP 400 "Unknown name 'thinking_config':
    # Cannot find field" — including the polite ``{"includeThoughts": False}``
    # form. Omit the field entirely on non-Gemini models. (#17426)
    if not normalized_model.startswith("gemini"):
        return None

    if reasoning_config.get("enabled") is False:
        # Gemini can hide thought parts even when internal thinking still
        # happens; omit thinkingLevel to avoid model-specific validation quirks.
        return {"includeThoughts": False}

    effort = str(reasoning_config.get("effort", "medium") or "medium").strip().lower()
    if effort == "none":
        return {"includeThoughts": False}

    thinking_config: Dict[str, Any] = {"includeThoughts": True}

    # Gemini 2.5 accepts thinkingBudget; don't guess a budget from Fan'
    # coarse effort levels. ``includeThoughts`` alone is enough to surface
    # thought parts without risking request validation errors.
    if normalized_model.startswith("gemini-2.5-"):
        return thinking_config

    if effort not in {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}:
        effort = "medium"

    # Gemini 3 Flash documents low/medium/high thinking levels; Gemini 3 Pro
    # is stricter (low/high). Clamp Fan' wider effort set to what each
    # family accepts so we never forward an undocumented level verbatim.
    if normalized_model.startswith(("gemini-3", "gemini-3.1")):
        if "flash" in normalized_model:
            if effort in {"minimal", "low"}:
                thinking_config["thinkingLevel"] = "low"
            elif effort in {"high", "xhigh", "max", "ultra"}:
                thinking_config["thinkingLevel"] = "high"
            else:
                thinking_config["thinkingLevel"] = "medium"
        elif "pro" in normalized_model:
            thinking_config["thinkingLevel"] = (
                "high" if effort in {"high", "xhigh", "max", "ultra"} else "low"
            )

    return thinking_config


def _snake_case_gemini_thinking_config(config: dict | None) -> dict | None:
    """Convert Gemini thinking config keys to the OpenAI-compat field names."""
    if not isinstance(config, dict) or not config:
        return None

    translated: Dict[str, Any] = {}
    if isinstance(config.get("includeThoughts"), bool):
        translated["include_thoughts"] = config["includeThoughts"]
    if isinstance(config.get("thinkingLevel"), str) and config["thinkingLevel"].strip():
        translated["thinking_level"] = config["thinkingLevel"].strip().lower()
    if isinstance(config.get("thinkingBudget"), (int, float)):
        translated["thinking_budget"] = int(config["thinkingBudget"])
    return translated or None


def _is_gemini_openai_compat_base_url(base_url: Any) -> bool:
    normalized = str(base_url or "").strip().rstrip("/").lower()
    if not normalized:
        return False
    if "generativelanguage.googleapis.com" not in normalized:
        return False
    return normalized.endswith("/openai")


def _is_glm_5_2_model(model: Any) -> bool:
    """Recognize GLM-5.2 across common relay alias spellings."""
    normalized = str(model or "").strip().lower().rsplit("/", 1)[-1]
    return any(token in normalized for token in ("glm-5.2", "glm-5-2", "glm-5p2"))


def _zai_glm_5_2_reasoning_effort(reasoning_config: Any) -> str | None:
    """Map Fan's effort scale to GLM-5.2's ``high``/``max`` control."""
    if not isinstance(reasoning_config, dict):
        return None
    if reasoning_config.get("enabled") is False:
        return None
    effort = str(reasoning_config.get("effort") or "").strip().lower()
    if not effort or effort == "none":
        return None
    return "max" if effort in {"xhigh", "max", "ultra"} else "high"


def _model_consumes_thought_signature(model: Any) -> bool:
    """True when the outgoing model is a Gemini family model that requires
    ``extra_content`` (thought_signature) to be replayed on tool calls.

    Gemini 3 thinking models attach ``extra_content`` to each tool call and
    reject subsequent requests with HTTP 400 if it is missing. Every other
    strict OpenAI-compatible provider (Fireworks, Mistral, ...) rejects the
    request with 400 if ``extra_content`` *is* present. So the field must be
    kept only when the target model is itself Gemini-family, and stripped
    otherwise — including when a non-Gemini model inherits stale Gemini
    ``extra_content`` from earlier in a mixed-provider session.
    """
    m = str(model or "").lower()
    return "gemini" in m or "gemma" in m


class ChatCompletionsTransport(ProviderTransport):
    """Transport for api_mode='chat_completions'.

    The default path for OpenAI-compatible providers.
    """

    @property
    def api_mode(self) -> str:
        return "chat_completions"

    def convert_messages(
        self, messages: list[dict[str, Any]], **kwargs
    ) -> list[dict[str, Any]]:
        """Messages are already in OpenAI format — strip internal fields
        that strict chat-completions providers reject with HTTP 400/422
        (or, in the case of some OpenAI-compatible gateways, 5xx):

        - Codex Responses API fields: ``codex_reasoning_items`` /
          ``codex_message_items`` on the message, ``call_id`` /
          ``response_item_id`` on ``tool_calls`` entries.
        - ``extra_content`` on ``tool_calls`` (Gemini thought_signature) —
          stripped unless the outgoing ``model`` is itself Gemini-family.
          Gemini 3 thinking models attach it for replay, but strict providers
          (Fireworks, Mistral) reject any payload containing it with
          ``Extra inputs are not permitted, field: 'messages[N].tool_calls[M].extra_content'``.
          It must be kept for Gemini targets (replay required) and dropped for
          everyone else, including non-Gemini models that inherited stale
          Gemini ``extra_content`` earlier in a mixed-provider session.
        - ``tool_name`` on tool-result messages — written by
          ``make_tool_result_message()`` for the SQLite FTS index, but not
          part of the Chat Completions schema. Strict providers (Fireworks,
          Moonshot/Kimi) reject any payload containing it with
          ``Extra inputs are not permitted, field: 'messages[N].tool_name'``.
          Permissive providers (OpenRouter, MiniMax) silently ignore the
          field, which masked the bug for months.
        - Fan-internal scaffolding markers — any top-level message key
          starting with ``_`` (e.g. ``_empty_recovery_synthetic``,
          ``_empty_terminal_sentinel``, ``_thinking_prefill``). These are
          bookkeeping flags the agent loop attaches to messages so the
          persistence layer can later strip its own scaffolding; they must
          never reach the wire. Permissive providers may silently drop
          unknown message keys, but strict
          gateways (e.g. opencode-go, codex.nekos.me) reject with
          ``Extra inputs are not permitted, field: 'messages[N]._empty_recovery_synthetic'``,
          which then poisons every subsequent request in the session.
        """
        strip_extra_content = not _model_consumes_thought_signature(
            kwargs.get("model")
        )
        needs_sanitize = False
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            if (
                "codex_reasoning_items" in msg
                or "codex_message_items" in msg
                or "tool_name" in msg
                or "effect_disposition" in msg
                or "timestamp" in msg
            ):
                needs_sanitize = True
                break
            if any(isinstance(k, str) and k.startswith("_") for k in msg):
                needs_sanitize = True
                break
            tool_calls = msg.get("tool_calls")
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if isinstance(tc, dict) and (
                        "call_id" in tc
                        or "response_item_id" in tc
                        or (strip_extra_content and "extra_content" in tc)
                    ):
                        needs_sanitize = True
                        break
                if needs_sanitize:
                    break

        if not needs_sanitize:
            return messages

        sanitized = copy.deepcopy(messages)
        for msg in sanitized:
            if not isinstance(msg, dict):
                continue
            msg.pop("codex_reasoning_items", None)
            msg.pop("codex_message_items", None)
            msg.pop("tool_name", None)
            msg.pop("effect_disposition", None)
            msg.pop("timestamp", None)
            # Drop all Fan-internal scaffolding markers (``_``-prefixed).
            # OpenAI's message schema has no ``_``-prefixed fields, so this
            # is safe and future-proofs against new markers being added.
            for key in [k for k in msg if isinstance(k, str) and k.startswith("_")]:
                msg.pop(key, None)
            tool_calls = msg.get("tool_calls")
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if isinstance(tc, dict):
                        tc.pop("call_id", None)
                        tc.pop("response_item_id", None)
                        if strip_extra_content:
                            tc.pop("extra_content", None)
        return sanitized

    def convert_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Tools are already in OpenAI format — identity."""
        return tools

    def build_kwargs(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        **params,
    ) -> dict[str, Any]:
        """Build chat.completions.create() kwargs.

        params (all optional):
            timeout: float — API call timeout
            max_tokens: int | None — user-configured max tokens
            ephemeral_max_output_tokens: int | None — one-shot override
            max_tokens_param_fn: callable — returns {max_tokens: N} or {max_completion_tokens: N}
            reasoning_config: dict | None
            request_overrides: dict | None
            session_id: str | None
            model_lower: str — lowercase model name for pattern matching
            # Provider profile path (all per-provider quirks live in providers/)
            provider_profile: ProviderProfile | None — when present, delegates to
                _build_kwargs_from_profile(); all flag params below are bypassed.
            # Legacy-path flags — only used when provider_profile is None
            # (i.e. custom / unregistered providers). Known providers all go
            # through provider_profile.
            is_openrouter: bool
            is_qwen_portal: bool
            is_github_models: bool
            is_nvidia_nim: bool
            is_kimi: bool
            is_tokenhub: bool
            is_lmstudio: bool
            is_custom_provider: bool
            ollama_num_ctx: int | None
            # Provider routing
            provider_preferences: dict | None
            # Qwen-specific
            qwen_prepare_fn: callable | None — runs AFTER codex sanitization
            qwen_prepare_inplace_fn: callable | None — in-place variant for deepcopied lists
            qwen_session_metadata: dict | None
            # Temperature
            fixed_temperature: Any — from _fixed_temperature_for_model()
            omit_temperature: bool
            # Reasoning
            supports_reasoning: bool
            github_reasoning_extra: dict | None
            lmstudio_reasoning_options: list[str] | None  # raw allowed_options from /api/v1/models
            extra_body_additions: dict | None
        """
        # Codex sanitization: drop reasoning_items / call_id / response_item_id.
        # Pass model so the Gemini thought_signature (extra_content) is kept for
        # Gemini targets and stripped for strict non-Gemini providers.
        sanitized = self.convert_messages(messages, model=model)

        # ── Provider profile: single-path when present ──────────────────
        _profile = params.get("provider_profile")
        if _profile:
            return self._build_kwargs_from_profile(
                _profile, model, sanitized, tools, params
            )

        # ── Legacy fallback (unregistered / unknown provider) ───────────
        # Reached only when get_provider_profile() returned None.
        # Known providers always go through the profile path above.

        api_kwargs: dict[str, Any] = {
            "model": model,
            "messages": sanitized,
        }

        timeout = params.get("timeout")
        if timeout is not None:
            api_kwargs["timeout"] = timeout

        # Tools
        if tools:
            # Moonshot/Kimi uses a stricter flavored JSON Schema.  Rewriting
            # tool parameters here keeps aggregator routes such as OpenRouter
            # compatible, in addition to direct moonshot.ai endpoints.
            if is_moonshot_model(model):
                tools = sanitize_moonshot_tools(tools)
            api_kwargs["tools"] = tools

        # max_tokens resolution — priority: ephemeral > user > provider default
        max_tokens_fn = params.get("max_tokens_param_fn")
        ephemeral = params.get("ephemeral_max_output_tokens")
        max_tokens = params.get("max_tokens")
        is_nvidia_nim = params.get("is_nvidia_nim", False)
        is_kimi = params.get("is_kimi", False)
        is_tokenhub = params.get("is_tokenhub", False)
        reasoning_config = _reasoning_config_for_model(
            model, params.get("reasoning_config")
        )

        if ephemeral is not None and max_tokens_fn:
            api_kwargs.update(max_tokens_fn(ephemeral))
        elif max_tokens is not None and max_tokens_fn:
            api_kwargs.update(max_tokens_fn(max_tokens))

        # Kimi: top-level reasoning_effort (unless thinking disabled)
        if is_kimi:
            _kimi_thinking_off = bool(
                reasoning_config
                and isinstance(reasoning_config, dict)
                and reasoning_config.get("enabled") is False
            )
            if not _kimi_thinking_off:
                _kimi_effort = "medium"
                if reasoning_config and isinstance(reasoning_config, dict):
                    _e = (reasoning_config.get("effort") or "").strip().lower()
                    if _e in {"low", "medium", "high"}:
                        _kimi_effort = _e
                api_kwargs["reasoning_effort"] = _kimi_effort

        # Tencent TokenHub: top-level reasoning_effort (unless thinking disabled)
        if is_tokenhub:
            _tokenhub_thinking_off = bool(
                reasoning_config
                and isinstance(reasoning_config, dict)
                and reasoning_config.get("enabled") is False
            )
            if not _tokenhub_thinking_off:
                _tokenhub_effort = "high"
                if reasoning_config and isinstance(reasoning_config, dict):
                    _e = (reasoning_config.get("effort") or "").strip().lower()
                    if _e in {"low", "medium", "high"}:
                        _tokenhub_effort = _e
                api_kwargs["reasoning_effort"] = _tokenhub_effort

        # LM Studio: top-level reasoning_effort. Only emit when the model
        # declares reasoning support via /api/v1/models capabilities (gated
        # upstream by params["supports_reasoning"]). resolve_lmstudio_effort
        # is shared with run_agent's summary path so both stay in sync.
        if params.get("is_lmstudio", False) and params.get("supports_reasoning", False):
            _lm_effort = resolve_lmstudio_effort(
                reasoning_config,
                params.get("lmstudio_reasoning_options"),
            )
            if _lm_effort is not None:
                api_kwargs["reasoning_effort"] = _lm_effort

        # Z.AI's GLM-5.2 OpenAI-compatible endpoint supports only native
        # ``high`` / ``max`` reasoning levels. Its generic extra_body path is
        # intentionally disabled for non-OpenRouter providers, so forward the
        # user's effort preference through the provider's top-level control.
        if (
            str(params.get("provider_name") or "").strip().lower() == "zai"
            and _is_glm_5_2_model(model)
        ):
            _zai_effort = _zai_glm_5_2_reasoning_effort(reasoning_config)
            if _zai_effort is not None:
                api_kwargs["reasoning_effort"] = _zai_effort

        # Custom OpenAI-compatible reasoning endpoints (for example GLM on a
        # configured custom provider) use a top-level effort string rather
        # than the generic extra_body envelope.
        if params.get("is_custom_provider", False):
            thinking_off = bool(
                reasoning_config
                and isinstance(reasoning_config, dict)
                and reasoning_config.get("enabled") is False
            )
            if not thinking_off:
                custom_effort = "medium"
                if reasoning_config and isinstance(reasoning_config, dict):
                    custom_effort = reasoning_config.get("effort", "medium") or "medium"
                api_kwargs["reasoning_effort"] = custom_effort

        # extra_body assembly
        extra_body: dict[str, Any] = {}

        is_openrouter = params.get("is_openrouter", False)
        is_github_models = params.get("is_github_models", False)
        provider_name = str(params.get("provider_name") or "").strip().lower()
        base_url = params.get("base_url")

        provider_prefs = params.get("provider_preferences")
        if provider_prefs and is_openrouter:
            extra_body["provider"] = provider_prefs

        # Pareto Code router plugin — model-gated. Same shape as the
        # profile path in plugins/model-providers/openrouter/__init__.py;
        # this branch only runs when the OpenRouter profile isn't loaded.
        if is_openrouter and model == "openrouter/pareto-code":
            _pareto_score = params.get("openrouter_min_coding_score")
            if _pareto_score is not None and _pareto_score != "":
                try:
                    _pareto_score_f = float(_pareto_score)
                except (TypeError, ValueError):
                    _pareto_score_f = None
                if _pareto_score_f is not None and 0.0 <= _pareto_score_f <= 1.0:
                    extra_body["plugins"] = [
                        {"id": "pareto-router", "min_coding_score": _pareto_score_f}
                    ]

        # Kimi extra_body.thinking
        if is_kimi:
            _kimi_thinking_enabled = True
            if reasoning_config and isinstance(reasoning_config, dict):
                if reasoning_config.get("enabled") is False:
                    _kimi_thinking_enabled = False
            extra_body["thinking"] = {
                "type": "enabled" if _kimi_thinking_enabled else "disabled",
            }

        # Reasoning. LM Studio is handled above via top-level reasoning_effort,
        # so skip emitting extra_body.reasoning for it.
        if params.get("supports_reasoning", False) and not params.get("is_lmstudio", False):
            if is_github_models:
                gh_reasoning = params.get("github_reasoning_extra")
                if gh_reasoning is not None:
                    extra_body["reasoning"] = gh_reasoning
            else:
                effort = "medium"
                if reasoning_config and isinstance(reasoning_config, dict):
                    effort = reasoning_config.get("effort", "medium") or "medium"
                extra_body["reasoning"] = {"enabled": True, "effort": effort}

        if provider_name == "gemini":
            raw_thinking_config = _build_gemini_thinking_config(model, reasoning_config)
            if _is_gemini_openai_compat_base_url(base_url):
                thinking_config = _snake_case_gemini_thinking_config(raw_thinking_config)
                if thinking_config:
                    openai_compat_extra = extra_body.get("extra_body", {})
                    google_extra = openai_compat_extra.get("google", {})
                    google_extra["thinking_config"] = thinking_config
                    openai_compat_extra["google"] = google_extra
                    extra_body["extra_body"] = openai_compat_extra
            elif raw_thinking_config:
                extra_body["thinking_config"] = raw_thinking_config
        elif provider_name == "google-gemini-cli":
            thinking_config = _build_gemini_thinking_config(model, reasoning_config)
            if thinking_config:
                extra_body["thinking_config"] = thinking_config

        # Merge any pre-built extra_body additions
        additions = params.get("extra_body_additions")
        if additions:
            extra_body.update(additions)

        if extra_body:
            api_kwargs["extra_body"] = extra_body

        # Request overrides last (service_tier etc.)
        overrides = params.get("request_overrides")
        if overrides:
            api_kwargs.update(overrides)

        return api_kwargs

    def _build_kwargs_from_profile(self, profile, model, sanitized, tools, params):
        """Build API kwargs using a ProviderProfile — single path, no legacy flags.

        This method replaces the entire flag-based kwargs assembly when a
        provider_profile is passed. Every quirk comes from the profile object.
        """
        from providers.base import OMIT_TEMPERATURE

        # Message preprocessing
        sanitized = profile.prepare_messages(sanitized)

        api_kwargs: dict[str, Any] = {
            "model": model,
            "messages": sanitized,
        }

        # Temperature
        if profile.fixed_temperature is OMIT_TEMPERATURE:
            pass  # Don't include temperature at all
        elif profile.fixed_temperature is not None:
            api_kwargs["temperature"] = profile.fixed_temperature
        else:
            # Use caller's temperature if provided
            temp = params.get("temperature")
            if temp is not None:
                api_kwargs["temperature"] = temp

        # Timeout
        timeout = params.get("timeout")
        if timeout is not None:
            api_kwargs["timeout"] = timeout

        # Tools — apply Moonshot/Kimi schema sanitization regardless of path
        if tools:
            if is_moonshot_model(model):
                tools = sanitize_moonshot_tools(tools)
            api_kwargs["tools"] = tools

        # max_tokens resolution — priority: ephemeral > user > profile default
        max_tokens_fn = params.get("max_tokens_param_fn")
        ephemeral = params.get("ephemeral_max_output_tokens")
        user_max = params.get("max_tokens")
        # Per-model default cap — profiles override get_max_tokens() when
        # they front several backends with different completion-token limits
        # (e.g. opencode-go: mimo-v2.5-pro = 131072).
        profile_max = profile.get_max_tokens(model)

        if ephemeral is not None and max_tokens_fn:
            api_kwargs.update(max_tokens_fn(ephemeral))
        elif user_max is not None and max_tokens_fn:
            api_kwargs.update(max_tokens_fn(user_max))
        elif profile_max and max_tokens_fn:
            api_kwargs.update(max_tokens_fn(profile_max))

        # Provider-specific api_kwargs extras (reasoning_effort, metadata, etc.)
        reasoning_config = _reasoning_config_for_model(
            model, params.get("reasoning_config")
        )
        extra_body_from_profile, top_level_from_profile = (
            profile.build_api_kwargs_extras(
                reasoning_config=reasoning_config,
                supports_reasoning=params.get("supports_reasoning", False),
                qwen_session_metadata=params.get("qwen_session_metadata"),
                model=model,
                ollama_num_ctx=params.get("ollama_num_ctx"),
                session_id=params.get("session_id"),
            )
        )
        api_kwargs.update(top_level_from_profile)

        # extra_body assembly
        extra_body: dict[str, Any] = {}

        # Profile's extra_body (tags, provider prefs, vl_high_resolution, etc.)
        profile_body = profile.build_extra_body(
            session_id=params.get("session_id"),
            provider_preferences=params.get("provider_preferences"),
            model=model,
            base_url=params.get("base_url"),
            reasoning_config=reasoning_config,
            openrouter_min_coding_score=params.get("openrouter_min_coding_score"),
        )
        if profile_body:
            extra_body.update(profile_body)

        # Profile's reasoning/thinking extra_body entries
        if extra_body_from_profile:
            extra_body.update(extra_body_from_profile)

        # Merge any pre-built extra_body additions from the caller
        additions = params.get("extra_body_additions")
        if additions:
            extra_body.update(additions)

        # Request overrides (user config)
        overrides = params.get("request_overrides")
        if overrides:
            for k, v in overrides.items():
                if k == "extra_body" and isinstance(v, dict):
                    extra_body.update(v)
                else:
                    api_kwargs[k] = v

        if extra_body:
            api_kwargs["extra_body"] = extra_body

        return api_kwargs

    def normalize_response(self, response: Any, **kwargs) -> NormalizedResponse:
        """Normalize OpenAI ChatCompletion to NormalizedResponse.

        For chat_completions, this is near-identity — the response is already
        in OpenAI format.  extra_content on tool_calls (Gemini thought_signature)
        is preserved via ToolCall.provider_data.  reasoning_details (OpenRouter
        unified format) and reasoning_content (DeepSeek/Moonshot) are also
        preserved for downstream replay.
        """
        choice = response.choices[0]
        msg = choice.message
        finish_reason = choice.finish_reason or "stop"

        tool_calls = None
        if msg.tool_calls:
            tool_calls = []
            for tc in msg.tool_calls:
                # Preserve provider-specific extras on the tool call.
                # Gemini 3 thinking models attach extra_content with
                # thought_signature — without replay on the next turn the API
                # rejects the request with 400.
                tc_provider_data: dict[str, Any] = {}
                extra = getattr(tc, "extra_content", None)
                if extra is None and hasattr(tc, "model_extra"):
                    model_extra = getattr(tc, "model_extra", None)
                    extra = (
                        model_extra.get("extra_content")
                        if isinstance(model_extra, dict)
                        else None
                    )
                if extra is not None:
                    if hasattr(extra, "model_dump"):
                        try:
                            extra = extra.model_dump()
                        except Exception:
                            pass
                    tc_provider_data["extra_content"] = extra
                tool_calls.append(
                    ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        arguments=tc.function.arguments,
                        provider_data=tc_provider_data or None,
                    )
                )

        usage = None
        if hasattr(response, "usage") and response.usage:
            u = response.usage
            usage = Usage(
                prompt_tokens=getattr(u, "prompt_tokens", 0) or 0,
                completion_tokens=getattr(u, "completion_tokens", 0) or 0,
                total_tokens=getattr(u, "total_tokens", 0) or 0,
            )

        # Preserve reasoning fields separately.  DeepSeek/Moonshot use
        # ``reasoning_content``; others use ``reasoning``.  Downstream code
        # (_extract_reasoning, thinking-prefill retry) reads both distinctly,
        # so keep them apart in provider_data rather than merging.
        reasoning = getattr(msg, "reasoning", None)
        reasoning_content = getattr(msg, "reasoning_content", None)
        if reasoning_content is None and hasattr(msg, "model_extra"):
            model_extra = getattr(msg, "model_extra", None) or {}
            if isinstance(model_extra, dict) and "reasoning_content" in model_extra:
                reasoning_content = model_extra["reasoning_content"]

        provider_data: Dict[str, Any] = {}
        if reasoning_content is not None:
            provider_data["reasoning_content"] = reasoning_content
        rd = getattr(msg, "reasoning_details", None)
        if rd:
            provider_data["reasoning_details"] = rd

        # OpenAI structured-refusal field. When a model declines, the SDK
        # populates ``message.refusal`` with the explanation and leaves
        # ``content`` empty. Some compatible gateways surface refusals this
        # way or via ``finish_reason="content_filter"``. Without capturing it the refusal looks
        # like an empty response, so the agent loop retries a deterministic
        # refusal and gives up with "no content after retries". Promote it to
        # content + a ``content_filter`` finish reason so the loop's refusal
        # handler (finish_reason == "content_filter") surfaces it clearly and
        # stops. ``refusal`` is ``None`` for normal responses, so this is a
        # no-op in the common case.
        content = msg.content
        refusal = getattr(msg, "refusal", None)
        if refusal is None and hasattr(msg, "model_extra"):
            _msg_extra = getattr(msg, "model_extra", None) or {}
            if isinstance(_msg_extra, dict):
                refusal = _msg_extra.get("refusal")
        if isinstance(refusal, str) and refusal.strip():
            # Record the refusal explanation regardless — it's useful provider
            # metadata even when the model also returned a usable payload.
            provider_data["refusal"] = refusal
            _has_text = isinstance(content, str) and content.strip()
            _has_tool_calls = bool(tool_calls)
            # Only promote to a terminal ``content_filter`` when the refusal is
            # the *sole* payload — no visible text and no tool calls. A
            # response that carries real content (or tool calls) alongside a
            # refusal note is a normal, usable turn: surfacing it as a failed
            # safety refusal would discard the model's actual work. In the
            # empty-payload case, adopt the refusal as content so the loop has
            # something to show.
            if not _has_text and not _has_tool_calls:
                content = refusal
                if finish_reason in (None, "stop"):
                    finish_reason = "content_filter"

        return NormalizedResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            reasoning=reasoning,
            usage=usage,
            provider_data=provider_data or None,
        )

    def validate_response(self, response: Any) -> bool:
        """Check that response has valid choices."""
        if response is None:
            return False
        if not hasattr(response, "choices") or response.choices is None:
            return False
        if not response.choices:
            return False
        return True

    def extract_cache_stats(self, response: Any) -> dict[str, int] | None:
        """Extract OpenRouter/OpenAI cache stats from prompt_tokens_details."""
        usage = getattr(response, "usage", None)
        if usage is None:
            return None
        details = getattr(usage, "prompt_tokens_details", None)
        if details is None:
            return None
        cached = getattr(details, "cached_tokens", 0) or 0
        written = getattr(details, "cache_write_tokens", 0) or 0
        if cached or written:
            return {"cached_tokens": cached, "creation_tokens": written}
        return None


# Auto-register on import
from agent.transports import register_transport  # noqa: E402

register_transport("chat_completions", ChatCompletionsTransport)
