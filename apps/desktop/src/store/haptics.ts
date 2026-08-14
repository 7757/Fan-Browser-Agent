import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

const HAPTICS_MUTED_STORAGE_KEY = 'fan.desktop.hapticsMuted'

export const $hapticsMuted = atom(storedBoolean(HAPTICS_MUTED_STORAGE_KEY, false))

$hapticsMuted.subscribe(muted => persistBoolean(HAPTICS_MUTED_STORAGE_KEY, muted))


