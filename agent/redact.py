"""Regex-based secret redaction for logs and tool output.

Applies pattern matching to mask API keys, tokens, and credentials
before they reach log files or verbose output.

Short tokens (< 18 chars) are fully masked. Longer tokens preserve
the first 6 and last 4 characters for debuggability.
"""

import logging
import os
import re
import shlex

logger = logging.getLogger(__name__)

# Sensitive query-string parameter names (case-insensitive exact match).
# Ported from nearai/ironclaw#2529 — catches tokens whose values don't match
# any known vendor prefix regex (e.g. opaque tokens, short OAuth codes).
_SENSITIVE_QUERY_PARAMS = frozenset({
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "api_key",
    "apikey",
    "client_secret",
    "password",
    "auth",
    "jwt",
    "session",
    "secret",
    "key",
    "code",           # OAuth authorization codes
    "signature",      # pre-signed URL signatures
    "x-amz-signature",
})

# Sensitive form-urlencoded / JSON body key names (case-insensitive exact match).
# Exact match, NOT substring — "token_count" and "session_id" must NOT match.
# Ported from nearai/ironclaw#2529.
_SENSITIVE_BODY_KEYS = frozenset({
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "api_key",
    "apikey",
    "client_secret",
    "password",
    "auth",
    "jwt",
    "secret",
    "private_key",
    "authorization",
    "key",
})

# Snapshot at import time so runtime env mutations (e.g. LLM-generated
# `export FAN_REDACT_SECRETS=false`) cannot disable redaction
# mid-session.  ON by default — secure default per issue #17691. Users who
# need raw credential values in tool output (e.g. working on the redactor
# itself) can opt out via `security.redact_secrets: false` in config.yaml
# (bridged to this env var by local entry points) or
# `FAN_REDACT_SECRETS=false` in ~/.fan/.env. An opt-out warning is logged
# at startup so operators see the downgrade.
_REDACT_ENABLED = os.getenv("FAN_REDACT_SECRETS", "true").lower() in {"1", "true", "yes", "on"}

# Known API key prefixes -- match the prefix + contiguous token chars
_PREFIX_PATTERNS = [
    r"sk-[A-Za-z0-9_-]{10,}",           # OpenAI-compatible API keys
    r"ghp_[A-Za-z0-9]{10,}",            # GitHub PAT (classic)
    r"github_pat_[A-Za-z0-9_]{10,}",    # GitHub PAT (fine-grained)
    r"gho_[A-Za-z0-9]{10,}",            # GitHub OAuth access token
    r"ghu_[A-Za-z0-9]{10,}",            # GitHub user-to-server token
    r"ghs_[A-Za-z0-9]{10,}",            # GitHub server-to-server token
    r"ghr_[A-Za-z0-9]{10,}",            # GitHub refresh token
    r"AIza[A-Za-z0-9_-]{30,}",          # Google API keys
    r"pplx-[A-Za-z0-9]{10,}",           # Perplexity
    r"fal_[A-Za-z0-9_-]{10,}",          # Fal.ai
    r"fc-[A-Za-z0-9]{10,}",             # Firecrawl
    r"bb_live_[A-Za-z0-9_-]{10,}",      # BrowserBase
    r"gAAAA[A-Za-z0-9_=-]{20,}",        # Codex encrypted tokens
    r"AKIA[A-Z0-9]{16}",                # AWS Access Key ID
    r"sk_live_[A-Za-z0-9]{10,}",        # Stripe secret key (live)
    r"sk_test_[A-Za-z0-9]{10,}",        # Stripe secret key (test)
    r"rk_live_[A-Za-z0-9]{10,}",        # Stripe restricted key
    r"SG\.[A-Za-z0-9_-]{10,}",          # SendGrid API key
    r"hf_[A-Za-z0-9]{10,}",             # HuggingFace token
    r"r8_[A-Za-z0-9]{10,}",             # Replicate API token
    r"npm_[A-Za-z0-9]{10,}",            # npm access token
    r"pypi-[A-Za-z0-9_-]{10,}",         # PyPI API token
    r"dop_v1_[A-Za-z0-9]{10,}",         # DigitalOcean PAT
    r"doo_v1_[A-Za-z0-9]{10,}",         # DigitalOcean OAuth
    r"am_[A-Za-z0-9_-]{10,}",           # AgentMail API key
    r"sk_[A-Za-z0-9_]{10,}",            # ElevenLabs TTS key (sk_ underscore, not sk- dash)
    r"tvly-[A-Za-z0-9]{10,}",           # Tavily search API key
    r"exa_[A-Za-z0-9]{10,}",            # Exa search API key
    r"gsk_[A-Za-z0-9]{10,}",            # Groq Cloud API key
    r"retaindb_[A-Za-z0-9]{10,}",       # RetainDB API key
    r"hsk-[A-Za-z0-9]{10,}",            # Hindsight API key
    r"mem0_[A-Za-z0-9]{10,}",           # Mem0 Platform API key
    r"brv_[A-Za-z0-9]{10,}",            # ByteRover API key
    r"xai-[A-Za-z0-9]{30,}",            # xAI (Grok) API key
    r"fw_[A-Za-z0-9]{30,}",             # Fireworks AI API key
]

# ENV assignment patterns: KEY=value where KEY contains a secret-like name
_SECRET_ENV_NAMES = r"(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)"
_ENV_ASSIGN_RE = re.compile(
    rf"([A-Z0-9_]{{0,50}}{_SECRET_ENV_NAMES}[A-Z0-9_]{{0,50}})\s*=\s*(['\"]?)(\S+)\2",
)

# Lowercase and dotted application config keys are common in Spring, YAML,
# .env and properties output. Keep these narrower than the uppercase ENV rule
# so prose and ordinary code are not mangled.
_SECRET_CFG_NAMES = r"(?:api[ _.\-]?key|token|secret|passwd|password|credential|auth)"
_CFG_VALUE = r"(['\"]?)([^\s&]+?)\2(?=[\s&]|$)"
_ENV_LOOKUP_VALUE_RE = re.compile(
    r"^(?:os\.(?:getenv|environ)|process\.env|\$ENV\{)"
)
_CFG_DOTTED_RE = re.compile(
    rf"((?:[A-Za-z0-9_\-]+\.)+[A-Za-z0-9_.\-]*{_SECRET_CFG_NAMES}[A-Za-z0-9_.\-]*"
    rf"|[A-Za-z0-9_.\-]*{_SECRET_CFG_NAMES}[A-Za-z0-9_.\-]*\.[A-Za-z0-9_.\-]+)"
    rf"={_CFG_VALUE}",
    re.IGNORECASE,
)
_CFG_ANCHORED_RE = re.compile(
    rf"(^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_\-]*{_SECRET_CFG_NAMES}[A-Za-z0-9_\-]*)={_CFG_VALUE}",
    re.IGNORECASE | re.MULTILINE,
)
_YAML_CFG_NAMES = r"(?:api[ _.\-]?key|token|secret|passwd|password|credential)"
_YAML_ASSIGN_RE = re.compile(
    rf"(^[ \t]*[A-Za-z0-9_.\-]*{_YAML_CFG_NAMES}[A-Za-z0-9_.\-]*)(:[ \t]*)(?!['\"])([^\s&]+)",
    re.IGNORECASE | re.MULTILINE,
)

# JSON field patterns: "apiKey": "value", "token": "value", etc.
_JSON_KEY_NAMES = r"(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token|auth_token|bearer|secret_value|raw_secret|secret_input|key_material)"
_JSON_FIELD_RE = re.compile(
    rf'("{_JSON_KEY_NAMES}")\s*:\s*"([^"]+)"',
    re.IGNORECASE,
)

# Authorization headers — preserve the header name and optional scheme, while
# excluding closing quotes from the credential match so redaction cannot turn a
# valid quoted command into an unterminated string.
_AUTH_HEADER_RE = re.compile(
    r"((?:Proxy-)?Authorization:\s*)([A-Za-z][\w.+-]*\s+)?([^\s\"']+)",
    re.IGNORECASE,
)

_SECRET_HEADER_NAMES = (
    r"(?:x-api-key|x-goog-api-key|api-key|apikey|x-api-token|x-auth-token|x-access-token)"
)
_SECRET_HEADER_RE = re.compile(
    rf"({_SECRET_HEADER_NAMES}\s*:\s*)([^\s\"']+)",
    re.IGNORECASE,
)

# Private key blocks: -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----"
)

# Database connection strings: protocol://user:PASSWORD@host.  User/password
# groups cannot cross whitespace so a source-code DSN template never consumes
# later lines up to an unrelated decorator's ``@``.
_DB_CONNSTR_RE = re.compile(
    r"((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:\s]+:)([^@\s]+)(@)",
    re.IGNORECASE,
)

# A bare token in URL userinfo (``scheme://TOKEN@host``) is a credential, not
# a normal callback/query token.  Keep the colon form out of this rule: it has
# historically been allowed for legitimate URL round-trips, while this
# colon-less form is the common ``git remote ... https://TOKEN@host`` leak.
# The 8-character floor avoids masking ordinary short usernames.
_URL_BARE_TOKEN_RE = re.compile(
    r"((?:https?|wss?|git|ssh|ftp|ftps|sftp)://)"
    r"([^\s:@/]{8,})"
    r"(@[^\s]+)",
    re.IGNORECASE,
)

# JWT tokens: header.payload[.signature] — always start with "eyJ" (base64 for "{")
# Matches 1-part (header only), 2-part (header.payload), and full 3-part JWTs.
_JWT_RE = re.compile(
    r"eyJ[A-Za-z0-9_-]{10,}"           # Header (always starts with eyJ)
    r"(?:\.[A-Za-z0-9_=-]{4,}){0,2}"   # Optional payload and/or signature
)

# URLs containing query strings — matches `scheme://...?...[# or end]`.
# Used to scan text for URLs whose query params may contain secrets.
# Ported from nearai/ironclaw#2529.
_URL_WITH_QUERY_RE = re.compile(
    r"(https?|wss?|ftp)://"          # scheme
    r"([^\s/?#]+)"                    # authority (may include userinfo)
    r"([^\s?#]*)"                     # path
    r"\?([^\s#]+)"                    # query (required)
    r"(#\S*)?",                       # optional fragment
)

# URLs containing userinfo — `scheme://user:password@host` for ANY scheme
# (not just DB protocols already covered by _DB_CONNSTR_RE above).
# Catches things like `https://user:token@api.example.com/v1/foo`.
_URL_USERINFO_RE = re.compile(
    r"(https?|wss?|ftp)://([^/\s:@]+):([^/\s@]+)@",
)

# HTTP access logs often use a relative request target rather than a full URL:
# `"POST /webhook?password=... HTTP/1.1"`. The full-URL redactor above only
# sees strings containing `://`, so handle request-target query strings too.
_HTTP_REQUEST_TARGET_QUERY_RE = re.compile(
    r"\b((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+[^ \t\r\n\"']*?)"
    r"\?([^ \t\r\n\"']+)",
    re.IGNORECASE,
)

# Form-urlencoded body detection: conservative — only applies when the entire
# text looks like a query string (k=v&k=v pattern with no newlines).
_FORM_BODY_RE = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_.-]*=[^&\s]*(?:&[A-Za-z_][A-Za-z0-9_.-]*=[^&\s]*)+$"
)

# Compile known prefix patterns into one alternation
_PREFIX_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(" + "|".join(_PREFIX_PATTERNS) + r")(?![A-Za-z0-9_-])"
)


def mask_secret(
    value: str,
    *,
    head: int = 4,
    tail: int = 4,
    floor: int = 12,
    placeholder: str = "***",
    empty: str = "",
) -> str:
    """Mask a secret for display, preserving ``head`` and ``tail`` characters.

    Canonical helper for display-time redaction across Fan — used by
    ``fan config``, ``fan status``, ``fan dump``, and anywhere
    a secret needs to be shown truncated for debuggability while still
    keeping the bulk hidden.

    Args:
        value:       The secret to mask. ``None``/empty returns ``empty``.
        head:        Leading characters to preserve. Default 4.
        tail:        Trailing characters to preserve. Default 4.
        floor:       Values shorter than ``head + tail + floor_margin`` are
                     fully masked (returns ``placeholder``). Default 12 —
                     matches the existing config/status/dump convention.
        placeholder: Value returned for too-short inputs. Default ``"***"``.
        empty:       Value returned when ``value`` is falsy (None, ""). The
                     caller can override this to e.g. ``color("(not set)",
                     Colors.DIM)`` for user-facing display.

    Examples:
        >>> mask_secret("sk-proj-abcdef1234567890")
        'sk-p...7890'
        >>> mask_secret("short")                         # fully masked
        '***'
        >>> mask_secret("")                              # empty default
        ''
        >>> mask_secret("", empty="(not set)")           # empty override
        '(not set)'
        >>> mask_secret("long-token", head=6, tail=4, floor=18)
        '***'
    """
    if not value:
        return empty
    if len(value) < floor:
        return placeholder
    return f"{value[:head]}...{value[-tail:]}"


def _mask_token(token: str) -> str:
    """Mask a log token — conservative 18-char floor, preserves 6 prefix / 4 suffix."""
    # Empty input: historically this returned "***" rather than "". Preserve.
    if not token:
        return "***"
    return mask_secret(token, head=6, tail=4, floor=18)


def _mask_token_nonreusable(token: str) -> str:
    """Return a file-read sentinel that cannot be mistaken for a credential.

    Log masks deliberately retain a little head/tail context for diagnostics.
    File content is different: the model may read a configuration file and
    write it back.  A plausible-looking truncated key can then overwrite the
    original secret.  Preserve only a recognisable provider prefix and emit a
    syntactically invalid marker instead.
    """
    if not token:
        return "«redacted-secret»"
    label = next((prefix for prefix in _PREFIX_SUBSTRINGS if token.startswith(prefix)), "")
    return f"«redacted:{label}…»" if label else "«redacted-secret»"


def _redact_query_string(query: str) -> str:
    """Redact sensitive parameter values in a URL query string.

    Handles `k=v&k=v` format. Sensitive keys (case-insensitive) have values
    replaced with `***`. Non-sensitive keys pass through unchanged.
    Empty or malformed pairs are preserved as-is.
    """
    if not query:
        return query
    parts = []
    for pair in query.split("&"):
        if "=" not in pair:
            parts.append(pair)
            continue
        key, _, value = pair.partition("=")
        if key.lower() in _SENSITIVE_QUERY_PARAMS:
            parts.append(f"{key}=***")
        else:
            parts.append(pair)
    return "&".join(parts)


def _redact_url_query_params(text: str) -> str:
    """Scan text for URLs with query strings and redact sensitive params.

    Catches opaque tokens that don't match vendor prefix regexes, e.g.
    `https://example.com/cb?code=ABC123&state=xyz` → `...?code=***&state=xyz`.
    """
    def _sub(m: re.Match) -> str:
        scheme = m.group(1)
        authority = m.group(2)
        path = m.group(3)
        query = _redact_query_string(m.group(4))
        fragment = m.group(5) or ""
        return f"{scheme}://{authority}{path}?{query}{fragment}"
    return _URL_WITH_QUERY_RE.sub(_sub, text)



def _redact_form_body(text: str) -> str:
    """Redact sensitive values in a form-urlencoded body.

    Only applies when the entire input looks like a pure form body
    (k=v&k=v with no newlines, no other text). Single-line non-form
    text passes through unchanged. This is a conservative pass — the
    `_redact_url_query_params` function handles embedded query strings.
    """
    if not text or "\n" in text or "&" not in text:
        return text
    # The body-body form check is strict: only trigger on clean k=v&k=v.
    if not _FORM_BODY_RE.match(text.strip()):
        return text
    return _redact_query_string(text.strip())


def redact_sensitive_text(
    text: str,
    *,
    force: bool = False,
    code_file: bool = False,
    file_read: bool = False,
) -> str:
    """Apply all redaction patterns to a block of text.

    Safe to call on any string -- non-matching text passes through unchanged.
    Enabled by default. Disable via security.redact_secrets: false in config.yaml.
    Set force=True for safety boundaries that must never return raw secrets
    regardless of the user's global logging redaction preference.

    Set code_file=True to skip the ENV-assignment and JSON-field regex
    patterns when the text is known to be source code (e.g. MAX_TOKENS=***
    constants, "apiKey": "test" fixtures). Prefix patterns, auth headers,
    private keys, DB connstrings, JWTs, and URL secrets are still redacted.

    Set file_read=True for file content returned to the agent. Prefix-matched
    credentials remain redacted, but use a non-reusable sentinel such as
    ``«redacted:ghp_…»`` rather than a head/tail-preserving log mask. This
    keeps a later file rewrite from silently replacing a real secret with a
    plausible-looking but unusable partial token. ``file_read`` also implies
    ``code_file`` to retain the low-false-positive source/config path.

    Performance: each regex pattern is gated behind a cheap substring
    pre-check (e.g. ``"=" in text`` for ENV assignments, ``"://" in text``
    for URLs, ``"eyJ" in text`` for JWTs). On a typical fan log line
    (no secrets) this drops the 13-pattern scan from ~5.6us to ~1.8us per
    record (-68%). The pre-checks are conservative — false positives
    still run the full regex, which then doesn't match. False negatives
    are impossible because every regex requires the gated substring to
    match.
    """
    if text is None:
        return None
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return text
    if not (force or _REDACT_ENABLED):
        return text

    if file_read:
        code_file = True

    # Known prefixes (sk-, ghp_, etc.) — gate on substring presence
    if _has_known_prefix_substring(text):
        mask_prefix = _mask_token_nonreusable if file_read else _mask_token
        text = _PREFIX_RE.sub(lambda m: mask_prefix(m.group(1)), text)

    # ENV assignments: OPENAI_API_KEY=***  (skip for code files — false positives)
    if not code_file:
        if "=" in text:
            def _redact_env(m):
                name, quote, value = m.group(1), m.group(2), m.group(3)
                if _ENV_LOOKUP_VALUE_RE.match(value):
                    return m.group(0)
                return f"{name}={quote}{_mask_token(value)}{quote}"
            text = _ENV_ASSIGN_RE.sub(_redact_env, text)
            if "://" not in text:
                text = _CFG_DOTTED_RE.sub(_redact_env, text)
                text = _CFG_ANCHORED_RE.sub(_redact_env, text)

        # JSON fields: "apiKey": "***"  (skip for code files — false positives)
        if ":" in text and '"' in text:
            def _redact_json(m):
                key, value = m.group(1), m.group(2)
                if _ENV_LOOKUP_VALUE_RE.match(value):
                    return m.group(0)
                return f'{key}: "{_mask_token(value)}"'
            text = _JSON_FIELD_RE.sub(_redact_json, text)

        if ":" in text and "://" not in text:
            def _redact_yaml(m):
                key, separator, value = m.group(1), m.group(2), m.group(3)
                if _ENV_LOOKUP_VALUE_RE.match(value):
                    return m.group(0)
                return f"{key}{separator}{_mask_token(value)}"
            text = _YAML_ASSIGN_RE.sub(_redact_yaml, text)

    # Authorization and Proxy-Authorization headers, with or without a scheme.
    if "uthorization" in text or "UTHORIZATION" in text:
        text = _AUTH_HEADER_RE.sub(
            lambda m: m.group(1) + (m.group(2) or "") + _mask_token(m.group(3)),
            text,
        )

    # API-key style headers carry a single opaque value and may not match any
    # vendor-specific token prefix.
    if ":" in text:
        text = _SECRET_HEADER_RE.sub(
            lambda m: m.group(1) + _mask_token(m.group(2)),
            text,
        )

    # Private key blocks
    if "BEGIN" in text and "-----" in text:
        text = _PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", text)

    # A brace-only password in a source f-string is a variable reference, not
    # a live credential.  Preserve it for code output while still masking
    # literal connection strings everywhere.
    if "://" in text:
        if code_file:
            def _redact_db_connstr(m):
                password = m.group(2)
                if password.startswith("{") and password.endswith("}"):
                    return m.group(0)
                return f"{m.group(1)}***{m.group(3)}"
            text = _DB_CONNSTR_RE.sub(_redact_db_connstr, text)
        else:
            text = _DB_CONNSTR_RE.sub(lambda m: f"{m.group(1)}***{m.group(3)}", text)

        # Do not broadly redact URL query strings: signed links and OAuth
        # callbacks must remain usable.  A colon-less token in userinfo is the
        # narrow safe exception and prevents host credentials from entering
        # transcripts or tool output.
        text = _URL_BARE_TOKEN_RE.sub(
            lambda m: f"{m.group(1)}{_mask_token(m.group(2))}{m.group(3)}",
            text,
        )

    # JWT tokens (eyJ... — base64-encoded JSON headers)
    if "eyJ" in text:
        text = _JWT_RE.sub(lambda m: _mask_token(m.group(0)), text)

    # NOTE: Web-URL redaction (query params + userinfo + HTTP access-log
    # request targets) is intentionally OFF. Many legitimate workflows pass
    # opaque tokens through query strings — magic-link checkouts, OAuth
    # callbacks the agent is meant to follow, pre-signed share URLs — and
    # blanket-redacting param values by name breaks those skills mid-flow.
    # Known credential shapes (sk-, ghp_, JWTs, etc.) inside URLs are still
    # caught by _PREFIX_RE and _JWT_RE above. DB connection-string passwords
    # are still caught by _DB_CONNSTR_RE.

    # Form-urlencoded bodies (only triggers on clean k=v&k=v inputs).
    if "&" in text and "=" in text:
        text = _redact_form_body(text)

    return text


_ENV_DUMP_COMMANDS = frozenset({"env", "printenv", "set", "export", "declare"})


def is_env_dump_command(command: str | None) -> bool:
    """Return whether shell output is principally an environment dump.

    The distinction lets ordinary source/config output keep ``code_file=True``
    while ``env``/``printenv`` output receives the opaque ``KEY=value`` secret
    pass. Malformed input falls back to the source-safe path, where known token
    shapes are still redacted.
    """
    if not isinstance(command, str) or not command.strip():
        return False
    # Handle a direct shell ``-c`` wrapper before separator splitting. The
    # payload may itself contain quoted pipelines, which a regex split cannot
    # distinguish from separators in the outer command.
    try:
        root_tokens = shlex.split(command)
    except ValueError:
        root_tokens = []
    if root_tokens and root_tokens[0].rsplit("/", 1)[-1] in {
        "bash", "sh", "zsh", "dash",
    }:
        try:
            c_index = root_tokens.index("-c")
        except ValueError:
            c_index = -1
        if c_index >= 0 and c_index + 1 < len(root_tokens):
            return is_env_dump_command(root_tokens[c_index + 1])
    for segment in re.split(r"[|;&]+", command):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment)
        except ValueError:
            tokens = segment.split()
        if not tokens:
            continue
        if tokens[0] in _ENV_DUMP_COMMANDS:
            return True
        if tokens[0].rsplit("/", 1)[-1] in {"bash", "sh", "zsh", "dash"}:
            try:
                c_index = tokens.index("-c")
            except ValueError:
                continue
            if c_index + 1 < len(tokens) and is_env_dump_command(tokens[c_index + 1]):
                return True
    return False


def redact_terminal_output(
    output: str,
    command: str | None = None,
    *,
    force: bool = False,
) -> str:
    """Apply one redaction policy to foreground and background output."""
    if not output:
        return output
    return redact_sensitive_text(
        output,
        force=force,
        code_file=not is_env_dump_command(command),
    )


# Substrings used to gate ``_PREFIX_RE`` execution. If none of these appear in
# the input string, the prefix regex cannot match anything, so we skip it.
# False positives are fine (they just run the regex, which then matches
# nothing) — the bound is "no false negatives" and that holds because every
# pattern in ``_PREFIX_PATTERNS`` has at least one of these as a literal
# substring of its leading characters.
#
# Derived automatically from ``_PREFIX_PATTERNS`` at module load time so a
# future PR that adds a new prefix to the regex list can't silently break
# the screen.

def _extract_literal_prefix(pattern: str) -> str:
    """Return the leading literal characters of a regex pattern.

    Stops at the first regex metacharacter (``[``, ``(``, ``\\``, ``.``,
    ``?``, ``*``, ``+``, ``|``, ``{``, ``^``, ``$``).  Returns the literal
    that any match of the pattern MUST contain as a substring, so the
    pre-screen never produces false negatives.
    """
    meta = "[(\\.?*+|{^$"
    for i, ch in enumerate(pattern):
        if ch in meta:
            return pattern[:i]
    return pattern


_PREFIX_SUBSTRINGS = tuple(
    _extract_literal_prefix(p) for p in _PREFIX_PATTERNS
)


def _has_known_prefix_substring(text: str) -> bool:
    """Return True if ``text`` contains any known credential prefix substring.

    Used as a cheap pre-check before invoking the expensive ``_PREFIX_RE``.
    """
    return any(p in text for p in _PREFIX_SUBSTRINGS)


_HTTP_METHOD_SUBSTRINGS = (
    "GET ",
    "POST ",
    "PUT ",
    "PATCH ",
    "DELETE ",
    "HEAD ",
    "OPTIONS ",
    "TRACE ",
    "CONNECT ",
)



class RedactingFormatter(logging.Formatter):
    """Log formatter that redacts secrets from all log messages."""

    def __init__(self, fmt=None, datefmt=None, style='%', **kwargs):
        super().__init__(fmt, datefmt, style, **kwargs)

    def format(self, record: logging.LogRecord) -> str:
        original = super().format(record)
        return redact_sensitive_text(original)
