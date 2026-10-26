import { create } from "zustand"
import type { Track } from "../api/types"
import { yt } from "../api/youtube"
import { useLibrary } from "./library"

// Playlist import creates every row immediately from the Spotify/CSV
// metadata and resolves them to real YouTube tracks behind it: one lean
// search per track in the main process, six at a time, in list order.
// A 1000 song import is usable in seconds instead of a modal counting up,
// and a click always jumps the queue (resolveNow), so nothing the user
// actually wants ever waits for the background pass.

const CHUNK = 20
const MAX_TRIES = 2
// a quiet gap between chunks keeps a long import from tripping Google's
// automated-query check; a chunk that matched NOTHING backs off harder
const GAP = 400
const QUIET_GAP = 2000
const MATCH_LOG = "[match]"

interface Job {
  playlistId: string
  track: Track
  tries: number
}

const queued = new Map<string, Job>()
const order: string[] = []
const inflight = new Map<string, Promise<Track | null>>()
let pumping = false

export const useResolve = create<{ lists: Record<string, { done: number; total: number }> }>(
  () => ({ lists: {} }),
)

function settle(playlistId: string, n: number) {
  if (n <= 0) return
  useResolve.setState((s) => {
    const cur = s.lists[playlistId]
    if (!cur) return s
    const done = Math.min(cur.total, cur.done + n)
    const lists = { ...s.lists }
    if (done >= cur.total) delete lists[playlistId]
    else lists[playlistId] = { ...cur, done }
    return { lists }
  })
}

function query(track: Track) {
  return { title: track.title, artist: track.user?.name ?? "", duration: track.duration }
}

// one placeholder → its best YouTube match. Shared by the background pass
// and by clicks, so the same row is never searched twice at once.
function resolveOne(track: Track): Promise<Track | null> {
  const running = inflight.get(track.id)
  if (running) return running
  const job = yt
    .matchSongs([query(track)])
    .then((hits) => hits[0] ?? null)
    .catch(() => null)
  inflight.set(track.id, job)
  void job.finally(() => inflight.delete(track.id))
  return job
}

function dropQueued(id: string) {
  if (!queued.delete(id)) return
  const at = order.indexOf(id)
  if (at >= 0) order.splice(at, 1)
}

// a row the user clicked: resolve right now, out of band, and drop it from
// the background queue so the pass doesn't pay for it again
export async function resolveNow(track: Track): Promise<Track | null> {
  const hit = await resolveOne(track)
  dropQueued(track.id)
  if (hit) useLibrary.getState().resolveTracks(new Map([[track.id, hit]]))
  return hit
}

export function enqueuePending(playlistId: string, tracks: Track[]) {
  let added = 0
  for (const track of tracks) {
    if (!track.pending || !track.id) continue
    if (queued.has(track.id) || inflight.has(track.id)) continue
    queued.set(track.id, { playlistId, track, tries: 0 })
    order.push(track.id)
    added++
  }
  if (!added) return
  useResolve.setState((s) => {
    const cur = s.lists[playlistId] ?? { done: 0, total: 0 }
    return { lists: { ...s.lists, [playlistId]: { done: cur.done, total: cur.total + added } } }
  })
  void pump()
}

// rows with no match at all are dropped - the old importer never added them
// either. Retries keep a rate-limit blip from deleting real songs.
async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (order.length) {
      const ids = order.splice(0, CHUNK)
      const jobs = ids.map((id) => queued.get(id)).filter((j): j is Job => Boolean(j))
      if (!jobs.length) continue
      const started = Date.now()
      const hits = await yt
        .matchSongs(jobs.map((j) => query(j.track)))
        .catch(() => jobs.map(() => null))
      const replace = new Map<string, Track>()
      const dead: string[] = []
      const retry: string[] = []
      const settled = new Map<string, number>()
      // a chunk where nothing at all matched is a session/network problem,
      // not 20 unknown songs - give it another pass before deleting rows
      const allMissed = jobs.every((_, i) => !hits[i])
      jobs.forEach((job, i) => {
        const hit = hits[i] ?? null
        if (hit) {
          replace.set(job.track.id, hit)
          queued.delete(job.track.id)
          settled.set(job.playlistId, (settled.get(job.playlistId) ?? 0) + 1)
        } else if (allMissed && jobs.length > 1 && job.tries < MAX_TRIES) {
          job.tries++
          retry.push(job.track.id)
        } else {
          queued.delete(job.track.id)
          dead.push(job.track.id)
          settled.set(job.playlistId, (settled.get(job.playlistId) ?? 0) + 1)
        }
      })
      if (replace.size) useLibrary.getState().resolveTracks(replace)
      if (dead.length) useLibrary.getState().dropTracks(dead)
      order.push(...retry)
      for (const [playlistId, n] of settled) settle(playlistId, n)
      if (import.meta.env.DEV)
        console.debug(MATCH_LOG, `${jobs.length} → ${replace.size} in ${Date.now() - started}ms`)
      await new Promise((r) => setTimeout(r, allMissed ? QUIET_GAP : GAP))
    }
  } finally {
    pumping = false
  }
}
