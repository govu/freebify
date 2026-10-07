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

// one bucket per calendar month — powers the monthly Rewind (top tracks /
// artists / minutes of THAT month, not the all-time aggregates)
interface MonthAgg {
  ms: number
  plays: number
  tracks: Record<string, TrackAgg>
  artists: Record<string, ArtistAgg>
}

// caps keep a years-long library from outgrowing localStorage — entries are
// evicted lowest-playtime-first, so the stats that survive are the ones
// that actually matter
const MAX_TRACKS = 300
const MAX_ARTISTS = 200
const MAX_DAYS = 120
const MAX_MONTHS = 14 // a year + headroom — older months drop off the edge
const MAX_MONTH_TRACKS = 60
const MAX_MONTH_ARTISTS = 40
const FLUSH_MS = 15_000

interface StatsState {
  tracks: Record<string, TrackAgg>
  artists: Record<string, ArtistAgg>
  days: Record<string, number> // YYYY-MM-DD → ms listened
  months: Record<string, MonthAgg> // YYYY-MM → per-month aggregate
  totalMs: number
  totalPlays: number
  recordMs: (t: Track, ms: number) => void
  recordPlay: (t: Track) => void
  flush: () => void
}

// LOCAL calendar day — toISOString() is UTC, which lands evening sessions
// (UTC+1/+2) on the next day and midnight sessions on the previous one
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
export const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`

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

function pruneMonths(months: Record<string, MonthAgg>): Record<string, MonthAgg> {
  const keys = Object.keys(months)
  if (keys.length <= MAX_MONTHS) return months
  const keep = new Set(keys.sort().slice(-MAX_MONTHS))
  const out: Record<string, MonthAgg> = {}
  for (const k of keys) if (keep.has(k)) out[k] = months[k]
  return out
}

// increment plays inside a month bucket — mirrors the all-time merge below
function bumpMonthPlays(months: Record<string, MonthAgg>, mk: string, t: Track): Record<string, MonthAgg> {
  const m = months[mk] ?? { ms: 0, plays: 0, tracks: {}, artists: {} }
  const prevT = m.tracks[t.id]
  const a = t.user?.name ?? "Unknown artist"
  const prevA = m.artists[a]
  const art = t.artwork?.["480x480"] ?? t.artwork?.["150x150"] ?? t.artwork?.fallback ?? null
  const tracks = prune({ ...m.tracks, [t.id]: { track: slimTrack(t), plays: (prevT?.plays ?? 0) + 1, ms: prevT?.ms ?? 0 } }, MAX_MONTH_TRACKS, (v) => v.ms)
  const artists = prune({ ...m.artists, [a]: { name: a, art: prevA?.art ?? art, plays: (prevA?.plays ?? 0) + 1, ms: prevA?.ms ?? 0 } }, MAX_MONTH_ARTISTS, (v) => v.ms)
  return { ...months, [mk]: { ms: m.ms, plays: m.plays + 1, tracks, artists } }
}

// shared sanitizers — merge() validates the all-time records AND every
// month bucket with the same rules
function sanTracks(v: unknown, cap: number): Record<string, TrackAgg> {
  const out: Record<string, TrackAgg> = {}
  if (isObj(v)) {
    for (const [k, a] of Object.entries(v)) {
      if (isObj(a) && isValidTrack(a.track)) {
        out[k] = { track: slimTrack(a.track), plays: num(a.plays), ms: num(a.ms) }
      }
    }
  }
  return prune(out, cap, (x) => x.ms)
}
function sanArtists(v: unknown, cap: number): Record<string, ArtistAgg> {
  const out: Record<string, ArtistAgg> = {}
  if (isObj(v)) {
    for (const [k, a] of Object.entries(v)) {
      if (isObj(a) && typeof a.name === "string") {
        out[k] = { name: a.name, art: typeof a.art === "string" ? a.art : null, plays: num(a.plays), ms: num(a.ms) }
      }
    }
  }
  return prune(out, cap, (x) => x.ms)
}

// pulled out of the persist options so merge failures surface instead of
// dying silently inside zustand's hydration catch
function mergePersisted(persisted: unknown, current: StatsState): StatsState {
  const p = isObj(persisted) ? persisted : {}
  const days: Record<string, number> = {}
  if (isObj(p.days)) {
    for (const [k, v] of Object.entries(p.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) days[k] = num(v)
    }
  }
  const months: Record<string, MonthAgg> = {}
  if (isObj(p.months)) {
    for (const [k, v] of Object.entries(p.months)) {
      if (!/^\d{4}-\d{2}$/.test(k) || !isObj(v)) continue
      months[k] = {
        ms: num(v.ms),
        plays: num(v.plays),
        tracks: sanTracks(v.tracks, MAX_MONTH_TRACKS),
        artists: sanArtists(v.artists, MAX_MONTH_ARTISTS),
      }
    }
  }
  return {
    ...current,
    tracks: sanTracks(p.tracks, MAX_TRACKS),
    artists: sanArtists(p.artists, MAX_ARTISTS),
    days: pruneDays(days),
    months: pruneMonths(months),
    totalMs: num(p.totalMs),
    totalPlays: num(p.totalPlays),
  }
}

export const useStats = create<StatsState>()(
  persist(
    (set) => ({
      tracks: {},
      artists: {},
      days: {},
      months: {},
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
          const art = t.artwork?.["480x480"] ?? t.artwork?.["150x150"] ?? t.artwork?.fallback ?? null
          return {
            totalPlays: s.totalPlays + 1,
            months: pruneMonths(bumpMonthPlays(s.months, monthKey(), t)),
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
          const mk = monthKey()
          const mo: MonthAgg = s.months[mk]
            ? { ...s.months[mk], tracks: { ...s.months[mk].tracks }, artists: { ...s.months[mk].artists } }
            : { ms: 0, plays: 0, tracks: {}, artists: {} }
          for (const [id, ms] of pendMs) {
            const t = pendTracks.get(id)
            if (!t) continue
            const prev = tracks[id]
            tracks[id] = { track: t, plays: prev?.plays ?? 0, ms: (prev?.ms ?? 0) + ms }
            const a = t.user?.name ?? "Unknown artist"
            const prevA = artists[a]
            const art = prevA?.art ?? t.artwork?.["480x480"] ?? t.artwork?.["150x150"] ?? t.artwork?.fallback ?? null
            artists[a] = { name: a, art, plays: prevA?.plays ?? 0, ms: (prevA?.ms ?? 0) + ms }
            const prevMT = mo.tracks[id]
            mo.tracks[id] = { track: t, plays: prevMT?.plays ?? 0, ms: (prevMT?.ms ?? 0) + ms }
            const prevMA = mo.artists[a]
            mo.artists[a] = { name: a, art: prevMA?.art ?? art, plays: prevMA?.plays ?? 0, ms: (prevMA?.ms ?? 0) + ms }
          }
          mo.ms += msTotal
          pendMs = new Map()
          pendTracks = new Map()
          pendDays = 0
          pendTotal = 0
          const months = { ...s.months }
          months[mk] = {
            ...mo,
            tracks: prune(mo.tracks, MAX_MONTH_TRACKS, (v) => v.ms),
            artists: prune(mo.artists, MAX_MONTH_ARTISTS, (v) => v.ms),
          }
          return {
            totalMs: s.totalMs + msTotal,
            days: pruneDays({ ...s.days, [dayKey()]: (s.days[dayKey()] ?? 0) + dayMs }),
            months: pruneMonths(months),
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
        months: s.months,
        totalMs: s.totalMs,
        totalPlays: s.totalPlays,
      }),
      // validate every persisted field — a corrupt blob (NaN, wrong types,
      // non-track values) must degrade to zeroed stats, never throw inside
      // a player listener that happens to trigger the merge
      merge: (persisted, current) => {
        try {
          return mergePersisted(persisted, current)
        } catch (e) {
          console.error("[stats] merge failed:", e)
          return current
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
  ;(window as unknown as { __stats?: typeof useStats }).__stats = useStats
}
