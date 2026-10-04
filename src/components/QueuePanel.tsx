import { AnimatePresence, motion } from "motion/react"
import { GripVertical, Infinity as InfinityIcon, ListPlus, Trash2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useLibrary } from "../store/library"
import { notify, usePlayer } from "../store/player"
import { fmtDuration } from "../utils/format"
import { ArtworkImg } from "./ArtworkImg"
import { Equalizer } from "./Equalizer"

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const jumpTo = usePlayer((s) => s.jumpTo)
  const toggle = usePlayer((s) => s.toggle)
  const removeAt = usePlayer((s) => s.removeAt)
  const clearQueue = usePlayer((s) => s.clearQueue)
  const autoplay = usePlayer((s) => s.autoplay)
  const setAutoplay = usePlayer((s) => s.setAutoplay)
  const setQueueOpen = usePlayer((s) => s.setQueueOpen)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addTracksToPlaylist = useLibrary((s) => s.addTracksToPlaylist)
  const moveInQueue = usePlayer((s) => s.moveInQueue)
  const [saved, setSaved] = useState(false)
  // drag-to-reorder — indices are absolute queue indices, not upNext-local
  const [dragI, setDragI] = useState<number | null>(null)
  const [overI, setOverI] = useState<number | null>(null)

  const upNext = queue.slice(index + 1)

  const saveAsPlaylist = () => {
    if (saved) return // double-click would create two identical playlists
    const pid = createPlaylist()
    // only what you'd actually hear next — already-played history isn't
    // part of "the queue" in the user's mental model. One bulk set():
    // the per-track loop serialized the store on every call.
    addTracksToPlaylist(pid, queue.slice(Math.max(0, index)))
    setSaved(true)
    notify("Saved queue as playlist")
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 34 }}
      // below lg the layout row disappears entirely — the queue becomes a
      // fixed overlay on the right edge (min window 940px < lg breakpoint).
      // top-12 keeps the header clear of the invisible drag band + the
      // floating window controls in the top-right corner
      // (top-0 would bury the header buttons under window controls)
      className="fixed bottom-[88px] right-0 top-12 z-[45] w-80 shrink-0 overflow-hidden border-l border-line bg-panel shadow-2xl shadow-black/60 lg:relative lg:bottom-auto lg:top-auto lg:z-auto lg:shadow-none"
    >
      {/* lg:relative puts the panel flush against the window's top edge —
          its header row would sit under the floating min/max/close
          controls; pt-11 clears that strip (in overlay mode top-12 on the
          aside already provides the clearance) */}
      <div className="flex h-full w-80 flex-col lg:pt-11">
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="font-bold">Queue</h3>
          <div className="flex items-center gap-1">
            {queue.length > 1 && (
              <button
                onClick={clearQueue}
                title="Clear queue"
                aria-label="Clear queue"
                className="grid size-7 place-items-center rounded-full text-dim transition hover:bg-hover hover:text-ink"
              >
                <Trash2 size={14} />
              </button>
            )}
            {queue.length > 0 && (
              <button
                onClick={saveAsPlaylist}
                title="Save queue as playlist"
                aria-label="Save queue as playlist"
                className={`grid size-7 place-items-center rounded-full transition hover:bg-hover ${
                  saved ? "text-ink" : "text-dim hover:text-ink"
                }`}
              >
                <ListPlus size={15} />
              </button>
            )}
            <button
              onClick={() => setQueueOpen(false)}
              aria-label="Close queue"
              className="grid size-7 place-items-center rounded-full text-dim transition hover:bg-hover hover:text-ink"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* autoplay toggle — Spotify's "similar content will keep playing" */}
        <button
          onClick={() => setAutoplay(!autoplay)}
          aria-pressed={autoplay}
          className="mx-3 mb-2 flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover"
        >
          <InfinityIcon size={15} className={autoplay ? "text-ink" : "text-faint"} />
          <span className={`flex-1 text-xs font-medium ${autoplay ? "text-ink" : "text-dim"}`}>
            Autoplay similar songs
          </span>
          <span
            className={`relative h-4 w-7 rounded-full transition-colors ${autoplay ? "bg-ink" : "bg-hover"}`}
          >
            <motion.span
              layout
              transition={{ type: "spring", stiffness: 500, damping: 34 }}
              className={`absolute top-0.5 size-3 rounded-full ${autoplay ? "left-3.5 bg-black" : "left-0.5 bg-dim"}`}
            />
          </span>
        </button>

        <div className="scroller min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {queue[index] && (
            <>
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Now playing</p>
              {/* tapping the live row toggles instead of restarting */}
              <QueueRow track={queue[index]} active playing={isPlaying} onClick={toggle} />
            </>
          )}
          {upNext.length > 0 && (
            <>
              <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">
                Next up <span className="normal-case tracking-normal text-faint/60">· drag to reorder</span>
              </p>
              <AnimatePresence initial={false}>
                {upNext.map((t, k) => {
                  const i = index + 1 + k
                  return (
                    <QueueRow
                      key={`${t.streamId ?? t.id}-${i}`}
                      track={t}
                      onClick={() => jumpTo(i)}
                      onRemove={() => removeAt(i)}
                      dragging={dragI === i}
                      dropAbove={overI === i && dragI !== null && dragI !== i}
                      drag={{
                        onDragStart: (e) => {
                          e.dataTransfer!.effectAllowed = "move"
                          e.dataTransfer!.setData("text/plain", String(i))
                          setDragI(i)
                        },
                        onDragOver: (e) => {
                          e.preventDefault()
                          e.dataTransfer!.dropEffect = "move"
                          if (overI !== i) setOverI(i)
                        },
                        onDrop: (e) => {
                          e.preventDefault()
                          if (dragI !== null && dragI !== i) moveInQueue(dragI, i)
                          setDragI(null)
                          setOverI(null)
                        },
                        onDragEnd: () => {
                          setDragI(null)
                          setOverI(null)
                        },
                      }}
                    />
                  )
                })}
              </AnimatePresence>
            </>
          )}
          {queue.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-dim">Your queue is empty.</p>
          )}
          {queue.length > 0 && upNext.length === 0 && !autoplay && (
            <p className="px-4 py-6 text-center text-xs text-dim">
              End of queue — enable autoplay to keep the music going.
            </p>
          )}
        </div>
      </div>
    </motion.aside>
  )
}

function QueueRow({
  track: t,
  active,
  playing,
  onClick,
  onRemove,
  drag,
  dragging,
  dropAbove,
}: {
  track: import("../api/types").Track
  active?: boolean
  playing?: boolean
  onClick: () => void
  onRemove?: () => void
  drag?: {
    onDragStart: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
    onDragEnd: (e: DragEvent) => void
  }
  dragging?: boolean
  dropAbove?: boolean
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  // HTML5 drag handlers can't go through motion.div's props — motion
  // consumes onDrag*/draggable as its own gesture API. Bind them
  // imperatively on the real element instead.
  useEffect(() => {
    const el = rowRef.current
    if (!el || !drag) return
    el.draggable = true
    const pairs: [string, EventListener][] = [
      ["dragstart", drag.onDragStart as EventListener],
      ["dragover", drag.onDragOver as EventListener],
      ["drop", drag.onDrop as EventListener],
      ["dragend", drag.onDragEnd as EventListener],
    ]
    for (const [ev, fn] of pairs) el.addEventListener(ev, fn)
    return () => {
      for (const [ev, fn] of pairs) el.removeEventListener(ev, fn)
      el.draggable = false
    }
  }, [drag])
  return (
    <motion.div
      ref={rowRef}
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.16 } }}
      transition={{ duration: 0.18 }}
      className={`group/row relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover ${
        active ? "bg-hover/60" : ""
      } ${dragging ? "opacity-40" : ""} ${dropAbove ? "shadow-[inset_0_2px_0_0_#fff]" : ""} ${
        drag ? "select-none" : ""
      }`}
    >
      {drag && (
        <GripVertical
          size={14}
          className="-ml-1 shrink-0 cursor-grab text-faint opacity-0 transition group-hover/row:opacity-100"
        />
      )}
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative size-10 shrink-0 overflow-hidden rounded-md">
          <ArtworkImg art={t.artwork} size="150x150" alt="" className="size-full" iconSize={14} />
          {active && (
            <span className="absolute inset-0 grid place-items-center bg-black/45">
              <Equalizer playing={playing ?? false} className="text-white" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-medium ${active ? "text-ink" : ""}`}>{t.title}</span>
          <span className="block truncate text-xs text-dim">{t.user.name}</span>
        </span>
      </button>
      <span className="text-xs tabular-nums text-dim">{fmtDuration(t.duration)}</span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${t.title} from queue`}
          className="grid size-6 shrink-0 place-items-center rounded-full text-faint opacity-0 transition hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <X size={13} />
        </button>
      )}
    </motion.div>
  )
}
