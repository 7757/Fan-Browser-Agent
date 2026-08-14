import type { ToolCallMessagePartProps } from '@assistant-ui/react'
// Dev-only preview harness for the runtime interaction prompts (approval / sudo
// / secret / collect / verification / control). Replaces the removed
// prompt-states-lab page: pop any state with mock data straight from the
// devtools console, WITHOUT the gateway, to eyeball component styles.
//
//   window.fanMock.approval()      window.fanMock.sudo()
//   window.fanMock.secret()        window.fanMock.collect()
//   window.fanMock.verification()  window.fanMock.control()
//   window.fanMock.clear()
//
// sudo/secret/verification/control are root-mounted overlays, so setting their
// store IS enough to show them. approval + collect are INLINE (they only mount
// under a pending tool row), so those two render inside <DevMockPreview/>, a
// dev-only floating panel that hosts the real component with mock props.
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

import { CollectTool } from '@/components/assistant-ui/collect-tool'
import { ApprovalBar } from '@/components/assistant-ui/tool-approval'
import { clearCollectRequest, parseCollectContent, setCollectRequest } from '@/store/collect'
import {
  clearAllPrompts,
  setApprovalRequest,
  setControlRequest,
  setSecretRequest,
  setSudoRequest,
  setVerificationRequest
} from '@/store/prompts'
import { $activeSessionId } from '@/store/session'

type InlinePreview = 'approval' | 'collect' | null

// Which inline component the floating panel is hosting (null = hidden).
const $inlinePreview = atom<InlinePreview>(null)

const sid = (): string | null => $activeSessionId.get()
const rid = (): string => `mock-${Date.now()}`

interface FanMock {
  approval: () => void
  clear: () => void
  collect: () => void
  control: () => void
  secret: () => void
  sudo: () => void
  verification: () => void
}

// Kitchen-sink field set exercising every collect input type.
const MOCK_COLLECT_FIELDS = [
  { name: 'phone', label: '手机号', type: 'phone' as const, required: true, placeholder: '13800138000' },
  { name: 'sms_code', label: '短信验证码', type: 'otp' as const, required: true },
  { name: 'card', label: '信用卡号', type: 'credit_card' as const, required: true, placeholder: '4111 1111 1111 1111' },
  { name: 'id', label: '身份证号', type: 'id_number' as const, required: false },
  { name: 'dept', label: '部门', type: 'select' as const, required: true, options: ['技术部', '市场部', '财务部'] },
  { name: 'invoice_file', label: '发票文件', type: 'file' as const, required: false }
]

export function installDevMock(): void {
  // MODE (not DEV): our Vite setup bundles with PROD=true even in `vite dev`
  // (see main.tsx / scripts/dev-no-hmr.mjs), so DEV is false while developing.
  if (import.meta.env.MODE === 'production' || typeof window === 'undefined') {
    return
  }

  const fanMock: FanMock = {
    approval: () => {
      setApprovalRequest({
        allowPermanent: true,
        command: 'rm -rf ./dist && npm run build',
        description: 'rm -rf',
        requestId: rid(),
        sessionId: sid()
      })
      $inlinePreview.set('approval')
    },
    collect: () => {
      setCollectRequest({
        ...parseCollectContent({
          question: '签证申请资料',
          questions: [
            {
              id: 'purpose',
              question: '本次出行目的是什么？',
              choices: ['旅游', '商务', '探亲']
            },
            { id: 'details', question: '请提供申请资料', fields: MOCK_COLLECT_FIELDS },
            {
              id: 'company',
              question: '请提供邀请公司名称',
              depends_on: { question_id: 'purpose', operator: 'equals', value: '商务' }
            }
          ],
          submit_label: '提交全部资料'
        }),
        requestId: rid(),
        sessionId: sid()
      })
      $inlinePreview.set('collect')
    },
    sudo: () => setSudoRequest({ requestId: rid(), sessionId: sid() }),
    secret: () =>
      setSecretRequest({
        envVar: 'OPENAI_API_KEY',
        prompt: '需要 OPENAI_API_KEY 才能继续执行这个技能。',
        requestId: rid(),
        sessionId: sid()
      }),
    verification: () =>
      setVerificationRequest({
        captchaType: 'captcha',
        message: '需要人工验证 — 请在浏览器中完成验证，Agent 会在你完成后继续',
        requestId: rid(),
        sessionId: sid()
      }),
    control: () =>
      setControlRequest({
        message: '检测到你操作了被接管浏览器的标签页，已暂停',
        requestId: rid(),
        sessionId: sid(),
        tabKind: 'tab'
      }),
    clear: () => {
      $inlinePreview.set(null)
      clearAllPrompts()
      clearCollectRequest()
    }
  }

  ;(window as unknown as { fanMock: FanMock }).fanMock = fanMock
  console.info(
    '%c[fanMock]%c approval() · sudo() · secret() · collect() · verification() · control() · clear()',
    'color:#2D6BF0;font-weight:700',
    'color:inherit'
  )
}

// Floating host for the two INLINE prompts (approval / collect) that can't be
// shown by a store-set alone. Mounted once at the app root; renders nothing
// until a mock fires. Dev-only.
export function DevMockPreview(): React.ReactElement | null {
  const which = useStore($inlinePreview)

  if (import.meta.env.MODE === 'production' || !which) {
    return null
  }

  console.info('[fanMock] DevMockPreview rendering:', which)

  // The native browser WebContentsView paints ABOVE all DOM and occupies the
  // LEFT pane, so a centred panel would be hidden behind it. Anchor to the RIGHT
  // (the chat column is pure DOM and always visible) so the preview shows.
  return (
    <div
      className="fixed right-5 top-20 z-[99999] flex w-[380px] flex-col gap-2"
      data-fanmock="preview"
    >
      <div className="flex items-center gap-2 self-center rounded-full bg-black/70 px-3 py-1 text-[11px] font-medium text-white backdrop-blur">
        <span>组件预览 · dev mock</span>
        <button
          className="rounded-full px-1.5 text-white/70 hover:text-white"
          onClick={() => $inlinePreview.set(null)}
          type="button"
        >
          ✕
        </button>
      </div>
      <div className="w-full rounded-2xl border border-black/5 bg-[#eef2fb] p-4 shadow-2xl">
        {which === 'approval' && (
          <ApprovalBar
            request={{
              allowPermanent: true,
              command: 'rm -rf ./dist && npm run build',
              description: 'rm -rf',
              requestId: 'dev-mock-approval',
              sessionId: sid()
            }}
          />
        )}
        {which === 'collect' && <CollectTool {...({ args: undefined } as unknown as ToolCallMessagePartProps)} />}
      </div>
    </div>
  )
}
