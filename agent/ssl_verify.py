"""TLS verification resolution for httpx/OpenAI provider clients."""

from __future__ import annotations

import logging
import os
import ssl
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _coerce_insecure(ssl_verify: Any) -> bool:
    if ssl_verify is False:
        return True
    return isinstance(ssl_verify, str) and ssl_verify.strip().lower() in {
        "false", "0", "no", "off",
    }


def resolve_httpx_verify(
    *,
    ca_bundle: Optional[str] = None,
    ssl_verify: Any = None,
    base_url: str = "",
) -> bool | ssl.SSLContext:
    """Resolve httpx's ``verify`` value for provider HTTP clients.

    Per-provider TLS settings take precedence, followed by Fan's documented
    process-wide CA-bundle environment variables.  Disabling verification is
    supported only as an explicit local-development setting and is surfaced in
    the logs.
    """
    if _coerce_insecure(ssl_verify):
        logger.warning(
            "TLS certificate verification DISABLED (ssl_verify: false) for %s — "
            "this is intended for local development only and is unsafe on any "
            "network you do not fully control.",
            base_url or "a custom provider endpoint",
        )
        return False

    effective_ca = (
        (ca_bundle or "").strip()
        or os.getenv("FAN_CA_BUNDLE", "").strip()
        or os.getenv("SSL_CERT_FILE", "").strip()
        or os.getenv("REQUESTS_CA_BUNDLE", "").strip()
        or os.getenv("CURL_CA_BUNDLE", "").strip()
    )
    if effective_ca:
        ca_path = str(Path(effective_ca).expanduser())
        if os.path.isfile(ca_path):
            return ssl.create_default_context(cafile=ca_path)
        logger.warning(
            "CA bundle path does not exist: %s — falling back to default certificates",
            effective_ca,
        )
    return True
