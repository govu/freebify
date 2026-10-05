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
    if (s.items[t.id] || s.progress[t.id] !== undefined) return
    set((st) => ({ progress: { ...st.progress, [t.id]: 0 } }))
    // Audius streams need their resolved URL up front — the yt path only
    // needs the videoId (yt-dlp handles the rest)
    const url = t.source === "yt" ? undefined : streamUrl(t.id)
    try {
      const ok = await b.start({ id: t.id, source: t.source, streamId: t.streamId, url, track: slimTrack(t) })
      if (ok === false) set((st) => {
        const progress = { ...st.progress }
        delete progress[t.id]
        return { progress }
      })
    } catch {
      set((st) => {
        const progress = { ...st.progress }
        delete progress[t.id]
        return { progress }
      })
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
      delete items[id]
      delete progress[id]
      return { items, progress }
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

// boot wiring — pull the manifest once, then live off dl:event pushes
{
  const b = bridge()
  if (b) {
    void useDownloads.getState().refresh()
    b.onEvent?.((ev) => {
      if (!ev || typeof ev.id !== "string") return
      if (ev.type === "progress") {
        useDownloads.setState((s) => ({ progress: { ...s.progress, [ev.id]: ev.pct ?? 0 } }))
      } else if (ev.type === "done") {
        useDownloads.setState((s) => {
          const progress = { ...s.progress }
          delete progress[ev.id]
          const items = { ...s.items }
          const item = ev.item as Partial<DlItem> | undefined
          if (item?.file && item.track) {
            items[ev.id] = { file: item.file, addedAt: item.addedAt ?? Date.now(), track: item.track }
          }
          return { items, progress }
        })
      } else if (ev.type === "error") {
        useDownloads.setState((s) => {
          const progress = { ...s.progress }
          delete progress[ev.id]
          return { progress }
        })
      }
    })
  }
}
