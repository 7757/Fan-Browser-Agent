import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { FAN_LOGO_MARK } from '@/lib/brand'

const FAN_MARK_SRC = FAN_LOGO_MARK

// Same-origin /favicon.ico, derived from the page URL. Used when the main
// process hasn't reported a <link rel=icon> favicon (e.g. before its capture
// lands) — most sites serve this, so the icon shows without waiting on events.
export function originFaviconFor(pageUrl?: string): string {
  if (!pageUrl) {
    return ''
  }

  try {
    const parsed = new URL(pageUrl)

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return ''
    }

    return `${parsed.origin}/favicon.ico`
  } catch {
    return ''
  }
}

// Only durable network URLs cross the session persistence boundary. Page icon
// events can legally contain data:/blob: values tied to one renderer lifetime;
// replaying those after restart is either useless or unsafe. Returning an empty
// string also keeps old browser_state rows (which have no favicon) compatible.
export function sanitizePersistedFavicon(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  try {
    const parsed = new URL(value.trim())

    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return ''
    }

    return parsed.href
  } catch {
    return ''
  }
}

export function faviconCandidatesFor(src?: string, pageUrl?: string): string[] {
  const reported = typeof src === 'string' ? src.trim() : ''

  // A page-reported icon is authoritative, including renderer-local data: URLs.
  // Falling through to /favicon.ico after that icon fails can display a different
  // brand and also turns one failed request into a second speculative request.
  if (reported) {
    return [reported]
  }

  const fallback = originFaviconFor(pageUrl)

  return fallback ? [fallback] : []
}

export function isFanBlankTabUrl(value?: string): boolean {
  if (!value || value === 'about:blank') {
    return true
  }

  try {
    const parsed = new URL(value)

    return parsed.pathname === '/start' && parsed.searchParams.has('ws')
  } catch {
    return false
  }
}

// The tab's favicon chip. A page-reported favicon is authoritative. Same-origin
// /favicon.ico is only inferred when the page has not reported an icon at all;
// a failed reported icon falls back directly to the globe.
// SHARED by the full session tab strip and the overview cards' tab strip so
// they stay identical.
// size 'sm' is for the compact overview-card strip (a scaled-down preview);
// 'follow' preserves the composer strip's denser white identity chip.
// 'md' (default) is the full session tab strip.
const FAVICON_SIZES = {
  md: {
    chip: 'size-5 rounded-[0.5rem]',
    img: 'size-[0.875rem]',
    fallback: 'size-4',
    surface: 'bg-[color-mix(in_srgb,var(--dt-foreground)_6%,transparent)] text-(--ui-text-tertiary)'
  },
  sm: {
    chip: 'size-[0.875rem] rounded-[0.375rem]',
    img: 'size-[0.625rem]',
    fallback: 'size-[0.6875rem]',
    surface: 'bg-[color-mix(in_srgb,var(--dt-foreground)_6%,transparent)] text-(--ui-text-tertiary)'
  },
  follow: {
    chip: 'size-[18px] rounded-[5px]',
    img: 'size-[18px] rounded-[5px]',
    fallback: 'size-4',
    surface: 'bg-white text-[#2D6BF0]'
  }
} as const

type FaviconDimensions = (typeof FAVICON_SIZES)[keyof typeof FAVICON_SIZES]

// Chrome's default-favicon treatment is a compact, filled world glyph without a chip
// behind it. Keeping this local also avoids making the app-wide outline Globe
// icon pretend to be a browser favicon in unrelated surfaces.
function DefaultPageFavicon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={`text-[#5F6368] dark:text-[#9AA0A6] ${className}`}
      data-default-page-favicon=""
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-1 17.93C7.05 19.44 4 16.08 4 12c0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93Zm6.9-2.54C17.64 16.58 16.9 16 16 16h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39Z" />
    </svg>
  )
}

function FaviconSurface({ dims }: { dims: FaviconDimensions }) {
  return <span aria-hidden className={`col-start-1 row-start-1 ${dims.surface} ${dims.chip}`} data-favicon-surface="" />
}

function CandidateFavicon({
  candidates,
  dims,
  generation
}: {
  candidates: string[]
  dims: FaviconDimensions
  generation: string
}) {
  const [index, setIndex] = useState(0)
  const [ready, setReady] = useState(false)
  const current = candidates[index]
  const attempt = `${generation}:${index}:${current ?? ''}`
  const activeAttemptRef = useRef(attempt)

  // Layout cleanup retires the old attempt before the browser can deliver an
  // event for the newly committed candidate. The attempt token also protects
  // the async decode continuation from an old image changing the new state.
  useLayoutEffect(() => {
    activeAttemptRef.current = attempt

    return () => {
      if (activeAttemptRef.current === attempt) {
        activeAttemptRef.current = ''
      }
    }
  }, [attempt])

  const isCurrentAttempt = (image: HTMLImageElement) =>
    activeAttemptRef.current === attempt && image.isConnected && image.getAttribute('src') === current

  const advanceCandidate = (image: HTMLImageElement) => {
    // Hide synchronously so even an already-visible image never exposes the
    // browser's broken-image glyph while React commits the fallback state.
    image.style.visibility = 'hidden'

    if (!isCurrentAttempt(image)) {
      return
    }

    setReady(false)
    setIndex(previous => (previous === index ? previous + 1 : previous))
  }

  const handleLoad = async (image: HTMLImageElement) => {
    try {
      // onLoad means the bytes arrived; decode() makes the reveal boundary
      // explicit. Older/test DOMs without decode safely use onLoad itself.
      if (typeof image.decode === 'function') {
        await image.decode()
      }
    } catch {
      advanceCandidate(image)

      return
    }

    if (isCurrentAttempt(image)) {
      setReady(true)
    }
  }

  return (
    <>
      {ready && current ? <FaviconSurface dims={dims} /> : null}
      <DefaultPageFavicon
        className={`col-start-1 row-start-1 ${dims.fallback} ${ready && current ? 'invisible' : ''}`}
      />
      {current ? (
        <img
          alt=""
          aria-hidden
          className={`col-start-1 row-start-1 object-contain transition-opacity ${dims.img} ${
            ready ? 'visible opacity-100' : 'invisible opacity-0'
          }`}
          draggable={false}
          key={attempt}
          onError={event => advanceCandidate(event.currentTarget)}
          onLoad={event => void handleLoad(event.currentTarget)}
          src={current}
        />
      ) : null}
    </>
  )
}

export function TabFavicon({
  faviconPending = false,
  loadFailed = false,
  size = 'md',
  src,
  url
}: {
  faviconPending?: boolean
  loadFailed?: boolean
  size?: keyof typeof FAVICON_SIZES
  src?: string
  url?: string
}) {
  const candidates = useMemo(
    () => (loadFailed ? [] : faviconCandidatesFor(src, faviconPending ? undefined : url)),
    [faviconPending, loadFailed, src, url]
  )

  // JSON encoding avoids ambiguous delimiters in data: URLs. A new key mounts
  // a fresh loader generation, while the retired generation ignores late
  // onLoad/onError/decode completions.
  const generation = JSON.stringify(candidates)

  const dims = FAVICON_SIZES[size]
  // Search-results pages get NO special glyph: the engine's own favicon
  // (Bing, Google, …) identifies the tab better than a generic magnifier
  // — the search affordance lives in the omnibox, not the tab strip.
  const isFanBlank = isFanBlankTabUrl(url)

  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden ${dims.chip}`}>
      {loadFailed ? (
        <DefaultPageFavicon className={dims.fallback} />
      ) : !faviconPending && isFanBlank ? (
        <>
          <FaviconSurface dims={dims} />
          <img
            alt=""
            aria-hidden
            className={`col-start-1 row-start-1 object-contain opacity-90 dark:invert ${dims.img}`}
            draggable={false}
            src={FAN_MARK_SRC}
          />
        </>
      ) : (
        <CandidateFavicon candidates={candidates} dims={dims} generation={generation} key={generation} />
      )}
    </span>
  )
}
