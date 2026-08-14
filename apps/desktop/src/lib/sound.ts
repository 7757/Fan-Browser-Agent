// Tiny self-contained UI sound effects, synthesized via Web Audio — no bundled
// audio assets. Each play is triggered inside a user gesture (a click), so the
// browser autoplay policy lets the AudioContext resume.

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      return null
    }
    if (!ctx) {
      ctx = new Ctor()
    }
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    return ctx
  } catch {
    return null
  }
}

// A short descending "whoosh" — something being sent away. Soft and quick so it
// reads as feedback, not an alert.
export function playDeleteSound(): void {
  const ac = audioContext()
  if (!ac) {
    return
  }

  const now = ac.currentTime
  const osc = ac.createOscillator()
  const gain = ac.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(520, now)
  osc.frequency.exponentialRampToValueAtTime(150, now + 0.15)

  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.13, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19)

  osc.connect(gain).connect(ac.destination)
  osc.start(now)
  osc.stop(now + 0.21)
}
