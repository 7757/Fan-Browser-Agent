---
name: browser-scroll-recovery
description: "Use when content is below the fold, inside a scrollable container/iframe, or in a long/virtualized list. browser_scroll scrolls the page or an indexed element, browser_scroll_to_text jumps to visible text, and paginate by re-observing after each scroll."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, scroll, pagination, virtualized-list, eb-scroll, infinite-scroll]
    related_skills: [browser-element-inspection, browser-dropdown-selection, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser Scroll Recovery

## Overview

An element you need may simply not be in view yet: below the fold, inside a scrollable panel that has its own scrollbar, inside an iframe, or in a virtualized list that only renders the rows currently on screen. The embedded browser gives you two complementary tools. `browser_scroll` moves the **page** by default, or a **specific scrollable element** when you pass its index — this is how you scroll inside a modal, a sidebar, an inner panel, or an iframe rather than the whole page. `browser_scroll_to_text` jumps straight to a piece of visible text without you guessing how many pages to scroll.

The key insight for virtualized/infinite lists: an off-screen row has **no index** until it's rendered. You can't click what hasn't been scrolled into existence. So the loop is always scroll → re-observe → act on the now-present index.

## When to Use

- A button/link/row you expect is missing from `browser_observe` (below the fold or in a scroll container).
- Scrolling the whole page doesn't move an inner panel, modal, or iframe content.
- Long results, infinite-scroll feeds, or virtualized tables where rows load as you scroll.
- Don't use for: elements already visible in the observation — act on them directly.

## Page vs. Element Scrolling

`browser_scroll` defaults to the main page:

```
browser_scroll(down=true, pages=1)     # one viewport down
browser_scroll(down=false, pages=0.5)  # half a viewport up
```

To scroll **inside a specific container** (a chat panel, a modal body, a dropdown menu, an inner scroll region, or an iframe's content), pass that container/element's index:

```
browser_scroll(index=<scrollable element index>, down=true, pages=1)
```

If a page scroll seems to do nothing, the content is almost certainly in an inner scroll region — find the container in the observation and scroll it by index instead. The tool re-observes after scrolling, so read the returned DOM for newly visible indices.

## Jumping to Text

When you know what you're looking for, skip the guesswork:

```
browser_scroll_to_text(text="Add to cart")
browser_scroll_to_text(text="Total", exact=true, case_sensitive=true)
```

This scrolls until the text is visible, then re-observes. Use it to land near a target before clicking the nearby element by its freshly observed index. Pair with `browser_search_page(pattern="...")` first if you only want to confirm the text exists (and how many times) without moving the viewport.

## Long Lists & Virtualized Tables

Off-screen rows aren't in the DOM, so paginate:

1. `browser_observe` — note the rows currently rendered and the scroll container.
2. If your target isn't there, `browser_scroll(index=<container>, down=true, pages=1)` (or page scroll if it's the main list).
3. The tool re-observes; check the new rows. Repeat scroll → observe until the target appears or the list stops growing.
4. Act on the target by its **current** index, immediately after the observation that revealed it.

For infinite scroll that lazy-loads on reaching the bottom, `browser_scroll` down and then `browser_settle` (or `browser_wait`) to let the next batch fetch before re-observing. Detect "end of list": when two consecutive scrolls produce no new rows and the scroll position no longer changes, stop — don't loop forever.

## Recovering a Missing Element

Checklist when something you expect isn't in the observation:

1. Re-observe — it may have been a stale view.
2. `browser_scroll_to_text` for nearby label text, or `browser_search_page` to confirm it exists at all.
3. If it exists but page scroll won't reach it, scroll the inner container by index.
4. Check for an overlay/modal/cookie-banner intercepting — close it, then re-observe.

## Common Pitfalls

1. **Scrolling the page when content is in an inner panel.** Page `browser_scroll` won't move a modal/sidebar/iframe. Pass the container's `index`.

2. **Clicking a row that isn't rendered yet.** Virtualized rows have no index until scrolled into view. Scroll → observe → then click by the fresh index.

3. **Reusing an index after scrolling.** Scrolling re-renders; only the latest observation's indices are valid.

4. **Infinite scroll without a wait.** Scrolling past the bottom triggers a fetch; re-observing immediately misses the new batch. `browser_settle`/`browser_wait` between scroll and observe.

5. **Looping forever.** If two scrolls add no new content and position is unchanged, you've hit the end — stop and report what you found.

6. **Guessing page counts.** When you know the target text, `browser_scroll_to_text` is faster and more reliable than blind `pages=N` scrolling.

## Verification Checklist

- [ ] Determined whether the target scrolls with the page or inside a container/iframe
- [ ] Used `browser_scroll(index=...)` for inner containers, page scroll for the main document
- [ ] Used `browser_scroll_to_text` / `browser_search_page` to locate known text instead of blind scrolling
- [ ] For virtualized/infinite lists: scrolled → `browser_settle`/`browser_wait` → re-observed before acting
- [ ] Acted on the target by an index from the latest observation
- [ ] Stopped scrolling once two scrolls produced no new content (end-of-list detection)
