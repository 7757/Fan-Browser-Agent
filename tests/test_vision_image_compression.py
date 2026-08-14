from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image

import tools.vision_tools as vision_tools
from tools.vision_tools import (
    _PROXY_SAFE_RESIZE_TARGET_BYTES,
    _VISION_SEND_TARGET_BYTES,
    _image_retry_target_bytes,
    _resize_image_for_vision,
)


def _data_url_with_size(size: int) -> str:
    prefix = "data:image/jpeg;base64,"
    assert size >= len(prefix)
    return prefix + ("A" * (size - len(prefix)))


def _write_test_png(directory: Path) -> Path:
    image_path = directory / "source.png"
    Image.new("RGB", (32, 32), "white").save(image_path, format="PNG")
    return image_path


def _png_data_url() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "blue").save(buffer, format="PNG")
    return (
        "data:image/png;base64,"
        + base64.b64encode(buffer.getvalue()).decode("ascii")
    )


def _vision_response(content: str = "ok") -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )


def test_http_413_uses_proxy_safe_retry_target() -> None:
    target = _image_retry_target_bytes(
        RuntimeError("413 Request Entity Too Large"),
        1_354_536,
    )

    assert target == _PROXY_SAFE_RESIZE_TARGET_BYTES


def test_opaque_png_is_compressed_as_jpeg(tmp_path) -> None:
    image_path = tmp_path / "screenshot.png"
    Image.effect_noise((1024, 1024), 100).convert("RGB").save(
        image_path,
        format="PNG",
    )

    result = _resize_image_for_vision(
        image_path,
        mime_type="image/png",
        max_base64_bytes=256 * 1024,
    )

    assert result.startswith("data:image/jpeg;base64,")
    assert len(result) <= 256 * 1024
    with Image.open(io.BytesIO(base64.b64decode(result.partition(",")[2]))) as image:
        assert image.width > 0
        assert image.height > 0


def test_transparent_png_keeps_png_encoding(tmp_path) -> None:
    image_path = tmp_path / "transparent.png"
    image = Image.new("RGBA", (512, 512), (255, 255, 255, 255))
    image.putpixel((0, 0), (255, 255, 255, 0))
    image.save(image_path, format="PNG")

    result = _resize_image_for_vision(
        image_path,
        mime_type="image/png",
        max_base64_bytes=512,
    )

    assert result.startswith("data:image/png;base64,")


def test_native_path_accepts_compression_at_send_limit(tmp_path) -> None:
    image_path = _write_test_png(tmp_path)
    oversized_source = _data_url_with_size(_VISION_SEND_TARGET_BYTES + 1)
    compressed = _data_url_with_size(_VISION_SEND_TARGET_BYTES)

    with (
        patch.object(
            vision_tools,
            "_image_to_base64_data_url",
            return_value=oversized_source,
        ),
        patch.object(
            vision_tools,
            "_resize_image_for_vision",
            return_value=compressed,
        ),
    ):
        result = asyncio.run(
            vision_tools._vision_analyze_native(str(image_path), "describe")
        )

    assert result["_multimodal"] is True
    embedded = result["content"][1]["image_url"]["url"]
    assert len(embedded) == _VISION_SEND_TARGET_BYTES


def test_native_path_rejects_compression_above_send_limit(tmp_path) -> None:
    image_path = _write_test_png(tmp_path)
    oversized_source = _data_url_with_size(_VISION_SEND_TARGET_BYTES + 2)
    failed_compression = _data_url_with_size(_VISION_SEND_TARGET_BYTES + 1)

    with (
        patch.object(
            vision_tools,
            "_image_to_base64_data_url",
            return_value=oversized_source,
        ),
        patch.object(
            vision_tools,
            "_resize_image_for_vision",
            return_value=failed_compression,
        ),
    ):
        result = asyncio.run(
            vision_tools._vision_analyze_native(str(image_path), "describe")
        )

    error = json.loads(result)
    assert error["success"] is False
    assert "Native vision image compression failed" in error["error"]
    assert "1.00 MB limit" in error["error"]


def test_native_path_accepts_image_data_url_and_cleans_temp_file(tmp_path) -> None:
    with patch.object(vision_tools, "get_fan_dir", return_value=tmp_path):
        result = asyncio.run(
            vision_tools._vision_analyze_native(
                _png_data_url(),
                "read the image",
            )
        )

    assert result["_multimodal"] is True
    embedded = result["content"][1]["image_url"]["url"]
    assert embedded.startswith("data:image/png;base64,")
    assert list(tmp_path.iterdir()) == []


def test_aux_path_accepts_image_data_url_and_cleans_temp_file(tmp_path) -> None:
    sent_urls: list[str] = []

    async def capture_request(**kwargs) -> SimpleNamespace:
        sent_urls.append(kwargs["messages"][0]["content"][1]["image_url"]["url"])
        return _vision_response("blue square")

    with (
        patch.object(vision_tools, "get_fan_dir", return_value=tmp_path),
        patch.object(
            vision_tools,
            "async_call_llm",
            side_effect=capture_request,
        ),
    ):
        result = json.loads(
            asyncio.run(
                vision_tools.vision_analyze_tool(
                    _png_data_url(),
                    "describe",
                )
            )
        )

    assert result == {"success": True, "analysis": "blue square"}
    assert sent_urls[0].startswith("data:image/png;base64,")
    assert list(tmp_path.iterdir()) == []


def test_image_data_url_rejects_non_image_mime() -> None:
    data_url = "data:text/plain;base64," + base64.b64encode(b"hello").decode()

    try:
        vision_tools._decode_data_image_url(data_url)
    except ValueError as exc:
        assert "Unsupported image data URL MIME type" in str(exc)
    else:
        raise AssertionError("non-image data URL should be rejected")


def test_image_data_url_rejects_malformed_base64() -> None:
    try:
        vision_tools._decode_data_image_url("data:image/png;base64,%%%")
    except ValueError as exc:
        assert "malformed base64 payload" in str(exc)
    else:
        raise AssertionError("malformed data URL should be rejected")


def test_image_data_url_rejects_mime_mismatch_and_cleans_temp_file(
    tmp_path,
) -> None:
    mismatched = _png_data_url().replace(
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        1,
    )

    with patch.object(vision_tools, "get_fan_dir", return_value=tmp_path):
        try:
            vision_tools._decode_data_image_url(mismatched)
        except ValueError as exc:
            assert "does not match the decoded image" in str(exc)
        else:
            raise AssertionError("mismatched MIME should be rejected")

    assert list(tmp_path.iterdir()) == []


def test_image_data_url_enforces_decoded_size_limit() -> None:
    data_url = "data:image/png;base64," + base64.b64encode(b"abc").decode()

    with patch.object(vision_tools, "_VISION_MAX_DATA_URL_BYTES", 2):
        try:
            vision_tools._decode_data_image_url(data_url)
        except ValueError as exc:
            assert "too large" in str(exc)
        else:
            raise AssertionError("oversized data URL should be rejected")


def test_aux_path_does_not_send_compression_above_send_limit(tmp_path) -> None:
    image_path = _write_test_png(tmp_path)
    failed_compression = _data_url_with_size(_VISION_SEND_TARGET_BYTES + 1)
    call_llm = AsyncMock(return_value=_vision_response())

    with (
        patch.object(
            vision_tools,
            "_resize_image_for_vision",
            return_value=failed_compression,
        ),
        patch.object(vision_tools, "async_call_llm", call_llm),
    ):
        result = json.loads(
            asyncio.run(
                vision_tools.vision_analyze_tool(
                    str(image_path),
                    "describe",
                )
            )
        )

    assert result["success"] is False
    assert "Vision image compression failed" in result["error"]
    call_llm.assert_not_awaited()


def test_aux_413_retry_does_not_send_payload_above_retry_target(tmp_path) -> None:
    image_path = _write_test_png(tmp_path)
    first_payload = _data_url_with_size(_VISION_SEND_TARGET_BYTES)
    retry_target = _image_retry_target_bytes(
        RuntimeError("413 Request Entity Too Large"),
        len(first_payload),
    )
    failed_retry = _data_url_with_size(retry_target + 1)
    sent_sizes: list[int] = []

    async def reject_first_request(**kwargs) -> SimpleNamespace:
        data_url = kwargs["messages"][0]["content"][1]["image_url"]["url"]
        sent_sizes.append(len(data_url))
        raise RuntimeError("413 Request Entity Too Large")

    with (
        patch.object(
            vision_tools,
            "_resize_image_for_vision",
            side_effect=[first_payload, failed_retry],
        ),
        patch.object(
            vision_tools,
            "async_call_llm",
            side_effect=reject_first_request,
        ),
    ):
        result = json.loads(
            asyncio.run(
                vision_tools.vision_analyze_tool(
                    str(image_path),
                    "describe",
                )
            )
        )

    assert result["success"] is False
    assert "Vision retry image compression failed" in result["error"]
    assert sent_sizes == [_VISION_SEND_TARGET_BYTES]


def test_aux_413_retry_sends_payload_when_target_is_met(tmp_path) -> None:
    image_path = _write_test_png(tmp_path)
    first_payload = _data_url_with_size(_VISION_SEND_TARGET_BYTES)
    retry_target = _image_retry_target_bytes(
        RuntimeError("413 Request Entity Too Large"),
        len(first_payload),
    )
    retry_payload = _data_url_with_size(retry_target)
    sent_sizes: list[int] = []

    async def reject_then_accept(**kwargs) -> SimpleNamespace:
        data_url = kwargs["messages"][0]["content"][1]["image_url"]["url"]
        sent_sizes.append(len(data_url))
        if len(sent_sizes) == 1:
            raise RuntimeError("413 Request Entity Too Large")
        return _vision_response()

    with (
        patch.object(
            vision_tools,
            "_resize_image_for_vision",
            side_effect=[first_payload, retry_payload],
        ),
        patch.object(
            vision_tools,
            "async_call_llm",
            side_effect=reject_then_accept,
        ),
    ):
        result = json.loads(
            asyncio.run(
                vision_tools.vision_analyze_tool(
                    str(image_path),
                    "describe",
                )
            )
        )

    assert result["success"] is True
    assert sent_sizes == [_VISION_SEND_TARGET_BYTES, retry_target]


def test_aux_vision_request_stops_when_interrupted(tmp_path) -> None:
    image_path = _write_test_png(tmp_path)
    payload = _data_url_with_size(1024)
    checks = 0

    async def blocked_request(**_kwargs) -> SimpleNamespace:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    def interrupt_check() -> bool:
        nonlocal checks
        checks += 1
        return checks >= 2

    with (
        patch.object(
            vision_tools,
            "_resize_image_for_vision",
            return_value=payload,
        ),
        patch.object(
            vision_tools,
            "async_call_llm",
            side_effect=blocked_request,
        ),
    ):
        result = json.loads(
            asyncio.run(
                vision_tools.vision_analyze_tool(
                    str(image_path),
                    "列出图片里的模型",
                    interrupt_check=interrupt_check,
                )
            )
        )

    assert result["success"] is False
    assert result["error"] == "Vision analysis interrupted by user"
    assert checks >= 2


def test_text_main_vision_prompt_is_question_focused() -> None:
    analyze = AsyncMock(return_value='{"success": true, "analysis": "ok"}')

    with (
        patch.object(
            vision_tools,
            "_should_use_native_vision_fast_path",
            return_value=False,
        ),
        patch.object(vision_tools, "vision_analyze_tool", analyze),
    ):
        result = asyncio.run(
            vision_tools._handle_vision_analyze(
                {
                    "image_url": "/tmp/models.png",
                    "question": "列出图片里的模型",
                }
            )
        )

    assert json.loads(result)["success"] is True
    prompt = analyze.await_args.args[1]
    assert "列出图片里的模型" in prompt
    assert "Be concise" in prompt
    assert "Fully describe and explain everything" not in prompt
