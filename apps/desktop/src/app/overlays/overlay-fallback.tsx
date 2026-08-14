import { PageLoader } from '@/components/page-loader'

// Suspense fallback for the lazy overlay routes (settings / agents / cron):
// the same backdrop + glass card OverlayView renders, with the
// shared PageLoader inside. A cold chunk load then reads as "the overlay is
// opening" instead of a blank gap. With idle preloading this rarely shows.
export function OverlayFallback() {
  return (
    <div className="lg-scrim fixed inset-0 z-50 p-[2.5%]" role="presentation">
      <div className="glass-panel app-bloom-bg relative flex h-full min-h-0 flex-col overflow-hidden">
        <PageLoader aria-label="正在打开" />
      </div>
    </div>
  )
}
