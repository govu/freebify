import { useRef, useState } from "react"

interface SliderProps {
  value: number
  min?: number
  max: number
  onScrub?: (v: number) => void
  onCommit?: (v: number) => void
  className?: string
  // ease fill between external value ticks (e.g. the seek bar's ~4Hz
  // timeupdate) instead of stepping — disable for scrub-driven sliders
  smooth?: boolean
  ariaLabel?: string
  disabled?: boolean
}

export function Slider({ value, min = 0, max, onScrub, onCommit, className = "", smooth = false, ariaLabel, disabled = false }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const last = useRef(0)
  const span = max - min

  const ratio = dragRatio ?? (span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0)

  const ratioFrom = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect()
    if (!rect.width) return 0 // hidden/zero-size — 0/0 would be NaN
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const endDrag = (commit: boolean) => {
    if (dragRatio === null) return
    setDragRatio(null)
    if (!commit) return
    onCommit ? onCommit(last.current) : onScrub?.(last.current)
  }

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-disabled={disabled || undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      // clamp — a stale/out-of-range value must not lie to AT (e.g. seek
      // reporting position > duration while duration hasn't loaded yet)
      aria-valuenow={Math.round(Math.min(max, Math.max(min, dragRatio !== null ? min + dragRatio * span : value)) * 10) / 10}
      className={`group relative flex h-4 items-center outline-none select-none ${
        disabled ? "cursor-default opacity-50" : "cursor-pointer"
      } ${className}`}
      // touch-none: the browser must not steal horizontal drags as scroll
      // pans — that fires pointercancel and half-commits a seek
      style={{ touchAction: "none" }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === "Home") {
          e.preventDefault()
          e.stopPropagation()
          onCommit ? onCommit(min) : onScrub?.(min)
          return
        }
        if (e.key === "End") {
          e.preventDefault()
          e.stopPropagation()
          onCommit ? onCommit(max) : onScrub?.(max)
          return
        }
        const step = e.shiftKey || e.key.startsWith("Page") ? 0.1 : 0.02
        const d =
          e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp"
            ? step
            : e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown"
              ? -step
              : 0
        if (!d) return
        e.preventDefault()
        e.stopPropagation() // App-level arrow shortcuts seek — don't double-fire
        const v = Math.min(max, Math.max(min, value + d * span))
        onCommit ? onCommit(v) : onScrub?.(v)
      }}
      onPointerDown={(e) => {
        // primary button + single active pointer only — a right-click or a
        // second touch must not start/steal a drag
        if (disabled || e.button !== 0 || !e.isPrimary || dragRatio !== null) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* pointer already inactive (synthetic event) */
        }
        const r = ratioFrom(e.clientX)
        last.current = min + r * span
        setDragRatio(r)
        onScrub?.(last.current)
      }}
      onPointerMove={(e) => {
        if (dragRatio === null || !e.isPrimary) return
        const r = ratioFrom(e.clientX)
        last.current = min + r * span
        setDragRatio(r)
        onScrub?.(last.current)
      }}
      onPointerUp={(e) => {
        if (e.isPrimary) endDrag(true)
      }}
      // pointercancel = the OS stole the gesture (touch→scroll, stylus) —
      // drop the drag WITHOUT committing the half-finished position
      onPointerCancel={() => endDrag(false)}
      // capture can also be lost silently (window blur mid-drag) — clean up
      onLostPointerCapture={() => endDrag(false)}
    >
      <div className="relative h-1 w-full overflow-visible rounded-full bg-white/10">
        {/* scaleX is compositor-only — animating `width` forced a layout
            pass every 4Hz tick for the entire playback session */}
        <div
          className={`absolute inset-y-0 left-0 w-full origin-left rounded-full bg-white group-hover:bg-ink ${
            dragRatio === null ? (smooth ? "transition-transform duration-300 ease-linear" : "transition-transform duration-75") : ""
          }`}
          style={{ transform: `scaleX(${ratio})` }}
        />
        <div
          className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-md transition group-hover:scale-110 group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{ left: `calc(${ratio * 100}% - 6px)`, opacity: dragRatio !== null ? 1 : undefined }}
        />
      </div>
    </div>
  )
}
