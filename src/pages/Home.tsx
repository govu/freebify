import { motion } from "motion/react"
import { Play } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { apiClient, originalsOnly } from "../api/audius"
import { prefetchStream, yt, ytAvailable } from "../api/youtube"
import type { Playlist, Track, User } from "../api/types"
import { ArtistCard, PlaylistCard, Section, TrackCard } from "../components/Cards"
import { CardsRowSkeleton, RowsSkeleton } from "../components/Skeletons"
import { Logo } from "../components/Logo"
import { TrackTable } from "../components/TrackTable"
import { ArtworkImg } from "../components/ArtworkImg"
import { useLibrary } from "../store/library"
import { usePlayer } from "../store/player"
import { availableRewind, useRewind } from "../store/rewind"
import { useStats } from "../store/stats"
import { useT } from "../i18n"

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
}

// time-of-day mood pick — the shelf feels curated instead of static
const MOOD_BY_HOUR: [number, string][] = [
  [5, "Workout"],
  [9, "Focus"],
  [13, "Feel Good"],
  [17, "Energy boosters"],
  [21, "Chill"],
]
function moodForNow() {
  const h = new Date().getHours()
  let pick = "Chill"
  for (const [from, name] of MOOD_BY_HOUR) if (h >= from) pick = name
  return pick
}

export function Home() {
  const tt = useT()
  const [chartTracks, setChartTracks] = useState<Track[]>([])
  const [chartArtists, setChartArtists] = useState<User[]>([])
  const [releases, setReleases] = useState<Playlist[]>([])
  const [moodPls, setMoodPls] = useState<Playlist[]>([])
  const [moodName, setMoodName] = useState("")
  const [forYou, setForYou] = useState<Track[]>([])
  const [forYouName, setForYouName] = useState("")
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [audiusTrend, setAudiusTrend] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [run, setRun] = useState(0)

  const recents = useLibrary((s) => s.recents)
  // Rewind card — recompute when month buckets flush; newest edition wins
  const months = useStats((s) => s.months)
  const rewind = useMemo(() => (Object.keys(months).length ? availableRewind() : null), [months])
  const openRewind = useRewind((s) => s.open)

  useEffect(() => {
    let live = true
    const load = async (first: boolean) => {
      if (first) {
        setLoading(true)
        setFailed(false)
      }
      let gotSomething = false
      const mark = <T,>(v: T[] | null | undefined): T[] => {
        if (v && v.length) gotSomething = true
        return v ?? []
      }
      // on refresh, an empty-but-successful response must NOT wipe a
      // populated section — that causes a visible collapse + scroll jump
      const fill = <T,>(set: (v: T[]) => void, v: T[] | null | undefined) => {
        if (v && v.length) set(mark(v))
      }
      try {
        if (await ytAvailable()) {
          const [ch, rel, pl, mo] = await Promise.allSettled([
            yt.charts(),
            yt.newReleases(),
            yt.playlists(),
            yt.moods(),
          ])
          if (!live) return
          if (ch.status === "fulfilled" && ch.value) {
            fill(setChartTracks, ch.value.tracks)
            fill(setChartArtists, ch.value.artists)
            ch.value.tracks.slice(0, 3).forEach(prefetchStream)
          }
          if (rel.status === "fulfilled") fill(setReleases, rel.value)
          if (pl.status === "fulfilled") fill(setPlaylists, pl.value)
          else
            apiClient
              .trendingPlaylists({ limit: 12 })
              .then((p) => {
                if (live && p.length) {
                  setPlaylists(mark(p))
                  setFailed(false)
                }
              })
              .catch(() => {})

          // page is interactive NOW — mood + "because you listened" fill in
          // asynchronously instead of adding two serial RTTs to first paint
          if (live) setLoading(false)
          if (mo.status === "fulfilled" && mo.value.length) {
            const want = moodForNow()
            const pick =
              mo.value.find((m) => m.name.toLowerCase() === want.toLowerCase()) ??
              mo.value.find((m) => m.name.toLowerCase().includes(want.toLowerCase())) ??
              mo.value[0]
            setMoodName(pick.name)
            yt.mood(pick.params)
              .then((mp) => {
                if (live) fill(setMoodPls, mp?.playlists)
              })
              .catch(() => {})
          }

          // "Because you listened" — seed the radio of the most recent
          // track. Read the store live: this closure is ~30min stale by
          // refresh time, and the seed should reflect what the user played
          // THIS session, not what was recent when Home mounted
          const seed = useLibrary.getState().recents[0]
          if (seed?.streamId) {
            yt.upNext(seed.streamId)
              .then((rel2) => {
                if (live && rel2.length) {
                  setForYou(mark(rel2.slice(0, 10)))
                  // strip video-era cruft — "ELLA | BLESSD (VIDEO OFICIAL)"
                  // reads better as "ELLA"
                  setForYouName(
                    seed.title
                      .split(/\s*[|(\[]/)[0]
                      .replace(/\s*(feat\.?|ft\.?).*/i, "")
                      .trim() || seed.title
                  )
                }
              })
              .catch(() => {})
          }
          // empty yt branch → keep going into the Audius path instead of
          // declaring failure with a second catalog still untried
          if (!gotSomething) {
            const [t, p] = await Promise.allSettled([
              apiClient.trendingTracks({ limit: 30 }),
              apiClient.trendingPlaylists({ limit: 12 }),
            ])
            if (!live) return
            if (t.status === "fulfilled") fill(setAudiusTrend, originalsOnly(t.value).slice(0, 12))
            if (p.status === "fulfilled") fill(setPlaylists, p.value)
          }
          if (live) {
            setLoading(false)
            if (!gotSomething) setFailed(true)
          }
          return
        }
      } catch {
        /* fall through to Audius */
      }
      // Audius fallback — keeps the app alive without YouTube
      try {
        const [t, p] = await Promise.allSettled([
          apiClient.trendingTracks({ limit: 30 }),
          apiClient.trendingPlaylists({ limit: 12 }),
        ])
        if (!live) return
        if (t.status === "fulfilled") fill(setAudiusTrend, originalsOnly(t.value).slice(0, 12))
        if (p.status === "fulfilled") fill(setPlaylists, p.value)
      } catch {
        /* all sources down */
      }
      if (live) {
        setLoading(false)
        if (!gotSomething) setFailed(true)
      }
    }
    void load(true)
    // silent refresh — charts/trending rotate; re-paint every 30 min while
    // the page is open without flashing skeletons
    const iv = setInterval(() => void load(false), 30 * 60 * 1000)
    return () => {
      live = false
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  const recentPicks = originalsOnly(recents).slice(0, 8)
  const hits = chartTracks.slice(0, 8)
  const quickPool = recentPicks.length >= 4 ? recentPicks : hits

  const h = new Date().getHours()
  const greetKey =
    h < 5 ? "home.greeting.late" : h < 12 ? "home.greeting.morning" : h < 18 ? "home.greeting.afternoon" : "home.greeting.evening"

  return (
    <div className="-mt-12 pb-10">
      {/* hero */}
      <div className="relative mb-8 px-6 pt-16">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 100% at 20% 0%, rgb(255 255 255 / 0.07), transparent 60%), radial-gradient(50% 80% at 80% 0%, rgb(255 255 255 / 0.04), transparent 60%)",
          }}
        />
        <motion.div {...fadeUp} transition={{ duration: 0.5 }} className="relative">
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{tt(greetKey)}</h1>
        </motion.div>

        {/* quick picks */}
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.08 }}
          className="relative mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
        >
          {loading && quickPool.length === 0
            ? Array.from({ length: 8 }).map((_, i) => <div key={i} className="shimmer h-16 rounded-xl" />)
            : quickPool.map((t, i) => (
                <QuickTile key={t.id} track={t} context={quickPool} index={i} />
              ))}
        </motion.div>
      </div>

      <motion.div {...fadeUp} transition={{ duration: 0.5, delay: 0.14 }}>
        {/* monthly Rewind — your own Wrapped, rebuilt from local stats */}
        {rewind && (
          <section className="mx-6 mb-10">
            <button
              onClick={() => openRewind(rewind)}
              className="group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border border-line bg-card px-5 py-4 text-left transition-colors hover:bg-cardhover"
            >
              <div
                className="pointer-events-none absolute inset-0 opacity-60"
                style={{ background: "radial-gradient(60% 120% at 0% 50%, rgb(255 255 255 / 0.08), transparent 62%)" }}
              />
              <span className="relative grid size-11 shrink-0 place-items-center rounded-xl bg-ink text-black">
                <Logo size={24} />
              </span>
              <span className="relative min-w-0 flex-1">
                <p className="truncate text-[15px] font-bold">
                  {tt(rewind.partial ? "home.rewind.partialReady" : "home.rewind.ready", { label: rewind.label })}
                </p>
                <p className="truncate text-xs text-dim">{tt("home.rewind.sub")}</p>
              </span>
              <span className="relative shrink-0 rounded-full bg-white/10 px-4 py-2 text-xs font-bold transition group-hover:bg-ink group-hover:text-black">
                {tt("home.rewind.watch")}
              </span>
            </button>
          </section>
        )}

        {failed && (
          <div className="mx-6 mb-6 rounded-xl border border-line bg-card px-5 py-4">
            <p className="text-sm font-semibold">{tt("home.loadError")}</p>
            <p className="mt-1 text-xs text-dim">{tt("home.loadErrorHint")}</p>
            <button
              onClick={() => setRun((r) => r + 1)}
              className="mt-3 rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-black transition hover:scale-105"
            >
              {tt("home.retry")}
            </button>
          </div>
        )}

        {/* charts — the localized Top-100 the user's region actually listens
            to, with real chart positions */}
        {(loading || chartTracks.length > 0) && (
          <section className="mb-10">
            <div className="mb-4 flex items-baseline justify-between px-6">
              <h2 className="text-xl font-bold tracking-tight">{tt("home.topSongs")}</h2>
              <span className="text-xs font-semibold text-faint">{tt("home.chart")}</span>
            </div>
            {loading && chartTracks.length === 0 ? (
              <div className="px-6">
                <RowsSkeleton count={6} />
              </div>
            ) : (
              <div className="px-6">
                <TrackTable tracks={chartTracks.slice(0, 10)} context={chartTracks} showPlays />
              </div>
            )}
          </section>
        )}

        {/* top artists — the chart's artist cards */}
        {chartArtists.length > 0 && (
          <Section title={tt("home.topArtists")}>
            {chartArtists.map((u) => (
              <ArtistCard key={u.id} u={u} />
            ))}
          </Section>
        )}

        {/* new releases — fresh albums & singles, OLAK/MPRE routed correctly */}
        {(loading || releases.length > 0) && (
          <Section title={tt("home.newReleases")}>
            {loading && releases.length === 0 ? (
              <CardsRowSkeleton />
            ) : (
              releases.map((p) => <PlaylistCard key={p.id} p={p} />)
            )}
          </Section>
        )}

        {/* personalized radio — seeded by the most recent listen */}
        {forYou.length > 0 && (
          <Section title={tt("home.becauseListened", { name: forYouName })}>
            {forYou.map((t) => (
              <TrackCard key={t.id} t={t} context={forYou} />
            ))}
          </Section>
        )}

        {/* time-aware mood shelf — Workout mornings, Chill nights… */}
        {moodPls.length > 0 && (
          <Section title={tt("home.moodMixes", { name: moodName })}>
            {moodPls.map((p) => (
              <PlaylistCard key={p.id} p={p} />
            ))}
          </Section>
        )}

        {(loading || playlists.length > 0) && (
          <Section title={tt("home.hotPlaylists")}>
            {loading && playlists.length === 0 ? (
              <CardsRowSkeleton />
            ) : (
              playlists.map((p) => <PlaylistCard key={p.id} p={p} />)
            )}
          </Section>
        )}

        {/* Audius path — only when YouTube is down entirely */}
        {audiusTrend.length > 0 && (
          <Section title={tt("home.trending")}>
            {audiusTrend.map((t) => (
              <TrackCard key={t.id} t={t} context={audiusTrend} />
            ))}
          </Section>
        )}
      </motion.div>
    </div>
  )
}

function QuickTile({ track: t, context, index }: { track: Track; context: Track[]; index: number }) {
  const playContext = usePlayer((s) => s.playContext)
  const isCurrent = usePlayer((s) => s.current?.id === t.id)

  return (
    <motion.button
      initial={{ opacity: 0, x: -14 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: 0.05 + index * 0.045, ease: "easeOut" }}
      onClick={() => playContext(context, index)}
      onMouseEnter={() => prefetchStream(t)}
      className="group flex h-16 items-center overflow-hidden rounded-xl border border-line bg-card/80 text-left backdrop-blur transition-colors hover:bg-cardhover"
    >
      <ArtworkImg art={t.artwork} size="150x150" alt="" className="size-16 shrink-0" iconSize={18} />
      <span className={`min-w-0 flex-1 truncate px-3 text-sm font-semibold ${isCurrent ? "underline decoration-white/30 underline-offset-4" : ""}`}>
        {t.title}
      </span>
      <span className="mr-3 grid size-9 shrink-0 place-items-center rounded-full bg-white text-black opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
        <Play size={15} className="ml-0.5 fill-current" />
      </span>
    </motion.button>
  )
}
