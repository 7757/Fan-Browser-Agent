---
name: browser-dropdown-selection
description: Select native and custom browser dropdown options.
version: 2.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, dropdown, select, forms, program, numbered-dom]
    category: browser
    related_skills: [browser-programming, browser-form-filling, browser-element-inspection, browser-scroll-recovery]
    fallback_for_toolsets: [browser_program]
    requires_toolsets: [browser_program]
    requires_tools: [browser_snapshot, browser_run]
---

# Browser Dropdown Selection

Use the latest numbered snapshot and the flat `fan.*` API inside
`browser_run`. This is not Playwright: do not use selectors, roles as locator
methods, bare numbers, or legacy single-action browser tools.

## Choose the Path

Dropdowns have two shapes:

- A native `<select>` owns `<option>` records that usually have no separate
  page numbers. Select it directly through its numbered control.
- A custom dropdown is a button, `div`, combobox, or listbox whose options may
  appear only after it opens.

`fan.select` handles native selects and many recognized custom dropdowns by
visible text or value. Use that fast path first when the intended option is
known. The distinction matters only when a custom widget needs an
open-observe-click fallback.

## Known Option

Use a current outer-snapshot number with `fan.ref(N)`:

```js
await fan.select(fan.ref(46), "Two");
return {selected: "Two"};
```

Do not click a native `<select>` first. Do not invent a number for one of its
options.

When the exact label or value is uncertain, inspect the available choices
before selecting:

```js
const target = fan.ref(46);
const menu = await fan.dropdownOptions(target);
const choice = fan.requireUnique(
  menu.options.filter(option =>
    option.text === "United States" || option.value === "US"
  ),
  "Dropdown choice must be unique"
);
await fan.select(target, choice.text || choice.value);
return {selected: choice.text || choice.value};
```

`fan.dropdownOptions` supports native selects and many ARIA/custom widgets.
Never silently use `menu.options[0]`.

## Stable Multi-Step Form

Keep controls from the same snapshot in one transaction. This is the preferred
path when no new semantic choice appears:

```js
await fan.type(fan.ref(27), "Fan Browser E2E", {clear: true});
await fan.select(fan.ref(46), "Two");
await fan.click(fan.ref(96));
await fan.click(fan.ref(103));
await fan.settle();
return {submitted: true};
```

Do not observe between these actions merely to refresh numbers. Observe again
only when navigation, opening a custom menu, or another dynamic change reveals
new elements that were not in the original snapshot.

## Custom Dropdown Fallback

If direct inspection or selection cannot resolve a custom widget, open it and
use a fresh in-program observation:

```js
const label = element => String(
  element.name ||
  element.text ||
  element.attributes?.["aria-label"] ||
  ""
).trim();

await fan.click(fan.ref(72));
const opened = await fan.observe();
const option = fan.requireUnique(
  opened.elements.filter(element => {
    const role = String(
      element.role || element.attributes?.role || ""
    ).toLowerCase();
    const tag = String(element.tag || "").toLowerCase();
    const optionLike = ["option", "menuitem"].includes(role) ||
      ["li", "button", "div"].includes(tag);
    return optionLike &&
      label(element) === "California";
  }),
  "Open dropdown option must be unique"
);
await fan.click(option);
return {selected: "California"};
```

Pass the fresh element object directly. Do not turn its index into
`fan.ref(...)`: `fan.ref(N)` belongs to the outer snapshot generation.

For a searchable combobox, open it, observe the fresh input, type the filter,
observe the filtered options, require one exact match, and click that element.
Do not press Enter when it might submit the surrounding form.

For a long or virtualized menu, scroll its current observed container with
`fan.scroll(container, {down: true, pages: 1})`, observe again, and match the
newly rendered option. An option cannot be addressed before it is rendered.

## Common Pitfalls

1. Reusing `fan.ref(N)` after navigation or a fresh observation.
2. Passing a bare number, CSS selector, or guessed locator to `fan.select`.
3. Selecting by partial text when several options can match.
4. Choosing the first candidate instead of calling `fan.requireUnique`.
5. Clicking a native option that has no numbered page element.
6. Pressing Enter inside a custom dropdown and submitting the form early.
7. Claiming success without checking the final snapshot or returned value.

## Verification Checklist

- [ ] The trigger came from the current numbered snapshot.
- [ ] The option label or value was exact and unique.
- [ ] Known controls stayed in one `browser_run`.
- [ ] Newly revealed options came from a fresh `fan.observe()`.
- [ ] The final state confirms the selected value or resulting page effect.
