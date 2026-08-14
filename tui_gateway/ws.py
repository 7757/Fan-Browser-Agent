"""WebSocket transport for the tui_gateway JSON-RPC server.

Reuses :func:`tui_gateway.server.dispatch` so every RPC method, slash command,
approval/collect/sudo flow, and agent event flows through the same
Electron/WebSocket connection.

Wire protocol
-------------
Newline-delimited JSON-RPC in both directions. The server emits a
``gateway.ready`` event immediately after connection accept, then echoes
responses/events for inbound requests.

Mounting
--------
    from fastapi import WebSocket
    from tui_gateway.ws import handle_ws

    @app.websocket("/api/ws")
    async def ws(ws: WebSocket):
        await handle_ws(ws)
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import threading
from typing import Any

from tui_gateway import server

_log = logging.getLogger(__name__)

# Max seconds a pool-dispatched handler will block waiting for the event loop
# to flush a WS frame before we mark the transport dead. Protects handler
# threads from a wedged socket.
_WS_WRITE_TIMEOUT_S = 10.0
_WS_LOG_PAYLOAD_PREVIEW = 240

# A streaming reply can emit hundreds of display-only delta frames in a short
# burst. Coalesce those frames briefly so their loop wakeups do not compete
# with an active agent turn for the GIL; control, tool, and completion frames
# still flush immediately and preserve order.
_STREAMING_EVENT_TYPES = frozenset(
    {"message.delta", "reasoning.delta", "thinking.delta"}
)
_TOKEN_COALESCE_S = 0.033

# Keep starlette optional at import time; handle_ws uses the real class when
# it's available and falls back to a generic Exception sentinel otherwise.
try:
    from starlette.websockets import WebSocketDisconnect as _WebSocketDisconnect
except ImportError:  # pragma: no cover - starlette is a required install path
    _WebSocketDisconnect = Exception  # type: ignore[assignment]


class WSTransport:
    """Per-connection WS transport.

    ``write`` is safe to call from any thread *other than* the event loop
    thread that owns the socket. Pool workers (the only real caller) run in
    their own threads, so marshalling onto the loop via
    :func:`asyncio.run_coroutine_threadsafe` + ``future.result()`` is correct
    and deadlock-free there.

    When called from the loop thread itself (e.g. by ``handle_ws`` for an
    inline response) the same call would deadlock: we'd schedule work onto
    the loop we're currently blocking. We detect that case and fire-and-
    forget instead. Callers that need to know when the bytes are on the wire
    should use :meth:`write_async` from the loop thread.
    """

    def __init__(
        self,
        ws: Any,
        loop: asyncio.AbstractEventLoop,
        *,
        peer: str = "unknown",
    ) -> None:
        self._ws = ws
        self._loop = loop
        self._peer = peer
        self._closed = False
        self._token_lock = threading.Lock()
        self._pending_tokens: list[str] = []
        self._token_flush_handle: asyncio.TimerHandle | None = None
        self._token_flush_armed = False

    @staticmethod
    def _is_streaming_frame(obj: dict) -> bool:
        params = obj.get("params") if isinstance(obj, dict) else None
        return isinstance(params, dict) and params.get("type") in _STREAMING_EVENT_TYPES

    def write(self, obj: dict) -> bool:
        if self._closed:
            return False

        line = json.dumps(obj, ensure_ascii=False)

        try:
            on_loop = asyncio.get_running_loop() is self._loop
        except RuntimeError:
            on_loop = False

        if self._is_streaming_frame(obj):
            with self._token_lock:
                self._pending_tokens.append(line)
                if not self._token_flush_armed:
                    self._token_flush_armed = True
                    self._loop.call_soon_threadsafe(self._arm_token_flush)
            return not self._closed

        # A non-streaming frame must never overtake preceding token frames.
        # Capture and schedule the complete batch under the same lock that
        # protects the coalescing timer.
        from agent.async_utils import safe_schedule_threadsafe
        with self._token_lock:
            self._pending_tokens.append(line)
            batch = self._pending_tokens
            self._pending_tokens = []
            if on_loop:
                self._loop.create_task(self._safe_send_many(batch))
                return True
            fut = safe_schedule_threadsafe(self._safe_send_many(batch), self._loop)
            if fut is None:
                self._closed = True
                return False

        try:
            fut.result(timeout=_WS_WRITE_TIMEOUT_S)
            return not self._closed
        except concurrent.futures.TimeoutError:  # builtin TimeoutError on 3.11+
            # The event loop is stalled (GIL-heavy agent turn, delegation
            # running N children), NOT the socket dead. The send coroutine is
            # already scheduled and will flush once the loop breathes — latching
            # _closed here permanently silenced live windows after one slow
            # write. Unblock the worker thread and keep the transport alive;
            # _safe_send latches on a real socket error when the frame fails.
            _log.warning(
                "ws write slow (loop stalled >%ss) peer=%s — frame left in flight",
                _WS_WRITE_TIMEOUT_S, self._peer,
            )
            return not self._closed
        except Exception as exc:
            self._closed = True
            _log.warning(
                "ws write failed peer=%s error_type=%s error=%s",
                self._peer, type(exc).__name__, exc,
            )
            return False

    def _arm_token_flush(self) -> None:
        """Schedule the buffered delta-frame flush on the owning loop."""
        if self._closed:
            return
        self._token_flush_handle = self._loop.call_later(
            _TOKEN_COALESCE_S, self._flush_tokens
        )

    def _flush_tokens(self) -> None:
        """Flush a coalesced streaming batch on the event-loop thread."""
        with self._token_lock:
            self._token_flush_handle = None
            self._token_flush_armed = False
            if not self._pending_tokens or self._closed:
                self._pending_tokens = []
                return
            batch = self._pending_tokens
            self._pending_tokens = []
            self._loop.create_task(self._safe_send_many(batch))

    async def write_async(self, obj: dict) -> bool:
        """Send from the owning event loop. Awaits until the frame is on the wire."""
        if self._closed:
            return False
        with self._token_lock:
            pending = self._pending_tokens
            self._pending_tokens = []
        if pending:
            await self._safe_send_many(pending)
        await self._safe_send(json.dumps(obj, ensure_ascii=False))
        return not self._closed

    async def _safe_send(self, line: str) -> None:
        try:
            await self._ws.send_text(line)
        except Exception as exc:
            self._closed = True
            _log.warning(
                "ws send failed peer=%s error_type=%s error=%s",
                self._peer, type(exc).__name__, exc,
            )

    async def _safe_send_many(self, lines: list[str]) -> None:
        """Send one ordered batch of already-serialized frames."""
        try:
            for line in lines:
                await self._ws.send_text(line)
        except Exception as exc:
            self._closed = True
            _log.warning(
                "ws send failed peer=%s error_type=%s error=%s",
                self._peer, type(exc).__name__, exc,
            )

    def close(self) -> None:
        self._closed = True
        handle = self._token_flush_handle
        if handle is not None:
            handle.cancel()
            self._token_flush_handle = None


def _ws_peer_label(ws: Any) -> str:
    """Return ``host:port`` when available, else a stable placeholder."""
    client = getattr(ws, "client", None)
    if client is None:
        return "unknown"
    host = getattr(client, "host", None) or "unknown"
    port = getattr(client, "port", None)
    return f"{host}:{port}" if port is not None else host


async def handle_ws(ws: Any) -> None:
    """Run one Electron/WebSocket gateway session."""
    peer = _ws_peer_label(ws)
    transport: WSTransport | None = None
    messages = 0
    parse_errors = 0
    dispatch_crashes = 0
    send_failures = 0
    disconnect_reason = "not_connected"

    try:
        await ws.accept()
        disconnect_reason = "connected"
        _log.info("ws accepted peer=%s", peer)

        transport = WSTransport(ws, asyncio.get_running_loop(), peer=peer)

        # WebSocket desktop sessions bypass the CLI entrypoint that normally
        # starts MCP discovery.  _make_agent only waits for an already-running
        # discovery thread, so without this trigger its first tool snapshot can
        # be MCP-less until a manual reload.  The shared starter is idempotent
        # and config-gated, so every connection can safely invoke it.
        from fan_cli.mcp_startup import start_background_mcp_discovery

        start_background_mcp_discovery(
            logger=_log,
            thread_name="tui-ws-mcp-discovery",
        )

        ready_ok = await transport.write_async(
            {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {
                    "type": "gateway.ready",
                    "payload": {"skin": server.resolve_skin()},
                },
            }
        )
        if not ready_ok:
            disconnect_reason = "ready_send_failed"
            send_failures += 1
            _log.error("ws ready frame send failed peer=%s", peer)
            return

        while True:
            try:
                raw = await ws.receive_text()
            except _WebSocketDisconnect as exc:
                disconnect_reason = (
                    "client_disconnect("
                    f"code={getattr(exc, 'code', None)},"
                    f"reason={getattr(exc, 'reason', None)})"
                )
                break
            except Exception:
                disconnect_reason = "receive_failed"
                _log.exception("ws receive failed peer=%s", peer)
                break

            line = raw.strip()
            if not line:
                continue
            messages += 1

            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                parse_errors += 1
                _log.warning(
                    "ws parse error peer=%s index=%d error=%s payload=%r",
                    peer,
                    messages,
                    exc,
                    line[:_WS_LOG_PAYLOAD_PREVIEW],
                )
                ok = await transport.write_async(
                    {
                        "jsonrpc": "2.0",
                        "error": {"code": -32700, "message": "parse error"},
                        "id": None,
                    }
                )
                if not ok:
                    disconnect_reason = "send_failed_after_parse_error"
                    send_failures += 1
                    _log.warning("ws parse-error reply send failed peer=%s", peer)
                    break
                continue

            # dispatch() may schedule long handlers on the pool; it returns
            # None in that case and the worker writes the response itself via
            # the transport we pass in (a separate thread, so transport.write
            # is the safe path there). For inline handlers it returns the
            # response dict, which we write here from the loop.
            req_id = req.get("id") if isinstance(req, dict) else None
            req_method = req.get("method") if isinstance(req, dict) else None
            try:
                resp = await asyncio.to_thread(server.dispatch, req, transport)
            except Exception:
                dispatch_crashes += 1
                _log.exception(
                    "ws dispatch crash peer=%s id=%s method=%s",
                    peer,
                    req_id,
                    req_method,
                )
                ok = await transport.write_async(
                    {
                        "jsonrpc": "2.0",
                        "error": {"code": -32603, "message": "internal error"},
                        "id": req_id if req_id is not None else None,
                    }
                )
                if not ok:
                    disconnect_reason = "send_failed_after_dispatch_crash"
                    send_failures += 1
                    _log.warning(
                        "ws dispatch-crash reply send failed peer=%s id=%s method=%s",
                        peer,
                        req_id,
                        req_method,
                    )
                    break
                continue
            if resp is not None and not await transport.write_async(resp):
                disconnect_reason = "send_failed_after_response"
                send_failures += 1
                _log.warning(
                    "ws response send failed peer=%s id=%s method=%s",
                    peer,
                    req_id,
                    req_method,
                )
                break
    finally:
        detached_sessions = 0
        reaped_scheduled = 0
        if transport is not None:
            transport.close()

            # Detach the transport from any sessions it owned so later emits
            # do not write to a closed socket. A quick reconnect/session.resume
            # can re-bind a live transport before the orphan reap fires.
            for _sid, sess in list(server._sessions.items()):
                if sess.get("transport") is transport:
                    sess["transport"] = None
                    detached_sessions += 1
                    try:
                        server._schedule_ws_orphan_reap(_sid)
                        reaped_scheduled += 1
                    except Exception:
                        _log.exception(
                            "ws orphan-reap schedule failed peer=%s sid=%s",
                            peer,
                            _sid,
                        )
        try:
            await ws.close()
        except Exception as exc:
            _log.debug("ws close failed peer=%s error=%s", peer, exc)
        _log.info(
            "ws closed peer=%s reason=%s messages=%d parse_errors=%d "
            "dispatch_crashes=%d send_failures=%d detached_sessions=%d",
            peer,
            disconnect_reason,
            messages,
            parse_errors,
            dispatch_crashes,
            send_failures,
            detached_sessions,
        )
