import {
  ChevronDown, Heart, ListMusic, Loader2, MicVocal, Pause, Play,
  Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from "lucide-react"
import { AnimatePresence, motion, useDragControls } from "motion/react"
import { useEffect, useReducer, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useLibrary } from "../store/library"
import { usePlayer, applyVolume } from "../store/player"
import { yt, ytBridge } from "../api/youtube"
import { hasArtistPage } from "../api/types"
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

interface LrcRec {
  id?: number
  trackName?: string
  artistName?: string
  duration?: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

// accent/case/punctuation-insensitive normalize — uploaders write the same
// title a dozen ways; lyric DB records use yet another
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

// prefix match on a word boundary — "lluvia remix" starts with "lluvia",
// but "raindrops" must NOT count as matching "rain"
const starts = (a: string, b: string) => a.startsWith(b) && (a.length === b.length || a[b.length] === " ")

// loose title equality: containment either way or ≥70% word overlap —
// strict equality rejects the same song under a longer upload title
const titleLike = (a: string, b: string) => {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (starts(na, nb) || starts(nb, na)) return true
  const wa = new Set(na.split(" "))
  const wb = nb.split(" ").filter((w) => w.length > 1)
  return wb.length > 0 && wb.filter((w) => wa.has(w)).length / wb.length >= 0.7
}

// strip only NOISE tails — "(VIDEO OFICIAL)", "| BLESSD (VIDEO...)",
// "[Official Audio]" — while keeping meaningful "(feat. X)" groups: each
// trailing bracket/pipe group is removed only if it contains a noise
// keyword, so features survive and video cruft dies
const TITLE_NOISE = /video|oficial|official|lyric|letra|\baudio\b|visual|\bhd\b|\b4k\b|\bmv\b|explicit|live\b|cover\b|remaster/i
const cleanTitle = (s: string) => {
  let t = s.trim()
  for (let i = 0; i < 4; i++) {
    const m = /\s*(\([^(]*\)|\[[^\]]*\]|\|.*)$/.exec(t)
    if (!m || !TITLE_NOISE.test(m[1])) break
    t = t.slice(0, m.index).trim()
  }
  return t
}
// drops every bracket group + pipe tail — the "(feat. X)"-stripped retry
const stripGroups = (s: string) => s.replace(/\s*(\([^(]*\)|\[[^\]]*\])/g, "").replace(/\s*\|.*$/, "").trim()

// tokens in ANY script — \p{L} keeps Japanese/Cyrillic/etc. that norm()'s
// [a-z0-9] would strip to nothing, leaving those songs unalignable
const simTokens = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []

// char bigrams of the concatenated text — covers unsegmented scripts
// (Japanese/Chinese have no spaces → one token per line) and captions
// that merge two lyric rows into one cue
const simBigrams = (s: string): Set<string> => {
  const t = simTokens(s).join("")
  const b = new Set<string>()
  if (t.length === 1) b.add(t)
  for (let i = 0; i + 1 < t.length; i++) b.add(t.slice(i, i + 2))
  return b
}

const dice = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const x of a) if (b.has(x)) hit++
  return (2 * hit) / (a.size + b.size)
}

// word-Dice survives ASR mishearings; bigram-Dice survives script and
// granularity differences — take whichever reads the lines as more alike
const lineSim = (a: Set<string>, aBi: Set<string>, b: Set<string>, bBi: Set<string>) =>
  Math.max(dice(a, b), dice(aBi, bBi))

// ASR noise isn't a lyric — "[música]", "[Applause]", ">>" speaker markers —
// strip every bracketed marker from caption-derived text; marker-only cues
// become "" and get dropped
const capText = (t: string) => t.replace(/\[[^\]]*\]/g, " ").replace(/>+/g, "").replace(/\s+/g, " ").trim()

// A lyric DB's timestamps describe the studio recording; playback is THIS
// upload, whose video intro the record never saw. The video's own caption
// track is timed to our exact audio, so matching the first lyric lines
// against it measures the real lead-in. Captions are ASR-messy — a quorum
// of agreeing deltas is required so one bad match can't beat the duration
// guess it replaces. null = couldn't measure (keep the guess).
const alignOffset = (lrc: LrcLine[], caps: LrcLine[]): number | null => {
  // captions often split one lyric row across two cues — scoring against
  // line+next merged (bounded gap so distant rows can't fake a match)
  // keeps a granularity quirk from costing us a candidate
  const pool: { t: number; w: Set<string>; bi: Set<string> }[] = []
  for (let i = 0; i < caps.length; i++) {
    pool.push({ t: caps[i].t, w: new Set(simTokens(caps[i].text)), bi: simBigrams(caps[i].text) })
    const nx = caps[i + 1]
    if (nx && nx.t - caps[i].t < 4) {
      const text = `${caps[i].text} ${nx.text}`
      pool.push({ t: caps[i].t, w: new Set(simTokens(text)), bi: simBigrams(text) })
    }
  }
  const cands: number[] = []
  // two guards against hooky songs: a repeated line ("oh-eh" every 30s)
  // can latch onto a LATER chorus and manufacture a huge false offset.
  // (a) monotonic — caption time can only move forward as lyrics advance;
  // (b) plausible window — a record↔upload shift lives inside [-45, 120]s.
  // Prefer lines that appear ONCE in the sheet — unique lines can't latch
  // onto a repeated hook's other occurrences at all
  const head = lrc.slice(0, 14)
  const freq = new Map<string, number>()
  for (const l of head) {
    const k = simTokens(l.text).join(" ")
    freq.set(k, (freq.get(k) ?? 0) + 1)
  }
  const uniq = head.filter((l) => freq.get(simTokens(l.text).join(" ")) === 1)
  const sample = uniq.length >= 3 ? uniq : head
  // hooks can't vote — "Oh-eh, oh-eh"-type lines (≤3 distinct tokens) latch
  // onto chanted intro cues and measure the intro's own chant, not where the
  // real lyric line lands. Content-rich lines only when enough exist.
  const rich = sample.filter((l) => new Set(simTokens(l.text)).size >= 4)
  const voters = rich.length >= 3 ? rich : sample
  let lastT = -Infinity
  for (const l of voters) {
    const w = new Set(simTokens(l.text))
    const bi = simBigrams(l.text)
    let best = 0
    let bestT = 0
    for (const c of pool) {
      if (c.t < lastT - 1) continue
      const dt = c.t - l.t
      if (dt < -45 || dt > 120) continue
      const s = lineSim(w, bi, c.w, c.bi)
      if (s > best) {
        best = s
        bestT = c.t
      }
    }
    if (best < 0.55) continue
    // argmax picks the CLEANEST occurrence — for a repeated hook that's a
    // later chorus, which poisons the monotonic cursor for every line
    // after it. Any cue within 85% of the top score is an equivalent match;
    // take the EARLIEST of those instead
    let earlyT = bestT
    for (const c of pool) {
      const dt = c.t - l.t
      if (dt < -45 || dt > 120 || c.t >= earlyT) continue
      if (lineSim(w, bi, c.w, c.bi) >= best * 0.85) earlyT = c.t
    }
    cands.push(earlyT - l.t)
    lastT = earlyT
  }
  if (cands.length < 3) return null
  cands.sort((a, b) => a - b)
  // the true offset clusters within a few seconds (ASR cue jitter splits
  // tighter windows); wrong matches scatter
  let bi = 0
  let bn = 0
  for (let i = 0, j = 0; i < cands.length; i++) {
    while (j < cands.length && cands[j] - cands[i] <= 4) j++
    if (j - i > bn) {
      bi = i
      bn = j - i
    }
  }
  if (bn < Math.max(3, Math.ceil(cands.length * 0.4))) return null
  const off = Math.round(cands[bi + Math.floor(bn / 2)] * 10) / 10
  // >90s means the captions belong to a different structure, not an intro
  return Math.abs(off) <= 90 ? off : null
}

// One global offset fixes intros but NOT mid-song drift or per-line
// mistiming. Given captions for THIS structure, anchor every line to its
// best-matching cue inside a bounded window around (l.t + off) — per-line
// measured timing, monotonic by clamp so display order can never invert.
// Unmatched lines keep the global guess. Adopted only with real coverage.
const alignLines = (lrc: LrcLine[], caps: LrcLine[], off: number): LrcLine[] | null => {
  const pool: { t: number; w: Set<string>; bi: Set<string> }[] = []
  for (let i = 0; i < caps.length; i++) {
    pool.push({ t: caps[i].t, w: new Set(simTokens(caps[i].text)), bi: simBigrams(caps[i].text) })
    const nx = caps[i + 1]
    if (nx && nx.t - caps[i].t < 4) {
      const text = `${caps[i].text} ${nx.text}`
      pool.push({ t: caps[i].t, w: new Set(simTokens(text)), bi: simBigrams(text) })
    }
  }
  const out = lrc.map((l) => ({ ...l }))
  let anchored = 0
  let searchable = 0
  let prevT = -1e9
  for (const l of out) {
    const w = new Set(simTokens(l.text))
    if (w.size < 2) {
      l.t = Math.max(l.t + off, prevT + 0.05)
      prevT = l.t
      continue
    }
    searchable++
    const bi = simBigrams(l.text)
    const exp = l.t + off
    let best = 0
    let bestT = -1
    for (const c of pool) {
      if (c.t < exp - 4 || c.t > exp + 6) continue
      const s = lineSim(w, bi, c.w, c.bi)
      if (s > best) {
        best = s
        bestT = c.t
      }
    }
    l.t = Math.max(best >= 0.5 ? bestT : exp, prevT + 0.05)
    if (best >= 0.5) anchored++
    prevT = l.t
  }
  return anchored >= Math.max(4, Math.ceil(searchable * 0.45)) ? out : null
}

// A same-title WRONG SONG's sheet can slide past every metadata gate
// (identical runtime, artist word overlap) — alignOffset only judges
// timing, not content. The video's own captions are the ground truth:
// sample ~18 spread lines and ask whether their words appear in them at
// all. A real match hits repeatedly even through ASR noise; a foreign
// sheet barely matches anywhere.
const lrcContentOk = (lrc: LrcLine[], caps: LrcLine[]): boolean => {
  if (caps.length < 12) return true // too sparse to judge — don't veto on nothing
  const pool = caps.map((c) => ({ t: c.t, w: new Set(simTokens(c.text)), bi: simBigrams(c.text) }))
  const step = Math.max(1, Math.floor(lrc.length / 18))
  let hit = 0
  let n = 0
  for (let i = 0; i < lrc.length; i += step) {
    const l = lrc[i]
    const w = new Set(simTokens(l.text))
    const bi = simBigrams(l.text)
    let best = 0
    for (const c of pool) {
      const dt = c.t - l.t
      if (dt < -120 || dt > 180) continue
      const s = lineSim(w, bi, c.w, c.bi)
      if (s > best) best = s
    }
    n++
    if (best >= 0.45) hit++
  }
  return n === 0 || hit / n >= 0.34
}

// post-measure sanity: with the shift applied, sampled lines must land
// near their own caption match — a same-title upload with a different
// structure (longer intro, extra verse) can still quorum on hooky lines,
// and this is the check that rejects it
const timingOk = (lrc: LrcLine[], caps: LrcLine[], off: number): boolean => {
  if (caps.length < 8) return true // too sparse to verify — trust the quorum
  const pool = caps.map((c) => ({ t: c.t, w: new Set(simTokens(c.text)), bi: simBigrams(c.text) }))
  const step = Math.max(1, Math.floor(lrc.length / 14))
  let hit = 0
  let n = 0
  for (let i = 0; i < lrc.length; i += step) {
    const w = new Set(simTokens(lrc[i].text))
    const bi = simBigrams(lrc[i].text)
    // a line counts if ANY matching cue lands near the shifted position —
    // scoring the argmax occurrence only would false-reject repeated hooks
    let ok = false
    for (const c of pool) {
      if (Math.abs(c.t - (lrc[i].t + off)) > 7) continue
      if (lineSim(w, bi, c.w, c.bi) >= 0.45) {
        ok = true
        break
      }
    }
    n++
    if (ok) hit++
  }
  return n === 0 || hit / n >= 0.5
}

// sheet fingerprint — an offset persisted for one sheet must never slide
// a different one (content-veto swaps, a different fetch source later)
const sheetFpOf = (lines: LrcLine[]) =>
  simTokens(`${lines[0]?.text ?? ""} ${lines[1]?.text ?? ""}`).join(" ").slice(0, 48)

const lrcGet = async (path: string, p: Record<string, string>): Promise<LrcRec[]> => {
  try {
    const u = new URL(path, "https://lrclib.net")
    for (const [k, v] of Object.entries(p)) if (v) u.searchParams.set(k, v)
    const r = await fetch(u, { signal: AbortSignal.timeout(7000) })
    if (!r.ok) return []
    const j = (await r.json()) as LrcRec | LrcRec[]
    return (Array.isArray(j) ? j : [j]).filter(
      (x) => Boolean(x?.syncedLyrics?.trim()) || Boolean(x?.plainLyrics?.trim())
    )
  } catch {
    return []
  }
}

// live lyrics — active line bright, past lines dim, future lines faint;
// auto-scroll keeps the active line near the center. Isolated component so
// the 4 Hz clock only re-renders these lines, not the whole overlay.
// Click a line to seek to it; Shift+click pins THAT line to right now —
// a one-tap fix for versions whose LRC timestamps are offset. Persisted
// per track id so the correction survives restarts
function SyncedLyrics({ lines, autoOff }: { lines: LrcLine[]; autoOff: number }) {
  // The store clock ticks at ~4Hz (the element's timeupdate) — between
  // ticks a line can sit ~250ms behind the music, which reads as a laggy
  // highlight. Interpolate locally from the last tick while playing so
  // the active line lands on the syllable.
  const storeT = usePlayer((s) => s.currentTime)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const tick = useRef({ t: storeT, at: performance.now() })
  if (tick.current.t !== storeT) tick.current = { t: storeT, at: performance.now() }
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!isPlaying) return
    const h = setInterval(bump, 100)
    return () => clearInterval(h)
  }, [isPlaying])
  const t = tick.current.t + (isPlaying ? (performance.now() - tick.current.at) / 1000 : 0)
  const seek = usePlayer((s) => s.seek)
  const trackId = usePlayer((s) => s.current?.id)
  const [offset, setOffset] = useState(0)
  // saved manual correction beats the auto guess — the user knows best.
  // Both keys now carry a sheet fingerprint: an offset pinned to one sheet
  // must never slide a different one (content-veto swaps, later sources)
  const fp = sheetFpOf(lines)
  useEffect(() => {
    if (!trackId) return
    let saved: number | null = null
    try {
      // one-time purge — every pin/measured offset written before the
      // challengeable-pin fix is suspect (they were pinned while the
      // pipeline was still broken). Wipe once; fresh corrections persist
      if (!localStorage.getItem("lrcpin-purged-v2")) {
        for (const k of Object.keys(localStorage)) {
          if (/^lrcoff(a|2)?-/.test(k)) localStorage.removeItem(k)
        }
        localStorage.setItem("lrcpin-purged-v2", "1")
      }
      // lrcoff2- = manual (Shift+click); lrcoffa- = auto-measured —
      // both fingerprinted to their sheet; lrcoff- = v1 keys → purge
      const read = (k: string): number | null => {
        const raw = localStorage.getItem(k)
        if (raw === null) return null
        try {
          const p = JSON.parse(raw) as { o?: number; f?: string }
          if (typeof p === "object" && p !== null && typeof p.o === "number") {
            return p.f === undefined || p.f === fp ? p.o : null
          }
        } catch { /* bare number — legacy manual pin, trust it */ }
        return Number(raw) || 0
      }
      const manual = read(`lrcoff2-${trackId}`)
      let auto = read(`lrcoffa-${trackId}`)
      // an auto-persist ≈0 fighting a strong intro guess is the lyric-twin
      // lie's signature — it was measured on an upload that strips the
      // spoken intro. The modal-backed duration guess paints first; the
      // walk re-measures right after anyway.
      if (manual === null && auto !== null && Math.abs(auto) < 2 && Math.abs(autoOff) >= 5) {
        try { localStorage.removeItem(`lrcoffa-${trackId}`) } catch { /* ok */ }
        auto = null
      }
      saved = manual ?? auto
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("lrcoff") || k.startsWith("lrcaln"))
      for (const k of keys) {
        if (k.startsWith("lrcoff-")) localStorage.removeItem(k)
      }
      // cap the sets so a long-lived profile can't sprawl
      const kept = keys.filter((k) => k.startsWith("lrcoff2-") || k.startsWith("lrcoffa-") || k.startsWith("lrcaln-"))
      for (const k of kept.slice(0, Math.max(0, kept.length - 140))) localStorage.removeItem(k)
    } catch { /* storage unavailable — offsets just won't persist */ }
    setOffset(saved ?? autoOff)
  }, [trackId, autoOff, fp])
  const applyOffset = (v: number) => {
    const next = Math.max(-90, Math.min(90, Math.round(v * 10) / 10))
    setOffset(next)
    if (trackId) {
      try {
        localStorage.setItem(`lrcoff2-${trackId}`, JSON.stringify({ o: next, f: fp }))
        localStorage.removeItem(`lrcoffa-${trackId}`)
      } catch { /* quota/security — correction stays session-only */ }
    }
  }
  const adj = t - offset
  // small lookahead lands the highlight *on* the line being sung;
  // -1 while the intro still plays — nothing gets wrongly lit early
  let active = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= adj + 0.15) active = i
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
      <AnimatePresence />
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
              {i === active ? (() => {
                // karaoke word-fill: distribute the line's span across its
                // words — reads as word-level sync without word timings
                const words = l.text.split(/\s+/).filter(Boolean)
                if (words.length < 2) return l.text
                const nextT = lines[i + 1]?.t ?? l.t + 4
                const prog = Math.min(1, Math.max(0, (adj - l.t) / Math.max(0.4, nextT - l.t)))
                const lit = Math.floor(prog * words.length)
                return words.map((wd, wi) => (
                  <span key={wi} className={`transition-colors duration-150 ${wi <= lit ? "text-ink" : "text-ink/40"}`}>
                    {wd}{wi < words.length - 1 ? " " : ""}
                  </span>
                ))
              })() : l.text}
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
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  const liked = useLibrary((s) => (current ? Boolean(s.liked[current.id]) : false))
  const toggleLike = useLibrary((s) => s.toggleLike)

  // drag-to-close from the header only — attaching the gesture to the whole
  // sheet would fight the seek slider's pointer drags
  const dragControls = useDragControls()
  // dialog semantics need real focus handling: grab focus on open so SRs
  // announce it, hand it back on close so Tab doesn't land in a void
  const dlgRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dlgRef.current?.focus()
    return () => prev?.focus?.()
  }, [])
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
    // cleanTitle strips only NOISE tails — "(VIDEO OFICIAL)", "[Official
    // Audio]" — keeping meaningful "(feat. X)" groups; the stripped variant
    // drops every bracket for a bare-title retry when feature-tagged
    // queries come back empty
    const title = cleanTitle(current.title)
    const stripped = stripGroups(title)
    const titles = stripped && stripped !== title ? [title, stripped] : [title]
    // channel suffixes: " - Topic"/" - Official" need the dash (bare
    // "Topic"/"Official HIGE DANDism" are real artist names); VEVO is
    // stripped only in its shouty trailing form (ShakiraVEVO → Shakira)
    const artist = current.user.name
      .replace(/\s*[-–—]\s*(vevo|official|oficial|topic)\b.*$/i, "")
      .replace(/VEVO\s*$/, "")
      .trim()
    const dur = current.duration ?? 0
    // last-line sanity: a synced file whose last line lands way past our
    // track's end is for a different version — reject it rather than drift
    const sane = (lines: LrcLine[]) =>
      lines.length >= 4 && (!dur || lines[lines.length - 1].t <= dur + 20) ? lines : null
    // LRCLIB pools every candidate three query shapes return — the strict
    // artist+title search misses whenever the uploader isn't the canonical
    // artist ("Salsa Clasica", "X - Topic"), so fuzzy `q` and title-only
    // searches widen the net. Picks stay gated by title overlap + duration,
    // so a same-title different song can't slip through
    const lrcPool: LrcRec[] = []
    const lrcSeen = new Set<number>()
    const lrcAdd = (recs: LrcRec[]) => {
      for (const r of recs) {
        if (r.id != null) {
          if (lrcSeen.has(r.id)) continue
          lrcSeen.add(r.id)
        }
        lrcPool.push(r)
      }
    }
    // canonical-artist records sort first — a cover's lyrics can differ
    // even when the title matches
    const artistSim = (name?: string) => {
      const na = norm(artist)
      const nr = norm(name ?? "")
      if (!na || !nr) return 0
      if (na === nr || starts(na, nr) || starts(nr, na)) return 2
      const wa = new Set(na.split(" "))
      return nr.split(" ").some((w) => wa.has(w)) ? 1 : 0
    }
    const pickLrc = (ref: string): { synced: LrcLine[]; autoOff: number } | { plain: string } | null => {
      // closest duration wins — radio edits / deluxe versions have
      // different structure, so a wrong-duration pick puts every line
      // off by the intro's length
      const close = (x: LrcRec) => (dur && x.duration ? Math.abs(x.duration - dur) : 999)
      // wrong-song guard — generic titles ("Como Estás") pool dozens of
      // unrelated songs on LRCLIB, and title match alone used to let a
      // completely different track's lyrics through (a German rap record
      // surfaced on a Latin song this way). A zero-artist-overlap record
      // is only plausible when the runtime is nearly identical — same
      // recording under another crediting (a "Topic" channel vs the real
      // artist); anything looser is a different song and lyrics lose.
      const artistOk = (r: LrcRec) =>
        !artist ||
        artistSim(r.artistName) > 0 ||
        Boolean(dur && r.duration && Math.abs(r.duration - dur) <= 5)
      const cand = lrcPool.filter((r) => titleLike(r.trackName ?? "", ref) && artistOk(r))
      const by = (a: LrcRec, b: LrcRec) => artistSim(b.artistName) - artistSim(a.artistName) || close(a) - close(b)
      // outlier-duration trap: submitters sometimes tag a record with the
      // VIDEO's runtime while pasting the canonical (intro-less) sheet —
      // e.g. Dai Dai's 240s record carries timestamps that start singing at
      // 0.09s while the real upload has a ~19s spoken intro. Closest-duration
      // alone would pick that lying record and zero the autoOff guess.
      // When a tight plurality of records shares another duration, trust the
      // modal bucket instead — plurality means independently-timed agreement.
      const durBuckets = new Map<number, LrcRec[]>()
      for (const r of cand.filter((x) => x.syncedLyrics?.trim() && x.duration)) {
        const b = Math.round(r.duration!)
        durBuckets.set(b, [...(durBuckets.get(b) ?? []), r])
      }
      const modal = [...durBuckets.entries()].sort((a, b) => b[1].length - a[1].length)[0]
      const closestRec = cand.filter((r) => r.syncedLyrics?.trim()).sort(by)[0]
      const useModal =
        modal && modal[1].length >= 3 && closestRec
          ? Math.abs(Math.round(closestRec.duration ?? 0) - modal[0]) > 3 && dur > modal[0]
          : false
      const ordered = (useModal ? cand.filter((r) => r.syncedLyrics?.trim() && Math.round(r.duration ?? -1) === modal[0]) : cand.filter((r) => r.syncedLyrics?.trim())).sort(by)
      for (const rec of ordered) {
        const synced = sane(parseLrc(rec.syncedLyrics!))
        if (!synced) continue
        // auto-calibration: our version longer than the record usually
        // means the extra time is lead-in intro → shift lyrics later.
        // ±45 — a lyric-video intro easily exceeds the old ±15 clamp, and
        // caption alignment refines (or vetoes) the guess right after
        const g = dur && rec.duration ? Math.max(-45, Math.min(45, dur - rec.duration)) : 0
        return { synced, autoOff: Math.abs(g) >= 2.5 ? Math.round(g * 2) / 2 : 0 }
      }
      const plain = cand.filter((r) => r.plainLyrics?.trim()).sort(by)[0]?.plainLyrics?.trim()
      return plain ? { plain } : null
    }
    const fetchLrcLib = async (): Promise<{ synced: LrcLine[]; autoOff: number } | { plain: string } | null> => {
      for (const t of titles) {
        // the three query shapes race in parallel — same host, and a
        // synced hit short-circuits before the next title variant
        const [strict, fuzzy, byTitle] = await Promise.all([
          lrcGet("/api/search", { track_name: t, artist_name: artist }),
          lrcGet("/api/search", { q: `${artist} ${t}`.trim() }),
          lrcGet("/api/search", { track_name: t }),
        ])
        lrcAdd(strict)
        lrcAdd(fuzzy)
        lrcAdd(byTitle)
        const hit = pickLrc(t)
        if (hit && "synced" in hit) return hit
      }
      // /api/get is exact-match only but occasionally serves a record the
      // search ranking buried — one cheap shot with the primary title
      lrcAdd(await lrcGet("/api/get", { track_name: titles[0], artist_name: artist }))
      return titles.map(pickLrc).find((x) => x != null) ?? null
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
    // music where LRCLIB is thin), textyl returns timestamped lines directly
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
          // API order isn't guaranteed chronological — sane()'s last-line
          // check and the active-line early-exit both assume sorted input
          .sort((a, b) => a.t - b.t)
        return sane(lines)
      } catch {
        return null
      }
    }
    // the video we're ACTUALLY playing: direct for yt tracks; for Audius
    // the closest same-recording uploads. Twins must share title AND
    // artist AND near-identical duration — ±10 keeps mixes/clips/live
    // takes out (a wrong twin's captions are another song's words or a
    // different structure's timing). Uploads are iterated lazily: many
    // carry no caption track at all (proven on real videos), so alignment
    // and the caption fallback keep walking until one yields lines.
    const artistOkTwin = (t: { title?: string; user?: { name?: string } }) => {
      const a = norm(artist)
      if (!a) return true
      const ch = norm(t.user?.name ?? "")
      const ttl = ` ${norm(t.title ?? "")} `
      if (ch && (ch === a || starts(ch, a) || starts(a, ch))) return true
      return a.split(" ").some((w) => w.length > 2 && (ch.split(" ").includes(w) || ttl.includes(` ${w} `)))
    }
    const ownVid = current.source === "yt" ? current.streamId ?? null : null
    const twinQueries = [...new Set([`${artist} ${title}`.trim(), title, stripped].filter(Boolean))]
    const fits = (x: { streamId?: string; title: string; duration?: number; user?: { name?: string } }) =>
      !!x.streamId &&
      titleLike(x.title, title) &&
      // karaoke/cover/instrumental uploads pass title+artist but their
      // captions are a different recording's timing — never useful
      !/karaoke|cover|tribute|instrumental|in the style of/i.test(x.title) &&
      artistOkTwin(x) &&
      (!dur || !x.duration || Math.abs(x.duration - dur) <= 10)
    const byDur = <T extends { duration?: number }>(a: T, b: T) =>
      Math.abs((a.duration ?? 0) - dur) - Math.abs((b.duration ?? 0) - dur)
    // measuring offsets needs a wider gate than borrowing caption sheets:
    // an official-video reupload carries the intro INSIDE its duration —
    // the very lead-in we're trying to measure — so ±10 would exclude it
    const fitsLoose = (x: { streamId?: string; title: string; duration?: number; user?: { name?: string } }) =>
      !!x.streamId &&
      titleLike(x.title, title) &&
      // live shows & performances measure the SHOW's timeline (crowd
      // intro, stage banter), not the studio lead-in — "perform … at",
      // festival and award uploads all slip past a bare /live/ test
      !/karaoke|cover|tribute|instrumental|in the style of|live\b|en vivo|perform|concert|festival|award|ceremon|grammy|fifa|world cup|super bowl|halftime|fan ?cam|encore/i.test(x.title) &&
      artistOkTwin(x) &&
      (!dur || !x.duration || Math.abs(x.duration - dur) <= 30)
    // walk uploads lazily — ownVid first, then same-recording twins (music
    // catalog, then general YouTube for fan lyric videos). `alternates:false`
    // stops after ownVid — only the PLAYING upload can time this audio.
    // Caption probes run CONCURRENTLY per source (one yt-dlp call is ~3s —
    // serial probing burned 20-30s before a measurement could land).
    const forEachVideo = async (
      fn: (vid: string, own: boolean, meta: { title?: string } | undefined, cap: { lines: LrcLine[]; wordy?: number } | null) => Promise<boolean>,
      {
        alternates = true,
        alive = () => true,
        loose = false,
        budget = 6,
      }: { alternates?: boolean; alive?: () => boolean; loose?: boolean; budget?: number } = {},
    ) => {
      const seen = new Set<string>()
      let tried = 0
      const gate = loose ? fitsLoose : fits
      // lyric-titled uploads often strip the intro — measuring them first
      // would veto the real offset, so when measuring (loose) they go last
      const lyricish = (t: { title?: string }) => (/lyrics?|letra|lyric video/i.test(t.title ?? "") ? 1 : 0)
      const rank = (a: { title?: string; duration?: number }, b: { title?: string; duration?: number }) =>
        loose ? lyricish(a) - lyricish(b) || byDur(a, b) : byDur(a, b)
      const getCaps = (vid: string) => yt.captions(vid).catch(() => null)
      // batch-evaluate a candidate list: fetch all captions at once (bounded
      // by remaining budget), then walk the ranked results in order
      const batch = async (cands: { streamId?: string; title: string; duration?: number; user?: { name?: string } }[]) => {
        const fresh = cands.filter((t) => t.streamId && !seen.has(t.streamId))
        if (!fresh.length || !alive()) return false
        const room = Math.max(0, budget - tried)
        const slice = fresh.slice(0, room)
        for (const t of slice) seen.add(t.streamId!)
        tried += slice.length
        const caps = await Promise.all(slice.map((t) => getCaps(t.streamId!)))
        for (let i = 0; i < slice.length; i++) {
          if (!alive()) return true
          if (await fn(slice[i].streamId!, false, slice[i], caps[i])) return true
        }
        return tried > budget
      }
      if (ownVid && alive()) {
        seen.add(ownVid)
        tried++
        if (await fn(ownVid, true, undefined, await getCaps(ownVid))) return
      }
      if (!alternates) return
      // the playing upload's own related list — official-video reuploads
      // and lyric versions cluster there (same video family), which makes
      // it the cheapest source of same-structure captioned twins
      if (ownVid) {
        const rel = await yt.upNext(ownVid).catch(() => [] as { streamId?: string; title: string; duration?: number; user?: { name?: string } }[])
        const gated = rel.filter(gate).sort(rank)
        dbgL(`upnext: ${rel.length} hits, ${gated.length} pass gate`)
        if (await batch(gated)) return
      }
      for (const q of twinQueries) {
        if (!alive() || tried > budget) return
        const res = await yt.search(q).catch(() => null)
        const gated = (res?.tracks ?? []).filter(gate).sort(rank)
        dbgL(`search "${q}": ${res?.tracks?.length ?? 0} hits, ${gated.length} pass gate`)
        if (await batch(gated)) return
      }
      // the music catalog carries no captions on many official uploads —
      // general YouTube adds fan lyric videos (they nearly always ship
      // ASR/manual subs for the same recording). Bare-title queries come
      // first: they surface official-video reuploads (which KEEP the spoken
      // intro) while "… lyrics" queries only surface lyric videos (stripped
      // intro — useless as offset references).
      for (const q of [...new Set([`${artist} ${title}`, title, `${artist} ${title} official video`, `${artist} ${title} video oficial`, `${artist} ${title} lyrics`, `${title} lyrics`].filter((x) => x.trim() && x.trim() !== "lyrics"))]) {
        if (!alive() || tried > budget) return
        const vids = await yt.videoSearch(q).catch(() => [])
        const gated = vids.filter(gate).sort(rank)
        dbgL(`vsearch "${q}": ${vids.length} hits, ${gated.length} pass gate`)
        if (await batch(gated)) return
      }
    }
    // DB lyrics describe the studio take — a lyric video's intro shifts
    // every line early. Measure the real lead-in against the video's own
    // captions (walking alternates when the playing upload has none) and
    // nudge autoOff after the first paint rather than delay the render.
    // Auto offsets persist under lrcoffa- and re-verify every open — a
    // wrong measurement can't stick; a manual Shift+click always wins.
    const sheetFp = sheetFpOf
    const dbgL = (m: string) => window.freebify?.app?.log?.(`lyrics: ${m}`)
    const refineOffset = async (lrc: LrcLine[], fallback: number) => {
      const dbg = dbgL
      try {
        dbg(`enter src=${current.source} vid=${current.streamId ?? "?"} dur=${dur} lines=${lrc.length} fb=${fallback}`)
        if (!ytBridge()?.captions) return dbg("exit: no captions bridge")
        // can't use `live` — finish()'s setLyricsTried re-runs the effect
        // and its cleanup trips the flag while this measurement is still
        // in flight. The store + the synced-lines identity check below are
        // the real "is this still on screen" guard.
        const sameTrack = () => usePlayer.getState().current?.id === current.id
        if (!sameTrack()) return dbg("exit: not same track")
        // a manual Shift+click pin on THIS sheet is honored — but it is no
        // longer a veto on measurement: a pin saved while the pipeline was
        // buggy can pin the WRONG offset forever (this actually happened).
        // We still walk; only a strong measurement (own captions, a non-lyric
        // twin, or ≥2 agreeing twins) disagreeing by >3s overrides the pin.
        let pin: number | null = null
        try {
          const m = localStorage.getItem(`lrcoff2-${current.id}`)
          if (m !== null) {
            const p = JSON.parse(m) as { o?: number; f?: string } | number
            if (typeof p === "object" && p !== null && p.f !== undefined && p.f !== sheetFp(lrc))
              return dbg("exit: pin belongs to another sheet")
            pin = typeof p === "object" && p !== null && typeof p.o === "number" ? p.o : Number(m) || 0
          }
        } catch { /* unparsable — treat as present, still challengeable */ pin = 0 }
        // ownVid's captions are ground truth when they exist — but many
        // official uploads ship none, so twins may measure too. A twin's
        // offset describes ITS lead-in, so several are collected and only a
        // quorum-backed value commits; lyric/letra uploads are deprioritized
        // since they often strip the video's spoken intro.
        const measured: { off: number; caps: LrcLine[]; aligned: LrcLine[] | null }[] = []
        const lyricMeasured: number[] = []
        // spoken intros live in the upload's caption track but in NO lyric
        // DB — cues sitting before where the sheet's first line lands ARE
        // that intro; show them as lyric lines so the sheet covers what
        // the audio actually says. t<0 keeps display+seek math intact.
        // `edge` = where the sheet's first line lands in VIDEO time;
        // `shift` = the autoOff the display will use (0 once lines are
        // already video-absolute)
        const introLines = (caps: LrcLine[], edge: number, shift: number): LrcLine[] => {
          if (edge < 4) return []
          const out: LrcLine[] = []
          let lastK = ""
          for (const c of caps) {
            if (c.t >= edge) break
            const text = capText(c.text)
            const k = norm(text)
            if (k.length < 3 || k === lastK) continue
            lastK = k
            out.push({ t: c.t - shift, text })
            if (out.length >= 10) break
          }
          return out.length >= 2 ? out : []
        }
        // the displayed sheet may already be intro-prepended or per-line
        // aligned (new array !== lrc) — "same sheet" = tail still matches
        const sameSheet = (cur: { synced?: LrcLine[]; plain?: string } | null): boolean => {
          const s = cur?.synced
          if (!s) return false
          if (s === lrc) return true
          return s.length >= lrc.length && s[s.length - 1]?.text === lrc[lrc.length - 1]?.text
        }
        const persistAln = (aligned: LrcLine[], intro: LrcLine[]) =>
          setTimeout(() => {
            try {
              if (localStorage.getItem(`lrcoff2-${current.id}`) === null) {
                localStorage.setItem(
                  `lrcaln-${current.id}`,
                  JSON.stringify({ f: sheetFp(lrc), t: aligned.map((l) => l.t), i: intro.slice(0, 12) }),
                )
              }
            } catch { /* correction stays session-only */ }
          }, 4000)
        // per-line measured sheet — the "maximum expression" path: intro
        // lines at real cue times + every lyric line anchored to its cue
        const applyAligned = (aligned: LrcLine[], caps: LrcLine[]) => {
          const intro = introLines(caps, aligned[0]?.t - 0.8, 0)
          dbg(`aligned lines=${aligned.length} intro=${intro.length}`)
          setLyrics((cur) => (sameSheet(cur) ? { synced: intro.length ? [...intro, ...aligned] : aligned, autoOff: 0 } : cur))
          persistAln(aligned, intro)
        }
        const applyOff = (off: number, strong: boolean, caps?: LrcLine[]) => {
          if (Math.abs(off) > 90 || Math.abs(off - fallback) < 1.5) {
            dbg(`offset ${off.toFixed(1)} rejected (fallback ${fallback.toFixed(1)})`)
            return
          }
          if (pin !== null) {
            if (Math.abs(off - pin) <= 3) return dbg(`pin ${pin} agrees`)
            if (!strong) return dbg(`kept pin ${pin} over weak measurement ${off.toFixed(1)}`)
            dbg(`overrode pin ${pin} with measured ${off.toFixed(1)}`)
            try { localStorage.removeItem(`lrcoff2-${current.id}`) } catch { /* ok */ }
            pin = null
          }
          const intro = caps ? introLines(caps, (lrc[0]?.t ?? 0) + off - 0.8, off) : []
          dbg(`offset applied +${off.toFixed(1)}s intro=${intro.length}`)
          setLyrics((cur) => (sameSheet(cur) ? { synced: intro.length ? [...intro, ...lrc] : lrc, autoOff: off } : cur))
          // persist AFTER the note can surface (the render effect reads
          // keys when autoOff changes — writing first would suppress it);
          // a Shift+click meanwhile wins the key
          setTimeout(() => {
            try {
              if (localStorage.getItem(`lrcoff2-${current.id}`) === null) {
                localStorage.setItem(`lrcoffa-${current.id}`, JSON.stringify({ o: off, f: sheetFp(lrc) }))
              }
            } catch { /* correction stays session-only */ }
          }, 4000)
        }
        await forEachVideo(
          async (vid, own, meta, cap) => {
            if (!cap?.lines?.length || !sameTrack()) {
              dbg(`no captions: ${vid} own=${own}`)
              return false
            }
            dbg(`captions: ${vid} n=${cap.lines.length} "${(meta?.title ?? "").slice(0, 40)}"`)
            const clipped = cap.lines
              .map((l) => ({ t: l.t, text: capText(l.text) }))
              .filter((l) => l.text && (!dur || l.t <= dur + 15))
            // content veto: a same-title DIFFERENT song's sheet passes the
            // metadata gates but its words aren't in this audio — swap for
            // the captions, the right words by definition. Only ground truth
            // may overwrite: ownVid on yt, the stand-in twin on Audius.
            // The wordy gate stops a wrong-LANGUAGE ASR hallucination
            // (e.g. Spanish audio mislabeled en-orig) from vetoing a good
            // DB sheet — that transcript is noise, not a different song.
            if (!lrcContentOk(lrc, clipped) && clipped.length >= 4 && (cap.wordy ?? 1) >= 0.6) {
              if (ownVid && !own) return false
              setLyrics((cur) => (sameSheet(cur) ? { synced: clipped, autoOff: 0 } : cur))
              return true
            }
            const off = alignOffset(lrc, clipped)
            // a failed quorum here doesn't preclude the next upload
            if (off == null) return false
            // sanity before counting a vote: with the shift applied, sampled
            // lines must land near their own caption match — a twin whose
            // structure differs can still quorum on hooky lines
            if (!timingOk(lrc, clipped, off)) return false
            // per-line anchoring beats a global offset whenever coverage
            // allows — it survives drift, bad canonical lines, everything
            const aligned = alignLines(lrc, clipped, off)
            if (own) {
              if (aligned) applyAligned(aligned, clipped)
              else applyOff(off, true, clipped)
              return true
            }
            // lyric videos strip the video's spoken intro — their captions
            // time the canonical audio, so a measured ~0 from them is a LIE
            // for our upload. They never count toward quorum, never stop the
            // walk, and only serve as last resort when nothing else exists.
            const isLyric = /lyrics?|letra|lyric video/i.test(meta?.title ?? "")
            if (!isLyric) measured.push({ off, caps: clipped, aligned })
            else lyricMeasured.push(off)
            dbg(`measured ${off.toFixed(1)}s on ${vid} lyric=${isLyric}`)
            return measured.length >= 3
          },
          { alternates: true, alive: sameTrack, loose: true, budget: 11 },
        )
        dbg(`walk done measured=${measured.length} lyricOnly=${lyricMeasured.length} alive=${sameTrack()}`)
        if (!sameTrack()) return
        if (measured.length === 0) {
          // no real-structure twin found — a lyric-only pool beats nothing
          // ONLY when we have no duration guess to preserve; agreeing lyric
          // measurements ~0 must never erase a positive intro guess
          if (lyricMeasured.length === 0) return
          if (Math.abs(fallback) >= 1.5) return dbg(`kept fallback ${fallback.toFixed(1)} over lyric-only measurements`)
          lyricMeasured.sort((a, b) => a - b)
          applyOff(lyricMeasured[Math.floor(lyricMeasured.length / 2)], false)
          return
        }
        const clusters: number[][] = []
        for (const m of measured) {
          const c = clusters.find((c) => Math.abs(c[0] - m.off) <= 4)
          if (c) c.push(m.off)
          else clusters.push([m.off])
        }
        const win = clusters.sort((a, b) => b.length - a.length)[0]
        const off = win.slice().sort((a, b) => a - b)[Math.floor(win.length / 2)]
        // every vote here is non-lyric (lyric votes are quarantined above) —
        // a single real-structure upload is strong enough to override a pin
        const winner = measured.find((m) => win.includes(m.off))
        if (winner?.aligned) applyAligned(winner.aligned, winner.caps)
        else applyOff(off, true, winner?.caps)
      } catch { /* best-effort — the unaligned lyrics still display */ }
    }
    // YouTube's own captions as the synced catch-all — ASR tracks exist for
    // nearly every music upload; alternates cover the ones that don't
    const fetchCaptions = async (): Promise<LrcLine[] | null> => {
      try {
        if (!ytBridge()?.captions) return null
        let out: LrcLine[] | null = null
        await forEachVideo(
          async (vid, _own, _meta, cap) => {
            if (!cap?.lines?.length) {
              dbgL(`capsheet: none on ${vid}`)
              return false
            }
            dbgL(`capsheet: ${cap.lines.length} lines on ${vid}`)
            // captions run to the video's end — clip to the track's runtime
            // so a longer upload's outro chatter can't tail the lyric sheet
            out = sane(cap.lines.map((l) => ({ t: l.t, text: capText(l.text) })).filter((l) => l.text && (!dur || l.t <= dur + 15)))
            return out != null
          },
          { alive: () => live },
        )
        return out
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
        // a previously per-line-aligned sheet for THIS song+sheet fingerprint
        // paints perfectly on first frame — the walk re-verifies behind it.
        // Same lyric-twin lie guard as the auto-offset persist: stored times
        // ≈canonical against a strong intro guess means the alignment was
        // measured on an intro-stripped upload → drop it.
        if (body && "synced" in body && body.autoOff !== undefined) {
          try {
            const raw = localStorage.getItem(`lrcaln-${current.id}`)
            const p = raw ? (JSON.parse(raw) as { f?: string; t?: number[]; i?: LrcLine[] }) : null
            if (p?.f === sheetFp(body.synced) && p.t?.length === body.synced.length) {
              const isLie = Math.abs((p.t[0] ?? 0) - (body.synced[0]?.t ?? 0)) < 2 && body.autoOff >= 5
              if (isLie) localStorage.removeItem(`lrcaln-${current.id}`)
              else body = { synced: [...(p.i ?? []), ...body.synced.map((l, i) => ({ ...l, t: p.t![i] }))], autoOff: 0 }
            }
          } catch { /* fall through to unaligned sheet */ }
        }
        dbgL(`sheet: ${body === null ? "none" : "plain" in body ? "plain" : `synced n=${body.synced.length} first=${body.synced[0]?.t.toFixed(1)} last=${body.synced[body.synced.length - 1]?.t.toFixed(1)} off=${"autoOff" in body ? body.autoOff : "?"}`} src=${current.source} vid=${current.streamId ?? "?"} dur=${dur}`)
        setLyrics(body)
        setLyricsTried(true)
        setLyricsLoading(false)
      }
      // YTM's own timed lyrics first — official LyricFind data bound to this
      // exact videoId, so no wrong-song search risk at all. Timing is still
      // the canonical recording's, so the intro-offset layer stays on top.
      if (current.source === "yt" && current.streamId) {
        const timed = await yt.timedLyrics(current.streamId).catch(() => null)
        const timedLines = timed?.lines ? sane(timed.lines) : null
        if (timedLines) {
          window.freebify?.app?.log?.(`lyrics: ytm timed source — ${timedLines.length} lines`)
          void refineOffset(timedLines, 0)
          return finish({ synced: timedLines, autoOff: 0 })
        }
      }
      const lrclib = await fetchLrcLib()
      if (lrclib && "synced" in lrclib) {
        void refineOffset(lrclib.synced, lrclib.autoOff)
        return finish(lrclib)
      }
      // lyrist + textyl race in parallel — independent hosts, no reason to
      // pay two timeouts serially when a song is missing from both
      const [lyrist, textyl] = await Promise.all([fetchLyrist(), fetchTextyl()])
      if (lyrist) {
        void refineOffset(lyrist, 0)
        return finish({ synced: lyrist, autoOff: 0 })
      }
      if (textyl) {
        void refineOffset(textyl, 0)
        return finish({ synced: textyl, autoOff: 0 })
      }
      // lyric databases exhausted — YouTube captions (ASR included) are the
      // coverage net: virtually every song has SOME captioned upload
      const caps = await fetchCaptions()
      if (caps) return finish({ synced: caps, autoOff: 0 })
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
      ref={dlgRef}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      tabIndex={-1}
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
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg outline-none"
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
          so without this the window can't be moved while it's open.
          right-[140px] clears the floating window controls — a drag region
          under them swallows their clicks at the native hit-test level */}
      <div className="drag-region absolute left-0 right-[140px] top-0 z-20 h-12" />
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
          <p className="flex-1 text-center text-xs font-semibold text-ink/50">
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
                {/* ambient artwork wash behind the lyric column — without it
                    the panel reads as flat black with text floating in a void */}
                {current.artwork && (
                  <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.17] blur-3xl saturate-[0.8]">
                    <ArtworkImg art={current.artwork} size="1000x1000" className="size-full scale-125" />
                  </div>
                )}
                {lyricsLoading ? (
                  <Loader2 size={28} className="animate-spin text-ink/50" />
                ) : lyrics && "synced" in lyrics ? (
                  <div className="h-full w-[min(92vw,840px)] [mask-image:linear-gradient(180deg,transparent,black_10%,black_90%,transparent)]">
                    <SyncedLyrics lines={lyrics.synced} autoOff={lyrics.autoOff} />
                  </div>
                ) : lyrics ? (
                  <div className="scroller h-full w-[min(92vw,840px)] overflow-y-auto overscroll-contain px-2 [mask-image:linear-gradient(180deg,transparent,black_8%,black_92%,transparent)]">
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
          <div className="relative flex items-end justify-between gap-4">
            {showLyrics ? (
              <div className="flex min-w-0 items-center gap-3">
                <ArtworkImg
                  art={current.artwork}
                  size="150x150"
                  alt=""
                  className="mb-0.5 size-12 shrink-0 rounded-md shadow-lg shadow-black/40"
                  iconSize={20}
                />
                <div className="min-w-0">
                  <Marquee text={current.title} className="text-2xl font-bold" />
                  {hasArtistPage(current.user) ? (
                    <Link
                      to={`/artist/${encodeURIComponent(current.user.id)}?n=${encodeURIComponent(current.user.name)}`}
                      onClick={() => setNpOpen(false)}
                      className="mt-1 block truncate text-base text-ink/60 transition hover:text-ink"
                    >
                      {current.user.name}
                    </Link>
                  ) : (
                    <span className="mt-1 block truncate text-base text-ink/60">{current.user.name}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="pointer-events-none absolute inset-x-20 bottom-0 min-w-0 text-center">
                <Marquee text={current.title} className="text-2xl font-bold" />
                {hasArtistPage(current.user) ? (
                  <Link
                    to={`/artist/${encodeURIComponent(current.user.id)}?n=${encodeURIComponent(current.user.name)}`}
                    onClick={() => setNpOpen(false)}
                    className="pointer-events-auto mt-1 inline-block max-w-full truncate text-base text-ink/60 transition hover:text-ink"
                  >
                    {current.user.name}
                  </Link>
                ) : (
                  <span className="mt-1 block truncate text-base text-ink/60">{current.user.name}</span>
                )}
              </div>
            )}
            <div className="relative z-10 mb-1 ml-auto flex shrink-0 items-center gap-3">
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

          <div className="relative mt-4 flex items-center justify-center gap-8">
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
            <div className="absolute right-0 flex items-center gap-2">
              <button onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} className="text-ink/60 transition hover:text-ink">
                <VolumeIcon size={20} />
              </button>
              <Slider
                value={volume}
                max={1}
                onScrub={applyVolume}
                onCommit={(v) => setVolume(v)}
                className="w-24"
                ariaLabel="Volume"
              />
            </div>
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
