import { ChevronLeft, ChevronRight } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"

export function TopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  // react-router tracks the history stack index — back is a no-op at 0
  const hist = window.history.state as { idx?: number; len?: number } | null
  const canBack = (hist?.idx ?? 0) > 0
  // forward is a no-op at the stack's tip — reflect that like Back does,
  // instead of a live-looking button that silently does nothing
  const canFwd = hist?.len != null && (hist.idx ?? 0) < hist.len - 1
  return (
    <header className="pointer-events-none sticky top-0 z-30 flex items-center gap-2 bg-gradient-to-b from-bg via-bg/80 to-transparent px-5 pb-10 pt-3">
      {/* invisible drag band — the top ~48px of the content column is the
          window's drag region (pointer-events stays off below it so cards
          scrolled under the gradient remain clickable). It stops short of
          the floating window controls: a no-drag element OVERLAPPING a drag
          region forces Windows to resolve the app-region hole on every
          click (and can eat it waiting for a drag/double-click) — keeping
          them physically separate makes the controls respond instantly */}
      <div className="drag-region pointer-events-auto absolute left-0 right-[140px] top-0 h-12" />
      <div className="no-drag pointer-events-auto relative flex gap-2">
        <button
          onClick={() => canBack && navigate(-1)}
          disabled={!canBack}
          aria-label="Back"
          className="grid size-8 place-items-center rounded-full border border-line bg-panel/80 text-dim backdrop-blur transition enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-35"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          onClick={() => canFwd && navigate(1)}
          disabled={!canFwd}
          aria-label="Forward"
          className="grid size-8 place-items-center rounded-full border border-line bg-panel/80 text-dim backdrop-blur transition enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-35"
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="flex-1" />
      {/* suppress unused-var warning for location — it forces re-render so
          the back-enabled state tracks the history index */}
      <span className="hidden">{location.key}</span>
    </header>
  )
}
