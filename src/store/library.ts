import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { Track } from "../api/types"
import { isObj, isValidTrack, repairTrack, safeStorage, sanitizeTrackList, slimTrack } from "./storage"

export interface LocalPlaylist {
  id: string
  name: string
  tracks: Track[]
  createdAt: number
}

interface LibraryState {
  liked: Record<string, Track>
  likedOrder: string[]
  recents: Track[]
  playlists: LocalPlaylist[]
  toggleLike: (t: Track) => void
  isLiked: (id: string) => boolean
  addRecent: (t: Track) => void
  likedTracks: () => Track[]
  createPlaylist: (name?: string) => string
  renamePlaylist: (id: string, name: string) => void
  deletePlaylist: (id: string) => void
  addToPlaylist: (id: string, track: Track) => void
  addTracksToPlaylist: (id: string, tracks: Track[]) => void
  removeFromPlaylist: (id: string, trackId: string) => void
  moveInPlaylist: (id: string, from: number, to: number) => void
}

const newId = () =>
  `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// smallest unused "My Playlist #N" — avoids duplicate names after deletions
function nextPlaylistName(playlists: LocalPlaylist[]): string {
  const taken = new Set(
    playlists
      .map((p) => /^My Playlist #(\d+)$/.exec(p.name)?.[1])
      .filter((n): n is string => Boolean(n)),
  )
  let n = 1
  while (taken.has(String(n))) n++
  return `My Playlist #${n}`
}

// shared by migrate + merge — corrupted blobs could carry duplicate ids,
// and likedTracks() maps this straight into React keys
function cleanOrder(v: unknown, liked: Record<string, Track>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  if (!Array.isArray(v)) return Object.keys(liked)
  for (const id of v) {
    if (typeof id === "string" && Boolean(liked[id]) && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      liked: {},
      likedOrder: [],
      recents: [],
      playlists: [],

      toggleLike: (t) =>
        set((s) => {
          if (s.liked[t.id]) {
            const liked = { ...s.liked }
            delete liked[t.id]
            return { liked, likedOrder: s.likedOrder.filter((id) => id !== t.id) }
          }
          return {
            liked: { ...s.liked, [t.id]: t },
            likedOrder: [t.id, ...s.likedOrder],
          }
        }),

      isLiked: (id) => Boolean(get().liked[id]),

      addRecent: (t) =>
        set((s) => ({
          recents: [t, ...s.recents.filter((r) => r.id !== t.id)].slice(0, 40),
        })),

      likedTracks: () => get().likedOrder.map((id) => get().liked[id]).filter(Boolean),

      createPlaylist: (name) => {
        const id = newId()
        set((s) => ({
          playlists: [
            {
              id,
              // lowest free N — `length+1` reuses a number after deleting
              // an earlier playlist (two "My Playlist #3" would coexist)
              name: name?.trim() || nextPlaylistName(s.playlists),
              tracks: [],
              createdAt: Date.now(),
            },
            ...s.playlists,
          ],
        }))
        return id
      },

      renamePlaylist: (id, name) =>
        set((s) => ({
          playlists: s.playlists.map((p) =>
            p.id === id ? { ...p, name: name.trim() || p.name } : p
          ),
        })),

      deletePlaylist: (id) =>
        set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) })),

      addToPlaylist: (id, track) =>
        set((s) => ({
          playlists: s.playlists.map((p) =>
            p.id === id && !p.tracks.some((t) => t.id === track.id)
              ? { ...p, tracks: [...p.tracks, track] }
              : p
          ),
        })),

      // bulk add in ONE set() — the per-track loop serialized the whole
      // store to localStorage on every call (O(n²) freeze on a big queue)
      addTracksToPlaylist: (id, tracks) =>
        set((s) => ({
          playlists: s.playlists.map((p) => {
            if (p.id !== id) return p
            const have = new Set(p.tracks.map((t) => t.id))
            const add = tracks.filter((t) => !have.has(t.id))
            return add.length ? { ...p, tracks: [...p.tracks, ...add] } : p
          }),
        })),

      removeFromPlaylist: (id, trackId) =>
        set((s) => ({
          playlists: s.playlists.map((p) =>
            p.id === id ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p
          ),
        })),

      moveInPlaylist: (id, from, to) =>
        set((s) => ({
          playlists: s.playlists.map((p) => {
            if (p.id !== id || from === to || from < 0 || to < 0 || from >= p.tracks.length || to >= p.tracks.length)
              return p
            const tracks = [...p.tracks]
            const [item] = tracks.splice(from, 1)
            tracks.splice(to, 0, item)
            return { ...p, tracks }
          }),
        })),
    }),
    {
      name: "freebify-library",
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      // write slimmed snapshots — strips unbounded fields (descriptions,
      // bios, cover photos) so thousands of tracks don't eat the quota
      partialize: (s) => ({
        liked: Object.fromEntries(Object.entries(s.liked).map(([k, t]) => [k, slimTrack(t)])),
        likedOrder: s.likedOrder,
        recents: s.recents.map(slimTrack),
        playlists: s.playlists.map((p) => ({ ...p, tracks: p.tracks.map(slimTrack) })),
      }),
      // v0 → v1: rebuild order if missing, drop invalid tracks
      migrate: (persisted) => {
        const s = isObj(persisted) ? persisted : {}
        const liked = isObj(s.liked)
          ? Object.fromEntries(
              Object.entries(s.liked)
                .filter(([, v]) => isValidTrack(v))
                .map(([k, t]) => [k, slimTrack(repairTrack(t as Track))]),
            )
          : {}
        return {
          liked,
          likedOrder: cleanOrder(s.likedOrder, liked),
          recents: sanitizeTrackList(s.recents, 40),
          playlists: (Array.isArray(s.playlists) ? s.playlists : [])
            .filter((p) => isObj(p) && typeof p.id === "string")
            .map((p) => ({
              id: p.id as string,
              name: typeof p.name === "string" ? p.name : "Playlist",
              createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
              tracks: sanitizeTrackList(p.tracks, 2000),
            })),
        }
      },
      // every hydration (any version) — validate the shape, never trust it
      merge: (persisted, current) => {
        if (!isObj(persisted)) return current
        const liked = isObj(persisted.liked)
          ? Object.fromEntries(
              // repairTrack: legacy yt-* ids predate the streamId field —
              // without the backfill they validate fine but can never play
              Object.entries(persisted.liked)
                .filter(([, v]) => isValidTrack(v))
                .map(([k, t]) => [k, repairTrack(t as Track)]),
            )
          : current.liked
        return {
          ...current,
          liked,
          likedOrder: cleanOrder(persisted.likedOrder, liked),
          recents: sanitizeTrackList(persisted.recents, 40),
          playlists: (Array.isArray(persisted.playlists) ? persisted.playlists : [])
            .filter((p) => isObj(p) && typeof p.id === "string")
            .map((p) => ({
              id: p.id as string,
              name: typeof p.name === "string" ? p.name : "Playlist",
              createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
              tracks: sanitizeTrackList(p.tracks, 2000),
            })),
        }
      },
      onRehydrateStorage: () => (_s, err) => {
        if (err) {
          console.error("[freebify] corrupt library state, resetting", err)
          try {
            localStorage.removeItem("freebify-library")
          } catch {
            /* ignore */
          }
        }
      },
    },
  ),
)
