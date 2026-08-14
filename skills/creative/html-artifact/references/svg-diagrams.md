# SVG Diagrams

Author diagrams as inline `<svg>` so the artifact remains self-contained. Read
`concept-archetypes.md` for educational diagrams or `dark-tech.md` for software and
infrastructure diagrams.

## Markers, nodes, and edges

Define one arrow marker in `<defs>` and inherit the line color:

```xml
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M2 1 L8 5 L2 9" fill="none" stroke="context-stroke"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
```

Group each node's shape and labels:

```xml
<g class="node">
  <rect x="100" y="20" width="180" height="44" rx="8"/>
  <text class="th" x="190" y="42" text-anchor="middle"
        dominant-baseline="central">Service</text>
</g>
```

```css
.node rect { fill: var(--white); stroke: var(--gray-300); stroke-width: 1.5; }
.node.hot rect { fill: rgba(217,119,87,.10); stroke: var(--clay); }
.node.ok rect  { fill: rgba(120,140,93,.12); stroke: var(--olive); }
.node.bad rect { fill: rgba(176,74,63,.10); stroke: var(--rust); }
.edge { stroke: var(--gray-500); stroke-width: 1.5; fill: none;
        marker-end: url(#arrow); }
.edge.yes { stroke: var(--olive); }
.edge.no { stroke: var(--rust); stroke-dasharray: 4 4; }
text { pointer-events: none; }
```

Use a path diamond for a decision gate:

```xml
<path class="gate" d="M310 262 L352 294 L310 326 L268 294 Z"/>
<text x="310" y="294" text-anchor="middle"
      dominant-baseline="central">valid?</text>
```

Draw edges before nodes so node fills cover connector ends. Label meaningful
branches with small mono text near their midpoint.

## Coordinate discipline

- Use `viewBox="0 0 W H"`; set `H` to the last element plus at least 40px.
- Put nodes on regular lanes and ranks. Reuse lane coordinates so straight edges
  remain straight.
- Leave at least 60px between boxes and 10px between arrowheads and target boxes.
- Fit text before placing a node: at 14px medium text, allow about 8px per character
  plus 48px horizontal padding.
- Wrap wide diagrams in an overflow container and give the SVG a sensible
  `min-width` rather than squeezing it unreadably on small screens.
- Reinspect the rendered pixels after every coordinate change.

## Optional interaction

Keep the full diagram understandable without JavaScript. For a clickable detail
panel, assign each node a `data-key`, update the panel with DOM APIs, and mark a
default-active node in the original HTML so the panel is never empty.

When exporting SVG separately, include its styles, markers, background, and literal
colors inside the SVG; CSS variables from the host page will not follow it.

