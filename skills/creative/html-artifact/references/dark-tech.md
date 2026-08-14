# Dark-Tech Diagram Variant

Use this dark variant for cloud, software, and system architecture. Read
`svg-diagrams.md` for markers, node groups, and coordinate discipline. Use
`concept-archetypes.md` for educational or physical subjects.

## Surface

```css
body {
  background: #020617;
  color: #e2e8f0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.diagram-card {
  background: #0b1220;
  border: 1px solid #1e293b;
  border-radius: 14px;
  padding: 20px;
}
```

Use the optional inline SVG grid from `templates/diagram.html`. Do not load a web
font or any other remote asset.

## Semantic component palette

| Component | Fill | Stroke |
|---|---|---|
| Frontend | `rgba(8,51,68,.4)` | `#22d3ee` |
| Backend | `rgba(6,78,59,.4)` | `#34d399` |
| Database | `rgba(76,29,149,.4)` | `#a78bfa` |
| Cloud | `rgba(120,53,15,.3)` | `#fbbf24` |
| Security | `rgba(136,19,55,.4)` | `#fb7185` |
| Message bus | `rgba(251,146,60,.3)` | `#fb923c` |
| External | `rgba(30,41,59,.5)` | `#94a3b8` |

Use 12px names, 9px sublabels, and 8px annotations. Avoid neon decoration that
does not communicate category or state.

## Rendering

Translucent fills reveal connectors beneath them. Put an opaque backing rectangle
behind each styled component rectangle:

```xml
<rect x="100" y="80" width="160" height="60" rx="6" fill="#0f172a"/>
<rect x="100" y="80" width="160" height="60" rx="6"
      fill="rgba(6,78,59,.4)" stroke="#34d399" stroke-width="1.5"/>
<text x="180" y="114" text-anchor="middle" fill="#e2e8f0"
      font-size="12">API server</text>
```

- Draw connectors before component groups.
- Use dashed rose lines for security flows and boundaries.
- Use larger dashed amber boundaries for regions.
- Put message buses in clear gaps between services.
- Place the legend outside every boundary with at least 20px clearance.
- Keep standard services around 60px high and leave at least 40px between rows.

