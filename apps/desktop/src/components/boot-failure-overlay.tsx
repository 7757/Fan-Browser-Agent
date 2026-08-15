import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { BrowserOnlyNotice } from '@/components/browser-only-notice'
import { AlertTriangle, FileText, Loader2, RefreshCw } from '@/lib/icons'
import { $desktopBoot } from '@/store/boot'

type BusyAction = 'retry' | null

// Recovery surface for a hard boot failure (gateway never came up, backend
// exited during startup, bootstrap latched, …). Without this the app shell
// renders dead — "gateway offline", no composer, only a toast — with no way
// to retry, repair the install, or find the logs.
//
// 使用独立的透明玻璃恢复卡，不依赖工作区是否已经成功渲染。
// 错误只展示首行人话摘要;完整错误+最近日志折叠进「技术详情」,不再把
// 原始日志不直出给普通用户；所有诊断信息仅保存在本地。
export function BootFailureOverlay() {
  const boot = useStore($desktopBoot)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [showDetail, setShowDetail] = useState(false)

  const visible = Boolean(boot.error) && !boot.running

  useEffect(() => {
    if (!visible) {
      return
    }

    void window.fanDesktop
      ?.getRecentLogs()
      .then(res => setLogs(res.lines ?? []))
      .catch(() => undefined)
  }, [visible])

  if (!visible) {
    return null
  }

  // Opened in a plain browser (e.g. the Vite dev URL on :5174): there is no
  // Electron IPC bridge, so the recovery actions below all call
  // window.fanDesktop and would be no-ops. Show a calm "use the desktop app"
  // notice instead of the alarming red boot-failure recovery screen.
  if (typeof window !== 'undefined' && !window.fanDesktop) {
    return <BrowserOnlyNotice />
  }

  const retry = async () => {
    setBusy('retry')
    await window.fanDesktop?.resetBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const openLogs = () => void window.fanDesktop?.revealLogs().catch(() => undefined)

  // 首行 = 人话摘要;其余(startFan 会把最近日志拼进 error)归入技术详情。
  // getRecentLogs 与 error 内嵌的日志尾巴高度重叠,按行去重只保留一份。
  const errorLines = String(boot.error ?? '').split('\n')
  const summary = errorLines[0]?.trim() || '后台服务未能启动。'
  const embedded = new Set(errorLines.map(line => line.trim()).filter(Boolean))
  const extraLogs = logs.slice(-40).filter(line => !embedded.has(line.trim()))
  const detail = [...errorLines.slice(1), ...extraLogs].join('\n').trim()

  return (
    <div className="fan-bootfail-overlay">
      <div className="fan-bootfail-card">
        <div aria-hidden className="fan-bootfail-icon">
          <AlertTriangle />
        </div>
        <h2 className="fan-bootfail-headline">Fan 无法启动</h2>
        <p className="fan-bootfail-sub">
          后台服务未能启动，试试下面的恢复步骤——不会影响你的聊天记录和设置。诊断信息仅保存在本地。
        </p>
        <p className="fan-bootfail-error">{summary}</p>
        <div className="fan-bootfail-actions">
          <button
            className="fan-bootfail-primary"
            disabled={Boolean(busy)}
            onClick={() => void retry()}
            type="button"
          >
            {busy === 'retry' ? <Loader2 className="fan-spin" /> : <RefreshCw />}
            重试
          </button>
          <button className="fan-bootfail-ghost" onClick={openLogs} type="button">
            <FileText />
            打开日志
          </button>
        </div>
        <p className="fan-bootfail-hint">若多次重试仍失败，请从 GitHub Releases 重新下载并安装最新版 Fan。</p>
        {detail ? (
          <>
            <button className="fan-bootfail-toggle" onClick={() => setShowDetail(v => !v)} type="button">
              {showDetail ? '收起技术详情' : '查看技术详情'}
            </button>
            {showDetail ? (
              <pre className="fan-bootfail-log" data-selectable-text="true">
                {detail}
              </pre>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
