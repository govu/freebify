import { create } from "zustand"
import type { Track } from "../api/types"
import { streamUrl } from "../api/audius"
import { slimTrack } from "./storage"

// Renderer mirror of the main-process download manifest — main owns the
// files + truth; this store just reflects it for menus/badges/playback.
export interface DlItem {
  file: string
  addedAt: number
  track: Track
}

interface DownloadsState {
  items: Record<string, DlItem>
  // in-flight downloads — id → 0-99 (entries vanish on done/error)
  progress: Record<string, number>
  // track metadata for in-flight rows — the manifest only knows finished
  // downloads, so without this a queued job renders as a raw "yt-…" id
  pendingTracks: Record<string, Track>
  // ids sitting in the main-process queue (not yet started)
  queued: Record<string, true>
  refresh: () => Promise<void>
  start: (t: Track) => Promise<void>
  startAll: (tracks: Track[]) => Promise<number>
  remove: (id: string) => Promise<void>
  // drop a stale entry without touching main — used when the play path
  // discovers the file is already gone (main pruned it in dl:exists)
  dropLocal: (id: string) => void
}

const bridge = () => window.freebify?.dl ?? null

export const useDownloads = create<DownloadsState>()((set, get) => ({
  items: {},
  progress: {},
  pendingTracks: {},
  queued: {},

  refresh: async () => {
    const b = bridge()
    if (!b) return
    try {
      const list = await b.list()
      const items: Record<string, DlItem> = {}
      for (const it of list) {
        if (it?.id && it.file && it.track) items[it.id] = { file: it.file, addedAt: it.addedAt, track: it.track }
      }
      set({ items })
    } catch {
      /* manifest read failed — keep whatever we have */
    }
  },

  start: async (t) => {
    const b = bridge()
    if (!b) return
    const s = get()
    if (s.items[t.id] || s.progress[t.id] !== undefined || s.queued[t.id]) return
    set((st) => ({
      pendingTracks: { ...st.pendingTracks, [t.id]: slimTrack(t) },
      queued: { ...st.queued, [t.id]: true },
    }))
    // Audius streams need their resolved URL up front — the yt path only
    // needs the videoId (yt-dlp handles the rest)
    const url = t.source === "yt" ? undefined : streamUrl(t.id)
    try {
      const ok = await b.start({ id: t.id, source: t.source, streamId: t.streamId, url, track: slimTrack(t) })
      if (ok === false) cleanup(t.id)
    } catch {
      cleanup(t.id)
    }
  },

  // batch entry point for "download album/playlist" — the main process
  // queue caps concurrency, so this just fires every track's start()
  startAll: async (tracks) => {
    const s = get()
    const fresh = tracks.filter((t) => t && !s.items[t.id] && s.progress[t.id] === undefined)
    for (const t of fresh) void s.start(t)
    return fresh.length
  },

  remove: async (id) => {
    const b = bridge()
    set((st) => {
      const items = { ...st.items }
      const progress = { ...st.progress }
      const pendingTracks = { ...st.pendingTracks }
      const queued = { ...st.queued }
      delete items[id]
      delete progress[id]
      delete pendingTracks[id]
      delete queued[id]
      return { items, progress, pendingTracks, queued }
    })
    if (b) await b.remove(id).catch(() => {})
  },

  dropLocal: (id) =>
    set((st) => {
      if (!st.items[id]) return st
      const items = { ...st.items }
      delete items[id]
      return { items }
    }),
}))

// clear every trace of an in-flight id — shared by start() rejection and
// the done/error event paths
function cleanup(id: string) {
  useDownloads.setState((s) => {
    const progress = { ...s.progress }
    const pendingTracks = { ...s.pendingTracks }
    const queued = { ...s.queued }
    delete progress[id]
    delete pendingTracks[id]
    delete queued[id]
    return { progress, pendingTracks, queued }
  })
}

// boot wiring — pull the manifest once, then live off dl:event pushes
{
  const b = bridge()
  if (b) {
    void useDownloads.getState().refresh()
    b.onEvent?.((ev) => {
      if (!ev || typeof ev.id !== "string") return
      if (ev.type === "queued") {
        useDownloads.setState((s) => ({ queued: { ...s.queued, [ev.id]: true } }))
      } else if (ev.type === "progress") {
        // first progress from a job = it actually started — off the waitlist
        useDownloads.setState((s) => {
          const queued = { ...s.queued }
          delete queued[ev.id]
          return { progress: { ...s.progress, [ev.id]: ev.pct ?? 0 }, queued }
        })
      } else if (ev.type === "done") {
        const item = ev.item as Partial<DlItem> | undefined
        useDownloads.setState((s) => {
          const items = { ...s.items }
          if (item?.file && item.track) {
            items[ev.id] = { file: item.file, addedAt: item.addedAt ?? Date.now(), track: item.track }
          }
          return { items }
        })
        cleanup(ev.id)
      } else if (ev.type === "error") {
        cleanup(ev.id)
      }
    })
  }
}
