import { motion } from "motion/react"
import { BadgeCheck, ChevronLeft, ChevronRight, Disc3, Download, Heart, Link2, ListEnd, ListMusic, ListPlus, Play, Radio, Share2, User as UserIcon } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "react-router-dom"
import type { Playlist, Track, User } from "../api/types"
import { hasArtistPage } from "../api/types"
import { apiClient } from "../api/audius"
import { prefetchStream, yt } from "../api/youtube"
import { notify, usePlayer } from "../store/player"
import { useDownloads } from "../store/downloads"
import { exportPlaylistToFile, useLibrary } from "../store/library"
import { t, useT } from "../i18n"
import type { LocalPlaylist } from "../store/library"
import { fmtCount } from "../utils/format"
import { ArtworkImg } from "./ArtworkImg"
import { Equalizer } from "./Equalizer"

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const tt = useT()
  const rowRef = useRef<HTMLDivElement>(null)
  // scroll edge state drives arrow visibility - no point offering a right
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
        {/* pt-1 keeps the card hover-lift (y:-4) from clipping - overflow-x
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
            aria-label={tt("card.scrollLeft")}
            className="absolute left-1 top-[40%] z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-panel/95 text-ink opacity-0 shadow-xl shadow-black/60 ring-1 ring-line backdrop-blur transition hover:scale-110 hover:bg-cardhover focus-visible:opacity-100 group-hover/sec:opacity-100"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        {!edges.end && (
          <button
            onClick={() => scrollBy(1)}
            aria-label={tt("card.scrollRight")}
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
  const tt = useT()
  return (
    <motion.button
      onClick={onClick}
      aria-label={tt("card.play")}
      initial={false}
      whileTap={{ scale: 0.96 }}
      className="absolute bottom-3 right-3 z-10 grid size-11 translate-y-2 place-items-center rounded-full bg-white text-black opacity-0 shadow-xl shadow-black/40 transition-[transform,opacity,box-shadow] duration-200 hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100"
    >
      {playing ? <Equalizer playing className="h-3.5" /> : <Play size={18} className="ml-0.5 fill-current" />}
    </motion.button>
  )
}

const cardCls =
  "group relative w-44 shrink-0 rounded-[20px] bg-card p-3 transition-colors duration-200 hover:bg-cardhover"

// ---- right-click menus on cards -----------------------------------------
// Track rows have the full ⋯ menu; cards get the same core actions on
// right-click. Portaled to document.body - the Section scrollports clip
// (overflow-x) anything mounted inside the card.
interface CardMenuAction {
  label: string
  icon?: ReactNode
  onClick: () => void
}

function useCardMenu() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const open = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
  }
  return { pos, open, close: () => setPos(null) }
}

function CardMenu({ pos, actions, onClose }: { pos: { x: number; y: number }; actions: CardMenuAction[]; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("blur", onClose)
    window.addEventListener("resize", onClose)
    window.addEventListener("scroll", onClose, true) // capture - the row scrolls, not window
    window.addEventListener("contextmenu", onClose)
    window.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("blur", onClose)
      window.removeEventListener("resize", onClose)
      window.removeEventListener("scroll", onClose, true)
      window.removeEventListener("contextmenu", onClose)
      window.removeEventListener("keydown", key)
    }
  }, [onClose])
  // flip upward when the menu would clip below the viewport
  const flip = pos.y > window.innerHeight - (actions.length * 41 + 16)
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[90]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        role="menu"
        style={{
          left: Math.min(pos.x, window.innerWidth - 220),
          ...(flip ? { bottom: window.innerHeight - pos.y } : { top: pos.y }),
        }}
        className="fixed z-[100] w-52 overflow-hidden rounded-xl border border-line bg-cardhover py-1 shadow-2xl shadow-black/50"
      >
        {actions.map((a, i) => (
          <button
            key={i}
            role="menuitem"
            onClick={() => {
              onClose()
              a.onClick()
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-white/10"
          >
            {a.icon}
            <span className="flex-1 truncate">{a.label}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}

const copyText = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => notify(t("table.linkCopied")),
    () => {},
  )

// resolve a card's playlist into tracks for Play - same id-prefix routing
// as the playlist page
async function playlistTracks(p: Playlist): Promise<Track[]> {
  try {
    if (p.id.startsWith("ytalb-")) return (await yt.album(p.id.slice(6)))?.tracks ?? []
    if (p.id.startsWith("ytpl-")) return (await yt.playlist(p.id.slice(5)))?.tracks ?? []
    return await apiClient.playlistTracks(p.id)
  } catch {
    return []
  }
}

function playlistLink(p: Playlist): string | undefined {
  if (p.permalink) return p.permalink
  if (p.id.startsWith("ytpl-")) return `https://music.youtube.com/playlist?list=${p.id.slice(5).replace(/^VL/, "")}`
  if (p.id.startsWith("ytalb-")) return `https://music.youtube.com/browse/${p.id.slice(6)}`
  return undefined
}

function artistLink(u: User): string | undefined {
  if (u.permalink) return u.permalink
  const ch = u.streamId ?? (u.id.startsWith("yt-") ? u.id.slice(3) : "")
  return ch ? `https://music.youtube.com/channel/${ch}` : undefined
}

export function TrackCard({ t, context }: { t: Track; context?: Track[] }) {
  const tt = useT()
  const navigate = useNavigate()
  const playTrack = usePlayer((s) => s.playTrack)
  const playContext = usePlayer((s) => s.playContext)
  const toggle = usePlayer((s) => s.toggle)
  const playNextUp = usePlayer((s) => s.playNextUp)
  const enqueue = usePlayer((s) => s.enqueue)
  const isCurrent = usePlayer((s) => s.current?.id === t.id)
  // combined selector: non-current cards always yield `false`, so a global
  // play/pause only re-renders the ONE card whose icon actually changes
  const isCurPlaying = usePlayer((s) => s.current?.id === t.id && s.isPlaying)
  const liked = useLibrary((s) => Boolean(s.liked[t.id]))
  const toggleLike = useLibrary((s) => s.toggleLike)
  const dlState = useDownloads((s) =>
    s.items[t.id] ? "done" : s.progress[t.id] !== undefined ? "busy" : "none",
  )
  const dlPct = useDownloads((s) => s.progress[t.id] ?? 0)
  const dlStart = useDownloads((s) => s.start)
  const dlRemove = useDownloads((s) => s.remove)
  const canDl = Boolean(window.freebify?.dl)
  const menu = useCardMenu()
  // clicking the card of the track that's already loaded toggles it -
  // replaying from 0 on a pause-click feels broken
  const play = () => (isCurrent ? toggle() : playTrack(t, context))
  const link = t.permalink ?? (t.streamId ? `https://music.youtube.com/watch?v=${t.streamId}` : undefined)

  const actions: CardMenuAction[] = [
    { label: tt("card.play"), icon: <Play size={15} />, onClick: play },
    { label: tt("table.playNext"), icon: <ListEnd size={15} />, onClick: () => playNextUp(t) },
    { label: tt("table.addQueue"), icon: <ListPlus size={15} />, onClick: () => enqueue(t) },
    ...(t.source === "yt" && t.streamId
      ? [
          {
            label: tt("table.startRadio"),
            icon: <Radio size={15} />,
            onClick: () =>
              void yt.upNext(t.streamId!).then((tracks) => {
                if (tracks.length) playContext(tracks, 0)
                else notify(tt("table.radioFail"))
              }),
          },
        ]
      : []),
    ...(hasArtistPage(t.user)
      ? [
          {
            label: tt("table.goArtist"),
            icon: <UserIcon size={15} />,
            onClick: () =>
              navigate(`/artist/${encodeURIComponent(t.user.id)}?n=${encodeURIComponent(t.user.name)}`),
          },
        ]
      : []),
    ...(t.album?.id
      ? [
          {
            label: tt("table.goAlbum"),
            icon: <Disc3 size={15} />,
            onClick: () =>
              navigate(
                t.album!.id.startsWith("ytalb-")
                  ? `/playlist/${encodeURIComponent(t.album!.id)}`
                  : `/playlist/ytalb-${encodeURIComponent(t.album!.id)}`,
              ),
          },
        ]
      : []),
    {
      label: liked ? tt("table.unlike") : tt("table.like"),
      icon: <Heart size={15} className={liked ? "fill-current" : ""} />,
      onClick: () => toggleLike(t),
    },
    ...(canDl
      ? [
          {
            label:
              dlState === "done"
                ? tt("table.removeDownload")
                : dlState === "busy"
                  ? tt("table.downloading", { pct: dlPct })
                  : tt("table.download"),
            icon: dlState === "done" ? <BadgeCheck size={15} /> : <Download size={15} />,
            onClick: () => {
              if (dlState === "done") void dlRemove(t.id)
              else if (dlState === "none") void dlStart(t)
            },
          },
        ]
      : []),
    ...(link
      ? [{ label: tt("table.copyLink"), icon: <Link2 size={15} />, onClick: () => void copyText(link) }]
      : []),
  ]

  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 400, damping: 26 }}
      className={cardCls}
      onContextMenu={menu.open}
    >
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
      {menu.pos && <CardMenu pos={menu.pos} actions={actions} onClose={menu.close} />}
    </motion.div>
  )
}

// Editorial playlist covers come with the YouTube Music logo baked into
// the artwork - ugly and generic. Instead, lazily fetch the first 4 track
// artworks and compose a Spotify-style 2×2 collage (only when the card
// scrolls into view - a full row of getPlaylist calls would be wasteful).
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
            // a dead thumb inside the collage shows a broken-image tile -
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
  // ytpl covers carry a baked-in YouTube Music logo - never render them:
  // a shimmer while the collage loads, a neutral icon tile if it fails.
  // Albums (ytalb-) and Audius covers are real artwork - fine to fall back.
  if (!p.id.startsWith("ytpl-")) {
    return (
      <div ref={ref}>
        <ArtworkImg art={p.artwork} alt={alt} className="aspect-square w-full rounded-lg" />
      </div>
    )
  }
  if (arts === null) {
    return <div ref={ref} className="aspect-square w-full animate-pulse rounded-lg bg-hover" />
  }
  return (
    <div ref={ref} className="grid aspect-square w-full place-items-center rounded-lg bg-hover">
      <ListMusic size={30} className="text-faint" />
    </div>
  )
}

export function PlaylistCard({ p }: { p: Playlist }) {
  const tt = useT()
  const navigate = useNavigate()
  const playContext = usePlayer((s) => s.playContext)
  const menu = useCardMenu()
  // yt editorial playlists carry NO artwork - the collage fetches track
  // thumbs for them. Items that already ship a real cover (album rows,
  // new releases, Audius) go straight to ArtworkImg: no extra browse call.
  const isYt = (p.id.startsWith("ytpl-") || p.id.startsWith("ytalb-")) && !p.artwork?.["480x480"]
  const link = playlistLink(p)
  const open = () => navigate(`/playlist/${encodeURIComponent(p.id)}`)
  const actions: CardMenuAction[] = [
    { label: tt("card.open"), icon: <ListMusic size={15} />, onClick: open },
    {
      label: tt("card.play"),
      icon: <Play size={15} />,
      onClick: () =>
        void playlistTracks(p).then((tracks) => {
          if (tracks.length) playContext(tracks, 0)
          else notify(t("import.notFound"))
        }),
    },
    ...(link
      ? [{ label: tt("table.copyLink"), icon: <Link2 size={15} />, onClick: () => void copyText(link) }]
      : []),
  ]
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }} onContextMenu={menu.open}>
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
          {p.is_album ? tt("card.album") : tt("card.playlist")} · {p.total_play_count ? tt("card.plays", { n: fmtCount(p.total_play_count) }) : p.user.name}
        </p>
      </Link>
      {menu.pos && <CardMenu pos={menu.pos} actions={actions} onClose={menu.close} />}
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
  const tt = useT()
  const navigate = useNavigate()
  const playContext = usePlayer((s) => s.playContext)
  const menu = useCardMenu()
  const open = () => navigate(`/playlist/${encodeURIComponent(p.id)}`)
  const actions: CardMenuAction[] = [
    { label: tt("card.open"), icon: <ListMusic size={15} />, onClick: open },
    {
      label: tt("card.play"),
      icon: <Play size={15} />,
      onClick: () => p.tracks.length && playContext(p.tracks, 0),
    },
    {
      label: tt("playlist.export"),
      icon: <Share2 size={15} />,
      onClick: () =>
        void exportPlaylistToFile(p).then((ok) => {
          if (ok) notify(t("playlist.exported"))
        }),
    },
  ]
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }} onContextMenu={menu.open}>
      <Link to={`/playlist/${encodeURIComponent(p.id)}`} className={`block ${cardCls}`}>
        <PlaylistCover tracks={p.tracks} className="rounded-lg" />
        <p className="mt-3 truncate text-sm font-semibold">{p.name}</p>
        <p className="mt-0.5 truncate text-xs text-dim">{tt("card.playlist")} · {tt("card.tracks", { n: p.tracks.length })}</p>
      </Link>
      {menu.pos && <CardMenu pos={menu.pos} actions={actions} onClose={menu.close} />}
    </motion.div>
  )
}

export function ArtistCard({ u }: { u: User }) {
  const tt = useT()
  const navigate = useNavigate()
  const menu = useCardMenu()
  const open = () => navigate(`/artist/${encodeURIComponent(u.id)}?n=${encodeURIComponent(u.name)}`)
  const link = artistLink(u)
  const actions: CardMenuAction[] = [
    { label: tt("card.open"), icon: <UserIcon size={15} />, onClick: open },
    ...(link
      ? [{ label: tt("table.copyLink"), icon: <Link2 size={15} />, onClick: () => void copyText(link) }]
      : []),
  ]
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 400, damping: 26 }} onContextMenu={menu.open}>
      <Link to={`/artist/${encodeURIComponent(u.id)}?n=${encodeURIComponent(u.name)}`} className={`block ${cardCls}`}>
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
        <p className="mt-0.5 truncate text-xs text-dim">{tt("card.artist")} · {tt("card.followers", { n: fmtCount(u.follower_count) })}</p>
      </Link>
      {menu.pos && <CardMenu pos={menu.pos} actions={actions} onClose={menu.close} />}
    </motion.div>
  )
}
