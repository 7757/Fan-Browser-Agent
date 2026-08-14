import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { MonitorPlay } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { previewName } from '@/lib/preview-targets'
import { notifyError } from '@/store/notifications'
import {
  $previewTarget,
  dismissPreviewTarget,
  type PreviewRecordSource,
  setCurrentSessionPreviewTarget
} from '@/store/preview'
import { $currentCwd } from '@/store/session'

export function PreviewAttachment({ source = 'manual', target }: { source?: PreviewRecordSource; target: string }) {
  const cwd = useStore($currentCwd)
  const activePreview = useStore($previewTarget)
  const [opening, setOpening] = useState(false)
  const activePreviewRef = useRef(activePreview)
  const cwdRef = useRef(cwd)
  const mountedRef = useRef(false)
  const requestTokenRef = useRef(0)
  const targetRef = useRef(target)
  const name = previewName(target)
  const isActive = activePreview?.source === target

  activePreviewRef.current = activePreview
  cwdRef.current = cwd
  targetRef.current = target

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      requestTokenRef.current += 1
    }
  }, [])

  useEffect(() => {
    requestTokenRef.current += 1
    setOpening(false)
  }, [cwd, target])

  async function togglePreview() {
    if (opening) {
      return
    }

    if (isActive) {
      dismissPreviewTarget()

      return
    }

    const requestToken = ++requestTokenRef.current
    const requestTarget = target
    const requestCwd = cwd

    setOpening(true)

    try {
      const preview = await normalizeOrLocalPreviewTarget(requestTarget, requestCwd || undefined)

      if (
        !mountedRef.current ||
        requestTokenRef.current !== requestToken ||
        targetRef.current !== requestTarget ||
        cwdRef.current !== requestCwd
      ) {
        return
      }

      if (!preview) {
        throw new Error(`Could not open preview target: ${requestTarget}`)
      }

      const currentPreview = activePreviewRef.current

      if (currentPreview?.source === preview.source && currentPreview.url === preview.url) {
        return
      }

      setCurrentSessionPreviewTarget(preview, source, requestTarget)
    } catch (error) {
      if (
        !mountedRef.current ||
        requestTokenRef.current !== requestToken ||
        targetRef.current !== requestTarget ||
        cwdRef.current !== requestCwd
      ) {
        return
      }

      notifyError(error, '预览不可用')
    } finally {
      if (mountedRef.current && requestTokenRef.current === requestToken) {
        setOpening(false)
      }
    }
  }

  return (
    // Liquid Glass preview card — Pencil b8iff HAHyw material: glass card,
    // neutral 22px globe chip, 12.5/600 title + mono muted url, glass pill
    // action. (The live preview itself opens in the native view, so the card
    // stays a single-row affordance.)
    <div className="lg-card flex w-full max-w-160 flex-wrap items-center gap-2.5 px-3 py-2 text-sm">
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-[#22325C14] dark:bg-white/10">
        <MonitorPlay className="size-[13px] text-(--bwa-text-secondary)" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold leading-[1.15rem] text-(--bwa-text)">{name}</div>
        <div className="truncate font-mono text-[11px] leading-4 text-(--bwa-text-muted)">{target}</div>
      </div>
      <button
        className="lg-btn ml-auto shrink-0 text-[11.5px] font-medium text-(--bwa-text-secondary) disabled:opacity-50 max-[28rem]:ml-9 max-[28rem]:w-[calc(100%-2.25rem)]"
        disabled={opening}
        onClick={() => void togglePreview()}
        type="button"
      >
        {opening ? '正在打开…' : isActive ? '隐藏' : '打开预览'}
      </button>
    </div>
  )
}
