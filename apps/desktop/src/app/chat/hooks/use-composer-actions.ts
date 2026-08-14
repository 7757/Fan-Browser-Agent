import { useCallback } from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { attachmentId, contextPath, pathLabel } from '@/lib/chat-runtime'
import {
  addComposerAttachment,
  type ComposerAttachment,
  removeComposerAttachment,
  setComposerTerminalSelection
} from '@/store/composer'
import { notify, notifyError } from '@/store/notifications'

import type { ImageDetachResponse } from '../../types'

const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|ico)$/i

const BLOB_MIME_EXTENSION: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
  'image/x-icon': '.ico'
}

function blobExtension(blob: Blob): string {
  const mime = blob.type.split(';')[0]?.trim().toLowerCase()

  return (mime && BLOB_MIME_EXTENSION[mime]) || '.png'
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSION_PATTERN.test(filePath)
}

export interface DroppedFile {
  /** Browser-native File handle. Absent for in-app drags (e.g. project tree). */
  file?: File
  /** Absolute filesystem path. Empty when an OS drop didn't carry one. */
  path: string
  /** True if the entry is a directory. Currently only set by in-app drags. */
  isDirectory?: boolean
  /** First line number for in-app line-ref drags (source view gutter). */
  line?: number
  /** Last line number for line-range drags (`line..lineEnd` inclusive). */
  lineEnd?: number
}

/** MIME emitted by in-app drag sources (project tree, gutter line numbers).
 * Payload is JSON `{ path; isDirectory?; line?; lineEnd? }[]`. */
export const FAN_PATHS_MIME = 'application/x-fan-paths'

/**
 * Eagerly resolve files from a drop event into [File?, path, isDirectory?]
 * triples. Internal Fan sources (e.g. the project tree) ride on a custom
 * MIME and produce path-only entries; OS drops produce File-bearing entries.
 *
 * Must be called synchronously from inside the drop handler — `DataTransfer`
 * items are detached as soon as the handler returns, and `webUtils.getPathForFile`
 * also requires the original (non-cloned) File reference.
 */
export function extractDroppedFiles(transfer: DataTransfer): DroppedFile[] {
  const result: DroppedFile[] = []
  const seenPaths = new Set<string>()
  const seenFiles = new Set<File>()
  const getPath = window.fanDesktop?.getPathForFile

  // In-app drags first — they carry richer metadata (isDirectory) than the
  // File-based fallback can provide, and produce no overlapping native files.
  try {
    const internalRaw = transfer.getData(FAN_PATHS_MIME)

    if (internalRaw) {
      const parsed = JSON.parse(internalRaw) as {
        path?: unknown
        isDirectory?: unknown
        line?: unknown
        lineEnd?: unknown
      }[]

      const positiveInt = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.floor(value) : undefined)

      for (const entry of parsed) {
        if (!entry || typeof entry.path !== 'string' || !entry.path) {
          continue
        }

        const line = positiveInt(entry.line)
        const rawEnd = positiveInt(entry.lineEnd)
        const lineEnd = line && rawEnd && rawEnd > line ? rawEnd : undefined
        const dedupKey = line ? `${entry.path}:${line}-${lineEnd ?? line}` : entry.path

        if (seenPaths.has(dedupKey)) {
          continue
        }

        seenPaths.add(dedupKey)
        result.push({ isDirectory: entry.isDirectory === true, line, lineEnd, path: entry.path })
      }
    }
  } catch {
    // Malformed payload — fall through to native files.
  }

  const fileList = transfer.files

  if (fileList) {
    for (let i = 0; i < fileList.length; i += 1) {
      const file = fileList.item(i)

      if (!file || seenFiles.has(file)) {
        continue
      }

      seenFiles.add(file)
      let path = ''

      if (getPath) {
        try {
          path = getPath(file) || ''
        } catch {
          path = ''
        }
      }

      if (path && seenPaths.has(path)) {
        continue
      }

      if (path) {
        seenPaths.add(path)
      }

      result.push({ file, path })
    }
  }

  const items = transfer.items

  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]

      if (!item || item.kind !== 'file') {
        continue
      }

      const file = item.getAsFile()

      if (!file || seenFiles.has(file)) {
        continue
      }

      seenFiles.add(file)
      let path = ''

      if (getPath) {
        try {
          path = getPath(file) || ''
        } catch {
          path = ''
        }
      }

      if (path && seenPaths.has(path)) {
        continue
      }

      if (path) {
        seenPaths.add(path)
      }

      result.push({ file, path })
    }
  }

  return result
}

interface ComposerActionsOptions {
  activeSessionId: string | null
  currentCwd: string
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

/** Add to the main composer and focus it. All sidebar/picker/drop attach paths funnel through here. */
const attachToMain = (attachment: ComposerAttachment) => {
  addComposerAttachment(attachment)
  requestComposerFocus('main')
}

export function useComposerActions({ activeSessionId, currentCwd, requestGateway }: ComposerActionsOptions) {
  const addTextToDraft = useCallback((text: string) => {
    requestComposerInsert(text, { mode: 'block' })
  }, [])

  const addTerminalSelectionAttachment = useCallback((text: string, label = 'selection') => {
    const trimmed = text.trim()
    const normalizedLabel = label.trim() || 'selection'
    const refText = `@terminal:${formatRefValue(normalizedLabel)}`

    if (!trimmed) {
      return
    }

    setComposerTerminalSelection(normalizedLabel, trimmed)
    requestComposerInsert(refText, { mode: 'inline' })
  }, [])

  const addContextRefAttachment = useCallback((refText: string, label?: string, detail?: string) => {
    const kind: ComposerAttachment['kind'] = refText.startsWith('@folder:')
      ? 'folder'
      : refText.startsWith('@url:')
        ? 'url'
        : 'file'

    attachToMain({
      id: attachmentId(kind, refText),
      kind,
      label: label || refText.replace(/^@(file|folder|url):/, ''),
      detail,
      refText
    })
  }, [])

  const pickContextPaths = useCallback(
    async (kind: 'file' | 'folder') => {
      const paths = await window.fanDesktop?.selectPaths({
        title: kind === 'file' ? '添加文件作为上下文' : '添加文件夹作为上下文',
        defaultPath: currentCwd || undefined,
        directories: kind === 'folder'
      })

      if (!paths?.length) {
        return
      }

      for (const path of paths) {
        const rel = contextPath(path, currentCwd)

        attachToMain({
          id: attachmentId(kind, rel),
          kind,
          label: pathLabel(path),
          detail: rel,
          refText: `@${kind}:${formatRefValue(rel)}`,
          path
        })
      }
    },
    [currentCwd]
  )

  const attachContextFilePath = useCallback(
    (filePath: string) => {
      if (!filePath) {
        return false
      }

      const rel = contextPath(filePath, currentCwd)

      attachToMain({
        id: attachmentId('file', rel),
        kind: 'file',
        label: pathLabel(filePath),
        detail: rel,
        refText: `@file:${formatRefValue(rel)}`,
        path: filePath
      })

      return true
    },
    [currentCwd]
  )

  const attachImagePath = useCallback(async (filePath: string) => {
    if (!filePath) {
      return false
    }

    const baseAttachment: ComposerAttachment = {
      id: attachmentId('image', filePath),
      kind: 'image',
      label: pathLabel(filePath),
      detail: filePath,
      path: filePath
    }

    attachToMain(baseAttachment)

    try {
      const previewUrl = await window.fanDesktop?.readFileDataUrl(filePath)

      if (previewUrl) {
        addComposerAttachment({ ...baseAttachment, previewUrl })
      }

      return true
    } catch (err) {
      notifyError(err, '图片预览失败')

      return true
    }
  }, [])

  const attachImageBlob = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        return false
      }

      if (blob.type && !blob.type.startsWith('image/')) {
        return false
      }

      try {
        const buffer = await blob.arrayBuffer()
        const data = new Uint8Array(buffer)
        const savedPath = await window.fanDesktop?.saveImageBuffer(data, blobExtension(blob))

        if (!savedPath) {
          notify({ kind: 'error', title: '附加图片', message: '图片写入磁盘失败。' })

          return false
        }

        return attachImagePath(savedPath)
      } catch (err) {
        notifyError(err, '附加图片失败')

        return false
      }
    },
    [attachImagePath]
  )

  const pickImages = useCallback(async () => {
    const paths = await window.fanDesktop?.selectPaths({
      title: '附加图片',
      defaultPath: currentCwd || undefined,
      filters: [
        {
          name: '图片',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']
        }
      ]
    })

    if (!paths?.length) {
      return
    }

    for (const path of paths) {
      await attachImagePath(path)
    }
  }, [attachImagePath, currentCwd])

  const pasteClipboardImage = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      try {
        const path = await window.fanDesktop?.saveClipboardImage()

        if (!path) {
          if (!silent) {
            notify({
              kind: 'warning',
              title: '剪贴板',
              message: '剪贴板中未找到图片'
            })
          }

          return false
        }

        await attachImagePath(path)
        return true
      } catch (err) {
        if (!silent) {
          notifyError(err, '粘贴剪贴板内容失败')
        }

        return false
      }
    },
    [attachImagePath]
  )

  const attachContextFolderPath = useCallback(
    (folderPath: string) => {
      if (!folderPath) {
        return false
      }

      const rel = contextPath(folderPath, currentCwd)

      attachToMain({
        id: attachmentId('folder', rel),
        kind: 'folder',
        label: pathLabel(folderPath),
        detail: rel,
        refText: `@folder:${formatRefValue(rel)}`,
        path: folderPath
      })

      return true
    },
    [currentCwd]
  )

  const attachDroppedItems = useCallback(
    async (candidates: DroppedFile[]) => {
      if (candidates.length === 0) {
        return false
      }

      let attached = false
      let lastFailure: string | null = null

      for (const candidate of candidates) {
        const { file, isDirectory, path: knownPath } = candidate

        // Path-only entry (in-app drag from the file browser tree, etc.).
        if (!file) {
          if (isDirectory) {
            if (knownPath && attachContextFolderPath(knownPath)) {
              attached = true

              continue
            }

            lastFailure = `无法附加文件夹 ${knownPath || ''}`

            continue
          }

          if (knownPath && isImagePath(knownPath)) {
            if (await attachImagePath(knownPath)) {
              attached = true

              continue
            }

            lastFailure = `无法附加 ${knownPath}`

            continue
          }

          if (knownPath && attachContextFilePath(knownPath)) {
            attached = true

            continue
          }

          lastFailure = `无法附加 ${knownPath || '文件'}`

          continue
        }

        const fallbackPath =
          !knownPath && window.fanDesktop?.getPathForFile ? window.fanDesktop.getPathForFile(file) : ''

        const filePath = knownPath || fallbackPath || ''
        const isImage = file.type.startsWith('image/') || isImagePath(file.name) || (filePath && isImagePath(filePath))

        if (isImage) {
          if ((filePath && (await attachImagePath(filePath))) || (await attachImageBlob(file))) {
            attached = true

            continue
          }

          lastFailure = `无法附加 ${file.name || '图片'}`

          continue
        }

        if (filePath && attachContextFilePath(filePath)) {
          attached = true

          continue
        }

        lastFailure = `无法附加 ${file.name || '文件'}`
      }

      if (!attached && lastFailure) {
        notify({ kind: 'warning', title: '拖放文件', message: lastFailure })
      }

      return attached
    },
    [attachContextFilePath, attachContextFolderPath, attachImageBlob, attachImagePath]
  )

  const removeAttachment = useCallback(
    async (id: string) => {
      const removed = removeComposerAttachment(id)

      if (
        removed?.kind === 'image' &&
        removed.path &&
        activeSessionId &&
        removed.attachedSessionId &&
        removed.attachedSessionId === activeSessionId
      ) {
        await requestGateway<ImageDetachResponse>('image.detach', {
          session_id: activeSessionId,
          path: removed.path
        }).catch(() => undefined)
      }
    },
    [activeSessionId, requestGateway]
  )

  return {
    addContextRefAttachment,
    addTerminalSelectionAttachment,
    addTextToDraft,
    attachContextFilePath,
    attachContextFolderPath,
    attachDroppedItems,
    attachImageBlob,
    attachImagePath,
    pasteClipboardImage,
    pickContextPaths,
    pickImages,
    removeAttachment
  }
}
