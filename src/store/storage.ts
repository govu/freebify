import type { Track } from "../api/types"

// ---- resilient localStorage for zustand persist ----
// - skips redundant writes (persist serializes on EVERY setState — with
//   partialize the payload is identical on high-frequency ticks like
//   currentTime, so comparing strings kills 4Hz writes for free)
// - swallows quota errors so a full disk never throws inside a user action
const lastWrites = new Map<string, string>()

export const safeStorage = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  setItem: (k: string, v: string) => {
    if (lastWrites.get(k) === v) return
    try {
      localStorage.setItem(k, v)
      lastWrites.set(k, v)
    } catch {
      /* quota exhausted — session state stays alive, persistence degrades */
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
    lastWrites.delete(k)
  },
}

// ---- persisted-state sanitizers (corrupt blobs can't brick the app) ----
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function isValidTrack(t: unknown): t is Track {
  if (!isObj(t)) return false
  const u = t.user
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    isObj(u) &&
    typeof u.name === "string" &&
    typeof u.id === "string" &&
    (t.duration == null || (typeof t.duration === "number" && Number.isFinite(t.duration)))
  )
}

// Backfill fields added after earlier builds persisted tracks.
export function repairTrack(t: Track): Track {
  if (t.id.startsWith("yt-") && !t.streamId) {
    return { ...t, streamId: t.id.slice(3), source: "yt" }
  }
  return t
}

// Strip heavy fields that don't need persisting (Audius descriptions/bios
// are unbounded) — keeps storage small so quota lasts.
export function slimTrack(t: Track): Track {
  return {
    ...t,
    description: undefined,
    user: { ...t.user, bio: undefined, cover_photo: null },
  }
}

export function sanitizeTrackList(v: unknown, cap: number): Track[] {
  return (Array.isArray(v) ? v : []).filter(isValidTrack).map((t) => slimTrack(repairTrack(t))).slice(0, cap)
}
