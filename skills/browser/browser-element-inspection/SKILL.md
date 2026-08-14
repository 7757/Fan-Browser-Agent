---
name: browser-element-inspection
description: "Use when you need an element's real properties — attribute values, text, backend node, ARIA role/name — without acting on it. browser_element inspects/reads/evaluates on an indexed element; browser_evaluate/browser_evaluate_js and browser_find_elements read the DOM directly."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, inspection, attributes, accessibility, eb-element, eb-evaluate, dom]
    related_skills: [browser-form-filling, browser-iframe-shadow-dom, browser-scroll-recovery, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser Element Inspection

## Overview

Often you need to *read* the page, not change it: what URL does this link point to, is this checkbox actually checked, what value is in this field, what's this element's ARIA role, is the button disabled. Guessing from the rendered text is error-prone. The embedded browser gives you precise, no-LLM-cost read tools that inspect the real DOM/accessibility state.

`browser_element` operates on an **indexed** element (info / read one attribute / evaluate an arrow function bound to it). `browser_find_elements` queries the DOM by CSS selector and returns tag, text, attributes, and child counts for elements that may not even be in the interactive set. `browser_evaluate` / `browser_evaluate_js` run JavaScript in the page to compute anything programmatically. `browser_observe` with accessibility/snapshot enrichment surfaces ARIA roles and backend-node detail. Reading before acting prevents wrong-target clicks and false "it worked" conclusions.

## When to Use

- Verifying state: is it checked/selected/disabled/visible, what's the current `value`.
- Reading attributes: `href`, `src`, `data-*`, `aria-*`, `name`, `class`, `id`.
- Resolving the right target among several similar elements before clicking.
- Reading the accessibility role/name of a control.
- Don't use for: changing values (use `browser-form-filling`) or navigating.

## Inspecting an Indexed Element — `browser_element`

Three operations on the element at a given index:

```
browser_element(index=N, operation="info")                          # tag, text, key attributes, geometry
browser_element(index=N, operation="attribute", name="href")        # one attribute value
browser_element(index=N, operation="evaluate", expression="() => this.checked")   # arrow fn, `this` = the element
```

The `evaluate` operation binds `this` to the element, so you can read anything: `() => this.value`, `() => this.disabled`, `() => this.getAttribute('aria-expanded')`, `() => this.getBoundingClientRect().top`. This is the precise way to confirm a control's live state instead of inferring from rendered text.

## Querying the DOM — `browser_find_elements`

When you don't have an index, or want several elements at once, query by CSS selector:

```
browser_find_elements(selector="a.download", attributes=["href", "download"])
browser_find_elements(selector="[role=tab]", attributes=["aria-selected"])
browser_find_elements(selector="input[name=email]", attributes=["value", "required"])
```

It returns tag, (optional) text, the requested attributes, and child counts — even for elements outside the indexed/interactive set (e.g. hidden inputs, metadata nodes). Zero LLM cost; ideal for "does this exist and what are its attributes" questions.

## Computing Across the Page — `browser_evaluate` / `browser_evaluate_js`

- `browser_evaluate(expression="(arg) => ...", args=[...])` runs a single arrow function (Browser-Use style) and returns its value. Good for one-liners: `(sel) => document.querySelectorAll(sel).length`.
- `browser_evaluate_js(code="...")` runs arbitrary browser JS / an IIFE for richer extraction. Browser APIs only — no Node.js. Use `max_chars` to cap large returns.

Both are bound by same-origin policy: they cannot read cross-origin iframes or closed shadow roots (see `browser-iframe-shadow-dom`).

## ARIA Role, Name & Backend Node

For accessibility/role information and backend-node identity, enrich the observation:

```
browser_observe(includeAccessibility=true, includeSnapshot=true)
```

`includeAccessibility=true` adds the CDP Accessibility tree (role + accessible name), which is the reliable way to tell a real `<button>` from a `role="button"` div, or to find the control a screen reader would. `includeSnapshot=true` adds DOMSnapshot-backed elements with backend-node detail. For a single element, `browser_element(operation="evaluate", expression="() => this.getAttribute('role')")` reads its explicit role attribute directly.

## Choosing the Right Tool

| Goal | Tool |
|---|---|
| Read one attribute of an indexed element | `browser_element(operation="attribute")` |
| Read live state (checked/value/disabled) of an indexed element | `browser_element(operation="evaluate")` |
| Find elements + attributes by CSS, possibly hidden | `browser_find_elements` |
| Compute a number/array across the DOM | `browser_evaluate` / `browser_evaluate_js` |
| ARIA role / accessible name / backend node | `browser_observe(includeAccessibility/includeSnapshot=true)` |
| Just confirm some text exists on the page | `browser_search_page` |

## Common Pitfalls

1. **Inferring state from rendered text.** A toggle may *look* on but be off in the DOM. Read `this.checked` / `aria-pressed` with `browser_element(operation="evaluate")`.

2. **Using a stale index.** `browser_element` uses the latest observation's index. Re-observe if the page changed.

3. **Expecting `browser_evaluate` to pierce isolation.** Same-origin policy blocks cross-origin iframes and closed shadow roots — those reads return nothing or throw.

4. **Reaching for `browser_evaluate_js` when `browser_find_elements` suffices.** For "find elements + their attributes", `browser_find_elements` is simpler, cheaper, and safer than hand-written JS.

5. **Confusing the two evaluate tools.** `browser_evaluate` takes an arrow function (`(x) => ...`) with `args`; `browser_evaluate_js` takes a raw code string / IIFE. Match the input shape to the tool.

6. **Reading huge DOM dumps.** Cap output with `max_chars` on `browser_evaluate_js`, or scope `browser_find_elements` with a tight selector, instead of returning the whole tree.

## Verification Checklist

- [ ] Chose the read tool by goal (attribute → `browser_element`; CSS query → `browser_find_elements`; compute → `browser_evaluate`; role → accessibility observe)
- [ ] For live state, read it (`this.checked`/`this.value`/`aria-*`) rather than inferring from text
- [ ] Used an index from the latest observation for `browser_element`
- [ ] Enriched with `includeAccessibility`/`includeSnapshot` when role/backend-node detail was needed
- [ ] Did not assume `browser_evaluate` can read cross-origin or closed-shadow content
- [ ] Capped large outputs (`max_chars` / tight selector)
