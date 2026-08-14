import { useState } from 'react'

import { useI18n } from '@/i18n'

type IntroCopy = {
  body: string
  headline: string
}

export type IntroProps = {
  personality?: string
  seed?: number
}

const INTRO_COPY: IntroCopy[] = [
  {
    body: '输入一个任务、问题或网址。我会配合左侧浏览器，把下一步做清楚。',
    headline: '准备好了，随时开始。'
  },
  {
    body: '告诉我目标页面和你想完成的事，我会浏览、观察并继续执行。',
    headline: '今天要处理什么？'
  },
  {
    body: '可以从一个网址、一段需求，或者一个模糊想法开始。',
    headline: '从哪里开始？'
  }
]

function pickCopy(seed = 0): IntroCopy {
  return INTRO_COPY[Math.abs(seed) % INTRO_COPY.length] || INTRO_COPY[0]
}

export function Intro({ seed }: IntroProps) {
  const { t } = useI18n()
  const [mountSeed] = useState(() => Math.floor(Math.random() * 100000))
  const copy = pickCopy(mountSeed + (seed ?? 0))

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 items-start px-4 pb-2 text-left"
      data-slot="aui_intro"
    >
      {/* Left-aligned title + body, seated just above the composer as a
          conversation starter (no icon — it read as empty filler). */}
      <div className="flex max-w-[24rem] flex-col items-start space-y-1.5">
        <p className="m-0 text-base font-semibold tracking-tight text-foreground">{t(copy.headline)}</p>
        <p className="m-0 text-[0.8125rem] leading-6 text-(--ui-text-secondary)">{t(copy.body)}</p>
      </div>
    </div>
  )
}
