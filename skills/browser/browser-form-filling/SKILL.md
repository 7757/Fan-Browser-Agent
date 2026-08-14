---
name: browser-form-filling
description: "Use when filling a multi-field form in the embedded browser. Fill text fields atomically with browser_fill_form, never press Enter per field, submit once, and verify from returned readbacks and DOM."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, forms, input, eb-type, react, vue, validation]
    related_skills: [browser-dropdown-selection, browser-file-upload, browser-element-inspection, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser Form Filling

## Overview

Filling a form reliably is mostly about sequencing and verification, not about any single clever action. `browser_fill_form` resolves all text fields from one snapshot, focuses and clears each target, verifies local readback, and returns one final DOM. The mistakes that waste turns are: separate focus/type/observe calls per field, pressing Enter after every field, and submitting before async validation finished.

Treat a form as one transaction: observe once, pass all text fields to `browser_fill_form`, handle special controls, then submit exactly once and confirm the result.

## When to Use

- Filling login, signup, checkout, search, contact, or any multi-input form.
- Re-entering a field whose value did not persist (React/Vue controlled inputs).
- Don't use for: dropdown selection (use `browser-dropdown-selection`), file inputs (use `browser-file-upload`).

## Core Recipe

1. **Observe once.** `browser_observe` to get the indices of every input/textarea you need.
2. **Fill all text fields once.** Call `browser_fill_form(fields=[...])`. The runtime resolves every index from one snapshot, fills and verifies each field locally, then returns one final observation.
   - Do **not** pass Enter and do **not** call `browser_send_keys("Enter")` between fields.
3. **Handle special controls** with their own tools: `browser_select` / open-and-click for dropdowns, `browser_upload` for file inputs, `browser_click` for checkboxes and radios.
4. **Read the transaction result.** Check `status`, `completedCount`, and each field's `readback`. Only inspect a field separately when the transaction reports a mismatch or the control has custom behavior.
5. **Submit once on the next model turn.** `browser_fill_form` returns the final DOM snapshot; choose the submit control from that refreshed snapshot and click it once. Only use `browser_send_keys("Enter")` when a single text field is explicitly designed for Enter submission.
6. **Confirm from the click result.** The submit action returns a fresh DOM. Look there for a success state, redirect, or inline validation errors. Use `browser_settle` followed by `browser_observe` only when the result is genuinely delayed.

## Framework-Bound Inputs (React / Vue / Angular)

Controlled inputs re-render from state. A naive value assignment can be discarded on the next render, leaving the field visually empty or reverted. `browser_type` defaults to **human** typing mode, which dispatches real key events and fires the `input`/`change` handlers frameworks listen for — this is the correct default for controlled inputs.

If a value does not persist:

- Re-run `browser_fill_form` for only the failed field with `typing_mode="human"` explicitly.
- If the field is an autocomplete/combobox, keep `autocomplete_wait=true` (default) so the suggestion list settles; raise `autocomplete_wait_ms` if it's slow.
- Only use `typing_mode="direct"` for special browser controls (e.g. date/color pickers) that reject synthetic keystrokes — it assigns the value directly and may skip some handlers.
- After typing into a field that triggers async state, give it a beat: `browser_settle` (waits for DOM readiness + network idle) before reading the value back.

## Verifying a Value Landed

Use the `fields[].readback` returned by `browser_fill_form` first. That check happens inside the same runtime transaction and costs no additional model tool call.

For a custom control or a reported mismatch, inspect the value explicitly:

```
browser_element(index=N, operation="attribute", name="value")
```

or read it live:

```
browser_element(index=N, operation="evaluate", expression="() => this.value")
```

If the returned value is empty or wrong, re-type that one field. Retry at most 2-3 times; if it still won't stick, the field may be disabled, masked, or gated by an earlier required field — re-observe and check.

## Submit Once, Then Confirm

- Click the actual submit control once. Do not double-click or re-submit "to be safe" — that can create duplicate records.
- Read the fresh DOM returned by the submit action. If the backend response is still pending, call `browser_settle` and then `browser_observe` once. Look for a success message, URL change, or validation errors.
- If validation errors appear, fix only the flagged fields and submit again. Don't refill the whole form.

## Common Pitfalls

1. **Pressing Enter after each field.** Submits the form early or triggers per-field validation that blocks the rest. Type all fields first; submit once at the end.

2. **Ignoring transaction readback.** Controlled inputs can revert. Check `browser_fill_form` field results; use `browser_element` only for a mismatch or custom control.

3. **Re-observing and reusing old indices.** If the page re-rendered (validation appeared, a section expanded), indices may have shifted. Use indices only from the latest observation.

4. **Submitting before async work finishes.** Autocomplete, availability checks, and debounced validation need a moment. `browser_settle` before submit when the form does background work.

5. **Manually clicking/focusing before every `browser_type`.** Unnecessary — `browser_type` focuses for you. Extra clicks can close popovers or open the wrong control.

6. **Leaving `clear` unset when appending.** `browser_type` clears by default. To append to existing content, pass `clear=false`.

7. **Double-submitting.** Re-clicking submit after a slow response can create duplicates. Wait and confirm instead.

## Verification Checklist

- [ ] Observed once and captured all field indices up front
- [ ] Filled all text fields in one `browser_fill_form` call with no per-field Enter
- [ ] Dropdowns/uploads/checkboxes handled with their proper tools
- [ ] Checked `browser_fill_form` status and field readbacks (inspected only mismatches separately)
- [ ] `browser_settle` after fields that trigger async validation
- [ ] Submitted exactly once and used its returned DOM to confirm success or read validation errors
