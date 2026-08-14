import { Leva, useControls } from 'leva'
import { useEffect, useState } from 'react'

export function Backdrop() {
  if (!import.meta.env.DEV) {
    return null
  }

  return <DevelopmentBackdrop />
}

function DevelopmentBackdrop() {
  const [controlsOpen, setControlsOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null

      const editing =
        target?.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement

      if (editing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      if (event.shiftKey && event.code === 'KeyY') {
        setControlsOpen(open => !open)
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const shape = useControls(
    'UI / Shape',
    { radiusScalar: { value: 0.2, min: 0, max: 2, step: 0.1, label: 'radius scalar' } },
    { collapsed: true }
  )

  useEffect(() => {
    document.documentElement.style.setProperty('--radius-scalar', String(shape.radiusScalar))
  }, [shape.radiusScalar])

  return <Leva collapsed hidden={!controlsOpen} titleBar={{ title: 'backdrop', drag: true }} />
}
