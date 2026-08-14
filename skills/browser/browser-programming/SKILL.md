---
name: browser-programming
description: Run browser workflows as programmable transactions.
version: 1.0.0
author: Xingfan contributors, Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, workflow, program, transaction, numbered-dom]
    category: browser
    related_skills: [browser-form-filling, browser-scroll-recovery]
    fallback_for_toolsets: [browser_program]
    requires_toolsets: [browser_program]
    requires_tools: [browser_snapshot, browser_run, browser_handoff]
---

# Browser Programming Skill

Use Fan's numbered page snapshot to plan a compact browser transaction, then
batch Fan's existing native actions through the flat `fan.*` API. `browser_run`
is an action batcher, not Playwright, a second locator engine, or unrestricted
page JavaScript. Similar method names do not imply Playwright signatures,
options, or return values.

## When to Use

- A browser task has several known steps that can run from one page snapshot.
- A navigation or menu action reveals a page that code can inspect with a
  deterministic, unique rule.
- Repeated single browser actions would waste model round trips.
- A workflow needs a clean boundary for fresh information, user takeover, or
  uncertain side effects.

Do not use it to guess controls on an unseen page, bypass human verification,
or reproduce browser actions outside the native runtime.

## Prerequisites

- The desktop browser workbench is bound to the conversation.
- `browser_snapshot`, `browser_run`, and `browser_handoff` are available.
- Use the user's existing signed-in browser state; never request or expose
  cookies, session tokens, or hidden credentials.
- For the exact method signatures and target shapes, load
  [references/api.md](references/api.md) with `read_file` only when needed.

## How to Run

1. Use the current authoritative numbered page when one is attached; otherwise
   call `browser_snapshot`.
2. Treat user-specified page, tab, language, filter, and selection state as
   action preconditions. Correct mismatches before the goal action.
3. Put all steps justified by that observation in one `browser_run` body.
   Every call has a fresh isolated JavaScript scope, so declare all variables
   in that body; no earlier local `snapshot` or other value persists.
4. Only call `fan.observe()` when a later action in the same transaction needs
   the changed DOM.
5. Continue locally only when a deterministic filter produces one target.
6. Do not end a transaction with `fan.observe()`; the runtime attaches the final
   authoritative snapshot.
7. Read the run status and final snapshot before claiming completion.
8. Call `browser_handoff` when a person must log in, verify, approve, or decide.

## Quick Reference

| Need | Use |
|---|---|
| Address an outer snapshot index | `fan.ref(index)` |
| Read a fresh page in the program | `const snapshot = await fan.observe()` |
| Read fresh ordinary page prose | `snapshot.text` |
| Extract long page content | `fan.pageContent(options)` |
| Use a protected value collected from the user | top-level `value_refs` + `fan.protectedValue(alias)` |
| Enforce one candidate | `fan.requireUnique(candidates, reason)` |
| Return for model judgment | `return fan.replan(reason, snapshot)` |
| Navigate or search | `fan.navigate`, `fan.search` |
| Click | `fan.click(target, {allowOccluded?, force?, expected?, timeoutMs?})` |
| One verified visual click | `fan.clickPoint({x, y})` + top-level `visual_evidence_ref` |
| One verified visual drag | `fan.dragPoint({x, y}, {x, y})` + top-level `visual_evidence_ref` |
| Enter text | `fan.type`, `fan.keys` |
| Answer a native JS dialog | `fan.dialog("accept" \| "dismiss", promptText?)` |
| Highlight current numbered controls on the live page | `fan.highlight()`, `fan.highlight(target)`, `fan.highlight({limit: N})` |
| Clear live highlights | `fan.highlight({clear: true})` |
| Map numbered DOM controls to pixels | `browser_snapshot({highlight_screenshot: true})` |
| Fill stable fields | `fan.fillForm` |
| Fill and submit once | `fan.formSubmit` |
| Upload local files | `fan.upload(target, [absolutePath], options?)` |
| List tabs | `fan.tabs()` returns the tab array directly |
| Change tabs | `fan.newTab`, `fan.switchTab`, `fan.closeTab` |
| Wait for one numbered control state | `fan.waitForState(target, state, options)` |
| Wait for one delayed element | `fan.waitForElement(query, options)` |
| Scroll page/container/iframe | `fan.scroll(target?, options)` |

Targets are outer-snapshot `fan.ref(N)` values or element objects from the most
recent `fan.observe()`. They are not bare numbers, strings, selectors, roles,
or guessed references.

Values returned by `collect` as `fan-value://...` are opaque references, not
text to enter. Keep them outside code in `browser_run.value_refs`, bind each to
a stable alias, and pass only `fan.protectedValue(alias)` to `fan.type`,
`fan.fillForm`, `fan.formSubmit`, `fan.select`, `fan.dialog`, or `fan.upload`.
Never paste a reference into program code. The host resolves it only at the
native input boundary; unavailable or cross-session aliases must be collected
again.

Same-origin iframe controls appear in this same numbered list. For rich text,
use the inner numbered `contenteditable`/`textbox`; never substitute the outer
iframe number or blind global keystrokes for a missing editor target.

`snapshot.elements` is an ordinary array of element records. The `[N]` shown in
numbered DOM is `element.index`, not an array offset: use
`snapshot.elements.find(element => element.index === N)`, never
`snapshot.elements[N]`. Common fields are `index`, `tag`, `role`, `type`,
`name`, `text`, `value`, `checked`, `attributes`, `capabilities`, `disabled`,
and `readonly`; fields may be absent. Prefer semantic combinations of
`role`, `name` or `text`, and explicit `attributes`. A normal text field may
have `role: "textbox"` without an explicit `type="text"` attribute.
`snapshot.text` is the canonical numbered page text and also contains ordinary
visible prose that may have no element record. Use it for deterministic
cross-tab reading, then return only the compact facts the task needs.

`fan.click` accepts only `allowOccluded`, `force`, `expected`, and `timeoutMs`;
do not pass `modifiers` or other Playwright options. Each `fan.tabs()` element
has `stableId`, `tabId`, `url`, `title`, and `current`. Use `stableId` with
`fan.switchTab` and `fan.closeTab`. To open a known snapshot link in a new tab,
pass its real `href` to `fan.newTab(href)` instead of emulating a modifier-click.
Pass a numbered scroll container or iframe as the first argument:
`fan.scroll(fan.ref(N), {down: true, pages: 1})`.
Scroll upward with `fan.scroll({up: true, pages: 1})`; the host normalizes this
to `down: false`. Do not pass conflicting `up` and `down` values.
`fan.settle` uses only timeout/network-idle options; native actions already
wait internally, so do not append it mechanically.

When a snapshot starts with `<overlay>`, resolve the overlay before acting on
the obscured page. Use a listed current close/skip index first, then Escape
when current focus makes it appropriate, and call `fan.observe()` to verify
that the overlay disappeared. If no indexed action is available, return for a
fresh screenshot and use one evidence-bound coordinate click only when privacy
policy permits. Never delete, hide, or rewrite page DOM to bypass an overlay.
When `<overlay>` is absent, do not infer a current modal from an isolated
Close/Dismiss node, residual Cookie Settings text, or an `occluded` count, and
do not send Escape or click a close control on that basis.

`fan.dialog(action, promptText?)` is only for native JavaScript
`alert`, `confirm`, and `prompt` dialogs. The action is strictly `accept` or
`dismiss`; provide `promptText` only when accepting a native prompt. HTML/CSS
modals and onboarding overlays are page elements, so close them with a current
indexed action or confirmed-focus Escape and verify their disappearance with a
fresh observation.

`fan.highlight()` draws live overlays for every currently numbered interactive
element. Pass a current bound target to highlight one element, `{limit: N}` to
limit the all-elements form, or `{clear: true}` to remove the overlays. It does
not discover unnumbered Canvas/pixel targets, and a truncated snapshot is not
proof that every control on the whole document was highlighted.

Use `browser_snapshot({highlight_screenshot: true})` when the model must map
numbered DOM records to pixels, especially for icon-only controls. It implies
`include_screenshot: true` and draws the same `[index]` values onto the returned
image copy without changing or clearing live page highlights. Vision-capable
models inspect it directly; text-only models invoke auxiliary numbered
grounding only for this explicit request. Use the chosen `fan.ref(N)` in the
next `browser_run`; stale generations remain rejected.

### Verified Visual Coordinates

Use coordinates only when the numbered snapshot cannot reliably represent a
visible control. Request the latest
`browser_snapshot({include_screenshot: true})`, copy
`screenshot.coordinateAction.evidenceRef` exactly into the next
`browser_run.visual_evidence_ref`, and keep the reference outside program code.

The captured visible viewport uses a top-left origin with both axes normalized
from 0 through 1000. One evidence reference authorizes exactly one
`fan.clickPoint({x,y})` or `fan.dragPoint({x,y},{x,y})`. Capture a fresh
screenshot after any page, tab, scroll, or viewport change, and never
automatically retry an `unknown_after_effect` coordinate action.

Pass `fan.upload` a non-empty path array. Each existing, non-empty file must be
a readable regular file; files from any local directory are supported. Prefer
the path supplied by the user or created for the current task, and use a
resolved absolute path. A leading `~/` is accepted and expanded, but do not rely
on other relative paths. Downloads, Documents, Desktop, and temporary upload
files under `/tmp` are all valid locations. Do not copy a file into Downloads
merely to upload it.

## Procedure

### 1. Establish Ground Truth

Use the authoritative numbered page already present in the request. Call
`browser_snapshot` only when no current page observation is attached. Extract
the visible page goal, current tab, and real numbered controls. Do not invent a
control that is not in this snapshot.

Compare user-specified page, tab, language, filter, selected option, and output
scope with the visible state before acting. Treat a mismatch as a precondition
to correct in the same transaction, not as something to discover after submit.

If the next operation is fully known, reference its outer-snapshot number with
`fan.ref(N)`. If navigation is followed by another action that needs a
destination-page element, call `fan.observe()` before choosing and directly
passing that element object. If navigation is the final action, return without
observing; the runtime supplies the final snapshot.

### 2. Choose the Information Boundary

Batch actions while no new semantic decision is required:

- typing into a known field and pressing a known key;
- filling several stable fields already present;
- navigating, observing because a later action needs the new DOM, and selecting
  a uniquely identifiable control;
- opening a known tab and collecting deterministic page data.
- waiting for one already-numbered control to become enabled or detached with
  `fan.waitForState`, then continuing with its freshly bound result;
- waiting for one known delayed element with `fan.waitForElement`, then acting
  on the uniquely matched fresh element.

Return `needs_replan` when the fresh page presents alternatives whose meaning
the original code cannot decide. The right boundary is new information, not
one action per model turn.

Return immediately when no later action needs fresh DOM. Never add a trailing
`fan.observe()` merely to read the final URL, title, text, or field state.

### 3. Resolve Targets Without Guessing

Filter `snapshot.elements` by stable facts such as tag, role, accessible name,
visible text, input type, and attributes. Pass the candidates to
`fan.requireUnique`.

Never silently choose the first candidate. If the result is empty or ambiguous,
let the runtime return a replan boundary with candidate evidence.

When the target already has a number and only its state changes, use
`fan.waitForState`. The host pins the original browser node before any program
effect, waits for that exact node rather than resolving the number again, then
returns its freshly bound element when it remains attached:

```js
await fan.click(fan.ref(47));
const input = await fan.waitForState(
  fan.ref(46),
  {enabled: true},
  {description: "dynamic input"});
await fan.type(input, "Ready", {clear: true});
```

Use `{attached: false}` when a known numbered node must disappear. That result
is state evidence, not an actionable element. Never replace a known numbered
wait with a broad role query: another hidden or repeated control may match.

When the target did not exist in the earlier snapshot, `fan.waitForElement`
accepts a declarative exact query and returns the one fresh, already-bound element
so it can be passed directly to an action. It deliberately accepts no function callback,
so polling cannot hide asynchronous browser actions.

```js
await fan.click(fan.ref(17));
const input = await fan.waitForElement(
  {role: "textbox", name: "Details"},
  {description: "Details textbox"});
await fan.type(input, "Ready", {clear: true});
return {filled: true};
```

Queries may combine exact element fields and an exact `attributes` object. Zero
matches keep polling; multiple matches or timeout return `needs_replan`. Use an
explicit `fan.observe()` for a more complex condition. Never add one after the
final action; the runtime attaches the authoritative final snapshot.

A click that opens or switches a tab performs its own internal wait. Await the
click, then call `fan.tabs()` directly; never poll tabs with a DOM wait. When
exactly one tab was opened, the click result also
contains its public `openedTab` record.

### 4. Preserve Humanized Native Actions

Use `fan.type`, `fan.click`, and the other flat methods. These route to Fan's
existing human-visible pointer movement, typing, actionability checks, input
readback, and effect tracking. Do not emulate clicks or inputs in code.

Use `fan.fillForm` for stable multi-field input. Use `fan.formSubmit` when the
fields and submit target are already known and submission must happen once.
Use separate flat calls for a known sequence such as typing into `fan.ref(53)`
and pressing Enter. If several numbered fields and a submit button come from
the same snapshot, keep them in one `fan.formSubmit` action rather than
assembling a non-idempotent submit sequence by hand. See
[references/api.md](references/api.md) for the standard numbered-action and
tab examples.

### 5. Treat Side Effects Conservatively

Sending, buying, publishing, deleting, booking, and submitting are not
rollback-safe. Dispatch each once.

- `failed_before_effect` may be replanned from a fresh snapshot.
- `failed_after_effect` requires verification before any new action.
- `unknown_after_effect` must never be replayed automatically.

### 6. Verify and Finish

Inspect the final snapshot and the structured program value. Verify the URL,
page text, field value, success state, or extracted records required by the
user. A successful JavaScript return alone is not proof of a successful page
effect.

## Pitfalls

1. Reusing a number after navigation when another action follows. Observe and
   use only the new generation for that later action.
2. Adding Playwright-style methods. Only the documented flat `fan.*` API exists.
3. Choosing `candidates[0]`. Use `fan.requireUnique` or return for replanning.
4. Splitting every native action into another model turn. Batch until new
   semantic information appears.
5. Forcing the whole task into one run. A truthful `needs_replan` boundary is
   better than a guessed action.
6. Retrying an uncertain submit. Verify the page first and preserve the
   do-not-retry evidence.
7. Treating every “verification” label as an active CAPTCHA. A text/image code
   requires a currently visible challenge plus its input and uses `collect`;
   behavioral challenges and login steps that truly require the person use
   `browser_handoff`.
8. Appending `fan.observe()` at the end. Use the runtime-provided final snapshot.

## Verification

- [ ] Every target came from a current numbered snapshot.
- [ ] Relevant page, tab, language, filter, and selection preconditions matched
      the user's request or were corrected before the goal action.
- [ ] Every in-program observation supported a later action or branch.
- [ ] No transaction ended with a redundant `fan.observe()`.
- [ ] Runtime-selected candidates were deterministic and unique.
- [ ] The run used only flat `fan.*` methods.
- [ ] Side effects were dispatched at most once.
- [ ] `needs_replan`, `needs_human`, and unknown-effect statuses were respected.
- [ ] Completion was confirmed from the final snapshot or structured evidence.
- [ ] Any numbered live/image highlight matched the current observation, and a
      truncated or unnumbered page was not described as fully covered.
