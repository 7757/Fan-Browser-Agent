// Responsive horizontal gutter for primary content bodies (settings right side,
// skills, artifacts, command center / sessions). Ratio-based so it scales with
// the window, but clamped so it never collapses on narrow widths or runs away
// on ultrawide displays. Headers/tabs intentionally keep their own tighter
// padding.
//
// NOTE: these must stay literal strings — Tailwind's scanner only picks up
// complete class names, so do not build them via template interpolation.
export const PAGE_INSET_X = 'px-[clamp(1.25rem,4vw,4rem)]'

