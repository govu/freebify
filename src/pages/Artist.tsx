import { motion } from "motion/react"
import { BadgeCheck, Play, UserCheck, UserPlus, UserX } from "lucide-react"
import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { apiClient } from "../api/audius"
import { prefetchStream, yt } from "../api/youtube"
import type { Playlist, Track, User } from "../api/types"
import { PlaylistCard, Section } from "../components/Cards"
import { HeroSkeleton, RowsSkeleton } from "../components/Skeletons"
import { TrackTable } from "../components/TrackTable"
import { useT } from "../i18n"
import { useLibrary } from "../store/library"
import { usePlayer } from "../store/player"
import { fmtCount } from "../utils/format"

export function ArtistPage() {
  const { id } = useParams<{ id: string }>()
  // ?n= carries the display name — dead channel ids (private/deleted/browse
  // ids that merely LOOK like UC…) get a name-search rescue in the backend
  const nameHint = useSearchParams()[0].get("n") ?? undefined
  const [artist, setArtist] = useState<User | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [albums, setAlbums] = useState<Playlist[]>([])
  const [singles, setSingles] = useState<Playlist[]>([])
  const [allTracks, setAllTracks] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // track fetch fails independently — "hasn't uploaded tracks" is a lie
  // when the request simply didn't come back
  const [tracksError, setTracksError] = useState(false)
  const [retry, setRetry] = useState(0)
  // a dead CDN cover URL shouldn't leave a broken-image hero — and the
  // component isn't remounted between artists, so all image state must
  // reset when the route param changes (below, inside the effect)
  const [coverFailed, setCoverFailed] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [coverIdx, setCoverIdx] = useState(0)
  const [avatarIdx, setAvatarIdx] = useState(0)
  const playContext = usePlayer((s) => s.playContext)
  const followed = useLibrary((s) => Boolean(s.followed[artist?.id ?? ""]))
  const toggleFollow = useLibrary((s) => s.toggleFollow)
  const tt = useT()

  useEffect(() => {
    if (!id) return
    let live = true
    setLoading(true)
    setError(false)
    setTracksError(false)
    setCoverFailed(false)
    setAvatarFailed(false)
    setCoverIdx(0)
    setAvatarIdx(0)
    setAlbums([])
    setSingles([])
    setAllTracks(false)
    void (async () => {
      if (id.startsWith("yt-")) {
        try {
          const res = await yt.artist(id.slice(3), nameHint)
          if (!live) return
          if (res) {
            setArtist(res.user)
            setTracks(res.tracks)
            setAlbums(res.albums ?? [])
            setSingles(res.singles ?? [])
            res.tracks.slice(0, 6).forEach((t) => prefetchStream(t))
          } else setError(true)
        } catch {
          if (live) setError(true)
        }
        if (live) setLoading(false)
        return
      }
      const [u, t, a] = await Promise.allSettled([
        apiClient.user(id),
        apiClient.userTracks(id, 50),
        // Audius albums/singles ship as playlist objects — same card surface
        apiClient.userAlbums(id),
      ])
      if (!live) return
      if (u.status === "fulfilled") setArtist(u.value)
      else setError(true)
      if (t.status === "fulfilled") setTracks(t.value)
      else setTracksError(true)
      if (a.status === "fulfilled") setAlbums(a.value)
      setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [id, nameHint, retry])

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
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center">
          <div className="grid size-14 place-items-center rounded-full bg-hover">
            <UserX size={22} className="text-faint" />
          </div>
          <p className="mt-4 text-lg font-semibold">{tt("artist.notFound")}</p>
          <p className="mt-1 max-w-64 text-sm leading-5 text-dim">
            {nameHint ? tt("artist.notFound.named", { name: nameHint }) : tt("artist.notFound.sub")}
          </p>
          <button
            onClick={() => setRetry((r) => r + 1)}
            className="mt-5 rounded-full border border-line px-6 py-2 text-sm font-semibold transition hover:scale-[1.03] hover:border-white/30"
          >
            {tt("artist.retry")}
          </button>
        </motion.div>
      </div>
    )
  }

  const trackArt = tracks.find((t) => t.artwork?.["480x480"] || t.artwork?.["150x150"])?.artwork ?? null
  const avatars = [
    ...new Set(
      [
        artist.profile_picture?.["480x480"],
        artist.profile_picture?.["150x150"],
        trackArt?.["480x480"],
        trackArt?.["150x150"],
      ].filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  ]
  const avatar = avatars[Math.min(avatarIdx, avatars.length - 1)] ?? null
  // ordered candidates — a dead googleusercontent token shouldn't kill the
  // hero when another size of the same banner still serves
  const covers = [
    ...new Set(
      [artist.cover_photo?.["2000x"], artist.cover_photo?.["640x"], avatar].filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      ),
    ),
  ]
  const cover = covers[Math.min(coverIdx, covers.length - 1)] ?? null

  return (
    <div className="-mt-12 pb-10">
      {/* hero */}
      <div className="relative flex min-h-64 items-end overflow-hidden">
        {cover && !coverFailed ? (
          <HeroImg
            src={cover}
            onGiveUp={() =>
              coverIdx + 1 < covers.length ? setCoverIdx((i) => i + 1) : setCoverFailed(true)
            }
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
          className="relative flex items-end gap-5 px-6 pb-6"
        >
          {avatar && !avatarFailed ? (
            <HeroImg
              src={avatar}
              onGiveUp={() =>
                avatarIdx + 1 < avatars.length ? setAvatarIdx((i) => i + 1) : setAvatarFailed(true)
              }
              className="size-24 shrink-0 rounded-full border-2 border-white/15 bg-panel object-cover shadow-2xl shadow-black/60 sm:size-28"
            />
          ) : (
            <div className="grid size-24 shrink-0 place-items-center rounded-full border-2 border-white/15 bg-panel text-4xl font-black text-dim shadow-2xl shadow-black/60 sm:size-28">
              {artist.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
          {artist.is_verified && (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <BadgeCheck size={15} /> {tt("artist.verified")}
            </p>
          )}
          <h1 className="mt-1 text-4xl font-black tracking-tight drop-shadow-lg sm:text-6xl">{artist.name}</h1>
          <p className="mt-2 text-sm text-ink/80">
            {artist.id.startsWith("yt-")
              ? tt("artist.monthlyListeners", { n: fmtCount(artist.follower_count) })
              : tt("artist.stats", { followers: fmtCount(artist.follower_count), tracks: artist.track_count })}
            {artist.location ? ` · ${artist.location}` : ""}
          </p>
          </div>
        </motion.div>
      </div>

      <div className="px-6 pt-5">
        <div className="mb-6 flex items-center gap-3">
          {tracks.length > 0 && (
            <button
              onClick={() => playContext(tracks, 0)}
              className="flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
            >
              <Play size={16} className="fill-current" /> {tt("artist.play")}
            </button>
          )}
          <button
            onClick={() => artist && toggleFollow(artist)}
            aria-pressed={followed}
            className={`flex items-center gap-2 rounded-full border px-6 py-3 text-sm font-bold text-ink transition ${
              followed
                ? "border-white/10 bg-white/10"
                : "border-white/25 hover:border-white"
            }`}
          >
            {followed ? <UserCheck size={16} /> : <UserPlus size={16} />}
            {followed ? tt("artist.following") : tt("artist.follow")}
          </button>
        </div>

        <h2 className="mb-2 text-xl font-bold">{tt("artist.popular")}</h2>
        {tracksError ? (
          <div className="py-10 text-sm text-dim">
            <p>{tt("artist.tracksError")}</p>
            <button
              onClick={() => setRetry((r) => r + 1)}
              className="mt-3 rounded-full border border-line px-5 py-1.5 text-xs font-semibold transition hover:border-white/30"
            >
              {tt("artist.retry")}
            </button>
          </div>
        ) : tracks.length > 0 ? (
          <>
            {/* the table caps at 15 rows — a 100-song list would bury the
                discography; context= keeps the play queue on the FULL list
                so row clicks queue everything, not just the slice */}
            <TrackTable tracks={allTracks ? tracks : tracks.slice(0, 15)} context={tracks} />
            {tracks.length > 15 && (
              <button
                onClick={() => setAllTracks((v) => !v)}
                className="mt-2 rounded-full px-3 py-1.5 text-xs font-semibold text-dim transition hover:bg-hover hover:text-ink"
              >
                {allTracks ? tt("artist.showLess") : tt("artist.showAll", { n: tracks.length })}
              </button>
            )}
          </>
        ) : (
          <p className="py-10 text-sm text-dim">{tt("artist.noTracks")}</p>
        )}
      </div>

      {albums.length > 0 && (
        <div className="mt-4">
          <Section title={tt("artist.albums")}>{albums.map((p) => <PlaylistCard key={p.id} p={p} />)}</Section>
        </div>
      )}
      {singles.length > 0 && (
        <div className={albums.length > 0 ? "" : "mt-4"}>
          <Section title={tt("artist.singles")}>{singles.map((p) => <PlaylistCard key={p.id} p={p} />)}</Section>
        </div>
      )}

      {artist.bio && (
        <div className="mt-10 max-w-2xl px-6">
          <h2 className="mb-2 text-xl font-bold">{tt("artist.about")}</h2>
          <p className="whitespace-pre-line text-sm leading-6 text-dim">{artist.bio}</p>
        </div>
      )}
    </div>
  )
}

// A transient CDN failure (googleusercontent rate-limits hot sessions with
// 429s, flaky wifi, DNS hiccup) would mark the hero dead for the whole
// mount — retry with fresh img elements before giving up to the fallback.
function HeroImg({
  src,
  onGiveUp,
  className,
}: {
  src: string
  onGiveUp: () => void
  className: string
}) {
  const [attempt, setAttempt] = useState(0)
  const [dead, setDead] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setAttempt(0)
    setDead(false)
    setLoaded(false)
  }, [src])
  if (dead) return null
  return (
    <img
      key={`${src}:${attempt}`}
      src={src}
      alt=""
      onLoad={() => setLoaded(true)}
      onError={() => {
        if (attempt < 3) setTimeout(() => setAttempt((a) => a + 1), 1200 * (attempt + 1))
        else {
          setDead(true)
          onGiveUp()
        }
      }}
      // invisible until a successful decode — a retrying element would
      // otherwise flash the browser's broken-image glyph over the hero
      style={{ opacity: loaded ? 1 : 0 }}
      className={className}
    />
  )
}
