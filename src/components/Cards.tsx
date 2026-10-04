import { motion } from "motion/react"
import { BadgeCheck, ChevronLeft, ChevronRight, ListMusic, Play } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { Playlist, Track, User } from "../api/types"
import { prefetchStream, yt } from "../api/youtube"
import { usePlayer } from "../store/player"
import type { LocalPlaylist } from "../store/library"
import { fmtCount } from "../utils/format"
import { ArtworkImg } from "./ArtworkImg"
import { Equalizer } from "./Equalizer"

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null)
  // scroll edge state drives arrow visibility — no point offering a right
  // arrow when the row is already at its end
  const [edges, setEdges] = useState({ start: true, end: false })
  const update = () => {
    const el = rowRef.current
    if (!el) return
    setEdges({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    })
  }
  // measure once on mount + whenever children could change the scrollable
  // width (late-loading cards widen the row after first paint)
  useEffect(() => {
    update()
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children])
  const scrollBy = (dir: -1 | 1) => {
    const el = rowRef.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" })
  }
  return (
    <section className="group/sec relative mb-10">
      <div className="mb-4 flex items-baseline justify-between px-6">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      </div>
      <div className="relative">
        {/* pt-1 keeps the card hover-lift (y:-4) from clipping — overflow-x
            auto forces overflow-y auto, so the top edge would get cut
            on every hover without the padding */}
        <div
          ref={rowRef}
          onScroll={update}
          className="no-scrollbar flex gap-4 overflow-x-auto px-6 pb-2 pt-1"
        >
          {children}
        </div>
        {!edges.start && (
          <button
            onClick={() => scrollBy(-1)}
            aria-label="Scroll left"
            className="absolute left-1 top-[40%] z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-panel/95 text-ink opacity-0 shadow-xl shadow-black/60 ring-1 ring-line backdrop-blur transition hover:scale-110 hover:bg-cardhover focus-visible:opacity-100 group-hover/sec:opacity-100"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        {!edges.end && (
          <button
            onClick={() => scrollBy(1)}
            aria-label="Scroll right"
            className="absolute right-1 top-[40%] z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-panel/95 text-ink opacity-0 shadow-xl shadow-black/60 ring-1 ring-line backdrop-blur transition hover:scale-110 hover:bg-cardhover focus-visible:opacity-100 group-hover/sec:opacity-100"
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>
    </section>
  )
}

function PlayFAB({ onClick, playing }: { onClick: (e: React.MouseEvent) => void; playing?: boolean }) {
  return (
    <motion.button
      onClick={onClick}
      aria-label="Play"
      initial={false}
      whileTap={{ scale: 0.9 }}
      className="absolute bottom-3 right-3 z-10 grid size-11 translate-y-2 place-items-center rounded-full bg-white text-black opacity-0 shadow-xl shadow-black/40 transition-all duration-200 hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100"
    >
      {playing ? <Equalizer playing className="h-3.5" /> : <Play size={18} className="ml-0.5 fill-current" />}
    </motion.button>
  )
}

const cardCls =
  "group relative w-44 shrink-0 rounded-xl bg-card p-3 transition-all duration-200 hover:bg-cardhover"

export function TrackCard({ t, context }: { t: Track; context?: Track[] }) {
  const playTrack = usePlayer((s) => s.playTrack)
  const toggle = usePlayer((s) => s.toggle)
  const isCurrent = usePlayer((s) => s.current?.id === t.id)
  // combined selector: non-current cards always yield `false`, so a global
  // play/pause only re-renders the ONE card whose icon actually changes
  const isCurPlaying = usePlayer((s) => s.current?.id === t.id && s.isPlaying)
  // clicking the card of the track that's already loaded toggles it —
  // replaying from 0 on a pause-click feels broken
  const play = () => (isCurrent ? toggle() : playTrack(t, context))

  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }} className={cardCls}>
      <div
        role="button"
        tabIndex={0}
        onMouseEnter={() => prefetchStream(t)}
        onClick={play}
        onKeyDown={(e) => e.key === "Enter" && play()}
        className="cursor-pointer"
      >
        <div className="relative">
          <ArtworkImg art={t.artwork} alt={t.title} className="aspect-square w-full rounded-lg" />
          <PlayFAB playing={isCurPlaying} onClick={(e) => { e.stopPropagation(); play() }} />
        </div>
        <p className={`mt-3 truncate text-sm font-semibold ${isCurrent ? "underline decoration-white/30 underline-offset-4" : ""}`}>{t.title}</p>
        <p className="mt-0.5 truncate text-xs text-dim">{t.user.name}</p>
      </div>
    </motion.div>
  )
}

// Editorial playlist covers come with the YouTube Music logo baked into
// the artwork — ugly and generic. Instead, lazily fetch the first 4 track
// artworks and compose a Spotify-style 2×2 collage (only when the card
// scrolls into view — a full row of getPlaylist calls would be wasteful).
function CollageCover({ p, alt }: { p: Playlist; alt: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [arts, setArts] = useState<string[] | null>(null)
  const browseId = p.id.replace(/^(ytpl|ytalb)-/, "")

  useEffect(() => {
    const el = ref.current
    if (!el || !browseId || arts !== null) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          io.disconnect()
          void yt.playlistArts(browseId).then(setArts).catch(() => setArts([]))
        }
      },
      { rootMargin: "200px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [browseId, arts])

  if (arts && arts.length >= 4) {
    return (
      <div ref={ref} className="grid aspect-square w-full grid-cols-2 overflow-hidden rounded-lg">
        {arts.slice(0, 4).map((src, i) => (
          <img
            key={i}
            src={src}
            alt=""
            loading="lazy"
            className="aspect-square w-full object-cover"
            // a dead thumb inside the collage shows a broken-image tile —
            // hide it so the grid stays clean
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.opacity = "0"
            }}
          />
        ))}
      </div>
    )
  }
  if (arts && arts.length > 0) {
    return (
      <div ref={ref}>
        <img src={arts[0]} alt={alt} loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
      </div>
    )
  }
  // still loading or no arts — show the playlist's own cover as fallback
  return (
    <div ref={ref}>
      <ArtworkImg art={p.artwork} alt={alt} className="aspect-square w-full rounded-lg" />
    </div>
  )
}

export function PlaylistCard({ p }: { p: Playlist }) {
  // only yt editorial playlists get the collage treatment — Audius covers
  // are already clean real artwork
  const isYt = p.id.startsWith("ytpl-") || p.id.startsWith("ytalb-")
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }}>
      <Link to={`/playlist/${encodeURIComponent(p.id)}`} className={`block ${cardCls}`}>
        <div className="relative">
          {isYt ? (
            <CollageCover p={p} alt={p.playlist_name} />
          ) : (
            <ArtworkImg art={p.artwork} alt={p.playlist_name} className="aspect-square w-full rounded-lg" />
          )}
        </div>
        <p className="mt-3 truncate text-sm font-semibold">{p.playlist_name}</p>
        <p className="mt-0.5 truncate text-xs text-dim">
          {p.is_album ? "Album" : "Playlist"} · {p.total_play_count ? `${fmtCount(p.total_play_count)} plays` : p.user.name}
        </p>
      </Link>
    </motion.div>
  )
}

/** 2×2 artwork collage (or single cover / icon) for user playlists */
export function PlaylistCover({
  tracks,
  className,
  iconSize = 32,
}: {
  tracks: Track[]
  className?: string
  iconSize?: number
}) {
  // tracks missing 150x150 (some Audius artwork only ships larger sizes)
  // would collapse a 4-cover collage into the single-image branch
  const arts = tracks
    .map((t) => t.artwork?.["150x150"] ?? t.artwork?.["480x480"] ?? t.artwork?.["1000x1000"])
    .filter(Boolean)
    .slice(0, 4)
  if (arts.length >= 4) {
    return (
      <div className={`grid grid-cols-2 overflow-hidden ${className ?? ""}`}>
        {arts.map((src, i) => (
          <img key={i} src={src!} alt="" loading="lazy" className="aspect-square w-full object-cover" />
        ))}
      </div>
    )
  }
  if (arts.length > 0) {
    return <img src={arts[0]!} alt="" loading="lazy" className={`aspect-square w-full object-cover ${className ?? ""}`} />
  }
  return (
    <div className={`grid aspect-square w-full place-items-center bg-hover ${className ?? ""}`}>
      <ListMusic size={iconSize} className="text-faint" />
    </div>
  )
}

export function LocalPlaylistCard({ p }: { p: LocalPlaylist }) {
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }}>
      <Link to={`/playlist/${encodeURIComponent(p.id)}`} className={`block ${cardCls}`}>
        <PlaylistCover tracks={p.tracks} className="rounded-lg" />
        <p className="mt-3 truncate text-sm font-semibold">{p.name}</p>
        <p className="mt-0.5 truncate text-xs text-dim">Playlist · {p.tracks.length} tracks</p>
      </Link>
    </motion.div>
  )
}

export function ArtistCard({ u }: { u: User }) {
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }}>
      <Link to={`/artist/${encodeURIComponent(u.id)}`} className={`block ${cardCls}`}>
        <ArtworkImg
          art={u.profile_picture}
          alt={u.name}
          className="aspect-square w-full rounded-full"
          iconSize={28}
        />
        <p className="mt-3 flex items-center gap-1 truncate text-sm font-semibold">
          <span className="truncate">{u.name}</span>
          {u.is_verified && <BadgeCheck size={14} className="shrink-0 text-dim" />}
        </p>
        <p className="mt-0.5 truncate text-xs text-dim">Artist · {fmtCount(u.follower_count)} followers</p>
      </Link>
    </motion.div>
  )
}
