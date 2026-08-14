'use client'

import { TextMessagePartProvider, useMessagePartText } from '@assistant-ui/react'
import {
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
  type SyntaxHighlighterProps
} from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import { type ComponentProps, memo, type ReactNode, useDeferredValue, useEffect, useMemo, useState } from 'react'

import { OversizedTextBlock } from '@/components/chat/oversized-text-block'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { SyntaxHighlighter } from '@/components/chat/shiki-highlighter'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { normalizeExternalUrl, openExternalLink, PrettyLink } from '@/lib/external-link'
import { createMemoizedMathPlugin } from '@/lib/katex-memo'
import { preprocessMarkdownSafely, stripInternalMessageMarkers } from '@/lib/markdown-preprocess'
import {
  filePathFromMediaPath,
  mediaExternalUrl,
  mediaKind,
  mediaName,
  mediaPathFromMarkdownHref,
  mediaStreamUrl
} from '@/lib/media'
import { previewTargetFromMarkdownHref } from '@/lib/preview-targets'
import { isOversizedRichText } from '@/lib/text-chunks'
import { cn } from '@/lib/utils'

// Math rendering plugin (KaTeX). Configured once at module scope — the
// plugin is stateless beyond its internal cache so re-creating per-render
// would needlessly thrash. We use a memoizing wrapper around rehype-katex
// (see lib/katex-memo.ts) so that during streaming we re-katex only the
// equations whose source actually changed since the last token. With the
// stock @streamdown/math plugin every equation re-renders on every token,
// which throttles UI updates badly for math-heavy responses; the memoized
// plugin keeps the steady-state work proportional to "new equations
// arriving" rather than "equations × tokens-per-second".
//
// `singleDollarTextMath: true` enables `$x^2$` for inline math (de-facto
// LLM convention). The default false-setting only accepts `$$...$$`.
const mathPlugin = createMemoizedMathPlugin({ singleDollarTextMath: true })

async function mediaSrc(path: string): Promise<string> {
  if (/^(?:https?|data):/i.test(path)) {
    return path
  }

  // Stream audio/video through the custom protocol: data URLs are capped and
  // load the whole file into memory, which broke playback for larger videos.
  if (window.fanDesktop && ['audio', 'video'].includes(mediaKind(path))) {
    return mediaStreamUrl(path)
  }

  if (!window.fanDesktop?.readFileDataUrl) {
    return mediaExternalUrl(path)
  }

  return window.fanDesktop.readFileDataUrl(filePathFromMediaPath(path))
}

function OpenMediaButton({ kind, path }: { kind: 'audio' | 'video'; path: string }) {
  return (
    <button
      className="mt-2 bg-transparent text-xs font-medium text-muted-foreground underline underline-offset-4 decoration-current/20 hover:text-foreground"
      onClick={() => void window.fanDesktop?.openExternal(mediaExternalUrl(path))}
      type="button"
    >
      打开{kind === 'audio' ? '音频' : '视频'}文件
    </button>
  )
}

function MediaAttachment({ path }: { path: string }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const kind = mediaKind(path)
  const name = mediaName(path)

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''

    setFailed(false)
    setSrc('')
    void mediaSrc(path)
      .then(value => {
        if (value.startsWith('blob:')) {
          objectUrl = value
        }

        if (!cancelled) {
          setSrc(value)
        } else if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })

    return () => {
      cancelled = true

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [path])

  if (kind === 'image' && src) {
    return (
      <span className="block">
        <MarkdownImage alt={name} src={src} />
      </span>
    )
  }

  if (kind === 'audio' && src) {
    return (
      <span className="my-3 block max-w-md rounded-xl border border-border bg-muted/35 p-3">
        <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{name}</span>
        <audio className="block w-full" controls onError={() => setFailed(true)} preload="metadata" src={src} />
        {failed && <OpenMediaButton kind="audio" path={path} />}
      </span>
    )
  }

  if (kind === 'video' && src) {
    return (
      <span className="my-3 block max-w-2xl rounded-xl border border-border bg-muted/35 p-3">
        <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{name}</span>
        <video
          className="block max-h-112 w-full rounded-lg bg-black"
          controls
          onError={() => setFailed(true)}
          src={src}
        />
        {failed && <OpenMediaButton kind="video" path={path} />}
      </span>
    )
  }

  return (
    <a
      className="font-semibold text-foreground underline underline-offset-4 decoration-current/20 wrap-anywhere"
      href="#"
      onClick={event => {
        event.preventDefault()
        openExternalLink(mediaExternalUrl(path))
      }}
    >
      {failed ? `打开 ${name}` : `正在加载 ${name}...`}
    </a>
  )
}

function childrenToText(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children).trim()
  }

  if (Array.isArray(children) && children.every(c => typeof c === 'string' || typeof c === 'number')) {
    return children.join('').trim()
  }

  return ''
}

function MarkdownLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const mediaPath = mediaPathFromMarkdownHref(href)

  if (mediaPath) {
    return <MediaAttachment path={mediaPath} />
  }

  const previewTarget = previewTargetFromMarkdownHref(href)

  if (previewTarget) {
    return <PreviewAttachment source="explicit-link" target={previewTarget} />
  }

  const target = href ? normalizeExternalUrl(href) : href

  if (!target || !/^https?:\/\//i.test(target)) {
    return (
      <a
        className={cn(
          'font-semibold text-foreground underline underline-offset-4 decoration-current/20 wrap-anywhere',
          className
        )}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
        {...props}
      >
        {children}
      </a>
    )
  }

  const text = childrenToText(children)
  const fallbackLabel = text && normalizeExternalUrl(text) !== target ? text : undefined

  return (
    <PrettyLink className={cn('wrap-anywhere', className)} fallbackLabel={fallbackLabel} href={target} {...props} />
  )
}

function MarkdownImage({ className, src, alt, ...props }: ComponentProps<'img'>) {
  return (
    <ZoomableImage
      alt={alt}
      className={cn(
        'm-0 block h-auto w-auto max-h-(--image-preview-height) max-w-[min(100%,var(--image-preview-max-width))] rounded-lg object-contain shadow-md',
        className
      )}
      containerClassName="my-2 block w-fit max-w-full"
      slot="aui_markdown-image"
      src={src}
      {...props}
    />
  )
}

/**
 * Re-publish the active message-part context with React's `useDeferredValue`
 * applied to the streaming text and status. The outer wrapper still re-renders
 * on every token, but the work it does is trivial (one hook, one provider).
 *
 * The expensive subtree (Streamdown → micromark → mdast → hast → React) lives
 * inside `<TextMessagePartProvider>` and reads the deferred text via the
 * normal `useMessagePartText` hook. React's concurrent scheduler then has
 * permission to:
 *   - skip intermediate token states when the next token arrives mid-render
 *     (it abandons the in-flight deferred render and starts over)
 *   - deprioritize the markdown render when the main thread is busy with an
 *     urgent task (typing, scrolling, layout work elsewhere)
 *
 * Net effect: per-token CPU is unchanged but the *blocking* part of that work
 * goes away — typing-while-streaming stays a single-frame paint, scroll
 * stutter disappears, and the longtask histogram tightens because long
 * commits can be interrupted and discarded.
 *
 * Industry standard (Streamdown's own block-array setState already uses
 * `useTransition`); this just lifts the deferral up to the consumer text
 * boundary so it covers the whole pipeline, not just the inner setState.
 */
function DeferStreamingText({ children }: { children: ReactNode }) {
  const { text, status } = useMessagePartText()
  const deferredText = useDeferredValue(text)
  const isRunning = status.type === 'running'

  return (
    <TextMessagePartProvider isRunning={isRunning} text={deferredText}>
      {children}
    </TextMessagePartProvider>
  )
}

interface MarkdownTextSurfaceProps {
  containerClassName?: string
  containerProps?: ComponentProps<'div'> & { 'data-slot'?: string }
  preprocess?: (text: string) => string
}

// Keep headings distinct without letting a model response turn into a document
// editor. The scale follows the surrounding reading text instead of prose's
// large article defaults.
const HEADING_SIZES: Record<'h1' | 'h2' | 'h3' | 'h4', string> = {
  h1: 'text-[1.25rem]',
  h2: 'text-[1.125rem]',
  h3: 'text-[1rem]',
  h4: 'text-[0.9375rem]'
}

const MARKDOWN_CONTAINER_CLASS_NAME = cn(
  'aui-md prose w-full max-w-none text-[length:var(--conversation-assistant-font-size)] leading-(--conversation-reading-line-height) text-foreground',
  'prose-p:leading-(--conversation-reading-line-height) prose-li:leading-(--conversation-reading-line-height)',
  'prose-headings:text-foreground prose-headings:tracking-normal prose-strong:font-semibold prose-strong:text-foreground',
  'prose-a:break-words prose-p:[overflow-wrap:anywhere]',
  'prose-li:marker:text-muted-foreground/60',
  'prose-code:rounded-[0.375rem] prose-code:px-[0.35rem] prose-code:py-[0.08rem] prose-code:font-mono prose-code:text-[0.86em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*+*]:mt-[0.875rem]'
)

function MarkdownTextSurface({
  containerClassName,
  containerProps,
  preprocess = preprocessMarkdownSafely
}: MarkdownTextSurfaceProps) {
  const { status, text } = useMessagePartText()
  const isStreaming = status.type === 'running'
  const oversized = isOversizedRichText(text)
  const oversizedText = useMemo(() => (oversized ? stripInternalMessageMarkers(text) : ''), [oversized, text])

  // Keep code parsing enabled while streaming so incomplete fenced blocks still
  // render as code cards. The expensive Shiki pass is deferred by
  // `SyntaxHighlighter` below when `isStreaming` is true.
  const plugins = useMemo(() => ({ math: mathPlugin, code }), [])

  const components = useMemo(
    () =>
      ({
        h1: ({ className, ...props }: ComponentProps<'h1'>) => (
          <h1 className={cn('mt-6 mb-2 font-semibold leading-[1.35]', HEADING_SIZES.h1, className)} {...props} />
        ),
        h2: ({ className, ...props }: ComponentProps<'h2'>) => (
          <h2 className={cn('mt-5 mb-2 font-semibold leading-[1.4]', HEADING_SIZES.h2, className)} {...props} />
        ),
        h3: ({ className, ...props }: ComponentProps<'h3'>) => (
          <h3 className={cn('mt-4 mb-1.5 font-semibold leading-[1.45]', HEADING_SIZES.h3, className)} {...props} />
        ),
        h4: ({ className, ...props }: ComponentProps<'h4'>) => (
          <h4 className={cn('mt-3.5 mb-1.5 font-semibold leading-[1.45]', HEADING_SIZES.h4, className)} {...props} />
        ),
        p: ({ className, ...props }: ComponentProps<'p'>) => (
          <p className={cn('my-0 wrap-anywhere leading-(--conversation-reading-line-height)', className)} {...props} />
        ),
        a: MarkdownLink,
        inlineCode: ({ className, style, ...props }: ComponentProps<'code'>) => (
          <code
            className={className}
            dir="ltr"
            // The live-thinking shimmer makes text transparent on its
            // container and relies on background-clip to reveal glyphs.
            // Inline code has its own background, so inheriting that fill
            // color leaves an empty input-like pill. Keep code text opaque.
            style={{ ...style, WebkitTextFillColor: 'currentColor' }}
            {...props}
          />
        ),
        hr: ({ className, ...props }: ComponentProps<'hr'>) => (
          <hr className={cn('my-6 border-(--ui-stroke-tertiary)', className)} {...props} />
        ),
        blockquote: ({ className, ...props }: ComponentProps<'blockquote'>) => (
          <blockquote
            className={cn('my-4 border-s-2 border-(--dt-primary) ps-4 text-foreground/75 not-italic', className)}
            dir="auto"
            {...props}
          />
        ),
        ul: ({ className, ...props }: ComponentProps<'ul'>) => (
          <ul className={cn('my-3 space-y-1.5 ps-6', className)} dir="auto" {...props} />
        ),
        ol: ({ className, ...props }: ComponentProps<'ol'>) => (
          <ol className={cn('my-3 space-y-1.5 ps-6', className)} dir="auto" {...props} />
        ),
        li: ({ className, ...props }: ComponentProps<'li'>) => (
          <li className={cn('ps-1 leading-(--conversation-reading-line-height)', className)} {...props} />
        ),
        table: ({ className, ...props }: ComponentProps<'table'>) => (
          <div className="aui-md-table lg-card lg-card-static my-5 max-w-full overflow-x-auto">
            <table
              className={cn(
                'm-0 w-full min-w-[32rem] border-collapse text-[0.875rem] [&_tr]:border-b [&_tr]:border-(--lg-divider) [&_tr:last-child]:border-b-0',
                className
              )}
              {...props}
            />
          </div>
        ),
        thead: ({ className, ...props }: ComponentProps<'thead'>) => (
          <thead className={cn('m-0 bg-(--lg-inset-fill) text-foreground/70', className)} {...props} />
        ),
        th: ({ className, ...props }: ComponentProps<'th'>) => (
          <th
            className={cn(
              'whitespace-nowrap px-3.5 py-2.5 text-left align-middle text-[0.8125rem] font-semibold text-foreground/70',
              className
            )}
            {...props}
          />
        ),
        td: ({ className, ...props }: ComponentProps<'td'>) => (
          <td
            className={cn('px-3.5 py-2.5 align-top text-[0.875rem] leading-[1.55] text-foreground/90', className)}
            {...props}
          />
        ),
        img: MarkdownImage,
        SyntaxHighlighter: (props: SyntaxHighlighterProps) => <SyntaxHighlighter {...props} defer={isStreaming} />
      }) as StreamdownTextComponents,
    [isStreaming]
  )

  if (oversized) {
    return (
      <OversizedTextBlock
        className={cn('aui-md text-foreground/90', containerClassName)}
        containerProps={containerProps}
        text={oversizedText}
      />
    )
  }

  return (
    <StreamdownTextPrimitive
      components={components}
      containerClassName={cn(MARKDOWN_CONTAINER_CLASS_NAME, containerClassName)}
      containerProps={containerProps}
      lineNumbers={false}
      mode="streaming"
      // Always auto-close incomplete fences — even during streaming.
      // Without this, an unclosed ```python ... ``` whose body contains
      // `$` (very common: shell snippets, JS template strings, dollar
      // amounts) leaks those dollars out to the math parser and they
      // get rendered as broken inline math until the closing fence
      // arrives. Shiki is independently deferred via `defer={isStreaming}`
      // on the SyntaxHighlighter component, so we don't pay code-block
      // tokenization on every token even with this set.
      parseIncompleteMarkdown
      plugins={plugins}
      preprocess={preprocess}
    />
  )
}

interface MarkdownTextContentProps extends MarkdownTextSurfaceProps {
  isRunning: boolean
  text: string
}

export function MarkdownTextContent({ isRunning, text, ...surfaceProps }: MarkdownTextContentProps) {
  return (
    <TextMessagePartProvider isRunning={isRunning} text={text}>
      <DeferStreamingText>
        <MarkdownTextSurface {...surfaceProps} />
      </DeferStreamingText>
    </TextMessagePartProvider>
  )
}

const MarkdownTextImpl = () => {
  return (
    <DeferStreamingText>
      <MarkdownTextSurface />
    </DeferStreamingText>
  )
}

export const MarkdownText = memo(MarkdownTextImpl)
