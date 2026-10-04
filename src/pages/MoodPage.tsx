import { useEffect, useState } from "react"
import { useLocation, useParams } from "react-router-dom"
import { yt } from "../api/youtube"
import type { Playlist, Track } from "../api/types"
import { PlaylistCard, Section, TrackCard } from "../components/Cards"
import { CardsRowSkeleton } from "../components/Skeletons"
import { moodNames } from "./Search"

// YouTube Music mood/genre category page — the browse token lives in the
// URL; display name arrives via router state or the cached lookup.
export function MoodPage() {
  const { params } = useParams<{ params: string }>()
  const location = useLocation()
  // React Router already decodes params — a second decodeURIComponent
  // would mangle (or URIError on) tokens containing %
  const [name, setName] = useState(
    (location.state as { name?: string } | null)?.name ??
      (params ? moodNames.get(params) : undefined) ??
      "Mixes"
  )
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [run, setRun] = useState(0)

  useEffect(() => {
    if (!params) return
    let live = true
    setLoading(true)
    setFailed(false)
    // mood→mood nav reuses the route — reset so the previous category's
    // title and shelves don't linger under the new skeletons
    setPlaylists([])
    setTracks([])
    setName(
      (location.state as { name?: string } | null)?.name ?? moodNames.get(params) ?? "Mixes",
    )
    void yt
      .mood(params)
      .then((r) => {
        if (!live) return
        if (!r || (!r.playlists.length && !r.tracks.length)) {
          setFailed(true)
        } else {
          if (r.name) setName(r.name)
          setPlaylists(r.playlists)
          setTracks(r.tracks)
        }
        setLoading(false)
      })
      .catch(() => {
        if (live) {
          setFailed(true)
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [params, run])

  return (
    <div className="-mt-12 pb-10">
      <div className="relative mb-8 px-6 pt-16">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 100% at 20% 0%, rgb(255 255 255 / 0.07), transparent 60%)",
          }}
        />
        <h1 className="relative text-3xl font-black tracking-tight sm:text-4xl">{name}</h1>
      </div>

      {failed && (
        <div className="mx-6 mb-6 rounded-xl border border-line bg-card px-5 py-4">
          <p className="text-sm font-semibold">Couldn't load this mood</p>
          <button
            onClick={() => setRun((r) => r + 1)}
            className="mt-3 rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-black transition hover:scale-105"
          >
            Retry
          </button>
        </div>
      )}

      {loading && (
        <section className="mb-10">
          <div className="mb-4 h-6 w-40 rounded bg-hover/60 px-6" />
          <CardsRowSkeleton />
        </section>
      )}

      {playlists.length > 0 && (
        <Section title={`${name} playlists`}>
          {playlists.map((p) => (
            <PlaylistCard key={p.id} p={p} />
          ))}
        </Section>
      )}

      {tracks.length > 0 && (
        <Section title="Top tracks">
          {tracks.map((t) => (
            <TrackCard key={t.id} t={t} context={tracks} />
          ))}
        </Section>
      )}
    </div>
  )
}
