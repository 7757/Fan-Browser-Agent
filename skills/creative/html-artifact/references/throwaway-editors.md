# Interactive Editors

Use a single-file HTML editor for one narrow task, ending with an export action that
serializes the user's choices. A feel-test prototype may omit export when the
interaction itself is the requested result.

## Structure

Use the sequence state → render → controls → export → feedback. Keep a stable initial
state so reset and diff export are deterministic.

```js
const INITIAL = [/* task data */];
let state = structuredClone(INITIAL);

function render() {
  // Build or update controls from state with DOM APIs.
}

function serialize(current) {
  // Return Markdown, JSON, a diff, or plain text.
}

copyBtn.addEventListener('click', () => {
  writeClipboard(serialize(state)).then(showCopied, showCopied);
});
resetBtn.addEventListener('click', () => {
  state = structuredClone(INITIAL);
  render();
});
render();
```

Use `textContent`, `createElement`, and explicit attributes for dynamic content.
Do not insert untrusted values with `innerHTML`.

## Clipboard export on a controlled local file

The asynchronous clipboard API may be unavailable for a `file://` page. Use a
user-gesture handler and a temporary off-screen textarea as a fallback:

```js
function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
  return Promise.resolve();
}
```

Always remove the temporary node and normalize the return value to a Promise. Show
brief visible feedback after export.

## Pick an export format

- Markdown for human review or an issue/PR description.
- JSON for machine-readable configuration.
- A minimal `-`/`+` diff when only changes matter.
- Plain text for prompts, templates, and snippets.

Recompute counts and derived values at export time. Use native controls whenever
possible; keep keyboard focus visible and labels connected to inputs.

