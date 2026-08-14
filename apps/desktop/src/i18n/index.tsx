import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type DesktopLanguage = 'en' | 'zh'

export const DEFAULT_DESKTOP_LANGUAGE: DesktopLanguage = 'zh'
export const DESKTOP_LANGUAGE_STORAGE_KEY = 'fan-desktop-language-v1'

const ENGLISH_MESSAGES: Record<string, string> = {
  '关闭': 'Close',
  '关闭设置': 'Close settings',
  '偏好': 'Preferences',
  'MCP 配置': 'MCP configuration',
  '归档': 'Archive',
  '用量': 'Usage',
  '技能': 'Skills',
  '关于': 'About',
  '聊天': 'Chat',
  '外观': 'Appearance',
  '工作区': 'Workspace',
  '安全': 'Safety',
  '界面语言': 'Interface language',
  '选择 Fan 桌面界面使用的语言。': 'Choose the language used by the Fan desktop interface.',
  '中文': 'Chinese',
  '英文': 'English',
  '默认模型': 'Default model',
  '时区': 'Time zone',
  '对话风格': 'Conversation style',
  '显示推理过程': 'Show reasoning',
  '工作目录': 'Working directory',
  '危险操作确认': 'Dangerous action confirmation',
  '默认搜索引擎': 'Default search engine',
  '文件检查点': 'File checkpoints',
  '新建聊天时使用此模型，除非在输入框中选择了其他模型。':
    'Use this model for new chats unless another model is selected in the composer.',
  '新会话的默认助手风格。': 'Default assistant style for new sessions.',
  'Fan 需要本地时间上下文时使用。留空则使用系统时区。':
    'Used when Fan needs local-time context. Leave blank to use the system time zone.',
  '后端提供推理内容时显示推理段落。': 'Show reasoning sections when the backend provides them.',
  '工具和终端任务的默认项目目录。': 'Default project directory for tools and terminal tasks.',
  '新建会话的工作台浏览器会打开此搜索引擎主页；已有会话会恢复原标签，不受影响。':
    'New session browsers open this search engine. Existing sessions restore their tabs and are unaffected.',
  '每次确认:危险操作先征求你;智能判断:AI 评估风险,仅拦截真正危险的;从不确认:全部放行(毁灭性命令仍会被硬性拦截)。':
    'Always ask: confirm dangerous actions; Smart: AI evaluates risk and only blocks truly dangerous actions; Never ask: allow all actions (destructive commands remain blocked).',
  '文件编辑前创建可回滚的快照。': 'Create a reversible snapshot before editing files.',
  '决定工作台浏览器新开标签或新会话默认使用哪个搜索引擎；不会改动已经打开的标签。':
    'Sets the default search engine for new browser tabs and sessions without changing open tabs.',
  'Fan 执行文件、终端和代码相关任务时默认进入的目录。通常设置为你的项目根目录。':
    'The directory Fan enters by default for file, terminal, and coding tasks. Usually your project root.',
  '删除文件、系统级命令等危险操作的确认策略。无论选哪档，格盘、关机等毁灭性命令都会被硬性拦截。':
    'Confirmation policy for file deletion, system commands, and other dangerous actions. Destructive commands such as disk formatting and shutdown are always blocked.',
  '开启后，Fan 在修改文件前会创建可回滚快照。占用少量本地空间，但更容易撤销误改。':
    'When enabled, Fan creates a reversible snapshot before editing files. It uses a small amount of local storage and makes accidental changes easier to undo.',
  '亲切助手': 'Helpful',
  '简洁直接': 'Concise',
  '专业技术': 'Technical',
  '创意发散': 'Creative',
  '循循善诱': 'Teacher',
  '可爱卖萌': 'Kawaii',
  '猫娘': 'Catgirl',
  '海盗腔': 'Pirate',
  '莎翁文风': 'Shakespeare',
  '冲浪少年': 'Surfer',
  '黑色电影': 'Noir',
  'UwU 软萌': 'UwU',
  '哲思': 'Philosopher',
  '热血带感': 'Hype',
  '必应 Bing': 'Bing',
  '百度': 'Baidu',
  '每次确认': 'Always ask',
  '智能判断': 'Smart',
  '从不确认': 'Never ask',
  '无': 'None',
  '（无）': '(None)',
  '未设置': 'Not set',
  '逗号分隔的值': 'Comma-separated values',
  '设置加载失败': 'Failed to load settings',
  '自动保存失败': 'Auto-save failed',
  '对话风格保存失败': 'Failed to save conversation style',
  '正在加载 Fan 配置…': 'Loading Fan configuration…',
  '设置项': 'Setting',
  '说明': ' information',
  '以下为仅限桌面端的显示偏好设置。颜色模式控制明亮 / 深色外观。':
    'These display preferences apply to the desktop app. Color mode controls the light or dark appearance.',
  '选择明亮或深色，或让 Fan 跟随系统设置。':
    'Choose light or dark, or let Fan follow your system setting.',
  '颜色模式': 'Color mode',
  '浅色': 'Light',
  '深色': 'Dark',
  '系统': 'System',
  '控制 Fan 的明暗外观。选择“系统”时会跟随 macOS 或 Windows 的系统外观。':
    'Controls Fan’s light or dark appearance. System follows the macOS or Windows appearance setting.',
  '正在加载已归档会话…': 'Loading archived sessions…',
  '已归档的会话': 'Archived sessions',
  '已归档的聊天会从侧栏隐藏，但保留所有消息。在侧栏中按住 Ctrl/⌘ 点击聊天可将其归档。':
    'Archived chats are hidden from the sidebar while retaining all messages. Ctrl/⌘-click a chat in the sidebar to archive it.',
  '归档聊天后将在此显示。': 'Archived chats will appear here.',
  '暂无归档': 'No archived chats',
  '恢复': 'Restore',
  '永久删除': 'Delete permanently',
  '默认项目目录': 'Default project directory',
  '新会话会从此目录开始；也可以在创建时另行选择。':
    'New sessions start in this directory. You can also choose another directory when creating one.',
  '默认项目目录已更新': 'Default project directory updated',
  '无法更新默认目录': 'Could not update the default directory',
  '无法清除默认目录': 'Could not clear the default directory',
  '更改': 'Change',
  '选择': 'Choose',
  '清除': 'Clear',
  '后续新会话将使用此目录。': 'New sessions will use this directory.',
  '尚未选择目录': 'No directory selected',
  '你的主目录': 'your home directory',
  '无法加载已归档的会话': 'Could not load archived sessions',
  '取消归档失败': 'Failed to restore archived session',
  '永久删除失败': 'Permanent deletion failed',
  '关于我们': 'About us',
  '版本信息不可用': 'Version information unavailable',
  '你的 AI 浏览器 agent': 'Your AI browser agent',
  '开发构建不使用应用内更新，直接更新源码检出即可。':
    'Development builds do not use in-app updates. Update the source checkout directly.',
  '更新失败，请重试。': 'Update failed. Please try again.',
  '无法连接到更新服务器，请稍后重试。': 'Could not reach the update server. Please try again later.',
  '发现新版本': 'New version available',
  '打开更新': 'Open update',
  '检查中…': 'Checking…',
  '重试更新': 'Retry update',
  '重试检查': 'Check again',
  '更新并安装': 'Update and install',
  '当前已是最新版本': 'Up to date',
  '检查更新': 'Check for updates',
  '即将重启…': 'Restarting soon…',
  '更新中…': 'Updating…',
  '窗口控制': 'Window controls',
  '窗口控件': 'Window controls',
  '最小化': 'Minimize',
  '还原': 'Restore',
  '最大化': 'Maximize',
  '仅对话': 'Chat only',
  '分屏': 'Split view',
  '仅浏览器': 'Browser only',
  '会话布局': 'Session layout',
  '打开应用菜单': 'Open application menu',
  '面板控件': 'Panel controls',
  '应用控件': 'Application controls',
  '新建会话': 'New session',
  '全部对话': 'All chats',
  '设置': 'Settings',
  'Fan 正在操作浏览器，暂时不能隐藏浏览器': 'Fan is using the browser, so it cannot be hidden right now',
  '请先处理当前对话请求': 'Please resolve the current chat request first',
  '准备好了，随时开始。': 'Ready when you are.',
  '输入一个任务、问题或网址。我会配合左侧浏览器，把下一步做清楚。':
    'Enter a task, question, or URL. I’ll work with the browser on the left to make the next step clear.',
  '今天要处理什么？': 'What are we working on today?',
  '告诉我目标页面和你想完成的事，我会浏览、观察并继续执行。':
    'Tell me the page and what you want to accomplish. I’ll browse, inspect, and continue.',
  '从哪里开始？': 'Where should we start?',
  '可以从一个网址、一段需求，或者一个模糊想法开始。':
    'Start with a URL, a requirement, or even a rough idea.',
  '我们来做什么？': 'What should we do?',
  '给 Fan 分配一个任务': 'Give Fan a task',
  '你在想什么？': 'What are you thinking?',
  '描述你的需求': 'Describe what you need',
  '我们要解决什么？': 'What should we solve?',
  '随便问': 'Ask anything',
  '从一个目标开始': 'Start with a goal',
  '发送后续消息': 'Send a follow-up',
  '补充更多上下文': 'Add more context',
  '细化请求': 'Refine your request',
  '接下来呢？': 'What next?',
  '继续吧': 'Continue',
  '再进一步': 'Take it further',
  '调整或继续': 'Adjust or continue',
  '正在重新连接 Fan…': 'Reconnecting to Fan…',
  '正在启动 Fan...': 'Starting Fan...',
  '消息': 'Message',
  '切换自动审查失败': 'Failed to change command access mode',
  '命令访问模式': 'Command access mode',
  '完全访问': 'Full access',
  '自动审查': 'Auto review',
  '每条危险命令执行前都询问': 'Ask before every dangerous command',
  '危险命令自动批准，不再逐条询问': 'Automatically approve dangerous commands without asking',
  '补充当前运行': 'Add to current run',
  '停止': 'Stop',
  '发送': 'Send',
  '附件': 'Attachments',
  '选择文件': 'Choose files',
  '选择文件夹': 'Choose folder',
  '选择图片': 'Choose images',
  '粘贴图片': 'Paste image',
  '提示词片段…': 'Prompt snippets…',
  '提示词片段': 'Prompt snippets',
  '选择一条起始提示词插入到输入框。': 'Choose a starter prompt to insert into the composer.',
  '跟随中': 'Following',
  '新标签页': 'New tab',
  '常用命令': 'Common commands',
  '快捷键': 'Keyboard shortcuts',
  '完整命令列表 + 快捷键': 'Full command list and keyboard shortcuts',
  '继续之前的会话': 'Resume a previous session',
  '控制转录详细程度': 'Control transcript detail',
  '复制所选内容或最后一条助手消息': 'Copy the selection or last assistant message',
  '退出 Fan': 'Quit Fan',
  '引用文件、文件夹、URL、git': 'Reference files, folders, URLs, and git',
  '斜杠命令面板': 'Slash command menu',
  '此快速帮助（按删除键关闭）': 'This quick help (press Backspace to close)',
  '发送 · Shift+Enter 换行': 'Send · Shift+Enter for a new line',
  '重绘': 'Redraw',
  '关闭弹出层 · 取消运行': 'Close popover · cancel run',
  '切换弹出层 / 历史记录': 'Navigate popover / history',
  '打开完整面板 · 退格键关闭': 'Open full panel · press Backspace to close',
  '附加 URL': 'Attach URL',
  'Fan 将获取该页面并将其作为本轮的上下文。':
    'Fan will fetch this page and use it as context for this turn.',
  '取消': 'Cancel',
  '附加': 'Attach',
  '令牌、费用及技能活动概览': 'Overview of tokens, costs, and skill activity'
}

function normalizeLanguage(value: string | null | undefined): DesktopLanguage {
  return value === 'en' ? 'en' : DEFAULT_DESKTOP_LANGUAGE
}

export function storedDesktopLanguage(): DesktopLanguage {
  if (typeof window === 'undefined') {
    return DEFAULT_DESKTOP_LANGUAGE
  }

  try {
    return normalizeLanguage(window.localStorage.getItem(DESKTOP_LANGUAGE_STORAGE_KEY))
  } catch {
    return DEFAULT_DESKTOP_LANGUAGE
  }
}

export function translate(language: DesktopLanguage, source: string): string {
  return language === 'en' ? (ENGLISH_MESSAGES[source] ?? source) : source
}

interface LanguageContextValue {
  language: DesktopLanguage
  setLanguage: (language: DesktopLanguage) => void
  t: (source: string) => string
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_DESKTOP_LANGUAGE,
  setLanguage: () => undefined,
  t: source => source
})

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<DesktopLanguage>(storedDesktopLanguage)

  const setLanguage = useCallback((next: DesktopLanguage) => {
    const normalized = normalizeLanguage(next)
    setLanguageState(normalized)

    try {
      window.localStorage.setItem(DESKTOP_LANGUAGE_STORAGE_KEY, normalized)
    } catch {
      // Persistence is best-effort in restricted renderer contexts.
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])

  const t = useCallback((source: string) => translate(language, source), [language])
  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useI18n(): LanguageContextValue {
  return useContext(LanguageContext)
}
