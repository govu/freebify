import { AnimatePresence, motion } from "motion/react"
import { usePlayer } from "../store/player"

// Transient bottom toast — surfaces errors the player can recover from
// (e.g. the circuit breaker stopping after repeated stream failures).
export function Toast() {
  const notice = usePlayer((s) => s.notice)
  // role=status + aria-live: playback errors are otherwise invisible to
  // screen readers
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex justify-center">
      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice}
            role="status"
            aria-live="polite"
            initial={{ y: 14, opacity: 0, scale: 0.97 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 8, opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            className="rounded-lg border border-white/10 bg-card/95 px-4 py-2.5 text-[13px] font-medium text-ink shadow-2xl shadow-black/60 backdrop-blur"
          >
            {notice}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
