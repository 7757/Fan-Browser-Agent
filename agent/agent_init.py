"""Implementation of :meth:`AIAgent.__init__` — extracted as a module function.

``AIAgent.__init__`` is one of the longest methods in the codebase (60+
parameters, ~1,400 lines of attribute initialization, provider
auto-detection, credential resolution, context-engine bootstrap, etc.).
Keeping it in ``run_agent.py`` bloats that file with code that's mostly
"setup state, then forget".

After this extraction the body lives here as ``init_agent(agent, ...)``
and :meth:`AIAgent.__init__` is a thin wrapper that calls
``init_agent(self, ...)``.  All imports the body needs at module-load
time are listed below; the body also performs many lazy imports inside
its own scope that come along unchanged.

Symbols that tests patch on ``run_agent.*`` (``OpenAI``, ``cleanup_vm``,
etc.) are resolved through :func:`_ra` so the patch contract is
preserved.
"""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, parse_qs, urlunparse

from agent.context_compressor import ContextCompressor
from agent.iteration_budget import IterationBudget
from agent.memory_manager import StreamingContextScrubber
from agent.model_metadata import (
    MINIMUM_CONTEXT_LENGTH,
    fetch_model_metadata,
    is_local_endpoint,
    query_ollama_num_ctx,
)
from agent.process_bootstrap import _install_safe_stdio
from agent.subdirectory_hints import SubdirectoryHintTracker
from agent.think_scrubber import StreamingThinkScrubber
from agent.tool_guardrails import (
    ToolCallGuardrailConfig,
    ToolCallGuardrailController,
    ToolGuardrailDecision,
)
from fan_cli.config import cfg_get
from fan_cli.timeouts import get_provider_request_timeout
from fan_constants import get_fan_home
from utils import base_url_host_matches

# Use the same logger name as run_agent so tests patching ``run_agent.logger``
# capture our warnings.  (run_agent.py also does
# ``logger = logging.getLogger(__name__)``, which resolves to "run_agent"
# from inside that module.)
logger = logging.getLogger("run_agent")


def _ra():
    """Lazy reference to ``run_agent`` so callers can patch
    ``run_agent.OpenAI`` / ``run_agent.cleanup_vm`` / ... and have those
    patches reach this code path.
    """
    import run_agent
    return run_agent


def _normalized_custom_base_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().rstrip("/")


def _custom_provider_model_matches(agent_model: str, entry: Dict[str, Any]) -> bool:
    provider_model = str(entry.get("model", "") or "").strip().lower()
    if not provider_model:
        return True
    return provider_model == str(agent_model or "").strip().lower()


def _custom_provider_extra_body_for_agent(
    *,
    provider: str,
    model: str,
    base_url: str,
    custom_providers: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    provider_norm = (provider or "").strip().lower()
    if provider_norm == "custom":
        provider_key_filter = ""
    elif provider_norm.startswith("custom:"):
        provider_key_filter = provider_norm.split(":", 1)[1].strip()
    else:
        return None

    target_url = _normalized_custom_base_url(base_url)
    if not target_url:
        return None

    fallback: Optional[Dict[str, Any]] = None
    for entry in custom_providers or []:
        if not isinstance(entry, dict):
            continue
        if provider_key_filter:
            entry_keys = {
                str(entry.get("provider_key", "") or "").strip().lower(),
                str(entry.get("name", "") or "").strip().lower(),
            }
            if provider_key_filter not in entry_keys:
                continue
        if _normalized_custom_base_url(entry.get("base_url")) != target_url:
            continue
        extra_body = entry.get("extra_body")
        if not isinstance(extra_body, dict) or not extra_body:
            continue
        provider_model = str(entry.get("model", "") or "").strip()
        if provider_model:
            if _custom_provider_model_matches(model, entry):
                return dict(extra_body)
        elif fallback is None:
            fallback = dict(extra_body)

    return fallback


def _merge_custom_provider_extra_body(agent, custom_providers: List[Dict[str, Any]]) -> None:
    extra_body = _custom_provider_extra_body_for_agent(
        provider=agent.provider,
        model=agent.model,
        base_url=agent.base_url,
        custom_providers=custom_providers,
    )
    if not extra_body:
        return

    overrides = dict(getattr(agent, "request_overrides", {}) or {})
    merged_extra_body = dict(extra_body)
    existing_extra_body = overrides.get("extra_body")
    if isinstance(existing_extra_body, dict):
        merged_extra_body.update(existing_extra_body)
    overrides["extra_body"] = merged_extra_body
    agent.request_overrides = overrides


def _validate_interactive_tool_contract(
    valid_tool_names: set[str],
    *,
    collect_callback: callable = None,
) -> None:
    """Fail fast when the desktop browser prompt promises an absent tool.

    Non-interactive browser contexts (for example delegated workers) are
    intentionally allowed to omit ``collect`` because they cannot wait for the
    user. The main desktop session always supplies the callback and therefore
    must expose the unified interaction schema to the model.
    """
    if collect_callback is None:
        return
    if not any(name.startswith("browser_") for name in valid_tool_names):
        return
    if "collect" not in valid_tool_names:
        raise RuntimeError(
            "Interactive browser tool contract is invalid: the collect tool "
            "is required whenever Electron browser tools and collect_callback "
            "are enabled."
        )


def init_agent(
    agent,
    base_url: str = None,
    api_key: str = None,
    provider: str = None,
    api_mode: str = None,
    acp_command: str = None,
    acp_args: list[str] | None = None,
    command: str = None,
    args: list[str] | None = None,
    model: str = "",
    max_iterations: int = 90,  # Default tool-calling iterations (shared with subagents)
    tool_delay: float = 1.0,
    enabled_toolsets: List[str] = None,
    disabled_toolsets: List[str] = None,
    save_trajectories: bool = False,
    verbose_logging: bool = False,
    quiet_mode: bool = False,
    tool_progress_mode: str = "all",
    ephemeral_system_prompt: str = None,
    log_prefix_chars: int = 100,
    log_prefix: str = "",
    providers_allowed: List[str] = None,
    providers_ignored: List[str] = None,
    providers_order: List[str] = None,
    provider_sort: str = None,
    provider_require_parameters: bool = False,
    provider_data_collection: str = None,
    openrouter_min_coding_score: Optional[float] = None,
    session_id: str = None,
    tool_progress_callback: callable = None,
    tool_start_callback: callable = None,
    tool_complete_callback: callable = None,
    thinking_callback: callable = None,
    reasoning_callback: callable = None,
    collect_callback: callable = None,
    step_callback: callable = None,
    stream_delta_callback: callable = None,
    interim_assistant_callback: callable = None,
    tool_gen_callback: callable = None,
    status_callback: callable = None,
    max_tokens: int = None,
    reasoning_config: Dict[str, Any] = None,
    service_tier: str = None,
    request_overrides: Dict[str, Any] = None,
    prefill_messages: List[Dict[str, Any]] = None,
    platform: str = None,
    user_id: str = None,
    user_id_alt: str = None,
    user_name: str = None,
    chat_id: str = None,
    chat_name: str = None,
    chat_type: str = None,
    thread_id: str = None,
    gateway_session_key: str = None,
    skip_context_files: bool = False,
    load_soul_identity: bool = False,
    skip_memory: bool = False,
    session_db=None,
    parent_session_id: str = None,
    iteration_budget: "IterationBudget" = None,
    fallback_model: Dict[str, Any] = None,
    credential_pool=None,
    checkpoints_enabled: bool = False,
    checkpoint_max_snapshots: int = 20,
    checkpoint_max_total_size_mb: int = 500,
    checkpoint_max_file_size_mb: int = 10,
    pass_session_id: bool = False,
):
    """
    Initialize the AI Agent.

    Args:
        base_url (str): Base URL for the model API (optional)
        api_key (str): API key for authentication (optional, uses env var if not provided)
        provider (str): Provider identifier (optional; used for telemetry/routing hints)
        api_mode (str): API mode override: "chat_completions" or "codex_responses"
        model (str): Model name to use (empty means resolve from provider config)
        max_iterations (int): Maximum number of tool calling iterations (default: 90)
        tool_delay (float): Delay between tool calls in seconds (default: 1.0)
        enabled_toolsets (List[str]): Only enable tools from these toolsets (optional)
        disabled_toolsets (List[str]): Disable tools from these toolsets (optional)
        save_trajectories (bool): Whether to save conversation trajectories to JSONL files (default: False)
        verbose_logging (bool): Enable verbose logging for debugging (default: False)
        quiet_mode (bool): Suppress progress output for clean CLI experience (default: False)
        ephemeral_system_prompt (str): System prompt used during agent execution but NOT saved to trajectories (optional)
        log_prefix_chars (int): Number of characters to show in log previews for tool calls/responses (default: 100)
        log_prefix (str): Prefix to add to all log messages for identification in parallel processing (default: "")
        providers_allowed (List[str]): OpenRouter providers to allow (optional)
        providers_ignored (List[str]): OpenRouter providers to ignore (optional)
        providers_order (List[str]): OpenRouter providers to try in order (optional)
        provider_sort (str): Sort providers by price/throughput/latency (optional)
        openrouter_min_coding_score (float): Coding-score floor (0.0-1.0) for the
            openrouter/pareto-code router. Only applied when model == "openrouter/pareto-code".
            None or empty = let OpenRouter pick the strongest available coder.
        session_id (str): Pre-generated session ID for logging (optional, auto-generated if not provided)
        tool_progress_callback (callable): Callback function(tool_name, args_preview) for progress notifications
        collect_callback (callable): Callback function(payload) -> str for
            interactive user questions and structured information collection.
        max_tokens (int): Maximum tokens for model responses (optional, uses model default if not set)
        reasoning_config (Dict): OpenRouter reasoning configuration override (e.g. {"effort": "none"} to disable thinking).
            If None, defaults to {"enabled": True, "effort": "medium"} for OpenRouter. Set to disable/customize reasoning.
        prefill_messages (List[Dict]): Messages to prepend to conversation history as prefilled context.
            Useful for injecting a few-shot example or priming the model's response style.
            Example: [{"role": "user", "content": "Hi!"}, {"role": "assistant", "content": "Hello!"}]
        platform (str): The local interface in use (e.g. "cli", "desktop", "api_server", "cron").
            Used to inject platform-specific formatting hints into the system prompt.
        skip_context_files (bool): If True, skip auto-injection of SOUL.md, AGENTS.md, and .cursorrules
            into the system prompt. Use this for batch processing and data generation to avoid
            polluting trajectories with user-specific persona or project instructions.
        load_soul_identity (bool): If True, still use ~/.fan/SOUL.md as the primary
            identity even when skip_context_files=True. Project context files from the cwd
            remain skipped.
    """
    _install_safe_stdio()

    agent.model = model
    agent.max_iterations = max_iterations
    # Shared iteration budget — parent creates, children inherit.
    # Consumed by every LLM turn across parent + all subagents.
    agent.iteration_budget = iteration_budget or IterationBudget(max_iterations)
    agent.tool_delay = tool_delay
    agent.save_trajectories = save_trajectories
    agent.verbose_logging = verbose_logging
    agent.quiet_mode = quiet_mode
    agent.tool_progress_mode = tool_progress_mode
    agent.ephemeral_system_prompt = ephemeral_system_prompt
    agent.platform = platform  # "cli", "desktop", "api_server", "cron", etc.
    agent._user_id = user_id  # Optional stable user identifier
    agent._user_id_alt = user_id_alt  # Optional stable alternate platform identifier
    agent._user_name = user_name
    agent._chat_id = chat_id
    agent._chat_name = chat_name
    agent._chat_type = chat_type
    agent._thread_id = thread_id
    agent._gateway_session_key = gateway_session_key  # Stable key for an externally managed local session
    # Pluggable print function — CLI replaces this with _cprint so that
    # raw ANSI status lines are routed through prompt_toolkit's renderer
    # instead of going directly to stdout where patch_stdout's StdoutProxy
    # would mangle the escape sequences.  None = use builtins.print.
    agent._print_fn = None
    agent.background_review_callback = None  # Optional sync callback for local clients
    agent.skip_context_files = skip_context_files
    agent.load_soul_identity = load_soul_identity
    agent.pass_session_id = pass_session_id
    agent.log_prefix_chars = log_prefix_chars
    agent.log_prefix = f"{log_prefix} " if log_prefix else ""
    # Store effective base URL for feature detection (prompt caching, reasoning, etc.)
    agent.base_url = base_url or ""
    provider_name = provider.strip().lower() if isinstance(provider, str) and provider.strip() else None
    agent.provider = provider_name or ""
    if credential_pool is not None:
        try:
            from agent.credential_pool import credential_pool_matches_provider

            if not credential_pool_matches_provider(
                credential_pool,
                agent.provider,
                base_url=agent.base_url,
            ):
                credential_pool = None
        except Exception:
            credential_pool = None
    agent._credential_pool = credential_pool
    agent.acp_command = acp_command or command
    agent.acp_args = list(acp_args or args or [])
    normalized_api_mode = str(api_mode or "").strip().lower()
    supported_api_modes = {
        "chat_completions", "codex_responses", "bedrock_converse", "codex_app_server",
    }
    if normalized_api_mode and normalized_api_mode not in supported_api_modes:
        raise RuntimeError(
            f"Unsupported API mode: {normalized_api_mode}. "
            "Use chat_completions for OpenAI-compatible endpoints."
        )
    if normalized_api_mode in supported_api_modes:
        agent.api_mode = normalized_api_mode
    elif agent.provider == "openai-codex":
        agent.api_mode = "codex_responses"
    elif agent.provider in {"xai", "xai-oauth"}:
        agent.api_mode = "codex_responses"
    elif (provider_name is None) and (
        agent._base_url_hostname == "chatgpt.com"
        and "/backend-api/codex" in agent._base_url_lower
    ):
        agent.api_mode = "codex_responses"
        agent.provider = "openai-codex"
    elif (provider_name is None) and agent._base_url_hostname == "api.x.ai":
        agent.api_mode = "codex_responses"
        agent.provider = "xai"
    elif agent.provider == "bedrock" or (
        agent._base_url_hostname.startswith("bedrock-runtime.")
        and base_url_host_matches(agent._base_url_lower, "amazonaws.com")
    ):
        # AWS Bedrock — auto-detect from provider name or base URL
        # (bedrock-runtime.<region>.amazonaws.com).
        agent.api_mode = "bedrock_converse"
    else:
        agent.api_mode = "chat_completions"

    # Eagerly warm the transport cache so import errors surface at init,
    # not mid-conversation.  Also validates the api_mode is registered.
    try:
        agent._get_transport()
    except Exception:
        pass  # Non-fatal — transport may not exist for all modes yet

    try:
        from fan_cli.model_normalize import (
            _AGGREGATOR_PROVIDERS,
            normalize_model_for_provider,
        )

        if agent.provider not in _AGGREGATOR_PROVIDERS:
            agent.model = normalize_model_for_provider(agent.model, agent.provider)
    except Exception:
        pass

    # GPT-5.x models usually require the Responses API path, but some
    # providers have exceptions (for example Copilot's gpt-5-mini still
    # uses chat completions). Also auto-upgrade for direct OpenAI URLs
    # (api.openai.com) since all newer tool-calling models prefer
    # Responses there. ACP runtimes are excluded: CopilotACPClient
    # handles its own routing and does not implement the Responses API
    # surface.
    # When api_mode was explicitly provided, respect it — the user
    # knows what their endpoint supports (#10473).
    # Exception: Azure OpenAI serves gpt-5.x on /chat/completions and
    # does NOT support the Responses API — skip the upgrade for Azure
    # (openai.azure.com), even though it looks OpenAI-compatible.
    if (
        api_mode is None
        and agent.api_mode == "chat_completions"
        and agent.provider != "copilot-acp"
        and not str(agent.base_url or "").lower().startswith("acp://copilot")
        and not str(agent.base_url or "").lower().startswith("acp+tcp://")
        and not agent._is_azure_openai_url()
        and (
            agent._is_direct_openai_url()
            or agent._provider_model_requires_responses_api(
                agent.model,
                provider=agent.provider,
            )
        )
    ):
        agent.api_mode = "codex_responses"
        # Invalidate the eager-warmed transport cache — api_mode changed
        # from chat_completions to codex_responses after the warm at __init__.
        if hasattr(agent, "_transport_cache"):
            agent._transport_cache.clear()

    # Pre-warm OpenRouter model metadata cache in a background thread.
    # fetch_model_metadata() is cached for 1 hour; this avoids a blocking
    # HTTP request on the first API response when pricing is estimated.
    # Use a process-level Event so this thread is only spawned once — a new
    # AIAgent is created for every gateway request, so without the guard
    # each message leaks one OS thread and the process eventually exhausts
    # the system thread limit (RuntimeError: can't start new thread).
    if (agent.provider == "openrouter" or agent._is_openrouter_url()) and \
            not _ra()._openrouter_prewarm_done.is_set():
        _ra()._openrouter_prewarm_done.set()
        threading.Thread(
            target=fetch_model_metadata,
            daemon=True,
            name="openrouter-prewarm",
        ).start()

    agent.tool_progress_callback = tool_progress_callback
    agent.tool_start_callback = tool_start_callback
    agent.tool_complete_callback = tool_complete_callback
    agent.suppress_status_output = False
    agent.thinking_callback = thinking_callback
    agent.reasoning_callback = reasoning_callback
    agent.collect_callback = collect_callback
    agent.step_callback = step_callback
    agent.stream_delta_callback = stream_delta_callback
    agent.interim_assistant_callback = interim_assistant_callback
    agent.status_callback = status_callback
    agent.tool_gen_callback = tool_gen_callback

    
    # Tool execution state — allows _vprint during tool execution
    # even when stream consumers are registered (no tokens streaming then)
    agent._executing_tools = False
    agent._tool_guardrails = ToolCallGuardrailController()
    agent._tool_guardrail_halt_decision: ToolGuardrailDecision | None = None

    # Interrupt mechanism for breaking out of tool loops
    agent._interrupt_requested = False
    agent._interrupt_message = None  # Optional message that triggered interrupt
    agent._execution_thread_id: int | None = None  # Set at run_conversation() start
    agent._interrupt_thread_signal_pending = False
    agent._client_lock = threading.RLock()

    # /steer mechanism — inject a user note into the next tool result
    # without interrupting the agent. Unlike interrupt(), steer() does
    # NOT set _interrupt_requested; it waits for the current tool batch
    # to finish naturally, then the drain hook appends the text to the
    # last tool result's content so the model sees it on its next
    # iteration. Message-role alternation is preserved (we modify an
    # existing tool message rather than inserting a new user turn).
    agent._pending_steer: Optional[str] = None
    agent._pending_steer_lock = threading.Lock()

    # Concurrent-tool worker thread tracking.  `_execute_tool_calls_concurrent`
    # runs each tool on its own ThreadPoolExecutor worker — those worker
    # threads have tids distinct from `_execution_thread_id`, so
    # `_set_interrupt(True, _execution_thread_id)` alone does NOT cause
    # `is_interrupted()` inside the worker to return True.  Track the
    # workers here so `interrupt()` / `clear_interrupt()` can fan out to
    # their tids explicitly.
    agent._tool_worker_threads: set[int] = set()
    agent._tool_worker_threads_lock = threading.Lock()
    
    # Subagent delegation state
    agent._delegate_depth = 0        # 0 = top-level agent, incremented for children
    agent._active_children = []      # Running child AIAgents (for interrupt propagation)
    agent._active_children_lock = threading.Lock()
    
    # Store OpenRouter provider preferences
    agent.providers_allowed = providers_allowed
    agent.providers_ignored = providers_ignored
    agent.providers_order = providers_order
    agent.provider_sort = provider_sort
    agent.provider_require_parameters = provider_require_parameters
    agent.provider_data_collection = provider_data_collection
    agent.openrouter_min_coding_score = openrouter_min_coding_score

    # Store toolset filtering options
    agent.enabled_toolsets = enabled_toolsets
    agent.disabled_toolsets = disabled_toolsets
    
    # Model response configuration
    agent.max_tokens = max_tokens  # None = use model default
    agent.reasoning_config = reasoning_config  # None = use default (medium for OpenRouter)
    agent.service_tier = service_tier
    agent.request_overrides = dict(request_overrides or {})
    agent.prefill_messages = prefill_messages or []  # Prefilled conversation turns
    agent._force_ascii_payload = False
    
    # Recomputed after provider resolution below. This placeholder prevents an
    # init-time fallback from inheriting the failed primary provider's policy.
    agent._use_prompt_caching = False

    # Iteration budget: the LLM is only notified when it actually exhausts
    # the iteration budget (api_call_count >= max_iterations).  At that
    # point we inject ONE message, allow one final API call, and if the
    # model doesn't produce a text response, force a user-message asking
    # it to summarise.  No intermediate pressure warnings — they caused
    # models to "give up" prematurely on complex tasks (#7915).
    agent._budget_exhausted_injected = False
    agent._budget_grace_call = False

    # Activity tracking — updated on each API call, tool execution, and
    # stream chunk.  Used by the gateway timeout handler to report what the
    # agent was doing when it was killed, and by the "still working"
    # notifications to show progress.
    agent._last_activity_ts: float = time.time()
    agent._last_activity_desc: str = "initializing"
    agent._current_tool: str | None = None
    agent._api_call_count: int = 0

    # Rate limit tracking — updated from x-ratelimit-* response headers
    # after each API call.  Accessed by /usage slash command.
    agent._rate_limit_state: Optional["RateLimitState"] = None

    # OpenRouter response cache hit counter — incremented when
    # X-OpenRouter-Cache-Status: HIT is seen in streaming response headers.
    agent._or_cache_hits: int = 0

    # Centralized logging — agent.log (INFO+) and errors.log (WARNING+)
    # both live under ~/.fan/logs/.  Idempotent, so gateway mode
    # (which creates a new AIAgent per message) won't duplicate handlers.
    from fan_logging import setup_logging, setup_verbose_logging
    setup_logging(fan_home=_ra()._fan_home)

    if agent.verbose_logging:
        setup_verbose_logging()
        _ra().logger.info("Verbose logging enabled (third-party library logs suppressed)")
    elif agent.quiet_mode:
        # In quiet mode (CLI default), keep console output clean —
        # but DO NOT raise per-logger levels. Doing so prevents the
        # root logger's file handlers (agent.log, errors.log) from
        # ever seeing the records, because Python checks
        # logger.isEnabledFor() before handler propagation. We rely
        # on the fact that fan_logging.setup_logging() does not
        # install a console StreamHandler in quiet mode — so INFO
        # records flow to the file handlers but never reach a
        # console. Any future noise reduction belongs at the
        # handler level inside fan_logging.py, not here.
        pass
    
    # Internal stream callback (set during streaming TTS).
    # Initialized here so _vprint can reference it before run_conversation.
    agent._stream_callback = None
    # Deferred paragraph break flag — set after tool iterations so a
    # single "\n\n" is prepended to the next real text delta.
    agent._stream_needs_break = False
    # Stateful scrubber for <memory-context> spans split across stream
    # deltas (#5719).  sanitize_context() alone can't survive chunk
    # boundaries because the block regex needs both tags in one string.
    agent._stream_context_scrubber = StreamingContextScrubber()
    # Stateful scrubber for reasoning/thinking tags in streamed deltas
    # (#17924).  Replaces the per-delta _strip_think_blocks regex that
    # destroyed downstream state (e.g. MiniMax-M2.7 streaming
    # '<think>' as delta1 and 'Let me check' as delta2 — the regex
    # erased delta1, so downstream state machines never learned a
    # block was open and leaked delta2 as content).
    agent._stream_think_scrubber = StreamingThinkScrubber()
    # Visible assistant text already delivered through live token callbacks
    # during the current model response. Used to avoid re-sending the same
    # commentary when the provider later returns it as a completed interim
    # assistant message.
    agent._current_streamed_assistant_text = ""

    # Optional current-turn user-message override used when the API-facing
    # user message intentionally differs from the persisted transcript
    # (e.g. CLI voice mode adds a temporary prefix for the live call only).
    agent._persist_user_message_idx = None
    agent._persist_user_message_override = None

    # Cache image-to-text fallbacks per image payload/URL so a
    # single tool loop does not repeatedly re-run auxiliary vision on the
    # same image history.
    agent._image_fallback_cache: Dict[str, str] = {}

    # Initialize LLM client via centralized provider router.
    # The router handles auth resolution, base URL, headers, and
    # provider-specific wrapping for all known providers.
    # raw_codex=True because the main agent needs direct responses.stream()
    # access for Codex Responses API streaming.
    # Resolve per-provider / per-model request timeout once up front so
    # every OpenAI-wire and router-based client construction path can apply
    # it consistently. Bedrock uses its own timeout path.
    _provider_timeout = get_provider_request_timeout(agent.provider, agent.model)

    if agent.api_mode == "bedrock_converse":
        # AWS Bedrock — uses boto3 directly, no OpenAI client needed.
        # Region is extracted from the base_url or defaults to us-east-1.
        _region_match = re.search(r"bedrock-runtime\.([a-z0-9-]+)\.", base_url or "")
        agent._bedrock_region = _region_match.group(1) if _region_match else "us-east-1"
        # Guardrail config — read from config.yaml at init time.
        agent._bedrock_guardrail_config = None
        try:
            from fan_cli.config import load_config as _load_br_cfg
            _gr = _load_br_cfg().get("bedrock", {}).get("guardrail", {})
            if _gr.get("guardrail_identifier") and _gr.get("guardrail_version"):
                agent._bedrock_guardrail_config = {
                    "guardrailIdentifier": _gr["guardrail_identifier"],
                    "guardrailVersion": _gr["guardrail_version"],
                }
                if _gr.get("stream_processing_mode"):
                    agent._bedrock_guardrail_config["streamProcessingMode"] = _gr["stream_processing_mode"]
                if _gr.get("trace"):
                    agent._bedrock_guardrail_config["trace"] = _gr["trace"]
        except Exception:
            pass
        agent.client = None
        agent._client_kwargs = {}
        if not agent.quiet_mode:
            _gr_label = " + Guardrails" if agent._bedrock_guardrail_config else ""
            print(f"🤖 AI Agent initialized with model: {agent.model} (AWS Bedrock, {agent._bedrock_region}{_gr_label})")
    else:
        if api_key and base_url:
            # Explicit credentials from CLI/gateway — construct directly.
            # The runtime provider resolver already handled auth for us.
            # Extract query params (e.g. Azure api-version) from base_url
            # and pass via default_query to prevent loss during SDK URL
            # joining (httpx drops query string when joining paths).
            _parsed_url = urlparse(base_url)
            if _parsed_url.query:
                _clean_url = urlunparse(_parsed_url._replace(query=""))
                _query_params = {
                    k: v[0] for k, v in parse_qs(_parsed_url.query).items()
                }
                client_kwargs = {
                    "api_key": api_key,
                    "base_url": _clean_url,
                    "default_query": _query_params,
                }
            else:
                client_kwargs = {"api_key": api_key, "base_url": base_url}
            if _provider_timeout is not None:
                client_kwargs["timeout"] = _provider_timeout
            if agent.provider == "copilot-acp":
                client_kwargs["command"] = agent.acp_command
                client_kwargs["args"] = agent.acp_args
            effective_base = base_url
            if base_url_host_matches(effective_base, "openrouter.ai"):
                from agent.auxiliary_client import build_or_headers
                client_kwargs["default_headers"] = build_or_headers()
            elif base_url_host_matches(effective_base, "integrate.api.nvidia.com"):
                from agent.auxiliary_client import build_nvidia_nim_headers
                client_kwargs["default_headers"] = build_nvidia_nim_headers(effective_base)
            elif base_url_host_matches(effective_base, "api.routermint.com"):
                client_kwargs["default_headers"] = _ra()._routermint_headers()
            elif base_url_host_matches(effective_base, "portal.qwen.ai"):
                client_kwargs["default_headers"] = _ra()._qwen_portal_headers()
            elif base_url_host_matches(effective_base, "chatgpt.com"):
                from agent.auxiliary_client import _codex_cloudflare_headers
                client_kwargs["default_headers"] = _codex_cloudflare_headers(api_key)
            elif "default_headers" not in client_kwargs:
                # Fall back to profile.default_headers for providers that
                # declare custom headers (e.g. Kimi User-Agent on non-kimi.com
                # endpoints).
                try:
                    from providers import get_provider_profile as _gpf
                    _ph = _gpf(agent.provider)
                    if _ph and _ph.default_headers:
                        client_kwargs["default_headers"] = dict(_ph.default_headers)
                except Exception:
                    pass
        else:
            # No explicit creds — use the centralized provider router
            from agent.auxiliary_client import resolve_provider_client
            _routed_client, _ = resolve_provider_client(
                agent.provider or "auto", model=agent.model, raw_codex=True)
            if _routed_client is not None:
                client_kwargs = {
                    "api_key": _routed_client.api_key,
                    "base_url": str(_routed_client.base_url),
                }
                if _provider_timeout is not None:
                    client_kwargs["timeout"] = _provider_timeout
                # Preserve provider-specific headers the router set.  The
                # OpenAI SDK stores caller-provided default_headers in
                # _custom_headers; older/mocked clients may expose
                # _default_headers instead.
                _routed_headers = getattr(_routed_client, "_custom_headers", None)
                if not _routed_headers:
                    _routed_headers = getattr(_routed_client, "default_headers", None)
                if not _routed_headers:
                    _routed_headers = getattr(_routed_client, "_default_headers", None)
                if _routed_headers:
                    client_kwargs["default_headers"] = dict(_routed_headers)
            else:
                # When the user explicitly chose a non-OpenRouter provider
                # but no credentials were found, fail fast with a clear
                # message instead of silently routing through OpenRouter.
                _explicit = (agent.provider or "").strip().lower()
                if _explicit and _explicit not in {"auto", "openrouter", "custom"}:
                    # Look up the actual env var name from the provider
                    # config — some providers use non-standard names
                    # (e.g. alibaba → DASHSCOPE_API_KEY, not ALIBABA_API_KEY).
                    _env_hint = f"{_explicit.upper()}_API_KEY"
                    try:
                        from fan_cli.auth import PROVIDER_REGISTRY
                        _pcfg = PROVIDER_REGISTRY.get(_explicit)
                        if _pcfg and _pcfg.api_key_env_vars:
                            _env_hint = _pcfg.api_key_env_vars[0]
                    except Exception:
                        pass
                    # --- Init-time fallback (#17929) ---
                    _fb_entries = []
                    if isinstance(fallback_model, list):
                        _fb_entries = [
                            f for f in fallback_model
                            if isinstance(f, dict) and f.get("provider") and f.get("model")
                        ]
                    elif isinstance(fallback_model, dict) and fallback_model.get("provider") and fallback_model.get("model"):
                        _fb_entries = [fallback_model]
                    _fb_resolved = False
                    for _fb in _fb_entries:
                        _fb_explicit_key = (_fb.get("api_key") or "").strip() or None
                        if not _fb_explicit_key:
                            _fb_key_env = (_fb.get("key_env") or _fb.get("api_key_env") or "").strip()
                            if _fb_key_env:
                                _fb_explicit_key = os.getenv(_fb_key_env, "").strip() or None
                        _fb_client, _fb_model = resolve_provider_client(
                            _fb["provider"], model=_fb["model"], raw_codex=True,
                            explicit_base_url=_fb.get("base_url"),
                            explicit_api_key=_fb_explicit_key,
                        )
                        if _fb_client is not None:
                            agent.provider = _fb["provider"]
                            agent.model = _fb_model or _fb["model"]
                            agent._fallback_activated = True
                            client_kwargs = {
                                "api_key": _fb_client.api_key,
                                "base_url": str(_fb_client.base_url),
                            }
                            if _provider_timeout is not None:
                                client_kwargs["timeout"] = _provider_timeout
                            _fb_headers = getattr(_fb_client, "_custom_headers", None)
                            if not _fb_headers:
                                _fb_headers = getattr(_fb_client, "default_headers", None)
                            if not _fb_headers:
                                _fb_headers = getattr(_fb_client, "_default_headers", None)
                            if _fb_headers:
                                client_kwargs["default_headers"] = dict(_fb_headers)
                            _fb_resolved = True
                            break
                    if not _fb_resolved:
                        raise RuntimeError(
                            f"Provider '{_explicit}' is set in config.yaml but no API key "
                            f"was found. Set the {_env_hint} environment "
                            f"variable, or switch to a different provider with `fan model`."
                        )
                if not getattr(agent, "_fallback_activated", False):
                    # No provider configured — reject with a clear message.
                    raise RuntimeError(
                        "No LLM provider configured. Run `fan model` to "
                        "select a provider, or run `fan setup` for first-time "
                        "configuration."
                    )
        
        agent._client_kwargs = client_kwargs  # stored for rebuilding after interrupt

        # User-configured request headers (model.default_headers in
        # config.yaml) override provider/SDK defaults. Lets custom
        # OpenAI-compatible endpoints behind a gateway/WAF that rejects the
        # OpenAI SDK's identifying headers swap in a plain User-Agent. (#40033)
        # client_kwargs is the same dict object as agent._client_kwargs, so
        # this mutation is reflected in the client built just below.
        agent._apply_user_default_headers()

        try:
            from fan_cli.config import (
                apply_custom_provider_tls_to_client_kwargs,
                get_compatible_custom_providers,
                load_config_readonly,
            )

            apply_custom_provider_tls_to_client_kwargs(
                client_kwargs,
                str(client_kwargs.get("base_url") or agent.base_url or ""),
                get_compatible_custom_providers(load_config_readonly()),
            )
        except Exception:
            pass

        agent.api_key = client_kwargs.get("api_key", "")
        agent.base_url = client_kwargs.get("base_url", agent.base_url)
        try:
            agent.client = agent._create_openai_client(client_kwargs, reason="agent_init", shared=True)
            if not agent.quiet_mode:
                print(f"🤖 AI Agent initialized with model: {agent.model}")
                if base_url:
                    print(f"🔗 Using custom base URL: {base_url}")
                key_used = client_kwargs.get("api_key", "none")
                if isinstance(key_used, str) and key_used and key_used != "dummy-key" and len(key_used) > 12:
                    print(f"🔑 Using API key: {key_used[:8]}...{key_used[-4:]}")
                else:
                    print("⚠️  Warning: API key appears invalid or missing")
        except Exception as e:
            raise RuntimeError(f"Failed to initialize OpenAI client: {e}")
    
    # Provider fallback chain — ordered list of backup providers tried
    # when the primary is exhausted (rate-limit, overload, connection
    # failure).  Supports both legacy single-dict ``fallback_model`` and
    # new list ``fallback_providers`` format.
    if isinstance(fallback_model, list):
        agent._fallback_chain = [
            f for f in fallback_model
            if isinstance(f, dict) and f.get("provider") and f.get("model")
        ]
    elif isinstance(fallback_model, dict) and fallback_model.get("provider") and fallback_model.get("model"):
        agent._fallback_chain = [fallback_model]
    else:
        agent._fallback_chain = []
    agent._fallback_index = 0
    agent._fallback_activated = getattr(agent, "_fallback_activated", False)
    # Legacy attribute kept for backward compat (tests, external callers)
    agent._fallback_model = agent._fallback_chain[0] if agent._fallback_chain else None
    if agent._fallback_chain and not agent.quiet_mode:
        if len(agent._fallback_chain) == 1:
            fb = agent._fallback_chain[0]
            print(f"🔄 Fallback model: {fb['model']} ({fb['provider']})")
        else:
            print(f"🔄 Fallback chain ({len(agent._fallback_chain)} providers): " +
                  " → ".join(f"{f['model']} ({f['provider']})" for f in agent._fallback_chain))

    # Explicit request markers are enabled only for compatible Qwen/Alibaba
    # endpoints. Other providers may cache prefixes automatically.
    agent._use_prompt_caching = agent._prompt_cache_policy()

    # Get available tools with filtering
    agent.tools = _ra().get_tool_definitions(
        enabled_toolsets=enabled_toolsets,
        disabled_toolsets=disabled_toolsets,
        quiet_mode=agent.quiet_mode,
    )
    
    # Show tool configuration and store valid tool names for validation
    agent.valid_tool_names = set()
    if agent.tools:
        agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
        tool_names = sorted(agent.valid_tool_names)
        if not agent.quiet_mode:
            print(f"🛠️  Loaded {len(agent.tools)} tools: {', '.join(tool_names)}")
            # Show filtering info if applied
            if enabled_toolsets:
                print(f"   ✅ Enabled toolsets: {', '.join(enabled_toolsets)}")
            if disabled_toolsets:
                print(f"   ❌ Disabled toolsets: {', '.join(disabled_toolsets)}")
    elif not agent.quiet_mode:
        print("🛠️  No tools loaded (all tools filtered out or unavailable)")

    _validate_interactive_tool_contract(
        agent.valid_tool_names,
        collect_callback=agent.collect_callback,
    )

    # Kanban worker/orchestrator lifecycle guidance is session-static:
    # the dispatcher decides at spawn time whether this process is a kanban
    # worker (kanban_show tool is present iff FAN_KANBAN_TASK is set).
    # Resolving the ~835-token block once here avoids re-running the
    # membership test + reference on every system-prompt rebuild
    # (init + each context compression).
    from agent.prompt_builder import KANBAN_GUIDANCE
    agent._kanban_worker_guidance = (
        KANBAN_GUIDANCE if "kanban_show" in agent.valid_tool_names else ""
    )

    # Check tool requirements
    if agent.tools and not agent.quiet_mode:
        requirements = _ra().check_toolset_requirements()
        missing_reqs = [name for name, available in requirements.items() if not available]
        if missing_reqs:
            print(f"⚠️  Some tools may not work due to missing requirements: {missing_reqs}")
    
    # Show trajectory saving status
    if agent.save_trajectories and not agent.quiet_mode:
        print("📝 Trajectory saving enabled")
    
    # Show ephemeral system prompt status
    if agent.ephemeral_system_prompt and not agent.quiet_mode:
        prompt_preview = agent.ephemeral_system_prompt[:60] + "..." if len(agent.ephemeral_system_prompt) > 60 else agent.ephemeral_system_prompt
        print(f"🔒 Ephemeral system prompt: '{prompt_preview}' (not saved to trajectories)")
    
    # Show prompt caching status
    if agent._use_prompt_caching and not agent.quiet_mode:
        print("💾 Prompt cache markers: ENABLED (Qwen/Alibaba)")
    
    # Session logging setup - auto-save conversation trajectories for debugging
    agent.session_start = datetime.now()
    if session_id:
        # Use provided session ID (e.g., from CLI)
        agent.session_id = session_id
    else:
        # Generate a new session ID
        timestamp_str = agent.session_start.strftime("%Y%m%d_%H%M%S")
        short_uuid = uuid.uuid4().hex[:6]
        agent.session_id = f"{timestamp_str}_{short_uuid}"

    # Expose session ID to tools (terminal, execute_code) so agents can
    # reference their own session for --resume commands, cross-session
    # coordination, and logging. Keep the ContextVar and os.environ
    # fallback synchronized because different tool paths still read both.
    os.environ["FAN_SESSION_ID"] = str(agent.session_id)

    # Session logs go into ~/.fan/sessions/ for every local interface.
    fan_home = get_fan_home()
    agent.logs_dir = fan_home / "sessions"
    agent.logs_dir.mkdir(parents=True, exist_ok=True)
    # Per-session JSON snapshot writer (~/.fan/sessions/session_{sid}.json)
    # is opt-in via sessions.write_json_snapshots (default False).  state.db
    # is canonical — the snapshot is only useful for external tooling that
    # reads the JSON files directly.  See run_agent._save_session_log.
    agent._session_json_enabled = False
    try:
        from fan_cli.config import load_config as _load_sess_cfg
        _sess_cfg = (_load_sess_cfg().get("sessions") or {})
        agent._session_json_enabled = bool(_sess_cfg.get("write_json_snapshots", False))
    except Exception:
        pass
    # logs_dir is retained for bounded request-failure metadata. Full request
    # bodies are only written when FAN_DUMP_REQUESTS is explicitly enabled.
    
    # Track conversation messages for session logging
    agent._session_messages: List[Dict[str, Any]] = []
    # Responses encrypted reasoning replay state.  Some OpenAI-compatible
    # routes accept GPT-5 Responses requests but later reject replayed
    # encrypted reasoning blobs (HTTP 400 ``invalid_encrypted_content``).
    # When that happens we disable replay for the rest of the session and
    # fall back to stateless continuity.  See
    # agent/conversation_loop.py's invalid_encrypted_content retry branch.
    agent._codex_reasoning_replay_enabled = True
    agent._memory_write_origin = "assistant_tool"
    agent._memory_write_context = "foreground"
    
    # Cached system prompt -- built once per session, only rebuilt on compression
    agent._cached_system_prompt: Optional[str] = None
    
    # Filesystem checkpoint manager (transparent — not a tool)
    from tools.checkpoint_manager import CheckpointManager
    agent._checkpoint_mgr = CheckpointManager(
        enabled=checkpoints_enabled,
        max_snapshots=checkpoint_max_snapshots,
        max_total_size_mb=checkpoint_max_total_size_mb,
        max_file_size_mb=checkpoint_max_file_size_mb,
    )
    
    # SQLite session store (optional -- provided by CLI or gateway)
    agent._session_db = session_db
    agent._parent_session_id = parent_session_id
    agent._last_flushed_db_idx = 0  # tracks DB-write cursor to prevent duplicate writes
    agent._session_db_created = False  # DB row deferred to run_conversation()
    # Agents normally own their SQLite session row. Temporary forks that share
    # a live parent's id opt out explicitly before close().
    agent._end_session_on_close = True
    # Background review forks share their parent's session id for prompt-cache
    # warmth. They set this flag before running so no harness message can enter
    # the canonical session store or JSON snapshot.
    agent._persist_disabled = False
    agent._session_init_model_config = {
        "max_iterations": agent.max_iterations,
        "reasoning_config": reasoning_config,
        "max_tokens": max_tokens,
    }
    
    # In-memory todo list for task planning (one per agent/session)
    from tools.todo_tool import TodoStore
    agent._todo_store = TodoStore()
    
    # Load config once for memory, skills, and compression sections
    try:
        from fan_cli.config import load_config as _load_agent_config
        _agent_cfg = _load_agent_config()
    except Exception:
        _agent_cfg = {}
    try:
        agent._tool_guardrails = ToolCallGuardrailController(
            ToolCallGuardrailConfig.from_mapping(
                _agent_cfg.get("tool_loop_guardrails", {})
            )
        )
    except Exception as _tlg_err:
        _ra().logger.warning("Tool loop guardrail config ignored: %s", _tlg_err)
    # Cache only the derived auxiliary compression context override that is
    # needed later by the startup feasibility check.  Avoid exposing a
    # broad pseudo-public config object on the agent instance.
    agent._aux_compression_context_length_config = None

    # Persistent memory (MEMORY.md + USER.md) -- loaded from disk
    agent._memory_store = None
    # Persistent memory and the user profile are product invariants for normal
    # sessions. ``skip_memory`` is reserved for intentionally memory-free
    # temporary agents and tests; local config cannot disable either store.
    agent._memory_enabled = not skip_memory
    agent._user_profile_enabled = not skip_memory
    agent._memory_nudge_interval = 10
    agent._turns_since_memory = 0
    agent._iters_since_skill = 0
    if not skip_memory:
        raw_mem_config = _agent_cfg.get("memory", {})
        mem_config = raw_mem_config if isinstance(raw_mem_config, dict) else {}
        try:
            agent._memory_nudge_interval = int(mem_config.get("nudge_interval", 10))
        except (TypeError, ValueError):
            agent._memory_nudge_interval = 10
        try:
            from tools.memory_tool import MemoryStore
            agent._memory_store = MemoryStore(
                memory_char_limit=mem_config.get("memory_char_limit", 2200),
                user_char_limit=mem_config.get("user_char_limit", 1375),
            )
            agent._memory_store.load_from_disk()
        except Exception:
            pass  # Memory is optional -- don't break agent init
    


    # Memory provider plugin (external — one at a time, alongside built-in)
    # Reads memory.provider from config to select which plugin to activate.
    agent._memory_manager = None
    if not skip_memory:
        try:
            _mem_provider_name = mem_config.get("provider", "") if mem_config else ""

            if _mem_provider_name and _mem_provider_name.strip():
                from agent.memory_manager import MemoryManager as _MemoryManager
                from plugins.memory import load_memory_provider as _load_mem
                agent._memory_manager = _MemoryManager()
                _mp = _load_mem(_mem_provider_name)
                if _mp and _mp.is_available():
                    agent._memory_manager.add_provider(_mp)
                if agent._memory_manager.providers:
                    _init_kwargs = {
                        "session_id": agent.session_id,
                        "platform": platform or "cli",
                        "fan_home": str(get_fan_home()),
                        "agent_context": "primary",
                    }
                    # Thread session title for memory provider scoping
                    # (e.g. honcho uses this to derive chat-scoped session keys)
                    if agent._session_db:
                        try:
                            _st = agent._session_db.get_session_title(agent.session_id)
                            if _st:
                                _init_kwargs["session_title"] = _st
                        except Exception:
                            pass
                    # Thread stable user identity for per-user memory scoping.
                    if agent._user_id:
                        _init_kwargs["user_id"] = agent._user_id
                    if agent._user_id_alt:
                        _init_kwargs["user_id_alt"] = agent._user_id_alt
                    if agent._user_name:
                        _init_kwargs["user_name"] = agent._user_name
                    if agent._chat_id:
                        _init_kwargs["chat_id"] = agent._chat_id
                    if agent._chat_name:
                        _init_kwargs["chat_name"] = agent._chat_name
                    if agent._chat_type:
                        _init_kwargs["chat_type"] = agent._chat_type
                    if agent._thread_id:
                        _init_kwargs["thread_id"] = agent._thread_id
                    # Thread the externally managed session key into memory isolation.
                    if agent._gateway_session_key:
                        _init_kwargs["gateway_session_key"] = agent._gateway_session_key
                    # Stable identity for single-user memory provider scoping.
                    _init_kwargs["agent_identity"] = "browser-agent"
                    _init_kwargs["agent_workspace"] = "fan"
                    agent._memory_manager.initialize_all(**_init_kwargs)
                    _ra().logger.info("Memory provider '%s' activated", _mem_provider_name)
                else:
                    _ra().logger.debug("Memory provider '%s' not found or not available", _mem_provider_name)
                    agent._memory_manager = None
        except Exception as _mpe:
            _ra().logger.warning("Memory provider plugin init failed: %s", _mpe)
            agent._memory_manager = None

    from agent.memory_manager import inject_memory_provider_tools as _inject_memory_provider_tools
    _inject_memory_provider_tools(agent)

    # Skills config: nudge interval for skill creation reminders
    agent._skill_nudge_interval = 10
    try:
        skills_config = _agent_cfg.get("skills", {})
        agent._skill_nudge_interval = int(skills_config.get("creation_nudge_interval", 10))
    except Exception:
        pass

    # Tool-use enforcement config: "auto" (default — matches hardcoded
    # model list), true (always), false (never), or list of substrings.
    _agent_section = _agent_cfg.get("agent", {})
    if not isinstance(_agent_section, dict):
        _agent_section = {}
    agent._tool_use_enforcement = _agent_section.get("tool_use_enforcement", "auto")
    # ``auto`` keeps the existing Responses API-only continuation.  Operators
    # may opt selected chat-completions models into the same recovery when they
    # tend to acknowledge an action but emit no tool call.
    agent._intent_ack_continuation = _agent_section.get(
        "intent_ack_continuation", "auto"
    )

    # Universal task-completion guidance toggle.  Default True.  Surfaced
    # as a separate flag from tool_use_enforcement because the guidance
    # applies to ALL models, not just the model families enforcement
    # targets.
    agent._task_completion_guidance = bool(_agent_section.get("task_completion_guidance", True))

    # Local Python toolchain probe toggle.  Default True.  When False,
    # the probe is skipped entirely (no subprocess calls, no system-prompt
    # line).  Useful for users on exotic setups where the probe heuristics
    # are noisy.
    agent._environment_probe = bool(_agent_section.get("environment_probe", True))

    # App-level API retry count (wraps each model API call).  Default 3,
    # overridable via agent.api_max_retries in config.yaml.  See #11616.
    try:
        _raw_api_retries = _agent_section.get("api_max_retries", 3)
        _api_retries = int(_raw_api_retries)
        _api_retries = max(_api_retries, 1)  # 1 = no retry (single attempt)
    except (TypeError, ValueError):
        _api_retries = 3
    agent._api_max_retries = _api_retries

    # Initialize context compressor for automatic context management
    # Compresses conversation when approaching model's context limit
    # Configuration via config.yaml (compression section)
    _compression_cfg = _agent_cfg.get("compression", {})
    if not isinstance(_compression_cfg, dict):
        _compression_cfg = {}
    compression_threshold = float(_compression_cfg.get("threshold", 0.50))
    try:
        from agent.auxiliary_client import _compression_threshold_for_model as _cthresh_fn
        _model_cthresh = _cthresh_fn(agent.model)
        if _model_cthresh is not None:
            compression_threshold = _model_cthresh
    except Exception:
        pass
    compression_enabled = str(_compression_cfg.get("enabled", True)).lower() in {"true", "1", "yes"}
    compression_target_ratio = float(_compression_cfg.get("target_ratio", 0.20))
    compression_protect_last = int(_compression_cfg.get("protect_last_n", 20))
    # protect_first_n is the number of non-system messages to protect at
    # the head, in addition to the system prompt (which is always
    # implicitly protected by the compressor).  Floor at 0 — a value of
    # 0 means "preserve only the system prompt + summary + tail", which
    # is a legitimate (and common) configuration for long-running
    # rolling-compaction sessions.
    compression_protect_first = max(
        0, int(_compression_cfg.get("protect_first_n", 3))
    )
    compression_abort_on_summary_failure = str(
        _compression_cfg.get("abort_on_summary_failure", False)
    ).lower() in {"true", "1", "yes"}

    # Read optional explicit context_length override for the auxiliary
    # compression model. Custom endpoints often cannot report this via
    # /models, so the startup feasibility check needs the config hint.
    try:
        _aux_cfg = cfg_get(_agent_cfg, "auxiliary", "compression", default={})
    except Exception:
        _aux_cfg = {}
    if isinstance(_aux_cfg, dict):
        _aux_context_config = _aux_cfg.get("context_length")
    else:
        _aux_context_config = None
    if _aux_context_config is not None:
        try:
            _aux_context_config = int(_aux_context_config)
        except (TypeError, ValueError):
            _aux_context_config = None
    agent._aux_compression_context_length_config = _aux_context_config

    # Read explicit model output-token override from config when the
    # caller did not pass one directly.
    _model_cfg = _agent_cfg.get("model", {})
    if agent.max_tokens is None and isinstance(_model_cfg, dict):
        _config_max_tokens = _model_cfg.get("max_tokens")
        if _config_max_tokens is not None:
            try:
                if isinstance(_config_max_tokens, bool):
                    raise ValueError
                _parsed_max_tokens = int(_config_max_tokens)
                if _parsed_max_tokens <= 0:
                    raise ValueError
                agent.max_tokens = _parsed_max_tokens
            except (TypeError, ValueError):
                _ra().logger.warning(
                    "Invalid model.max_tokens in config.yaml: %r — "
                    "must be a positive integer (e.g. 4096). "
                    "Falling back to provider default.",
                    _config_max_tokens,
                )
                print(
                    f"\n⚠ Invalid model.max_tokens in config.yaml: {_config_max_tokens!r}\n"
                    f"  Must be a positive integer (e.g. 4096).\n"
                    f"  Falling back to provider default.\n",
                    file=sys.stderr,
                )
    agent._session_init_model_config["max_tokens"] = agent.max_tokens

    # Read explicit context_length override from model config
    if isinstance(_model_cfg, dict):
        _config_context_length = _model_cfg.get("context_length")
    else:
        _config_context_length = None
    if _config_context_length is not None:
        try:
            _config_context_length = int(_config_context_length)
        except (TypeError, ValueError):
            _ra().logger.warning(
                "Invalid model.context_length in config.yaml: %r — "
                "must be a plain integer (e.g. 256000, not '256K'). "
                "Falling back to auto-detection.",
                _config_context_length,
            )
            print(
                f"\n⚠ Invalid model.context_length in config.yaml: {_config_context_length!r}\n"
                f"  Must be a plain integer (e.g. 256000, not '256K').\n"
                f"  Falling back to auto-detected context window.\n",
                file=sys.stderr,
            )
            _config_context_length = None

    # Resolve custom_providers list once for reuse below (startup
    # context-length override and plugin context-engine init).
    try:
        from fan_cli.config import get_compatible_custom_providers
        _custom_providers = get_compatible_custom_providers(_agent_cfg)
    except Exception:
        _custom_providers = _agent_cfg.get("custom_providers")
        if not isinstance(_custom_providers, list):
            _custom_providers = []

    # Store for reuse by _check_compression_model_feasibility (auxiliary
    # compression model context-length detection needs the same list).
    agent._custom_providers = _custom_providers
    _merge_custom_provider_extra_body(agent, _custom_providers)

    # Check custom_providers per-model context_length
    if _config_context_length is None and _custom_providers:
        try:
            from fan_cli.config import get_custom_provider_context_length
            _cp_ctx_resolved = get_custom_provider_context_length(
                model=agent.model,
                base_url=agent.base_url,
                custom_providers=_custom_providers,
            )
            if _cp_ctx_resolved:
                _config_context_length = int(_cp_ctx_resolved)
        except Exception:
            _cp_ctx_resolved = None

        # Surface a clear warning if the user set a context_length but it
        # wasn't a valid positive int — the helper silently skips those.
        if _config_context_length is None:
            _target = agent.base_url.rstrip("/") if agent.base_url else ""
            for _cp_entry in _custom_providers:
                if not isinstance(_cp_entry, dict):
                    continue
                _cp_url = (_cp_entry.get("base_url") or "").rstrip("/")
                if _target and _cp_url == _target:
                    _cp_models = _cp_entry.get("models", {})
                    if isinstance(_cp_models, dict):
                        _cp_model_cfg = _cp_models.get(agent.model, {})
                        if isinstance(_cp_model_cfg, dict):
                            _cp_ctx = _cp_model_cfg.get("context_length")
                            if _cp_ctx is not None:
                                try:
                                    _parsed = int(_cp_ctx)
                                    if _parsed <= 0:
                                        raise ValueError
                                except (TypeError, ValueError):
                                    _ra().logger.warning(
                                        "Invalid context_length for model %r in "
                                        "custom_providers: %r — must be a positive "
                                        "integer (e.g. 256000, not '256K'). "
                                        "Falling back to auto-detection.",
                                        agent.model, _cp_ctx,
                                    )
                                    print(
                                        f"\n⚠ Invalid context_length for model {agent.model!r} in custom_providers: {_cp_ctx!r}\n"
                                        f"  Must be a positive integer (e.g. 256000, not '256K').\n"
                                        f"  Falling back to auto-detected context window.\n",
                                        file=sys.stderr,
                                    )
                    break

    # Persist for reuse on switch_model / fallback activation. Must come
    # AFTER the custom_providers branch so per-model overrides aren't lost.
    agent._config_context_length = _config_context_length

    agent._ensure_lmstudio_runtime_loaded(_config_context_length)



    # Select context engine: config-driven (like memory providers).
    # 1. Check config.yaml context.engine setting
    # 2. Check general plugin system (user-installed plugins)
    # 3. Fall back to built-in ContextCompressor
    _selected_engine = None
    _copy_failed = False
    _engine_name = "compressor"  # default
    try:
        _ctx_cfg = _agent_cfg.get("context", {}) if isinstance(_agent_cfg, dict) else {}
        _engine_name = _ctx_cfg.get("engine", "compressor") or "compressor"
    except Exception:
        pass

    if _engine_name != "compressor":
        _candidate = None
        try:
            from fan_cli.plugins import get_plugin_context_engine
            _candidate = get_plugin_context_engine()
        except Exception:
            _candidate = None

        if _candidate is not None and _candidate.name == _engine_name:
            # Plugin registration holds a process-wide singleton. Give every
            # agent its own mutable compressor state so a child agent's
            # update_model() cannot change its parent's context budget.
            import copy
            try:
                _selected_engine = copy.deepcopy(_candidate)
            except Exception as _copy_err:
                _copy_failed = True
                _ra().logger.warning(
                    "Context engine '%s' could not be safely copied for this "
                    "agent (%s) — falling back to the built-in compressor. "
                    "Plugin engines with uncopyable state should implement "
                    "__deepcopy__ for their mutable budget state.",
                    _engine_name,
                    _copy_err,
                )

        if _selected_engine is None and not _copy_failed:
            _ra().logger.warning(
                "Context engine '%s' not found — falling back to built-in compressor",
                _engine_name,
            )
    # else: config says "compressor" — use built-in, don't auto-activate plugins

    if _selected_engine is not None:
        agent.context_compressor = _selected_engine
        # Resolve context_length for plugin engines — mirrors switch_model() path
        from agent.model_metadata import get_model_context_length
        _plugin_ctx_len = get_model_context_length(
            agent.model,
            base_url=agent.base_url,
            api_key=getattr(agent, "api_key", ""),
            config_context_length=_config_context_length,
            provider=agent.provider,
            custom_providers=_custom_providers,
        )
        agent.context_compressor.update_model(
            model=agent.model,
            context_length=_plugin_ctx_len,
            base_url=agent.base_url,
            api_key=getattr(agent, "api_key", ""),
            provider=agent.provider,
            api_mode=agent.api_mode,
        )
        if not agent.quiet_mode:
            _ra().logger.info("Using context engine: %s", _selected_engine.name)
    else:
        agent.context_compressor = ContextCompressor(
            model=agent.model,
            threshold_percent=compression_threshold,
            protect_first_n=compression_protect_first,
            protect_last_n=compression_protect_last,
            summary_target_ratio=compression_target_ratio,
            summary_model_override=None,
            quiet_mode=agent.quiet_mode,
            base_url=agent.base_url,
            api_key=getattr(agent, "api_key", ""),
            config_context_length=_config_context_length,
            provider=agent.provider,
            api_mode=agent.api_mode,
            abort_on_summary_failure=compression_abort_on_summary_failure,
            max_tokens=agent.max_tokens,
        )
    _bind_session_state = getattr(agent.context_compressor, "bind_session_state", None)
    if callable(_bind_session_state):
        try:
            _bind_session_state(session_db=agent._session_db, session_id=agent.session_id)
        except Exception:
            pass
    agent.compression_enabled = compression_enabled

    # Reject models whose context window is below the minimum required
    # for reliable tool-calling workflows (64K tokens).
    _ctx = getattr(agent.context_compressor, "context_length", 0)
    if _ctx and _ctx < MINIMUM_CONTEXT_LENGTH:
        raise ValueError(
            f"Model {agent.model} has a context window of {_ctx:,} tokens, "
            f"which is below the minimum {MINIMUM_CONTEXT_LENGTH:,} required "
            f"by Fan Agent.  Choose a model with at least "
            f"{MINIMUM_CONTEXT_LENGTH // 1000}K context.  If your server "
            f"reports a window smaller than the model's true window, set "
            f"model.context_length in config.yaml to the real value "
            f"(this must be at least {MINIMUM_CONTEXT_LENGTH // 1000}K)."
        )

    # Inject context engine tool schemas (e.g. lcm_grep, lcm_describe, lcm_expand).
    # Skip names that are already present — the _ra().get_tool_definitions()
    # quiet_mode cache returned a shared list pre-#17335, so a stray
    # mutation here would poison subsequent agent inits in the same
    # long-lived backend and trip provider-side 'duplicate tool name'
    # errors. Even with the cache fix, dedup is the right defense
    # against plugin paths that may register the same schemas via
    # ctx.register_tool(). Mirrors the memory tools dedup above.
    #
    # Respect the local interface's enabled_toolsets configuration (#5544):
    # context engine tools follow the same gating pattern as memory
    # provider tools — without the gate, `platform_toolsets: cron: []`
    # would still leak lcm_* tools into the tool surface and incur the
    # same local-model latency penalty.
    agent._context_engine_tool_names: set = set()
    if (
        hasattr(agent, "context_compressor")
        and agent.context_compressor
        and agent.tools is not None
        and (
            agent.enabled_toolsets is None
            or "context_engine" in agent.enabled_toolsets
        )
    ):
        _existing_tool_names = {
            t.get("function", {}).get("name")
            for t in agent.tools
            if isinstance(t, dict)
        }
        from agent.memory_manager import normalize_tool_schema as _normalize_tool_schema
        for _raw_schema in agent.context_compressor.get_tool_schemas():
            _schema = _normalize_tool_schema(_raw_schema)
            if _schema is None:
                _ra().logger.warning(
                    "Context engine returned a tool schema with no resolvable "
                    "name; skipping to avoid poisoning the request (%r)",
                    _raw_schema,
                )
                continue
            _tname = _schema["name"]
            if _tname in _existing_tool_names:
                continue  # already registered via plugin/cache path
            _wrapped = {"type": "function", "function": _schema}
            agent.tools.append(_wrapped)
            agent.valid_tool_names.add(_tname)
            agent._context_engine_tool_names.add(_tname)
            _existing_tool_names.add(_tname)

    # Notify context engine of session start
    if hasattr(agent, "context_compressor") and agent.context_compressor:
        try:
            agent.context_compressor.on_session_start(
                agent.session_id,
                fan_home=str(get_fan_home()),
                platform=agent.platform or "cli",
                model=agent.model,
                context_length=getattr(agent.context_compressor, "context_length", 0),
                conversation_id=getattr(agent, "_gateway_session_key", None),
                session_db=agent._session_db,
            )
        except Exception as _ce_err:
            _ra().logger.debug("Context engine on_session_start: %s", _ce_err)

    agent._subdirectory_hints = SubdirectoryHintTracker(
        working_dir=os.getenv("TERMINAL_CWD") or None,
    )
    agent._user_turn_count = 0

    # Cumulative token usage for the session
    agent.session_prompt_tokens = 0
    agent.session_completion_tokens = 0
    agent.session_total_tokens = 0
    agent.session_api_calls = 0
    agent.session_input_tokens = 0
    agent.session_output_tokens = 0
    agent.session_cache_read_tokens = 0
    agent.session_cache_write_tokens = 0
    agent.session_reasoning_tokens = 0
    agent.session_estimated_cost_usd = 0.0
    agent.session_cost_status = "unknown"
    agent.session_cost_source = "none"
    
    # ── Ollama num_ctx injection ──
    # Ollama defaults to 2048 context regardless of the model's capabilities.
    # When running against an Ollama server, detect the model's max context
    # and pass num_ctx on every chat request so the full window is used.
    # User override: set model.ollama_num_ctx in config.yaml to cap VRAM use.
    # If model.context_length is set, it caps num_ctx so the user's VRAM
    # budget is respected even when GGUF metadata advertises a larger window.
    agent._ollama_num_ctx: int | None = None
    _ollama_num_ctx_override = None
    if isinstance(_model_cfg, dict):
        _ollama_num_ctx_override = _model_cfg.get("ollama_num_ctx")
    if _ollama_num_ctx_override is not None:
        try:
            agent._ollama_num_ctx = int(_ollama_num_ctx_override)
        except (TypeError, ValueError):
            _ra().logger.debug("Invalid ollama_num_ctx config value: %r", _ollama_num_ctx_override)
    if agent._ollama_num_ctx is None and agent.base_url and is_local_endpoint(agent.base_url):
        try:
            # ``agent.api_key`` may be a callable (Entra token provider).
            # Ollama detection makes a manual HTTP request and expects a
            # string — Azure Foundry isn't a local endpoint so this branch
            # never fires for Entra, but guard defensively.
            _key_for_ollama = agent.api_key if isinstance(agent.api_key, str) else ""
            _detected = query_ollama_num_ctx(agent.model, agent.base_url, api_key=_key_for_ollama or "")
            if _detected and _detected > 0:
                agent._ollama_num_ctx = _detected
        except Exception as exc:
            _ra().logger.debug("Ollama num_ctx detection failed: %s", exc)
    # Cap auto-detected ollama_num_ctx to the user's explicit context_length.
    # Without this, GGUF metadata can advertise 256K+ which Ollama honours
    # by allocating that much VRAM — blowing up small GPUs even though the
    # user explicitly set a smaller context_length in config.yaml.
    if (
        agent._ollama_num_ctx
        and _config_context_length
        and _ollama_num_ctx_override is None  # don't override explicit ollama_num_ctx
        and agent._ollama_num_ctx > _config_context_length
    ):
        _ra().logger.info(
            "Ollama num_ctx capped: %d -> %d (model.context_length override)",
            agent._ollama_num_ctx, _config_context_length,
        )
        agent._ollama_num_ctx = _config_context_length
    if agent._ollama_num_ctx and not agent.quiet_mode:
        _ra().logger.info(
            "Ollama num_ctx: will request %d tokens (model max from /api/show)",
            agent._ollama_num_ctx,
        )

    if not agent.quiet_mode:
        if compression_enabled:
            print(f"📊 Context limit: {agent.context_compressor.context_length:,} tokens (compress at {int(compression_threshold*100)}% = {agent.context_compressor.threshold_tokens:,})")
        else:
            print(f"📊 Context limit: {agent.context_compressor.context_length:,} tokens (auto-compression disabled)")

    # Check immediately so CLI users see the warning at startup.
    # Gateway status_callback is not yet wired, so any warning is stored
    # in _compression_warning and replayed in the first run_conversation().
    agent._compression_warning = None
    # Lazy feasibility check: deferred to the first turn that approaches the
    # compression threshold. Running it eagerly here costs ~400ms cold (network
    # probe of the auxiliary provider chain + /models lookup) on every agent
    # init, including short ``chat -q`` runs that never reach the threshold.
    # ``ensure_compression_feasibility_checked`` (called from
    # ``run_conversation``'s preflight) runs it at most once per agent.
    agent._compression_feasibility_checked = False

    # Snapshot primary runtime for per-turn restoration.  When fallback
    # activates during a turn, the next turn restores these values so the
    # preferred model gets a fresh attempt each time.  Uses a single dict
    # so new state fields are easy to add without N individual attributes.
    _cc = agent.context_compressor
    agent._primary_runtime = {
        "model": agent.model,
        "provider": agent.provider,
        "base_url": agent.base_url,
        "api_mode": agent.api_mode,
        "api_key": getattr(agent, "api_key", ""),
        "client_kwargs": dict(agent._client_kwargs),
        "use_prompt_caching": agent._use_prompt_caching,
        # Context engine state that _try_activate_fallback() overwrites.
        # Use getattr for model/base_url/api_key/provider since plugin
        # engines may not have these (they're ContextCompressor-specific).
        "compressor_model": getattr(_cc, "model", agent.model),
        "compressor_base_url": getattr(_cc, "base_url", agent.base_url),
        "compressor_api_key": getattr(_cc, "api_key", ""),
        "compressor_provider": getattr(_cc, "provider", agent.provider),
        "compressor_context_length": _cc.context_length,
        "compressor_threshold_tokens": _cc.threshold_tokens,
    }


__all__ = ["init_agent"]
