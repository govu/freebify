import { AnimatePresence, motion } from "motion/react"
import { Music2, Play, Search as SearchIcon, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { apiClient, GENRES, isNonOriginalQuery, originalsOnly } from "../api/audius"
import { prefetchStream, yt, ytAvailable } from "../api/youtube"
import type { Playlist, Track, User } from "../api/types"
import { ArtworkImg } from "../components/ArtworkImg"
import { ArtistCard, PlaylistCard, Section } from "../components/Cards"
import { RowsSkeleton } from "../components/Skeletons"
import { TrackTable } from "../components/TrackTable"
import { usePlayer } from "../store/player"

// shared params→name lookup — the MoodPage route only carries the browse
// token in the URL; this map resolves a human title when navigated deep
export const moodNames = new Map<string, string>()

export function SearchPage() {
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [tracks, setTracks] = useState<Track[]>([])
  const [artists, setArtists] = useState<User[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [suggs, setSuggs] = useState<string[]>([])
  const [moods, setMoods] = useState<{ name: string; params: string }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const playTrack = usePlayer((s) => s.playTrack)
  const navigate = useNavigate()

  // browse categories for the empty state — YTM mood/genre taxonomy,
  // cached in-module so the MoodPage route can resolve name by token
  useEffect(() => {
    let live = true
    void yt.moods().then((m) => {
      if (!live) return
      setMoods(m)
      for (const x of m) moodNames.set(x.params, x.name)
    })
    return () => {
      live = false
    }
  }, [])

  // autocomplete — lighter debounce than the search itself; hides once the
  // query settles (suggestions for what's already searched are noise)
  useEffect(() => {
    const q = query.trim()
    if (!q || q === debounced) {
      setSuggs([])
      return
    }
    let live = true
    const id = setTimeout(() => {
      void yt.suggest(q).then((s) => {
        if (live) setSuggs(s.filter((x) => x.toLowerCase() !== q.toLowerCase()))
      })
    }, 180)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [query, debounced])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    if (!debounced) {
      setTracks([]); setArtists([]); setPlaylists([])
      setFailed(false)
      return
    }
    let live = true
    setLoading(true)
    setFailed(false)
    void (async () => {
      // YouTube Music first (original studio versions); Audius as fallback
      try {
        if (await ytAvailable()) {
          const res = await yt.search(debounced)
          if (!live) return
          if (res.tracks.length || res.artists.length || res.playlists.length) {
            setTracks(res.tracks)
            setArtists(res.artists)
            setPlaylists(res.playlists)
            setLoading(false)
            // warm the stream cache for top results → click plays instantly
            res.tracks.slice(0, 6).forEach((t) => {
              if (t.streamId) void yt.prefetch(t.streamId).catch(() => null)
            })
            return
          }
        }
      } catch {
        /* fall through to Audius */
      }
      const [t, u, p] = await Promise.allSettled([
        apiClient.searchTracks(debounced, 20),
        apiClient.searchUsers(debounced, 8),
        apiClient.searchPlaylists(debounced, 8),
      ])
      if (!live) return
      // if the user searched FOR a remix/edit/nightcore, don't hide the
      // very thing they asked for
      const filter = isNonOriginalQuery(debounced) ? (v: Track[]) => v : originalsOnly
      if (t.status === "fulfilled") setTracks(filter(t.value))
      if (u.status === "fulfilled") setArtists(u.value)
      if (p.status === "fulfilled") setPlaylists(p.value)
      // every source rejected → this is a failure, not an empty result set.
      // Rendering "No results" here would lie to the user
      if (t.status === "rejected" && u.status === "rejected" && p.status === "rejected") {
        setFailed(true)
      }
      setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [debounced, retryTick])

  const top = tracks[0]

  return (
    <div className="-mt-12 px-6 pb-10">
      {/* search input */}
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="sticky top-14 z-20 mx-auto mb-8 mt-4 max-w-md"
      >
        <div className="relative">
          <div className="group flex items-center gap-3 rounded-full border border-line bg-panel/90 px-5 py-3.5 shadow-xl shadow-black/30 backdrop-blur transition-all duration-300 focus-within:border-white/50 focus-within:shadow-[0_0_0_4px_rgba(255,255,255,0.07),0_18px_40px_-12px_rgba(0,0,0,0.8)] hover:border-white/25">
            <SearchIcon size={18} className="shrink-0 text-dim transition-colors duration-300 group-focus-within:text-ink" />
            <input
              ref={inputRef}
              id="search-input"
              type="text"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Escape inside the input clears the query before the global
                // handler would blur/close panels
                if (e.key === "Escape" && query) {
                  e.stopPropagation()
                  setQuery("")
                }
              }}
              placeholder="Songs, artists, playlists…"
              className="w-full bg-transparent text-[15px] font-medium placeholder:font-normal placeholder:text-faint/70"
            />
            <AnimatePresence>
              {query && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => {
                    setQuery("")
                    inputRef.current?.focus()
                  }}
                  aria-label="Clear"
                  className="grid size-6 shrink-0 place-items-center rounded-full bg-hover text-dim transition hover:bg-white/15 hover:text-ink"
                >
                  <X size={13} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
          {/* autocomplete — YouTube Music's own suggestion engine; clicking
              fills + searches immediately (feels instant) */}
          {suggs.length > 0 && (
            <div className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-line bg-panel/95 py-1 shadow-2xl shadow-black/50 backdrop-blur">
              {suggs.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setQuery(s)
                    setSuggs([])
                  }}
                  className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors hover:bg-hover"
                >
                  <SearchIcon size={14} className="shrink-0 text-faint" />
                  <span className="truncate">{s}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </motion.div>

      {!debounced && (
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          {/* mood categories — real YouTube Music editorial taxonomy,
              richer than the flat genre list */}
          {moods.length > 0 && (
            <>
              <h2 className="mb-4 text-xl font-bold">Moods & moments</h2>
              <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {moods.slice(0, 18).map((m, i) => (
                  <motion.button
                    key={m.params}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.02, duration: 0.35 }}
                    onClick={() => navigate(`/mood/${encodeURIComponent(m.params)}`, { state: { name: m.name } })}
                    className="relative h-24 overflow-hidden rounded-xl bg-card p-3 text-left text-sm font-bold text-ink shadow-lg transition hover:bg-cardhover"
                  >
                    {m.name}
                    <Music2 size={52} className="absolute -bottom-3 -right-3 rotate-[20deg] text-cardhover" />
                  </motion.button>
                ))}
              </div>
            </>
          )}
          <h2 className="mb-4 text-xl font-bold">Browse genres</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {GENRES.map((g, i) => (
              <motion.button
                key={g}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02, duration: 0.35 }}
                onClick={() => navigate(`/genre/${encodeURIComponent(g)}`)}
                className="relative h-24 overflow-hidden rounded-xl bg-card p-3 text-left text-sm font-bold text-ink shadow-lg transition hover:bg-cardhover"
              >
                {g}
                <Music2 size={52} className="absolute -bottom-3 -right-3 rotate-[20deg] text-cardhover" />
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}

      {debounced && loading && <RowsSkeleton count={8} />}

      {debounced && !loading && failed && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-24 text-center">
          <p className="text-lg font-semibold">Search failed</p>
          <p className="mt-2 text-sm text-dim">Both catalogs are unreachable right now — check your connection.</p>
          <button
            onClick={() => setRetryTick((n) => n + 1)}
            className="mt-5 rounded-full bg-white px-5 py-2 text-sm font-bold text-black transition hover:scale-[1.04]"
          >
            Retry
          </button>
        </motion.div>
      )}

      {debounced && !loading && !failed && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
          {(top || artists.length > 0 || playlists.length > 0) ? (
            <>
              <div className="mb-10 grid gap-6 lg:grid-cols-[22rem_1fr]">
                {top && (
                  <div>
                    <h2 className="mb-4 text-xl font-bold">Top result</h2>
                    <button
                      onClick={() => playTrack(top, tracks)}
                      onMouseEnter={() => prefetchStream(top)}
                      className="group relative block w-full rounded-2xl bg-card p-5 text-left transition-colors hover:bg-cardhover"
                    >
                      <ArtworkImg art={top.artwork} alt={top.title} className="size-28 rounded-xl shadow-lg" />
                      <p className="mt-4 truncate text-2xl font-bold">{top.title}</p>
                      <p className="mt-1 truncate text-sm text-dim">
                        Song · {top.user.name}
                      </p>
                      <span className="absolute bottom-5 right-5 grid size-12 translate-y-2 place-items-center rounded-full bg-white text-black opacity-0 shadow-xl transition-all group-hover:translate-y-0 group-hover:opacity-100">
                        <Play size={20} className="ml-0.5 fill-current" />
                      </span>
                    </button>
                  </div>
                )}
                <div>
                  <h2 className="mb-4 text-xl font-bold">Songs</h2>
                  {/* full result set as context — queue continues past the
                      visible slice instead of stopping at row 6 */}
                  <TrackTable tracks={tracks.slice(0, 6)} context={tracks} showHeader={false} showPlays={false} />
                </div>
              </div>

              {artists.length > 0 && (
                <Section title="Artists">
                  {artists.map((u) => (
                    <ArtistCard key={u.id} u={u} />
                  ))}
                </Section>
              )}

              {playlists.length > 0 && (
                <Section title="Playlists & albums">
                  {playlists.map((p) => (
                    <PlaylistCard key={p.id} p={p} />
                  ))}
                </Section>
              )}

              {tracks.length > 6 && (
                <div className="mt-4">
                  <h2 className="mb-4 px-0 text-xl font-bold">More tracks</h2>
                  <TrackTable tracks={tracks.slice(6)} context={tracks} showHeader={false} numberOffset={6} />
                </div>
              )}
            </>
          ) : (
            <div className="py-24 text-center">
              <p className="text-lg font-semibold">No results for “{debounced}”</p>
              <p className="mt-2 text-sm text-dim">Try different keywords or check the spelling.</p>
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}
