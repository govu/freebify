import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { RotateCcw, SlidersHorizontal } from "lucide-react"
import { usePlayer } from "../store/player"
import { Slider } from "./Slider"

const BAND_LABELS = ["60", "250", "500", "1K", "4K", "8K", "14K"]

const PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0],
  Bass: [6, 4, 1, 0, 0, 1, 2],
  Vocal: [-2, 0, 3, 5, 4, 2, 0],
  Bright: [-1, 0, 1, 2, 4, 6, 7],
  "V-shape": [6, 3, 0, -1, 0, 3, 6],
}

const RANGE = 12 // ±12 dB

export function EqPopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const eq = usePlayer((s) => s.eq)
  const normOn = usePlayer((s) => s.normOn)
  const fadeSecs = usePlayer((s) => s.fadeSecs)
  const setEqBand = usePlayer((s) => s.setEqBand)
  const setEq = usePlayer((s) => s.setEq)
  const setNormOn = usePlayer((s) => s.setNormOn)
  const setFadeSecs = usePlayer((s) => s.setFadeSecs)
  const queueOpen = usePlayer((s) => s.queueOpen)
  const [readout, setReadout] = useState<number | null>(null)
  // the queue owns the right 320px of the window whenever it's open (inline
  // at lg+, overlay below it) — the popover must dodge it either way; clamped
  // so a very narrow window never pushes it off the LEFT edge instead
  const [vw, setVw] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const popRight = queueOpen ? Math.min(336, Math.max(16, vw - 340)) : 16

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", close)
    return () => window.removeEventListener("pointerdown", close)
  }, [open])

  const tuned = eq.some((v) => v !== 0)
  const custom = tuned && !Object.values(PRESETS).some((p) => p.every((v, i) => v === eq[i]))
  const activePreset = Object.entries(PRESETS).find(([, p]) => p.every((v, i) => v === eq[i]))?.[0]

  return (
    // flex kills the inline-baseline gap — a bare div wrapper would sit the
    // button on the text baseline and the icon rides visibly high next to
    // its sibling buttons
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Equalizer"
        aria-pressed={open}
        className={`relative transition hover:text-ink ${open || tuned || fadeSecs > 0 || !normOn ? "text-ink" : "text-dim"}`}
      >
        <SlidersHorizontal size={18} />
        {tuned && <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-ink" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            // fixed (not absolute): anchored to the window so it can dodge
            // the queue panel — absolute inside the bar would clip under it
            style={{ transformOrigin: "bottom right", right: popRight }}
            className="fixed bottom-[96px] w-[324px] rounded-2xl border border-line bg-panel p-5 shadow-2xl shadow-black/70 transition-[right] duration-200"
          >
            {/* header: title+reset on one row, preset chips wrap below —
                5 chips + the label don't fit one line at 324px (V-shape
                used to overflow the panel's right edge) */}
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-dim">Equalizer</span>
                {custom && (
                  <button
                    onClick={() => setEq(PRESETS.Flat)}
                    title="Reset to flat"
                    aria-label="Reset equalizer"
                    className="grid size-6 place-items-center rounded-md text-dim transition hover:bg-white/10 hover:text-ink"
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {Object.keys(PRESETS).map((name) => (
                  <button
                    key={name}
                    onClick={() => setEq(PRESETS[name])}
                    className={`whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                      activePreset === name ? "bg-white text-black" : "text-dim hover:bg-white/10 hover:text-ink"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            {/* vertical bands over a zero line — the classic EQ look */}
            <div className="relative mb-1 flex justify-between px-1" onPointerLeave={() => setReadout(null)}>
              <div className="pointer-events-none absolute inset-x-1 top-1/2 h-px bg-white/10" />
              {BAND_LABELS.map((label, i) => (
                <VBand
                  key={label}
                  label={label}
                  value={eq[i] ?? 0}
                  active={readout === i}
                  onActive={() => setReadout(i)}
                  onChange={(v) => setEqBand(i, v)}
                />
              ))}
            </div>

            {/* live readout — the touched band gets a precise dB value */}
            <div className="mb-3 h-4 text-center text-[10px] tabular-nums text-faint">
              {readout !== null
                ? `${BAND_LABELS[readout]} Hz · ${(eq[readout] ?? 0) > 0 ? "+" : ""}${(eq[readout] ?? 0).toFixed(1)} dB`
                : custom
                  ? "Custom"
                  : activePreset ?? ""}
            </div>

            <div className="space-y-3 border-t border-line pt-3">
              <button
                role="switch"
                aria-checked={normOn}
                onClick={() => setNormOn(!normOn)}
                className="flex w-full cursor-pointer items-center justify-between"
              >
                <span className="text-xs text-dim">Normalize volume</span>
                <span
                  className={`relative h-[18px] w-8 rounded-full border transition-colors ${
                    normOn ? "border-white bg-white" : "border-white/20 bg-white/10"
                  }`}
                >
                  <span
                    className={`absolute top-1/2 size-3 -translate-y-1/2 rounded-full transition-all ${
                      normOn ? "left-[16px] bg-black" : "left-[2px] bg-white/60"
                    }`}
                  />
                </span>
              </button>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-dim">Crossfade</span>
                  <span className="text-[10px] tabular-nums text-faint">{fadeSecs === 0 ? "off" : `${fadeSecs}s`}</span>
                </div>
                <Slider value={fadeSecs} max={12} onScrub={(v) => setFadeSecs(v)} ariaLabel="Crossfade seconds" />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// bipolar vertical fader — center is 0 dB, drag to ±12 in 0.5 steps
function VBand({
  label,
  value,
  active,
  onActive,
  onChange,
}: {
  label: string
  value: number
  active: boolean
  onActive: () => void
  onChange: (v: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const ratio = Math.min(1, Math.max(0, (value + RANGE) / (RANGE * 2))) // 0 bottom → 1 top

  const fromY = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect()
    const t = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    return Math.round((t * RANGE * 2 - RANGE) * 2) / 2
  }

  // window-level listeners instead of setPointerCapture — pointer capture
  // drops move events on some macOS/Linux builds, freezing the fader mid-drag
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => onChange(fromY(e.clientY))
    const up = () => setDrag(false)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [drag]) // eslint-disable-line react-hooks/exhaustive-deps — fromY reads the rect fresh each event

  return (
    <div className="flex w-8 flex-col items-center gap-1.5">
      <div
        ref={ref}
        role="slider"
        aria-label={`${label} Hz`}
        aria-orientation="vertical"
        aria-valuemin={-RANGE}
        aria-valuemax={RANGE}
        aria-valuenow={value}
        className="group relative h-24 w-8 cursor-pointer touch-none outline-none focus-visible:ring-1 focus-visible:ring-white/60"
        // role=slider needs tab focus + arrow keys to be a real slider —
        // without them the faders are mouse-only (a11y dead zone)
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 2 : 0.5
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault()
            onActive()
            onChange(Math.min(RANGE, value + step))
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault()
            onActive()
            onChange(Math.max(-RANGE, value - step))
          } else if (e.key === "Home" || e.key === "0") {
            e.preventDefault()
            onActive()
            onChange(0)
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary) return
          e.preventDefault()
          setDrag(true)
          onActive()
          onChange(fromY(e.clientY))
        }}
        onWheel={(e) => {
          onActive()
          onChange(Math.max(-RANGE, Math.min(RANGE, value + (e.deltaY < 0 ? 0.5 : -0.5))))
        }}
        onDoubleClick={() => onChange(0)}
      >
        {/* track */}
        <div className="absolute left-1/2 top-0 h-full w-[3px] -translate-x-1/2 rounded-full bg-white/10" />
        {/* fill from the zero line toward the thumb */}
        <div
          className="absolute left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-white/70"
          style={{
            top: `${Math.min(50, (1 - ratio) * 100)}%`,
            height: `${Math.abs(ratio - 0.5) * 100}%`,
          }}
        />
        {/* thumb */}
        <div
          className={`absolute left-1/2 h-[3px] w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${
            drag || active ? "scale-y-[2.2]" : "group-hover:scale-y-[1.8]"
          }`}
          style={{ top: `${(1 - ratio) * 100}%` }}
        />
      </div>
      <span className={`text-[9px] tabular-nums transition ${value !== 0 ? "text-ink" : "text-faint"}`}>{label}</span>
    </div>
  )
}
