import type { Playlist, Track, TrendTime, User } from "./types"

const APP_NAME = "Freebify"
const BOOTSTRAP_HOST = "https://api.audius.co"

let hosts: string[] = [BOOTSTRAP_HOST]
let hostIndex = 0
let hostsRequested = false

// Fetch the list of healthy discovery nodes once. Every API call then races
// through the pool, rotating past unhealthy hosts automatically. A failed
// bootstrap used to pin us to api.audius.co forever — nothing retried.
async function loadHosts() {
  if (hostsRequested) return
  hostsRequested = true
  try {
    const res = await fetch(BOOTSTRAP_HOST, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { data?: unknown }
    if (Array.isArray(json.data)) {
      const ok = json.data.filter((h): h is string => typeof h === "string" && h.startsWith("https://"))
      if (ok.length > 0) hosts = ok
    }
  } catch {
    // retry on the next call — a transient bootstrap failure shouldn't
    // pin us to a single discovery node for the whole session
    hostsRequested = false
  }
}
void loadHosts()

async function api<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  await loadHosts() // bootstrap retry — a dead first attempt never recovers otherwise
  const qs = new URLSearchParams({ app_name: APP_NAME })
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))

  let lastError: unknown = new Error("no hosts")
  // hostIndex mutates inside the catch — capture the base BEFORE the loop
  // or `idx = (hostIndex + i)` can revisit the host that just died (with
  // two hosts it retried the dead one twice and never tried the live one)
  const base = hostIndex
  for (let i = 0; i < Math.min(hosts.length, 4); i++) {
    const idx = (base + i) % hosts.length
    try {
      const res = await fetch(`${hosts[idx]}/v1${path}?${qs.toString()}`, {
        signal: AbortSignal.timeout(15000),
      })
      // a 4xx is deterministic — the resource is missing/bad on EVERY
      // host; rotating quadruples latency for a guaranteed failure
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { data: T }
      if (json.data == null) throw new Error("empty data")
      hostIndex = idx
      return json.data
    } catch (e) {
      lastError = e
      if ((e as { fatal?: boolean }).fatal) throw e
      // remember the dead host — the next call must not burn its full
      // timeout before finding a live one
      if (hosts.length > 1) hostIndex = (idx + 1) % hosts.length
    }
  }
  throw lastError
}

const currentHost = () => hosts[hostIndex % hosts.length]

export function rotateHost() {
  hostIndex = (hostIndex + 1) % hosts.length
}

export function streamUrl(trackId: string) {
  return `${currentHost()}/v1/tracks/${trackId}/stream?app_name=${APP_NAME}`
}

// ---- originality filtering ---------------------------------------------
// The open catalog mixes originals with remixes, DJ sets, edits and spam.
// These helpers detect and deprioritize non-original content so the app
// surfaces studio versions first — the "like Spotify" behavior.

// Strong terms: non-original wherever they appear (incl. plurals).
const STRONG_RE =
  /(re-?mix(ed|es|ing)?|mash ?ups?|bootlegs?|re-?edits?|vip mixes?|club mixes?|extended (mix|versions?)|dj[ -_]?(sets?|mix(es)?)|megamix(es)?|mixtapes?|sped[- ]?up|speed[- ]?up|slowed( +(&|and|n'|’) +reverb)?|nightcore|daycore|type beats?|sample packs?|loop kits?|drum kits?|accent samples?|radio mixes?|festival mixes?|cover versions?|bass boosted|8d audio|\blive (at|version|session)|unplugged|\bdemos?\b|radio edit|orchestral version|piano version|refix)/i

// Weak terms also appear in real song titles ("Tribute", "Acapella",
// "Edit") — only flag them when they show up as a version qualifier,
// i.e. inside brackets or after a dash/colon: "(VIP)", "- Acapella".
// The trailing \b + bracket keeps "(Editorial)" and "- Edison" clean.
const WEAK_RE =
  /[([\-:]\s*(edits?|vip|flips?|karaoke|tributes?|a ?cappellas?|acapellas?|instrumentals?|covers?|live|acoustic|single version|rework)\b\s*[)\]]?/i

// query-side check: if the user explicitly searches for remixes/edits,
// don't filter them out of their own results. "dj"/"vip"/"edit" are
// excluded — artists like DJ Snake must not disable filtering.
export function isNonOriginalQuery(q: string): boolean {
  return (
    STRONG_RE.test(q) ||
    WEAK_RE.test(q) ||
    /\b(remix|mashup|bootleg|nightcore|sped.?up|slowed|karaoke|cover)\b/i.test(q)
  )
}

export function isNonOriginal(t: Track): boolean {
  if (t.remix_of != null) return true
  // title gets both checks; tags only the strong check — artists tag
  // originals "#remix contest"/"#type beat" routinely, but a weak
  // qualifier in a tag is meaningless noise
  return STRONG_RE.test(`${t.title} ${t.tags ?? ""}`) || WEAK_RE.test(t.title ?? "")
}

// DJ sets / podcasts / full-length mixes — not "songs"
export function isLongForm(t: Track): boolean {
  return (t.duration ?? 0) >= 600
}

function score(t: Track): number {
  let s = Math.log10((t.play_count ?? 0) + 10)
  if (t.user?.is_verified) s += 1.5
  if (isNonOriginal(t)) s -= 4
  if (isLongForm(t)) s -= 2
  if (t.is_stream_gated) s -= 10
  if (t.is_streamable === false) s -= 10
  return s
}

export function rankTracks<T extends Track>(tracks: T[]): T[] {
  return [...tracks].sort((a, b) => score(b) - score(a))
}

// Strict "songs only" view — playable originals under 10 minutes
export function originalsOnly(tracks: Track[]): Track[] {
  return tracks.filter((t) => !isNonOriginal(t) && !isLongForm(t) && t.is_streamable !== false && !t.is_stream_gated)
}

// the API returns loosely-typed JSON — a malformed entry (missing user,
// non-string title) used to crash renders downstream; drop bad rows and
// dedupe ids so React keys stay unique
function cleanTracks(data: unknown): Track[] {
  if (!Array.isArray(data)) return []
  const seen = new Set<string>()
  return data.filter((t): t is Track => {
    const u = (t as Track)?.user
    if (
      !t || typeof (t as Track).id !== "string" || typeof (t as Track).title !== "string" ||
      !u || typeof u.name !== "string" || typeof u.id !== "string" ||
      seen.has((t as Track).id)
    )
      return false
    seen.add((t as Track).id)
    return true
  })
}

// same loose-JSON problem for users and playlists — an entry without a
// name/id crashes the card render just like a malformed track would
function cleanUsers(data: unknown): User[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (u): u is User => !!u && typeof (u as User).id === "string" && typeof (u as User).name === "string",
  )
}

function cleanPlaylists(data: unknown): Playlist[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (p): p is Playlist => !!p && typeof (p as Playlist).id === "string" && typeof (p as Playlist).playlist_name === "string",
  )
}

export const apiClient = {
  trendingTracks: (opts: { genre?: string; time?: TrendTime; limit?: number; offset?: number } = {}) =>
    api<Track[]>("/tracks/trending", {
      genre: opts.genre,
      time: opts.time ?? "week",
      limit: opts.limit ?? 20,
      offset: opts.offset,
    }).then(cleanTracks),

  searchTracks: (query: string, limit = 40, offset?: number) =>
    api<Track[]>("/tracks/search", { query, limit, offset }).then(cleanTracks).then(rankTracks),

  searchUsers: (query: string, limit = 12) => api<User[]>("/users/search", { query, limit }).then(cleanUsers),

  searchPlaylists: (query: string, limit = 12) =>
    api<Playlist[]>("/playlists/search", { query, limit }).then(cleanPlaylists),

  trendingPlaylists: (opts: { type?: "playlist" | "album"; time?: TrendTime; limit?: number } = {}) =>
    api<Playlist[]>("/playlists/trending", {
      type: opts.type,
      time: opts.time ?? "week",
      limit: opts.limit ?? 12,
    }).then(cleanPlaylists),

  playlist: (id: string) => api<Playlist>(`/playlists/${id}`),

  playlistTracks: (id: string, limit = 100) => api<Track[]>(`/playlists/${id}/tracks`, { limit }).then(cleanTracks),

  user: (id: string) => api<User>(`/users/${id}`),

  userTracks: (id: string, limit = 50) =>
    api<Track[]>(`/users/${id}/tracks`, { limit, sort_method: "plays", sort_direction: "desc" }).then(cleanTracks),

  track: (id: string) => api<Track>(`/tracks/${id}`),
}

// Audius genre enum (case-sensitive) — curated subset for browsing.
export const GENRES = [
  "Electronic", "Hip-Hop/Rap", "Pop", "Rock", "R&B/Soul", "Latin",
  "Techno", "House", "Trap", "Dubstep", "Drum & Bass", "Trance",
  "Lo-Fi", "Ambient", "Jazz", "Funk", "Acoustic", "Alternative",
  "Metal", "Punk", "Reggae", "Dancehall", "Hyperpop", "Vaporwave",
] as const
