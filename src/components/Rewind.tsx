import { animate, AnimatePresence, motion, useMotionValue, useTransform } from "motion/react"
import { ChevronLeft, ChevronRight, Clock3, Disc3, Play, Sparkles, Users, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { Artwork } from "../api/types"
import type { RewindData } from "../store/rewind"
import { useRewind } from "../store/rewind"
import { usePlayer } from "../store/player"
import { ArtworkImg } from "./ArtworkImg"

const hm = (ms: number) => {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return h ? `${h}h ${m}m` : `${m}m`
}

// per-slide auto-advance pacing — the outro stays until dismissed
const SLIDE_MS = [4600, 5800, 6400, 8600]

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

const slideVar = {
  enter: { opacity: 0, y: 84, scale: 0.965, filter: "blur(14px)" },
  center: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, y: -56, scale: 0.985, filter: "blur(10px)" },
}

// the Freebify mark drawn stroke by stroke — same geometry as Logo
function RewindMark({ size = 92 }: { size?: number }) {
  const s = { stroke: "#f4f4f5", strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" }
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      initial={{ scale: 0.88, rotate: -6, opacity: 0 }}
      animate={{ scale: 1, rotate: 0, opacity: 1 }}
      transition={{ duration: 0.9, ease: EASE }}
    >
      <motion.path
        d="M41.5 33A19 19 0 1 1 24 5"
        {...s}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.85, ease: "easeInOut", delay: 0.25 }}
      />
      <motion.circle
        cx="24" cy="24" r="10"
        {...s}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, ease: "easeInOut", delay: 0.42 }}
      />
      <motion.circle
        cx="24" cy="24" r="3.5"
        fill="#f4f4f5"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.4, ease: EASE, delay: 1.02 }}
        style={{ transformOrigin: "24px 24px" }}
      />
    </motion.svg>
  )
}

// char-by-char cascade — the lockup grammar from the brand piece
function Cascade({ text, delay = 0, className = "" }: { text: string; delay?: number; className?: string }) {
  return (
    <span className={className} aria-label={text}>
      {text.split("").map((c, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="inline-block"
          initial={{ opacity: 0, y: 46, rotate: i % 2 ? 2.5 : -2.5 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ duration: 0.4, ease: EASE, delay: delay + i * 0.035 }}
        >
          {c === " " ? " " : c}
        </motion.span>
      ))}
    </span>
  )
}

function Eyebrow({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.p
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE, delay }}
      className="text-xs font-bold uppercase tracking-[0.32em] text-faint"
    >
      {children}
    </motion.p>
  )
}

function CountUp({ to, className }: { to: number; className?: string }) {
  const mv = useMotionValue(0)
  const rounded = useTransform(mv, (v) => Math.round(v).toLocaleString())
  useEffect(() => {
    const c = animate(mv, to, { duration: 1.9, ease: [0.16, 1, 0.3, 1], delay: 0.35 })
    return () => c.stop()
  }, [mv, to])
  return <motion.span className={className}>{rounded}</motion.span>
}

function Chip({ icon, children, delay }: { icon: React.ReactNode; children: React.ReactNode; delay: number }) {
  return (
    <motion.span
      initial={{ opacity: 0, y: 14, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: EASE, delay }}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-3.5 py-1.5 text-xs font-semibold text-dim"
    >
      {icon}
      {children}
    </motion.span>
  )
}

export function RewindOverlay() {
  const active = useRewind((s) => s.active)
  const close = useRewind((s) => s.close)
  return (
    <AnimatePresence>{active && <RewindStory key={active.key + String(active.partial)} data={active} onClose={close} />}</AnimatePresence>
  )
}

function RewindStory({ data, onClose }: { data: RewindData; onClose: () => void }) {
  const [idx, setIdx] = useState(0)
  const playContext = usePlayer((s) => s.playContext)

  const slides = useMemo(() => {
    const list: React.ReactNode[] = [
      <IntroSlide key="i" data={data} />,
      <MinutesSlide key="m" data={data} />,
    ]
    if (data.artists.length) list.push(<ArtistSlide key="a" data={data} />)
    list.push(<TracksSlide key="t" data={data} onPlay={() => playContext(data.tracks.map((t) => t.track), 0)} />)
    list.push(<OutroSlide key="o" data={data} onClose={onClose} onPlay={() => playContext(data.tracks.map((t) => t.track), 0)} />)
    return list
  }, [data, onClose, playContext])

  const last = slides.length - 1
  const dur = idx < SLIDE_MS.length ? SLIDE_MS[idx] : 0

  const next = () => setIdx((i) => Math.min(last, i + 1))
  const prev = () => setIdx((i) => Math.max(0, i - 1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") { e.preventDefault(); onClose() }
      else if (e.code === "ArrowRight" || e.code === "Space") { e.preventDefault(); next() }
      else if (e.code === "ArrowLeft") { e.preventDefault(); prev() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.4 } }}
      className="fixed inset-0 z-[80] overflow-hidden bg-[#030303] outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={`${data.full} Rewind`}
    >
      {/* ambient — two slow-drifting glows, nothing else moves behind the type */}
      <motion.div
        className="pointer-events-none absolute -left-40 -top-40 size-[560px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.07), transparent 62%)" }}
        animate={{ x: [0, 60, 0], y: [0, 40, 0] }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="pointer-events-none absolute -bottom-52 -right-40 size-[620px] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.05), transparent 62%)" }}
        animate={{ x: [0, -50, 0], y: [0, -36, 0] }}
        transition={{ duration: 19, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* progress segments */}
      <div className="absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 px-5 pt-5 sm:px-8">
        <div className="flex flex-1 gap-1.5">
          {slides.map((_, i) => (
            <div key={i} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
              {i < idx && <div className="h-full w-full bg-white" />}
              {i === idx &&
                (dur > 0 ? (
                  <motion.div
                    className="h-full bg-white"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: dur / 1000, ease: "linear" }}
                    onAnimationComplete={next}
                  />
                ) : (
                  <div className="h-full w-full bg-white/70" />
                ))}
            </div>
          ))}
        </div>
        <span className="ml-3 text-[10px] font-bold uppercase tracking-[0.3em] text-faint">
          {data.partial ? "so far" : "rewind"}
        </span>
        <button
          onClick={onClose}
          aria-label="Close rewind"
          className="ml-2 grid size-8 place-items-center rounded-full text-dim transition hover:bg-white/10 hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {/* tap zones — left third back, right two-thirds forward */}
      <div className="absolute inset-0 z-10 flex">
        <button className="h-full w-[32%] cursor-w-resize" onClick={prev} aria-label="Previous slide" />
        <button className="h-full flex-1 cursor-e-resize" onClick={next} aria-label="Next slide" />
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden items-center pl-4 md:flex">
        <button onClick={prev} aria-label="Previous" className="pointer-events-auto grid size-10 place-items-center rounded-full text-faint transition hover:bg-white/10 hover:text-ink">
          <ChevronLeft size={20} />
        </button>
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 z-20 hidden items-center pr-4 md:flex">
        <button onClick={next} aria-label="Next" className="pointer-events-auto grid size-10 place-items-center rounded-full text-faint transition hover:bg-white/10 hover:text-ink">
          <ChevronRight size={20} />
        </button>
      </div>

      <div className="pointer-events-none relative z-20 flex h-full items-center justify-center px-6 pb-10 pt-16">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={idx}
            variants={slideVar}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.62, ease: EASE }}
            className="w-full max-w-3xl"
          >
            {slides[idx]}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

/* ---------------- slides ---------------- */

function IntroSlide({ data }: { data: RewindData }) {
  return (
    <div className="flex flex-col items-center text-center">
      <RewindMark />
      <Eyebrow delay={1.15}>
        {data.partial ? "Freebify · still counting" : "Freebify · monthly"}
      </Eyebrow>
      <Cascade
        text={data.label.toUpperCase()}
        delay={1.28}
        className="mt-5 block text-[19vw] font-black leading-[0.95] tracking-[-0.04em] text-ink sm:text-[7.5rem]"
      />
      <Cascade
        text="REWIND"
        delay={1.58}
        className="mt-1 block text-[11vw] font-black leading-none tracking-[0.14em] text-white/25 sm:text-6xl"
      />
      <motion.p
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 2.0 }}
        className="mt-6 text-sm text-dim"
      >
        {data.partial ? "Your month so far — " : "A month of yours — "}
        every play, counted on this device.
      </motion.p>
    </div>
  )
}

function MinutesSlide({ data }: { data: RewindData }) {
  const minutes = Math.round(data.ms / 60_000)
  return (
    <div className="flex flex-col items-center text-center">
      <Eyebrow delay={0.1}>you listened for</Eyebrow>
      <div className="mt-4 flex items-baseline gap-3">
        <CountUp to={minutes} className="text-[26vw] font-black leading-none tabular-nums tracking-[-0.05em] text-ink sm:text-[11rem]" />
        <motion.span
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.9 }}
          className="text-2xl font-bold text-dim sm:text-4xl"
        >
          min
        </motion.span>
      </div>
      <motion.p
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 1.1 }}
        className="mt-3 text-base text-dim"
      >
        {hm(data.ms)} — {data.plays.toLocaleString()} plays across {data.trackCount} tracks
      </motion.p>
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <Chip icon={<Disc3 size={12} />} delay={1.35}>{data.trackCount} tracks</Chip>
        <Chip icon={<Users size={12} />} delay={1.45}>{data.artistCount} artists</Chip>
        <Chip icon={<Clock3 size={12} />} delay={1.55}>{hm(data.ms)} total</Chip>
      </div>
    </div>
  )
}

function ArtistSlide({ data }: { data: RewindData }) {
  const a = data.artists[0]
  const art: Artwork | null = a.art ? { "480x480": a.art } : null
  return (
    <div className="flex flex-col items-center text-center">
      <Eyebrow delay={0.1}>your #1 artist</Eyebrow>
      <motion.div
        initial={{ opacity: 0, scale: 0.86, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.85, ease: EASE, delay: 0.35 }}
        className="relative mt-8"
      >
        <motion.div
          animate={{ scale: [1, 1.05] }}
          transition={{ duration: 6, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" }}
          className="size-56 overflow-hidden rounded-3xl shadow-2xl shadow-black/60 ring-1 ring-white/15 sm:size-72"
        >
          {art ? (
            <ArtworkImg art={art} size="480x480" alt={a.name} className="size-full" iconSize={44} />
          ) : (
            <div className="grid size-full place-items-center bg-gradient-to-br from-hover to-panel text-6xl font-black text-dim">
              {a.name[0]}
            </div>
          )}
        </motion.div>
        <motion.div
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.85 }}
          className="absolute -right-3 -top-3 grid size-14 place-items-center rounded-full bg-ink text-xl font-black text-black shadow-xl"
        >
          1
        </motion.div>
      </motion.div>
      <Cascade text={a.name} delay={0.7} className="mt-7 block max-w-full truncate text-4xl font-black tracking-tight text-ink sm:text-6xl" />
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 1.15 }}
        className="mt-3 text-sm text-dim"
      >
        {a.plays.toLocaleString()} plays · {hm(a.ms)} this month
      </motion.p>
    </div>
  )
}

function TracksSlide({ data, onPlay }: { data: RewindData; onPlay: () => void }) {
  return (
    <div>
      <Eyebrow delay={0.05}>on repeat</Eyebrow>
      <motion.h2
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: EASE, delay: 0.18 }}
        className="mt-2 text-4xl font-black tracking-tight text-ink sm:text-5xl"
      >
        The songs you couldn't stop
      </motion.h2>
      <div className="mt-8 space-y-2">
        {data.tracks.map((t, i) => (
          <motion.div
            key={t.track.id}
            initial={{ opacity: 0, x: -34, filter: "blur(6px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.45 + i * 0.13 }}
            className={`group flex items-center gap-4 rounded-xl px-4 py-3 ring-1 transition ${
              i === 0 ? "bg-white/[0.07] ring-white/15" : "bg-white/[0.025] ring-line"
            }`}
          >
            <span className={`w-7 text-right text-xl font-black tabular-nums ${i === 0 ? "text-ink" : "text-faint"}`}>{i + 1}</span>
            <ArtworkImg art={t.track.artwork} size="150x150" alt="" className="size-12 rounded-lg" iconSize={16} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold text-ink">{t.track.title}</p>
              <p className="truncate text-xs text-dim">{t.track.user?.name}</p>
            </div>
            <div className="flex shrink-0 items-center gap-4 text-xs font-semibold tabular-nums text-faint">
              <span className="flex items-center gap-1"><Play size={10} />{t.plays}</span>
              <span className="hidden sm:block">{hm(t.ms)}</span>
            </div>
          </motion.div>
        ))}
      </div>
      <motion.button
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 1.25 }}
        onClick={onPlay}
        className="pointer-events-auto mt-7 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-black transition hover:scale-[1.03]"
      >
        <Play size={14} className="fill-current" />
        Play your top tracks
      </motion.button>
    </div>
  )
}

function OutroSlide({ data, onClose, onPlay }: { data: RewindData; onClose: () => void; onPlay: () => void }) {
  const topA = data.artists[0]
  const topT = data.tracks[0]
  return (
    <div className="flex flex-col items-center text-center">
      <Eyebrow delay={0.05}>that was</Eyebrow>
      <Cascade
        text={`${data.label}.`}
        delay={0.18}
        className="mt-3 block text-6xl font-black tracking-[-0.03em] text-ink sm:text-8xl"
      />
      <motion.div
        initial={{ opacity: 0, y: 26, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.55 }}
        className="mt-9 w-full max-w-md rounded-2xl border border-line bg-white/[0.04] p-5"
      >
        <div className="flex items-center gap-4">
          {topT && <ArtworkImg art={topT.track.artwork} size="150x150" alt="" className="size-14 rounded-xl" iconSize={18} />}
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-bold text-ink">{topT?.track.title}</p>
            <p className="truncate text-xs text-dim">{topT?.track.user?.name}</p>
          </div>
          {topA && (
            <div className="flex shrink-0 items-center gap-2 text-left">
              {topA.art ? (
                <img src={topA.art} alt="" className="size-9 rounded-full object-cover ring-1 ring-white/15" />
              ) : (
                <div className="grid size-9 place-items-center rounded-full bg-card text-xs font-bold text-dim">{topA.name[0]}</div>
              )}
              <span className="max-w-[110px] truncate text-xs font-semibold text-dim">{topA.name}</span>
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Chip icon={<Clock3 size={11} />} delay={0.85}>{hm(data.ms)}</Chip>
          <Chip icon={<Disc3 size={11} />} delay={0.93}>{data.plays.toLocaleString()} plays</Chip>
          <Chip icon={<Sparkles size={11} />} delay={1.01}>{data.artistCount} artists</Chip>
        </div>
      </motion.div>
      <div className="mt-8 flex items-center justify-center gap-3">
        <motion.button
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE, delay: 1.15 }}
          onClick={onPlay}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-bold text-black transition hover:scale-[1.03]"
        >
          <Play size={14} className="fill-current" />
          Play it again
        </motion.button>
        <motion.button
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE, delay: 1.23 }}
          onClick={onClose}
          className="pointer-events-auto rounded-full border border-line px-6 py-2.5 text-sm font-semibold text-dim transition hover:border-white/30 hover:text-ink"
        >
          Keep listening
        </motion.button>
      </div>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1.6 }}
        className="mt-10 text-[11px] font-semibold uppercase tracking-[0.3em] text-faint"
      >
        Free forever.
      </motion.p>
    </div>
  )
}
