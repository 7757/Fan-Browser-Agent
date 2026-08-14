# Concept Diagram Archetypes

Use this light, flat system for educational, scientific, physical, and non-software
subjects. Read `svg-diagrams.md` first for shared structure and coordinates.

## Visual rules

- Keep shapes flat: no gradients, glow, blur, or ornamental shadows.
- Show only relationships that help explain the subject.
- Use sentence case and at most two label sizes: 14px medium titles and 12px body
  labels.
- Use 0.5px node borders and `fill="none"` on connector paths.
- Encode category or meaning with color, not sequence. Use two or three ramps.

## Color ramps

The bundled diagram template defines these classes for light and dark system modes:

| Class | Typical role |
|---|---|
| `c-gray` | neutral structure, starts, ends, users |
| `c-purple` | one domain category |
| `c-teal` | one domain category or sink |
| `c-coral` | one domain category |
| `c-pink` | one domain category |
| `c-blue` | information |
| `c-green` | success or positive outcome |
| `c-amber` | warning or uncertainty |
| `c-red` | failure or error |

Use the same class for nodes of the same kind. Do not assign a new color to every
step.

## Layout constants

- Default to a `0 0 680 H` viewBox with a 40px side safe area.
- Use 44px high single-line nodes and 56px two-line nodes.
- Leave at least 60px between nodes.
- Use 24px horizontal and 12px vertical inner padding.
- Limit nested containers to two or three levels.

## Pick an archetype

- **Flowchart or process:** neutral start/end, one category for steps, red only for
  failure branches, and diamonds for decisions.
- **Pipeline:** sources on the left, processing stages in the middle, sinks on the
  right, aligned on a regular row.
- **Layered stack:** full-width stacked rectangles with side labels and leaders.
- **Tree or hierarchy:** centered root, children fanning down, one style per depth.
- **Quadrant:** two crossing axes, four labeled cells, and concise axis labels.
- **Before/after:** paired panels on one grid; rust for pain and olive for wins.
- **Timeline or sequence:** one rail with numbered or dated nodes; use lifelines and
  labeled horizontal messages for sequence diagrams.
- **Hub-spoke:** one center with spokes to subsystems; distinguish relationship
  types by line style.
- **Cross-section:** draw the physical outline with paths, fill meaningful regions,
  and label them with leaders.
- **Quantitative chart:** flat bars on a baseline, labeled axes, one ramp per
  series, no decorative 3D.

Use `dark-tech.md` instead when the subject is cloud infrastructure or software
architecture.

