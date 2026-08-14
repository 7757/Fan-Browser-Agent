---
name: html-artifact
description: Create a self-contained HTML artifact when the user explicitly asks for an HTML file, visual or interactive report, or interactive prototype, or when a complex relationship materially needs visualization. Do not trigger for ordinary explanations, plans, reviews, reports, or simple mappings that prose, Markdown, or a small table can express clearly.
---

# HTML Artifact

Produce one self-contained `.html` file for a visual report, explorable prototype,
comparison surface, or complex diagram. Keep the artifact readable offline and easy
to open in Fan.

## Choose a mode

- **Report or explainer:** use `templates/base.html`.
- **Complex relationship or diagram:** use `templates/diagram.html`.
- **Interactive prototype or editor:** use `templates/editor.html`.
- **Variants:** use the base template and place meaningfully different options in
  one comparison surface.

If a short response, Markdown document, or table communicates the result just as
well, do not create an HTML artifact.

## Load only what the task needs

- Always read `references/house-style.md` before authoring.
- Read `references/svg-diagrams.md` for flows, architecture, or concept diagrams.
- Read `references/concept-archetypes.md` for educational or physical diagrams.
- Read `references/dark-tech.md` only for software and infrastructure diagrams.
- Read `references/throwaway-editors.md` for controls that export user choices.
- Read `references/fidelity-and-verify.md` to match polish to intent and preview the
  rendered result safely.

References are one level below this file. Do not look for or download external
examples.

## Workflow

1. Pick one mode and the closest bundled template.
2. Write the artifact to a user-approved workspace or session artifact path. Keep
   the absolute path for preview and handoff.
3. Adapt the template to the content. Put real, useful content in the HTML; use
   JavaScript only as a progressive enhancement.
4. Keep all CSS, SVG, and JavaScript inline. Use system fonts. Do not use CDNs,
   remote images, external scripts, runtime `fetch`, or clone/pull/install steps.
5. For dynamic text, prefer `textContent` and DOM construction over `innerHTML`.
   Never embed secrets, credentials, arbitrary local files, or unsanitized user
   content in markup or script.
6. Preview through Fan's desktop preview/artifacts surface first. Return or expose
   the absolute `.html` path so Fan can recognize it. For a direct local preview,
   use a controlled `file://` path. If browser security requires HTTP, use Fan's
   existing controlled preview/static-server flow, bind only to loopback, and serve
   only the artifact directory; never expose the workspace root or a public port.
7. Inspect the rendered artifact at its intended window sizes. Fix overflow,
   clipping, contrast, and SVG placement before handing it off.
8. Report the absolute path and briefly name any interactive controls or export.

## Output constraints

- One HTML file; no build step or runtime dependency.
- One `<style>` in `<head>` and, only when needed, one small vanilla script before
  `</body>`.
- Prefer semantic HTML and native controls. The primary content must remain useful
  with JavaScript disabled.
- Use inline SVG or CSS for graphics. Do not use Mermaid, D3, web fonts, or remote
  assets.
- Make layouts responsive and keyboard-usable. Preserve visible focus states and
  adequate contrast.
- Interactive editors should end with an explicit export or copy action unless the
  interaction itself is the requested deliverable.

