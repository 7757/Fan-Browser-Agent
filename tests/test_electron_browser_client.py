import errno
import io
import json
import os
import socket
import sys
import urllib.error
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.electron_browser_client import ElectronBrowserClient, ElectronBrowserRuntimeError


class _Response:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


def test_http_error_preserves_runtime_code_and_details():
    payload = {
        "ok": False,
        "error": "option not found",
        "errorCode": "DROPDOWN_OPTION_NOT_FOUND",
        "errorDetails": {"options": ["Blue", "Red"], "retryable": False},
    }
    http_error = urllib.error.HTTPError(
        "http://runtime.test/rpc",
        500,
        "Internal Server Error",
        {},
        io.BytesIO(json.dumps(payload).encode("utf-8")),
    )
    client = ElectronBrowserClient("http://runtime.test/rpc", "secret")

    with patch("urllib.request.urlopen", side_effect=http_error):
        try:
            client.call("select", params={"index": 3, "text": "Green"})
        except ElectronBrowserRuntimeError as exc:
            assert str(exc) == "option not found"
            assert exc.status == 500
            assert exc.code == "DROPDOWN_OPTION_NOT_FOUND"
            assert exc.details == {"options": ["Blue", "Red"], "retryable": False}
        else:
            raise AssertionError("expected ElectronBrowserRuntimeError")


def test_call_forwards_action_id_and_per_action_timeout():
    client = ElectronBrowserClient("http://runtime.test/rpc", "secret", timeout=60)
    with patch(
        "urllib.request.urlopen",
        return_value=_Response({"ok": True, "result": {"clicked": 7}}),
    ) as urlopen:
        result = client.call(
            "click",
            workbench_id="session-1",
            params={"index": 7},
            action_id="action-7",
            timeout=12.5,
        )

    request = urlopen.call_args.args[0]
    assert json.loads(request.data) == {
        "action": "click",
        "id": "session-1",
        "params": {"index": 7},
        "actionId": "action-7",
    }
    assert urlopen.call_args.kwargs["timeout"] == 12.5
    assert result == {"clicked": 7}


def test_transport_timeout_has_a_structured_runtime_code():
    client = ElectronBrowserClient("http://runtime.test/rpc", "secret")
    with patch(
        "urllib.request.urlopen",
        side_effect=urllib.error.URLError(socket.timeout("timed out")),
    ):
        try:
            client.call("click", params={"index": 7})
        except ElectronBrowserRuntimeError as exc:
            assert exc.code == "RUNTIME_REQUEST_TIMEOUT"
            assert exc.details == {"transportFailure": True}
        else:
            raise AssertionError("expected ElectronBrowserRuntimeError")


@pytest.mark.parametrize(
    "reason",
    [
        ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"),
        socket.gaierror(socket.EAI_NONAME, "Name or service not known"),
        OSError(errno.ENETUNREACH, "Network is unreachable"),
    ],
)
def test_explicit_pre_dispatch_transport_failure_is_marked(reason):
    client = ElectronBrowserClient("http://runtime.test/rpc", "secret")
    with patch(
        "urllib.request.urlopen",
        side_effect=urllib.error.URLError(reason),
    ):
        with pytest.raises(ElectronBrowserRuntimeError) as raised:
            client.call("click", params={"index": 7})

    assert raised.value.details == {
        "transportFailure": True,
        "beforeDispatch": True,
        "dispatchAttempted": False,
    }


def test_connection_reset_remains_ambiguous():
    client = ElectronBrowserClient("http://runtime.test/rpc", "secret")
    with patch(
        "urllib.request.urlopen",
        side_effect=urllib.error.URLError(
            ConnectionResetError(errno.ECONNRESET, "Connection reset")
        ),
    ):
        with pytest.raises(ElectronBrowserRuntimeError) as raised:
            client.call("click", params={"index": 7})

    assert raised.value.details == {"transportFailure": True}
