import { normalizeExternalUrl } from '@/lib/external-link'
import { extractToolErrorMessage, formatToolResultSummary } from '@/lib/tool-result-summary'

type ToolTone = 'agent' | 'browser' | 'default' | 'file' | 'image' | 'terminal'
export type ToolStatus = 'error' | 'running' | 'success' | 'warning'

export interface ToolPart {
  args?: unknown
  isError?: boolean
  result?: unknown
  toolCallId?: string
  toolName: string
  type: 'tool-call'
}

interface CountMetric {
  count: number
  noun: string
}

export interface ToolView {
  countLabel?: string
  detail: string
  detailLabel: string
  durationLabel?: string
  icon?: string
  imageUrl?: string
  inlineDiff: string
  previewTarget?: string
  rawArgs: string
  rawResult: string
  /** Set for tools whose output naturally contains ANSI escape codes
   *  (terminal/execute_code) so the renderer knows to run them through
   *  the ANSI parser instead of printing them as literals. */
  rendersAnsi?: boolean
  /** When the backend reports stderr as a separate stream (terminal /
   *  execute_code), the renderer shows it as its own labeled, neutrally
   *  tinted block under stdout — distinct from an error tone. */
  stderr?: string
  /** When set, the renderer uses stdout+stderr as separate sections and
   *  ignores the merged `detail`. */
  stdout?: string
  status: ToolStatus
  subtitle: string
  title: string
  tone: ToolTone
}

interface ToolMeta {
  done: string
  icon?: string
  pending: string
  tone: ToolTone
}

export interface MessageRunningStateSlice {
  message: {
    status?: {
      type?: string
    }
  }
  thread: {
    isRunning: boolean
  }
}

const TOOL_META: Record<string, ToolMeta> = {
  browser_click: { done: '已点击页面元素', pending: '正在点击页面元素', icon: 'globe', tone: 'browser' },
  browser_fill_form: { done: '已填写表单', pending: '正在填写表单', icon: 'globe', tone: 'browser' },
  browser_handoff: { done: '已交接浏览器操作', pending: '正在交接浏览器操作', icon: 'globe', tone: 'browser' },
  browser_navigate: { done: '已打开页面', pending: '正在打开页面', icon: 'globe', tone: 'browser' },
  browser_run: { done: '已运行浏览器工作流', pending: '正在运行浏览器工作流', icon: 'globe', tone: 'browser' },
  browser_snapshot: { done: '已读取页面快照', pending: '正在读取页面快照', icon: 'globe', tone: 'browser' },
  browser_type: { done: '已在页面上输入', pending: '正在页面上输入', icon: 'globe', tone: 'browser' },
  collect: { done: '已收集信息', pending: '正在等待用户提供信息', icon: 'tools', tone: 'agent' },
  cronjob: { done: '已设置定时任务', pending: '正在设置定时任务', icon: 'tools', tone: 'agent' },
  delegate_task: { done: '已派发子任务', pending: '正在派发子任务', icon: 'tools', tone: 'agent' },
  browser_back: { done: '已返回上一页', pending: '正在返回', icon: 'globe', tone: 'browser' },
  browser_cdp: { done: '已执行浏览器指令', pending: '正在执行浏览器指令', icon: 'globe', tone: 'browser' },
  browser_close_tab: { done: '已关闭标签页', pending: '正在关闭标签页', icon: 'globe', tone: 'browser' },
  browser_dialog: { done: '已处理对话框', pending: '正在处理对话框', icon: 'globe', tone: 'browser' },
  browser_drag: { done: '已拖拽', pending: '正在拖拽', icon: 'globe', tone: 'browser' },
  browser_dropdown_options: { done: '已读取下拉选项', pending: '正在读取下拉选项', icon: 'globe', tone: 'browser' },
  browser_element: { done: '已检查元素', pending: '正在检查元素', icon: 'globe', tone: 'browser' },
  browser_evaluate: { done: '已执行页面脚本', pending: '正在执行页面脚本', icon: 'globe', tone: 'browser' },
  browser_evaluate_js: { done: '已执行页面脚本', pending: '正在执行页面脚本', icon: 'globe', tone: 'browser' },
  browser_events: { done: '已读取浏览器事件', pending: '正在读取浏览器事件', icon: 'globe', tone: 'browser' },
  browser_find_elements: { done: '已查找元素', pending: '正在查找元素', icon: 'globe', tone: 'browser' },
  browser_find_visual: { done: '已视觉定位并点击', pending: '正在视觉定位元素', icon: 'globe', tone: 'browser' },
  browser_focus: { done: '已聚焦元素', pending: '正在聚焦元素', icon: 'globe', tone: 'browser' },
  browser_forward: { done: '已前进', pending: '正在前进', icon: 'globe', tone: 'browser' },
  browser_grant_permissions: { done: '已授予网站权限', pending: '正在授予网站权限', icon: 'globe', tone: 'browser' },
  browser_har: { done: '已读取网络记录', pending: '正在读取网络记录', icon: 'globe', tone: 'browser' },
  browser_highlight: { done: '已高亮元素', pending: '正在高亮元素', icon: 'globe', tone: 'browser' },
  browser_hover: { done: '已悬停', pending: '正在悬停', icon: 'globe', tone: 'browser' },
  browser_load_storage_state: { done: '已载入登录状态', pending: '正在载入登录状态', icon: 'globe', tone: 'browser' },
  browser_mouse: { done: '已移动鼠标', pending: '正在移动鼠标', icon: 'globe', tone: 'browser' },
  browser_network_config: { done: '已配置网络', pending: '正在配置网络', icon: 'globe', tone: 'browser' },
  browser_new_tab: { done: '已打开新标签页', pending: '正在打开新标签页', icon: 'globe', tone: 'browser' },
  browser_observe: { done: '已查看页面', pending: '正在查看页面', icon: 'globe', tone: 'browser' },
  browser_page_content: { done: '已读取页面内容', pending: '正在读取页面内容', icon: 'globe', tone: 'browser' },
  browser_reload: { done: '已刷新页面', pending: '正在刷新页面', icon: 'globe', tone: 'browser' },
  browser_save_har: { done: '已保存网络记录', pending: '正在保存网络记录', icon: 'globe', tone: 'browser' },
  browser_save_pdf: { done: '已保存 PDF', pending: '正在保存 PDF', icon: 'file-media', tone: 'browser' },
  browser_save_storage_state: { done: '已保存登录状态', pending: '正在保存登录状态', icon: 'globe', tone: 'browser' },
  browser_screenshot: { done: '已截图', pending: '正在截图', icon: 'file-media', tone: 'browser' },
  browser_scroll: { done: '已滚动页面', pending: '正在滚动页面', icon: 'globe', tone: 'browser' },
  browser_scroll_to_text: { done: '已滚动到文本', pending: '正在查找文本', icon: 'globe', tone: 'browser' },
  browser_search: { done: '已搜索', pending: '正在搜索', icon: 'globe', tone: 'browser' },
  browser_search_page: { done: '已在页面内查找', pending: '正在页面内查找', icon: 'globe', tone: 'browser' },
  browser_select: { done: '已选择选项', pending: '正在选择选项', icon: 'globe', tone: 'browser' },
  browser_send_keys: { done: '已按键', pending: '正在按键', icon: 'globe', tone: 'browser' },
  browser_set_viewport: { done: '已设置视口', pending: '正在设置视口', icon: 'globe', tone: 'browser' },
  browser_settle: { done: '已等待页面稳定', pending: '正在等待页面稳定', icon: 'globe', tone: 'browser' },
  browser_start_screencast: { done: '已开始录屏', pending: '正在开始录屏', icon: 'file-media', tone: 'browser' },
  browser_stop_screencast: { done: '已停止录屏', pending: '正在停止录屏', icon: 'file-media', tone: 'browser' },
  browser_storage_state: { done: '已读取存储状态', pending: '正在读取存储状态', icon: 'globe', tone: 'browser' },
  browser_switch_tab: { done: '已切换标签页', pending: '正在切换标签页', icon: 'globe', tone: 'browser' },
  browser_target_info: { done: '已读取标签信息', pending: '正在读取标签信息', icon: 'globe', tone: 'browser' },
  browser_targets: { done: '已读取标签列表', pending: '正在读取标签列表', icon: 'globe', tone: 'browser' },
  browser_upload: { done: '已上传文件', pending: '正在上传文件', icon: 'globe', tone: 'browser' },
  browser_url_policy: { done: '已设置访问策略', pending: '正在设置访问策略', icon: 'globe', tone: 'browser' },
  browser_wait: { done: '已等待', pending: '正在等待', icon: 'globe', tone: 'browser' },
  edit_file: { done: '已编辑文件', pending: '正在编辑文件', icon: 'edit', tone: 'file' },
  execute_code: { done: '已运行代码', pending: '正在运行代码', icon: 'terminal', tone: 'terminal' },
  fact_feedback: { done: '已更新记忆可信度', pending: '正在更新记忆可信度', icon: 'tools', tone: 'agent' },
  fact_store: { done: '已处理事实记忆', pending: '正在处理事实记忆', icon: 'tools', tone: 'agent' },
  kanban_block: { done: '已标记任务受阻', pending: '正在标记任务受阻', icon: 'tools', tone: 'agent' },
  kanban_comment: { done: '已评论任务', pending: '正在评论任务', icon: 'tools', tone: 'agent' },
  kanban_complete: { done: '已完成任务', pending: '正在完成任务', icon: 'tools', tone: 'agent' },
  kanban_create: { done: '已创建任务', pending: '正在创建任务', icon: 'tools', tone: 'agent' },
  kanban_heartbeat: { done: '已更新任务进度', pending: '正在更新任务进度', icon: 'tools', tone: 'agent' },
  kanban_link: { done: '已关联任务', pending: '正在关联任务', icon: 'tools', tone: 'agent' },
  kanban_list: { done: '已列出任务', pending: '正在列出任务', icon: 'tools', tone: 'agent' },
  kanban_show: { done: '已查看任务看板', pending: '正在查看任务看板', icon: 'tools', tone: 'agent' },
  kanban_unblock: { done: '已解除任务受阻', pending: '正在解除任务受阻', icon: 'tools', tone: 'agent' },
  list_files: { done: '已列出文件', pending: '正在列出文件', icon: 'files', tone: 'file' },
  memory: { done: '已更新记忆', pending: '正在更新记忆', icon: 'tools', tone: 'agent' },
  patch: { done: '已修改文件', pending: '正在修改文件', icon: 'edit', tone: 'file' },
  process: { done: '已管理进程', pending: '正在管理进程', icon: 'terminal', tone: 'terminal' },
  read_file: { done: '已读取文件', pending: '正在读取文件', icon: 'file', tone: 'file' },
  search_files: { done: '已搜索文件', pending: '正在搜索文件', icon: 'search', tone: 'file' },
  session_search: { done: '已搜索会话历史', pending: '正在搜索会话历史', icon: 'search', tone: 'agent' },
  session_search_recall: {
    done: '已搜索会话历史',
    pending: '正在搜索会话历史',
    icon: 'search',
    tone: 'agent'
  },
  skill_manage: { done: '已管理技能', pending: '正在管理技能', icon: 'tools', tone: 'agent' },
  skill_view: { done: '已查看技能', pending: '正在查看技能', icon: 'tools', tone: 'agent' },
  skills_list: { done: '已列出技能', pending: '正在列出技能', icon: 'search', tone: 'agent' },
  terminal: { done: '已执行命令', pending: '正在执行命令', icon: 'terminal', tone: 'terminal' },
  todo: { done: '已更新待办事项', pending: '正在更新待办事项', icon: 'tools', tone: 'agent' },
  vision_analyze: { done: '已分析图像', pending: '正在分析图像', icon: 'file-media', tone: 'image' },
  write_file: { done: '已编辑文件', pending: '正在编辑文件', icon: 'edit', tone: 'file' }
}

const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g
const CITATION_MARKER_RE = /(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:\d+(?:\s*,\s*\d+)*)\](?!\()/gu
const BACKTICK_NOISE_RE = /`{3,}/g

export const selectMessageRunning = (state: MessageRunningStateSlice) =>
  state.thread.isRunning && state.message.status?.type === 'running'

function titleForTool(name: string): string {
  const normalized = name.replace(/^browser_/, '')

  return (
    normalized
      .split('_')
      .filter(Boolean)
      .map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
      .join(' ') || name
  )
}

const PREFIX_META: { icon?: string; prefix: string; tone: ToolTone; verb: string }[] = [
  { prefix: 'browser_', verb: '浏览器', icon: 'globe', tone: 'browser' }
]

function toolMeta(name: string): ToolMeta {
  if (TOOL_META[name]) {
    return TOOL_META[name]
  }

  const action = titleForTool(name)
  const prefix = PREFIX_META.find(p => name.startsWith(p.prefix))

  return prefix
    ? {
        done: `${prefix.verb} ${action}`,
        pending: `正在运行 ${prefix.verb} ${action}`,
        icon: prefix.icon,
        tone: prefix.tone
      }
    : { done: action, pending: `正在运行 ${action}`, tone: 'default' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function compactPreview(value: unknown, max = 72): string {
  let raw: unknown

  if (typeof value === 'string') {
    raw = value
  } else {
    raw = parseMaybeObject(value).context
  }

  if (typeof raw !== 'string') {
    if (raw == null) {
      raw = ''
    } else {
      try {
        raw = JSON.stringify(raw)
      } catch {
        raw = String(raw)
      }
    }
  }

  const line = (raw as string).replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function contextValue(value: unknown): string {
  const row = parseMaybeObject(value)

  if (typeof row.context === 'string') {
    return row.context
  }

  if (typeof row.preview === 'string') {
    return row.preview
  }

  return typeof value === 'string' ? value : ''
}

// Each tool result is server-capped, but a turn over a large directory can
// still stack enough rows to freeze the renderer. Bound inline technical
// payloads; the regular Copy action keeps using the uncapped detail text.
export const MAX_TOOL_RENDER_CHARS = 20_000

export function clampForDisplay(value: string, max = MAX_TOOL_RENDER_CHARS): string {
  if (value.length <= max) {
    return value
  }

  const omitted = value.length - max

  return `${value.slice(0, max)}\n\n… ${omitted.toLocaleString()} more characters truncated — use Copy for the full output.`
}

function prettyJson(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)

  return clampForDisplay(raw ?? '')
}

function parseMaybeObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value
  }

  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)

    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function unwrapToolPayload(value: unknown): unknown {
  const record = parseMaybeObject(value)

  for (const key of ['data', 'result', 'output', 'response', 'payload']) {
    const payload = record[key]

    if (payload !== undefined && payload !== null) {
      return payload
    }
  }

  return value
}

function numberValue(value: unknown): null | number {
  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) ? n : null
}

function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return ''
  }

  if (seconds < 1) {
    const ms = Math.max(1, Math.round(seconds * 1000))

    return `${ms}ms`
  }

  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`
  }

  const wholeSeconds = Math.round(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remSeconds = wholeSeconds % 60

  if (minutes < 60) {
    return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60

  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`
}

const COUNT_FIELD_KEYS = [
  'count',
  'total',
  'result_count',
  'results_count',
  'num_results',
  'match_count',
  'matches_count',
  'file_count',
  'files_count',
  'item_count',
  'items_count',
  'search_count',
  'searches_count',
  'source_count',
  'sources_count',
  'document_count',
  'documents_count',
  'updated',
  'added',
  'removed',
  'deleted',
  'created',
  'changed',
  'processed',
  'steps'
] as const

const COUNT_ARRAY_KEYS = ['results', 'items', 'matches', 'files', 'documents', 'sources', 'rows'] as const

const COUNT_EXCLUDED_KEYS = new Set(['duration_s', 'exit_code', 'status_code'])

// Count-label nouns are Chinese measure-word phrases (个项/条/份…). They're
// rendered verbatim by formatCountLabel as `${count} ${noun}` (e.g. "3 项结果"),
// so no English pluralization is applied to them.
const COUNT_NOUN_BY_FIELD: Partial<Record<(typeof COUNT_FIELD_KEYS)[number], string>> = {
  count: '项',
  total: '项',
  result_count: '项结果',
  results_count: '项结果',
  num_results: '项结果',
  match_count: '处匹配',
  matches_count: '处匹配',
  file_count: '个文件',
  files_count: '个文件',
  item_count: '项',
  items_count: '项',
  search_count: '次搜索',
  searches_count: '次搜索',
  source_count: '个来源',
  sources_count: '个来源',
  document_count: '个文档',
  documents_count: '个文档',
  updated: '项',
  added: '项',
  removed: '项',
  deleted: '项',
  created: '项',
  changed: '项',
  processed: '项',
  steps: '步'
}

const COUNT_NOUN_BY_ARRAY: Record<(typeof COUNT_ARRAY_KEYS)[number], string> = {
  documents: '个文档',
  files: '个文件',
  items: '项',
  matches: '处匹配',
  results: '项结果',
  rows: '行',
  sources: '个来源'
}

const DEFAULT_COUNT_NOUN_BY_TOOL: Record<string, string> = {
  list_files: '个文件',
  search_files: '项结果',
  session_search_recall: '项结果',
  todo: '项待办'
}

function countFromUnknown(value: unknown): null | number {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.length : null
  }

  const n = numberValue(value)

  if (n === null || n <= 0) {
    return null
  }

  return Math.round(n)
}

// Maps an English unit word found in backend summary text to its Chinese
// measure-word phrase, so a result count surfaces in the UI as e.g. "5 个文件".
const EN_UNIT_TO_CN_NOUN: Record<string, string> = {
  result: '项结果',
  item: '项',
  file: '个文件',
  match: '处匹配',
  document: '个文档',
  source: '个来源',
  search: '次搜索',
  step: '步',
  row: '行'
}

function singularizeNoun(noun: string): string {
  const trimmed = noun.trim()

  if (!trimmed) {
    return ''
  }

  // Chinese (or any non-ASCII) measure-word phrases pass through untouched —
  // the English singularization rules below only apply to ASCII unit words.
  if (Array.from(trimmed).some(char => (char.codePointAt(0) || 0) > 0x7f)) {
    return trimmed
  }

  const normalized = trimmed.toLowerCase().replace(/s$/, '')

  return EN_UNIT_TO_CN_NOUN[normalized] || '项'
}

function formatCountLabel(metric: CountMetric): string {
  return `${metric.count} ${metric.noun}`
}

function countMetric(count: number, noun: string): CountMetric {
  return { count, noun: singularizeNoun(noun) || '项' }
}

function fallbackCountNoun(toolName: string): string {
  return DEFAULT_COUNT_NOUN_BY_TOOL[toolName] || '项'
}

function dynamicCountNounFromKey(key: string, fallbackNoun: string): string {
  const normalized = key.toLowerCase()

  if (normalized === 'count' || normalized === 'total') {
    return fallbackNoun
  }

  const stripped = normalized.replace(/_(count|total)$/i, '').replace(/^num_/, '')

  return singularizeNoun(stripped) || fallbackNoun
}

function countFromRecord(record: Record<string, unknown>, fallbackNoun: string): CountMetric | null {
  for (const key of COUNT_FIELD_KEYS) {
    const value = record[key]
    const count = countFromUnknown(value)

    if (count !== null) {
      return countMetric(count, COUNT_NOUN_BY_FIELD[key] || fallbackNoun)
    }
  }

  for (const key of COUNT_ARRAY_KEYS) {
    const value = record[key]
    const count = countFromUnknown(value)

    if (count !== null) {
      return countMetric(count, COUNT_NOUN_BY_ARRAY[key] || fallbackNoun)
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (COUNT_EXCLUDED_KEYS.has(key)) {
      continue
    }

    if (!/_count$|_total$/i.test(key)) {
      continue
    }

    const count = countFromUnknown(value)

    if (count !== null) {
      return countMetric(count, dynamicCountNounFromKey(key, fallbackNoun))
    }
  }

  return null
}

function countFromText(value: string, fallbackNoun: string): CountMetric | null {
  const text = value.trim()

  if (!text) {
    return null
  }

  const unitMatch =
    text.match(/\b(\d+)\s+(results?|items?|files?|matches?|documents?|sources?|searches?|steps?|rows?)\b/i) ||
    text.match(/\b(?:did|found|returned|listed|searched|matched|updated|created|deleted|processed)\s+(\d+)\b/i)

  if (unitMatch?.[1]) {
    const n = Number(unitMatch[1])
    const noun = unitMatch[2] ? singularizeNoun(unitMatch[2]) : fallbackNoun

    return Number.isFinite(n) && n > 0 ? countMetric(Math.round(n), noun) : null
  }

  return null
}

function toolResultCount(
  part: ToolPart,
  argsRecord: Record<string, unknown>,
  resultRecord: Record<string, unknown>
): CountMetric | null {
  if (part.result === undefined) {
    return null
  }

  const fallbackNounByTool = fallbackCountNoun(part.toolName)

  const directCount = countFromRecord(resultRecord, fallbackNounByTool)

  if (directCount !== null) {
    return directCount
  }

  const payload = unwrapToolPayload(part.result)

  if (isRecord(payload)) {
    const payloadCount = countFromRecord(payload, fallbackNounByTool)

    if (payloadCount !== null) {
      return payloadCount
    }
  }

  const summaryText =
    firstStringField(resultRecord, ['summary', 'message', 'detail']) || fallbackDetailText(argsRecord, resultRecord)

  const textMetric = countFromText(summaryText, fallbackNounByTool)

  return textMetric
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function looksLikePath(value: string): boolean {
  return /^file:\/\//i.test(value) || /^(?:\/|\.{1,2}\/|~\/).+/.test(value)
}

export function isPreviewableTarget(target: string): boolean {
  return Boolean(
    target &&
    (/^file:\/\//i.test(target) ||
      /^(?:\/|\.{1,2}\/|~\/).+\.html?$/i.test(target) ||
      /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(target))
  )
}

function stableHash(value: string): string {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index)
  }

  return Math.abs(hash).toString(36)
}

export function toolPartDisclosureId(part: ToolPart): string {
  if (part.toolCallId) {
    return `tool:${part.toolCallId}`
  }

  return `tool:${part.toolName}:${stableHash(JSON.stringify(part.args ?? ''))}`
}

const URL_PATTERN = /https?:\/\/[^\s'"<>)\]]+/i

function findFirstUrl(...sources: unknown[]): string {
  for (const src of sources) {
    if (typeof src === 'string') {
      const m = src.match(URL_PATTERN)

      if (m) {
        return m[0]
      }
    } else if (src && typeof src === 'object') {
      for (const v of Object.values(src as Record<string, unknown>)) {
        const found = findFirstUrl(v)

        if (found) {
          return found
        }
      }
    }
  }

  return ''
}

function hostnameOf(value: string): string {
  try {
    const url = new URL(value)

    return `${url.hostname}${url.pathname && url.pathname !== '/' ? url.pathname : ''}`
  } catch {
    return value
  }
}

export function looksRedundant(title: string, detail: string): boolean {
  if (!detail) {
    return true
  }

  const norm = (input: string) => input.toLowerCase().replace(/\s+/g, ' ').trim()

  return norm(title) === norm(detail)
}

export function cleanVisibleText(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part =>
      part.startsWith('`')
        ? part
        : part
            .replace(BACKTICK_NOISE_RE, '')
            .replace(CITATION_MARKER_RE, '')
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
              const normalized = normalizeExternalUrl(href)

              return `${label} ${normalized}`
            })
    )
    .join('')
}

function firstStringField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function toolErrorText(part: ToolPart, result: Record<string, unknown>): string {
  const expectedTerminalExit = part.toolName === 'terminal' && result.exit_code_expected === true
  const extractedError = expectedTerminalExit ? '' : extractToolErrorMessage(part.result)

  if (part.isError && !expectedTerminalExit) {
    return extractedError || (typeof part.result === 'string' && part.result.trim()) || '工具返回了错误。'
  }

  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim()
  }

  if (extractedError) {
    return extractedError
  }

  if (result.success === false || result.ok === false) {
    return firstStringField(result, ['message', 'reason', 'detail']) || '工具返回 success=false。'
  }

  if (typeof result.status === 'string' && /\b(error|failed|failure)\b/i.test(result.status)) {
    return firstStringField(result, ['message', 'reason', 'detail']) || `工具返回状态 "${result.status}"。`
  }

  const exit = numberValue(result.exit_code)

  return exit !== null && exit !== 0 && !expectedTerminalExit ? `命令以退出代码 ${exit} 失败。` : ''
}

function browserNonExecution(result: Record<string, unknown>): Record<string, unknown> | null {
  const nested = isRecord(result.result) ? result.result : null

  for (const candidate of [result, nested]) {
    if (!candidate) {
      continue
    }

    if (candidate.executed === false || candidate.replan_required === true || candidate.status === 'skipped') {
      return candidate
    }
  }

  return null
}

function browserObservedPageTransition(
  result: Record<string, unknown>,
  nonExecution: Record<string, unknown> | null
): boolean {
  if (
    !nonExecution ||
    nonExecution.executed !== false ||
    nonExecution.replan_required !== true ||
    nonExecution.code !== 'STALE_ELEMENT_REFERENCE' ||
    result.recovery_outcome !== 'superseded_by_page_transition'
  ) {
    return false
  }

  const dom = typeof result.dom === 'string' ? result.dom : ''
  const stateChanges = Array.isArray(nonExecution.state_changes) ? nonExecution.state_changes : []

  return (
    stateChanges.includes('active-tab') && dom.includes('<page_observation>') && dom.includes('</page_observation>')
  )
}

function isObservedPageTransitionPart(part: ToolPart): boolean {
  if (!part.toolName.startsWith('browser_')) {
    return false
  }

  const result = parseMaybeObject(part.result)

  return browserObservedPageTransition(result, browserNonExecution(result))
}

type BrowserRunReplanKind = 'effect' | 'human-completed' | 'none' | 'uncertain' | 'unknown'

function browserHumanVerificationCompleted(
  result: Record<string, unknown>,
  nonExecution: Record<string, unknown> | null
): boolean {
  const nested = isRecord(result.result) ? result.result : null

  for (const candidate of [nonExecution, result, nested]) {
    const humanStep =
      candidate && isRecord(candidate.human_step)
        ? candidate.human_step
        : candidate && isRecord(candidate.humanStep)
          ? candidate.humanStep
          : null

    if (
      humanStep?.kind === 'verification' &&
      humanStep.status === 'completed' &&
      humanStep.authoritative === true &&
      humanStep.verificationCleared === true
    ) {
      return true
    }
  }

  return false
}

function browserRunReplanKind(
  part: ToolPart,
  result: Record<string, unknown>,
  nonExecution: Record<string, unknown> | null
): BrowserRunReplanKind | null {
  if (part.toolName !== 'browser_run' || nonExecution?.replan_required !== true) {
    return null
  }

  if (browserHumanVerificationCompleted(result, nonExecution)) {
    return 'human-completed'
  }

  const nested = isRecord(result.result) ? result.result : null
  let runEffect: Record<string, unknown> | null = null

  for (const candidate of [nonExecution, result, nested]) {
    if (!candidate) {
      continue
    }

    const value = isRecord(candidate.run_effect)
      ? candidate.run_effect
      : isRecord(candidate.runEffect)
        ? candidate.runEffect
        : null

    if (value) {
      runEffect = value

      break
    }
  }

  if (!runEffect) {
    return 'unknown'
  }

  if (runEffect.uncertain === true) {
    return 'uncertain'
  }

  return runEffect.occurred === true ? 'effect' : 'none'
}

function nonExecutionTitle(
  part: ToolPart,
  meta: ToolMeta,
  result: Record<string, unknown>,
  nonExecution: Record<string, unknown>
): string {
  const replanKind = browserRunReplanKind(part, result, nonExecution)

  if (replanKind === 'human-completed') {
    return '人工验证已完成'
  }

  if (replanKind === 'effect') {
    return '浏览器工作流部分完成'
  }

  if (replanKind === 'uncertain') {
    return '浏览器操作结果待确认'
  }

  if (replanKind === 'unknown') {
    return '浏览器工作流需要重新规划'
  }

  return meta.done.startsWith('已') ? `未${meta.done.slice(1)}` : '浏览器操作未执行'
}

function nonExecutionReason(
  part: ToolPart,
  result: Record<string, unknown>,
  nonExecution: Record<string, unknown>
): string {
  const replanKind = browserRunReplanKind(part, result, nonExecution)

  if (replanKind === 'human-completed') {
    return '已确认验证完成，并读取验证后的最新页面。'
  }

  if (replanKind === 'effect') {
    return '部分操作已完成，页面状态已更新，需根据最新页面重新规划。'
  }

  if (replanKind === 'uncertain') {
    return '页面是否已更新暂时无法确认，需重新读取页面并规划。'
  }

  if (replanKind === 'none') {
    return '页面操作未执行，需根据最新页面状态重新规划。'
  }

  if (replanKind === 'unknown') {
    return '页面状态需要重新确认，需根据最新页面继续规划。'
  }

  const explicit = firstStringField(nonExecution, ['note', 'message', 'reason', 'detail'])

  if (explicit) {
    return explicit
  }

  return nonExecution.replan_required === true ? '操作未执行，需根据最新页面状态重新规划。' : '操作未执行。'
}

function nonExecutionDetailText(
  part: ToolPart,
  result: Record<string, unknown>,
  nonExecution: Record<string, unknown>
): string {
  const reason = nonExecutionReason(part, result, nonExecution)
  const replanKind = browserRunReplanKind(part, result, nonExecution)

  if (replanKind === 'human-completed') {
    return reason
  }

  const nested = isRecord(result.result) ? result.result : null

  const boundary =
    [nonExecution, result, nested]
      .map(candidate => (candidate && isRecord(candidate.boundary) ? candidate.boundary : null))
      .find(Boolean) ?? null

  const boundaryMessage = boundary ? firstStringField(boundary, ['message', 'reason', 'detail']) : ''

  const code =
    (boundary && firstStringField(boundary, ['code', 'error_code'])) ||
    firstStringField(nonExecution, ['code', 'error_code'])

  const diagnosticMessage = boundaryMessage && boundaryMessage !== reason ? boundaryMessage : ''
  const codeLine = code && !reason.includes(code) && !diagnosticMessage.includes(code) ? `诊断代码：${code}` : ''

  return [reason, diagnosticMessage, codeLine].filter(Boolean).join('\n\n')
}

function failureTitle(meta: ToolMeta): string {
  return meta.done.startsWith('已') ? `${meta.done.slice(1)}失败` : `${meta.done}失败`
}

function toolStatus(part: ToolPart, resultRecord: Record<string, unknown>): ToolStatus {
  if (part.result === undefined) {
    return 'running'
  }

  if (toolErrorText(part, resultRecord)) {
    return 'error'
  }

  if (part.toolName.startsWith('browser_')) {
    const nonExecution = browserNonExecution(resultRecord)

    if (browserObservedPageTransition(resultRecord, nonExecution)) {
      return 'success'
    }

    if (
      part.toolName === 'browser_run' &&
      browserHumanVerificationCompleted(resultRecord, nonExecution)
    ) {
      return 'success'
    }

    if (nonExecution) {
      return 'warning'
    }
  }

  return 'success'
}

function durationLabel(resultRecord: Record<string, unknown>): string | undefined {
  const seconds = numberValue(resultRecord.duration_s)

  if (seconds === null || seconds < 0) {
    return undefined
  }

  return formatDurationSeconds(seconds)
}

function toolPreviewTarget(toolName: string, args: Record<string, unknown>, result: Record<string, unknown>): string {
  const direct =
    firstStringField(result, ['preview', 'url', 'target']) ||
    firstStringField(args, ['preview', 'url', 'target', 'path', 'file', 'filepath']) ||
    firstStringField(result, ['path', 'file', 'filepath'])

  if (direct && (looksLikeUrl(direct) || looksLikePath(direct))) {
    return direct
  }

  if (toolName === 'browser_navigate') {
    const explicit = firstStringField(args, ['url', 'target']) || firstStringField(result, ['url'])

    return looksLikeUrl(explicit) ? explicit : findFirstUrl(args, result)
  }

  if (toolName === 'write_file' || toolName === 'edit_file') {
    return htmlPathFromInlineDiff(firstStringField(result, ['inline_diff']))
  }

  return ''
}

function toolImageUrl(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const candidate =
    firstStringField(result, ['image_url', 'url', 'path', 'image_path']) ||
    firstStringField(args, ['image_url', 'url', 'path'])

  if (!candidate) {
    return ''
  }

  // Only inline-render images the renderer can actually fetch: data URLs or
  // remote http(s). A bare filesystem path (e.g. vision_analyze's input image)
  // resolves against the dev-server origin and 404s — fall back to the tool's
  // codicon instead of a broken <img>.
  const isDataImage = candidate.toLowerCase().startsWith('data:image/')
  const isRemoteImage = /^https?:\/\//i.test(candidate) && /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(candidate)

  return isDataImage || isRemoteImage ? candidate : ''
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

export function stripInlineDiffChrome(value: string): string {
  return value
    ? stripAnsi(value)
        .replace(/^\s*┊\s*review diff\s*\n/i, '')
        .trim()
    : ''
}

function htmlPathFromInlineDiff(value: string): string {
  const cleaned = stripInlineDiffChrome(value)

  for (const match of cleaned.matchAll(/(?:^|\s)(?:[ab]\/)?([^\s]+\.html?)(?=\s|$)/gi)) {
    const candidate = match[1]?.trim()

    if (candidate) {
      return candidate
    }
  }

  return ''
}

function stripDividerLines(value: string): string {
  return value
    .split('\n')
    .filter(line => !/^[-=]{3,}\s*$/.test(line.trim()))
    .join('\n')
    .trim()
}

export function inlineDiffFromResult(result: unknown): string {
  const value = parseMaybeObject(result).inline_diff

  return typeof value === 'string' ? stripInlineDiffChrome(value) : ''
}

// Falls back to a string only when there's something concrete to render —
// counts of opaque items/fields are noise, not signal.
function minimalValueSummary(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return ''
}

function fallbackDetailText(args: unknown, result: unknown): string {
  const argContext = contextValue(args)
  const resultContext = contextValue(result)

  if (resultContext && resultContext !== argContext) {
    return resultContext
  }

  if (argContext) {
    return argContext
  }

  if (result !== undefined) {
    return formatToolResultSummary(result) || minimalValueSummary(result)
  }

  return formatToolResultSummary(args) || minimalValueSummary(args)
}

function toolSubtitle(
  part: ToolPart,
  argsRecord: Record<string, unknown>,
  resultRecord: Record<string, unknown>
): string {
  const toolName = part.toolName

  if (toolName === 'browser_navigate') {
    const url =
      firstStringField(argsRecord, ['url', 'target']) ||
      firstStringField(resultRecord, ['url']) ||
      findFirstUrl(argsRecord, resultRecord)

    return url ? hostnameOf(url) : '已在浏览器中导航'
  }

  if (toolName === 'browser_click') {
    const clicked =
      firstStringField(resultRecord, ['target', 'label', 'text']) ||
      firstStringField(argsRecord, ['expected_name', 'expected_text'])

    const index = numberValue(argsRecord.index)

    if (!clicked) {
      return index === null ? '已在页面上点击' : `已点击页面元素 #${index}`
    }

    return `已点击 ${clicked}`
  }

  if (toolName === 'browser_type') {
    const index = numberValue(argsRecord.index)
    const value = firstStringField(argsRecord, ['text'])

    return (
      [index !== null && `字段 #${index}`, value && `值: ${compactPreview(value, 42)}`].filter(Boolean).join(' · ') ||
      '已填写页面输入'
    )
  }

  if (toolName === 'browser_fill_form') {
    const fields = Array.isArray(argsRecord.fields) ? argsRecord.fields : []

    return fields.length > 0 ? `已填写 ${fields.length} 个表单字段` : '已填写表单'
  }

  if (toolName === 'terminal' || toolName === 'execute_code') {
    const output = firstStringField(resultRecord, ['output', 'stdout', 'stderr'])

    const lines = Array.isArray(resultRecord.lines)
      ? resultRecord.lines.filter((line): line is string => typeof line === 'string').join('\n')
      : ''

    const previewSource = (output || lines).trim()

    if (previewSource) {
      const firstMeaningfulLine = previewSource
        .split('\n')
        .map(line => line.trim())
        .find(line => line.length > 0)

      if (firstMeaningfulLine) {
        return compactPreview(firstMeaningfulLine, 160)
      }
    }

    const command = firstStringField(argsRecord, ['command', 'code']) || contextValue(argsRecord)

    return command ? compactPreview(command, 120) : '已执行命令'
  }

  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    const path =
      firstStringField(argsRecord, ['path', 'file', 'filepath']) ||
      htmlPathFromInlineDiff(firstStringField(resultRecord, ['inline_diff']))

    return (
      path ||
      (firstStringField(resultRecord, ['inline_diff']) ? '已更改文件' : fallbackDetailText(argsRecord, resultRecord))
    )
  }

  return (
    compactPreview(formatToolResultSummary(part.result), 120) ||
    compactPreview(resultRecord, 120) ||
    compactPreview(argsRecord, 120) ||
    fallbackDetailText(argsRecord, resultRecord)
  )
}

function toolDetailLabel(toolName: string): string {
  if (toolName === 'terminal' || toolName === 'execute_code') {
    return '命令输出'
  }

  return ''
}

function toolDetailText(
  part: ToolPart,
  argsRecord: Record<string, unknown>,
  resultRecord: Record<string, unknown>
): string {
  if (part.toolName === 'terminal' || part.toolName === 'execute_code') {
    // Streams are split out into ToolView.stdout / ToolView.stderr by
    // buildToolView so the renderer can label them separately. The merged
    // fallback here is only used when the backend doesn't expose either
    // stream individually.
    const output = firstStringField(resultRecord, ['output', 'stdout', 'stderr'])

    const lines = Array.isArray(resultRecord.lines)
      ? resultRecord.lines.filter((line): line is string => typeof line === 'string').join('\n')
      : ''

    if (output || lines) {
      return [output, lines].filter(Boolean).join('\n')
    }
  }

  if (part.toolName === 'read_file') {
    const content = firstStringField(resultRecord, ['content', 'text', 'data', 'body'])

    if (content) {
      return content
    }
  }

  if (part.toolName === 'write_file' || part.toolName === 'edit_file') {
    return inlineDiffFromResult(part.result) ? '' : fallbackDetailText(argsRecord, resultRecord)
  }

  return fallbackDetailText(argsRecord, resultRecord)
}

export function toolCopyPayload(part: ToolPart, view: ToolView): { label: string; text: string } {
  const args = parseMaybeObject(part.args)
  const result = parseMaybeObject(part.result)
  const detail = view.detail.trim()
  const hasSubstantialOutput = detail.length > 16

  if (part.toolName === 'terminal' || part.toolName === 'execute_code') {
    if (hasSubstantialOutput) {
      return { label: '复制输出', text: detail }
    }

    const command = firstStringField(args, ['command', 'code']) || contextValue(args)

    if (command) {
      return { label: '复制命令', text: command }
    }
  }

  if (part.toolName === 'browser_navigate') {
    const url = firstStringField(args, ['url', 'target']) || findFirstUrl(args, result)

    if (url) {
      return { label: '复制链接', text: url }
    }
  }

  if (part.toolName === 'read_file') {
    if (hasSubstantialOutput) {
      return { label: '复制文件', text: detail }
    }

    const path = firstStringField(args, ['path', 'file', 'filepath'])

    if (path) {
      return { label: '复制路径', text: path }
    }
  }

  if (part.toolName === 'write_file' || part.toolName === 'edit_file') {
    const path = firstStringField(args, ['path', 'file', 'filepath'])

    if (path) {
      return { label: '复制路径', text: path }
    }
  }

  if (detail) {
    return { label: '复制输出', text: detail }
  }

  return { label: '复制', text: view.title }
}

function dynamicTitle(
  part: ToolPart,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  fallback: string
): string {
  const verb = (gerund: string, past: string) => (part.result === undefined ? gerund : past)

  if (part.toolName === 'browser_navigate') {
    const url = findFirstUrl(args, result)

    return url ? `${verb('正在打开', '已打开')} ${hostnameOf(url)}` : fallback
  }

  if (part.toolName === 'browser_search') {
    const query = firstStringField(args, ['query'])

    return query ? `${verb('正在搜索', '已搜索')} ${compactPreview(query, 60)}` : fallback
  }

  if (part.toolName === 'browser_type') {
    const text = firstStringField(args, ['text'])

    return text ? `${verb('正在输入', '已输入')} ${compactPreview(text, 40)}` : fallback
  }

  if (part.toolName === 'terminal' || part.toolName === 'execute_code') {
    const command = firstStringField(args, ['command', 'code']) || contextValue(args)

    if (command) {
      const verbText =
        part.toolName === 'execute_code' ? verb('正在运行代码', '已运行代码') : verb('正在运行', '已运行')

      return `${verbText} · ${compactPreview(command, 160)}`
    }
  }

  return fallback
}

export function buildToolView(part: ToolPart, inlineDiff: string): ToolView {
  const argsRecord = parseMaybeObject(part.args)
  const resultRecord = parseMaybeObject(part.result)
  const meta = toolMeta(part.toolName)
  const status = toolStatus(part, resultRecord)
  const error = toolErrorText(part, resultRecord)

  const nonExecution = part.toolName.startsWith('browser_') ? browserNonExecution(resultRecord) : null
  const pageTransition = browserObservedPageTransition(resultRecord, nonExecution)

  const baseTitle =
    part.result === undefined
      ? meta.pending
      : error
        ? failureTitle(meta)
        : pageTransition
          ? '页面已切换'
          : nonExecution
            ? nonExecutionTitle(part, meta, resultRecord, nonExecution)
            : meta.done

  const title = error || nonExecution ? baseTitle : dynamicTitle(part, argsRecord, resultRecord, baseTitle)
  const titleEnriched = title !== baseTitle

  const nonExecutionSubtitle = nonExecution ? nonExecutionReason(part, resultRecord, nonExecution) : ''

  const baseSubtitle = error || nonExecutionSubtitle || toolSubtitle(part, argsRecord, resultRecord)
  const keepSubtitleWithTitle = part.toolName === 'terminal' || part.toolName === 'execute_code'
  const subtitle = titleEnriched && !error && !keepSubtitleWithTitle ? '' : baseSubtitle

  const detailBody = stripDividerLines(
    nonExecution && !error
      ? pageTransition
        ? nonExecutionReason(part, resultRecord, nonExecution)
        : nonExecutionDetailText(part, resultRecord, nonExecution)
      : toolDetailText(part, argsRecord, resultRecord)
  )

  const detail = error
    ? [error, detailBody]
        .filter(Boolean)
        .filter((value, index, list) => list.findIndex(entry => entry.trim() === value.trim()) === index)
        .join('\n\n')
    : detailBody

  const resultCount = status === 'error' ? null : toolResultCount(part, argsRecord, resultRecord)

  // For shell/code tools we surface stdout and stderr as separate labeled
  // streams in the renderer. Many CLIs use stderr for informational
  // messages (npm progress, git hints), so we deliberately don't paint
  // stderr destructively even though it's tagged.
  const rendersAnsi = part.toolName === 'terminal' || part.toolName === 'execute_code'
  const stdout = rendersAnsi ? firstStringField(resultRecord, ['stdout']) : ''
  const stderrRaw = rendersAnsi ? firstStringField(resultRecord, ['stderr']) : ''
  // Only attach stderr when the backend actually returned it as its own
  // field — otherwise the merged `detail` already covers it and double-
  // rendering would duplicate output.
  const hasSplitStreams = rendersAnsi && (Boolean(stdout) || Boolean(stderrRaw))

  return {
    countLabel: resultCount ? formatCountLabel(resultCount) : undefined,
    detail,
    detailLabel: error ? '错误详情' : toolDetailLabel(part.toolName),
    durationLabel: durationLabel(resultRecord),
    icon: meta.icon,
    imageUrl: toolImageUrl(argsRecord, resultRecord),
    inlineDiff,
    previewTarget: toolPreviewTarget(part.toolName, argsRecord, resultRecord),
    rawArgs: prettyJson(part.args),
    rawResult: prettyJson(part.result),
    rendersAnsi: rendersAnsi || undefined,
    stderr: hasSplitStreams ? stderrRaw || undefined : undefined,
    stdout: hasSplitStreams ? stdout || undefined : undefined,
    status,
    subtitle,
    title,
    tone: meta.tone
  }
}

export function groupStatus(parts: ToolPart[]): ToolStatus {
  if (parts.some(p => p.result === undefined)) {
    return 'running'
  }

  const outcomeParts = parts.filter(part => !isObservedPageTransitionPart(part))

  if (outcomeParts.length === 0) {
    return 'success'
  }

  const statuses = outcomeParts.map(part => toolStatus(part, parseMaybeObject(part.result)))
  const hasError = statuses.includes('error')

  if (hasError) {
    return statuses.at(-1) === 'success' ? 'warning' : 'error'
  }

  return statuses.includes('warning') ? 'warning' : 'success'
}

export function groupStatusSummary(parts: ToolPart[]): string {
  const outcomeParts = parts.filter(part => !isObservedPageTransitionPart(part))
  const statuses = outcomeParts.map(part => toolStatus(part, parseMaybeObject(part.result)))

  if (statuses.includes('running')) {
    return ''
  }

  const errorCount = groupFailedStepCount(outcomeParts)
  const warningParts = outcomeParts.filter(part => toolStatus(part, parseMaybeObject(part.result)) === 'warning')

  const replanCount = warningParts.filter(part => {
    const result = parseMaybeObject(part.result)
    const kind = browserRunReplanKind(part, result, browserNonExecution(result))

    return kind === 'effect' || kind === 'uncertain' || kind === 'unknown'
  }).length

  const unexecutedCount = warningParts.length - replanCount

  if (errorCount === 0 && warningParts.length === 0) {
    return ''
  }

  const issueParts = [
    errorCount > 0 ? `${errorCount} 个步骤失败` : '',
    replanCount > 0 ? `${replanCount} 个工作流需重新规划` : '',
    unexecutedCount > 0 ? `${unexecutedCount} 个操作未执行` : ''
  ].filter(Boolean)

  const lastIssueIndex = statuses.findLastIndex(status => status === 'error' || status === 'warning')
  const recovered = lastIssueIndex >= 0 && statuses.slice(lastIssueIndex + 1).includes('success')
  const summary = issueParts.join('，')

  return recovered ? `已自动恢复 · ${summary}` : summary
}

export function groupTitle(parts: ToolPart[]): string {
  const prefix = PREFIX_META.find(p => parts.every(part => part.toolName.startsWith(p.prefix)))
  const verb = prefix?.verb || '工具'

  return `${verb}操作 · ${parts.length} 步`
}

export function groupPreviewTargets(parts: ToolPart[]): string[] {
  const seen = new Set<string>()
  const targets: string[] = []

  for (const part of parts) {
    const view = buildToolView(part, inlineDiffFromResult(part.result))
    const target = view.previewTarget

    if (target && isPreviewableTarget(target) && !seen.has(target)) {
      seen.add(target)
      targets.push(target)
    }
  }

  return targets
}

export function groupFailedStepCount(parts: ToolPart[]): number {
  return parts.filter(part => toolStatus(part, parseMaybeObject(part.result)) === 'error').length
}

export function groupTotalDurationLabel(parts: ToolPart[]): string {
  const seconds = parts.reduce((sum, part) => {
    const value = numberValue(parseMaybeObject(part.result).duration_s)

    return sum + (value && value > 0 ? value : 0)
  }, 0)

  if (!seconds) {
    return ''
  }

  return formatDurationSeconds(seconds)
}

export function groupCopyText(parts: ToolPart[]): string {
  return parts
    .map(part => {
      const view = buildToolView(part, '')
      const lines = [view.title]

      if (view.subtitle && view.subtitle !== view.title) {
        lines.push(view.subtitle)
      }

      if (view.detail && view.detail !== view.subtitle) {
        lines.push(view.detail)
      }

      return lines.join('\n')
    })
    .join('\n\n')
}
