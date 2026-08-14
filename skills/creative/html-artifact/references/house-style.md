# House Style

Use one design system for every artifact. Reuse these tokens instead of inventing a
palette per file.

## Canonical tokens

```css
:root {
  --ivory:    #FAF9F5;
  --white:    #FFFFFF;
  --slate:    #141413;
  --clay:     #D97757;
  --olive:    #788C5D;
  --rust:     #B04A3F;
  --oat:      #E3DACC;
  --gray-150: #F0EEE6;
  --gray-300: #D1CFC5;
  --gray-500: #87867F;
  --gray-700: #3D3D3A;
  --border:        1.5px solid var(--gray-300);
  --radius-panel:  12px;
  --radius-row:    8px;
  --radius-pill:   999px;
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans:  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:  ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

Color carries consistent meaning: clay is focus, olive is success or addition,
rust is failure or removal, oat is neutral emphasis, and gray-500 is secondary
information. Use two or three accents, not a rainbow.

## Typography

- Use serif for headings and display numbers, sans for body text, and mono for
  labels, code, paths, timestamps, metrics, pills, and eyebrows.
- Keep body line-height between `1.55` and `1.65`.
- Use medium serif headings rather than heavy bold display text.

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  background: var(--ivory);
  color: var(--gray-700);
  font-family: var(--sans);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  padding: 56px 24px 120px;
}
.page { max-width: 860px; margin: 0 auto; }
.eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--gray-500);
}
h1, h2, h3 {
  font-family: var(--serif);
  font-weight: 500;
  letter-spacing: -.01em;
}
```

Use an 820–860px page for reports, 1040–1120px for dense two-column documents,
and about 780px for focused diagram cards.

## Core patterns

```css
.card {
  background: var(--white);
  border: var(--border);
  border-radius: var(--radius-panel);
  padding: 20px;
}
.card.warn { border-left: 4px solid var(--clay); }
.callout {
  background: rgba(217,119,87,.06);
  border-left: 3px solid var(--clay);
  border-radius: var(--radius-row);
  padding: 14px 16px;
}
.pill {
  border-radius: var(--radius-pill);
  padding: 2px 10px;
  font-family: var(--mono);
  font-size: 11px;
  background: var(--oat);
}
```

Use CSS Grid for page structure and Flexbox for alignment. Apply
`minmax(0, 1fr)` to flexible grid columns to prevent overflow. Collapse multi-column
layouts at a single meaningful breakpoint.

Use a real `<table>` for tabular data. Give headers a gray-150 background, small
uppercase mono labels, and rows hairline separators. Use a grid of rich cells only
when the content must restack responsively.

## Code and diffs

```css
.code {
  background: var(--slate);
  color: #E8E6DF;
  border-radius: var(--radius-panel);
  padding: 16px 18px;
  font-family: var(--mono);
  font-size: 13px;
  overflow-x: auto;
}
.code .kw  { color: var(--clay); }
.code .str { color: var(--olive); }
.code .cm  { color: var(--gray-500); }
.code .fn  { color: #C9B98A; }
.diff-row {
  display: grid;
  grid-template-columns: 48px 18px 1fr;
  white-space: pre;
  font-family: var(--mono);
  font-size: 12.5px;
}
.diff-row.add { background: rgba(120,140,93,.15); }
.diff-row.del { background: rgba(176,74,63,.15); }
```

Do not load a syntax-highlighting library. Wrap important tokens in semantic spans.

## Rhythm

Use section gaps around 52–64px and element gaps from an 8, 12, 14, 18, 22px
scale. Draw simple decoration with CSS or inline SVG instead of importing icons.

