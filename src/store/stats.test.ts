// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Track } from "../api/types"
import { dayKey, monthKey, useStats } from "./stats"

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
  // drain the module-level pending buffer before zeroing state — buffered
  // ms from a previous test must not leak into the next one
  useStats.getState().flush()
  useStats.setState({ tracks: {}, artists: {}, days: {}, months: {}, totalMs: 0, totalPlays: 0 })
})

describe("recordMs + flush", () => {
  it("buffers ms until flush lands it in every bucket", () => {
    const t = mkTrack("t1")
    useStats.getState().recordMs(t, 5000)
    // nothing is in state yet — recordMs only buffers
    expect(useStats.getState().totalMs).toBe(0)
    useStats.getState().recordMs(t, 3000)
    useStats.getState().flush()
    const s = useStats.getState()
    expect(s.totalMs).toBe(8000)
    expect(s.days[dayKey()]).toBe(8000)
    expect(s.months[monthKey()].ms).toBe(8000)
    expect(s.months[monthKey()].tracks.t1.ms).toBe(8000)
    expect(s.months[monthKey()].artists.Artist.ms).toBe(8000)
    expect(s.tracks.t1.ms).toBe(8000)
    expect(s.artists.Artist.ms).toBe(8000)
  })

  it("ignores non-positive and non-finite ms", () => {
    const t = mkTrack("t1")
    useStats.getState().recordMs(t, 0)
    useStats.getState().recordMs(t, -5)
    useStats.getState().recordMs(t, Number.NaN)
    useStats.getState().flush()
    const s = useStats.getState()
    expect(s.totalMs).toBe(0)
    expect(Object.keys(s.tracks)).toEqual([])
  })
})

describe("recordPlay", () => {
  it("increments play counters everywhere", () => {
    const t = mkTrack("t1")
    useStats.getState().recordPlay(t)
    useStats.getState().recordPlay(t)
    const s = useStats.getState()
    const mk = monthKey()
    expect(s.totalPlays).toBe(2)
    expect(s.months[mk].plays).toBe(2)
    expect(s.months[mk].tracks.t1.plays).toBe(2)
    expect(s.months[mk].artists.Artist.plays).toBe(2)
    expect(s.tracks.t1.plays).toBe(2)
    expect(s.artists.Artist.plays).toBe(2)
  })

  it("caps the month track bucket at 60 entries", () => {
    const mk = monthKey()
    for (let i = 0; i < 61; i++) {
      useStats.getState().recordPlay(mkTrack(`cap-${i}`))
    }
    const m = useStats.getState().months[mk]
    expect(m.plays).toBe(61)
    expect(Object.keys(m.tracks).length).toBeLessThanOrEqual(60)
  })
})

describe("hydration", () => {
  it("keeps valid persisted entries and drops corrupt ones", async () => {
    localStorage.setItem(
      "freebify-stats",
      JSON.stringify({
        version: 2,
        state: {
          tracks: {
            t1: { track: mkTrack("t1"), plays: 3, ms: 9000 },
            bad: { track: { x: 1 } },
          },
          months: {
            "2026-09": {
              ms: 600000,
              plays: 9,
              tracks: { t1: { track: mkTrack("t1"), plays: 3, ms: 9000 } },
              artists: { Artist: { name: "Artist", art: null, plays: 3, ms: 9000 } },
            },
          },
          totalMs: 600000,
          totalPlays: 9,
        },
      }),
    )
    vi.resetModules()
    const mod = await import("./stats")
    const s = mod.useStats.getState()
    expect(s.tracks.t1.plays).toBe(3)
    expect(s.tracks.t1.ms).toBe(9000)
    expect(s.tracks.bad).toBeUndefined()
    expect(s.months["2026-09"].ms).toBe(600000)
    expect(s.months["2026-09"].plays).toBe(9)
    expect(s.months["2026-09"].tracks.t1.plays).toBe(3)
    expect(s.months["2026-09"].artists.Artist.plays).toBe(3)
    expect(s.totalMs).toBe(600000)
    expect(s.totalPlays).toBe(9)
  })

  it("keeps zeroed state on a garbage persisted blob", async () => {
    localStorage.setItem("freebify-stats", JSON.stringify({ nope: true }))
    vi.resetModules()
    const mod = await import("./stats")
    const s = mod.useStats.getState()
    expect(s.tracks).toEqual({})
    expect(s.artists).toEqual({})
    expect(s.days).toEqual({})
    expect(s.months).toEqual({})
    expect(s.totalMs).toBe(0)
    expect(s.totalPlays).toBe(0)
  })
})
