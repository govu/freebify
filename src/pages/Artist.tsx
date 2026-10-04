import { motion } from "motion/react"
import { BadgeCheck, Play } from "lucide-react"
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { apiClient } from "../api/audius"
import { prefetchStream, yt } from "../api/youtube"
import type { Track, User } from "../api/types"
import { HeroSkeleton, RowsSkeleton } from "../components/Skeletons"
import { TrackTable } from "../components/TrackTable"
import { usePlayer } from "../store/player"
import { fmtCount } from "../utils/format"

export function ArtistPage() {
  const { id } = useParams<{ id: string }>()
  const [artist, setArtist] = useState<User | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // track fetch fails independently — "hasn't uploaded tracks" is a lie
  // when the request simply didn't come back
  const [tracksError, setTracksError] = useState(false)
  const [retry, setRetry] = useState(0)
  // a dead CDN cover URL shouldn't leave a broken-image hero
  const [coverFailed, setCoverFailed] = useState(false)
  const playContext = usePlayer((s) => s.playContext)

  useEffect(() => {
    if (!id) return
    let live = true
    setLoading(true)
    setError(false)
    setTracksError(false)
    void (async () => {
      if (id.startsWith("yt-")) {
        try {
          const res = await yt.artist(id.slice(3))
          if (!live) return
          if (res) {
            setArtist(res.user)
            setTracks(res.tracks)
            res.tracks.slice(0, 6).forEach((t) => prefetchStream(t))
          } else setError(true)
        } catch {
          if (live) setError(true)
        }
        if (live) setLoading(false)
        return
      }
      const [u, t] = await Promise.allSettled([apiClient.user(id), apiClient.userTracks(id, 50)])
      if (!live) return
      if (u.status === "fulfilled") setArtist(u.value)
      else setError(true)
      if (t.status === "fulfilled") setTracks(t.value)
      else setTracksError(true)
      setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [id, retry])

  if (loading) {
    return (
      <div className="-mt-12">
        {/* artist heroes are cover banners, not square art — cover={false}
            so the skeleton doesn't promise a layout that never arrives */}
        <HeroSkeleton cover={false} />
        <div className="px-6">
          <RowsSkeleton />
        </div>
      </div>
    )
  }

  if (error || !artist) {
    return (
      <div className="grid place-items-center py-32 text-center">
        <div>
          <p className="text-lg font-semibold">Artist not found</p>
          <p className="mt-1 text-sm text-dim">They may have moved or the network hiccuped.</p>
          <button
            onClick={() => setRetry((r) => r + 1)}
            className="mt-5 rounded-full border border-line px-6 py-2 text-sm font-semibold transition hover:scale-[1.03] hover:border-white/30"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const cover = artist.cover_photo?.["2000x"] ?? artist.cover_photo?.["640x"]

  return (
    <div className="-mt-12 pb-10">
      {/* hero */}
      <div className="relative flex min-h-64 items-end overflow-hidden">
        {cover && !coverFailed ? (
          <img
            src={cover}
            alt=""
            onError={() => setCoverFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-hover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="relative px-6 pb-6"
        >
          {artist.is_verified && (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <BadgeCheck size={15} /> Verified artist
            </p>
          )}
          <h1 className="mt-1 text-4xl font-black tracking-tight drop-shadow-lg sm:text-6xl">{artist.name}</h1>
          <p className="mt-2 text-sm text-ink/80">
            {artist.id.startsWith("yt-")
              ? `${fmtCount(artist.follower_count)} monthly listeners`
              : `${fmtCount(artist.follower_count)} followers · ${artist.track_count} tracks`}
            {artist.location ? ` · ${artist.location}` : ""}
          </p>
        </motion.div>
      </div>

      <div className="px-6 pt-5">
        {tracks.length > 0 && (
          <button
            onClick={() => playContext(tracks, 0)}
            className="mb-6 flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
          >
            <Play size={16} className="fill-current" /> Play
          </button>
        )}

        <h2 className="mb-2 text-xl font-bold">Popular</h2>
        {tracksError ? (
          <div className="py-10 text-sm text-dim">
            <p>Couldn't load the tracks — the artist page itself is fine.</p>
            <button
              onClick={() => setRetry((r) => r + 1)}
              className="mt-3 rounded-full border border-line px-5 py-1.5 text-xs font-semibold transition hover:border-white/30"
            >
              Retry
            </button>
          </div>
        ) : tracks.length > 0 ? (
          <TrackTable tracks={tracks} />
        ) : (
          <p className="py-10 text-sm text-dim">This artist hasn't uploaded tracks yet.</p>
        )}

        {artist.bio && (
          <div className="mt-10 max-w-2xl">
            <h2 className="mb-2 text-xl font-bold">About</h2>
            <p className="whitespace-pre-line text-sm leading-6 text-dim">{artist.bio}</p>
          </div>
        )}
      </div>
    </div>
  )
}
