#!/usr/bin/env python3
"""
Vision Tools Module

This module provides vision analysis tools that work with image URLs.
Uses the centralized auxiliary vision router, which can select the active
Fan model or a custom OpenAI-compatible endpoint.

Available tools:
- vision_analyze_tool: Analyze images from URLs with custom prompts

Features:
- Downloads images from URLs and converts to base64 for API compatibility
- Comprehensive image description
- Context-aware analysis based on user queries
- Automatic temporary file cleanup
- Proper error handling and validation
- Debug logging support

Usage:
    from vision_tools import vision_analyze_tool
    import asyncio
    
    # Analyze an image
    result = await vision_analyze_tool(
        image_url="https://example.com/image.jpg",
        user_prompt="What architectural style is this building?"
    )
"""

import asyncio
import base64
import binascii
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional
from urllib.parse import urlparse
import httpx
from agent.auxiliary_client import async_call_llm, extract_content_or_reasoning
from fan_constants import get_fan_dir
from tools.debug_helpers import DebugSession
from tools.website_policy import check_website_access
import sys

logger = logging.getLogger(__name__)

_debug = DebugSession("vision_tools", env_var="VISION_TOOLS_DEBUG")

# Configurable HTTP download timeout for _download_image().
# Separate from auxiliary.vision.timeout which governs the LLM API call.
# Resolution: config.yaml auxiliary.vision.download_timeout → env var → 30s default.
def _image_url_shape_ok(url: str) -> bool:
    """HTTP(S) shape check only (scheme, netloc). No DNS."""
    if not url or not isinstance(url, str):
        return False
    # Basic HTTP/HTTPS URL check
    if not url.startswith(("http://", "https://")):
        return False
    # Parse to ensure we at least have a network location; still allow URLs
    # without file extensions (e.g. CDN endpoints that redirect to images).
    parsed = urlparse(url)
    if not parsed.netloc:
        return False
    return True


def _validate_image_url(url: str) -> bool:
    """Validate image URL for sync callers and tests (SSRF via sync DNS check)."""
    if not _image_url_shape_ok(url):
        return False
    # Block private/internal addresses to prevent SSRF
    from tools.url_safety import is_safe_url
    return is_safe_url(url)


async def _validate_image_url_async(url: str) -> bool:
    """Validate remote image URL without blocking the event loop on DNS."""
    if not _image_url_shape_ok(url):
        return False
    from tools.url_safety import async_is_safe_url
    return await async_is_safe_url(url)


def _resolve_download_timeout() -> float:
    env_val = os.getenv("FAN_VISION_DOWNLOAD_TIMEOUT", "").strip()
    if env_val:
        try:
            return float(env_val)
        except ValueError:
            pass
    try:
        from fan_cli.config import cfg_get, load_config
        cfg = load_config()
        val = cfg_get(cfg, "auxiliary", "vision", "download_timeout")
        if val is not None:
            return float(val)
    except Exception:
        pass
    return 30.0

_VISION_DOWNLOAD_TIMEOUT = _resolve_download_timeout()

# Hard cap on downloaded image file size (50 MB). Prevents OOM from
# attacker-hosted multi-gigabyte files or decompression bombs.
_VISION_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

# Data URLs are subject to the same decoded-byte ceiling as downloaded images.
# Keep the accepted MIME set aligned with the formats that the existing local
# file path can validate in ``_detect_image_mime_type``.
_VISION_MAX_DATA_URL_BYTES = _VISION_MAX_DOWNLOAD_BYTES
_DATA_IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
}



def _detect_image_mime_type(image_path: Path) -> Optional[str]:
    """Return a MIME type when the file looks like a supported image."""
    with image_path.open("rb") as f:
        header = f.read(64)

    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header.startswith(b"BM"):
        return "image/bmp"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    if image_path.suffix.lower() == ".svg":
        head = image_path.read_text(encoding="utf-8", errors="ignore")[:4096].lower()
        if "<svg" in head:
            return "image/svg+xml"
    return None


def _decode_data_image_url(
    image_url: str,
) -> Optional[tuple[Path, str]]:
    """Decode a strict base64 image data URL into a temporary image file.

    Returns ``None`` for non-data URLs so callers can preserve their existing
    local-path and HTTP(S) resolution. A data URL is accepted only when it has
    the exact ``data:<supported image MIME>;base64,<payload>`` shape, contains
    valid base64, stays within the decoded image-size ceiling, and its bytes
    match the declared MIME type.

    The returned file belongs to the caller and must be deleted in ``finally``.
    """
    if not isinstance(image_url, str) or not image_url.startswith("data:"):
        return None

    header, separator, payload = image_url.partition(",")
    metadata = header[len("data:"):].split(";")
    if (
        not separator
        or len(metadata) != 2
        or metadata[1].lower() != "base64"
    ):
        raise ValueError(
            "Invalid image data URL. Expected "
            "data:image/<supported-format>;base64,<payload>."
        )

    mime_type = metadata[0].lower()
    suffix = _DATA_IMAGE_SUFFIXES.get(mime_type)
    if suffix is None:
        raise ValueError(
            f"Unsupported image data URL MIME type: {metadata[0] or '(missing)'}."
        )
    if not payload:
        raise ValueError("Invalid image data URL: base64 payload is empty.")

    # Reject an oversized payload before decoding so a caller cannot force a
    # much larger temporary allocation merely by supplying base64 text.
    max_encoded_bytes = ((_VISION_MAX_DATA_URL_BYTES + 2) // 3) * 4
    if len(payload) > max_encoded_bytes:
        raise ValueError(
            "Image data URL is too large "
            f"(decoded limit {_VISION_MAX_DATA_URL_BYTES} bytes)."
        )

    try:
        image_bytes = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid image data URL: malformed base64 payload.") from exc

    if not image_bytes:
        raise ValueError("Invalid image data URL: decoded image is empty.")
    if len(image_bytes) > _VISION_MAX_DATA_URL_BYTES:
        raise ValueError(
            f"Image data URL is too large ({len(image_bytes)} bytes, "
            f"max {_VISION_MAX_DATA_URL_BYTES})."
        )

    temp_dir = get_fan_dir("cache/vision", "temp_vision_images")
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = temp_dir / f"temp_data_image_{uuid.uuid4()}{suffix}"
    try:
        temp_path.write_bytes(image_bytes)
        detected_mime_type = _detect_image_mime_type(temp_path)
        if detected_mime_type != mime_type:
            raise ValueError(
                "Image data URL MIME type does not match the decoded image "
                f"(declared {mime_type}, detected "
                f"{detected_mime_type or 'unknown'})."
            )
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise

    return temp_path, mime_type


def _is_retryable_download_error(error: Exception) -> bool:
    """Return True only for transient image-download failures worth retrying.

    Non-retryable (fail-fast):
      - httpx.HTTPStatusError with a 4xx status other than 429 (404/403/410/...):
        the resource is missing or forbidden; retrying can't change that.
      - PermissionError: blocked by website policy / SSRF guard.
      - ValueError: image too large or blocked redirect — deterministic.

    Retryable (transient):
      - httpx 429 (rate limited) and 5xx (server-side) errors.
      - Connection/timeout/transport errors (httpx.TransportError) and any
        other unclassified exception, which may be a flaky network blip.
    """
    if isinstance(error, (PermissionError, ValueError)):
        return False
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if 400 <= status < 500 and status != 429:
            return False
        return True
    return True


async def _download_image(image_url: str, destination: Path, max_retries: int = 3) -> Path:
    """
    Download an image from a URL to a local destination (async) with retry logic.
    
    Args:
        image_url (str): The URL of the image to download
        destination (Path): The path where the image should be saved
        max_retries (int): Maximum number of retry attempts (default: 3)
        
    Returns:
        Path: The path to the downloaded image
        
    Raises:
        Exception: If download fails after all retries
    """
    import asyncio
    
    # Create parent directories if they don't exist
    destination.parent.mkdir(parents=True, exist_ok=True)
    
    async def _ssrf_redirect_guard(response):
        """Re-validate each redirect target to prevent redirect-based SSRF.

        Without this, an attacker can host a public URL that 302-redirects
        to http://169.254.169.254/ and bypass the pre-flight is_safe_url check.

        Must be async because httpx.AsyncClient awaits event hooks.
        """
        if response.is_redirect and response.next_request:
            redirect_url = str(response.next_request.url)
            from tools.url_safety import async_is_safe_url
            if not await async_is_safe_url(redirect_url):
                raise ValueError(
                    f"Blocked redirect to private/internal address: {redirect_url}"
                )

    last_error = None
    for attempt in range(max_retries):
        try:
            blocked = check_website_access(image_url)
            if blocked:
                raise PermissionError(blocked["message"])

            # Download the image with appropriate headers using async httpx
            # Enable follow_redirects to handle image CDNs that redirect (e.g., Imgur, Picsum)
            # SSRF: event_hooks validates each redirect target against private IP ranges
            async with httpx.AsyncClient(
                timeout=_VISION_DOWNLOAD_TIMEOUT,
                follow_redirects=True,
                event_hooks={"response": [_ssrf_redirect_guard]},
            ) as client:
                response = await client.get(
                    image_url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "image/*,*/*;q=0.8",
                    },
                )
                response.raise_for_status()

                # Reject overly large images early via Content-Length header.
                cl = response.headers.get("content-length")
                if cl and int(cl) > _VISION_MAX_DOWNLOAD_BYTES:
                    raise ValueError(
                        f"Image too large ({int(cl)} bytes, max {_VISION_MAX_DOWNLOAD_BYTES})"
                    )

                final_url = str(response.url)
                blocked = check_website_access(final_url)
                if blocked:
                    raise PermissionError(blocked["message"])
                
                # Save the image content (double-check actual size)
                body = response.content
                if len(body) > _VISION_MAX_DOWNLOAD_BYTES:
                    raise ValueError(
                        f"Image too large ({len(body)} bytes, max {_VISION_MAX_DOWNLOAD_BYTES})"
                    )
                destination.write_bytes(body)
            
            return destination
        except Exception as e:
            last_error = e
            # Error-class-aware retry: only retry transient failures. A 4xx
            # client error (404/403/410, etc.) will never succeed on retry —
            # the resource isn't there or we're not allowed — so burning 3
            # attempts with 2s/4s/8s backoff just inflates latency. 429 (rate
            # limit) and 5xx remain retryable. PermissionError (policy block)
            # and ValueError (too-large / SSRF redirect) are also terminal.
            if not _is_retryable_download_error(e) or attempt >= max_retries - 1:
                logger.error(
                    "Image download failed after %s attempt(s): %s",
                    attempt + 1,
                    str(e)[:100],
                    exc_info=True,
                )
                raise
            wait_time = 2 ** (attempt + 1)  # 2s, 4s, 8s
            logger.warning("Image download failed (attempt %s/%s): %s", attempt + 1, max_retries, str(e)[:50])
            logger.warning("Retrying in %ss...", wait_time)
            await asyncio.sleep(wait_time)

    # The loop always returns on success or re-raises on the final/non-retryable
    # attempt, so reaching here means max_retries was non-positive.
    if last_error is not None:
        raise last_error
    raise RuntimeError(
        f"_download_image exited retry loop without attempting (max_retries={max_retries})"
    )


def _determine_mime_type(image_path: Path) -> str:
    """
    Determine the MIME type of an image based on its file extension.
    
    Args:
        image_path (Path): Path to the image file
        
    Returns:
        str: The MIME type (defaults to image/jpeg if unknown)
    """
    extension = image_path.suffix.lower()
    mime_types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
    }
    return mime_types.get(extension, 'image/jpeg')


def _image_to_base64_data_url(image_path: Path, mime_type: Optional[str] = None) -> str:
    """
    Convert an image file to a base64-encoded data URL.
    
    Args:
        image_path (Path): Path to the image file
        mime_type (Optional[str]): MIME type of the image (auto-detected if None)
        
    Returns:
        str: Base64-encoded data URL (e.g., "data:image/jpeg;base64,...")
    """
    # Read the image as bytes
    data = image_path.read_bytes()
    
    # Encode to base64
    encoded = base64.b64encode(data).decode("ascii")
    
    # Determine MIME type
    mime = mime_type or _determine_mime_type(image_path)
    
    # Create data URL
    data_url = f"data:{mime};base64,{encoded}"
    
    return data_url


# Proactive send/embed cap (1 MB). This is the size we resize an image DOWN to
# before sending it or embedding it into conversation history. Once an
# oversized image is baked into history (e.g. a vision tool-result), it is
# re-sent on every subsequent turn and can permanently wedge the session with
# a non-retryable 400/413. The auxiliary VL path uses the same cap so base64
# expansion never turns an ordinary screenshot into a multi-megabyte request.
_VISION_SEND_TARGET_BYTES = 1 * 1024 * 1024

# Proactive embed dimension cap (px, longest side). Some multimodal APIs enforce
# an 8000px per-side ceiling independently of their byte cap, so a tall full-page
# screenshot can be well under 5 MB yet far over 8000px (e.g. 1200×12000 at
# 0.06 MB), so the byte-only embed check above lets it slip into immutable
# history un-resized and the session bricks on a non-retryable 400.  We cap at
# 7900 (headroom under 8000) so the proactive resize shrinks tall small-byte
# images before they are embedded.
_EMBED_MAX_DIMENSION = 7900

# Target size when auto-resizing on API failure (5 MB).  After a provider
# rejects an image, we downscale to this target and retry once.
_RESIZE_TARGET_BYTES = 5 * 1024 * 1024

# Fan's public gateway may sit behind a 1 MB reverse-proxy request ceiling.
# Keep a retried data URL comfortably below that limit so JSON/message overhead
# cannot turn a nominally sub-1 MB image into another HTTP 413.
_PROXY_SAFE_RESIZE_TARGET_BYTES = 640 * 1024


def _is_image_size_error(error: Exception) -> bool:
    """Detect if an API error is related to image or payload size."""
    err_str = str(error).lower()
    return any(hint in err_str for hint in (
        "too large", "payload", "413", "content_too_large",
        "request_too_large", "image_url", "invalid_request",
        "exceeds", "size limit",
    ))


def _image_retry_target_bytes(error: Exception, current_size: int) -> int:
    """Choose a strictly smaller retry target for a provider size rejection."""
    err_str = str(error).lower()
    proxy_rejected = any(hint in err_str for hint in (
        "413", "request entity too large", "content too large",
    ))
    ceiling = (
        _PROXY_SAFE_RESIZE_TARGET_BYTES
        if proxy_rejected
        else _RESIZE_TARGET_BYTES
    )
    return min(ceiling, max(64 * 1024, current_size // 2))


def _require_image_payload_within_limit(
    image_data_url: str,
    max_bytes: int,
    *,
    stage: str,
) -> None:
    """Reject an image when compression did not meet its requested budget."""
    actual_bytes = len(image_data_url)
    if actual_bytes <= max_bytes:
        return
    raise ValueError(
        f"{stage}: compressed image payload is "
        f"{actual_bytes / (1024 * 1024):.2f} MB, exceeding the required "
        f"{max_bytes / (1024 * 1024):.2f} MB limit. Install Pillow "
        f"(`pip install Pillow`) or compress the image manually."
    )


def _image_exceeds_dimension(image_path: Path, max_dimension: int) -> bool:
    """True if the image's longest side exceeds ``max_dimension`` px.

    Some multimodal APIs enforce a per-side cap independently of the byte cap,
    so a tall small-byte screenshot can pass every byte check yet trip a
    non-retryable 400.  Returns False (don't force a resize) when Pillow is
    unavailable or the file can't be read as an image — the byte-based checks
    still apply, and we never want a missing soft dependency to break the
    embed path.
    """
    try:
        from PIL import Image as _PILImage
        with _PILImage.open(image_path) as _img:
            return max(_img.size) > max_dimension
    except Exception:
        return False


def _resize_image_for_vision(image_path: Path, mime_type: Optional[str] = None,
                              max_base64_bytes: int = _RESIZE_TARGET_BYTES,
                              max_dimension: Optional[int] = None) -> str:
    """Convert an image to a base64 data URL, auto-resizing if too large.

    Tries Pillow first to progressively downscale oversized images.  If Pillow
    is not installed or resizing still exceeds the limit, falls back to the raw
    bytes and lets the caller handle the size check.

    Args:
        max_dimension: If set, images whose longest side exceeds this pixel
            count are forcibly downscaled even if they're under the byte
            budget. Some multimodal APIs also enforce a per-side cap
            independently of their byte cap.

    Returns the base64 data URL string.
    """
    # Quick file-size estimate: base64 expands by ~4/3, plus data URL header.
    # Skip the expensive full-read + encode if Pillow can resize directly.
    file_size = image_path.stat().st_size
    estimated_b64 = (file_size * 4) // 3 + 100  # ~header overhead
    needs_resize_for_bytes = estimated_b64 > max_base64_bytes

    # Check pixel dimensions even if bytes are fine.
    needs_resize_for_dims = False
    if max_dimension is not None:
        try:
            from PIL import Image as _PILQuick
            with _PILQuick.open(image_path) as _quick_img:
                if max(_quick_img.size) > max_dimension:
                    needs_resize_for_dims = True
        except Exception:
            pass  # can't check; Pillow path below will handle or skip

    if not needs_resize_for_bytes and not needs_resize_for_dims:
        # Small enough — just encode directly.
        data_url = _image_to_base64_data_url(image_path, mime_type=mime_type)
        if len(data_url) <= max_base64_bytes:
            return data_url
    else:
        data_url = None  # defer full encode; try Pillow resize first

    # Attempt auto-resize with Pillow (soft dependency)
    try:
        from PIL import Image
        import io as _io
    except ImportError:
        # Pillow is a lazy-installable soft dependency. Try a best-effort
        # install (respects security.allow_lazy_installs; no-op if disabled or
        # offline), then re-import. If it still isn't importable, fall back to
        # the raw bytes and let the caller raise the size error.
        try:
            from tools.lazy_deps import ensure as _ensure_dep
            _ensure_dep("tool.vision")
            from PIL import Image
            import io as _io
        except Exception:
            logger.info("Pillow not installed — cannot auto-resize oversized image")
            if data_url is None:
                data_url = _image_to_base64_data_url(image_path, mime_type=mime_type)
            return data_url  # caller will raise the size error

    logger.info("Image file is %.1f MB (estimated base64 %.1f MB, limit %.1f MB, max_dimension=%s), auto-resizing...",
                file_size / (1024 * 1024), estimated_b64 / (1024 * 1024),
                max_base64_bytes / (1024 * 1024), max_dimension)

    try:
        img = Image.open(image_path)
    except Exception as exc:
        logger.info("Pillow cannot open image for resizing: %s", exc)
        if data_url is None:
            data_url = _image_to_base64_data_url(image_path, mime_type=mime_type)
        return data_url  # fall through to size-check in caller
    mime = mime_type or _determine_mime_type(image_path)

    # Keep PNG only when transparency is real. Screenshots are frequently
    # stored as opaque RGBA PNGs; converting those to JPEG preserves their
    # dimensions while reducing the request far more than halving the pixels.
    has_transparency = False
    try:
        if img.mode in {"RGBA", "LA"}:
            alpha_min, _alpha_max = img.getchannel("A").getextrema()
            has_transparency = alpha_min < 255
        elif img.mode == "P" and "transparency" in img.info:
            has_transparency = True
    except Exception:
        has_transparency = "transparency" in img.info

    pil_format = "PNG" if mime == "image/png" and has_transparency else "JPEG"
    out_mime = "image/png" if pil_format == "PNG" else "image/jpeg"

    # Convert alpha/palette/grayscale modes to RGB for JPEG output.
    if pil_format == "JPEG" and img.mode != "RGB":
        img = img.convert("RGB")

    # Strategy: halve dimensions until both base64 fits AND pixel dimensions
    # are within limits, up to 4 rounds.
    # For JPEG, also try reducing quality at each size step.
    # For PNG, quality is irrelevant — only dimension reduction helps.
    quality_steps = (85, 70, 50) if pil_format == "JPEG" else (None,)
    prev_dims = (img.width, img.height)
    candidate = None  # will be set on first loop iteration

    def _dims_ok(w: int, h: int) -> bool:
        """True if both pixel dimensions are within the limit."""
        if max_dimension is None:
            return True
        return max(w, h) <= max_dimension

    for attempt in range(5):
        if attempt > 0:
            # Proportional scaling: halve the longer side and scale the
            # shorter side to preserve aspect ratio (min dimension 64).
            scale = 0.5
            new_w = max(int(img.width * scale), 64)
            new_h = max(int(img.height * scale), 64)
            # Re-derive the scale from whichever dimension hit the floor
            # so both axes shrink by the same factor.
            if new_w == 64 and img.width > 0:
                effective_scale = 64 / img.width
                new_h = max(int(img.height * effective_scale), 64)
            elif new_h == 64 and img.height > 0:
                effective_scale = 64 / img.height
                new_w = max(int(img.width * effective_scale), 64)
            # Stop if dimensions can't shrink further
            if (new_w, new_h) == prev_dims:
                break
            img = img.resize((new_w, new_h), Image.LANCZOS)
            prev_dims = (new_w, new_h)
            logger.info("Resized to %dx%d (attempt %d)", new_w, new_h, attempt)

        for q in quality_steps:
            buf = _io.BytesIO()
            save_kwargs = {"format": pil_format}
            if q is not None:
                save_kwargs["quality"] = q
            img.save(buf, **save_kwargs)
            encoded = base64.b64encode(buf.getvalue()).decode("ascii")
            candidate = f"data:{out_mime};base64,{encoded}"
            if len(candidate) <= max_base64_bytes and _dims_ok(img.width, img.height):
                logger.info("Auto-resized image fits: %.1f MB (quality=%s, %dx%d)",
                            len(candidate) / (1024 * 1024), q,
                            img.width, img.height)
                return candidate

    # If we still can't get it small enough, return the best attempt
    # and let the caller decide
    if candidate is not None:
        logger.warning("Auto-resize could not fit image under %.1f MB (best: %.1f MB)",
                       max_base64_bytes / (1024 * 1024), len(candidate) / (1024 * 1024))
        return candidate

    # Shouldn't reach here, but fall back to full encode
    return data_url or _image_to_base64_data_url(image_path, mime_type=mime_type)


# ---------------------------------------------------------------------------
# Native fast path: short-circuit the auxiliary LLM when the active main model
# supports native vision. Instead of asking a separate LLM to describe the
# image and returning text, we load the image, base64-encode it, and return a
# multimodal tool-result envelope. The agent loop unwraps the envelope into an
# OpenAI-style content list on the `tool` role; the active transport translates
# it into its supported multimodal tool-result format. The main model then
# "sees" the pixels directly on its next turn.
# ---------------------------------------------------------------------------


def _supports_media_in_tool_results(provider: str, model: str) -> bool:
    """Whether the given provider+model combination accepts image content
    inside a tool-result message.

    Providers covered today:

      * OpenAI-compatible Chat Completions: tool messages accept array content with
        ``image_url`` parts.
      * OpenAI Responses (``openai-codex``): ``function_call_output.output``
        accepts an array of ``input_text``/``input_image`` items.
      * Gemini 3 (and proxied via aggregators): supports multimodal tool
        results. Older Gemini does NOT.

    For unknown / legacy providers we conservatively return False — the
    caller falls back to the legacy aux-LLM text path.  The check is relaxed
    when the provider's ``ProviderProfile`` declares ``supports_vision=True``.
    """
    if not isinstance(provider, str):
        return False
    p = provider.strip().lower()
    if not p:
        return False

    # Fan's built-in providers use OpenAI-compatible Chat Completions.
    if p in {"alibaba", "alibaba-coding-plan", "custom", "local"}:
        return True

    # Gemini — gate on model name; older Gemini variants did not support
    # multimodal functionResponse. Gemini 3.x does.
    if p in {"google", "gemini", "google-gemini", "google-vertex-gemini"}:
        if not isinstance(model, str):
            return False
        m = model.strip().lower()
        if "gemini-3" in m or "gemini-pro-3" in m or "gemini-flash-3" in m:
            return True
        return False

    # Check the provider's registered profile for the supports_vision flag.
    # This covers vision-capable providers like xiaomi, minimax, etc. that
    # aren't in the hardcoded list above.
    try:
        from providers import get_provider_profile
        profile = get_provider_profile(p)
        if profile is not None and profile.supports_vision:
            return True
    except Exception:
        pass

    # Other vision-capable provider stacks. Conservative default: False.
    # Add explicit entries here as we verify each provider's tool-result
    # multimodal support empirically.
    return False


def _should_use_native_vision_fast_path() -> bool:
    """Whether vision tools should attach the image to the main model directly
    instead of routing through the auxiliary vision LLM.

    True when image routing resolves to ``native`` AND either the provider is
    known to accept images inside tool results, or the user explicitly declared
    the model vision-capable via the ``model.supports_vision`` config override.
    The override is the escape hatch for custom/local providers that aren't in
    the static allowlist. Best-effort: any resolution failure returns False so
    the caller falls back to the legacy aux-LLM path.
    """
    try:
        from agent.auxiliary_client import _read_main_provider, _read_main_model
        from agent.image_routing import decide_image_input_mode, _lookup_supports_vision
        from fan_cli.config import load_config

        provider = _read_main_provider()
        model = _read_main_model()
        cfg = load_config()
        if decide_image_input_mode(provider, model, cfg) != "native":
            return False
        return (
            _supports_media_in_tool_results(provider, model)
            or _lookup_supports_vision(provider, model, cfg) is True
        )
    except Exception as exc:
        logger.debug("Native vision fast-path check failed: %s", exc)
        return False


def _build_native_vision_tool_result(
    image_url: str,
    question: str,
    image_data_url: str,
    image_size_bytes: int,
) -> Dict[str, Any]:
    """Build the multimodal tool-result envelope returned by the fast path.

    Shape:
      {
        "_multimodal": True,
        "content": [
          {"type": "text", "text": "<short note + the user's question>"},
          {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
        ],
        "text_summary": "<plain-text fallback>",
        "meta": {"image_url": ..., "size_bytes": N},
      }

    The text part exists for two reasons: (1) it gives the model an
    instruction to act on now that the pixels are in context, and
    (2) providers that don't support multimodal tool results can fall back
    to ``text_summary``.
    """
    # The tool-result text part is intentionally minimal. The model already
    # has the user's original question in context; this just acknowledges
    # the image is now visible and reminds it what it was asked.
    text_part = (
        "Image loaded into your context — you can see it natively now. "
        "Use your built-in vision to answer the user."
    )
    if isinstance(question, str) and question.strip():
        text_part += f"\n\nQuestion: {question.strip()}"

    summary = (
        f"Image attached natively for the main model "
        f"({image_size_bytes / 1024:.1f} KB). "
        "Answer using built-in vision."
    )

    return {
        "_multimodal": True,
        "content": [
            {"type": "text", "text": text_part},
            {"type": "image_url", "image_url": {"url": image_data_url}},
        ],
        "text_summary": summary,
        "meta": {
            "image_url": image_url[:200],
            "size_bytes": image_size_bytes,
            "native_vision": True,
        },
    }


async def _vision_analyze_native(
    image_url: str,
    question: str,
) -> Any:
    """Fast path for vision-capable main models.

    Loads the image (local file OR remote URL), base64-encodes it, and
    returns a multimodal tool-result envelope. The agent loop unwraps it;
    provider adapters serialize it into the right tool-result-with-image
    shape for each backend.

    Returns:
        A ``_multimodal`` envelope dict on success.
        A JSON error string on failure (matches the existing tool-result
        contract so the agent loop displays errors normally).
    """
    if not isinstance(image_url, str) or not image_url.strip():
        return tool_error("image_url is required", success=False)

    temp_image_path: Optional[Path] = None
    should_cleanup = False
    try:
        from tools.interrupt import is_interrupted
        if is_interrupted():
            return tool_error("Interrupted", success=False)

        # Resolve the image source (mirrors vision_analyze_tool's logic
        # exactly so behaviour is consistent).
        decoded_data_image = _decode_data_image_url(image_url)
        detected_mime_type: Optional[str] = None
        if decoded_data_image is not None:
            temp_image_path, detected_mime_type = decoded_data_image
            should_cleanup = True
        else:
            resolved_url = image_url
            if resolved_url.startswith("file://"):
                resolved_url = resolved_url[len("file://"):]
            local_path = Path(os.path.expanduser(resolved_url))
            if local_path.is_file():
                # Do not turn a secret-bearing local file into a multimodal tool
                # result. Keep vision on the same credential-read boundary as
                # ordinary file/context tools.
                from agent.file_safety import raise_if_read_blocked

                raise_if_read_blocked(str(local_path))
                temp_image_path = local_path
                should_cleanup = False
            elif await _validate_image_url_async(image_url):
                blocked = check_website_access(image_url)
                if blocked:
                    return tool_error(blocked["message"], success=False)
                temp_dir = get_fan_dir("cache/vision", "temp_vision_images")
                temp_image_path = temp_dir / f"temp_image_{uuid.uuid4()}.jpg"
                await _download_image(image_url, temp_image_path)
                should_cleanup = True
            else:
                return tool_error(
                    "Invalid image source. Provide an HTTP/HTTPS URL, a valid "
                    "local file path, or a supported base64 image data URL.",
                    success=False,
                )

        image_size_bytes = temp_image_path.stat().st_size
        detected_mime_type = (
            detected_mime_type or _detect_image_mime_type(temp_image_path)
        )
        if not detected_mime_type:
            return tool_error(
                "Only real image files are supported for vision analysis.",
                success=False,
            )

        image_data_url = _image_to_base64_data_url(
            temp_image_path, mime_type=detected_mime_type,
        )

        # Proactive embed cap: this image gets baked into conversation
        # history and re-sent on every subsequent turn. Some multimodal APIs
        # reject large payloads or dimensions with a non-retryable 400, and
        # because history is immutable, an oversized embed can permanently
        # wedge the session. Resize down to the send target (1 MB / 7900px)
        # whenever the payload exceeds either limit.
        _over_bytes = len(image_data_url) > _VISION_SEND_TARGET_BYTES
        _over_dims = _image_exceeds_dimension(temp_image_path, _EMBED_MAX_DIMENSION)
        if _over_bytes or _over_dims:
            image_data_url = _resize_image_for_vision(
                temp_image_path, mime_type=detected_mime_type,
                max_base64_bytes=_VISION_SEND_TARGET_BYTES,
                max_dimension=_EMBED_MAX_DIMENSION,
            )

        # The send target is a hard boundary, not merely a best-effort hint.
        # Returning a larger native payload would bake it into immutable
        # conversation history and re-send it on every subsequent turn.
        try:
            _require_image_payload_within_limit(
                image_data_url,
                _VISION_SEND_TARGET_BYTES,
                stage="Native vision image compression failed",
            )
        except ValueError as exc:
            return tool_error(str(exc), success=False)

        return _build_native_vision_tool_result(
            image_url=image_url,
            question=question,
            image_data_url=image_data_url,
            image_size_bytes=image_size_bytes,
        )

    except Exception as exc:
        logger.warning("Native vision fast path failed: %s", exc)
        return tool_error(f"Native vision failed: {exc}", success=False)
    finally:
        # Only delete temp files we created — never user-provided paths.
        if should_cleanup and temp_image_path is not None:
            try:
                if temp_image_path.exists():
                    temp_image_path.unlink()
            except Exception:
                pass


def _vision_interrupt_requested(
    interrupt_check: Optional[Callable[[], bool]] = None,
) -> bool:
    """Return whether the active vision request should stop."""
    if interrupt_check is not None:
        try:
            if interrupt_check():
                return True
        except Exception:
            logger.debug("Vision interrupt callback failed", exc_info=True)
    try:
        from tools.interrupt import is_interrupted

        return bool(is_interrupted())
    except Exception:
        return False


async def _call_vision_llm_interruptibly(
    call_kwargs: Dict[str, Any],
    *,
    interrupt_check: Optional[Callable[[], bool]] = None,
) -> Any:
    """Await a vision LLM request while polling the agent interrupt signal.

    The OpenAI-compatible async request otherwise blocks until its HTTP timeout.
    Cancelling the outer ``async_call_llm`` task also runs its client-cleanup
    boundary, so Stop does not leave a poisoned or orphaned transport behind.
    """
    if _vision_interrupt_requested(interrupt_check):
        raise InterruptedError("Vision analysis interrupted by user")
    request_task = asyncio.create_task(async_call_llm(**call_kwargs))
    try:
        while True:
            done, _pending = await asyncio.wait((request_task,), timeout=0.1)
            if request_task in done:
                return await request_task
            if _vision_interrupt_requested(interrupt_check):
                request_task.cancel()
                try:
                    await request_task
                except asyncio.CancelledError:
                    pass
                raise InterruptedError("Vision analysis interrupted by user")
    finally:
        if not request_task.done():
            request_task.cancel()
            try:
                await request_task
            except (asyncio.CancelledError, Exception):
                pass


async def vision_analyze_tool(
    image_url: str,
    user_prompt: str,
    model: str = None,
    interrupt_check: Optional[Callable[[], bool]] = None,
) -> str:
    """
    Analyze an image from a URL, local file path, or image data URL using vision AI.
    
    This tool accepts an HTTP/HTTPS URL, a local file path, or a supported
    base64 image data URL. Remote URLs are downloaded first. Every source is
    normalized and processed through the centralized auxiliary vision router.
    
    The user_prompt parameter is the task-specific question or instruction for
    the visual model. Callers may add concise grounding guidance around it.
    
    Args:
        image_url (str): The image source to analyze. Accepts http:// or
                         https:// URLs, absolute/relative file paths, or a
                         supported base64 ``data:image/...`` URL.
        user_prompt (str): The prompt for the vision model.
        model (str): Optional explicit vision model override.
        interrupt_check: Optional request-local cancellation callback. Normal
                         agent tool calls also observe ``tools.interrupt``.
    
    Returns:
        str: JSON string containing the analysis results with the following structure:
             {
                 "success": bool,
                 "analysis": str (defaults to error message if None)
             }
    
    Raises:
        Exception: If download fails, analysis fails, or API key is not set
        
    Note:
        - For URLs, temporary images are stored under $FAN_HOME/cache/vision/ and cleaned up
        - For local file paths, the file is used directly and NOT deleted
        - Decoded data URL temporary files are always cleaned up
        - Supports common image formats (JPEG, PNG, GIF, WebP, etc.)
    """
    if not isinstance(user_prompt, str):
        user_prompt = str(user_prompt) if user_prompt is not None else ""
    debug_call_data = {
        "parameters": {
            "image_url": image_url,
            "user_prompt": user_prompt[:200] + "..." if len(user_prompt) > 200 else user_prompt,
            "model": model
        },
        "error": None,
        "success": False,
        "analysis_length": 0,
        "model_used": model,
        "image_size_bytes": 0
    }
    
    temp_image_path = None
    # Track whether we should clean up the file after processing.
    # Local files (e.g. from the image cache) should NOT be deleted.
    should_cleanup = True
    detected_mime_type = None
    
    try:
        from tools.interrupt import is_interrupted
        if is_interrupted():
            return tool_error("Interrupted", success=False)

        logger.info("Analyzing image: %s", image_url[:60])
        logger.info("User prompt: %s", user_prompt[:100])
        
        # Determine if this is a data URL, local file path, or remote URL.
        decoded_data_image = _decode_data_image_url(image_url)
        if decoded_data_image is not None:
            temp_image_path, detected_mime_type = decoded_data_image
            should_cleanup = True
        else:
            # Strip file:// scheme so file URIs resolve as local paths.
            resolved_url = image_url
            if resolved_url.startswith("file://"):
                resolved_url = resolved_url[len("file://"):]
            local_path = Path(os.path.expanduser(resolved_url))
            if local_path.is_file():
                from agent.file_safety import raise_if_read_blocked

                raise_if_read_blocked(str(local_path))
                # Local file path (e.g. from platform image cache) -- skip download
                logger.info("Using local image file: %s", image_url)
                temp_image_path = local_path
                should_cleanup = False  # Don't delete cached/local files
            elif await _validate_image_url_async(image_url):
                # Remote URL -- download to a temporary location
                blocked = check_website_access(image_url)
                if blocked:
                    raise PermissionError(blocked["message"])
                logger.info("Downloading image from URL...")
                temp_dir = get_fan_dir("cache/vision", "temp_vision_images")
                temp_image_path = temp_dir / f"temp_image_{uuid.uuid4()}.jpg"
                await _download_image(image_url, temp_image_path)
                should_cleanup = True
            else:
                raise ValueError(
                    "Invalid image source. Provide an HTTP/HTTPS URL, a valid "
                    "local file path, or a supported base64 image data URL."
                )
        
        # Get image file size for logging
        image_size_bytes = temp_image_path.stat().st_size
        image_size_kb = image_size_bytes / 1024
        logger.info("Image ready (%.1f KB)", image_size_kb)

        detected_mime_type = (
            detected_mime_type or _detect_image_mime_type(temp_image_path)
        )
        if not detected_mime_type:
            raise ValueError("Only real image files are supported for vision analysis.")
        
        # Compress before the first request. Base64 expands binary images by
        # roughly one third, so even a ~1 MB PNG can exceed a default reverse-
        # proxy limit once wrapped in JSON. Keep the encoded data URL at 1 MB.
        logger.info("Preparing compressed image payload...")
        image_data_url = _resize_image_for_vision(
            temp_image_path,
            mime_type=detected_mime_type,
            max_base64_bytes=_VISION_SEND_TARGET_BYTES,
            max_dimension=_EMBED_MAX_DIMENSION,
        )
        data_size_kb = len(image_data_url) / 1024
        logger.info("Image converted to base64 (%.1f KB)", data_size_kb)

        # Never send a best-effort result that still misses the requested
        # budget. In particular, Pillow may be unavailable or unable to decode
        # a supported container and the resize helper then returns raw bytes.
        _require_image_payload_within_limit(
            image_data_url,
            _VISION_SEND_TARGET_BYTES,
            stage="Vision image compression failed",
        )

        debug_call_data["image_size_bytes"] = image_size_bytes
        
        # Use the prompt as provided (model_tools.py now handles full description formatting)
        comprehensive_prompt = user_prompt
        
        # Prepare the message with base64-encoded image
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": comprehensive_prompt
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_data_url
                        }
                    }
                ]
            }
        ]
        
        logger.info("Processing image with vision model...")
        
        # Call the vision API via centralized router.
        # Read timeout from config.yaml (auxiliary.vision.timeout), default 120s.
        # Local vision models (llama.cpp, ollama) can take well over 30s.
        vision_timeout = 120.0
        vision_temperature = 0.1
        try:
            from fan_cli.config import cfg_get, load_config
            _cfg = load_config()
            _vision_cfg = cfg_get(_cfg, "auxiliary", "vision", default={})
            _vt = _vision_cfg.get("timeout")
            if _vt is not None:
                vision_timeout = float(_vt)
            _vtemp = _vision_cfg.get("temperature")
            if _vtemp is not None:
                vision_temperature = float(_vtemp)
        except Exception:
            pass
        call_kwargs = {
            "task": "vision",
            "messages": messages,
            "temperature": vision_temperature,
            "max_tokens": 2000,
            "timeout": vision_timeout,
        }
        if model:
            call_kwargs["model"] = model
        # The first request is already compressed; on a provider/proxy size
        # rejection, downscale further and retry once.
        try:
            response = await _call_vision_llm_interruptibly(
                call_kwargs,
                interrupt_check=interrupt_check,
            )
        except Exception as _api_err:
            if _is_image_size_error(_api_err):
                retry_target = _image_retry_target_bytes(
                    _api_err, len(image_data_url)
                )
                logger.info(
                    "API rejected image (%.1f MB, likely too large); "
                    "auto-resizing to at most %.0f KB and retrying...",
                    len(image_data_url) / (1024 * 1024),
                    retry_target / 1024,
                )
                resized_image_data_url = _resize_image_for_vision(
                    temp_image_path,
                    mime_type=detected_mime_type,
                    max_base64_bytes=retry_target,
                )
                _require_image_payload_within_limit(
                    resized_image_data_url,
                    retry_target,
                    stage="Vision retry image compression failed",
                )
                if len(resized_image_data_url) >= len(image_data_url):
                    raise ValueError(
                        "Vision retry image compression failed: compressed "
                        "payload was not smaller than the rejected payload."
                    )
                image_data_url = resized_image_data_url
                messages[0]["content"][1]["image_url"]["url"] = image_data_url
                response = await _call_vision_llm_interruptibly(
                    call_kwargs,
                    interrupt_check=interrupt_check,
                )
            else:
                raise
        
        # Extract the analysis — fall back to reasoning if content is empty
        analysis = extract_content_or_reasoning(response)

        # Retry once on empty content (reasoning-only response)
        if not analysis:
            logger.warning("Vision LLM returned empty content, retrying once")
            response = await _call_vision_llm_interruptibly(
                call_kwargs,
                interrupt_check=interrupt_check,
            )
            analysis = extract_content_or_reasoning(response)

        analysis_length = len(analysis)
        
        logger.info("Image analysis completed (%s characters)", analysis_length)
        
        # Prepare successful response
        result = {
            "success": True,
            "analysis": analysis or "There was a problem with the request and the image could not be analyzed."
        }
        
        debug_call_data["success"] = True
        debug_call_data["analysis_length"] = analysis_length
        
        # Log debug information
        _debug.log_call("vision_analyze_tool", debug_call_data)
        _debug.save()
        
        return json.dumps(result, indent=2, ensure_ascii=False)
        
    except InterruptedError as e:
        logger.info("Vision analysis interrupted")
        result = {
            "success": False,
            "error": str(e),
            "analysis": "Image analysis was interrupted by the user.",
        }
        debug_call_data["error"] = str(e)
        _debug.log_call("vision_analyze_tool", debug_call_data)
        _debug.save()
        return json.dumps(result, indent=2, ensure_ascii=False)

    except Exception as e:
        error_msg = f"Error analyzing image: {str(e)}"
        logger.error("%s", error_msg, exc_info=True)
        
        # Detect vision capability errors — give the model a clear message
        # so it can inform the user instead of a cryptic API error.
        err_str = str(e).lower()
        if any(hint in err_str for hint in (
            "402", "insufficient", "payment required", "credits", "billing",
        )):
            analysis = (
                "Insufficient credits or payment required. Please top up your "
                f"API provider account and try again. Error: {e}"
            )
        elif any(hint in err_str for hint in (
            "does not support", "not support image",
            "content_policy", "multimodal",
            "unrecognized request argument", "image input",
        )):
            analysis = (
                f"{model} does not support vision or our request was not "
                f"accepted by the server. Error: {e}"
            )
        elif "invalid_request" in err_str or "image_url" in err_str:
            analysis = (
                "The vision API rejected the image. This can happen when the "
                "image is in an unsupported format, corrupted, or still too "
                "large after auto-resize. Try a smaller JPEG/PNG and retry. "
                f"Error: {e}"
            )
        else:
            analysis = (
                "There was a problem with the request and the image could not "
                f"be analyzed. Error: {e}"
            )
        
        # Prepare error response
        result = {
            "success": False,
            "error": error_msg,
            "analysis": analysis,
        }
        
        debug_call_data["error"] = error_msg
        _debug.log_call("vision_analyze_tool", debug_call_data)
        _debug.save()
        
        return json.dumps(result, indent=2, ensure_ascii=False)
    
    finally:
        # Clean up temporary image file (but NOT local/cached files)
        if should_cleanup and temp_image_path and temp_image_path.exists():
            try:
                temp_image_path.unlink()
                logger.debug("Cleaned up temporary image file")
            except Exception as cleanup_error:
                logger.warning(
                    "Could not delete temporary file: %s", cleanup_error, exc_info=True
                )


def check_vision_requirements() -> bool:
    """Check if the configured runtime vision path can resolve a client.

    Mirrors the fallback chain that ``call_llm(task="vision")`` actually uses
    at runtime: first the explicit ``auxiliary.vision.provider`` (if any),
    and if that fails, the configured main/custom provider chain.
    Without the auto-fallback step the tool would disappear from the model's
    tool list whenever the explicit provider name was unresolvable, even
    when the auto chain would have served the request (issue #31179).
    """
    try:
        from agent.auxiliary_client import resolve_vision_provider_client
    except ImportError:
        return False
    try:
        _provider, client, _model = resolve_vision_provider_client()
        if client is not None:
            return True
        # Same fallback to "auto" that call_llm performs when the configured
        # provider can't be resolved.
        _provider, client, _model = resolve_vision_provider_client(provider="auto")
        return client is not None
    except Exception:
        return False



if __name__ == "__main__":
    """
    Simple test/demo when run directly
    """
    print("👁️ Vision Tools Module")
    print("=" * 40)
    
    # Check if vision model is available
    api_available = check_vision_requirements()
    
    if not api_available:
        print("❌ No auxiliary vision model available")
        print("Configure a supported multimodal model or custom OpenAI-compatible endpoint.")
        sys.exit(1)
    else:
        print("✅ Vision model available")
    
    print("🛠️ Vision tools ready for use!")
    
    # Show debug mode status
    if _debug.active:
        print(f"🐛 Debug mode ENABLED - Session ID: {_debug.session_id}")
        print(f"   Debug logs will be saved to: ./logs/vision_tools_debug_{_debug.session_id}.json")
    else:
        print("🐛 Debug mode disabled (set VISION_TOOLS_DEBUG=true to enable)")
    
    print("\nBasic usage:")
    print("  from vision_tools import vision_analyze_tool")
    print("  import asyncio")
    print("")
    print("  async def main():")
    print("      result = await vision_analyze_tool(")
    print("          image_url='https://example.com/image.jpg',")
    print("          user_prompt='What do you see in this image?'")
    print("      )")
    print("      print(result)")
    print("  asyncio.run(main())")
    
    print("\nExample prompts:")
    print("  - 'What architectural style is this building?'")
    print("  - 'Describe the emotions and mood in this image'")
    print("  - 'What text can you read in this image?'")
    print("  - 'Identify any safety hazards visible'")
    print("  - 'What products or brands are shown?'")
    
    print("\nDebug mode:")
    print("  # Enable debug logging")
    print("  export VISION_TOOLS_DEBUG=true")
    print("  # Debug logs capture all vision analysis calls and results")
    print("  # Logs saved to: ./logs/vision_tools_debug_UUID.json")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
from tools.registry import registry, tool_error

VISION_ANALYZE_SCHEMA = {
    "name": "vision_analyze",
    "description": (
        "Load an image into the conversation so you can see it. Accepts a "
        "URL, local file path, or data URL. When your active model has "
        "native vision, the image is attached to your context directly "
        "and you read the pixels yourself on the next turn — call this "
        "any time the user references an image (filepath in their message, "
        "URL in tool output, screenshot from the browser, etc.). For "
        "non-vision models, falls back to an auxiliary vision model that "
        "returns a text description."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "image_url": {
                "type": "string",
                "description": "Image URL (http/https), local file path, or data: URL to load."
            },
            "question": {
                "type": "string",
                "description": "Your specific question or request about the image. Optional context the model uses on the next turn after seeing the image."
            }
        },
        "required": ["image_url", "question"]
    }
}


def _handle_vision_analyze(args: Dict[str, Any], **kw: Any) -> Awaitable[str]:
    image_url = args.get("image_url", "")
    question = args.get("question", "")

    # Fast path: when native image routing is in effect for the active main
    # model (provider accepts images in tool results, or the user set the
    # model.supports_vision override), short-circuit the auxiliary LLM and
    # return the image bytes as a multimodal tool-result envelope. The main
    # model sees the pixels directly on its next turn — no aux call, no
    # information loss, no extra latency.
    if _should_use_native_vision_fast_path():
        logger.info("vision_analyze: native fast path")
        return _vision_analyze_native(image_url, question)

    # Text-main path: ask the auxiliary VL model for the answer the main model
    # actually needs. An unconditional exhaustive description made simple OCR
    # questions consume the full output budget and frequently hit the request
    # timeout before the main model could answer.
    full_prompt = (
        "Inspect the image and answer the following question directly and "
        "accurately. Include visible text or layout details only when they help "
        "answer it. Be concise unless the question explicitly requests a full "
        f"description.\n\nQuestion:\n{question or 'What is visible in this image?'}"
    )
    # Prefer the persisted auxiliary.vision.model. The environment variable is
    # retained as a legacy fallback for installs that have not migrated config.
    model = None
    try:
        from fan_cli.config import cfg_get, load_config

        configured_model = cfg_get(load_config(), "auxiliary", "vision", "model")
        if configured_model:
            model = str(configured_model).strip() or None
    except Exception:
        pass
    if not model:
        model = os.getenv("AUXILIARY_VISION_MODEL", "").strip() or None
    return vision_analyze_tool(image_url, full_prompt, model)


registry.register(
    name="vision_analyze",
    toolset="vision",
    schema=VISION_ANALYZE_SCHEMA,
    handler=_handle_vision_analyze,
    check_fn=check_vision_requirements,
    is_async=True,
    emoji="👁️",
)
