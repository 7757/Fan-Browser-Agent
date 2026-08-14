import { getFanConfigRecord } from '@/fan'

// Omnibox helpers for the browser panel. A new session opens a blank new-tab
// page (see session-browser / use-session-actions); the search engine is only
// used when the user actually types a search here, or the agent navigates.

// Search-query endpoints for the engines, for the omnibox: typing non-URL
// text and pressing Enter searches the configured engine (like a real browser).
const SEARCH_ENGINE_QUERIES: Record<string, (q: string) => string> = {
  bing: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  google: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  baidu: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`
}

// Omnibox classifier, kept deliberately simple: whitespace means a search query;
// a scheme or a dotted host (domain / IP) — or localhost — is a URL; a bare word
// like "nihao" is a search. This mirrors practical omnibox behavior.
function looksLikeUrl(input: string): boolean {
  const s = input.trim()

  if (!s || /\s/.test(s)) {return false}

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {return true}

  return s.includes('.') || s.toLowerCase().startsWith('localhost')
}

// If a URL is a search-results page of a known engine, return the search term;
// else null. Sessionthis only to select the search glyph—the
// omnibox itself always displays the browser-committed URL.
const SEARCH_RESULT_PARAMS: { host: RegExp; param: string }[] = [
  { host: /(^|\.)google\./i, param: 'q' },
  { host: /(^|\.)bing\.com$/i, param: 'q' },
  { host: /(^|\.)baidu\.com$/i, param: 'wd' },
  { host: /(^|\.)duckduckgo\.com$/i, param: 'q' }
]

export function searchQueryFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl)
    const isSearchPath = /\/(search|s)\b/i.test(u.pathname) || u.hostname.includes('duckduckgo')

    if (!isSearchPath) {return null}

    for (const { host, param } of SEARCH_RESULT_PARAMS) {
      if (host.test(u.hostname)) {
        const q = u.searchParams.get(param)?.trim()

        if (q) {return q}
      }
    }
  } catch {
    return null
  }

  return null
}

// Resolve what to actually navigate to for an omnibox entry: the URL itself
// (adding https:// when schemeless), or a search on the configured engine.
export async function resolveOmniboxUrl(input: string): Promise<string> {
  const s = input.trim()

  if (looksLikeUrl(s)) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`
  }

  try {
    const cfg = (await getFanConfigRecord()) as Record<string, unknown>
    const browser = cfg.browser as { search_engine?: unknown } | undefined
    const engine = String(browser?.search_engine ?? 'baidu').toLowerCase()

    return (SEARCH_ENGINE_QUERIES[engine] ?? SEARCH_ENGINE_QUERIES.baidu)(s)
  } catch {
    return SEARCH_ENGINE_QUERIES.baidu(s)
  }
}
