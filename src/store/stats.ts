import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { Track } from "../api/types"
import { safeStorage, slimTrack } from "./storage"
import { usePlayer } from "./player"

// Local listening stats — your own "Wrapped", no account, no server.
// Aggregated only (per-track and per-artist counters + daily minutes), not
// raw event logs — stays small and private by design.

interface TrackAgg {
  track: Track
  plays: number
  ms: number
}

interface ArtistAgg {
  name: string
  art: string | null
  plays: number
  ms: number
}

interface StatsState {
  tracks: Record<string, TrackAgg>
  artists: Record<string, ArtistAgg>
  days: Record<string, number> // YYYY-MM-DD → ms listened
  totalMs: number
  totalPlays: number
  recordMs: (t: Track, ms: number) => void
  recordPlay: (t: Track) => void
}

const dayKey = () => new Date().toISOString().slice(0, 10)

export const useStats = create<StatsState>()(
  persist(
    (set) => ({
      tracks: {},
      artists: {},
      days: {},
      totalMs: 0,
      totalPlays: 0,

      recordMs: (t, ms) =>
        set((s) => {
          if (!t || !Number.isFinite(ms) || ms <= 0) return s
          const prev = s.tracks[t.id]
          const a = t.user?.name ?? "Unknown artist"
          const prevA = s.artists[a]
          const art = t.artwork?.["150x150"] ?? null
          return {
            totalMs: s.totalMs + ms,
            days: { ...s.days, [dayKey()]: (s.days[dayKey()] ?? 0) + ms },
            tracks: {
              ...s.tracks,
              [t.id]: { track: slimTrack(t), plays: prev?.plays ?? 0, ms: (prev?.ms ?? 0) + ms },
            },
            artists: {
              ...s.artists,
              [a]: {
                name: a,
                art: prevA?.art ?? art,
                plays: prevA?.plays ?? 0,
                ms: (prevA?.ms ?? 0) + ms,
              },
            },
          }
        }),

      recordPlay: (t) =>
        set((s) => {
          if (!t) return s
          const prev = s.tracks[t.id]
          const a = t.user?.name ?? "Unknown artist"
          const prevA = s.artists[a]
          const art = t.artwork?.["150x150"] ?? null
          return {
            totalPlays: s.totalPlays + 1,
            tracks: {
              ...s.tracks,
              [t.id]: { track: slimTrack(t), plays: (prev?.plays ?? 0) + 1, ms: prev?.ms ?? 0 },
            },
            artists: {
              ...s.artists,
              [a]: {
                name: a,
                art: prevA?.art ?? art,
                plays: (prevA?.plays ?? 0) + 1,
                ms: prevA?.ms ?? 0,
              },
            },
          }
        }),
    }),
    {
      name: "freebify-stats",
      storage: createJSONStorage(() => safeStorage),
      version: 1,
    },
  ),
)

// ---- feed from the player ----------------------------------------------
// Accumulate real listening time from timeupdate deltas (clamped so a seek
// jump can't inflate it), and count a "play" once a track passes 30s.
let lastT = 0
let lastId: string | null = null
let countedFor: string | null = null
let acc = 0

usePlayer.subscribe((s, prev) => {
  const t = s.current
  if (!t) {
    lastId = null
    return
  }
  if (t.id !== lastId) {
    lastId = t.id
    countedFor = null
    acc = 0
  }
  if (!s.isPlaying) {
    lastT = s.currentTime
    return
  }
  const dt = s.currentTime - (prev?.currentTime ?? lastT)
  lastT = s.currentTime
  if (dt <= 0 || dt > 6) return // seek / stale tick — not listening time
  const ms = dt * 1000
  acc += ms
  useStats.getState().recordMs(t, ms)
  if (countedFor !== t.id && acc >= 30_000) {
    countedFor = t.id
    useStats.getState().recordPlay(t)
  }
})
