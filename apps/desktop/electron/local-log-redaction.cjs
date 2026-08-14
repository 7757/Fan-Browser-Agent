'use strict'

const DEFAULT_MAX_LENGTH = 2_000

/**
 * Remove common credentials and personal paths before text reaches the local
 * desktop log. This module has no network, upload, or customer-support path.
 */
function redactLocalLogText(value, maxLength = DEFAULT_MAX_LENGTH) {
  let text = String(value == null ? '' : value)
  text = text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\bAuthorization\s*:[^\r\n]*/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:Set-)?Cookie\s*:[^\r\n]*/gi, 'Cookie: [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(api[_-]?key|authorization|cookie|token|password)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[REDACTED]')
    .replace(
      /(\b(?:prompt|conversation(?:_content)?|messages?|tool[_ -]?(?:args?|arguments?|result|output)|request[_ -]?body|response[_ -]?body|input[_ -]?text|output[_ -]?text|user[_ -]?message|assistant[_ -]?message)\b\s*[:=])([^\r\n]*)/gi,
      '$1[CONTENT REDACTED]'
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\/Users\/[^/\s]+\//g, '~/')
    .replace(/\/home\/[^/\s]+\//g, '~/')
    .replace(/\\Users\\[^\\\s]+\\/gi, '~\\')

  const limit = Number.isSafeInteger(maxLength) && maxLength >= 0
    ? maxLength
    : DEFAULT_MAX_LENGTH
  if (text.length > limit) text = `${text.slice(0, limit)}…`
  return text
}

module.exports = { redactLocalLogText }
