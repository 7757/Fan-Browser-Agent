// Minimal ANSI SGR parser for rendering terminal output inside chat tool
// cards. Only handles the SGR codes that show up in practice (color, bold,
// reset); cursor motions and other CSI sequences are dropped silently.
//
// Returns a flat array of styled segments so callers can render them as
// React spans without each consumer having to re-implement the parser.

export interface AnsiSegment {
  bold: boolean
  /** Tailwind text-color class or null for the default foreground. */
  fg: AnsiColor | null
  text: string
}

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'bright-black'
  | 'bright-red'
  | 'bright-green'
  | 'bright-yellow'
  | 'bright-blue'
  | 'bright-magenta'
  | 'bright-cyan'
  | 'bright-white'

const FG_BY_CODE: Record<number, AnsiColor> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'bright-black',
  91: 'bright-red',
  92: 'bright-green',
  93: 'bright-yellow',
  94: 'bright-blue',
  95: 'bright-magenta',
  96: 'bright-cyan',
  97: 'bright-white'
}

// CSI = ESC '[' params 'final'. We only care about SGR (final == 'm'); other
// final bytes are matched and consumed so they don't leak into the rendered
// text. Range covers the common CSI command set (A-Z / a-z / @).
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([\d;]*)([\x40-\x7e])/g
// Other escape sequences (single-char OSC/SS3/etc.) — strip silently.
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPE_RE = /\x1b[@-Z\\-_]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function parseAnsi(input: string): AnsiSegment[] {
  if (!input) {
    return []
  }

  // Strip non-CSI escapes upfront — none of them carry text we want to keep
  // and CSI_RE wouldn't match them.
  const cleaned = input.replace(OTHER_ESCAPE_RE, '')

  const segments: AnsiSegment[] = []
  let cursor = 0
  let bold = false
  let fg: AnsiColor | null = null

  const pushText = (text: string) => {
    if (!text) {
      return
    }

    const last = segments.at(-1)

    if (last && last.bold === bold && last.fg === fg) {
      last.text += text

      return
    }

    segments.push({ bold, fg, text })
  }

  CSI_RE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = CSI_RE.exec(cleaned)) !== null) {
    const start = match.index

    if (start > cursor) {
      pushText(cleaned.slice(cursor, start))
    }

    if (match[2] === 'm') {
      const codes = match[1]
        .split(';')
        .map(part => (part === '' ? 0 : Number(part)))
        .filter(value => Number.isFinite(value))

      for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i]

        if (code === 0) {
          bold = false
          fg = null
        } else if (code === 1) {
          bold = true
        } else if (code === 22) {
          bold = false
        } else if (code === 39) {
          fg = null
        } else if (code in FG_BY_CODE) {
          fg = FG_BY_CODE[code]
        } else if (code === 38) {
          // 256-color / truecolor — skip the trailing args we don't render.
          if (codes[i + 1] === 5) {
            i += 2
          } else if (codes[i + 1] === 2) {
            i += 4
          }
        }
        // Background colors (40-47, 100-107) and effects we don't render are
        // intentionally ignored — the segment keeps the prior bold/fg state.
      }
    }

    cursor = CSI_RE.lastIndex
  }

  if (cursor < cleaned.length) {
    pushText(cleaned.slice(cursor))
  }

  return segments
}

const TAILWIND_BY_COLOR: Record<AnsiColor, string> = {
  // Mapped onto the design system's semantic tokens (--ui-*), which carry
  // their own light/dark variants. We don't paint pure ANSI colors
  // (#000, #fff) because they disappear into the surface.
  black: 'text-(--ui-text-secondary)',
  red: 'text-(--ui-red)',
  green: 'text-(--ui-green)',
  yellow: 'text-(--ui-yellow)',
  blue: 'text-(--ui-blue)',
  magenta: 'text-(--ui-purple)',
  cyan: 'text-(--ui-cyan)',
  white: 'text-(--ui-text-tertiary)',
  'bright-black': 'text-(--ui-text-tertiary)',
  'bright-red': 'text-(--ui-red)',
  'bright-green': 'text-(--ui-green)',
  'bright-yellow': 'text-(--ui-yellow)',
  'bright-blue': 'text-(--ui-blue)',
  'bright-magenta': 'text-(--ui-purple)',
  'bright-cyan': 'text-(--ui-cyan)',
  'bright-white': 'text-(--ui-text-secondary)'
}

export function ansiColorClass(color: AnsiColor): string {
  return TAILWIND_BY_COLOR[color]
}

/** Returns true if the input contains at least one CSI sequence. Cheap check
 *  so callers can skip the parser for plain-ASCII output. */
export function hasAnsiCodes(input: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[/.test(input)
}
