'use client'

import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown'
import { type FC, useMemo } from 'react'
import ShikiHighlighter from 'react-shiki'

import {
  CodeCard,
  CodeCardBody,
  CodeCardHeader,
  CodeCardIcon,
  CodeCardSubtitle,
  CodeCardTitle
} from '@/components/chat/code-card'
import { ExpandableBlock } from '@/components/chat/expandable-block'
import { CopyButton } from '@/components/ui/copy-button'
import { codiconForLanguage, isLikelyProseCodeBlock, sanitizeLanguageTag } from '@/lib/markdown-code'
import { chunkByLines, exceedsTextBudget } from '@/lib/text-chunks'

/**
 * Streamdown's code adapter renders header + body as inline siblings, so we
 * own the wrapping `<CodeCard>` here and neutralize the upstream
 * `data-streamdown="code-block"` chrome from styles.css. Anything that wants
 * a card-shaped code surface should compose `CodeCard*` directly.
 *
 * `react-shiki` full bundle so all `bundledLanguages` work; theme switches
 * follow the document `color-scheme` via `defaultColor="light-dark()"`.
 */
interface FanSyntaxHighlighterProps extends SyntaxHighlighterProps {
  defer?: boolean
}

const SHIKI_THEME = { dark: 'github-dark-default', light: 'github-light-default' } as const

/**
 * `github-light-default` colors comments `#6e7781` (~4.2:1 against the code
 * card background) — borderline unreadable at our 11px code size, and worst of
 * all for shell snippets where a single `#` turns the rest of the line into one
 * long comment span. Remap light-mode comments to GitHub's darker muted gray
 * (`#57606a`, ~6.4:1). Dark mode (`#8b949e`, ~6.1:1) already reads fine, so we
 * leave it untouched. Keyed per theme name so the bump only applies in light.
 */
const SHIKI_COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  'github-light-default': { '#6e7781': '#57606a' }
}

const MAX_HIGHLIGHT_CHARS = 150_000
const MAX_HIGHLIGHT_LINES = 3_000

export function exceedsHighlightBudget(code: string): boolean {
  return exceedsTextBudget(code, MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES)
}

const PlainCode: FC<{ code: string }> = ({ code }) => {
  const chunks = useMemo(() => chunkByLines(code, 200), [code])

  return (
    <>
      {chunks.map((chunk, index) => (
        <code
          className="block whitespace-pre [content-visibility:auto]"
          key={index}
          style={{ containIntrinsicSize: `auto ${chunk.lines * 20}px` }}
        >
          {chunk.text}
        </code>
      ))}
    </>
  )
}

export const SyntaxHighlighter: FC<FanSyntaxHighlighterProps> = ({
  components: { Pre },
  language,
  code,
  defer = false
}) => {
  const trimmed = (code ?? '').replace(/^\n+/, '').trimEnd()

  // Streaming may hand us empty/incomplete fences — render nothing rather
  // than a transient empty card.
  if (!trimmed.trim()) {
    return null
  }

  if (isLikelyProseCodeBlock(language, trimmed)) {
    return <div className="aui-prose-fence whitespace-pre-wrap wrap-anywhere text-foreground">{trimmed}</div>
  }

  const cleanLanguage = sanitizeLanguageTag(language || '')
  const label = cleanLanguage && cleanLanguage !== 'unknown' ? cleanLanguage : ''
  const overBudget = exceedsHighlightBudget(trimmed)
  const plain = defer || overBudget

  const body = (
    <Pre className="aui-shiki m-0 overflow-hidden bg-transparent p-0">
      {plain ? (
        <PlainCode code={trimmed} />
      ) : (
        <ShikiHighlighter
          addDefaultStyles={false}
          as="div"
          colorReplacements={SHIKI_COLOR_REPLACEMENTS}
          defaultColor="light-dark()"
          delay={120}
          language={language || 'text'}
          showLanguage={false}
          theme={SHIKI_THEME}
        >
          {trimmed}
        </ShikiHighlighter>
      )}
    </Pre>
  )

  return (
    <CodeCard data-streaming={defer ? 'true' : undefined}>
      <CodeCardHeader>
        <CodeCardTitle>
          <CodeCardIcon name={codiconForLanguage(label)} />
          代码
          {label && <CodeCardSubtitle> · {label}</CodeCardSubtitle>}
        </CodeCardTitle>
        <CopyButton
          appearance="inline"
          className="-my-1 -mr-1 h-5 px-1 opacity-55 hover:opacity-100"
          iconClassName="size-2.5"
          label="复制代码"
          showLabel={false}
          text={trimmed}
        />
      </CodeCardHeader>
      <CodeCardBody>
        {overBudget ? <ExpandableBlock>{body}</ExpandableBlock> : body}
      </CodeCardBody>
    </CodeCard>
  )
}
