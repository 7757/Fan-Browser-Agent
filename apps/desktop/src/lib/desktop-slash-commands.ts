interface CommandsCatalogSection {
  name: string
  pairs: [string, string][]
}

export interface CommandsCatalogLike {
  categories?: CommandsCatalogSection[]
  pairs?: [string, string][]
  /** Agent-internal skill commands, kept out of `pairs` on the gateway side —
      reserved for a future user-facing skills surface. */
  skill_pairs?: [string, string][]
  skill_count?: number
  warning?: string
}

const DESKTOP_COMMAND_META = [
  ['/agents', '显示活跃的桌面会话和运行中的任务'],
  ['/background', '在后台运行一条提示'],
  ['/branch', '将最新消息分支到新对话'],
  ['/compress', '压缩当前对话上下文'],
  ['/goal', '管理本会话的持续目标'],
  ['/help', '显示桌面斜杠命令'],
  ['/new', '开始新的桌面对话'],
  ['/retry', '重试上一条用户消息'],
  ['/rollback', '列出或恢复文件系统检查点'],
  ['/status', '显示当前会话状态'],
  ['/stop', '停止运行中的后台进程'],
  ['/title', '重命名当前会话'],
  ['/undo', '删除最后一组用户/助手消息'],
  ['/usage', '显示本会话的 Token 用量']
] as const

const DESKTOP_COMMANDS: ReadonlySet<string> = new Set(DESKTOP_COMMAND_META.map(([command]) => command))

const DESKTOP_ALIASES = new Map([
  ['/bg', '/background'],
  ['/btw', '/background'],
  ['/fork', '/branch'],
  ['/reload_mcp', '/reload-mcp'],
  ['/reload_skills', '/reload-skills'],
  ['/reset', '/new'],
  ['/tasks', '/agents']
])

const DESKTOP_COMMAND_DESCRIPTIONS: ReadonlyMap<string, string> = new Map(DESKTOP_COMMAND_META)

// Built-ins are available locally. An optional config list may narrow or
// extend the visible command set for a particular installation.
let _slashAllowlist: Set<string> = new Set(DESKTOP_COMMANDS)

export function setDesktopSlashAllowlist(commands: readonly unknown[] | null | undefined): void {
  if (!Array.isArray(commands)) {
    _slashAllowlist = new Set(DESKTOP_COMMANDS)

    return
  }

  _slashAllowlist = new Set(
    commands
      .map(c => canonicalDesktopSlashCommand(String(c)))
      .filter(c => c.length > 1)
  )
}

const PICKER_OWNED_COMMANDS = new Set(['/model'])

const TERMINAL_ONLY_COMMANDS = new Set([
  '/browser',
  '/bundles',
  '/busy',
  '/clear',
  '/commands',
  '/compact',
  '/config',
  '/copy',
  '/cron',
  '/details',
  '/exit',
  '/footer',
  '/gateway',
  '/gquota',
  '/history',
  '/image',
  '/indicator',
  '/logs',
  '/memory',
  '/mouse',
  '/paste',
    '/plugins',
  '/quit',
  '/redraw',
  '/reload',
  '/restart',
  '/save',
  '/sb',
  '/sessions',
  '/set-home',
  '/sethome',
  '/statusbar',
  '/subgoal',
  '/toolsets',
  '/tools',
  '/verbose'
])

const SETTINGS_OWNED_COMMANDS = new Set(['/skills'])

// Internal runtime mechanisms are deliberately not slash commands. `steer`
// is invoked by submitting ordinary text while a run is active.
const INTERNAL_SYSTEM_COMMANDS = new Set(['/steer'])

const ADVANCED_COMMANDS = new Set([
  '/curator',
  '/fast',
  '/insights',
  '/kanban',
  '/personality',
  '/reasoning',
  '/reload-mcp',
  '/reload-skills',
  '/voice'
])

// 产品层下线的命令:桌面端既不补全也不执行,输入时给出替代指引。
const RETIRED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['/debug', '/debug 已下线——可在日志目录中查看本地诊断信息。'],
  ['/resume', '/resume 已下线——请使用左侧会话列表恢复会话。'],
  ['/skin', '/skin 已下线——外观请在 设置 → 外观 中调整。'],
  ['/yolo', '/yolo 已下线——危险操作确认请在 设置 → 安全 中管理。']
])

const BLOCKED_COMMANDS = new Set([
  ...PICKER_OWNED_COMMANDS,
  ...TERMINAL_ONLY_COMMANDS,
  ...SETTINGS_OWNED_COMMANDS,
  ...INTERNAL_SYSTEM_COMMANDS,
  ...ADVANCED_COMMANDS,
  ...RETIRED_COMMANDS.keys()
])

function normalizeCommand(command: string): string {
  const trimmed = command.trim()
  const base = (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).split(/\s+/, 1)[0]?.toLowerCase() || ''

  return base
}

function canonicalDesktopSlashCommand(command: string): string {
  const normalized = normalizeCommand(command)

  return DESKTOP_ALIASES.get(normalized) || normalized
}

export function isDesktopSlashCommand(command: string): boolean {
  const normalized = normalizeCommand(command)
  const canonical = canonicalDesktopSlashCommand(normalized)

  if (BLOCKED_COMMANDS.has(normalized) || BLOCKED_COMMANDS.has(canonical)) {
    return false
  }

  return _slashAllowlist.has(canonical)
}

/**
 * An "extension" command is anything the backend surfaces that is NOT one of
 * Fan's built-in slash commands — i.e. skill commands and user-defined quick
 * commands. Extensions still require an explicit server allowlist entry.
 */
function isDesktopSlashExtensionCommand(command: string): boolean {
  const normalized = normalizeCommand(command)

  if (!normalized || normalized === '/') {
    return false
  }

  return !isKnownFanSlashCommand(normalized)
}

export function isDesktopSlashSuggestion(command: string): boolean {
  const normalized = normalizeCommand(command)
  const canonical = canonicalDesktopSlashCommand(normalized)

  // Built-in aliases stay hidden so the popover isn't cluttered with duplicates.
  if (isDesktopSlashExtensionCommand(normalized)) {
    return _slashAllowlist.has(canonical)
  }

  return DESKTOP_COMMANDS.has(canonical) && !DESKTOP_ALIASES.has(normalized) && _slashAllowlist.has(canonical)
}

export function desktopSlashUnavailableMessage(command: string): string | null {
  const normalized = normalizeCommand(command)
  const canonical = canonicalDesktopSlashCommand(normalized)

  const retired = RETIRED_COMMANDS.get(canonical) || RETIRED_COMMANDS.get(normalized)

  if (retired) {
    return retired
  }

  if (PICKER_OWNED_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} 使用桌面模型选择器，而非斜杠命令。`
  }

  if (SETTINGS_OWNED_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} 在桌面侧边栏中管理。`
  }

  if (INTERNAL_SYSTEM_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} 是应用内部的补充机制，无需手动调用。`
  }

  if (ADVANCED_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} 不在桌面斜杠面板中显示，请使用相应的桌面控件或终端界面。`
  }

  if (TERMINAL_ONLY_COMMANDS.has(normalized) || TERMINAL_ONLY_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} 仅在终端界面中可用。`
  }

  if (!_slashAllowlist.has(canonical)) {
    return `${normalized || '/'} 当前未在本地桌面配置中开启。`
  }

  return null
}

export function desktopSlashDescription(command: string, fallback = ''): string {
  const canonical = canonicalDesktopSlashCommand(command)

  return DESKTOP_COMMAND_DESCRIPTIONS.get(canonical) || fallback
}

export function filterDesktopCommandsCatalog(catalog: CommandsCatalogLike): CommandsCatalogLike {
  const categories = catalog.categories
    ?.map(section => ({
      ...section,
      pairs: section.pairs
        .filter(([command]) => isDesktopSlashSuggestion(command))
        .map(([command, description]) => [command, desktopSlashDescription(command, description)] as [string, string])
    }))
    .filter(section => section.pairs.length > 0)

  const pairs = catalog.pairs
    ?.filter(([command]) => isDesktopSlashSuggestion(command))
    .map(([command, description]) => [command, desktopSlashDescription(command, description)] as [string, string])

  return {
    ...catalog,
    ...(categories ? { categories } : {}),
    ...(pairs ? { pairs } : {}),
    // Agent-internal skills are not desktop commands. In particular, their
    // raw discovery count must not make /help claim commands are available
    // when the server-delivered desktop allowlist is empty.
    skill_pairs: [],
    skill_count: 0
  }
}

function isKnownFanSlashCommand(command: string): boolean {
  return DESKTOP_COMMANDS.has(command) || DESKTOP_ALIASES.has(command) || BLOCKED_COMMANDS.has(command)
}
