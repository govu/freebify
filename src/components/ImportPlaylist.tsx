import { AnimatePresence, motion } from "motion/react"
import { FileSpreadsheet, Link2, Loader2, X } from "lucide-react"
import { useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { yt } from "../api/youtube"
import type { Track } from "../api/types"
import { t, useT } from "../i18n"
import { notify } from "../store/player"
import { useLibrary } from "../store/library"
import { enqueuePending } from "../store/resolve"

// Import playlists: Spotify or YouTube Music links, or a CSV export
// (each row re-matched by search). Best-effort matching - the best scored
// hit is taken; originals-only catalog means a few misses. Matching runs in
// the main process at high concurrency, so even a 1000 track list is quick.

const YT_LIST = /[?&]list=([A-Za-z0-9_-]+)/
const SPOTIFY_LIST = /open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/

interface ImportEntry {
  title: string
  artist: string
  duration?: number
}
// minimal CSV cell parser - quoted fields, escaped "" quotes, comma sep
function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let cur = "", inQ = false, row: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQ = false
      else cur += c
    } else if (c === '"') inQ = true
    else if (c === ",") { row.push(cur); cur = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(cur); cur = ""
      if (row.some((f) => f.trim())) rows.push(row)
      row = []
    } else cur += c
  }
  row.push(cur)
  if (row.some((f) => f.trim())) rows.push(row)
  return rows
}

// Spotify export headers look like: "Track Name","Artist Name(s)",...
// (or TuneMyMusic/other tools with title,artist - map loosely).
// Two passes: exact-ish headers first, then loose - otherwise a
// "Songwriters"/"Album Name" column can steal the title slot
function findCols(header: string[]): [number, number] {
  const h = header.map((s) => s.trim().toLowerCase())
  const title =
    h.findIndex((s) => /^(track name|track title|title|name|song|song name)$/.test(s)) ??
    -1
  const titleLoose = title >= 0 ? title : h.findIndex((s) => /track name|song name/.test(s))
  const artist = h.findIndex((s) => /artist/.test(s))
  return [titleLoose >= 0 ? titleLoose : 0, artist >= 0 ? artist : 1]
}

export function ImportPlaylist() {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addTracksToPlaylist = useLibrary((s) => s.addTracksToPlaylist)
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const tt = useT()

  const finish = (pid: string, n: number, limited?: boolean) => {
    setBusy(false)
    setOpen(false)
    notify(limited ? t("import.limited", { n }) : t("import.imported", { n }))
    navigate(`/playlist/${pid}`)
  }

  // The playlist is created from the import metadata alone - every row is
  // real from the first frame and resolved behind it (store/resolve.ts), so
  // a 1000 track list is usable in about a second instead of a modal
  // counting to 1000.
  const matchEntries = async (playlistName: string, entries: ImportEntry[], limited?: boolean) => {
    const pid = createPlaylist(playlistName)
    const placeholders: Track[] = entries.map((e, i) => ({
      id: `spi-${pid}-${i}`,
      source: "yt",
      pending: true,
      title: e.title || "Untitled",
      duration: e.duration ?? 0,
      play_count: 0,
      repost_count: 0,
      favorite_count: 0,
      artwork: null,
      user: {
        id: `spa-${e.artist.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        handle: e.artist,
        name: e.artist || "Unknown artist",
        is_verified: false,
        follower_count: 0,
        track_count: 0,
        profile_picture: null,
        cover_photo: null,
      },
    }))
    addTracksToPlaylist(pid, placeholders)
    enqueuePending(pid, placeholders)
    setBusy(false)
    setOpen(false)
    notify(limited ? t("import.limited", { n: placeholders.length }) : t("import.imported", { n: placeholders.length }))
    navigate(`/playlist/${pid}`)
  }

  const importUrl = async () => {
    const u = url.trim()
    const spotifyId = SPOTIFY_LIST.exec(u)?.[1]
    if (spotifyId) {
      return importSpotify(spotifyId)
    }
    const id = YT_LIST.exec(u)?.[1]
    if (!id) {
      notify(t("import.pasteLink"))
      return
    }
    setBusy(true)
    try {
      const res = await yt.playlist(id.replace(/^VL/, ""))
      if (!res || res.tracks.length === 0) {
        notify(t("import.notFound"))
        setBusy(false)
        return
      }
      const pid = createPlaylist(res.playlist.playlist_name)
      addTracksToPlaylist(pid, res.tracks)
      finish(pid, res.tracks.length)
    } catch {
      notify(t("import.failed"))
      setBusy(false)
    }
  }

  const importSpotify = async (id: string) => {
    setBusy(true)
    try {
      const res = await yt.spotifyImport(id)
      if (!res?.ok || !res.name) {
        notify(t("import.unreadable"))
        setBusy(false)
        return
      }
      await matchEntries(res.name, res.tracks ?? [], res.limited)
    } catch {
      notify(t("import.failed"))
      setBusy(false)
    }
  }

  const importCsv = async (file: File) => {
    setBusy(true)
    try {
      const rows = csvRows(await file.text())
      if (rows.length < 2) throw new Error("empty")
      const [ti, ai] = findCols(rows[0])
      const entries: ImportEntry[] = rows
        .slice(1)
        .slice(0, 5000) // rows land instantly, matching fills in behind them
        .map((r) => ({ title: r[ti]?.trim() ?? "", artist: r[ai]?.trim() ?? "" }))
      await matchEntries(file.name.replace(/\.[^.]+$/, ""), entries)
    } catch {
      notify(t("import.badCsv"))
      setBusy(false)
    }
  }

  // .freebify.json - our own export format; entries still re-match through
  // search so the imported playlist holds real playable Track objects
  const importJson = async (file: File) => {
    setBusy(true)
    try {
      const j = JSON.parse(await file.text())
      if (j?.app !== "freebify" || j?.type !== "playlist" || !Array.isArray(j?.tracks))
        throw new Error("not a freebify playlist")
      const entries: ImportEntry[] = j.tracks
        .slice(0, 5000)
        .map((tr: { title?: string; artist?: string }) => ({
          title: String(tr?.title ?? ""),
          artist: String(tr?.artist ?? ""),
        }))
        .filter((e: ImportEntry) => e.title || e.artist)
      if (!entries.length) throw new Error("empty")
      await matchEntries(
        typeof j.name === "string" && j.name.trim() ? j.name : file.name.replace(/\.[^.]+$/, "").replace(/\.freebify$/, ""),
        entries,
      )
    } catch {
      notify(t("import.badJson"))
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-semibold text-dim transition hover:border-dim hover:text-ink"
      >
        <FileSpreadsheet size={15} /> {tt("import.button")}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !busy && setOpen(false)}
            className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-2xl shadow-black/60"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold">{tt("import.title")}</h3>
                <button
                  onClick={() => !busy && setOpen(false)}
                  className="grid size-8 place-items-center rounded-full text-dim transition hover:bg-hover hover:text-ink"
                  aria-label={tt("import.close")}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="mt-5">
                <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-dim">
                  <Link2 size={12} /> {tt("import.linkLabel")}
                </p>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && void importUrl()}
                  placeholder="open.spotify.com/playlist/…"
                  className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-sm outline-none transition placeholder:text-faint focus:border-white/40"
                />
                <p className="mt-2 text-xs text-faint">
                  {tt("import.linkHint")}
                </p>
                <button
                  onClick={() => void importUrl()}
                  disabled={busy || !url.trim()}
                  className="mt-3 w-full rounded-full bg-white py-2.5 text-sm font-bold text-black transition enabled:hover:scale-[1.02] disabled:opacity-40"
                >
                  {busy ? <Loader2 size={15} className="mx-auto animate-spin" /> : tt("import.submit")}
                </button>
              </div>

              <div className="mt-6 border-t border-line pt-5">
                <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-dim">
                  <FileSpreadsheet size={12} /> {tt("import.csvLabel")}
                </p>
                <p className="mb-3 text-xs text-faint">
                  {tt("import.csvHint")}
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.json,.freebify.json,text/csv,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ""
                    if (f) void (/\.(freebify\.json|json)$/i.test(f.name) ? importJson(f) : importCsv(f))
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  className="w-full rounded-full border border-line py-2.5 text-sm font-semibold text-dim transition enabled:hover:border-dim enabled:hover:text-ink disabled:opacity-40"
                >
                  {tt("import.chooseCsv")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
