import { useStore } from '@nanostores/react'

import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { FileText, FolderOpen, ImageIcon, Link, Terminal } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import type { ComposerAttachment } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import { setCurrentSessionPreviewTarget } from '@/store/preview'
import { $currentCwd } from '@/store/session'

export function AttachmentList({
  attachments,
  onRemove
}: {
  attachments: ComposerAttachment[]
  onRemove?: (id: string) => void
}) {
  return (
    <div className="flex max-w-full flex-wrap gap-1.5 px-1 pt-1" data-slot="composer-attachments">
      {attachments.filter(Boolean).map(attachment => (
        <AttachmentPill attachment={attachment} key={attachment.id} onRemove={onRemove} />
      ))}
    </div>
  )
}

function AttachmentPill({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove?: (id: string) => void }) {
  const Icon = { folder: FolderOpen, url: Link, image: ImageIcon, file: FileText, terminal: Terminal }[attachment.kind]
  const cwd = useStore($currentCwd)
  const canPreview = attachment.kind !== 'folder' && attachment.kind !== 'terminal'
  const detail = attachment.detail && attachment.detail !== attachment.label ? attachment.detail : undefined

  async function openPreview() {
    if (!canPreview) {
      return
    }

    const rawTarget =
      attachment.path ||
      attachment.detail ||
      attachment.refText?.replace(/^@(file|image|url):/, '') ||
      attachment.label ||
      ''

    const target = rawTarget.replace(/^`|`$/g, '')

    if (!target) {
      return
    }

    try {
      const preview = await normalizeOrLocalPreviewTarget(target, cwd || undefined)

      if (!preview) {
        throw new Error(`Could not preview ${attachment.label}`)
      }

      setCurrentSessionPreviewTarget(preview, 'manual', target)
    } catch (error) {
      notifyError(error, '预览不可用')
    }
  }

  return (
    // Liquid Glass attachment chip — Pencil b8iff lOtcr, 1:1: glass inset
    // chip r12 (7/9 padding), 26px accent thumb r6, 12/500 name + 10.5 muted
    // meta, quiet remove ✕.
    <Tip label={attachment.path || attachment.detail || attachment.label}>
      <div className="group/attachment relative min-w-0 shrink-0">
        <button
          aria-label={canPreview ? `预览 ${attachment.label}` : attachment.label}
          className="flex max-w-56 items-center gap-[9px] rounded-[12px] border border-(--lg-inset-stroke) bg-(--lg-inset-fill-strong) px-[9px] py-[7px] text-left shadow-(--lg-inset-highlight) transition-colors hover:bg-(--lg-inset-fill) disabled:cursor-default"
          disabled={!canPreview}
          onClick={() => void openPreview()}
          type="button"
        >
          {attachment.previewUrl && attachment.kind === 'image' ? (
            <img
              alt={attachment.label}
              className="size-[26px] shrink-0 rounded-[6px] object-cover"
              draggable={false}
              src={attachment.previewUrl}
            />
          ) : (
            <span className="grid size-[26px] shrink-0 place-items-center rounded-[6px] bg-(--bwa-primary-soft) text-(--lg-accent)">
              <Icon className="size-[13px]" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium leading-4 text-(--bwa-text)">
              {attachment.label}
            </span>
            {detail && (
              <span className="block truncate font-mono text-[10.5px] leading-3 text-(--bwa-text-muted)">
                {detail}
              </span>
            )}
          </span>
        </button>
        {onRemove && (
          <button
            aria-label={`移除 ${attachment.label}`}
            className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full border border-(--lg-inset-stroke) bg-(--lg-inset-fill-strong) text-(--bwa-text-muted) opacity-0 shadow-(--lg-inset-highlight) backdrop-blur-sm transition hover:text-(--bwa-text) group-hover/attachment:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(attachment.id)}
            type="button"
          >
            <Codicon name="close" size="0.625rem" />
          </button>
        )}
      </div>
    </Tip>
  )
}
