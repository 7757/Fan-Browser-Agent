import type { FanGateway } from '@/fan'
import type { ComposerAttachment } from '@/store/composer'

import type { DroppedFile } from '../hooks/use-composer-actions'

interface ContextSuggestion {
  text: string
  display: string
  meta?: string
}

export interface ChatBarState {
  // Read-only reflection of the active locally configured model; provider
  // selection is intentionally not exposed in the composer.
  model: {
    model: string
    provider: string
    loading?: boolean
  }
  tools: { enabled: boolean; label: string; suggestions?: ContextSuggestion[] }
}

export interface ChatBarProps {
  busy: boolean
  disabled: boolean
  focusKey?: string | null
  state: ChatBarState
  gateway?: FanGateway | null
  sessionId?: string | null
  cwd?: string | null
  onCancel: () => Promise<boolean | void> | boolean | void
  onAddContextRef?: (refText: string, label?: string, detail?: string) => void
  onAddUrl?: (url: string) => void
  onAttachImageBlob?: (blob: Blob) => Promise<boolean | void> | boolean | void
  onAttachDroppedItems?: (candidates: DroppedFile[]) => Promise<boolean | void> | boolean | void
  onPasteClipboardImage?: (opts?: { silent?: boolean }) => Promise<boolean> | void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  onRemoveAttachment?: (id: string) => void
  onSubmit: (
    value: string,
    options?: { attachments?: ComposerAttachment[]; fromSteer?: boolean }
  ) => Promise<boolean> | boolean
}
