import { create } from "zustand"
import type { Track } from "../api/types"
import { monthKey, useStats } from "./stats"
import { safeStorage } from "./storage"

// Monthly Rewind — your own "Wrapped", derived entirely from local stats.
// A rewind unlocks the moment a calendar month closes; the current month
// is peekable as a "so far" edition once there's enough listening to show.

export interface RewindTrack {
  track: Track
  plays: number
  ms: number
}
export interface RewindArtist {
  name: string
  art: string | null
  plays: number
  ms: number
}
export interface RewindData {
  key: string // "2025-07"
  label: string // "July" (localized)
  full: string // "July 2025"
  partial: boolean // still-counting month → "so far" edition
  ms: number
  plays: number
  tracks: RewindTrack[] // top 5 by listening time
  artists: RewindArtist[] // top 5 by listening time
  trackCount: number
  artistCount: number
}

// a finished month needs some real listening to be worth a ceremony;
// the in-progress month just needs a pulse
const MIN_MS = 10 * 60_000
const MIN_PLAYS = 5
const MIN_PLAYS_PARTIAL = 3

export function buildRewind(key: string, partial = false): RewindData | null {
  const m = useStats.getState().months[key]
  if (!m) return null
  if (partial ? m.plays < MIN_PLAYS_PARTIAL : m.ms < MIN_MS || m.plays < MIN_PLAYS) return null
  const tracks = Object.values(m.tracks).sort((a, b) => b.ms - a.ms).slice(0, 5)
  const artists = Object.values(m.artists).sort((a, b) => b.ms - a.ms).slice(0, 5)
  if (!tracks.length) return null
  const [y, mo] = key.split("-").map(Number)
  const d = new Date(y, mo - 1, 1)
  return {
    key,
    partial,
    ms: m.ms,
    plays: m.plays,
    label: d.toLocaleDateString(undefined, { month: "long" }),
    full: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    tracks,
    artists,
    trackCount: Object.keys(m.tracks).length,
    artistCount: Object.keys(m.artists).length,
  }
}

// newest CLOSED month with enough data — what the monthly prompt fires for
export function latestRewind(): RewindData | null {
  const months = useStats.getState().months
  const cur = monthKey()
  const key = Object.keys(months)
    .filter((k) => k < cur)
    .sort()
    .pop()
  return key ? buildRewind(key) : null
}

// the month still running — the "so far" edition shown on demand
export function currentRewind(): RewindData | null {
  return buildRewind(monthKey(), true)
}

// the card/entry shows the freshest available edition either way
export function availableRewind(): RewindData | null {
  return latestRewind() ?? currentRewind()
}

const SEEN_KEY = "freebify-rewind-seen"
export const isRewindSeen = (key: string) => {
  try {
    return safeStorage.getItem(SEEN_KEY) === key
  } catch {
    return false
  }
}
const markRewindSeen = (key: string) => safeStorage.setItem(SEEN_KEY, key)

interface RewindState {
  active: RewindData | null
  open: (d: RewindData) => void
  close: () => void
}
export const useRewind = create<RewindState>()((set) => ({
  active: null,
  open: (d) => {
    markRewindSeen(d.key)
    set({ active: d })
  },
  close: () => set({ active: null }),
}))
