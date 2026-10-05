import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { SlidersHorizontal } from "lucide-react"
import { usePlayer } from "../store/player"
import { Slider } from "./Slider"

const BAND_LABELS = ["60", "250", "500", "1K", "4K", "8K", "14K"]

const PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0],
  "Bass boost": [6, 4, 1, 0, 0, 1, 2],
  Vocal: [-2, 0, 3, 5, 4, 2, 0],
  Bright: [-1, 0, 1, 2, 4, 6, 7],
  "V-shape": [6, 3, 0, -1, 0, 3, 6],
}

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

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", close)
    return () => window.removeEventListener("pointerdown", close)
  }, [open])

  const tuned = eq.some((v) => v !== 0) || normOn !== true || fadeSecs !== 4

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Equalizer"
        aria-pressed={open}
        className={`relative transition hover:text-ink ${open || tuned ? "text-ink" : "text-dim"}`}
      >
        <SlidersHorizontal size={18} />
        {tuned && <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-ink" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-10 right-0 w-[300px] rounded-2xl border border-line bg-panel/95 p-4 shadow-2xl backdrop-blur"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-dim">Equalizer</span>
              <div className="flex gap-1">
                {Object.entries(PRESETS).map(([name, gains]) => (
                  <button
                    key={name}
                    onClick={() => setEq(gains)}
                    className="rounded-md px-1.5 py-0.5 text-[10px] text-dim transition hover:bg-white/10 hover:text-ink"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            {BAND_LABELS.map((label, i) => (
              <div key={label} className="mb-1.5 flex items-center gap-2">
                <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-faint">{label}</span>
                <Slider
                  value={eq[i] ?? 0}
                  min={-12}
                  max={12}
                  onScrub={(v) => setEqBand(i, Math.round(v * 2) / 2)}
                  className="flex-1"
                  ariaLabel={`${label} Hz`}
                />
                <span className="w-9 shrink-0 text-[10px] tabular-nums text-dim">
                  {(eq[i] ?? 0) > 0 ? "+" : ""}
                  {(eq[i] ?? 0).toFixed(1)}
                </span>
              </div>
            ))}

            <div className="mt-4 space-y-3 border-t border-line pt-3">
              <label className="flex cursor-pointer items-center justify-between">
                <span className="text-xs text-dim">Normalize volume</span>
                <button
                  role="switch"
                  aria-checked={normOn}
                  onClick={() => setNormOn(!normOn)}
                  className={`relative h-5 w-9 rounded-full transition ${normOn ? "bg-ink" : "bg-white/15"}`}
                >
                  <span
                    className={`absolute top-0.5 size-4 rounded-full bg-panel transition-transform ${normOn ? "translate-x-4" : "translate-x-0.5"}`}
                  />
                </button>
              </label>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-dim">Crossfade</span>
                  <span className="text-[10px] tabular-nums text-faint">{fadeSecs === 0 ? "off" : `${fadeSecs}s`}</span>
                </div>
                <Slider
                  value={fadeSecs}
                  max={12}
                  onScrub={(v) => setFadeSecs(v)}
                  ariaLabel="Crossfade seconds"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
