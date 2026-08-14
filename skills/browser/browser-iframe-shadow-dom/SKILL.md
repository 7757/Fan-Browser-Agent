---
name: browser-iframe-shadow-dom
description: "Use when a target element lives inside an iframe or shadow DOM. The browser_* tools auto-route through same-origin iframes and open shadow roots by index, but cross-origin OOPIF frames and closed shadow roots are not reachable — detect that and adapt."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, iframe, shadow-dom, oopif, cross-origin, eb-tools, web-components]
    related_skills: [browser-element-inspection, browser-form-filling, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser iframe & Shadow DOM

## Overview

Modern pages embed content in two nested contexts: **iframes** (an `<iframe>` hosting another document) and **shadow DOM** (encapsulated subtrees attached to custom elements / web components). The good news: the embedded browser flattens both into a single indexed observation. When `browser_observe` lists an element, you act on it by index with `browser_click` / `browser_type` / `browser_select` regardless of how deeply it's nested — the runtime routes the action into the right frame or shadow root for you. You usually don't need to "switch into" a frame.

The limits are about **isolation**, not nesting depth: a **cross-origin** iframe (rendered out-of-process — an OOPIF) and a **closed** shadow root are deliberately walled off by the browser. Their contents may not appear in the observation at all, and you cannot reach in. Recognizing those two cases — and not burning turns trying to force them — is the core of this skill.

## When to Use

- A button/field you can see on screen does not appear in `browser_observe`, or appears but actions on it silently fail.
- The page is built from web components (`<custom-element>`) or embeds widgets (payment fields, captchas, embedded docs, chat widgets, ad frames).
- Don't use for: ordinary same-document elements that already show up and respond — just act on them normally.

## How Routing Works (the easy path)

For same-origin iframes and open shadow roots, the element appears in the flattened observation. Act on it directly:

1. `browser_observe` — the element is listed with an index like any other.
2. `browser_click(index=N)` / `browser_type(index=N, text=...)` / `browser_select(index=N, text=...)` — the runtime dispatches the action into the correct frame/shadow context automatically.
3. Re-observe to confirm.

To enrich the observation with nested-target detail when something is missing, request the optional layers:

```
browser_observe(includeTargets=true, includeAccessibility=true, includeSnapshot=true)
```

`includeTargets=true` surfaces attached page/iframe CDP targets; `browser_targets` and `browser_target_info` list tracked targets and tell you which frames are app-owned/attached versus out-of-process.

## When the Element Isn't There: diagnose the boundary

If a visible element is absent from the observation or unresponsive, figure out which wall you hit:

| Symptom | Likely cause | What you can do |
|---|---|---|
| `<iframe>` present but its inner controls never appear | Cross-origin OOPIF | Often not reachable via index; see below |
| Element appears but click/type does nothing | Closed shadow root or occluded overlay | Closed shadow = unreachable; for overlay try `allow_occluded=true` |
| Web component shows but its internals are blank | Closed shadow root | Unreachable; look for a public API or a same-origin alternative |
| Inner controls appear and work | Same-origin iframe / open shadow | Normal — just use the index |

Use `browser_find_elements(selector="iframe")` to enumerate frames and read their `src` — a `src` on a different origin than the top page signals a cross-origin OOPIF.

## Cross-Origin iframes (OOPIF)

A cross-origin iframe runs out-of-process and is isolated by the browser's security model. Its DOM is generally **not** addressable by top-page index, and JS run via `browser_evaluate` / `browser_evaluate_js` in the top page cannot read into it (same-origin policy). Practical options:

- If the iframe content has its own URL, sometimes you can `browser_navigate` directly to that URL in the workbench (or a new tab) and operate there, then return — only when that makes sense for the task.
- Check `browser_targets` / `browser_target_info`: if the frame is an attached target, some routing may still work via index — try the indexed action once and observe the result.
- If it's a third-party widget (captcha, payment, embedded video) you genuinely cannot drive, stop and tell the user rather than thrashing. Captcha/verification is handled by the human-in-the-loop path (see `browser-anti-bot-etiquette`).

## Shadow DOM

- **Open** shadow roots (`attachShadow({mode:"open"})`) are traversed by the observation; their elements get indices and respond to `browser_*` actions normally.
- **Closed** shadow roots (`mode:"closed"`) hide their subtree from outside script and from the observation. You cannot reach inner elements by index, and `browser_evaluate` cannot pierce them. Look for the component's documented public methods/attributes (set via `browser_element(operation="attribute")` or `browser_evaluate_js` on the host), or a non-shadow fallback UI.
- A `slot`ted child lives in the host's light DOM, so it's reachable normally even if the component uses shadow DOM internally.

## Common Pitfalls

1. **Trying to "switch into" a frame.** There is no frame-switch step — actions route by index automatically for reachable contexts. If the element isn't in the observation, the problem is isolation, not a missing switch.

2. **Fighting a cross-origin OOPIF.** Repeated index/JS attempts won't pierce it. Confirm the boundary via frame `src` / `browser_targets`, then navigate to its URL or report it as undrivable.

3. **Assuming `browser_evaluate` sees everything.** Page JS is bound by same-origin policy and cannot read cross-origin frames or closed shadow roots. Don't write evaluate code that reaches across those walls.

4. **Treating a closed shadow root as a bug.** It's intentional encapsulation. Use the component's public API or a fallback, don't retry index access.

5. **Missing the enrichment flags.** When nested targets seem absent, re-observe with `includeTargets=true`/`includeAccessibility=true` before concluding the element is unreachable.

## Verification Checklist

- [ ] Tried acting on the element by its observed index first (routing is automatic for reachable contexts)
- [ ] If absent, classified the boundary: same-origin iframe / open shadow (reachable) vs OOPIF / closed shadow (not)
- [ ] Used `browser_find_elements(selector="iframe")` + `browser_targets` to confirm cross-origin frames by `src`/target type
- [ ] For OOPIF: considered navigating to the frame URL, or reported it as undrivable instead of thrashing
- [ ] For closed shadow DOM: looked for a public API / fallback rather than retrying index access
- [ ] Did not write `browser_evaluate` code that assumes it can pierce cross-origin or closed boundaries
