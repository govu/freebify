import { motion } from "motion/react"
import { Check, Download, Link2, ListMusic, Pencil, Play, Plus, Search, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { apiClient } from "../api/audius"
import { prefetchStream, yt } from "../api/youtube"
import type { Playlist, Track } from "../api/types"
import { hasArtistPage } from "../api/types"
import { ArtworkImg } from "../components/ArtworkImg"
import { PlaylistCover } from "../components/Cards"
import { HeroSkeleton, RowsSkeleton } from "../components/Skeletons"
import { TrackTable } from "../components/TrackTable"
import { t, useT } from "../i18n"
import { useLibrary } from "../store/library"
import { useDownloads } from "../store/downloads"
import { notify, usePlayer } from "../store/player"
import { fmtCount, fmtDuration } from "../utils/format"

export function PlaylistPage() {
  const { id } = useParams<{ id: string }>()
  if (id?.startsWith("local-")) return <LocalPlaylistView id={id} />
  return <RemotePlaylistView id={id!} />
}

function RemotePlaylistView({ id }: { id: string }) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // tracks fetch can fail independently of the playlist shell — "empty"
  // would then be a lie (it isn't empty, it didn't load)
  const [tracksError, setTracksError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [filter, setFilter] = useState("")
  const [copied, setCopied] = useState(false)
  const playContext = usePlayer((s) => s.playContext)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addTracksToPlaylist = useLibrary((s) => s.addTracksToPlaylist)
  const startAll = useDownloads((s) => s.startAll)
  const navigate = useNavigate()
  const tt = useT()

  useEffect(() => {
    if (!id) {
      setLoading(false)
      setError(true)
      return
    }
    let live = true
    setLoading(true)
    setError(false)
    setTracksError(false) // a retry must actually be able to recover
    void (async () => {
      if (id.startsWith("ytalb-") || id.startsWith("ytpl-")) {
        // an IPC rejection (reload mid-call, missing handler) would leave
        // the page on skeletons forever — catch like the Artist page does
        try {
          const res = id.startsWith("ytalb-")
            ? await yt.album(id.slice(6))
            : await yt.playlist(id.slice(5))
          if (!live) return
          if (res) {
            setPlaylist(res.playlist)
            setTracks(res.tracks)
            res.tracks.slice(0, 6).forEach((t) => prefetchStream(t))
          } else setError(true)
        } catch {
          if (live) setError(true)
        }
        if (live) setLoading(false)
        return
      }
      const [p, t] = await Promise.allSettled([apiClient.playlist(id), apiClient.playlistTracks(id)])
      if (!live) return
      if (p.status === "fulfilled") setPlaylist(p.value)
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
        <HeroSkeleton />
        <div className="px-6">
          <RowsSkeleton />
        </div>
      </div>
    )
  }

  if (error || !playlist) {
    return (
      <div className="grid place-items-center py-32 text-center">
        <div>
          <p className="text-lg font-semibold">{tt("playlist.notFound")}</p>
          <p className="mt-1 text-sm text-dim">{tt("playlist.notFound.sub")}</p>
          <button
            onClick={() => setRetry((r) => r + 1)}
            className="mt-5 rounded-full border border-line px-6 py-2 text-sm font-semibold transition hover:scale-[1.03] hover:border-white/30"
          >
            {tt("playlist.retry")}
          </button>
        </div>
      </div>
    )
  }

  const totalSec = tracks.reduce((a, t) => a + (t.duration ?? 0), 0)
  const q = filter.trim().toLowerCase()
  const shown = q
    ? tracks.filter(
        (t) => t.title.toLowerCase().includes(q) || t.user.name.toLowerCase().includes(q)
      )
    : tracks
  // editorial playlists credit "YouTube Music" — yt-va/yt-/null owners are
  // fake ids that would route to a random artist search result
  const ownerLinkable = hasArtistPage(playlist.user)

  return (
    <div className="-mt-12 pb-10">
      <div
        className="flex flex-col items-start gap-6 px-6 pb-8 pt-20 sm:flex-row sm:items-end"
        style={{
          background:
            "linear-gradient(180deg, rgb(255 255 255 / 0.08), transparent), radial-gradient(60% 100% at 90% 0%, rgb(255 255 255 / 0.04), transparent)",
        }}
      >
        <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
          {playlist.id.startsWith("ytpl-") ? (
            // editorial playlist covers ship with the YouTube Music logo
            // baked into the artwork — collage the loaded tracks instead
            // (the same treatment the cards get); albums keep real art
            <PlaylistCover
              tracks={tracks}
              className="size-44 rounded-xl shadow-2xl shadow-black/50 sm:size-52"
              iconSize={48}
            />
          ) : (
            <ArtworkImg
              art={playlist.artwork}
              size="1000x1000"
              alt={playlist.playlist_name}
              className="size-44 rounded-xl shadow-2xl shadow-black/50 sm:size-52"
              iconSize={48}
            />
          )}
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.08 }}
          // min-w-0 + break: a 60-char editorial title used to push the
          // hero wider than the viewport instead of wrapping
          className="min-w-0 sm:flex-1"
        >
          <p className="text-xs font-semibold text-ink/70">
            {playlist.is_album ? tt("playlist.album") : tt("playlist.playlist")}
          </p>
          <h1 title={playlist.playlist_name} className="mt-2 line-clamp-3 break-words text-3xl font-black tracking-tight sm:text-5xl">{playlist.playlist_name}</h1>
          {playlist.description && (
            <p className="mt-3 line-clamp-2 max-w-xl text-sm text-dim">{playlist.description}</p>
          )}
          <p className="mt-3 text-sm text-dim">
            {ownerLinkable ? (
              <Link
                to={`/artist/${encodeURIComponent(playlist.user.id)}?n=${encodeURIComponent(playlist.user.name)}`}
                className="font-semibold text-ink hover:underline"
              >
                {playlist.user.name}
              </Link>
            ) : (
              <span className="font-semibold text-ink">{playlist.user?.name ?? tt("playlist.unknown")}</span>
            )}
            {" · "}
            {tt("playlist.trackCount", { n: playlist.track_count || tracks.length })}
            {totalSec > 0 && ` · ${fmtDuration(totalSec)}`}
            {playlist.total_play_count ? ` · ${tt("playlist.plays", { n: fmtCount(playlist.total_play_count) })}` : ""}
          </p>
        </motion.div>
      </div>

      <div className="px-6 pt-5">
        <div className="mb-6 flex items-center gap-3">
          {tracks.length > 0 && (
            <button
              onClick={() => playContext(tracks, 0)}
              className="flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
            >
              <Play size={16} className="fill-current" /> {tt("playlist.play")}
            </button>
          )}
          {tracks.length > 0 && (
            <button
              onClick={() => {
                const pid = createPlaylist(playlist.playlist_name)
                addTracksToPlaylist(pid, tracks)
                navigate(`/playlist/${pid}`)
              }}
              className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Plus size={15} /> {tt("playlist.saveToLibrary")}
            </button>
          )}
          {tracks.length > 0 && (
            <button
              onClick={() => void startAll(tracks).then((n) => notify(n > 0 ? t("playlist.downloading", { n }) : t("playlist.alreadyDownloaded")))}
              title={tt("playlist.downloadAllTitle")}
              className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Download size={15} /> {tt("playlist.downloadAll")}
            </button>
          )}
          {playlist.permalink && (
            <button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(playlist.permalink!)
                  .then(() => setCopied(true))
                  .catch(() => {})
                setTimeout(() => setCopied(false), 1500)
              }}
              title={tt("playlist.copyLink")}
              aria-label={tt("playlist.copyLinkAria")}
              className="grid size-10 place-items-center rounded-full border border-line text-dim transition hover:border-dim hover:text-ink"
            >
              {copied ? <Check size={15} /> : <Link2 size={15} />}
            </button>
          )}
          {tracks.length > 8 && (
            <label className="ml-auto flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm text-dim transition focus-within:border-white/40">
              <Search size={14} />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={tt("playlist.findInPlaylist")}
                className="w-32 bg-transparent placeholder:text-faint focus-visible:shadow-none"
              />
            </label>
          )}
        </div>
        {tracksError ? (
          <div className="py-10 text-sm text-dim">
            <p>{tt("playlist.tracksError")}</p>
            <button
              onClick={() => setRetry((r) => r + 1)}
              className="mt-3 rounded-full border border-line px-5 py-1.5 text-xs font-semibold transition hover:border-white/30"
            >
              {tt("playlist.retry")}
            </button>
          </div>
        ) : shown.length > 0 ? (
          <TrackTable tracks={shown} />
        ) : tracks.length > 0 ? (
          <p className="py-10 text-sm text-dim">{tt("playlist.noMatch", { q: filter })}</p>
        ) : (
          <p className="py-10 text-sm text-dim">{tt("playlist.empty")}</p>
        )}
      </div>
    </div>
  )
}

// ---- user-created playlists (local, persisted) ----
function LocalPlaylistView({ id }: { id: string }) {
  const playlist = useLibrary((s) => s.playlists.find((p) => p.id === id))
  const renamePlaylist = useLibrary((s) => s.renamePlaylist)
  const deletePlaylist = useLibrary((s) => s.deletePlaylist)
  const removeFromPlaylist = useLibrary((s) => s.removeFromPlaylist)
  const playContext = usePlayer((s) => s.playContext)
  const startAll = useDownloads((s) => s.startAll)
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [confirmDel, setConfirmDel] = useState(false)
  const tt = useT()

  if (!playlist) {
    return (
      <div className="grid place-items-center py-32 text-center">
        <div>
          <p className="text-lg font-semibold">{tt("playlist.notFound")}</p>
          <p className="mt-1 text-sm text-dim">{tt("playlist.notFound.localSub")}</p>
        </div>
      </div>
    )
  }

  const tracks = playlist.tracks
  const totalSec = tracks.reduce((a, t) => a + (t.duration ?? 0), 0)

  const commitName = () => {
    renamePlaylist(id, draft)
    setEditing(false)
  }

  return (
    <div className="-mt-12 pb-10">
      <div
        className="flex flex-col items-start gap-6 px-6 pb-8 pt-20 sm:flex-row sm:items-end"
        style={{
          background:
            "linear-gradient(180deg, rgb(255 255 255 / 0.08), transparent), radial-gradient(60% 100% at 90% 0%, rgb(255 255 255 / 0.04), transparent)",
        }}
      >
        <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
          <PlaylistCover
            tracks={tracks}
            className="size-44 rounded-xl shadow-2xl shadow-black/50 sm:size-52"
            iconSize={56}
          />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.08 }}
          className="min-w-0 flex-1"
        >
          <p className="text-xs font-semibold text-ink/70">{tt("playlist.playlist")}</p>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName()
                if (e.key === "Escape") setEditing(false)
              }}
              className="mt-2 w-full max-w-md rounded-lg border border-line bg-panel px-3 py-2 text-3xl font-black tracking-tight outline-none focus:border-dim sm:text-5xl"
            />
          ) : (
            <button
              onClick={() => {
                setDraft(playlist.name)
                setEditing(true)
              }}
              className="group mt-2 flex max-w-full items-center gap-3 text-left"
              title={tt("playlist.rename")}
              aria-label={tt("playlist.renameAria")}
            >
              <h1 title={playlist.name} className="line-clamp-3 break-words text-3xl font-black tracking-tight sm:text-5xl">{playlist.name}</h1>
              <Pencil size={20} className="shrink-0 text-faint opacity-0 transition group-hover:opacity-100" />
            </button>
          )}
          <p className="mt-3 text-sm text-dim">
            {tt("playlist.trackCount", { n: tracks.length })}{totalSec > 0 && ` · ${fmtDuration(totalSec)}`}
          </p>
        </motion.div>
      </div>

      <div className="flex items-center gap-3 px-6 pt-5">
        {tracks.length > 0 && (
          <button
            onClick={() => playContext(tracks, 0)}
            className="flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
          >
            <Play size={16} className="fill-current" /> {tt("playlist.play")}
          </button>
        )}
        {tracks.length > 0 && (
          <button
            onClick={() => void startAll(tracks).then((n) => notify(n > 0 ? t("playlist.downloading", { n }) : t("playlist.alreadyDownloaded")))}
            title={tt("playlist.downloadAllTitle")}
            className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-dim transition hover:border-dim hover:text-ink"
          >
            <Download size={15} /> {tt("playlist.downloadAll")}
          </button>
        )}
        <button
          onClick={() => {
            if (confirmDel) {
              deletePlaylist(id)
              navigate("/library")
            } else setConfirmDel(true)
          }}
          onMouseLeave={() => setConfirmDel(false)}
          className={`flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold transition ${
            confirmDel ? "border-white bg-white text-black" : "border-line text-dim hover:border-dim hover:text-ink"
          }`}
        >
          <Trash2 size={15} /> {confirmDel ? tt("playlist.deleteConfirm") : tt("playlist.delete")}
        </button>
      </div>

      <div className="px-6 pt-4">
        {tracks.length > 0 ? (
          <TrackTable
            tracks={tracks}
            onRemove={(t) => removeFromPlaylist(id, t.id)}
            removeLabel={tt("playlist.removeLabel")}
          />
        ) : (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-line py-20 text-center">
            <ListMusic size={44} className="text-faint" />
            <p className="mt-4 text-lg font-semibold">{tt("playlist.emptyLocal.title")}</p>
            <p className="mt-1 text-sm text-dim">{tt("playlist.emptyLocal.sub")}</p>
            <Link
              to="/search"
              className="mt-6 flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black transition hover:scale-105"
            >
              <Plus size={15} /> {tt("playlist.findSongs")}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
