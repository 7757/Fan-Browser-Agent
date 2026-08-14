import type { DesktopLanguage } from '@/i18n'
import {
  Brain,
  Cpu,
  FileText,
  type IconComponent,
  Layers3,
  Lock,
  MessageCircle,
  Monitor,
  Moon,
  Palette,
  Sun,
  Terminal
} from '@/lib/icons'
import type { ThemeMode } from '@/themes/context'

import type { DesktopConfigSection } from './types'

export const EMPTY_SELECT_VALUE = '__fan_empty__'
export const CONTROL_TEXT = 'text-xs'

export const BUILTIN_PERSONALITIES = [
  'helpful',
  'concise',
  'technical',
  'creative',
  'teacher',
  'kawaii',
  'catgirl',
  'pirate',
  'shakespeare',
  'surfer',
  'noir',
  'uwu',
  'philosopher',
  'hype'
]

// Display labels for the built-in personalities. The raw IDs above stay as the
// stored ``display.personality`` config value; this map only localizes what the
// dropdown shows (wired in via ``optionLabels`` in config-settings.tsx). Custom
// personalities not listed here fall back to a prettified version of their key.
export const PERSONALITY_LABELS: Record<string, string> = {
  helpful: '亲切助手',
  concise: '简洁直接',
  technical: '专业技术',
  creative: '创意发散',
  teacher: '循循善诱',
  kawaii: '可爱卖萌',
  catgirl: '猫娘',
  pirate: '海盗腔',
  shakespeare: '莎翁文风',
  surfer: '冲浪少年',
  noir: '黑色电影',
  uwu: 'UwU 软萌',
  philosopher: '哲思',
  hype: '热血带感'
}

// Display labels for the browser default search engine select.
export const SEARCH_ENGINE_LABELS: Record<string, string> = {
  bing: '必应 Bing',
  google: 'Google',
  duckduckgo: 'DuckDuckGo',
  baidu: '百度'
}

// Schema-side select overrides for desktop-relevant enum fields whose
// backend schema only declares a string type.
export const ENUM_OPTIONS: Record<string, string[]> = {
  'agent.image_input_mode': ['auto', 'native', 'text'],
  'agent.reasoning_effort': ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  'agent.service_tier': ['', 'auto', 'default', 'flex'],
  'approvals.cron_mode': ['deny', 'approve'],
  'browser.search_engine': ['baidu', 'bing', 'google', 'duckduckgo'],
  'code_execution.mode': ['project', 'strict'],
  'delegation.api_mode': ['', 'chat_completions', 'codex_responses'],
  'delegation.reasoning_effort': ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  'display.busy_input_mode': ['interrupt', 'queue', 'steer'],
  'display.resume_display': ['minimal', 'full', 'off'],
  'logging.level': ['DEBUG', 'INFO', 'WARNING', 'ERROR'],
  'memory.write_mode': ['on', 'approve', 'off']
}

export const FIELD_LABELS: Record<string, string> = {
  timezone: '时区',
  model_context_length: '上下文窗口覆盖值',
  max_concurrent_sessions: '最大并发会话数',
  'agent.max_turns': '单次任务最大轮数',
  'agent.reasoning_effort': '主模型推理强度',
  'agent.api_max_retries': '模型请求重试次数',
  'agent.service_tier': '模型服务档位',
  'agent.task_completion_guidance': '任务完成引导',
  'agent.environment_probe': '本机环境探测',
  'agent.image_input_mode': '图片输入模式',
  'auxiliary.vision.provider': '图片理解提供商',
  'auxiliary.vision.model': '图片理解模型',
  'auxiliary.vision.base_url': '图片理解 Base URL',
  'auxiliary.vision.timeout': '图片理解超时（秒）',
  'auxiliary.vision.download_timeout': '图片下载超时（秒）',
  'auxiliary.compression.provider': '上下文压缩提供商',
  'auxiliary.compression.model': '上下文压缩模型',
  'auxiliary.compression.base_url': '上下文压缩 Base URL',
  'auxiliary.compression.timeout': '上下文压缩超时（秒）',
  'auxiliary.approval.provider': '智能审批提供商',
  'auxiliary.approval.model': '智能审批模型',
  'auxiliary.approval.base_url': '智能审批 Base URL',
  'auxiliary.approval.timeout': '智能审批超时（秒）',
  'auxiliary.mcp.provider': 'MCP 辅助提供商',
  'auxiliary.mcp.model': 'MCP 辅助模型',
  'auxiliary.mcp.base_url': 'MCP 辅助 Base URL',
  'auxiliary.mcp.timeout': 'MCP 辅助超时（秒）',
  'auxiliary.title_generation.provider': '标题生成提供商',
  'auxiliary.title_generation.model': '标题生成模型',
  'auxiliary.title_generation.base_url': '标题生成 Base URL',
  'auxiliary.title_generation.timeout': '标题生成超时（秒）',
  'auxiliary.triage_specifier.provider': '任务规格提供商',
  'auxiliary.triage_specifier.model': '任务规格模型',
  'auxiliary.triage_specifier.base_url': '任务规格 Base URL',
  'auxiliary.triage_specifier.timeout': '任务规格超时（秒）',
  'auxiliary.kanban_decomposer.provider': '任务拆解提供商',
  'auxiliary.kanban_decomposer.model': '任务拆解模型',
  'auxiliary.kanban_decomposer.base_url': '任务拆解 Base URL',
  'auxiliary.kanban_decomposer.timeout': '任务拆解超时（秒）',
  'auxiliary.curator.provider': '技能整理提供商',
  'auxiliary.curator.model': '技能整理模型',
  'auxiliary.curator.base_url': '技能整 Base URL',
  'auxiliary.curator.timeout': '技能整理超时（秒）',
  'display.personality': '对话风格',
  'display.show_reasoning': '显示推理过程',
  'display.busy_input_mode': '运行中输入行为',
  'display.timestamps': '显示消息时间',
  'display.inline_diffs': '内联显示文件差异',
  'display.file_mutation_verifier': '文件改动验证',
  'terminal.cwd': '工作目录',
  'terminal.timeout': '命令默认超时（秒）',
  'terminal.auto_source_bashrc': '自动加载 Shell 配置',
  'approvals.mode': '危险操作确认',
  'approvals.gateway_timeout': '审批等待上限（秒）',
  'approvals.cron_mode': '定时任务危险操作策略',
  'browser.search_engine': '默认搜索引擎',
  'browser.allow_private_urls': '允许访问局域网地址',
  'checkpoints.enabled': '文件检查点',
  'checkpoints.max_snapshots': '最多保留检查点',
  'checkpoints.max_total_size_mb': '检查点空间上限（MB）',
  'checkpoints.auto_prune': '自动清理旧检查点',
  'checkpoints.retention_days': '检查点保留天数',
  'compression.enabled': '自动压缩上下文',
  'compression.threshold': '触发压缩比例',
  'compression.target_ratio': '压缩后保留比例',
  'compression.protect_last_n': '保护最近消息数',
  'compression.protect_first_n': '保护开头消息数',
  'compression.abort_on_summary_failure': '摘要失败时中止压缩',
  'memory.write_mode': '记忆写入方式',
  'memory.memory_char_limit': '项目记忆字符上限',
  'memory.user_char_limit': '用户资料字符上限',
  'delegation.model': '子代理模型',
  'delegation.provider': '子代理提供商',
  'delegation.base_url': '子代理 Base URL',
  'delegation.api_mode': '子代理 API 协议',
  'delegation.reasoning_effort': '子代理推理强度',
  'delegation.max_iterations': '子代理最大轮数',
  'delegation.child_timeout_seconds': '子代理超时（秒）',
  'delegation.max_concurrent_children': '同步子代理并发数',
  'delegation.max_async_children': '后台子代理并发数',
  'delegation.max_spawn_depth': '子代理最大层级',
  'delegation.orchestrator_enabled': '允许编排型子代理',
  'code_execution.mode': '代码执行隔离方式',
  'tools.tool_search.enabled': '按需加载工具',
  'tools.tool_search.threshold_pct': '工具搜索触发比例',
  'logging.level': '日志级别',
  'logging.max_size_mb': '单个日志上限（MB）',
  'logging.backup_count': '日志备份数量',
  'network.force_ipv4': '模型请求强制使用 IPv4',
  'sessions.auto_prune': '自动清理旧会话',
  'sessions.retention_days': '会话保留天数',
  'lsp.enabled': '启用语言服务器',
  'lsp.wait_mode': '诊断等待方式',
  'lsp.wait_timeout': '诊断等待秒数',
  'lsp.install_strategy': '语言服务器安装方式'
}

export const FIELD_DESCRIPTIONS: Record<string, string> = {
  'display.personality': '新会话的默认助手风格。',
  timezone: 'Fan 需要本地时间上下文时使用。留空则使用系统时区。',
  model_context_length: '设为 0 时由本机根据模型元数据自动检测。',
  'agent.reasoning_effort': '留空时使用所选模型提供商的默认值。',
  'agent.api_max_retries': '模型或网络发生临时错误时，Fan 在切换备用路线前的重试次数。',
  'agent.service_tier': '仅对支持相应服务档位的模型提供商生效。',
  'display.show_reasoning': '后端提供推理内容时显示推理段落。',
  'terminal.cwd': '工具和终端任务的默认项目目录。',
  'browser.search_engine': '新建会话的工作台浏览器会打开此搜索引擎主页；已有会话会恢复原标签，不受影响。',
  'browser.allow_private_urls': '允许浏览器访问 localhost、局域网设备和其它私有网络地址。',
  'approvals.mode': '每次确认:危险操作先征求你;智能判断:AI 评估风险,仅拦截真正危险的;从不确认:全部放行(毁灭性命令仍会被硬性拦截)。',
  'checkpoints.enabled': '文件编辑前创建可回滚的快照。',
  'compression.threshold': '上下文占用达到该比例时开始自动压缩，例如 0.5 表示 50%。',
  'compression.target_ratio': '压缩完成后作为近期原文保留的上下文比例。',
  'memory.write_mode': '“确认”会在写入长期记忆前征求许可；“关闭”会禁用记忆写入。',
  'delegation.base_url': '用于子代理的 OpenAI 兼容端点；凭据仍应通过专用 Provider 配置管理。',
  'delegation.provider': '留空时继承主模型提供商。',
  'delegation.model': '留空时继承主模型。',
  'code_execution.mode': '项目模式可使用当前项目依赖；严格模式在隔离临时目录中执行。',
  'network.force_ipv4': '在 IPv6 连接不稳定的网络中可避免模型请求长时间等待。',
  'sessions.auto_prune': '只会清理已结束且超过保留期的本机会话。'
}

export const FIELD_TOOLTIPS: Record<string, string> = {
  'browser.search_engine': '决定工作台浏览器新开标签或新会话默认使用哪个搜索引擎；不会改动已经打开的标签。',
  'terminal.cwd': 'Fan 执行文件、终端和代码相关任务时默认进入的目录。通常设置为你的项目根目录。',
  'approvals.mode': '删除文件、系统级命令等危险操作的确认策略。无论选哪档，格盘、关机等毁灭性命令都会被硬性拦截。',
  'checkpoints.enabled': '开启后，Fan 在修改文件前会创建可回滚快照。占用少量本地空间，但更容易撤销误改。'
}

export const APPEARANCE_TOOLTIPS: Record<'colorMode', string> = {
  colorMode: '控制 Fan 的明暗外观。选择“系统”时会跟随 macOS 或 Windows 的系统外观。'
}

// Open-source desktop exposes an explicit, reviewed subset of the local config
// schema. Object-shaped internals, shell allowlists, raw secrets/API keys and
// loopback capability tokens intentionally stay out of this generic editor.
export const SECTIONS: DesktopConfigSection[] = [
  {
    id: 'chat',
    label: '聊天',
    icon: MessageCircle,
    keys: [
      'display.personality',
      'timezone',
      'display.show_reasoning',
      'display.busy_input_mode',
      'display.timestamps'
    ]
  },
  {
    id: 'model-runtime',
    label: '模型高级设置',
    icon: Brain,
    keys: [
      'model_context_length',
      'agent.reasoning_effort',
      'agent.service_tier',
      'agent.api_max_retries',
      'agent.max_turns',
      'agent.image_input_mode',
      'agent.environment_probe',
      'agent.task_completion_guidance'
    ]
  },
  {
    id: 'auxiliary',
    label: '辅助模型',
    icon: Cpu,
    // Keep this list explicit: credential and arbitrary-object fields
    // (`api_key`, `extra_body`) stay hidden.
    keys: [
      'auxiliary.vision.provider',
      'auxiliary.vision.model',
      'auxiliary.vision.base_url',
      'auxiliary.vision.timeout',
      'auxiliary.vision.download_timeout',
      'auxiliary.compression.provider',
      'auxiliary.compression.model',
      'auxiliary.compression.base_url',
      'auxiliary.compression.timeout',
      'auxiliary.approval.provider',
      'auxiliary.approval.model',
      'auxiliary.approval.base_url',
      'auxiliary.approval.timeout',
      'auxiliary.mcp.provider',
      'auxiliary.mcp.model',
      'auxiliary.mcp.base_url',
      'auxiliary.mcp.timeout',
      'auxiliary.title_generation.provider',
      'auxiliary.title_generation.model',
      'auxiliary.title_generation.base_url',
      'auxiliary.title_generation.timeout',
      'auxiliary.triage_specifier.provider',
      'auxiliary.triage_specifier.model',
      'auxiliary.triage_specifier.base_url',
      'auxiliary.triage_specifier.timeout',
      'auxiliary.kanban_decomposer.provider',
      'auxiliary.kanban_decomposer.model',
      'auxiliary.kanban_decomposer.base_url',
      'auxiliary.kanban_decomposer.timeout',
      'auxiliary.curator.provider',
      'auxiliary.curator.model',
      'auxiliary.curator.base_url',
      'auxiliary.curator.timeout'
    ]
  },
  {
    id: 'appearance',
    label: '外观',
    icon: Palette,
    keys: []
  },
  {
    id: 'workspace',
    label: '工作区',
    icon: Monitor,
    keys: ['browser.search_engine', 'browser.allow_private_urls', 'terminal.cwd', 'terminal.timeout', 'terminal.auto_source_bashrc']
  },
  {
    id: 'safety',
    label: '安全',
    icon: Lock,
    keys: [
      'approvals.mode',
      'approvals.gateway_timeout',
      'approvals.cron_mode',
      'checkpoints.enabled',
      'checkpoints.max_snapshots',
      'checkpoints.max_total_size_mb',
      'checkpoints.auto_prune',
      'checkpoints.retention_days'
    ]
  },
  {
    id: 'context',
    label: '上下文与记忆',
    icon: Layers3,
    keys: [
      'compression.enabled',
      'compression.threshold',
      'compression.target_ratio',
      'compression.protect_last_n',
      'compression.protect_first_n',
      'compression.abort_on_summary_failure',
      'memory.write_mode',
      'memory.memory_char_limit',
      'memory.user_char_limit'
    ]
  },
  {
    id: 'delegation',
    label: '子代理',
    icon: Cpu,
    keys: [
      'delegation.provider',
      'delegation.model',
      'delegation.base_url',
      'delegation.api_mode',
      'delegation.reasoning_effort',
      'delegation.max_iterations',
      'delegation.child_timeout_seconds',
      'delegation.max_concurrent_children',
      'delegation.max_async_children',
      'delegation.max_spawn_depth',
      'delegation.orchestrator_enabled'
    ]
  },
  {
    id: 'tools',
    label: '工具与执行',
    icon: Terminal,
    keys: [
      'code_execution.mode',
      'tools.tool_search.enabled',
      'tools.tool_search.threshold_pct',
      'display.inline_diffs',
      'display.file_mutation_verifier',
      'lsp.enabled',
      'lsp.wait_mode',
      'lsp.wait_timeout',
      'lsp.install_strategy'
    ]
  },
  {
    id: 'maintenance',
    label: '日志与维护',
    icon: FileText,
    keys: [
      'logging.level',
      'logging.max_size_mb',
      'logging.backup_count',
      'network.force_ipv4',
      'sessions.auto_prune',
      'sessions.retention_days'
    ]
  }
]

export const SETTINGS_NAV_SECTIONS = SECTIONS

export interface ModeOption {
  id: ThemeMode
  label: string
  icon: IconComponent
}

export const MODE_OPTIONS: ModeOption[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '系统', icon: Monitor }
]

export interface LanguageOption {
  id: DesktopLanguage
  label: string
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: '英文' }
]
