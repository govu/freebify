import { motion } from "motion/react"
import { Download, FolderOpen, Loader2, Play, Search, X } from "lucide-react"
import { useMemo } from "react"
import { Link } from "react-router-dom"
import { ArtworkImg } from "../components/ArtworkImg"
import { TrackTable } from "../components/TrackTable"
import { useDownloads } from "../store/downloads"
import { usePlayer } from "../store/player"

export function DownloadsPage() {
  const items = useDownloads((s) => s.items)
  const progress = useDownloads((s) => s.progress)
  const pendingTracks = useDownloads((s) => s.pendingTracks)
  const queued = useDownloads((s) => s.queued)
  const remove = useDownloads((s) => s.remove)
  const playContext = usePlayer((s) => s.playContext)
  const canDl = Boolean(window.freebify?.dl)

  // newest first — the manifest returns insertion order, not recency
  const tracks = useMemo(
    () =>
      Object.values(items)
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((i) => i.track),
    [items],
  )
  // every row the renderer knows about: actively downloading OR queued
  const busyIds = Object.keys({ ...progress, ...queued })
  const busy = busyIds.map((id) => ({
    id,
    track: pendingTracks[id] ?? items[id]?.track,
    isQueued: progress[id] === undefined,
    pct: progress[id] ?? 0,
  }))

  return (
    <div className="-mt-12 pb-10">
      {/* hero */}
      <div
        className="relative flex items-end gap-6 px-6 pb-8 pt-20"
        style={{
          background:
            "linear-gradient(180deg, rgb(255 255 255 / 0.1), transparent), radial-gradient(60% 100% at 80% 0%, rgb(255 255 255 / 0.05), transparent)",
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="grid size-40 shrink-0 place-items-center rounded-2xl bg-white shadow-2xl shadow-black/50 sm:size-52"
        >
          <Download size={72} className="text-black" />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.08 }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-ink/70">Offline</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-6xl">Downloads</h1>
          <p className="mt-3 text-sm text-dim">
            {tracks.length} tracks — stored on this device, playable offline
          </p>
          {canDl && (
            <button
              onClick={() => window.freebify!.dl!.openDir()}
              className="mt-4 flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <FolderOpen size={13} /> Open downloads folder
            </button>
          )}
        </motion.div>
      </div>

      <div className="px-6">
        {busy.length > 0 && (
          <div className="mb-6 space-y-1.5">
            {busy.map(({ id, track, isQueued, pct }) => (
              <div key={id} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2">
                {track?.artwork ? (
                  <ArtworkImg art={track.artwork} size="150x150" alt="" className="size-9 shrink-0 rounded-md" />
                ) : (
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-panel">
                    <Download size={13} className="text-faint" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{track?.title ?? id}</p>
                  <p className="truncate text-xs text-dim">{track?.user?.name}</p>
                </div>
                {/* thin progress line under the row content is overkill —
                    a pill + percent reads cleaner and matches the table */}
                {isQueued ? (
                  <span className="rounded-full border border-line px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                    Queued
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs tabular-nums text-dim">
                    <Loader2 size={11} className="animate-spin" />
                    {pct}%
                  </span>
                )}
                <button
                  onClick={() => void remove(id)}
                  aria-label="Cancel download"
                  className="grid size-7 shrink-0 place-items-center rounded-full text-faint transition hover:bg-white/10 hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {tracks.length > 0 ? (
          <>
            <button
              onClick={() => playContext(tracks, 0)}
              className="mb-6 flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
            >
              <Play size={16} className="fill-current" /> Play all
            </button>
            <TrackTable
              tracks={tracks}
              onRemove={(t) => void remove(t.id)}
              removeLabel="Delete download"
            />
          </>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center rounded-2xl border border-dashed border-line py-20 text-center"
          >
            <Download size={44} className="text-faint" />
            <p className="mt-4 text-lg font-semibold">Nothing downloaded yet</p>
            <p className="mt-1 max-w-sm text-sm text-dim">
              {canDl
                ? "Open the ··· menu on any track and choose Download — it plays instantly, even offline."
                : "Downloads need the desktop app."}
            </p>
            {canDl && (
              <Link
                to="/search"
                className="mt-6 flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black transition hover:scale-105"
              >
                <Search size={15} /> Find something to keep
              </Link>
            )}
          </motion.div>
        )}
      </div>
    </div>
  )
}
