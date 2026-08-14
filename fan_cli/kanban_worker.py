"""Headless kanban worker runtime.

The kanban dispatcher (running inside the desktop backend) executes each
card on a worker subprocess. Historically that subprocess was
``fan chat -q "work kanban task <id>"`` — the CLI chat entrypoint. The
chat/oneshot entrypoints were removed when Fan became desktop-only
(95111e2), so the worker runtime now lives here, reached via the internal
``fan kanban worker-run -q …`` subcommand. It is registered hidden and is
spawned only by ``kanban_db._default_spawn`` — not an interactive entry.

This is a faithful port of the former quiet single-query path from
``cli.main()`` plus ``_run_kanban_goal_loop_q`` (both recovered from git,
pre-430dcf6): one quiet agent turn, task-body image enrichment, an
optional goal loop for goal_mode cards, and kanban-aware exit codes
(``KANBAN_RATE_LIMIT_EXIT_CODE`` so the dispatcher's reap classifier can
release rate-limited cards without tripping the failure counter).
"""

from __future__ import annotations

import atexit
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def run_worker(
    query: str,
    *,
    model: Optional[str] = None,
    skills=None,
) -> int:
    """Run one headless quiet agent turn (plus goal loop) and return an exit code.

    Mirrors the former ``cli.main(query=…, quiet=True)`` worker path. The
    dispatcher communicates task context via FAN_KANBAN_* env vars set in
    ``kanban_db._default_spawn``; ``model``/``skills`` arrive as top-level
    ``fan -m … --skills …`` flags placed before the subcommand.
    """
    query = (query or "").strip()
    if not query:
        print("kanban worker-run: empty query", file=sys.stderr)
        return 2

    # Tools (e.g. terminal sudo prompts) check this to decide whether an
    # interactive TTY exists; workers behave like the old chat -q runs.
    os.environ["FAN_INTERACTIVE"] = "1"

    # Heavy import — cli builds CLI_CONFIG at import time. Lazy so that
    # `fan kanban list` etc. never pay for it.
    import cli as cli_mod
    from cli import FanSession

    # Default toolsets: same resolver as the old chat path so MCP servers
    # are included at runtime.
    from fan_cli.tools_config import _get_platform_tools

    toolsets_list = sorted(_get_platform_tools(cli_mod.CLI_CONFIG, "cli"))

    parsed_skills = cli_mod._parse_skills_argument(skills)

    cli = FanSession(
        model=model,
        toolsets=toolsets_list,
        verbose=False,
        compact=True,
    )

    if parsed_skills:
        skills_prompt, loaded_skills, missing_skills = cli_mod.build_preloaded_skills_prompt(
            parsed_skills,
            task_id=cli.session_id,
        )
        if missing_skills:
            # A stale skill name on a card must not kill the worker — warn
            # and continue with whatever loaded. (The old chat path raised;
            # workers are headless so robustness wins here.)
            print(
                f"kanban worker-run: unknown skill(s) skipped: {', '.join(missing_skills)}",
                file=sys.stderr,
            )
        if skills_prompt:
            cli.system_prompt = "\n\n".join(
                part for part in (cli.system_prompt, skills_prompt) if part
            ).strip()
            cli.preloaded_skills = loaded_skills

    atexit.register(cli_mod._run_cleanup)

    # Signal handling for dispatcher-spawned workers (#28181): SIGTERM hits
    # a worker that's likely in a non-daemon thread waiting on a child
    # subprocess. Raising KeyboardInterrupt only unwinds the main thread;
    # the process gets reparented and the dispatcher's _pid_alive check
    # returns True forever — task stuck in 'running'. Route the signal
    # through agent.interrupt() with a grace window, then os._exit(0) so
    # the kernel reclaims the PID and detect_crashed_workers can reclaim
    # the stale claim on the next tick.
    def _signal_handler_q(signum, frame):
        logger.debug("Received signal %s in kanban worker", signum)
        try:
            _agent = getattr(cli, "agent", None)
            if _agent is not None:
                _agent.interrupt(f"received signal {signum}")
                try:
                    _grace = float(os.getenv("FAN_SIGTERM_GRACE", "1.5"))
                except (TypeError, ValueError):
                    _grace = 1.5
                if _grace > 0:
                    time.sleep(_grace)
        except Exception:
            pass  # never block signal handling
        if os.environ.get("FAN_KANBAN_TASK"):
            try:
                import signal as _sig_mod

                if hasattr(_sig_mod, "SIGALRM"):
                    # Deadman guard for the flushes below.
                    _sig_mod.signal(_sig_mod.SIGALRM, lambda *_: os._exit(0))
                    _sig_mod.alarm(2)
            except Exception:
                pass
            try:
                # File logging is queue-backed so a worker's hard exit must
                # give its listener a bounded chance to finish before the
                # regular logging shutdown closes the target handlers.
                from fan_logging import drain_log_queue

                drain_log_queue(timeout=1.0)
            except Exception:
                pass
            try:
                logging.shutdown()
            except Exception:
                pass
            for _stream in (sys.stdout, sys.stderr):
                try:
                    _stream.flush()
                except Exception:
                    pass
            os._exit(0)
        raise KeyboardInterrupt()

    try:
        import signal as _signal

        _signal.signal(_signal.SIGINT, _signal_handler_q)
        _signal.signal(_signal.SIGTERM, _signal_handler_q)
        if hasattr(_signal, "SIGHUP"):
            _signal.signal(_signal.SIGHUP, _signal_handler_q)
    except Exception:
        pass  # signal handler may fail in restricted environments

    query, single_query_images = cli_mod._collect_query_images(query, None)

    # The actual task description lives in the card body. Mirror the
    # gateway/CLI behaviour for inbound images by scanning the body for
    # local image paths and http(s) image URLs and attaching them to the
    # worker's first turn.
    single_query_image_urls: list[str] = []
    _kanban_task_id = os.environ.get("FAN_KANBAN_TASK", "").strip()
    if _kanban_task_id:
        try:
            from fan_cli import kanban_db as _kb
            from agent.image_routing import extract_image_refs as _extract_refs

            _conn = _kb.connect()
            try:
                _task = _kb.get_task(_conn, _kanban_task_id)
            finally:
                try:
                    _conn.close()
                except Exception:
                    pass
            _body = getattr(_task, "body", "") if _task is not None else ""
            if _body:
                _kb_paths, _kb_urls = _extract_refs(_body)
                if _kb_paths:
                    _seen = {str(p) for p in single_query_images}
                    for _p in _kb_paths:
                        if _p not in _seen:
                            _seen.add(_p)
                            single_query_images.append(Path(_p))
                if _kb_urls:
                    single_query_image_urls.extend(_kb_urls)
        except Exception as _exc:
            # Best-effort enrichment; never block worker startup on it.
            logger.debug("kanban image-ref extraction failed: %s", _exc)

    # Quiet mode: suppress banner, spinner, tool previews. Only print the
    # final response and parseable session info.
    cli.tool_progress_mode = "off"
    if not cli._ensure_runtime_credentials():
        return 1

    effective_query: Any = query
    if single_query_images or single_query_image_urls:
        # Honour the same image-routing decision used by the interactive
        # path: vision-capable model → native image_url content parts,
        # otherwise the text pipeline (vision_analyze pre-description).
        _img_mode = "text"
        _build_parts = None
        try:
            from agent.image_routing import (
                build_native_content_parts as _build_parts,  # noqa: F811
            )
            from agent.image_routing import decide_image_input_mode
            from fan_cli.config import load_config

            _img_mode = decide_image_input_mode(
                (cli.provider or "").strip(),
                (cli.model or "").strip(),
                load_config(),
            )
        except Exception:
            _img_mode = "text"

        if _img_mode == "native" and _build_parts is not None:
            try:
                _parts, _skipped = _build_parts(
                    query if isinstance(query, str) else "",
                    [str(p) for p in single_query_images],
                    image_urls=list(single_query_image_urls) or None,
                )
                if any(p.get("type") == "image_url" for p in _parts):
                    effective_query = _parts
                else:
                    # All images unreadable — text fallback. URLs would be
                    # lost in the text pipeline, so keep the original query
                    # text intact when only URLs were supplied.
                    if single_query_images:
                        effective_query = cli._preprocess_images_with_vision(
                            query, single_query_images, announce=False,
                        )
            except Exception:
                if single_query_images:
                    effective_query = cli._preprocess_images_with_vision(
                        query, single_query_images, announce=False,
                    )
        elif single_query_images:
            effective_query = cli._preprocess_images_with_vision(
                query,
                single_query_images,
                announce=False,
            )

    turn_route = cli._resolve_turn_agent_config(effective_query)
    if turn_route["signature"] != cli._active_agent_route_signature:
        cli.agent = None
    if not cli._init_agent(
        model_override=turn_route["model"],
        runtime_override=turn_route["runtime"],
        request_overrides=turn_route.get("request_overrides"),
    ):
        return 1

    cli.agent.quiet_mode = True
    cli.agent.suppress_status_output = True
    # Suppress streaming display callbacks so stdout stays machine-readable
    # (no styled "Fan" box, no tool-gen status lines). The response is
    # printed once below.
    cli.agent.stream_delta_callback = None
    cli.agent.tool_gen_callback = None
    try:
        result = cli.agent.run_conversation(
            user_message=effective_query,
            conversation_history=cli.conversation_history,
        )
    except KeyboardInterrupt:
        cli_mod._emit_interrupted_session_end(cli, reason="keyboard_interrupt")
        print(f"\nsession_id: {cli.session_id}", file=sys.stderr)
        return 130

    # Sync session_id if mid-run compression created a continuation
    # session — the exit line reports session_id to stderr for automation
    # wrappers; without this sync it would point at the ended parent.
    if (
        getattr(cli.agent, "session_id", None)
        and cli.agent.session_id != cli.session_id
    ):
        cli.session_id = cli.agent.session_id

    response = result.get("final_response", "") if isinstance(result, dict) else str(result)
    # Surface backend errors that produced no visible output (e.g. invalid
    # model slug → provider 4xx). Stderr so piped stdout stays clean.
    if (
        not response
        and isinstance(result, dict)
        and result.get("error")
        and (result.get("failed") or result.get("partial"))
    ):
        print(f"Error: {result['error']}", file=sys.stderr)
    elif response:
        print(response)

    # Kanban goal-loop mode: a worker spawned for a goal_mode card keeps
    # working in THIS session until an auxiliary judge agrees the card is
    # done, the worker terminates the task itself, or the turn budget runs
    # out (→ sticky block). Gated on the env vars the dispatcher sets in
    # ``_default_spawn``; a no-op for every normal worker.
    if os.environ.get("FAN_KANBAN_GOAL_MODE") == "1":
        try:
            _run_goal_loop(cli, response)
        except Exception as _goal_exc:
            logger.debug("kanban goal loop failed: %s", _goal_exc)

    # Session ID goes to stderr so piped stdout is clean.
    print(f"\nsession_id: {cli.session_id}", file=sys.stderr)

    # Exit-code contract for the dispatcher's reap classifier: when the run
    # failed purely because the provider rate-limited / exhausted quota
    # (not because the task itself is broken), exit with the EX_TEMPFAIL
    # sentinel instead of the generic 1 so the task is released back to
    # ``ready`` WITHOUT incrementing the failure counter.
    _exit_code = 0
    if isinstance(result, dict) and result.get("failed"):
        _exit_code = 1
        if os.environ.get("FAN_KANBAN_TASK") and result.get("failure_reason") in (
            "rate_limit",
            "billing",
        ):
            try:
                from fan_cli.kanban_db import (
                    KANBAN_RATE_LIMIT_EXIT_CODE as _RL_CODE,
                )

                _exit_code = _RL_CODE
            except Exception:
                _exit_code = 1
    return _exit_code


def _run_goal_loop(cli, first_response: str) -> None:
    """Drive a kanban goal_mode worker through the Ralph-style goal loop.

    Called AFTER the worker's first turn, only when ``FAN_KANBAN_GOAL_MODE``
    is set (dispatcher-spawned goal_mode card). Wires the worker's
    ``run_conversation`` and the kanban DB into ``goals.run_kanban_goal_loop``.
    All errors are swallowed by the caller — a broken goal loop must never
    wedge a worker, the dispatcher's claim TTL / crash detection is the
    backstop.
    """
    task_id = (os.environ.get("FAN_KANBAN_TASK") or "").strip()
    if not task_id:
        return

    from fan_cli import kanban_db as _kb
    from fan_cli.goals import run_kanban_goal_loop as _run_loop, DEFAULT_MAX_TURNS as _DEF_TURNS

    # Resolve goal text from the card (title + body = the acceptance
    # criteria the judge evaluates against).
    conn = _kb.connect()
    try:
        task = _kb.get_task(conn, task_id)
    finally:
        try:
            conn.close()
        except Exception:
            pass
    if task is None:
        return

    goal_parts = [task.title or ""]
    if task.body:
        goal_parts.append(task.body)
    goal_text = "\n\n".join(p for p in goal_parts if p).strip()
    if not goal_text:
        return

    max_turns = task.goal_max_turns or _DEF_TURNS

    def _run_turn(prompt: str) -> str:
        result = cli.agent.run_conversation(
            user_message=prompt,
            conversation_history=cli.conversation_history,
        )
        # Keep session_id in sync if mid-run compression rotated it.
        if (
            getattr(cli.agent, "session_id", None)
            and cli.agent.session_id != cli.session_id
        ):
            cli.session_id = cli.agent.session_id
        resp = result.get("final_response", "") if isinstance(result, dict) else str(result)
        if resp:
            print(resp)
        return resp or ""

    def _task_status() -> "str | None":
        c = _kb.connect()
        try:
            t = _kb.get_task(c, task_id)
            return t.status if t is not None else None
        finally:
            try:
                c.close()
            except Exception:
                pass

    def _block(reason: str) -> None:
        c = _kb.connect()
        try:
            _kb.block_task(c, task_id, reason=reason)
        finally:
            try:
                c.close()
            except Exception:
                pass

    _run_loop(
        task_id=task_id,
        goal_text=goal_text,
        run_turn=_run_turn,
        task_status_fn=_task_status,
        block_fn=_block,
        max_turns=max_turns,
        first_response=first_response or "",
        log=lambda m: logger.info("%s", m),
    )
