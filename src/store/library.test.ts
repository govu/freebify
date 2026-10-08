// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Track } from "../api/types"
import { useLibrary } from "./library"

const mkTrack = (id: string, over: Partial<Track> = {}): Track => ({
  id,
  title: `Song ${id}`,
  duration: 200,
  play_count: 0,
  repost_count: 0,
  favorite_count: 0,
  artwork: null,
  user: {
    id: "u1",
    handle: "h",
    name: "Artist",
    is_verified: false,
    follower_count: 0,
    track_count: 0,
    profile_picture: null,
    cover_photo: null,
  },
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  useLibrary.setState({ liked: {}, likedOrder: [], recents: [], playlists: [] })
})

describe("toggleLike", () => {
  it("adds then removes a track", () => {
    const t = mkTrack("t1")
    useLibrary.getState().toggleLike(t)
    expect(useLibrary.getState().liked.t1).toEqual(t)
    expect(useLibrary.getState().isLiked("t1")).toBe(true)
    useLibrary.getState().toggleLike(t)
    expect(useLibrary.getState().liked.t1).toBeUndefined()
    expect(useLibrary.getState().isLiked("t1")).toBe(false)
    expect(useLibrary.getState().likedOrder).toEqual([])
  })

  it("keeps likedOrder deduped and newest-first", () => {
    useLibrary.getState().toggleLike(mkTrack("t1"))
    useLibrary.getState().toggleLike(mkTrack("t2"))
    useLibrary.getState().toggleLike(mkTrack("t3"))
    expect(useLibrary.getState().likedOrder).toEqual(["t3", "t2", "t1"])
    // re-liking after a remove puts it back on top, never duplicated
    useLibrary.getState().toggleLike(mkTrack("t1"))
    useLibrary.getState().toggleLike(mkTrack("t1"))
    expect(useLibrary.getState().likedOrder).toEqual(["t1", "t3", "t2"])
    expect(useLibrary.getState().likedOrder.length).toBe(3)
  })
})

describe("playlists", () => {
  it("auto-names 'My Playlist #N' with the lowest free N", () => {
    const first = useLibrary.getState().createPlaylist()
    const second = useLibrary.getState().createPlaylist()
    const names = () => useLibrary.getState().playlists.map((p) => p.name)
    expect(names()).toEqual(["My Playlist #2", "My Playlist #1"])
    useLibrary.getState().deletePlaylist(first)
    useLibrary.getState().createPlaylist()
    // #1 was freed by the delete — reused instead of climbing to #3
    expect(names()).toEqual(["My Playlist #1", "My Playlist #2"])
    expect(useLibrary.getState().playlists.find((p) => p.id === second)?.name).toBe("My Playlist #2")
  })

  it("uses an explicit name when given one", () => {
    useLibrary.getState().createPlaylist("  Gym Mix  ")
    expect(useLibrary.getState().playlists[0].name).toBe("Gym Mix")
  })

  it("addToPlaylist dedupes by track.id", () => {
    const id = useLibrary.getState().createPlaylist("P")
    useLibrary.getState().addToPlaylist(id, mkTrack("t1"))
    useLibrary.getState().addToPlaylist(id, mkTrack("t1", { title: "Same id, new title" }))
    useLibrary.getState().addToPlaylist(id, mkTrack("t2"))
    const tracks = useLibrary.getState().playlists[0].tracks
    expect(tracks.map((t) => t.id)).toEqual(["t1", "t2"])
    expect(tracks[0].title).toBe("Song t1")
  })

  it("addTracksToPlaylist bulk-dedupes against existing tracks", () => {
    const id = useLibrary.getState().createPlaylist("P")
    useLibrary.getState().addToPlaylist(id, mkTrack("t1"))
    useLibrary.getState().addTracksToPlaylist(id, [mkTrack("t1"), mkTrack("t2"), mkTrack("t3")])
    const tracks = useLibrary.getState().playlists[0].tracks
    expect(tracks.map((t) => t.id)).toEqual(["t1", "t2", "t3"])
  })

  it("moveInPlaylist reorders and ignores out-of-bounds moves", () => {
    const id = useLibrary.getState().createPlaylist("P")
    useLibrary.getState().addTracksToPlaylist(id, [mkTrack("a"), mkTrack("b"), mkTrack("c")])
    useLibrary.getState().moveInPlaylist(id, 0, 2)
    expect(useLibrary.getState().playlists[0].tracks.map((t) => t.id)).toEqual(["b", "c", "a"])
    useLibrary.getState().moveInPlaylist(id, 0, 9)
    expect(useLibrary.getState().playlists[0].tracks.map((t) => t.id)).toEqual(["b", "c", "a"])
  })

  it("removeFromPlaylist removes the track", () => {
    const id = useLibrary.getState().createPlaylist("P")
    useLibrary.getState().addTracksToPlaylist(id, [mkTrack("a"), mkTrack("b")])
    useLibrary.getState().removeFromPlaylist(id, "a")
    expect(useLibrary.getState().playlists[0].tracks.map((t) => t.id)).toEqual(["b"])
  })

  it("renamePlaylist renames, deletePlaylist deletes", () => {
    const id = useLibrary.getState().createPlaylist()
    useLibrary.getState().renamePlaylist(id, "Renamed")
    expect(useLibrary.getState().playlists[0].name).toBe("Renamed")
    useLibrary.getState().deletePlaylist(id)
    expect(useLibrary.getState().playlists).toEqual([])
  })
})

describe("addRecent", () => {
  it("dedupes by id and keeps newest first", () => {
    useLibrary.getState().addRecent(mkTrack("a"))
    useLibrary.getState().addRecent(mkTrack("b"))
    useLibrary.getState().addRecent(mkTrack("a"))
    expect(useLibrary.getState().recents.map((t) => t.id)).toEqual(["a", "b"])
  })
})

describe("hydration", () => {
  it("drops corrupt entries and cleans likedOrder on rehydrate", async () => {
    localStorage.setItem(
      "freebify-library",
      JSON.stringify({
        version: 1,
        state: {
          liked: { t1: mkTrack("t1"), bad: { nope: 1 } },
          likedOrder: ["t1", "bad", "t1"],
          recents: [mkTrack("r1"), { invalid: true }],
          playlists: [{ id: "p1", tracks: [mkTrack("x1")] }],
        },
      }),
    )
    vi.resetModules()
    const mod = await import("./library")
    const s = mod.useLibrary.getState()
    expect(Object.keys(s.liked)).toEqual(["t1"])
    expect(s.likedOrder).toEqual(["t1"])
    expect(s.recents.map((t) => t.id)).toEqual(["r1"])
    expect(s.playlists).toHaveLength(1)
    expect(s.playlists[0].id).toBe("p1")
    expect(s.playlists[0].tracks.map((t) => t.id)).toEqual(["x1"])
  })
})
