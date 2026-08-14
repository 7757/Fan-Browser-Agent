import { normalizePersonalityValue } from '@/lib/chat-runtime'
import { setCurrentPersonality, setIntroPersonality } from '@/store/session'

export type PersonalityGatewayRequester = <T = unknown>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>

/** Persist the default personality and apply it to the active session. */
export async function setSessionPersonality(
  requestGateway: PersonalityGatewayRequester,
  sessionId: null | string,
  personality: string
): Promise<string> {
  const requested = normalizePersonalityValue(personality)

  const result = await requestGateway<{ value?: string }>('config.set', {
    key: 'personality',
    ...(sessionId ? { session_id: sessionId } : {}),
    value: requested || 'none'
  })

  const applied = normalizePersonalityValue(result?.value ?? requested)

  setCurrentPersonality(applied)
  setIntroPersonality(applied)

  return applied
}
