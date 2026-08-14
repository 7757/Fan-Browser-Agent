from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from fan_cli import web_server
from tui_gateway import ws as gateway_ws


_TOKEN = "gateway-websocket-test-token"
_LOOPBACK_HEADERS = {
    "host": "127.0.0.1",
    "origin": "http://127.0.0.1",
}


@pytest.fixture
def gateway_dispatches(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    dispatches: list[str] = []

    async def handle_ws(socket: Any) -> None:
        dispatches.append(socket.query_params.get("token", ""))
        await socket.accept()
        await socket.send_json({"ready": True})
        await socket.close(code=1000)

    monkeypatch.setattr(web_server, "_SESSION_TOKEN", _TOKEN)
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_host", "127.0.0.1", raising=False)
    monkeypatch.setattr(gateway_ws, "handle_ws", handle_ws)
    return dispatches


@pytest.mark.parametrize(
    ("url", "headers", "client_host", "expected_close_code"),
    [
        ("/api/ws", _LOOPBACK_HEADERS, "testclient", 4401),
        ("/api/ws?token=wrong", _LOOPBACK_HEADERS, "testclient", 4401),
        (
            f"/api/ws?token={_TOKEN}",
            {"host": "evil.example", "origin": "http://127.0.0.1"},
            "testclient",
            4403,
        ),
        (
            f"/api/ws?token={_TOKEN}",
            {"host": "127.0.0.1", "origin": "https://evil.example"},
            "testclient",
            4403,
        ),
        (f"/api/ws?token={_TOKEN}", _LOOPBACK_HEADERS, "203.0.113.10", 4403),
    ],
    ids=["missing-token", "wrong-token", "wrong-host", "wrong-origin", "non-loopback"],
)
def test_gateway_websocket_rejects_unauthorized_upgrade_before_dispatch(
    gateway_dispatches: list[str],
    url: str,
    headers: dict[str, str],
    client_host: str,
    expected_close_code: int,
) -> None:
    with TestClient(web_server.app, client=(client_host, 50_000)) as client:
        with pytest.raises(WebSocketDisconnect) as caught:
            with client.websocket_connect(url, headers=headers):
                pass

    assert caught.value.code == expected_close_code
    assert gateway_dispatches == []


def test_gateway_websocket_accepts_valid_loopback_token_and_dispatches(
    gateway_dispatches: list[str],
) -> None:
    with TestClient(web_server.app) as client:
        with client.websocket_connect(
            f"/api/ws?token={_TOKEN}",
            headers=_LOOPBACK_HEADERS,
        ) as socket:
            assert socket.receive_json() == {"ready": True}

    assert gateway_dispatches == [_TOKEN]
