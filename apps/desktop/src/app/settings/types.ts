
import type { FanGateway } from '@/fan'
import type { IconComponent } from '@/lib/icons'

export type SettingsView =
  | 'about'
  | 'agents'
  | 'artifacts'
  | 'cron'
  | 'mcp'
  | 'sessions'
  | 'skills'
  | `config:${string}`

export interface SettingsPageProps {
  gateway?: FanGateway | null
  onClose: () => void
  onConfigSaved?: () => void
}

export interface DesktopConfigSection {
  id: string
  label: string
  icon: IconComponent
  keys: string[]
}
