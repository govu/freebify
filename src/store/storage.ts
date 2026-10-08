import type { Track, User } from "../api/types"

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
  let out = t
  if (t.id.startsWith("yt-") && !t.streamId) {
    out = { ...out, streamId: t.id.slice(3), source: "yt" }
  }
  const art = out.artwork
  if (art) {
    // i.ytimg URLs persisted with signed context params (?sqp=…&rs=…) go
    // dead when the signature expires — strip them so stored artwork
    // keeps loading forever (cleanThumb already does this for new fetches)
    const keys = ["150x150", "480x480", "1000x1000"] as const
    const next = { ...art }
    let fixed = false
    for (const k of keys) {
      const u = next[k]
      if (typeof u === "string" && /ytimg\.com\/[^?]+\?/.test(u)) {
        next[k] = u.replace(/(ytimg\.com\/[^?]+)\?.*$/, "$1")
        fixed = true
      }
    }
    // older persisted yt tracks predate the i.ytimg fallback key — backfill
    // so every stored track survives googleusercontent throttling
    const vid = out.streamId ?? (out.id.startsWith("yt-") ? out.id.slice(3) : null)
    if (vid && !next.fallback) {
      next.fallback = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
      fixed = true
    }
    if (fixed) out = { ...out, artwork: next }
  }
  return out
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

// Slim a User for persistence — same idea as slimTrack: bios and cover
// photos are unbounded fields we don't need on disk.
export function slimUser(u: User): User {
  return { ...u, bio: null, cover_photo: null }
}
export function isValidUser(v: unknown): v is User {
  return isObj(v) && typeof v.id === "string" && typeof v.name === "string" && Boolean(v.id)
}

export function sanitizeTrackList(v: unknown, cap: number): Track[] {
  return (Array.isArray(v) ? v : []).filter(isValidTrack).map((t) => slimTrack(repairTrack(t))).slice(0, cap)
}
