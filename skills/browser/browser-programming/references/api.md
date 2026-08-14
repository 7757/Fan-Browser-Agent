# Flat `fan.*` API Reference

The `browser_run` code field is an async JavaScript function body. It receives
one injected object named `fan`, whose methods batch Fan's existing native
browser actions. It is not Playwright or a second browser implementation.
There is no Node.js, Electron, filesystem, direct network, raw CDP, or
arbitrary page-evaluation access.

Every `browser_run` starts a fresh isolated JavaScript scope. Variables,
functions, arrays, and a local named `snapshot` from an earlier call do not
persist. Declare everything the current program needs in the same code body.
`snapshot` is not an injected global: use
`const snapshot = await fan.observe()` in this call when the program needs
structured page elements or page text. If the model already knows an outer
numbered target, use `fan.ref(N)` without an extra observation.

## Observation and References

```js
const snapshot = await fan.observe();
const article = await fan.pageContent({format: "text", maxChars: 20000});
const target = fan.ref(53);
const secret = fan.protectedValue("password");
const unique = fan.requireUnique(candidates, "reason");
return fan.replan("new semantic choice is required", snapshot);
```

`snapshot.elements` is an ordinary array of structured, current-generation
element records. The `[N]` in numbered DOM is the record's `element.index`,
not an array offset. Look up a known number with
`snapshot.elements.find(element => element.index === N)`; never use
`snapshot.elements[N]`.

`snapshot.text` is the canonical numbered page text for the active tab and may
be truncated on an unusually large page. It includes ordinary page prose that
does not necessarily appear in `snapshot.elements`. Read prices, status text,
and explanatory content with `String(snapshot.text || "")`; use
`snapshot.elements` only to select numbered action targets.

Common fields are `index`, `tag`, `role`, `type`, `name`, `text`, `value`,
`checked`, `attributes`, `capabilities`, `disabled`, and `readonly`. Treat
absent fields as empty. Prefer stable combinations of `role`, accessible
`name` or visible `text`, and explicit `attributes`; use site-specific
attribute values only when the current snapshot supplies them. A normal text
field can have `role: "textbox"` without an explicit `type="text"` attribute.

Only call `fan.observe()` when a later action in the same transaction needs new
DOM for target selection or branching. Do not append a final `fan.observe()` to
read the URL, title, text, or field state; the runtime attaches its own final
authoritative snapshot. Return only the compact records the task needs.

Use `fan.pageContent(options?)` for long deterministic page prose that exceeds
the compact snapshot. It is the current replacement for
`browser_page_content`; useful options include `format`, `extractLinks`,
`extractImages`, `startFromChar`, `maxChars`, and `overlapLines`. It reads the
current page and does not create selector references.

`fan.ref(index)` binds an outer `browser_snapshot` number to its generation and
never rebinds it after a later observation. Element objects from
`fan.observe()` are already bound to that new observation and must be passed
directly. Bare numeric targets and fabricated reference objects are rejected.

## Navigation

```text
fan.navigate(url, options?)
fan.search(query, options?)
fan.back(options?)
fan.forward(options?)
fan.reload(options?)
```

Navigation invalidates old references. When a later action must select a
destination-page element, call `fan.observe()` first and pass an element from
that fresh snapshot. When navigation ends the transaction, return immediately
and use the runtime-provided final snapshot. To override the configured search
engine, pass an options object such as `{engine: "baidu"}`; do not pass an
engine string as the second argument.

## Interaction

```text
fan.click(target, {allowOccluded?, force?, expected?, timeoutMs?})
fan.clickPoint({x, y})
fan.type(target, text, options?)
fan.fillForm(fields, options?)
fan.formSubmit(fields, submitTarget, options?)
fan.keys(keys, options?)
fan.dialog("accept" | "dismiss", promptText?)
fan.dropdownOptions(target, options?) // -> {options: [...], current, ...}
fan.select(target, textOrValue, options?)
fan.hover(target, options?)
fan.focus(target, options?)
fan.highlight()
fan.highlight(target)
fan.highlight({limit: positiveInteger})
fan.highlight({clear: true})
fan.scroll(target?, {down?, up?, pages?, timeoutMs?})
fan.scrollToText(text, options?)
fan.drag(source, target, options?)
fan.dragPoint({x, y}, {x, y})
fan.upload(target, files, options?)
```

## Protected collected values

Typed `collect` fields return opaque `fan-value://...` references. Put those
references in the top-level `browser_run.value_refs` object and use only their
aliases inside code:

```json
{
  "intent": "Fill the known login fields",
  "value_refs": {
    "username": "fan-value://...",
    "password": "fan-value://..."
  },
  "code": "await fan.type(fan.ref(26), fan.protectedValue(\"username\"), {clear: true});\nawait fan.type(fan.ref(27), fan.protectedValue(\"password\"), {clear: true});"
}
```

`fan.protectedValue(alias)` is an opaque marker accepted only by `fan.type`,
`fan.fillForm`, `fan.formSubmit`, `fan.select`, `fan.dialog`, and `fan.upload`.
The raw value stays in the host and is materialized only at the final native
input boundary. Never put a `fan-value://` reference directly in code. If a
reference is unavailable, expired, or belongs to another session, collect that
field again instead of guessing.

A text or image CAPTCHA belongs in `collect(type="captcha")` only when the
latest page has a visibly active challenge and a current code input. A
“verification-code login” tab, help copy, hidden provider marker, or historical
instruction is not a CAPTCHA. Sliders, image-selection puzzles, and provider
checkbox challenges require human handoff.

`fan.dropdownOptions` preserves the original browser dropdown result envelope;
it does not return the option array directly:

```js
const menu = await fan.dropdownOptions(fan.ref(46));
const choice = fan.requireUnique(
  menu.options.filter(option => option.text === "United States"),
  "Dropdown choice must be unique"
);
await fan.select(fan.ref(46), choice.value || choice.text);
```

Never call `menu.filter(...)`, and never recover by clicking a native
`<select>`.

### Overlay recovery

When the snapshot begins with `<overlay>`, handle it before using obscured page
controls:

1. click a current close/skip candidate explicitly listed by the overlay;
2. otherwise use `fan.keys("ESC")` only with an appropriate current focus;
3. call `fan.observe()` and verify the overlay marker disappeared;
4. if no indexed candidate exists, return for a fresh screenshot and use one
   evidence-bound `fan.clickPoint` only when privacy policy permits.

Never remove, hide, or mutate arbitrary DOM to bypass a modal or onboarding
layer, and never reuse an obscured old reference after the overlay changes.
If the snapshot has no `<overlay>` marker, an isolated Close/Dismiss control,
residual cookie-preference text, or an `occluded` count is not evidence of a
current modal and must not trigger Escape or a close click.

### Native JavaScript dialogs

`fan.dialog(action, promptText?)` answers only a pending native JavaScript
`alert`, `confirm`, or `prompt`. Its action is strictly `accept` or `dismiss`;
pass `promptText` only when accepting a native prompt. The call remains inside
the current `browser_run` decision token, control lease, action settlement, and
effect classification.

HTML/CSS modal elements and onboarding overlays are not native dialogs. Use a
current indexed click or confirmed-focus Escape for those, then verify their
disappearance with a fresh `fan.observe()`.

### Numbered visual highlighting

`fan.highlight()` draws live overlays around all interactive elements in the
current numbered snapshot. `fan.highlight(target)` highlights one current bound
target, `fan.highlight({limit: N})` limits the all-elements form, and
`fan.highlight({clear: true})` removes the overlays. Targets remain
generation-bound. This covers numbered controls only; snapshot truncation and
unnumbered Canvas/pixel content remain outside its claim.

For a DOM-to-pixel map without modifying the page, request:

```json
{"scope": "active_page", "highlight_screenshot": true}
```

This implies `include_screenshot: true` and annotates the returned image copy
with the same `[index]` values used by the snapshot. It does not clear an
existing live highlight overlay. A vision-capable main model reads the pixels
directly; a text-only model uses auxiliary numbered grounding only for this
explicit request. Choose an index and pass `fan.ref(N)` in the next
`browser_run`; a page-generation change rejects the stale reference.

Use targets, not selector strings. A field record may use a current `ref` or
element plus its text and supported native input options. Prefer
`fan.formSubmit` over a second blind submit call when stable fields and the
submit target are known together.

### Verified visual coordinates

Coordinate actions are a narrow fallback for a visible control that the
numbered snapshot cannot address reliably. First request:

```json
{"scope": "active_page", "include_screenshot": true}
```

When the runtime can bind the current screenshot to coordinate actions, the
result contains:

```json
{
  "screenshot": {
    "coordinateAction": {
      "evidenceRef": "<opaque evidence reference>",
      "coordinateSpace": {
        "type": "normalized-viewport",
        "minimum": 0,
        "maximum": 1000,
        "origin": "top-left"
      },
      "actions": ["click", "drag"],
      "singleUse": true
    }
  }
}
```

Copy `evidenceRef` exactly into the next browser-run request, outside code:

```json
{
  "intent": "Click the visually confirmed close control",
  "visual_evidence_ref": "<opaque evidence reference>",
  "code": "await fan.clickPoint({x: 930, y: 75});"
}
```

For a drag:

```js
await fan.dragPoint({x: 250, y: 500}, {x: 750, y: 500});
```

Points are non-array objects with finite numeric `x` and `y` values in the
inclusive 0–1000 range. The captured visible viewport has a top-left origin.
One reference authorizes exactly one visual click or drag. Capture a fresh
screenshot after any page, tab, scroll, or viewport change, and never replay a
coordinate action after `unknown_after_effect`.

Same-origin iframe contents are flattened into the numbered snapshot. For a
rich-text editor, act on the numbered inner `contenteditable`/`textbox`, not on
the outer `<iframe>`. If only the frame and unnumbered text are present, or the
inner editor is read-only, do not send blind keystrokes.

Use `fan.keys` for a verified current focus or a shortcut. Prefer `fan.type`
for text entry into a numbered target, and never split a sentence into
one-character `fan.keys` calls; a whole text string can be sent at once.

`fan.upload(target, files, options?)` requires a non-empty array of existing,
non-empty regular files. Files from any local directory are supported. Prefer
the path supplied by the user or created for the current task, pass a resolved
absolute path, and do not copy a file into Downloads merely to upload it.
Downloads, Documents, Desktop, and temporary upload files under `/tmp` are all
valid locations. Leading `~/` paths are expanded for convenience, but do not
rely on other relative forms.

Scroll the page down with `fan.scroll({down: true, pages: 1})` and up with
`fan.scroll({up: true, pages: 1})`. The host normalizes `up: true` to
`down: false`; do not pass conflicting `up` and `down` values. Scroll a
numbered container or same-origin iframe with
`fan.scroll(fan.ref(16), {down: true, pages: 1.5})`. The target is the first
argument; `target` and `index` are not valid option keys.

`fan.click` accepts only these option keys:

- `allowOccluded`: boolean
- `force`: boolean
- `expected`: semantic precondition object
- `timeoutMs`: number

Other keys are rejected. In particular, `modifiers`, `button`, `clickCount`,
and `noWaitAfter` are not supported Playwright aliases. Do not invent
Ctrl/Command-click by passing `modifiers`. To open a known link in a new tab,
use the `href` exposed by its snapshot element:

```js
await fan.newTab(link.href);
```

## Waiting and Tabs

```text
fan.wait(milliseconds)
fan.waitForState(target, {attached?, enabled?}, {timeoutMs?, pollMs?, description?})
fan.waitForElement(query, {timeoutMs?, pollMs?, description?})
fan.settle({timeoutMs?, networkIdleMs?})
fan.tabs()
fan.newTab(url?, options?)
fan.switchTab(tabId, options?)
fan.closeTab(tabId, options?)
```

Navigation, tab changes, and native interactions already perform their action
waits.

The meaningful `fan.settle` options are `timeoutMs`/`timeout_ms` and
`networkIdleMs`/`network_idle_ms`. Do not copy the `description` label from
`waitForState` or `waitForElement`, and do not append `settle` mechanically
after a click, navigation, or tab change.

Use `fan.waitForState` when the earlier numbered snapshot already identifies
the exact element and only its state changes:

```js
await fan.click(fan.ref(47));
const input = await fan.waitForState(
  fan.ref(46),
  {enabled: true},
  {timeoutMs: 5000, description: "dynamic input"});
await fan.type(input, "Ready", {clear: true});
```

The host pins the original `(frame session, backend node)` identity before the
program can perform an effect. It never resolves the same number against a
rebuilt selector map. On an attached/enabled match, the returned element is
bound to the fresh observation and can drive the next action. For removal, use
`fan.waitForState(fan.ref(N), {attached: false})`; the result is state evidence
and the removed target cannot be acted on. `enabled` is undefined for a
detached node, so `{attached: false, enabled: false}` is rejected.

Use `fan.waitForElement` only when a later action depends on one new delayed
element that had no earlier number. It accepts a declarative exact query, not a callback,
and returns the fresh already-bound element. Queries may combine
`index`, `role`, `name`,
`text`, `label`, `placeholder`, `tag`, `type`, `href`, `value`, `checked`, and
an exact `attributes` object. Zero matches keep polling; multiple matches or a
timeout return `needs_replan`. Do not add `fan.settle()` or `fan.observe()`
merely because the transaction is ending.

A click that opens or switches a tab performs its own internal wait. Await the
click, then call `fan.tabs()` directly; never poll tabs with a DOM wait. If the
click opened exactly one new tab, its result also
contains that tab as `openedTab`.

`fan.tabs()` returns the tab array directly:

```js
[
  {stableId, tabId, url, title, current},
  // ...
]
```

It does not return `{active, tabs}`. Use the stable `stableId` value with
`fan.switchTab(stableId)` and `fan.closeTab(stableId)`.

After a human verification boundary, the host returns a fresh snapshot plus:

```text
human_step: {
  kind: "verification",
  status: "completed",
  authoritative: true,
  verificationCleared: true
}
```

This is runtime-authored completion evidence emitted only after the behavioral
challenge is no longer detected. Continue from the attached fresh snapshot and
mark that verification step complete. Residual instructional text or a
still-mounted challenge control must not trigger another handoff, retry, or
navigation away from the verified result.

## Artifacts

```text
fan.saveScreenshot({fileName, ...options})
fan.savePdf(options?)
```

These route to Fan's existing save actions and return their structured result.
`fan.saveScreenshot` requires a safe download filename. Neither artifact
method accepts an arbitrary output path.

`browser_snapshot({include_screenshot: true})` attaches raw pixels;
`browser_snapshot({highlight_screenshot: true})` implies the same attachment
and adds current DOM index boxes to the returned image copy. Neither form
exposes a reusable image path or changes the live page. When present,
`screenshot.coordinateAction.evidenceRef` is only a host authorization for one
fresh coordinate action, never an `image_url`.

When a later `vision_analyze` call needs the screenshot, preserve the exact
save result instead of predicting its Downloads path or extension:

```js
const shot = await fan.saveScreenshot({fileName: "captcha.png"});
return {
  screenshotPath: shot.path,
  fileName: shot.fileName,
  format: shot.format
};
```

`fileName` must be a bare filename, not `~/...`, a directory, or an absolute
path. On the next model turn, pass the returned `screenshotPath` unchanged to
`vision_analyze`.

## Minimal Patterns

Before acting, compare user-required page, tab, language, filter, and selected
option state with the current snapshot. Correct mismatches before the goal
action.

Known consecutive actions from one outer reference:

```js
await fan.type(fan.ref(53), "AI browser agent", {clear: true});
await fan.keys("ENTER");
return {submitted: true};
```

Several fields and one submit target from the same snapshot:

```js
await fan.formSubmit(
  [
    {target: fan.ref(31), text: "Ada"},
    {target: fan.ref(32), text: "ada@example.com"}
  ],
  fan.ref(40)
);
return {submitted: true};
```

Use this existing compound action when the fields and one-time submit are
known together, so submission provenance and idempotency remain one native
operation.

Read known pages across tabs in one transaction and then return:

```js
const sourceTab = fan.requireUnique(
  (await fan.tabs()).filter(tab => tab.current),
  "Source tab must be unique"
);
const pages = [];

await fan.navigate("https://example.com/one");
let snapshot = await fan.observe();
pages.push({
  url: snapshot.url,
  title: snapshot.title,
  hasPrice: /\$\d/.test(String(snapshot.text || ""))
});

await fan.newTab("https://example.com/two");
snapshot = await fan.observe();
pages.push({
  url: snapshot.url,
  title: snapshot.title,
  hasPrice: /\$\d/.test(String(snapshot.text || ""))
});

await fan.switchTab(sourceTab.stableId);
return {pages};
```

Use a current page's outer `fan.ref(N)` before opening or switching tabs.
After any tab change, call `fan.observe()` and pass an element object from that
fresh snapshot; never reuse the old number across tabs. When a page requires a
fresh interaction, select its unique target from that same observation. Observe
again only when the transaction must read the resulting prose before it moves
to another tab.

Fresh deterministic target:

```js
await fan.navigate("https://example.com/");
const snapshot = await fan.observe();
const matches = snapshot.elements.filter(element => {
  const role = String(element.role || element.attributes?.role || "");
  const name = String(
    element.name ||
    element.attributes?.["aria-label"] ||
    element.text ||
    ""
  ).trim();
  return role === "button" && name === "Continue";
});
const button = fan.requireUnique(matches, "Continue button must be unique");
await fan.click(button);
return {continued: true};
```

Dynamic choice:

```js
await fan.type(fan.ref(20), "San");
const option = await fan.waitForElement(
  {role: "option", text: "San Francisco"},
  {description: "unique autocomplete result"});
await fan.click(option);
return {selected: true};
```

The query returns the unique matching element, so the result is directly
actionable. For a non-waiting fresh snapshot, pass the complete candidate array
to `fan.requireUnique`; do not select `candidates[0]`.
