// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import type { Track } from "../api/types"
import { isValidTrack, repairTrack, sanitizeTrackList, slimTrack } from "./storage"

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

describe("isValidTrack", () => {
  it("rejects non-objects", () => {
    for (const v of [null, undefined, 5, "x", true, []]) {
      expect(isValidTrack(v)).toBe(false)
    }
  })

  it("rejects tracks missing title", () => {
    const t = mkTrack("a") as unknown as Record<string, unknown>
    delete t.title
    expect(isValidTrack(t)).toBe(false)
  })

  it("rejects tracks missing a valid user", () => {
    const noUser = mkTrack("a") as unknown as Record<string, unknown>
    delete noUser.user
    expect(isValidTrack(noUser)).toBe(false)
    expect(isValidTrack({ ...mkTrack("a"), user: { id: "u1" } })).toBe(false)
    expect(isValidTrack({ ...mkTrack("a"), user: { name: "A" } })).toBe(false)
  })

  it("rejects bad durations", () => {
    expect(isValidTrack({ ...mkTrack("a"), duration: Number.NaN })).toBe(false)
    expect(isValidTrack({ ...mkTrack("a"), duration: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isValidTrack({ ...mkTrack("a"), duration: "200" })).toBe(false)
  })

  it("accepts a valid track", () => {
    expect(isValidTrack(mkTrack("a"))).toBe(true)
    // duration is optional in legacy persisted blobs
    expect(isValidTrack({ ...mkTrack("a"), duration: null })).toBe(true)
  })
})

describe("repairTrack", () => {
  it("backfills streamId and source for yt-* ids", () => {
    const out = repairTrack(mkTrack("yt-abc123"))
    expect(out.streamId).toBe("abc123")
    expect(out.source).toBe("yt")
  })

  it("strips signed params from ytimg artwork URLs", () => {
    const out = repairTrack(
      mkTrack("yt-abc123", {
        artwork: { "480x480": "https://i.ytimg.com/vi/x/hqdefault.jpg?sqp=123&rs=4" },
      }),
    )
    expect(out.artwork?.["480x480"]).toBe("https://i.ytimg.com/vi/x/hqdefault.jpg")
  })

  it("adds the i.ytimg fallback for yt tracks without one", () => {
    const out = repairTrack(
      mkTrack("yt-abc123", {
        artwork: { "480x480": "https://cdn.example.com/a.jpg" },
      }),
    )
    expect(out.artwork?.fallback).toBe("https://i.ytimg.com/vi/abc123/hqdefault.jpg")
  })

  it("keeps an existing fallback", () => {
    const out = repairTrack(
      mkTrack("yt-abc123", {
        artwork: { fallback: "https://i.ytimg.com/vi/zzz/hqdefault.jpg" },
      }),
    )
    expect(out.artwork?.fallback).toBe("https://i.ytimg.com/vi/zzz/hqdefault.jpg")
  })

  it("leaves non-yt tracks alone", () => {
    const t = mkTrack("aud-1")
    const out = repairTrack(t)
    expect(out.streamId).toBeUndefined()
    expect(out.source).toBeUndefined()
    expect(out.artwork).toBeNull()
  })
})

describe("slimTrack", () => {
  it("strips heavy fields", () => {
    const t = mkTrack("a", {
      description: "long description",
      user: { ...mkTrack("a").user, bio: "long bio", cover_photo: { "640x": "x" } },
    })
    const out = slimTrack(t)
    expect(out.description).toBeUndefined()
    expect(out.user.bio).toBeUndefined()
    expect(out.user.cover_photo).toBeNull()
    // the rest is preserved
    expect(out.id).toBe("a")
    expect(out.title).toBe("Song a")
    expect(out.user.name).toBe("Artist")
  })
})

describe("sanitizeTrackList", () => {
  it("filters invalid entries", () => {
    const out = sanitizeTrackList([mkTrack("a"), { bad: 1 }, mkTrack("b"), null], 10)
    expect(out.map((t) => t.id)).toEqual(["a", "b"])
  })

  it("caps the list at the cap argument", () => {
    const out = sanitizeTrackList([mkTrack("a"), mkTrack("b"), mkTrack("c")], 2)
    expect(out).toHaveLength(2)
    expect(out.map((t) => t.id)).toEqual(["a", "b"])
  })

  it("returns an empty array for non-arrays", () => {
    for (const v of [null, undefined, 5, "x", {}]) {
      expect(sanitizeTrackList(v, 10)).toEqual([])
    }
  })
})
