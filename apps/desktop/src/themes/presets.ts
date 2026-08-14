/**
 * Built-in desktop theme. The app ships a single skin — "badwork" glass — in
 * two modes (light / dark). Older multi-skin presets (nous/midnight/ember/mono/
 * cyberpunk/slate) were removed; only the light/dark mode toggle remains.
 *
 * Light = the bwa glass redesign (frosted white panels, blue #2D6BF0 accent).
 * Dark  = a hand-derived dark glass variant of the same language.
 */

import type { DesktopTheme, DesktopThemeTypography } from './types'

// Apple typography (scraped from apple.com.cn 2026-06): the zh-CN body stack
// is "SF Pro SC, SF Pro Text, SF Pro Icons, PingFang SC, Helvetica Neue,
// Helvetica, Arial". We keep that order verbatim, inserting -apple-system /
// BlinkMacSystemFont before the Helvetica fallbacks so macOS renders real
// San Francisco without bundling the (Apple-platform-licensed) SF webfonts.
// On Windows, Latin falls to Arial and CJK to the system font via fallback —
// the same degradation apple.com.cn itself has there.
// Non-Apple hosts fall through to the bundled OFL lookalikes (loaded in
// styles.css via @fontsource-variable): Inter ≈ SF Pro, Noto Sans SC ≈
// PingFang SC, JetBrains Mono ≈ SF Mono. ui-monospace resolves to SF Mono
// on macOS and falls through elsewhere.
const BWA_SANS =
  '"SF Pro SC", "SF Pro Text", "SF Pro Display", "SF Pro Icons", "PingFang SC", -apple-system, BlinkMacSystemFont, "Inter Variable", "Noto Sans SC Variable", "Helvetica Neue", Helvetica, Arial, sans-serif'
// SF Mono first (Apple-typography decision; macOS only), then the BUNDLED
// JetBrains Mono — the bwa spec's mono. ui-monospace must come AFTER it: on
// Windows it resolves to Cascadia Mono/Consolas and was silently winning, so
// every mono surface (kbd chips, counts, group labels) missed the spec face.
const BWA_MONO =
  '"SF Mono", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Monaco, "Cascadia Code", Consolas, monospace'

export const DEFAULT_TYPOGRAPHY: DesktopThemeTypography = { fontSans: BWA_SANS, fontMono: BWA_MONO }

const BWA_PRIMARY = '#2D6BF0'

/**
 * badwork — the only desktop skin. bwa light glass + derived dark glass.
 * The exact bwa neutrals (#E5E8EC border, #F2F4F6 surface-2, #5C636E/#8A919E
 * text) are pinned in styles.css `:root`; the seeds here drive the color-mix
 * chain and the light/dark switch.
 */
export const badworkGlassTheme: DesktopTheme = {
  name: 'badwork',
  label: 'Badwork',
  description: 'Frosted glass with blue accents',
  colors: {
    background: '#EFF3FB',
    foreground: '#1A1D21',
    card: '#FFFFFF',
    cardForeground: '#1A1D21',
    muted: '#F2F4F6',
    mutedForeground: '#8A919E',
    popover: '#FFFFFF',
    popoverForeground: '#1A1D21',
    primary: BWA_PRIMARY,
    primaryForeground: '#FFFFFF',
    secondary: '#F2F4F6',
    secondaryForeground: '#5C636E',
    accent: '#EAF1FE',
    accentForeground: '#2D6BF0',
    border: '#E5E8EC',
    input: '#E5E8EC',
    ring: BWA_PRIMARY,
    midground: BWA_PRIMARY,
    composerRing: BWA_PRIMARY,
    destructive: '#E0474C',
    destructiveForeground: '#FFFFFF',
    sidebarBackground: '#F4F7FC',
    sidebarBorder: '#E5E8EC',
    userBubble: BWA_PRIMARY,
    userBubbleBorder: '#2D6BF0'
  },
  darkColors: {
    background: '#0E1420',
    foreground: '#E8ECF2',
    card: '#161C28',
    cardForeground: '#E8ECF2',
    muted: '#1C2330',
    mutedForeground: '#8A93A3',
    popover: '#161C28',
    popoverForeground: '#E8ECF2',
    primary: '#5B8DEF',
    primaryForeground: '#0B1018',
    secondary: '#1C2330',
    secondaryForeground: '#C2C9D6',
    accent: '#1B2740',
    accentForeground: '#AFC5F2',
    border: '#FFFFFF1A',
    input: '#FFFFFF1A',
    ring: '#5B8DEF',
    midground: '#5B8DEF',
    composerRing: '#5B8DEF',
    destructive: '#F0666B',
    destructiveForeground: '#FFFFFF',
    sidebarBackground: '#121826',
    sidebarBorder: '#FFFFFF14',
    userBubble: '#2D6BF0',
    userBubbleBorder: '#FFFFFF1A'
  },
  typography: {
    fontSans: BWA_SANS,
    fontMono: BWA_MONO
  }
}

export const BUILTIN_THEMES: Record<string, DesktopTheme> = {
  badwork: badworkGlassTheme
}

export const BUILTIN_THEME_LIST = Object.values(BUILTIN_THEMES)

/** Skin used when nothing is persisted or the persisted name is retired. */
export const DEFAULT_SKIN_NAME = 'badwork'
