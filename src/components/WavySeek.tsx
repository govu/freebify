import { useEffect, useRef, useState } from "react"

// Seek bar drawn on a canvas: a sine wave runs along the played part and the
// phase travels with the song, so position reads at a glance without a flat
// bar. A thin dim line carries the unplayed part. Reduced motion gets a
// straight line instead of the wave; the interaction and ARIA are the ones
// the plain Slider exposes.
interface WavySeekProps {
  value: number
  max: number
  onScrub?: (v: number) => void
  onCommit?: (v: number) => void
  className?: string
  ariaLabel?: string
  disabled?: boolean
}

const HEIGHT = 20
const LINE = 4
const AMP = 3

export function WavySeek({
  value,
  max,
  onScrub,
  onCommit,
  className = "",
  ariaLabel,
  disabled = false,
}: WavySeekProps) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [w, setW] = useState(0)
  const dragRef = useRef<number | null>(null)
  const last = useRef(0)

  // the drawn ratio eases toward the real one; the audio clock ticks at ~4Hz
  const shown = useRef(0)
  const phase = useRef(0)
  const knob = useRef(0)
  const target = useRef(0)

  const span = max
  const ratio = drag ?? (span > 0 ? Math.min(1, Math.max(0, value / span)) : 0)
  // refs are read by the animation frame, never during render
  useEffect(() => {
    target.current = ratio
    dragRef.current = drag
  }, [ratio, drag])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext("2d")
    if (!el || !ctx || w <= 0) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.round(w * dpr)
    el.height = Math.round(HEIGHT * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    let raf = 0
    let alive = true
    let prev = performance.now()

    const draw = (now: number) => {
      if (!alive) return
      raf = requestAnimationFrame(draw)
      const dt = Math.min(0.1, (now - prev) / 1000)
      prev = now
      const dragging = dragRef.current !== null
      const goal = target.current

      // follow the clock quickly, the drag instantly; both are smoothed so a
      // 4Hz timeupdate doesn't step the knob
      shown.current += (goal - shown.current) * Math.min(1, dt * (dragging ? 40 : 14))
      if (Math.abs(goal - shown.current) < 0.0005) shown.current = goal
      // the wave crawls while playing and rides the pointer while dragging
      phase.current += (dragging ? (goal - knob.current) * 120 : dt * 2.6)
      knob.current = shown.current

      const r = shown.current
      const cy = HEIGHT / 2
      const x0 = 5
      const x1 = w - 5
      const knobX = x0 + r * (x1 - x0)
      ctx.clearRect(0, 0, w, HEIGHT)

      // unplayed tail: thin, dim, no wave
      ctx.strokeStyle = "rgba(255,255,255,0.18)"
      ctx.lineWidth = 2
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.moveTo(knobX + 6, cy)
      ctx.lineTo(x1, cy)
      ctx.stroke()

      // played part
      if (knobX > x0) {
        ctx.strokeStyle = "#fff"
        ctx.lineWidth = LINE
        ctx.lineJoin = "round"
        ctx.lineCap = "round"
        ctx.beginPath()
        if (still) {
          ctx.moveTo(x0, cy)
          ctx.lineTo(knobX, cy)
        } else {
          const k = (Math.PI * 2) / 34
          for (let x = x0; x <= knobX; x += 2) {
            const y = cy + Math.sin(phase.current - (knobX - x) * k) * AMP
            if (x === x0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.lineTo(knobX, cy)
        }
        ctx.stroke()
      }

      // knob: a small pill that grows while held
      const grow = dragging ? 1 : 0
      const kw = 6 + grow * 1.5
      const kh = 14 + grow * 6
      ctx.fillStyle = "#fff"
      ctx.beginPath()
      ctx.roundRect(knobX - kw / 2, cy - kh / 2, kw, kh, kw / 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [w])

  const ratioFrom = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r?.width) return 0
    const x0 = r.left + 5
    const x1 = r.right - 5
    return Math.min(1, Math.max(0, (clientX - x0) / Math.max(1, x1 - x0)))
  }

  const end = (commit: boolean) => {
    if (dragRef.current === null) return
    dragRef.current = null
    setDrag(null)
    if (!commit) return
    if (onCommit) onCommit(last.current)
    else onScrub?.(last.current)
  }

  const step = (delta: number) => {
    if (disabled) return
    const v = Math.min(max, Math.max(0, value + delta * max))
    if (onCommit) onCommit(v)
    else onScrub?.(v)
  }

  return (
    <div
      ref={box}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-disabled={disabled || undefined}
      aria-valuemin={0}
      aria-valuemax={Math.round(max * 10) / 10}
      aria-valuenow={Math.round(Math.min(max, Math.max(0, drag !== null ? drag * max : value)) * 10) / 10}
      className={`group relative flex outline-none select-none ${disabled ? "cursor-default opacity-50" : "cursor-pointer"} ${className}`}
      style={{ height: HEIGHT, touchAction: "none" }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === "Home") {
          e.preventDefault()
          e.stopPropagation()
          if (onCommit) onCommit(0)
          else onScrub?.(0)
          return
        }
        if (e.key === "End") {
          e.preventDefault()
          e.stopPropagation()
          if (onCommit) onCommit(max)
          else onScrub?.(max)
          return
        }
        const s = e.shiftKey || e.key.startsWith("Page") ? 0.1 : 0.02
        const d =
          e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp"
            ? s
            : e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown"
              ? -s
              : 0
        if (!d) return
        e.preventDefault()
        e.stopPropagation() // App-level arrow shortcuts seek: don't double-fire
        step(d)
      }}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0 || !e.isPrimary || dragRef.current !== null) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* pointer already gone (synthetic event) */
        }
        const r = ratioFrom(e.clientX)
        last.current = r * max
        dragRef.current = r
        setDrag(r)
        onScrub?.(last.current)
      }}
      onPointerMove={(e) => {
        if (dragRef.current === null || !e.isPrimary) return
        const r = ratioFrom(e.clientX)
        last.current = r * max
        dragRef.current = r
        setDrag(r)
        onScrub?.(last.current)
      }}
      onPointerUp={(e) => {
        if (e.isPrimary) end(true)
      }}
      // the OS stole the gesture: drop the drag without seeking
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(false)}
    >
      <canvas
        ref={canvas}
        className="pointer-events-none absolute inset-0"
        style={{ width: "100%", height: HEIGHT }}
        aria-hidden
      />
    </div>
  )
}
