import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { Track } from "../api/types"
import { isObj, isValidTrack, safeStorage, slimTrack } from "./storage"
import { usePlayer } from "./player"

// Local listening stats — your own "Wrapped", no account, no server.
// Aggregated only (per-track and per-artist counters + daily minutes), not
// raw event logs — stays small and private by design.
//
// recordMs is called on every playback tick (~4Hz): writes are buffered in
// memory and flushed on a timer / playback transition, so persist never
// serializes the whole aggregate inside the player's setState hot path.

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

// caps keep a years-long library from outgrowing localStorage — entries are
// evicted lowest-playtime-first, so the stats that survive are the ones
// that actually matter
const MAX_TRACKS = 300
const MAX_ARTISTS = 200
const MAX_DAYS = 120
const FLUSH_MS = 15_000

interface StatsState {
  tracks: Record<string, TrackAgg>
  artists: Record<string, ArtistAgg>
  days: Record<string, number> // YYYY-MM-DD → ms listened
  totalMs: number
  totalPlays: number
  recordMs: (t: Track, ms: number) => void
  recordPlay: (t: Track) => void
  flush: () => void
}

const dayKey = () => new Date().toISOString().slice(0, 10)

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)

// pending deltas — accumulated between flushes
let pendMs = new Map<string, number>() // trackId -> ms
let pendTracks = new Map<string, Track>() // trackId -> slim track
let pendDays = 0 // ms for the current day bucket
let pendTotal = 0

function prune<T>(rec: Record<string, T>, cap: number, msOf: (v: T) => number): Record<string, T> {
  const keys = Object.keys(rec)
  if (keys.length <= cap) return rec
  // keep the biggest `cap` by listening time — ties keep insertion order
  const keep = new Set(keys.sort((a, b) => msOf(rec[b]) - msOf(rec[a])).slice(0, cap))
  const out: Record<string, T> = {}
  for (const k of keys) if (keep.has(k)) out[k] = rec[k]
  return out
}

function pruneDays(days: Record<string, number>): Record<string, number> {
  const keys = Object.keys(days)
  if (keys.length <= MAX_DAYS) return days
  // ISO day keys sort chronologically — drop the oldest
  const keep = new Set(keys.sort().slice(-MAX_DAYS))
  const out: Record<string, number> = {}
  for (const k of keys) if (keep.has(k)) out[k] = days[k]
  return out
}

export const useStats = create<StatsState>()(
  persist(
    (set) => ({
      tracks: {},
      artists: {},
      days: {},
      totalMs: 0,
      totalPlays: 0,

      // hot path — buffer only; a set() here would serialize the whole
      // aggregate to localStorage four times a second
      recordMs: (t, ms) => {
        if (!t || !Number.isFinite(ms) || ms <= 0) return
        pendMs.set(t.id, (pendMs.get(t.id) ?? 0) + ms)
        if (!pendTracks.has(t.id)) pendTracks.set(t.id, slimTrack(t))
        pendDays += ms
        pendTotal += ms
        scheduleFlush()
      },

      recordPlay: (t) =>
        set((s) => {
          if (!t) return s
          const prev = s.tracks[t.id]
          const a = t.user?.name ?? "Unknown artist"
          const prevA = s.artists[a]
          const art = t.artwork?.["150x150"] ?? null
          return {
            totalPlays: s.totalPlays + 1,
            tracks: prune(
              {
                ...s.tracks,
                [t.id]: { track: slimTrack(t), plays: (prev?.plays ?? 0) + 1, ms: prev?.ms ?? 0 },
              },
              MAX_TRACKS,
              (v) => v.ms,
            ),
            artists: prune(
              {
                ...s.artists,
                [a]: {
                  name: a,
                  art: prevA?.art ?? art,
                  plays: (prevA?.plays ?? 0) + 1,
                  ms: prevA?.ms ?? 0,
                },
              },
              MAX_ARTISTS,
              (v) => v.ms,
            ),
          }
        }),

      // merge the buffered deltas into state once — one serialization per
      // flush instead of one per tick
      flush: () =>
        set((s) => {
          if (!pendMs.size && !pendTotal) return s
          const msTotal = pendTotal
          const dayMs = pendDays
          const tracks = { ...s.tracks }
          const artists = { ...s.artists }
          for (const [id, ms] of pendMs) {
            const t = pendTracks.get(id)
            if (!t) continue
            const prev = tracks[id]
            tracks[id] = { track: t, plays: prev?.plays ?? 0, ms: (prev?.ms ?? 0) + ms }
            const a = t.user?.name ?? "Unknown artist"
            const prevA = artists[a]
            artists[a] = {
              name: a,
              art: prevA?.art ?? t.artwork?.["150x150"] ?? null,
              plays: prevA?.plays ?? 0,
              ms: (prevA?.ms ?? 0) + ms,
            }
          }
          pendMs = new Map()
          pendTracks = new Map()
          pendDays = 0
          pendTotal = 0
          return {
            totalMs: s.totalMs + msTotal,
            days: pruneDays({ ...s.days, [dayKey()]: (s.days[dayKey()] ?? 0) + dayMs }),
            tracks: prune(tracks, MAX_TRACKS, (v) => v.ms),
            artists: prune(artists, MAX_ARTISTS, (v) => v.ms),
          }
        }),
    }),
    {
      name: "freebify-stats",
      storage: createJSONStorage(() => safeStorage),
      version: 2,
      // functions drop out of JSON anyway — partialize keeps it explicit
      partialize: (s) => ({
        tracks: s.tracks,
        artists: s.artists,
        days: s.days,
        totalMs: s.totalMs,
        totalPlays: s.totalPlays,
      }),
      // validate every persisted field — a corrupt blob (NaN, wrong types,
      // non-track values) must degrade to zeroed stats, never throw inside
      // a player listener that happens to trigger the merge
      merge: (persisted, current) => {
        const p = isObj(persisted) ? persisted : {}
        const tracks: Record<string, TrackAgg> = {}
        if (isObj(p.tracks)) {
          for (const [k, v] of Object.entries(p.tracks)) {
            if (isObj(v) && isValidTrack(v.track)) {
              tracks[k] = { track: slimTrack(v.track), plays: num(v.plays), ms: num(v.ms) }
            }
          }
        }
        const artists: Record<string, ArtistAgg> = {}
        if (isObj(p.artists)) {
          for (const [k, v] of Object.entries(p.artists)) {
            if (isObj(v) && typeof v.name === "string") {
              artists[k] = {
                name: v.name,
                art: typeof v.art === "string" ? v.art : null,
                plays: num(v.plays),
                ms: num(v.ms),
              }
            }
          }
        }
        const days: Record<string, number> = {}
        if (isObj(p.days)) {
          for (const [k, v] of Object.entries(p.days)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(k)) days[k] = num(v)
          }
        }
        return {
          ...current,
          tracks: prune(tracks, MAX_TRACKS, (v) => v.ms),
          artists: prune(artists, MAX_ARTISTS, (v) => v.ms),
          days: pruneDays(days),
          totalMs: num(p.totalMs),
          totalPlays: num(p.totalPlays),
        }
      },
      // v1 blobs used the same shape minus validation — plain merge suffices
      migrate: (persisted) => persisted,
    },
  ),
)

let flushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      useStats.getState().flush()
    } catch {
      /* a stats write must never throw inside the player emit chain */
    }
  }, FLUSH_MS)
}

// ---- feed from the player ----------------------------------------------
// Accumulate real listening time from timeupdate deltas (clamped so a seek
// jump can't inflate it), and count a "play" once a track passes 30s.
let lastT = 0
let lastId: string | null = null
let countedFor: string | null = null
let acc = 0

usePlayer.subscribe((s, prev) => {
  try {
    const t = s.current
    if (!t) {
      lastId = null
      return
    }
    if (t.id !== lastId) {
      // track changed — settle the pending time before it scrolls off
      if (flushTimer || pendTotal > 0) useStats.getState().flush()
      lastId = t.id
      countedFor = null
      acc = 0
    }
    if (!s.isPlaying) {
      lastT = s.currentTime
      // paused/stopped — make the buffered time durable now rather than
      // holding it until the timer (app could close in between)
      if (pendTotal > 0) useStats.getState().flush()
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
  } catch {
    /* stats must never break playback */
  }
})

// last chance to persist buffered listening time before unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    try {
      useStats.getState().flush()
    } catch {}
  })
}
