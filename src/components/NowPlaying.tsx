import {
  ChevronDown, Heart, ListMusic, Loader2, MicVocal, Pause, Play,
  Repeat, Repeat1, Shuffle, SkipBack, SkipForward,
} from "lucide-react"
import { AnimatePresence, motion, useDragControls } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useLibrary } from "../store/library"
import { usePlayer } from "../store/player"
import { yt } from "../api/youtube"
import { dominantColor, rgb } from "../utils/color"
import { fmtDuration } from "../utils/format"
import { ArtworkImg } from "./ArtworkImg"
import { Marquee } from "./Marquee"
import { Slider } from "./Slider"

interface LrcLine {
  t: number
  text: string
}

// LRC format: [mm:ss.xx] text — multiple stamps per line are legal
// (repeated sections), so each stamp produces its own line entry
function parseLrc(src: string): LrcLine[] {
  const out: LrcLine[] = []
  // [offset:±ms] is a real LRC metadata tag that shifts every timestamp —
  // ignoring it leaves lyrics permanently skewed on files that rely on it
  let metaOffset = 0
  for (const line of src.split("\n")) {
    const off = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(line.trim())
    if (off) metaOffset = Number(off[1]) / 1000
    // only stamps at the line's start count as line times — mid-line
    // stamps are enhanced-LRC word markers; their text IS this line's
    let rest = line.trim()
    const stamps: number[] = []
    let m: RegExpExecArray | null
    while ((m = /^\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      const frac = Number(m[4] ?? 0) / Math.pow(10, m[4]?.length ?? 1)
      stamps.push(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac)
      rest = rest.slice(m[0].length).trim()
    }
    // strip inline <mm:ss.xx> word markers and stray [mm:ss.xx] that
    // enhanced files sprinkle through the text itself
    rest = rest
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?(?:[.:]\d{1,3})?>/g, "")
      .replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:[.:]\d{1,3})?\]/g, "")
      .trim()
    if (!stamps.length || !rest) continue
    for (const t of stamps) out.push({ t: t + metaOffset, text: rest })
  }
  return out.sort((a, b) => a.t - b.t)
}

// live lyrics — active line bright, past lines dim, future lines faint;
// auto-scroll keeps the active line near the center. Isolated component so
// the 4 Hz clock only re-renders these lines, not the whole overlay.
// Click a line to seek to it; Shift+click pins THAT line to right now —
// a one-tap fix for versions whose LRC timestamps are offset. Persisted
// per track id so the correction survives restarts
function SyncedLyrics({ lines, autoOff }: { lines: LrcLine[]; autoOff: number }) {
  const t = usePlayer((s) => s.currentTime)
  const seek = usePlayer((s) => s.seek)
  const trackId = usePlayer((s) => s.current?.id)
  const [offset, setOffset] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  // saved manual correction beats the auto guess — the user knows best
  useEffect(() => {
    if (!trackId) return
    let saved: string | null = null
    try {
      saved = localStorage.getItem(`lrcoff-${trackId}`)
      // lrcoff-* keys grow one per corrected track — cap the set so a
      // long-lived profile can't sprawl
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("lrcoff-"))
      for (const k of keys.slice(0, Math.max(0, keys.length - 120))) localStorage.removeItem(k)
    } catch { /* storage unavailable — offsets just won't persist */ }
    if (saved !== null) {
      setOffset(Number(saved) || 0)
      setNote(null)
    } else {
      setOffset(autoOff)
      if (autoOff !== 0) {
        setNote(`Lyrics auto-synced ${autoOff > 0 ? "+" : ""}${autoOff}s`)
        const h = setTimeout(() => setNote(null), 4500)
        return () => clearTimeout(h)
      }
      setNote(null)
    }
  }, [trackId, autoOff])
  const applyOffset = (v: number) => {
    const next = Math.max(-30, Math.min(30, Math.round(v * 10) / 10))
    setOffset(next)
    if (trackId) {
      try {
        localStorage.setItem(`lrcoff-${trackId}`, String(next))
      } catch { /* quota/security — correction stays session-only */ }
    }
  }
  const adj = t - offset
  // slight lookahead lands the highlight *on* the line being sung;
  // -1 while the intro still plays — nothing gets wrongly lit early
  let active = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= adj + 0.3) active = i
    else break
  }
  const listRef = useRef<HTMLDivElement>(null)
  // manual scroll pauses auto-follow ~5s — without this the next line
  // change yanks the view back while the user reads ahead
  const userScrollUntil = useRef(0)
  useEffect(() => {
    const sc = listRef.current
    if (!sc) return
    const mark = () => {
      userScrollUntil.current = Date.now() + 5000
    }
    sc.addEventListener("wheel", mark)
    sc.addEventListener("touchmove", mark, { passive: true })
    return () => {
      sc.removeEventListener("wheel", mark)
      sc.removeEventListener("touchmove", mark)
    }
  }, [lines.length])
  useEffect(() => {
    const sc = listRef.current
    const el = active >= 0 ? sc?.querySelector<HTMLElement>(`[data-l="${active}"]`) : undefined
    if (!sc) return
    if (!el) {
      // intro: park the view at the first line instead of a phantom scroll
      if (Date.now() >= userScrollUntil.current) sc.scrollTo({ top: 0 })
      return
    }
    if (Date.now() < userScrollUntil.current) return
    // rect-based target: offsetTop chains break on the absolutely-positioned
    // overlay ancestor; this measures real viewport distance + scrollTop
    const target = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight / 2 + el.offsetHeight / 2
    sc.scrollTo({ top: target, behavior: "smooth" })
  }, [active])
  return (
    <div className="relative h-full w-full">
      {/* transient notice when auto-calibration kicked in — tells the user
          the lyrics were nudged without adding permanent chrome */}
      <AnimatePresence>
        {note && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-panel/80 px-3 py-1.5 text-[11px] font-medium text-ink/70 ring-1 ring-line backdrop-blur"
          >
            {note} · Shift+click a line if it's off
          </motion.div>
        )}
      </AnimatePresence>
      <div ref={listRef} className="scroller h-full w-full overflow-y-auto px-8 text-center">
        <div className="py-[38vh]">
          {lines.map((l, i) => (
            <button
              key={i}
              data-l={i}
              onClick={(e) => {
                if (e.shiftKey) applyOffset(t - l.t)
                else seek(l.t + offset)
              }}
              title="Click to jump · Shift+click to sync this line to now"
              className={`block w-full cursor-pointer px-4 py-2.5 text-2xl font-bold leading-snug transition-all duration-300 md:text-3xl ${
                i === active
                  ? "scale-[1.04] text-ink"
                  : i < active
                    ? "text-ink/45 hover:text-ink/70"
                    : "text-ink/25 hover:text-ink/50"
              }`}
            >
              {l.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function NowPlaying() {
  const current = usePlayer((s) => s.current)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const buffering = usePlayer((s) => s.buffering)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)

  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const setNpOpen = usePlayer((s) => s.setNpOpen)
  const setQueueOpen = usePlayer((s) => s.setQueueOpen)

  const liked = useLibrary((s) => (current ? Boolean(s.liked[current.id]) : false))
  const toggleLike = useLibrary((s) => s.toggleLike)

  // drag-to-close from the header only — attaching the gesture to the whole
  // sheet would fight the seek slider's pointer drags
  const dragControls = useDragControls()
  const [color, setColor] = useState<[number, number, number] | null>(null)
  useEffect(() => {
    let live = true
    const art =
      current?.artwork?.["480x480"] ??
      current?.artwork?.["1000x1000"] ??
      current?.artwork?.["150x150"]
    void dominantColor(art).then((c) => live && setColor(c))
    return () => {
      live = false
    }
  }, [current?.id, current?.artwork])

  // lyrics — synced beats plain: LRCLIB carries LRC-timestamped lines
  // (karaoke-style live highlighting); YouTube Music / lyrics.ovh are the
  // plain-text fallbacks. null = confirmed unavailable → mic hides
  const [showLyrics, setShowLyrics] = useState(false)
  const [lyrics, setLyrics] = useState<{ synced: LrcLine[]; autoOff: number } | { plain: string } | null>(null)
  const [lyricsTried, setLyricsTried] = useState(false)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  useEffect(() => {
    setShowLyrics(false)
    setLyrics(null)
    setLyricsTried(false)
  }, [current?.id])
  useEffect(() => {
    if (!showLyrics || lyricsTried || !current) return
    let live = true
    setLyricsLoading(true)
    // strip only NOISE tails — "(VIDEO OFICIAL)", "| BLESSD (VIDEO...)",
    // "[Official Audio]" — while keeping meaningful "(feat. X)" groups:
    // each trailing bracket/pipe group is removed only if it contains a
    // noise keyword, so features survive and video cruft dies
    const noise = /video|oficial|official|lyric|letra|\baudio\b|visual|\bhd\b|\b4k\b|\bmv\b|explicit|live\b|cover\b|remaster/i
    let title = current.title.trim()
    for (let i = 0; i < 4; i++) {
      const m = /\s*(\([^(]*\)|\[[^\]]*\]|\|.*)$/.exec(title)
      if (!m || !noise.test(m[1])) break
      title = title.slice(0, m.index).trim()
    }
    // channel suffixes: " - Topic"/" - Official" need the dash (bare
    // "Topic"/"Official HIGE DANDism" are real artist names); VEVO is
    // stripped only in its shouty trailing form (ShakiraVEVO → Shakira)
    const artist = current.user.name
      .replace(/\s*[-–—]\s*(vevo|official|oficial|topic)\b.*$/i, "")
      .replace(/VEVO\s*$/, "")
      .trim()
    const fetchLrcLib = async (): Promise<{ synced: LrcLine[]; autoOff: number } | { plain: string } | null> => {
      try {
        const params = (u: URL) => {
          u.searchParams.set("track_name", title)
          u.searchParams.set("artist_name", artist)
          return u
        }
        // /api/search returns every candidate version — picking the record
        // whose duration is closest to OUR track is what keeps timestamps
        // aligned (radio edits / deluxe versions have different structure,
        // so a wrong pick puts every line off by the intro's length).
        // The endpoint rate-limits to 503s sometimes → /api/get is the
        // reliable first-match fallback
        let arr: Array<{ duration?: number; syncedLyrics?: string; plainLyrics?: string }> | null = null
        try {
          const r = await fetch(params(new URL("https://lrclib.net/api/search")), { signal: AbortSignal.timeout(8000) })
          if (r.ok) {
            const j = await r.json()
            if (Array.isArray(j)) arr = j
          }
        } catch {
          /* fall through to /api/get */
        }
        if (!arr) {
          const r = await fetch(params(new URL("https://lrclib.net/api/get")), { signal: AbortSignal.timeout(8000) })
          if (!r.ok) return null
          const j = (await r.json()) as { syncedLyrics?: string; plainLyrics?: string; duration?: number }
          arr = j && (j.syncedLyrics || j.plainLyrics) ? [j] : []
        }
        if (!arr.length) return null
        const dur = current.duration ?? 0
        const close = (x: { duration?: number }) => (dur ? Math.abs((x.duration ?? 0) - dur) : 0)
        const syncedPool = arr.filter((x) => x.syncedLyrics).sort((a, b) => close(a) - close(b))
        for (const rec of syncedPool) {
          const synced = parseLrc(rec.syncedLyrics!)
          // sanity: a synced file whose last line lands way past our track's
          // end is for a different version — skip it rather than drift
          if (synced.length >= 4 && (!dur || synced[synced.length - 1].t <= dur + 20)) {
            // auto-calibration: our version longer than the record usually
            // means the extra time is lead-in intro → shift lyrics later
            const g = dur && rec.duration ? Math.max(-15, Math.min(15, dur - rec.duration)) : 0
            return { synced, autoOff: Math.abs(g) >= 2.5 ? Math.round(g * 2) / 2 : 0 }
          }
        }
        const plain = syncedPool[0]?.plainLyrics?.trim() ?? arr.find((x) => x.plainLyrics)?.plainLyrics?.trim()
        return plain ? { plain } : null
      } catch {
        return null
      }
    }
    const fetchOvh = async (): Promise<{ plain: string } | null> => {
      try {
        const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) return null
        const j = (await r.json()) as { lyrics?: string }
        return j.lyrics?.trim() ? { plain: j.lyrics.trim() } : null
      } catch {
        return null
      }
    }
    // two more synced sources before resigning to plain text — lyrist
    // aggregates LRC records (QQ/NetEase catalogs, strong on Latin/regional
    // music where LRCLIB is thin), textyl returns timestamped lines directly.
    // Same last-line sanity check rejects records for a different master.
    const dur = current.duration ?? 0
    const sane = (lines: LrcLine[]) =>
      lines.length >= 4 && (!dur || lines[lines.length - 1].t <= dur + 20) ? lines : null
    const fetchLyrist = async (): Promise<LrcLine[] | null> => {
      try {
        const r = await fetch(`https://lyrist.vercel.app/api/${encodeURIComponent(title)}/${encodeURIComponent(artist)}`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) return null
        const j = (await r.json()) as { lyrics?: string }
        return j.lyrics ? sane(parseLrc(j.lyrics)) : null
      } catch {
        return null
      }
    }
    const fetchTextyl = async (): Promise<LrcLine[] | null> => {
      try {
        const r = await fetch(`https://api.textyl.co/api/lyrics?q=${encodeURIComponent(`${artist} ${title}`)}`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) return null
        const j = (await r.json()) as Array<{ seconds?: number; lyrics?: string }>
        if (!Array.isArray(j)) return null
        const lines = j
          .filter((x): x is { seconds: number; lyrics: string } => typeof x.seconds === "number" && !!x.lyrics?.trim())
          .map((x) => ({ t: x.seconds, text: x.lyrics.trim() }))
        return sane(lines)
      } catch {
        return null
      }
    }
    // last resort — every synced source missed but someone carries the words.
    // Distribute plain lines across the runtime weighted by length so the
    // karaoke view (active line, auto-scroll, click-to-seek) still works
    // instead of a static wall; Shift+click still re-anchors if the guess drifts
    const pseudoSync = (plain: string): { synced: LrcLine[]; autoOff: number } | null => {
      const rows = plain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (rows.length < 2 || !dur) return null
      const lead = Math.min(12, dur * 0.08)
      const span = dur * 0.97 - lead
      const total = rows.reduce((s, l) => s + l.length, 0)
      let t = lead
      return {
        synced: rows.map((l) => {
          const line = { t, text: l }
          t += Math.max(1.2, (l.length / total) * span)
          return line
        }),
        autoOff: 0,
      }
    }
    void (async () => {
      const finish = (body: typeof lyrics) => {
        if (!live) return
        setLyrics(body)
        setLyricsTried(true)
        setLyricsLoading(false)
      }
      const lrclib = await fetchLrcLib()
      if (lrclib && "synced" in lrclib) return finish(lrclib)
      const lyrist = await fetchLyrist()
      if (lyrist) return finish({ synced: lyrist, autoOff: 0 })
      const textyl = await fetchTextyl()
      if (textyl) return finish({ synced: textyl, autoOff: 0 })
      // YouTube's own caption track — ASR exists for nearly every music
      // upload, so it's real timed words rather than our distributed guess
      const caps =
        current.source === "yt" && current.streamId
          ? await yt.captions(current.streamId).catch(() => null)
          : null
      const capLines = caps?.lines?.length ? sane(caps.lines) : null
      if (capLines) return finish({ synced: capLines, autoOff: 0 })
      // synced sources exhausted — assemble the best plain text, then fake-sync
      const ytRes =
        current.source === "yt" && current.streamId
          ? await yt.lyrics(current.streamId).catch(() => null)
          : null
      const plain =
        (lrclib && "plain" in lrclib ? lrclib.plain : null) ??
        ytRes?.lyrics ??
        (await fetchOvh())?.plain ??
        null
      finish(plain ? (pseudoSync(plain) ?? { plain }) : null)
    })()
    return () => {
      live = false
    }
  }, [showLyrics, lyricsTried, current])
  // hide the mic once we KNOW the track has no lyrics — but keep it while
  // the panel is open so it stays the user's way back to the artwork
  const hasLyrics = showLyrics || !lyricsTried || lyrics !== null

  if (!current) return null

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", stiffness: 260, damping: 32 }}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.45 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 160 || info.velocity.y > 700) setNpOpen(false)
      }}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg"
    >
      {/* adaptive gradient background */}
      <AnimatePresence>
        <motion.div
          key={current.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9 }}
          className="absolute inset-0"
          style={{
            background: `radial-gradient(110% 80% at 50% 0%, rgb(${rgb(color)} / 0.3), transparent 55%), linear-gradient(180deg, rgb(${rgb(color)} / 0.16), #0a0a0a 70%)`,
          }}
        />
      </AnimatePresence>
      <div className="absolute inset-0 backdrop-blur-3xl" />

      {/* pt-12 clears the frameless titlebar — without it the header buttons
          sit under the drag strip and the queue button's corner can hit the
          window's close control */}
      {/* window drag strip — the overlay covers every other drag region,
          so without this the window can't be moved while it's open */}
      <div className="drag-region absolute inset-x-0 top-0 z-20 h-12" />
      <div className="relative z-10 flex h-full flex-col px-6 pb-5 pt-12 sm:px-10">
        {/* header — grab here and drag down to dismiss, like mobile apps */}
        <div
          className="flex cursor-grab items-center active:cursor-grabbing"
          onPointerDown={(e) => dragControls.start(e)}
        >
          <button
            onClick={() => setNpOpen(false)}
            aria-label="Close"
            className="grid size-10 place-items-center rounded-full text-ink/80 transition hover:bg-white/10 hover:text-ink"
          >
            <ChevronDown size={22} />
          </button>
          <p className="flex-1 text-center text-[11px] font-semibold uppercase tracking-[0.35em] text-ink/60">
            Now playing
          </p>
          <button
            onClick={() => {
              setQueueOpen(true)
              setNpOpen(false)
            }}
            aria-label="Queue"
            className="grid size-10 place-items-center rounded-full text-ink/80 transition hover:bg-white/10 hover:text-ink"
          >
            <ListMusic size={19} />
          </button>
        </div>

        {/* artwork ↔ lyrics swap — same slot, springy crossfade. The lyrics
            branch is absolutely pinned to the slot: percentage heights fail
            against grid items, so inset-0 is the only bound that can't leak
            into the track meta below */}
        <div className="relative grid min-h-0 flex-1 place-items-center py-6">
          <AnimatePresence mode="wait" initial={false}>
            {showLyrics ? (
              <motion.div
                key="lyrics"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -14 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 flex flex-col items-center justify-center"
              >
                {lyricsLoading ? (
                  <Loader2 size={28} className="animate-spin text-ink/50" />
                ) : lyrics && "synced" in lyrics ? (
                  <div className="h-full w-[min(92vw,700px)] [mask-image:linear-gradient(180deg,transparent,black_10%,black_90%,transparent)]">
                    <SyncedLyrics lines={lyrics.synced} autoOff={lyrics.autoOff} />
                  </div>
                ) : lyrics ? (
                  <div className="scroller h-full w-[min(92vw,700px)] overflow-y-auto overscroll-contain px-2 [mask-image:linear-gradient(180deg,transparent,black_8%,black_92%,transparent)]">
                    <p className="whitespace-pre-line py-8 text-center text-lg font-medium leading-relaxed text-ink/90">
                      {lyrics.plain}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-ink/50">No lyrics found for this track.</p>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="art"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -14 }}
                transition={{ duration: 0.3 }}
              >
                <motion.div
                  layoutId="np-art"
                  animate={{ scale: isPlaying ? 1 : 0.95 }}
                  transition={{ type: "spring", stiffness: 260, damping: 30 }}
                  className="w-[min(52vh,400px)] overflow-hidden rounded-2xl shadow-2xl shadow-black/60"
                >
                  <ArtworkImg art={current.artwork} size="1000x1000" alt={current.title} className="aspect-square w-full" iconSize={64} />
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* meta + controls */}
        <div className="mx-auto w-full max-w-2xl pb-8">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <Marquee text={current.title} className="text-2xl font-bold" />
              <Link
                to={`/artist/${encodeURIComponent(current.user.id)}?n=${encodeURIComponent(current.user.name)}`}
                onClick={() => setNpOpen(false)}
                className="mt-1 block truncate text-base text-ink/60 transition hover:text-ink"
              >
                {current.user.name}
              </Link>
            </div>
            <div className="mb-1 flex shrink-0 items-center gap-3">
              {hasLyrics && (
                <button
                  onClick={() => setShowLyrics((v) => !v)}
                  aria-label="Lyrics"
                  aria-pressed={showLyrics}
                  className={`transition ${showLyrics ? "text-ink" : "text-ink/60 hover:text-ink"}`}
                >
                  <MicVocal size={22} />
                </button>
              )}
              <motion.button
                whileTap={{ scale: 1.3 }}
                onClick={() => toggleLike(current)}
                aria-label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
                aria-pressed={liked}
                className={`transition ${liked ? "text-ink" : "text-ink/60 hover:text-ink"}`}
              >
                <Heart size={24} className={liked ? "fill-current" : ""} />
              </motion.button>
            </div>
          </div>

          {/* isolated — the ~4Hz timeupdate subscription would otherwise
              re-render this whole overlay (incl. the blur layer) per tick */}
          <NpSeekBar trackDuration={current.duration} />

          <div className="mt-4 flex items-center justify-center gap-8">
            <button
              onClick={toggleShuffle}
              aria-label="Shuffle"
              aria-pressed={shuffle}
              className={`relative transition ${shuffle ? "text-ink" : "text-ink/60 hover:text-ink"}`}
            >
              <Shuffle size={20} />
              {shuffle && <span className="absolute -bottom-2 left-1/2 size-1 -translate-x-1/2 rounded-full bg-ink" />}
            </button>
            <button onClick={() => prev()} aria-label="Previous" className="text-ink/80 transition hover:text-ink">
              <SkipBack size={26} className="fill-current" />
            </button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={toggle}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="grid size-16 place-items-center rounded-full bg-white text-black shadow-xl transition hover:scale-105"
            >
              {buffering ? (
                <Loader2 size={26} className="animate-spin" />
              ) : isPlaying ? (
                <Pause size={26} className="fill-current" />
              ) : (
                <Play size={26} className="ml-1 fill-current" />
              )}
            </motion.button>
            <button onClick={() => next()} aria-label="Next" className="text-ink/80 transition hover:text-ink">
              <SkipForward size={26} className="fill-current" />
            </button>
            <button
              onClick={cycleRepeat}
              aria-label={repeat === "one" ? "Repeat: one" : repeat === "all" ? "Repeat: all" : "Repeat: off"}
              aria-pressed={repeat !== "off"}
              className={`relative transition ${repeat !== "off" ? "text-ink" : "text-ink/60 hover:text-ink"}`}
            >
              {repeat === "one" ? <Repeat1 size={20} /> : <Repeat size={20} />}
              {repeat !== "off" && (
                <span className="absolute -bottom-2 left-1/2 size-1 -translate-x-1/2 rounded-full bg-ink" />
              )}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function NpSeekBar({ trackDuration }: { trackDuration?: number }) {
  const currentTime = usePlayer((s) => s.currentTime)
  const duration = usePlayer((s) => s.duration)
  const seek = usePlayer((s) => s.seek)
  const dur = duration || trackDuration || 0
  return (
    <div className="mt-5">
      <Slider value={currentTime} max={dur} onCommit={(v) => seek(v)} smooth ariaLabel="Seek" />
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink/50">
        <span>{fmtDuration(currentTime)}</span>
        <span>{fmtDuration(dur)}</span>
      </div>
    </div>
  )
}
