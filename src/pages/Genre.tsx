import { motion } from "motion/react"
import { Play } from "lucide-react"
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { apiClient, originalsOnly } from "../api/audius"
import { prefetchStream, yt, ytAvailable } from "../api/youtube"
import type { Track, TrendTime } from "../api/types"
import { RowsSkeleton } from "../components/Skeletons"
import { TrackTable } from "../components/TrackTable"
import { usePlayer } from "../store/player"

const TIMES: { id: TrendTime; label: string }[] = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "allTime", label: "All time" },
]

export function GenrePage() {
  const { name = "" } = useParams<{ name: string }>()
  // useParams already decodes — decoding AGAIN throws URIError on names
  // containing a literal % (e.g. "/genre/100%")
  const genre = name
  const [time, setTime] = useState<TrendTime>("week")
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [run, setRun] = useState(0)
  // YouTube gives the genre's real catalog; the time chips switch to
  // Audius trending (the only source with period-based charts).
  const [source, setSource] = useState<"yt" | "audius">("yt")
  const playContext = usePlayer((s) => s.playContext)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(false)
    void (async () => {
      if (source === "yt" && (await ytAvailable())) {
        try {
          const res = await yt.search(`${genre} hits`)
          if (!live) return
          if (res.tracks.length) {
            setTracks(res.tracks.slice(0, 60))
            res.tracks.slice(0, 6).forEach((t) => prefetchStream(t))
            return
          }
        } catch { /* fall through to Audius */ }
      }
      try {
        const t = await apiClient.trendingTracks({ genre, time, limit: 80 })
        if (live) setTracks(originalsOnly(t))
      } catch {
        // distinguishable from a genre that genuinely has no chart
        if (live) setError(true)
      }
    })().finally(() => {
      if (live) setLoading(false)
    })
    return () => {
      live = false
    }
  }, [genre, time, source, run])

  return (
    <div className="-mt-12 pb-10">
      <div
        className="px-6 pb-8 pt-20"
        style={{
          // neutral hero glow — the design language is strictly grayscale;
          // the old per-genre tinted gradient was the odd one out
          background:
            "radial-gradient(70% 100% at 20% 0%, rgb(255 255 255 / 0.08), transparent 60%)",
        }}
      >
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <p className="text-xs font-semibold text-ink/70">
            Genre {source === "audius" ? "· trending" : ""}
          </p>
          <h1 className="mt-2 text-4xl font-black tracking-tight drop-shadow-lg sm:text-6xl">
            {genre}
          </h1>
        </motion.div>

        <div className="mt-6 flex items-center gap-2">
          <button
            onClick={() => setSource("yt")}
            aria-pressed={source === "yt"}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
              source === "yt" ? "bg-white text-black" : "bg-white/10 text-dim hover:bg-white/15 hover:text-ink"
            }`}
          >
            Top hits
          </button>
          {TIMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTime(t.id)
                setSource("audius")
              }}
              aria-pressed={source === "audius" && time === t.id}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                source === "audius" && time === t.id
                  ? "bg-white text-black"
                  : "bg-white/10 text-dim hover:bg-white/15 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pt-5">
        {tracks.length > 0 && !loading && (
          <button
            onClick={() => playContext(tracks, 0)}
            className="mb-6 flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
          >
            <Play size={16} className="fill-current" /> Play
          </button>
        )}
        {loading ? (
          <RowsSkeleton count={12} />
        ) : error ? (
          <div className="py-10 text-sm text-dim">
            <p>Couldn't load this genre right now.</p>
            <button
              onClick={() => setRun((r) => r + 1)}
              className="mt-3 rounded-full border border-line px-5 py-1.5 text-xs font-semibold transition hover:border-white/30"
            >
              Retry
            </button>
          </div>
        ) : (
          <TrackTable tracks={tracks} />
        )}
      </div>
    </div>
  )
}
