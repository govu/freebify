import { AnimatePresence, motion } from "motion/react"
import { FileSpreadsheet, Link2, Loader2, X } from "lucide-react"
import { useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { yt } from "../api/youtube"
import { notify } from "../store/player"
import { useLibrary } from "../store/library"

// Import playlists: Spotify or YouTube Music links, or a CSV export
// (each row re-matched by search). Best-effort matching — the top
// YouTube Music hit is taken; originals-only catalog means a few misses.

const YT_LIST = /[?&]list=([A-Za-z0-9_-]+)/
const SPOTIFY_LIST = /open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/

interface ImportEntry {
  title: string
  artist: string
}

// minimal CSV cell parser — quoted fields, escaped "" quotes, comma sep
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
// (or TuneMyMusic/other tools with title,artist — map loosely).
// Two passes: exact-ish headers first, then loose — otherwise a
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addTracksToPlaylist = useLibrary((s) => s.addTracksToPlaylist)
  const deletePlaylist = useLibrary((s) => s.deletePlaylist)
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const finish = (pid: string, n: number) => {
    setBusy(false)
    setProgress(null)
    setOpen(false)
    notify(`Imported ${n} tracks`)
    navigate(`/playlist/${pid}`)
  }

  // every entry is re-matched on YouTube Music — the top hit wins.
  // batches of 4 so a long list doesn't hammer search in one burst
  const matchEntries = async (playlistName: string, entries: ImportEntry[]) => {
    setProgress({ done: 0, total: entries.length })
    const pid = createPlaylist(playlistName)
    let found = 0
    const BATCH = 4
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH)
      const hits = await Promise.all(
        chunk.map(async (e) => {
          const q = `${e.artist} ${e.title}`.trim()
          if (!q) return null
          try {
            const res = await yt.search(q)
            return res.tracks[0] ?? null
          } catch {
            return null
          }
        })
      )
      addTracksToPlaylist(pid, hits.filter((t): t is NonNullable<typeof t> => Boolean(t)))
      found += hits.filter(Boolean).length
      setProgress({ done: Math.min(i + BATCH, entries.length), total: entries.length })
    }
    if (found === 0) {
      // every row failed to match — an empty playlist is worse than none
      deletePlaylist(pid)
      notify("No tracks matched")
      setBusy(false)
      setProgress(null)
      return
    }
    finish(pid, found)
  }

  const importUrl = async () => {
    const u = url.trim()
    const spotifyId = SPOTIFY_LIST.exec(u)?.[1]
    if (spotifyId) return importSpotify(spotifyId)
    const id = YT_LIST.exec(u)?.[1]
    if (!id) {
      notify("Paste a Spotify or YouTube Music playlist link")
      return
    }
    setBusy(true)
    try {
      const res = await yt.playlist(id.replace(/^VL/, ""))
      if (!res || res.tracks.length === 0) {
        notify("Playlist not found. Check it isn't private")
        setBusy(false)
        return
      }
      const pid = createPlaylist(res.playlist.playlist_name)
      addTracksToPlaylist(pid, res.tracks)
      finish(pid, res.tracks.length)
    } catch {
      notify("Import failed. Try again")
      setBusy(false)
    }
  }

  const importSpotify = async (id: string) => {
    setBusy(true)
    try {
      const res = await yt.spotifyList(id)
      if (!res) {
        notify("Couldn't read that playlist. Check it's public")
        setBusy(false)
        return
      }
      await matchEntries(res.name, res.tracks)
    } catch {
      notify("Import failed. Try again")
      setBusy(false)
      setProgress(null)
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
        .slice(0, 500) // cap — a 5000-row export would churn forever
        .map((r) => ({ title: r[ti]?.trim() ?? "", artist: r[ai]?.trim() ?? "" }))
      await matchEntries(file.name.replace(/\.[^.]+$/, ""), entries)
    } catch {
      notify("Couldn't read that CSV")
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-semibold text-dim transition hover:border-dim hover:text-ink"
      >
        <FileSpreadsheet size={15} /> Import
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
                <h3 className="text-lg font-bold">Import a playlist</h3>
                <button
                  onClick={() => !busy && setOpen(false)}
                  className="grid size-8 place-items-center rounded-full text-dim transition hover:bg-hover hover:text-ink"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="mt-5">
                <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-dim">
                  <Link2 size={12} /> Spotify or YouTube Music link
                </p>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && void importUrl()}
                  placeholder="open.spotify.com/playlist/…"
                  className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-sm outline-none transition placeholder:text-faint focus:border-white/40"
                />
                <p className="mt-2 text-xs text-faint">
                  Spotify: public playlists, first 50 tracks. YouTube Music: full list, no matching needed.
                </p>
                <button
                  onClick={() => void importUrl()}
                  disabled={busy || !url.trim()}
                  className="mt-3 w-full rounded-full bg-white py-2.5 text-sm font-bold text-black transition enabled:hover:scale-[1.02] disabled:opacity-40"
                >
                  {busy && !progress ? (
                    <Loader2 size={15} className="mx-auto animate-spin" />
                  ) : progress ? (
                    `Matching ${progress.done}/${progress.total}…`
                  ) : (
                    "Import playlist"
                  )}
                </button>
              </div>

              <div className="mt-6 border-t border-line pt-5">
                <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-dim">
                  <FileSpreadsheet size={12} /> CSV export
                </p>
                <p className="mb-3 text-xs text-faint">
                  For longer or private playlists. Title + artist columns are detected automatically. Max 500.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ""
                    if (f) void importCsv(f)
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  className="w-full rounded-full border border-line py-2.5 text-sm font-semibold text-dim transition enabled:hover:border-dim enabled:hover:text-ink disabled:opacity-40"
                >
                  {progress
                    ? `Matching ${progress.done}/${progress.total}…`
                    : "Choose .csv file"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
