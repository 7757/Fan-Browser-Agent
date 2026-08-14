const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i
const TECHNICAL_ERROR_PATTERN = /(?:^|\s)(?:HTTP\s*)?\d{3}(?:\s|:|$)|\b(?:ipc|stack trace|exception)\b/i
const USER_MESSAGE_KEYS = ['detail', 'message', 'msg'] as const

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : ''
}

function structuredMessage(raw: string): string | null {
  const objectStart = raw.indexOf('{')
  const objectEnd = raw.lastIndexOf('}')

  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(raw.slice(objectStart, objectEnd + 1)) as Record<string, unknown>

      for (const key of USER_MESSAGE_KEYS) {
        const value = parsed[key]

        if (typeof value === 'string' && value.trim()) {
          return value.trim()
        }
      }
    } catch {
      // Some local bridges format Python dictionaries with single quotes.
    }
  }

  const quotedField = raw.match(/["'](?:detail|message|msg)["']\s*:\s*(["'])([\s\S]*?)\1/i)

  return quotedField?.[2]?.replace(/\\([\\"'])/g, '$1').trim() || null
}

export function userFacingErrorMessage(error: unknown, fallback: string): string {
  const raw = rawErrorMessage(error).trim()

  if (!raw) {
    return fallback
  }

  const serverMessage = structuredMessage(raw)

  if (serverMessage) {
    return serverMessage
  }

  const hadTransportPrefix = IPC_ERROR_PREFIX.test(raw)
  const cleaned = raw.replace(IPC_ERROR_PREFIX, '').replace(/^Error:\s*/i, '').trim()

  if (!cleaned || hadTransportPrefix || TECHNICAL_ERROR_PATTERN.test(cleaned) || cleaned.length > 180) {
    return fallback
  }

  return cleaned
}
