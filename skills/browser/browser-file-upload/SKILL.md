---
name: browser-file-upload
description: "Use when uploading a local file through a web form. browser_upload targets a file <input> by its latest observed index; locate hidden inputs with browser_find_elements/browser_scroll/browser_search_page, validate the local path exists, and re-observe to confirm the attachment."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, upload, file-input, eb-upload, forms, find-elements]
    related_skills: [browser-form-filling, browser-element-inspection, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser File Upload

## Overview

`browser_upload` attaches one or more local files to an `<input type="file">` element, addressed by the element's **index from the most recent observation**. It does not open the OS file picker and does not need a click on a styled "Browse" button — it sets the input's files directly, then re-observes.

The two things that go wrong: (1) the real file `<input>` is hidden behind a styled drop-zone or custom button, so it doesn't appear in the normal observation and you can't find its index; and (2) the local path is wrong or relative, so the runtime rejects it. This skill covers finding the hidden input and validating the path before calling `browser_upload`.

## When to Use

- Attaching a document, image, or other local file to a form field.
- A visible "Upload" / "Choose file" / drag-and-drop area whose underlying `<input>` index you need.
- Don't use for: typing text into fields (use `browser-form-filling`), or downloading/saving the page (use `browser-pdf-handling`).

## Core Recipe

1. **Find the file input's index.** `browser_observe` and look for an element with tag `input` and type `file`. Use that index.
2. **Validate the local path** (see below) — confirm the file exists before uploading.
3. **Upload.**
   - Single file: `browser_upload(index=N, path="C:/Users/me/docs/report.pdf")`
   - Multiple files: `browser_upload(index=N, files=["C:/a/one.png", "C:/a/two.png"])`
4. **Verify.** The tool re-observes after upload. Confirm a filename/thumbnail/"1 file selected" indicator appears near the control. If nothing changed, the index was wrong or the input rejected the file.

## Finding a Hidden File Input

Custom uploaders hide the real `<input type="file">` (it's `display:none` or zero-size) behind a visible drop-zone. The visible button is NOT the input. Strategies, in order:

1. **Query the DOM directly** — most reliable for hidden inputs:
   ```
   browser_find_elements(selector="input[type=file]", attributes=["name", "accept", "multiple"])
   ```
   This returns matching inputs even when they're not in the indexed/interactive set. Note the `accept` attribute — it tells you the allowed file types.
2. **Click the visible trigger, then re-observe.** Some uploaders only insert the `<input>` into the DOM after you click the "Add file" button. `browser_click` the visible control, then `browser_observe` and look for the new file input. (Clicking will not pop a native OS dialog you can interact with — but it may reveal the input.)
3. **Scroll it into view.** If the form is long, `browser_scroll` or `browser_search_page(pattern="upload")` / `browser_scroll_to_text(text="Upload")` to bring the area into the observation, then re-observe.

Once you have the input from `browser_find_elements`, you still need its **index** to call `browser_upload`. If the input is hidden and has no index, re-`browser_observe` after revealing it (step 2), or use the index of the file input row that does appear in the observation. The index, not the CSS selector, is what `browser_upload` consumes.

## Validating the Local Path

`browser_upload` needs a real local path the Electron runtime can read. Before uploading:

- Use an **absolute path** with forward slashes or escaped backslashes (Windows: `C:/Users/...` is safest).
- If a `file`/`terminal` tool is available, confirm the file exists first (e.g. list the directory) rather than guessing.
- Respect the input's `accept` attribute (from `browser_find_elements`): uploading a `.txt` to an `accept="image/*"` input will be rejected by the page even if `browser_upload` succeeds at the input level.
- If the user gave a filename but not a directory, ask where it lives instead of inventing a path.

## Common Pitfalls

1. **Targeting the visible button instead of the input.** The styled "Browse"/drop-zone is a `div`/`button`, not the `<input type="file">`. Find the real input with `browser_find_elements(selector="input[type=file]")`.

2. **Using a stale or guessed index.** `browser_upload` uses the latest observation's index. Re-observe after revealing a hidden input, and never reuse an index from before the page changed.

3. **Relative or wrong path.** Pass an absolute local path. Verify the file exists with a file/terminal tool when available; don't assume.

4. **Ignoring `accept`.** A type mismatch is rejected by the page's own validation. Check `accept` via `browser_find_elements` and match the file type.

5. **Expecting an OS file dialog.** There is none to drive — `browser_upload` sets the files programmatically. Don't wait for or try to click a native picker.

6. **Not verifying.** Always re-observe and confirm the filename/preview appears. A silent no-op means the wrong index or a rejected file.

## Verification Checklist

- [ ] Located the real `input[type=file]` (via `browser_observe` or `browser_find_elements`), not the styled button
- [ ] For hidden inputs: revealed via click/scroll, then re-observed to get a usable index
- [ ] Confirmed the local path is absolute and the file exists
- [ ] Checked the input's `accept` against the file type
- [ ] Called `browser_upload` with `path=` (single) or `files=` (multiple)
- [ ] Re-observed and confirmed the attachment indicator (filename/thumbnail/count) appeared
