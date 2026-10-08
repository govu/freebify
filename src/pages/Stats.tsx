import { motion } from "motion/react"
import { BarChart3, Clock3, Disc3, Play, Users } from "lucide-react"
import { useMemo } from "react"
import { ArtworkImg } from "../components/ArtworkImg"
import { Logo } from "../components/Logo"
import { usePlayer } from "../store/player"
import { availableRewind, useRewind } from "../store/rewind"
import { dayKey, useStats } from "../store/stats"
import { dateLocale, useT } from "../i18n"
import { fmtCount, fmtDuration } from "../utils/format"

const hours = (ms: number) => (ms / 3_600_000).toFixed(1)
const hm = (ms: number) => {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return h ? `${h}h ${m}m` : `${m}m`
}

export function StatsPage() {
  const tt = useT()
  const tracks = useStats((s) => s.tracks)
  const artists = useStats((s) => s.artists)
  const days = useStats((s) => s.days)
  const totalPlays = useStats((s) => s.totalPlays)
  const playTrack = usePlayer((s) => s.playTrack)
  const months = useStats((s) => s.months)
  const rewind = useMemo(() => (Object.keys(months).length ? availableRewind() : null), [months])
  const openRewind = useRewind((s) => s.open)

  const topTracks = Object.values(tracks)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12)
  const topArtists = Object.values(artists)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)

  // last 7 days — local day keys matching what recordMs writes
  const todayKey = dayKey()
  const week = [...Array(7)].map((_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const k = dayKey(d)
    return { day: k, ms: days[k] ?? 0 }
  }).reverse()
  const weekMs = week.reduce((a, d) => a + d.ms, 0)
  const peak = Math.max(1, ...week.map((d) => d.ms))

  const empty = totalPlays === 0

  return (
    <div className="px-6 pb-16 pt-6">
      <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="text-3xl font-black tracking-tight">
        {tt("stats.title")}
      </motion.h1>
      <p className="mt-1 text-sm text-dim">{tt("stats.subtitle")}</p>

      {rewind && (
        <motion.button
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          onClick={() => openRewind(rewind)}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-black transition hover:scale-[1.03]"
        >
          <Logo size={15} />
          {tt(rewind.partial ? "stats.rewind.partial" : "stats.rewind.full", { label: rewind.label })}
        </motion.button>
      )}

      {empty ? (
        <div className="mt-16 flex flex-col items-center rounded-2xl border border-dashed border-line py-20 text-center">
          <BarChart3 size={44} className="text-faint" />
          <p className="mt-4 text-lg font-semibold">{tt("stats.emptyTitle")}</p>
          <p className="mt-1 text-sm text-dim">{tt("stats.emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon={<Clock3 size={16} />} label={tt("stats.thisWeek")} value={`${hours(weekMs)}h`} />
            <StatCard icon={<Disc3 size={16} />} label={tt("stats.totalPlays")} value={fmtCount(totalPlays)} />
            <StatCard icon={<BarChart3 size={16} />} label={tt("stats.tracksPlayed")} value={fmtCount(Object.keys(tracks).length)} />
            <StatCard icon={<Users size={16} />} label={tt("stats.artistsHeard")} value={fmtCount(Object.keys(artists).length)} />
          </div>

          {/* 7-day strip */}
          <div className="mt-6 rounded-2xl border border-line bg-panel p-5">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-xs font-semibold text-dim">{tt("stats.listeningTime")}</span>
              <span className="text-xs tabular-nums text-faint">{tt("stats.weekTotal", { t: hm(weekMs) })}</span>
            </div>
            <div className="flex h-24 items-end gap-2 border-b border-line/60 pb-px">
              {week.map((d) => {
                const isToday = d.day === todayKey
                const date = new Date(d.day + "T12:00:00")
                return (
                  <div
                    key={d.day}
                    className="group flex flex-1 flex-col items-center gap-1.5"
                    title={`${date.toLocaleDateString(dateLocale(), { weekday: "long", month: "short", day: "numeric" })} · ${d.ms ? hm(d.ms) : tt("stats.noListening")}`}
                  >
                    <motion.div
                      initial={{ scaleY: 0 }}
                      animate={{ scaleY: 1 }}
                      transition={{ duration: 0.4 }}
                      style={{ height: `${d.ms > 0 ? Math.max(8, (d.ms / peak) * 80) : 3}px` }}
                      className={`w-9 max-w-full origin-bottom rounded-full transition-colors ${
                        d.ms > 0 ? (isToday ? "bg-white" : "bg-white/50") : "bg-white/10"
                      } group-hover:bg-white`}
                    />
                    <span className={`text-[9px] uppercase ${isToday ? "font-semibold text-dim" : "text-faint"}`}>
                      {date.toLocaleDateString(dateLocale(), { weekday: "narrow" })}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-8 grid gap-8 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 text-sm font-semibold text-dim">{tt("stats.topTracks")}</h2>
              <div className="space-y-1">
                {topTracks.map((t, i) => (
                  <button
                    key={t.track.id}
                    onClick={() => playTrack(t.track)}
                    className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5"
                  >
                    <span className="w-5 text-right text-xs tabular-nums text-faint">{i + 1}</span>
                    <ArtworkImg art={t.track.artwork} size="150x150" alt="" className="size-9 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.track.title}</p>
                      <p className="truncate text-xs text-dim">{t.track.user?.name}</p>
                    </div>
                    <div className="flex items-center gap-4 text-xs tabular-nums text-faint">
                      <span className="flex items-center gap-1"><Play size={10} />{t.plays}</span>
                      <span>{fmtDuration(t.ms / 1000)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold text-dim">{tt("stats.topArtists")}</h2>
              <div className="space-y-1">
                {topArtists.map((a, i) => (
                  <div key={a.name} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                    <span className="w-5 text-right text-xs tabular-nums text-faint">{i + 1}</span>
                    {a.art ? (
                      <img src={a.art} alt="" className="size-9 rounded-full object-cover" loading="lazy" />
                    ) : (
                      <div className="grid size-9 place-items-center rounded-full bg-card text-xs font-bold text-dim">
                        {a.name[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.name}</p>
                    </div>
                    <div className="flex items-center gap-4 text-xs tabular-nums text-faint">
                      <span className="flex items-center gap-1"><Play size={10} />{a.plays}</span>
                      <span>{fmtDuration(a.ms / 1000)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2 text-faint">{icon}<span className="text-[11px]">{label}</span></div>
      <p className="mt-2 text-2xl font-black tabular-nums tracking-tight">{value}</p>
    </div>
  )
}
