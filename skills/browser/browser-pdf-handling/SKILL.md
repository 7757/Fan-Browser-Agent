---
name: browser-pdf-handling
description: "Use when a page is or links to a PDF. Recover the real source URL when the browser shows Chrome's PDF viewer, navigate to or download the PDF, and use browser_save_pdf to render the current page (HTML or PDF) to a PDF file."
version: 1.0.0
author: Fan Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  fan:
    tags: [browser, pdf, download, save-pdf, viewer, extraction]
    related_skills: [browser-file-upload, browser-element-inspection, fan-agent]
    fallback_for_toolsets: [browser_program]
---

# Browser PDF Handling

## Overview

PDFs show up in three situations and each needs a different move:

1. **You navigated to a `.pdf` URL** — the browser may render it in Chrome's built-in PDF viewer, which is a special internal page, not normal HTML. Indexed DOM observation is mostly empty; the real content is the PDF bytes.
2. **A link/button downloads a PDF** — clicking it produces a file in the downloads directory rather than a navigable page.
3. **You want to capture the current page as a PDF** — `browser_save_pdf` renders whatever is currently displayed (an HTML page, or the viewer) to a PDF file via CDP `Page.printToPDF`.

The recurring trap is the Chrome viewer: `browser_observe` returns almost nothing, so it looks like a blank page. The fix is to recover the underlying source URL and treat the PDF as a document, not as a DOM to click around in.

## When to Use

- The page is a PDF (Chrome viewer) and observation looks empty.
- You need to download or save a linked PDF.
- You want a PDF copy of the current page for the user or for later extraction.
- Don't use for: reading normal HTML article text — use `browser_page_content` instead.

## Recognizing the Chrome PDF Viewer

Signals: the URL ends in `.pdf` (or returns `content-type: application/pdf`), the page title is the filename, and `browser_observe` shows little to no interactive content. Don't try to click your way through the viewer's toolbar — recover the source URL instead.

Recover the real PDF URL:

```
browser_evaluate(expression="() => location.href")
```

If the viewer wraps the source (some embeds use `.../pdf-viewer?file=<encoded-url>`), the actual document is the `file=` parameter — decode it. Once you have the direct `.pdf` URL you can navigate to it, download it, or hand it to a fetch/file tool for text extraction.

## Saving / Downloading a PDF

**Capture the current page as a PDF** (works for both HTML pages and the open PDF viewer):

```
browser_save_pdf(file_name="report.pdf", paper_format="A4", print_background=true)
```

- Output lands in the Electron downloads directory; the result reports the saved path.
- `landscape`, `scale` (0.1–2.0), and `paper_format` (Letter/Legal/A4/A3/Tabloid) control layout.
- For long pages, default settings paginate automatically — no need to scroll first.

**A link that triggers a download:** click it (`browser_click`) and the runtime saves the file to the downloads directory; confirm via `browser_events` if you need to see the download event. If you have the direct URL, navigating to it or saving it through a fetch/file tool (when available) is more deterministic than clicking.

## Extracting Text From a PDF

The Chrome viewer's text is not in the indexed DOM. To get the content:

- Recover the direct `.pdf` URL (above) and pass it to a fetch/file/extraction tool when one is enabled, or
- `browser_save_pdf` to write the file locally, then extract from the saved file with a file/terminal tool.
- Do **not** rely on `browser_page_content` or `browser_observe` to read PDF body text — they read the HTML DOM, which the viewer doesn't expose.

## Common Pitfalls

1. **Treating the viewer as a normal page.** Empty observation ≠ blank page. Recognize the viewer (URL `.pdf`, filename title) and recover the source URL.

2. **Clicking the viewer toolbar to "download".** Unreliable. Use `browser_save_pdf` to capture, or navigate to the direct URL.

3. **Trying to read PDF text via `browser_page_content`/`browser_observe`.** Those read the HTML DOM. Get the bytes (direct URL or `browser_save_pdf`) and extract from the file.

4. **Losing the source URL inside a wrapper viewer.** Decode the `file=`/`url=` query parameter to find the real document.

5. **Assuming `browser_save_pdf` returns the bytes.** It writes a file and returns the path. Read the path from the result; don't expect inline content.

6. **Scrolling a long PDF before saving.** `browser_save_pdf` renders the whole document regardless of scroll position; scrolling is unnecessary.

## Verification Checklist

- [ ] Detected the Chrome viewer (URL `.pdf` / filename title / empty observation) before acting
- [ ] Recovered the direct `.pdf` source URL via `browser_evaluate(() => location.href)` (decoded any `file=` wrapper)
- [ ] For a page capture: `browser_save_pdf` with appropriate `paper_format`/`print_background`, read the saved path from the result
- [ ] For text extraction: used the direct URL or saved file with a fetch/file tool, not `browser_page_content`
- [ ] Confirmed the download/save actually produced a file (result path or `browser_events`)
