import { Plus } from 'lucide-react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

interface NewSessionEmptyProps {
  onNewSession: () => void
}

// Empty first-entry state (spec §7): shown on the index route when no session
// is active. The whole main surface is a single centered "New Session Tile" —
// clicking it starts a fresh draft (the same action the titlebar New uses),
// which lands on the default browser+chat workbench.
export function NewSessionEmpty({ onNewSession }: NewSessionEmptyProps) {
  const { t } = useI18n()

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center pt-(--titlebar-height)">
      <button
        aria-label={t('新建会话')}
        className={cn(
          // 400×250 frosted tile, radius 18, translucent white fill + 1.2px
          // near-white stroke + backdrop blur, soft drop shadow with a hairline
          // top highlight. Hover lifts and brightens it.
          'group grid h-[250px] w-[400px] place-items-center rounded-[18px]',
          'border-[1.2px] border-[#FFFFFFF2] bg-[#FFFFFF66] backdrop-blur-[24px]',
          'shadow-[0_20px_48px_-12px_#22325C2E,inset_0_1.4px_0_#FFFFFFE6]',
          'transition-all duration-200 ease-out',
          'hover:-translate-y-0.5 hover:bg-[#FFFFFF80] hover:shadow-[0_28px_60px_-12px_#22325C3D,inset_0_1.4px_0_#FFFFFFF2]'
        )}
        onClick={onNewSession}
        type="button"
      >
        <Plus
          className="text-[#5C636E] transition-colors group-hover:text-[#3E4650]"
          size={44}
          strokeWidth={2}
        />
      </button>
    </div>
  )
}
