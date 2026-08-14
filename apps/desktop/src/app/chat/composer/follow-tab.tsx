import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import { $activeBrowserControl } from '@/store/browser-control'
import { $controlRequest, $verificationRequest } from '@/store/prompts'

import { TabFavicon } from '../tab-favicon'

// "Follow Tab" (Pencil xmyPZ): a glassy strip docked on top of the composer that
// mirrors the embedded browser's active tab. The iridescent teal→purple→blue
// background flows left→right on a slow loop (.follow-tab-flow); a top white sheen
// + a faint grain give the frosted "friction" texture; the identity pill is real
// frosted glass (backdrop-blur over the moving gradient). It follows ANY active
// change (user- or agent-initiated) via the active browser-control projection.
//
// The strip is only a normal-operation cue. When the agent needs a human answer
// (browser takeover or verification), BrowserPausePrompt becomes the visible
// in-composer conversation instead; keeping the strip out avoids stacked status
// chrome competing with that question.
export function FollowTab() {
  const { t } = useI18n()
  const activeControl = useStore($activeBrowserControl)
  const controlRequest = useStore($controlRequest)
  const verification = useStore($verificationRequest)
  const identity = activeControl?.identity

  // A human-interaction request is rendered as a conversational card inside the
  // composer, so the regular moving status strip stays out of that state.
  if (!activeControl || !identity || controlRequest || verification) {
    return null
  }

  const label = t('跟随中')
  const title = identity.title || t('新标签页')

  return (
    // Full-bleed to the composer width (no px), no z-index: as an earlier sibling the
    // strip paints BEHIND the composer surface, which tucks its square bottom edge
    // under the dialog (the dialog sits in front, per the design). Height 48 with the
    // bottom ~12 hidden behind the composer leaves a ~36px visible band whose rounded
    // top corners (design shape is [12,12,0,0]; 14px here) read clearly.
    <div className="relative -mb-3">
      {/* Each layer carries its OWN rounded-top so the corners survive even when a
          descendant backdrop-filter defeats the ancestor's overflow+radius clip (a
          known Chromium quirk). */}
      <div className="relative h-12 overflow-hidden rounded-t-[14px] border border-b-0 border-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
        {/* iridescent base — matches the design (xmyPZ) at rest, static */}
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-t-[14px] follow-tab-grad" />
        {/* The moving gradient only exists while the agent is actively browsing,
            so it reads as work in progress rather than always-on chrome. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-t-[14px] follow-tab-flow" />
        {/* top white sheen — the glass highlight that fades downward */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-t-[14px]"
          style={{
            backgroundImage:
              'linear-gradient(180deg, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.10) 42%, rgba(255,255,255,0) 75%)'
          }}
        />
        {/* frosted friction grain */}
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-t-[14px] follow-tab-grain" />

        {/* content lives in the top ~36px; the strip's bottom ~12px is the seam that
            tucks under the composer (design padding [0,12,12,12]) */}
        <div className="relative z-10 flex h-9 items-center gap-2 px-3">
          {/* Keep the browser identity and its live state in one pill. This makes
              the strip read as context, rather than a title competing with a
              separate status control at the opposite edge. */}
          <div className="flex min-w-0 max-w-[min(100%,22rem)] items-center gap-2 rounded-full border border-white/45 bg-white/15 py-1 pl-1.5 pr-2.5 backdrop-blur-md">
            {/* Use the same authoritative-candidate, hidden-until-decoded
                favicon lifecycle as every other tab surface. */}
            <TabFavicon
              faviconPending={identity.faviconPending}
              loadFailed={identity.loadFailed}
              size="follow"
              src={identity.favicon}
              url={identity.url}
            />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold leading-none text-white">{title}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold leading-none text-white">
              <span className="flex size-4 items-center justify-center rounded-full border border-white/40 bg-white/20">
                <span className="size-1.5 animate-pulse rounded-full" style={{ backgroundColor: '#3FE0A0' }} />
              </span>
              {label}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
