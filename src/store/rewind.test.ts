// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"
import type { Track } from "../api/types"
import { availableRewind, buildRewind, currentRewind, latestRewind } from "./rewind"
import { monthKey, useStats } from "./stats"

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

const mkTrackAgg = (id: string, plays: number, ms: number) => ({
  track: mkTrack(id),
  plays,
  ms,
})

const mkArtistAgg = (name: string, plays: number, ms: number) => ({
  name,
  art: null,
  plays,
  ms,
})

// a month comfortably above the closed-edition thresholds
const mkMonth = (over: Record<string, unknown> = {}) => ({
  ms: 600000,
  plays: 9,
  tracks: {
    t1: mkTrackAgg("t1", 5, 300000),
    t2: mkTrackAgg("t2", 4, 200000),
  },
  artists: {
    Artist: mkArtistAgg("Artist", 9, 500000),
  },
  ...over,
})

const seedMonths = (months: Record<string, ReturnType<typeof mkMonth>>) => useStats.setState({ months })

beforeEach(() => {
  localStorage.clear()
  useStats.getState().flush()
  useStats.setState({ tracks: {}, artists: {}, days: {}, months: {}, totalMs: 0, totalPlays: 0 })
})

describe("buildRewind", () => {
  it("builds a sorted rewind for a qualifying month", () => {
    // six tracks — only the top 5 by listening time make the card
    const tracks: Record<string, ReturnType<typeof mkTrackAgg>> = {}
    for (let i = 1; i <= 6; i++) tracks[`t${i}`] = mkTrackAgg(`t${i}`, i, i * 100000)
    seedMonths({ "2020-09": mkMonth({ tracks }) })
    const r = buildRewind("2020-09")
    expect(r).not.toBeNull()
    expect(r?.key).toBe("2020-09")
    expect(r?.partial).toBe(false)
    expect(r?.ms).toBe(600000)
    expect(r?.plays).toBe(9)
    expect(r?.tracks).toHaveLength(5)
    expect(r?.tracks.map((t) => t.track.id)).toEqual(["t6", "t5", "t4", "t3", "t2"])
    expect(r?.artists.map((a) => a.name)).toEqual(["Artist"])
    expect(r?.trackCount).toBe(6)
    expect(r?.artistCount).toBe(1)
    // localized labels derive from the key, not the wall clock
    const d = new Date(2020, 8, 1)
    expect(r?.label).toBe(d.toLocaleDateString(undefined, { month: "long" }))
    expect(r?.full).toBe(d.toLocaleDateString(undefined, { month: "long", year: "numeric" }))
  })

  it("returns null below the closed-edition thresholds", () => {
    seedMonths({
      "2020-08": mkMonth({ ms: 599999 }), // enough plays, not enough time
      "2020-09": mkMonth({ plays: 4 }), // enough time, not enough plays
    })
    expect(buildRewind("2020-08")).toBeNull()
    expect(buildRewind("2020-09")).toBeNull()
  })

  it("partial edition only needs 3 plays", () => {
    seedMonths({
      "2020-09": mkMonth({ ms: 0, plays: 3 }),
      "2020-10": mkMonth({ ms: 0, plays: 2 }),
    })
    const ok = buildRewind("2020-09", true)
    expect(ok).not.toBeNull()
    expect(ok?.partial).toBe(true)
    expect(buildRewind("2020-10", true)).toBeNull()
  })

  it("returns null for an unknown or empty month", () => {
    expect(buildRewind("1999-01")).toBeNull()
    seedMonths({ "2020-09": mkMonth({ tracks: {} }) })
    expect(buildRewind("2020-09")).toBeNull()
  })
})

describe("latestRewind", () => {
  it("picks the newest month strictly before the current one", () => {
    seedMonths({
      "2020-01": mkMonth(),
      "2020-03": mkMonth(),
      // the current month is never "closed" and a future key is ignored
      [monthKey()]: mkMonth(),
      "2999-01": mkMonth(),
    })
    const r = latestRewind()
    expect(r?.key).toBe("2020-03")
    expect(r?.partial).toBe(false)
  })

  it("returns null when no closed month qualifies", () => {
    seedMonths({ "2020-03": mkMonth({ plays: 2 }) })
    expect(latestRewind()).toBeNull()
  })
})

describe("currentRewind", () => {
  it("returns the in-progress month as a partial edition", () => {
    seedMonths({ [monthKey()]: mkMonth({ ms: 0, plays: 3 }) })
    const r = currentRewind()
    expect(r?.key).toBe(monthKey())
    expect(r?.partial).toBe(true)
  })

  it("returns null while the current month is still too quiet", () => {
    seedMonths({ [monthKey()]: mkMonth({ ms: 0, plays: 1 }) })
    expect(currentRewind()).toBeNull()
  })
})

describe("availableRewind", () => {
  it("prefers the latest closed month over the current partial", () => {
    seedMonths({
      "2020-05": mkMonth(),
      [monthKey()]: mkMonth({ ms: 0, plays: 3 }),
    })
    const r = availableRewind()
    expect(r?.key).toBe("2020-05")
    expect(r?.partial).toBe(false)
  })

  it("falls back to the current partial when nothing closed qualifies", () => {
    seedMonths({ [monthKey()]: mkMonth({ ms: 0, plays: 3 }) })
    const r = availableRewind()
    expect(r?.key).toBe(monthKey())
    expect(r?.partial).toBe(true)
  })

  it("falls back when the only closed month is below threshold", () => {
    seedMonths({
      "2020-05": mkMonth({ ms: 0, plays: 4 }),
      [monthKey()]: mkMonth({ ms: 0, plays: 3 }),
    })
    const r = availableRewind()
    expect(r?.key).toBe(monthKey())
    expect(r?.partial).toBe(true)
  })
})
