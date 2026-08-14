interface RpcEventLike {
  payload?: unknown
  type?: string
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

/**
 * Whether an unscoped event (no `session_id`) must be dropped rather than
 * attributed to the focused chat.
 *
 * `subagent.*` and `review.summary` qualify: they describe background/async
 * work that must never attach to whichever chat happens to be focused. Every
 * other scoped event — message/reasoning/thinking/tool/status — is, when unscoped, the
 * active turn's own output (the gateway always stamps a background session's
 * events with that session's id, so a missing id can only mean "the focused
 * turn").
 */
export function gatewayEventRequiresSessionId(eventType: string | undefined): boolean {
  return eventType === 'review.summary' || (eventType?.startsWith('subagent.') ?? false)
}

export function gatewayEventCompletedFileDiff(event: RpcEventLike): boolean {
  if (event.type !== 'tool.complete') {
    return false
  }

  const diff = asRecord(event.payload).inline_diff

  return typeof diff === 'string' && diff.trim().length > 0
}
