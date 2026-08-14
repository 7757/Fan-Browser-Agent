export type TextUrlMode = 'all' | 'explicit' | 'http'

export interface TextUrlMatch {
  index: number
  url: string
}

const HARD_PROSE_BOUNDARIES = new Set([
  '，',
  '。',
  '；',
  '：',
  '！',
  '？',
  '、',
  '…',
  '（',
  '）',
  '［',
  '］',
  '｛',
  '｝',
  '【',
  '】',
  '《',
  '》',
  '〈',
  '〉',
  '「',
  '」',
  '『',
  '』',
  '〔',
  '〕',
  '〖',
  '〗',
  '〘',
  '〙',
  '〚',
  '〛',
  '“',
  '”',
  '‘',
  '’'
])

const OPENING_DELIMITERS = new Set(['(', '[', '{'])

const OPENING_FOR_CLOSING: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{'
}

const TRAILING_SENTENCE_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])

function candidateRegex(mode: TextUrlMode): RegExp {
  if (mode === 'http') {
    return /https?:\/\/[^\s<>"'`*]+/gi
  }

  if (mode === 'explicit') {
    return /(?:https?:\/\/|www\.)[^\s<>"'`*]+/gi
  }

  return /(?:https?:\/\/|www\.)[^\s<>"'`*]+|[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'`*]+)?/gi
}

export function splitUrlFromProse(candidate: string): string {
  const delimiters: string[] = []
  let boundary = candidate.length

  for (let index = 0; index < candidate.length;) {
    const codePoint = candidate.codePointAt(index)
    const char = codePoint === undefined ? '' : String.fromCodePoint(codePoint)

    if (HARD_PROSE_BOUNDARIES.has(char)) {
      boundary = index

      break
    }

    if (OPENING_DELIMITERS.has(char)) {
      delimiters.push(char)
    } else {
      const expectedOpening = OPENING_FOR_CLOSING[char]

      if (expectedOpening) {
        if (delimiters[delimiters.length - 1] !== expectedOpening) {
          boundary = index

          break
        }

        delimiters.pop()
      }
    }

    index += char.length || 1
  }

  let url = candidate.slice(0, boundary)

  while (url && TRAILING_SENTENCE_PUNCTUATION.has(url[url.length - 1] || '')) {
    url = url.slice(0, -1)
  }

  return url
}

function isUsableUrl(value: string): boolean {
  const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`

  try {
    const parsed = new URL(normalized)

    return /^https?:$/.test(parsed.protocol) && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * Finds URL spans in natural-language text without treating adjacent prose as
 * part of the URL. URL parsers cannot infer that distinction themselves:
 * Chromium will happily encode `）。下一句` as a valid path, even though it is
 * clearly sentence punctuation and prose to a reader.
 */
export function findTextUrls(text: string, mode: TextUrlMode = 'all'): TextUrlMatch[] {
  const matches: TextUrlMatch[] = []
  const candidates = candidateRegex(mode)
  let searchFrom = 0

  while (searchFrom < text.length) {
    candidates.lastIndex = searchFrom

    const match = candidates.exec(text)

    if (!match) {
      break
    }

    const candidate = match[0]
    const url = splitUrlFromProse(candidate)

    if (!url || !isUsableUrl(url)) {
      searchFrom = Math.max(candidates.lastIndex, match.index + 1)

      continue
    }

    matches.push({ index: match.index, url })
    searchFrom = match.index + url.length
  }

  return matches
}
