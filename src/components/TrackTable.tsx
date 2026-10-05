import { Check, ChevronLeft, Disc3, Download, Heart, Link2, ListEnd, ListMusic, ListPlus, MoreHorizontal, Play, Radio, Trash2, User as UserIcon } from "lucide-react"
import { motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import type { Track } from "../api/types"
import { isLongForm, isNonOriginal } from "../api/audius"
import { prefetchStream, yt } from "../api/youtube"
import { useLibrary } from "../store/library"
import { useDownloads } from "../store/downloads"
import { notify, usePlayer } from "../store/player"
import { fmtCount, fmtDuration } from "../utils/format"
import { ArtworkImg } from "./ArtworkImg"
import { Equalizer } from "./Equalizer"

interface TrackTableProps {
  tracks: Track[]
  // optional wider context — e.g. Search renders two tables of slices but
  // wants either row's play click to queue the FULL result set
  context?: Track[]
  showHeader?: boolean
  showPlays?: boolean
  numbered?: boolean
  numberOffset?: number
  onRemove?: (t: Track) => void
  removeLabel?: string
}

// rows are a fixed h-14 — windowing is just index math on the page
// scroller (#main-scroll). Only worth it on long lists: short tables keep
// the plain path untouched.
const ROW_H = 56
const VIRTUAL_MIN = 80
const OVERSCAN = 8

function useWindowed(total: number, enabled: boolean) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: Math.min(total, 24) })

  useEffect(() => {
    if (!enabled) return
    const scroller = document.getElementById("main-scroll")
    const wrap = wrapRef.current
    if (!scroller || !wrap) return
    let raf = 0
    const measure = () => {
      raf = 0
      const sRect = scroller.getBoundingClientRect()
      // distance from the scroll content's top to the first row — measured
      // fresh each tick: header art/images above the table can finish
      // loading late and shift everything down
      const top = wrap.getBoundingClientRect().top - sRect.top + scroller.scrollTop
      const start = Math.min(total, Math.max(0, Math.floor((scroller.scrollTop - top) / ROW_H) - OVERSCAN))
      const end = Math.min(
        total,
        Math.max(start, Math.ceil((scroller.scrollTop + sRect.height - top) / ROW_H) + OVERSCAN),
      )
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [enabled, total])

  return enabled ? { wrapRef, ...range } : { wrapRef, start: 0, end: total }
}

export function TrackTable({ tracks, context, showHeader = true, showPlays: wantPlays = true, numbered = true, numberOffset = 0, onRemove, removeLabel }: TrackTableProps) {
  const playContext = usePlayer((s) => s.playContext)
  // auto-hide the Plays column when NO row carries a count — a column of
  // "—" is worse than none (yt playlists lack view data; Audius has it)
  const showPlays = wantPlays && tracks.some((t) => (t.play_count ?? 0) > 0)
  // keyed by row instance ("id-index"), not just id — a list can legitimately
  // contain the same track twice and both menus would open at once
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const navigate = useNavigate()

  // seeing a list is the strongest "about to play" signal — warm the top
  // rows through the low-priority lane so most clicks resolve from cache.
  // keyed on a stable id-signature: sliced props change identity every
  // render and would refire the whole warm set per keystroke
  const warmKey = tracks
    .slice(0, 8)
    .map((t) => t.streamId ?? t.id)
    .join(",")
  useEffect(() => {
    // top-3 only — 8 rows at once spawns an yt-dlp prefetch storm on every
    // page mount; the rest warm on hover instead
    tracks.slice(0, 3).forEach(prefetchStream)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmKey])

  // an open row menu dies on scroll/resize/Escape — otherwise it rides
  // along off-screen, or the invisible backdrop swallows the next click
  const menuAlive = menuFor !== null && tracks.some((t, i) => `${t.id}-${i}` === menuFor)
  useEffect(() => {
    if (!menuAlive) {
      if (menuFor !== null) setMenuFor(null)
      return
    }
    const close = () => setMenuFor(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    document.getElementById("main-scroll")?.addEventListener("scroll", close, { passive: true })
    window.addEventListener("resize", close)
    window.addEventListener("keydown", onKey)
    return () => {
      document.getElementById("main-scroll")?.removeEventListener("scroll", close)
      window.removeEventListener("resize", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [menuAlive, menuFor])

  // window long lists — a 500-row playlist used to mount 500 rows' worth
  // of motion.div/ArtworkImg/menu state; now only the visible slice exists
  const virtual = tracks.length > VIRTUAL_MIN
  const { wrapRef, start, end } = useWindowed(tracks.length, virtual)

  // the lg grid has an optional Plays column — without it the actions cell
  // lands in the 5rem slot and overflows
  const lgCols = showPlays
    ? "lg:grid-cols-[1.75rem_minmax(0,1.4fr)_minmax(0,1fr)_5rem_6rem]"
    : "lg:grid-cols-[1.75rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem]"

  return (
    <div className="relative">
      {showHeader && (
        <div className={`grid h-9 grid-cols-[1.75rem_minmax(0,1fr)_6rem] items-center gap-x-4 border-b border-line px-3 text-[11px] font-medium uppercase tracking-widest text-faint ${lgCols}`}>
          <span>#</span>
          <span>Title</span>
          <span className="hidden lg:block">Artist</span>
          {showPlays && <span className="hidden text-right lg:block">Plays</span>}
          <span className="text-right">Time</span>
        </div>
      )}
      <div className="mt-1 flex flex-col" ref={wrapRef}>
        {virtual && start > 0 && <div aria-hidden style={{ height: start * ROW_H }} />}
        {(virtual ? tracks.slice(start, end) : tracks).map((t, k) => {
          const i = virtual ? start + k : k
          const rowKey = `${t.id}-${i}`
          return (
            <Row
              // index key: identity-keyed rows remount (and replay their
              // entrance animation) for every row below a removal. The
              // rowKey prop still pins the menu to the right row.
              key={i}
              rowKey={rowKey}
              track={t}
              index={i}
              numbered={numbered}
              numberOffset={numberOffset}
              showPlays={showPlays}
              lgCols={lgCols}
              menuOpen={menuFor === rowKey}
              onMenu={() => setMenuFor(menuFor === rowKey ? null : rowKey)}
              closeMenu={() => setMenuFor((m) => (m === rowKey ? null : m))}
              onPlay={() => playContext(context ?? tracks, i)}
              goArtist={() => navigate(`/artist/${encodeURIComponent(t.user.id)}?n=${encodeURIComponent(t.user.name)}`)}
              onRemove={onRemove}
              removeLabel={removeLabel}
            />
          )
        })}
        {virtual && end < tracks.length && (
          <div aria-hidden style={{ height: (tracks.length - end) * ROW_H }} />
        )}
        {tracks.length === 0 && (
          <p className="px-3 py-10 text-center text-sm text-dim">Nothing here yet.</p>
        )}
      </div>
      {/* outside-click catcher — sits above rows (z-20) but below the
          TopBar/PlayerBar (z-30/40) so navigation still works. Only render
          while the owning row still exists — a list mutation that removed
          it would leave a click-eating ghost backdrop */}
      {menuAlive && (
        <div
          className="fixed inset-0 z-20 cursor-default"
          onClick={() => setMenuFor(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuFor(null)
          }}
        />
      )}
    </div>
  )
}

interface RowProps {
  rowKey: string
  track: Track
  index: number
  numbered: boolean
  numberOffset: number
  showPlays: boolean
  lgCols: string
  menuOpen: boolean
  onMenu: () => void
  closeMenu: () => void
  onPlay: () => void
  goArtist: () => void
  onRemove?: (t: Track) => void
  removeLabel?: string
}

function Row({ track: t, index, numbered, numberOffset, showPlays, lgCols, menuOpen, onMenu, closeMenu, onPlay, goArtist, onRemove, removeLabel }: RowProps) {
  const isCurrent = usePlayer((s) => s.current?.id === t.id)
  // combined selector — plain s.isPlaying would re-render every row in the
  // table on each pause/play; this only flips for the current row
  const playingHere = usePlayer((s) => s.current?.id === t.id && s.isPlaying)
  const liked = useLibrary((s) => Boolean(s.liked[t.id]))
  const toggleLike = useLibrary((s) => s.toggleLike)
  const removeFromPlaylist = useLibrary((s) => s.removeFromPlaylist)
  const enqueue = usePlayer((s) => s.enqueue)
  const playNextUp = usePlayer((s) => s.playNextUp)
  const playContext = usePlayer((s) => s.playContext)
  const playlists = useLibrary((s) => s.playlists)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const [copied, setCopied] = useState(false)
  // download state — primitive selector so progress ticks only re-render
  // the one row that's actually downloading
  const dlState = useDownloads((s) =>
    s.items[t.id] ? "done" : s.progress[t.id] !== undefined ? "busy" : "none",
  )
  const dlPct = useDownloads((s) => s.progress[t.id] ?? 0)
  const dlStart = useDownloads((s) => s.start)
  const dlRemove = useDownloads((s) => s.remove)
  const canDl = Boolean(window.freebify?.dl)
  // menus near the viewport bottom flip upward instead of clipping
  const [flipUp, setFlipUp] = useState(false)
  const [flyOpen, setFlyOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  // hover prefetch needs a dwell — brushing across rows would otherwise
  // spawn an yt-dlp process per row touched
  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (warmTimer.current) clearTimeout(warmTimer.current) }, [])

  // the scrollport bottom is ~88px above the window edge (PlayerBar) —
  // measuring against innerHeight lets menus clip under it
  const menuWouldClip = (y: number) => {
    const bottom =
      document.getElementById("main-scroll")?.getBoundingClientRect().bottom ?? window.innerHeight
    return y + 300 > bottom
  }

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    // ~300px of menu + flyout — flip up if it would clip the scrollport
    setFlipUp(menuWouldClip(r.bottom))
    setFlyOpen(false)
    onMenu()
  }

  const artistPath = `/artist/${encodeURIComponent(t.user.id)}?n=${encodeURIComponent(t.user.name)}`
  // yt-va / yt- / empty ids are fake owner ids (playlist "Various Artists",
  // missing channel) — navigating there lands on a broken artist page
  const artistOk = Boolean(t.user.id) && t.user.id !== "yt-va" && t.user.id !== "yt-"

  return (
    <motion.div
      ref={rowRef}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.018, 0.25), ease: "easeOut" }}
      // the entrance transform creates a stacking context that traps the
      // menu below the z-20 backdrop — strip it once motion is done
      onAnimationComplete={() => {
        if (rowRef.current) rowRef.current.style.transform = "none"
      }}
      role="button"
      tabIndex={0}
      aria-label={`Play ${t.title}`}
      onKeyDown={(e) => {
        if (e.key === "Enter") onPlay()
      }}
      onClick={onPlay}
      onMouseEnter={() => {
        if (warmTimer.current) clearTimeout(warmTimer.current)
        warmTimer.current = setTimeout(() => prefetchStream(t), 450)
      }}
      onMouseLeave={() => {
        if (warmTimer.current) clearTimeout(warmTimer.current)
      }}
      onPointerDown={() => prefetchStream(t)}
      onContextMenu={(e) => {
        e.preventDefault()
        setFlipUp(menuWouldClip(e.clientY))
        setFlyOpen(false)
        if (!menuOpen) onMenu()
      }}
      className={`group relative grid h-14 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)_6rem] items-center gap-x-4 rounded-lg px-3 transition-colors hover:bg-hover focus-visible:bg-hover ${
        menuOpen ? "bg-hover" : ""
      } ${lgCols}`}
    >
      <span className="flex items-center justify-center text-sm text-dim">
        {isCurrent ? (
          <Equalizer playing={playingHere} className="text-ink" />
        ) : (
          <>
            {numbered && <span className="group-hover:hidden">{numberOffset + index + 1}</span>}
            <Play size={14} className="hidden fill-current text-ink group-hover:block" />
          </>
        )}
      </span>

      <span className="flex min-w-0 items-center gap-3">
        <ArtworkImg art={t.artwork} size="150x150" alt="" className="size-10 shrink-0 rounded-md" iconSize={16} />
        <span className="min-w-0">
          <span title={t.title} className={`block truncate text-sm font-medium ${isCurrent ? "text-white underline decoration-white/30 underline-offset-4" : "text-ink"}`}>
            {t.title}
            {(isNonOriginal(t) || isLongForm(t)) && (
              <span className="ml-1.5 rounded border border-line px-1 align-middle text-[9px] font-semibold uppercase tracking-wide text-faint">
                {isLongForm(t) ? "Set" : "Edit"}
              </span>
            )}
          </span>
          {artistOk ? (
            <Link
              to={artistPath}
              onClick={(e) => e.stopPropagation()}
              className="block truncate text-xs text-dim hover:text-ink hover:underline lg:hidden"
            >
              {t.user.name}
            </Link>
          ) : (
            <span className="block truncate text-xs text-dim lg:hidden">{t.user.name}</span>
          )}
        </span>
      </span>

      {artistOk ? (
        <Link
          to={artistPath}
          onClick={(e) => e.stopPropagation()}
          className="hidden truncate text-sm text-dim hover:text-ink hover:underline lg:block"
        >
          {t.user.name}
        </Link>
      ) : (
        <span className="hidden truncate text-sm text-dim lg:block">{t.user.name}</span>
      )}

      {showPlays && (
        <span className="hidden text-right text-sm tabular-nums text-dim lg:block">{t.play_count > 0 ? fmtCount(t.play_count) : "—"}</span>
      )}

      <span className="flex items-center justify-end gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            toggleLike(t)
          }}
          aria-label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
          aria-pressed={liked}
          className={`transition ${liked ? "text-ink" : "text-dim opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"}`}
        >
          <Heart size={15} className={liked ? "fill-current" : ""} />
        </button>
        <span className="w-9 text-right text-sm tabular-nums text-dim">{fmtDuration(t.duration)}</span>
        <button
          onClick={openMenu}
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={`text-dim transition hover:text-ink focus-visible:opacity-100 ${menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
        >
          <MoreHorizontal size={16} />
        </button>
      </span>

      {menuOpen && (
        // the container swallows clicks — hitting menu padding must not
        // bubble into the row and start playback
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className={`absolute right-8 z-30 w-52 overflow-visible rounded-xl border border-line bg-cardhover py-1 shadow-2xl ${
            flipUp ? "bottom-10" : "top-10"
          }`}
        >
          <MenuItem
            label="Play next"
            icon={<ListEnd size={15} />}
            onClick={(e) => {
              e.stopPropagation()
              playNextUp(t)
              closeMenu()
            }}
          />
          <MenuItem
            label="Add to queue"
            icon={<ListPlus size={15} />}
            onClick={(e) => {
              e.stopPropagation()
              enqueue(t)
              closeMenu()
            }}
          />
          {/* add-to-playlist flyout — opens on hover AND click (touch /
              keyboard can't hover); the wrapper's pr-2 is the hover bridge
              so the gap between item and panel never collapses */}
          <div className="group/sub relative">
            <button
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setFlyOpen((v) => !v)
              }}
              aria-haspopup="menu"
              aria-expanded={flyOpen}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-white/10"
            >
              <ListMusic size={15} />
              <span className="flex-1">Add to playlist</span>
              <ChevronLeft size={14} className="text-faint" />
            </button>
            <div
              role="menu"
              className={`absolute right-full top-0 z-40 w-52 pr-2 ${
                flyOpen ? "" : "invisible opacity-0 group-hover/sub:visible group-hover/sub:opacity-100"
              } transition-opacity`}
            >
              <div className="rounded-xl border border-line bg-cardhover py-1 shadow-2xl">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    const pid = createPlaylist()
                    addToPlaylist(pid, t)
                    notify("Added to new playlist")
                    closeMenu()
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-semibold text-ink transition hover:bg-white/10"
                >
                  <ListPlus size={15} /> New playlist
                </button>
                {playlists.length > 0 && <div className="mx-3 my-1 border-t border-line" />}
                <div className="scroller max-h-44 overflow-y-auto">
                  {playlists.map((p) => {
                    const has = p.tracks.some((x) => x.id === t.id)
                    return (
                      <button
                        key={p.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          // the check mark reads as toggleable — make it true
                          if (has) {
                            removeFromPlaylist(p.id, t.id)
                            notify(`Removed from "${p.name}"`)
                          } else {
                            addToPlaylist(p.id, t)
                            notify(`Added to "${p.name}"`)
                          }
                          closeMenu()
                        }}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-ink transition hover:bg-white/10"
                      >
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {has && <Check size={14} className="shrink-0 text-dim" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
          {canDl && (
            <MenuItem
              label={
                dlState === "done"
                  ? "Remove download"
                  : dlState === "busy"
                    ? `Downloading… ${dlPct}%`
                    : "Download"
              }
              icon={dlState === "done" ? <Check size={15} /> : <Download size={15} />}
              onClick={(e) => {
                e.stopPropagation()
                closeMenu()
                if (dlState === "done") void dlRemove(t.id)
                else if (dlState === "none") void dlStart(t)
              }}
            />
          )}
          {t.source === "yt" && t.streamId && (
            <MenuItem
              label="Start radio"
              icon={<Radio size={15} />}
              onClick={(e) => {
                e.stopPropagation()
                closeMenu()
                void yt.upNext(t.streamId!).then((tracks) => {
                  if (tracks.length) playContext(tracks, 0)
                  else notify("Couldn't start a radio for this track")
                })
              }}
            />
          )}
          {artistOk && (
            <MenuItem
              label="Go to artist"
              icon={<UserIcon size={15} />}
              onClick={(e) => {
                e.stopPropagation()
                goArtist()
                closeMenu()
              }}
            />
          )}
          {t.album?.id && (
            <MenuItem
              label="Go to album"
              icon={<Disc3 size={15} />}
              onClick={(e) => {
                e.stopPropagation()
                closeMenu()
                // yt album browseIds route through the playlist page's
                // ytalb- branch — navigate() so this works under both
                // HashRouter (prod) and BrowserRouter (dev)
                navigate(
                  t.album!.id.startsWith("ytalb-")
                    ? `/playlist/${encodeURIComponent(t.album!.id)}`
                    : `/playlist/ytalb-${encodeURIComponent(t.album!.id)}`,
                )
              }}
            />
          )}
          {t.permalink && (
            <MenuItem
              label={copied ? "Copied" : "Copy link"}
              icon={copied ? <Check size={15} /> : <Link2 size={15} />}
              onClick={(e) => {
                e.stopPropagation()
                // only claim success on a real write — and close NOW: a
                // delayed close would kill a menu another row opened since
                void navigator.clipboard
                  ?.writeText(t.permalink!)
                  .then(() => {
                    setCopied(true)
                    notify("Link copied")
                  })
                  .catch(() => {})
                closeMenu()
              }}
            />
          )}
          {onRemove && (
            <MenuItem
              label={removeLabel ?? "Remove from playlist"}
              icon={<Trash2 size={15} />}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(t)
                closeMenu()
              }}
            />
          )}
        </div>
      )}
    </motion.div>
  )
}

function MenuItem({
  label,
  icon,
  onClick,
}: {
  label: string
  icon?: React.ReactNode
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-white/10"
    >
      {icon}
      {label}
    </button>
  )
}
