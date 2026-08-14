export const MAX_RICH_TEXT_CHARS = 200_000

export interface TextChunk {
  lines: number
  text: string
}

export function isOversizedRichText(text: string): boolean {
  return text.length > MAX_RICH_TEXT_CHARS
}

export function exceedsTextBudget(text: string, maxChars: number, maxLines: number): boolean {
  if (text.length > maxChars) {
    return true
  }

  let lines = 1
  let index = text.indexOf('\n')

  while (index !== -1) {
    lines += 1

    if (lines > maxLines) {
      return true
    }

    index = text.indexOf('\n', index + 1)
  }

  return false
}

export function chunkByLines(text: string, linesPerChunk: number, charsPerChunk = 32_000): TextChunk[] {
  if (!Number.isInteger(linesPerChunk) || linesPerChunk < 1) {
    throw new RangeError('linesPerChunk must be a positive integer')
  }

  if (!Number.isInteger(charsPerChunk) || charsPerChunk < 1) {
    throw new RangeError('charsPerChunk must be a positive integer')
  }

  const chunks: TextChunk[] = []
  let chunkStart = 0
  let lineBreaks = 0

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineBreaks += 1
    }

    const reachedLineLimit = lineBreaks >= linesPerChunk
    const reachedCharLimit = index + 1 - chunkStart >= charsPerChunk

    if ((reachedLineLimit || reachedCharLimit) && index + 1 < text.length) {
      chunks.push({
        lines: Math.max(1, lineBreaks + (text.charCodeAt(index) === 10 ? 0 : 1)),
        text: text.slice(chunkStart, index + 1)
      })
      chunkStart = index + 1
      lineBreaks = 0
    }
  }

  chunks.push({
    lines: Math.max(1, lineBreaks + (text.endsWith('\n') ? 0 : 1)),
    text: text.slice(chunkStart)
  })

  return chunks
}
