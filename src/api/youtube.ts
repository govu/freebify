import type { Playlist, Track, User } from "./types"

// Renderer-side client for the YouTube Music service exposed by Electron
// preload (window.freebify). When the app runs in a plain browser, every
// helper degrades gracefully and the app falls back to Audius.

interface YtBridge {
  available: () => Promise<{ meta: boolean; bin: boolean }>
  search: (q: string) => Promise<{ tracks: Track[]; artists: User[]; playlists: Playlist[] }>
  stream: (videoId: string) => Promise<string | null>
  prefetch?: (videoId: string) => Promise<string | null>
  invalidate: (videoId: string) => Promise<boolean>
  artist: (id: string, nameHint?: string) => Promise<{ user: User; tracks: Track[] } | null>
  album: (id: string) => Promise<{ playlist: Playlist; tracks: Track[] } | null>
  playlist: (id: string) => Promise<{ playlist: Playlist; tracks: Track[] } | null>
  playlists: () => Promise<Playlist[]>
  upNext: (videoId: string) => Promise<Track[]>
  trending: () => Promise<Track[]>
  charts: () => Promise<{ tracks: Track[]; artists: User[] }>
  newReleases: () => Promise<Playlist[]>
  moods: () => Promise<{ name: string; params: string }[]>
  mood: (params: string) => Promise<{ name: string | null; playlists: Playlist[]; tracks: Track[] } | null>
  playlistArts: (id: string) => Promise<string[]>
  lyrics: (videoId: string) => Promise<{ lyrics: string } | null>
  captions?: (videoId: string) => Promise<{ lines: { t: number; text: string }[] } | null>
  suggest: (q: string) => Promise<string[]>
}

declare global {
  interface Window {
    freebify?: {
      yt: YtBridge
      dl?: {
        list: () => Promise<{ id: string; file: string; addedAt: number; track: Track }[]>
        exists: (id: string) => Promise<boolean>
        start: (p: {
          id: string
          source?: string
          streamId?: string
          url?: string
          track: Track
        }) => Promise<unknown>
        remove: (id: string) => Promise<boolean>
        openDir: () => void
        onEvent: (
          cb: (ev: { type: string; id: string; pct?: number; item?: unknown; msg?: string }) => void,
        ) => () => void
      }
      player?: {
        thumbar: (s: { playing: boolean; title?: string; artist?: string; progress?: number }) => void
        onCommand: (cb: (c: string) => void) => void
        presence?: (s: {
          playing: boolean
          title?: string
          artist?: string
          artwork?: string
          durationMs?: number
          positionMs?: number
          url?: string
        } | null) => void
        presenceEnabled?: (v: boolean) => void
      }
      win?: {
        control: (action: "minimize" | "maximize" | "close") => void
        onMaximized: (cb: (v: boolean) => void) => () => void
      }
      app?: {
        info: () => Promise<{ version: string; electron: string; chromium: string; platform: string }>
        openLogs: () => void
        log: (msg: string) => void
        onDeepLink: (cb: (path: string) => void) => () => void
        onUpdateReady: (cb: (version: string) => void) => () => void
        installUpdate: () => Promise<void>
      }
    }
  }
}

export const ytBridge = (): YtBridge | null => window.freebify?.yt ?? null

let availability: Promise<boolean> | null = null
export function ytAvailable(): Promise<boolean> {
  if (!availability) {
    const b = ytBridge()
    availability = b
      ? b
          .available()
          // gate the CATALOG on meta only — a missing/quarantined
          // yt-dlp.exe used to disable all YouTube metadata too, silently
          // downgrading to Audius-only. Stream resolution handles a dead
          // binary itself (iframe engine fallback).
          .then((a) => a.meta)
          .catch(() => false)
          .then((ok) => {
            if (!ok) availability = null // transient failure — retry next time
            return ok
          })
      : Promise.resolve(false)
  }
  return availability
}

export const yt = {
  search: async (q: string) => {
    const b = ytBridge()
    if (!b) return { tracks: [], artists: [], playlists: [] }
    return b.search(q)
  },
  stream: (videoId: string) => ytBridge()?.stream(videoId) ?? Promise.resolve(null),
  prefetch: (videoId: string) =>
    (ytBridge()?.prefetch ?? ytBridge()?.stream)?.(videoId) ?? Promise.resolve(null),
  invalidate: (videoId: string) => ytBridge()?.invalidate(videoId) ?? Promise.resolve(false),
  artist: (id: string, nameHint?: string) => ytBridge()?.artist(id, nameHint) ?? Promise.resolve(null),
  album: (id: string) => ytBridge()?.album(id) ?? Promise.resolve(null),
  playlist: (id: string) => ytBridge()?.playlist(id) ?? Promise.resolve(null),
  playlists: () => ytBridge()?.playlists() ?? Promise.resolve([]),
  upNext: (videoId: string) => ytBridge()?.upNext(videoId) ?? Promise.resolve([]),
  trending: () => ytBridge()?.trending() ?? Promise.resolve([]),
  charts: () => ytBridge()?.charts() ?? Promise.resolve({ tracks: [], artists: [] }),
  newReleases: () => ytBridge()?.newReleases() ?? Promise.resolve([]),
  moods: () => ytBridge()?.moods() ?? Promise.resolve([]),
  mood: (params: string) => ytBridge()?.mood(params) ?? Promise.resolve(null),
  playlistArts: (id: string) => ytBridge()?.playlistArts(id) ?? Promise.resolve([]),
  lyrics: (videoId: string) => ytBridge()?.lyrics(videoId) ?? Promise.resolve(null),
  captions: (videoId: string) => ytBridge()?.captions?.(videoId) ?? Promise.resolve(null),
  suggest: (q: string) => ytBridge()?.suggest(q) ?? Promise.resolve([]),
}

// Resolve a YouTube track's stream url ahead of the click — hovering or
// seeing a row warms the yt-dlp cache so play() starts in milliseconds.
// Uses the low-priority lane so warm-up never delays a real playback click.
// Renderer-side dedup: re-renders and pointer events can fire this for the
// same track many times — the main-process inflight map would merge them
// anyway, but each call still costs an IPC round-trip.
const prefetched = new Set<string>()
export function prefetchStream(t: Track) {
  if (t.source !== "yt" || !t.streamId || prefetched.has(t.streamId)) return
  prefetched.add(t.streamId)
  // cap the set — a long session resolves hundreds of ids
  if (prefetched.size > 800) {
    const first = prefetched.values().next().value
    if (first) prefetched.delete(first)
  }
  void yt.prefetch(t.streamId).catch(() => null)
}
