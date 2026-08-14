# Fidelity and Safe Preview

Match effort to intent, then inspect the rendered artifact through Fan's existing
preview surfaces.

## Fidelity

For a quick direction check, use realistic sample content, the house tokens, and one
or two meaningful interactions. Prefer several clearly different variants over one
over-polished option.

For a deliverable that will be shared, use careful spacing, a complete information
hierarchy, responsive behavior, graceful degradation, and a full visual pass.

When the user's intent is unclear and the effort difference is material, ask whether
they want a quick exploration or a polished deliverable.

## Comparing variants

Put three to six genuinely different variants in one file. Use one of these shapes:

- Equal tradeoff columns with a sample, consistent metrics, and one recommendation.
- Live artboards on a shared surface with a light/dark toggle.
- A control bar that updates a matrix of component variants using CSS variables.

Vary layout, density, interaction, or information priority—not just color.

## Preview safely in Fan

1. Write the file inside the approved workspace or session artifact directory.
2. Open the absolute path through Fan's desktop preview/artifacts surface first.
3. If a direct local target is needed, use a controlled `file://` URL. If the page
   genuinely requires HTTP semantics, use Fan's existing preview/static-server
   mechanism bound to loopback and scoped to the artifact directory.
4. Never serve the workspace root, bind a public interface, or download runtime
   examples and assets.
5. Inspect the intended desktop width and a narrow width. Check clipping, overflow,
   focus visibility, contrast, and unreadable density.
6. For SVG, also check text fit, connector endpoints, overlaps, viewBox height, and
   legend clearance. Recompute coordinates and preview again after changes.

Markup validity is not proof of a good artifact; inspect rendered pixels before
handoff.

## Graceful degradation

If the artifact uses JavaScript, keep the primary prose and diagram in HTML/SVG.
Use native `<details>` for collapsible material, render a default tab or node in the
original markup, and ensure the page is not blank when scripts fail.

