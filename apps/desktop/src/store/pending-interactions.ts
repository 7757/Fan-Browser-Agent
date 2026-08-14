import type { PendingInteraction } from '@/types/fan'

import { clearCollectRequest, hasCollectRequest, parseCollectContent, setCollectRequest } from './collect'
import {
  clearAllPrompts,
  clearApprovalRequest,
  clearControlRequest,
  clearSecretRequest,
  clearSudoRequest,
  clearVerificationRequest,
  hasAnyPrompt,
  setApprovalRequest,
  setControlRequest,
  setSecretRequest,
  setSudoRequest,
  setVerificationRequest
} from './prompts'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

interface InteractionVersion {
  epoch: string
  retiredEpochs: Set<string>
  revision: number
}

const interactionVersions = new Map<string, InteractionVersion>()

function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Record the newest live request/resolution observed for one session. */
export function recordPendingInteractionVersion(sessionId: string, epochValue: unknown, revisionValue: unknown): void {
  const epoch = text(epochValue)
  const nextRevision = revision(revisionValue)

  if (!sessionId || !epoch || nextRevision === null) {
    return
  }

  const current = interactionVersions.get(sessionId)

  if (!current) {
    interactionVersions.set(sessionId, { epoch, retiredEpochs: new Set(), revision: nextRevision })

    return
  }

  if (current.epoch === epoch) {
    if (nextRevision > current.revision) {
      current.revision = nextRevision
    }

    return
  }

  // Once a renderer has observed a replacement gateway epoch, traffic from
  // the retired process can still be sitting in a reconnect/event queue. Do
  // not let that old process become current again and resurrect its prompts.
  if (current.retiredEpochs.has(epoch)) {
    return
  }

  current.retiredEpochs.add(current.epoch)
  current.epoch = epoch
  current.revision = nextRevision
}

/**
 * Admit one live `*.request` exactly once in gateway lifecycle order.
 *
 * Request ids and browser challenge ids describe identity, not freshness: a
 * new block can legitimately target the same challenge. The gateway epoch and
 * monotonic interaction revision are the authoritative replay boundary.
 */
export function acceptPendingInteractionRequest(
  sessionId: string,
  epochValue: unknown,
  revisionValue: unknown
): boolean {
  const epoch = text(epochValue)
  const nextRevision = revision(revisionValue)

  // Keep compatibility with older gateways that did not publish lifecycle
  // metadata. Current gateways always provide both values.
  if (!sessionId || !epoch || nextRevision === null) {
    return true
  }

  const current = interactionVersions.get(sessionId)

  if (!current) {
    interactionVersions.set(sessionId, { epoch, retiredEpochs: new Set(), revision: nextRevision })

    return true
  }

  if (current.epoch === epoch) {
    if (nextRevision <= current.revision) {
      return false
    }

    current.revision = nextRevision

    return true
  }

  if (current.retiredEpochs.has(epoch)) {
    return false
  }

  current.retiredEpochs.add(current.epoch)
  current.epoch = epoch
  current.revision = nextRevision

  return true
}

function clearReplayablePrompts(sessionId: string): void {
  clearCollectRequest(undefined, sessionId)
  clearApprovalRequest(sessionId)
  clearSudoRequest(sessionId)
  clearSecretRequest(sessionId)
  clearVerificationRequest(sessionId)
  clearControlRequest(sessionId)
}

export function clearPendingInteractions(sessionId?: string): void {
  if (sessionId === undefined) {
    clearCollectRequest()
    clearAllPrompts()

    return
  }

  clearReplayablePrompts(sessionId)
}

export function hasPendingInteraction(sessionId: string): boolean {
  return hasCollectRequest(sessionId) || hasAnyPrompt(sessionId)
}

/** Apply an answer/timeout event without carrying any submitted data. */
export function resolvePendingInteraction(
  sessionId: string,
  requestId: string,
  epochValue?: unknown,
  revisionValue?: unknown
): boolean {
  recordPendingInteractionVersion(sessionId, epochValue, revisionValue)
  clearCollectRequest(requestId, sessionId)
  clearApprovalRequest(sessionId, requestId)
  clearSudoRequest(sessionId, requestId)
  clearSecretRequest(sessionId, requestId)
  clearVerificationRequest(sessionId, requestId)
  clearControlRequest(sessionId, requestId)

  return hasPendingInteraction(sessionId)
}

export function resetPendingInteractionVersions(sessionId?: string): void {
  if (sessionId === undefined) {
    interactionVersions.clear()
  } else {
    interactionVersions.delete(sessionId)
  }
}

/** Rebuild one session's replayable prompt queues from a gateway resume snapshot. */
export function hydratePendingInteractions(
  sessionId: string,
  interactions: PendingInteraction[] | undefined,
  snapshotEpoch?: unknown,
  snapshotRevision?: unknown
): boolean {
  const epoch = text(snapshotEpoch)
  const nextRevision = revision(snapshotRevision)
  const current = interactionVersions.get(sessionId)

  // A live request or resolution can arrive after the server takes its resume
  // snapshot but before the RPC response reaches the renderer. Never reapply
  // an already-consumed snapshot, or let an older one erase/resurrect newer
  // local state.
  if (epoch && nextRevision !== null && current) {
    if (
      current.retiredEpochs.has(epoch) ||
      (current.epoch === epoch && nextRevision <= current.revision)
    ) {
      return hasPendingInteraction(sessionId)
    }
  }

  if (epoch && nextRevision !== null) {
    recordPendingInteractionVersion(sessionId, epoch, nextRevision)
  }

  clearReplayablePrompts(sessionId)
  let waiting = false

  for (const interaction of interactions ?? []) {
    if (interaction.status !== 'waiting') {
      continue
    }

    const requestId = text(interaction.request_id)

    if (!requestId) {
      continue
    }

    switch (interaction.kind) {
      case 'approval':
        setApprovalRequest({
          requestId,
          sessionId,
          allowPermanent: interaction.allow_permanent !== false,
          command: text(interaction.command),
          description: text(interaction.description) || 'dangerous command'
        })
        waiting = true

        break
      case 'collect': {
        const content = parseCollectContent(interaction)

        if (!content.question) {
          break
        }

        setCollectRequest({
          requestId,
          toolCallId: text(interaction.tool_call_id) || null,
          ...content,
          sessionId
        })
        waiting = true

        break
      }

      case 'sudo':
        setSudoRequest({ requestId, sessionId })
        waiting = true

        break

      case 'secret':
        setSecretRequest({
          requestId,
          sessionId,
          envVar: text(interaction.env_var),
          prompt: text(interaction.prompt)
        })
        waiting = true

        break

      case 'verification':
        setVerificationRequest({
          requestId,
          sessionId,
          message: text(interaction.message),
          url: text(interaction.url) || undefined,
          captchaType: text(interaction.captcha_type ?? interaction.captchaType) || undefined,
          challengeId: text(interaction.challenge_id ?? interaction.challengeId) || undefined,
          documentRevision:
            revision(interaction.document_revision ?? interaction.documentRevision) ?? undefined
        })
        waiting = true

        break

      case 'control':
        setControlRequest({
          requestId,
          sessionId,
          message: text(interaction.message),
          url: text(interaction.url) || undefined,
          settling: interaction.settling === true,
          tabKind: text(interaction.tabKind) || undefined,
          anchorTabId: text(interaction.anchorTabId) || undefined,
          userTabId: text(interaction.userTabId) || undefined,
          inputKind: text(interaction.inputKind) || undefined,
          interventionId: text(interaction.interventionId) || undefined,
          interventionTimestamp:
            typeof interaction.interventionTimestamp === 'number'
              ? interaction.interventionTimestamp
              : undefined
        })
        waiting = true

        break

      default:
        break
    }
  }

  return waiting
}
