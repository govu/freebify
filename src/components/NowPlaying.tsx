import {
  ChevronDown, Heart, ListMusic, Loader2, MicVocal, Pause, Play,
  Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from "lucide-react"
import { AnimatePresence, motion, useDragControls } from "motion/react"
import { memo, useCallback, useEffect, useReducer, useRef, useState, type MouseEvent } from "react"
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
  if (!na || !nb) {
    // non-Latin scripts normalize to "" — fall back to the unicode-aware
    // tokenizer (keeps CJK/Cyrillic) or the whole pipeline dies for them
    const ta = simTokens(a).join(" ")
    const tb = simTokens(b).join(" ")
    return !!ta && !!tb && (ta.includes(tb) || tb.includes(ta))
  }
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
  // (b) plausible window — the match window can't be a constant: cinematic
  //   intros run minutes (MONACO ≈ +170s before the first sung word). The
  //   latest a line can land is bounded by the caption span itself — the
  //   last cue marks the end of the audio.
  const maxOff = Math.max(120, (caps[caps.length - 1]?.t ?? 120) - (lrc[0]?.t ?? 0) - 10)
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
      if (dt < -45 || dt > maxOff) continue
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
      // same monotonic guard as the main scan — an earlier equivalent match
      // that regresses the cursor poisons every voter after it
      if (c.t < lastT - 1 || dt < -45 || dt > maxOff || c.t >= earlyT) continue
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
  // beyond the caption span there is no audio left to shift into — but a
  // multi-minute cinematic intro is a legitimate measured offset
  return off >= -45 && off <= maxOff ? off : null
}

// One global offset fixes intros but NOT mid-song structural divergence —
// sheets can omit a verse section entirely (Calm Down drops ~15s of verse
// between "chewing gum" and the chorus) or the upload adds/removes one.
// A narrow window around the global guess can never recover those lines.
// Instead each line anchors inside a wide FORWARD-leaning window while a
// running offset tracks the local drift: a dropped section makes the audio
// land later than expected, so we look farther ahead than behind.
// The distance penalty keeps repeated hooks honest — a far cue must be
// clearly more similar to beat a near one. Monotonic by prevT clamp.
// Adopted only with real coverage.
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
  let prevOrig = 0
  let runOff = off
  // a distant anchor is a claim that the structure jumped — a REAL jump
  // (Telephone's +74s dialogue break) keeps holding for the following
  // lines; a repeated hook's later occurrence does not. Before accepting a
  // far anchor we check the next searchable line has SOME match near the
  // implied new offset — otherwise the "anchor" drags the monotonic floor
  // forward and strands every line after it (Calm Down: a chorus text at
  // +82s pulled 20 lines into a wall).
  const confirmedFar = (idx: number, localOff: number): boolean => {
    for (let j = idx + 1; j < lrc.length; j++) {
      const w2 = new Set(simTokens(lrc[j].text))
      if (w2.size < 2) continue
      const bi2 = simBigrams(lrc[j].text)
      const exp2 = lrc[j].t + localOff
      for (const c of pool) {
        if (Math.abs(c.t - exp2) > 12) continue
        if (lineSim(w2, bi2, c.w, c.bi) >= 0.45) return true
      }
      return false // next searchable line has no match near the new offset
    }
    return true // nothing left to contradict
  }
  for (let li = 0; li < out.length; li++) {
    const l = out[li]
    const orig = l.t
    const w = new Set(simTokens(l.text))
    if (w.size < 2) {
      l.t = Math.max(orig + runOff, prevT + Math.max(0.05, orig - prevOrig))
      prevT = l.t
      prevOrig = orig
      continue
    }
    searchable++
    const bi = simBigrams(l.text)
    const exp = orig + runOff
    let bestT = -1
    let bestAdj = 0
    for (const c of pool) {
      // forward-leaning window: a dropped sheet section pushes audio late —
      // videos also INSERT mid-song breaks (Telephone sticks ~74s of dialogue
      // between verses), so the far bound must reach past those; radio-edit
      // uploads CUT sections instead, dragging later lines up to ~40s early.
      // Similarity demand scales with distance: mid-range tolerates noisy
      // ASR, truly far anchors need strong text agreement AND confirmation.
      const lo = Math.max(exp - 40, prevT)
      if (c.t < lo || c.t > exp + 90) continue
      const s = lineSim(w, bi, c.w, c.bi)
      const dist = Math.abs(c.t - exp)
      if (s < (dist > 45 ? 0.68 : dist > 25 ? 0.55 : 0.5)) continue
      const adj = s - 0.015 * dist
      if (adj > bestAdj || bestT < 0) {
        bestAdj = adj
        bestT = c.t
      }
    }
    if (bestT >= 0 && Math.abs(bestT - exp) > 30 && !confirmedFar(li, bestT - orig)) {
      bestT = -1 // unconfirmed structural jump — keep natural spacing
    }
    if (bestT >= 0) {
      // local evidence nudges the running offset — clamped per-step so one
      // stray match can't swing the expectation, but a real structural
      // jump is absorbed within a few anchored lines
      const localOff = bestT - orig
      runOff += Math.max(-15, Math.min(15, localOff - runOff)) * 0.5
      l.t = bestT
      anchored++
    } else {
      // keep the line's natural spacing from its predecessor instead of
      // collapsing onto it — unanchored stretches (sparse ASR tails, sheet
      // holes) would otherwise stack a burst of lines at one timestamp
      l.t = Math.max(exp, prevT + Math.max(0.05, orig - prevOrig))
    }
    prevT = l.t
    prevOrig = orig
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
  const maxDt = Math.max(180, (caps[caps.length - 1]?.t ?? 0) - (lrc[0]?.t ?? 0) - 10)
  const step = Math.max(1, Math.floor(lrc.length / 18))
  let hit = 0
  let n = 0
  for (let i = 0; i < lrc.length; i += step) {
    const l = lrc[i]
    const w = new Set(simTokens(l.text))
    const bi = simBigrams(l.text)
    let best = 0
    for (const c of pool) {
      // same bound as alignOffset: cinematic intros run minutes, so the
      // sheet's real words can sit hundreds of seconds ahead of their
      // canonical time — a fixed +180 vetoes CORRECT sheets on long-intro
      // uploads and swaps them for raw caption text
      const dt = c.t - l.t
      if (dt < -120 || dt > maxDt) continue
      const s = lineSim(w, bi, c.w, c.bi)
      if (s > best) best = s
    }
    n++
    if (best >= 0.45) hit++
  }
  return n === 0 || hit / n >= 0.34
}

// post-measure sanity: with the shift applied, sampled lines should land
// near their own caption match. But ASR/manually-captioned tracks go sparse
// or idiosyncratic mid-song (pidgin spellings, merged cues, "♪" markers) —
// requiring EVERY line to match nearby false-vetoes correct measurements.
// A line only counts AGAINST the offset when it strongly matches a cue FAR
// from its expected position — a real contradiction. Weak/absent matches
// abstain; they're noise, not evidence.
const timingOk = (lrc: LrcLine[], caps: LrcLine[], off: number): boolean => {
  if (caps.length < 8) return true // too sparse to verify — trust the quorum
  const pool = caps.map((c) => ({ t: c.t, w: new Set(simTokens(c.text)), bi: simBigrams(c.text) }))
  const step = Math.max(1, Math.floor(lrc.length / 14))
  let hit = 0
  let miss = 0
  for (let i = 0; i < lrc.length; i += step) {
    const w = new Set(simTokens(lrc[i].text))
    const bi = simBigrams(lrc[i].text)
    let near = 0
    let far = 0
    for (const c of pool) {
      const s = lineSim(w, bi, c.w, c.bi)
      if (Math.abs(c.t - (lrc[i].t + off)) <= 7) {
        if (s > near) near = s
      } else if (s > far) far = s
    }
    if (near >= 0.45) hit++
    else if (far >= 0.62) miss++
  }
  const votes = hit + miss
  return votes < 4 || hit / votes >= 0.5
}

// display-only "♪" markers inside real sung gaps: a sheet that omits a
// section (Calm Down drops a ~15s verse) otherwise leaves its previous line
// lit through music it has no words for — the marker shows the song still
// moves. Only where a caption carries actual words; instrumental breaks
// stay empty. Never persisted — aligned times stay sheet-length for lrcaln.
const gapMarkers = (lines: LrcLine[], caps: LrcLine[]): LrcLine[] => {
  const out: LrcLine[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const nx = lines[i + 1]
    if (!nx) break
    if (nx.t - lines[i].t < 10) continue
    let last = lines[i].t
    let placed = 0
    for (const c of caps) {
      if (placed >= 3 || c.t >= nx.t - 2) break
      if (c.t <= last + 7) continue
      if (simTokens(c.text).length < 3) continue
      out.push({ t: c.t, text: "♪" })
      last = c.t
      placed++
    }
  }
  return out
}

// sheet fingerprint — an offset persisted for one sheet must never slide
// a different one (content-veto swaps, a different fetch source later).
// Tail-text only: prepended spoken-intro lines would otherwise change the
// fingerprint mid-session and orphan pins/offsets made on the raw sheet.
const sheetFpOf = (lines: LrcLine[]) =>
  simTokens(
    lines
      .filter((l) => l.text !== "♪") // display markers aren't sheet content
      .slice(-3)
      .map((l) => l.text)
      .join(" ")
  )
    .join(" ")
    .slice(0, 64)

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
// memoized row — the 10fps lyric clock ticks the whole list, but only the
// row whose active/past flag changed re-renders (Spotify-style: the whole
// line lights up — no word fill, no scale)
const LineRow = memo(function LineRow({
  i,
  l,
  active,
  past,
  onTap,
}: {
  i: number
  l: LrcLine
  active: boolean
  past: boolean
  onTap: (e: MouseEvent<HTMLButtonElement>, l: LrcLine) => void
}) {
  return (
    <button
      data-l={i}
      onClick={(e) => onTap(e, l)}
      title="Click to jump · Shift+click to sync this line to now"
      className={`block w-full cursor-pointer px-4 py-2.5 text-2xl font-bold leading-snug transition-colors duration-150 ease-out md:text-3xl ${
        active ? "text-ink" : past ? "text-ink/45 hover:text-ink/70" : "text-ink/25 hover:text-ink/50"
      }`}
    >
      {l.text}
    </button>
  )
})

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
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
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
    // ±90 used to be the sane bound — then MONACO shipped a +173s intro;
    // a user pinning a cinematic lead-in needs the full plausible range
    const next = Math.max(-90, Math.min(300, Math.round(v * 10) / 10))
    setOffset(next)
    if (trackId) {
      try {
        localStorage.setItem(`lrcoff2-${trackId}`, JSON.stringify({ o: next, f: fp }))
        localStorage.removeItem(`lrcoffa-${trackId}`)
      } catch { /* quota/security — correction stays session-only */ }
    }
  }
  const adj = t - offset
  // refs feed the click handler so memoized rows never close over a stale
  // clock — a Shift+click pin must read "now", not render-time
  const live = useRef({ adj, offset })
  live.current = { adj, offset }
  const applyOffsetRef = useRef(applyOffset)
  applyOffsetRef.current = applyOffset
  const onLineTap = useCallback(
    (e: React.MouseEvent, l: LrcLine) => {
      if (e.shiftKey) applyOffsetRef.current(live.current.adj + live.current.offset - l.t)
      else seek(l.t + live.current.offset)
    },
    [seek]
  )
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
  const scrollAnim = useRef(0)
  useEffect(() => {
    const sc = listRef.current
    if (!sc) return
    const mark = () => {
      userScrollUntil.current = Date.now() + 5000
      cancelAnimationFrame(scrollAnim.current)
    }
    sc.addEventListener("wheel", mark)
    sc.addEventListener("touchmove", mark, { passive: true })
    return () => {
      sc.removeEventListener("wheel", mark)
      sc.removeEventListener("touchmove", mark)
    }
  }, [lines.length])
  useEffect(() => () => cancelAnimationFrame(scrollAnim.current), [])
  useEffect(() => {
    const sc = listRef.current
    const el = active >= 0 ? sc?.querySelector<HTMLElement>(`[data-l="${active}"]`) : undefined
    if (!sc) return
    // browser "smooth" scroll takes ~500ms — the active line visibly lags
    // the music. A 220ms ease-out glide reads as instant but not jumpy.
    const glide = (top: number) => {
      cancelAnimationFrame(scrollAnim.current)
      const from = sc.scrollTop
      const d = top - from
      if (Math.abs(d) < 2) return void (sc.scrollTop = top)
      const t0 = performance.now()
      const dur = 220
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / dur)
        const e = 1 - Math.pow(1 - p, 3)
        sc.scrollTop = from + d * e
        if (p < 1) scrollAnim.current = requestAnimationFrame(step)
      }
      scrollAnim.current = requestAnimationFrame(step)
    }
    if (!el) {
      // intro: park the view at the first line instead of a phantom scroll
      if (Date.now() >= userScrollUntil.current) {
        cancelAnimationFrame(scrollAnim.current)
        sc.scrollTop = 0
      }
      return
    }
    if (Date.now() < userScrollUntil.current) return
    // rect-based target: offsetTop chains break on the absolutely-positioned
    // overlay ancestor; this measures real viewport distance + scrollTop
    const target = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight / 2 + el.offsetHeight / 2
    glide(target)
  }, [active])
  return (
    <div className="relative h-full w-full">
      {/* transient notice when auto-calibration kicked in — tells the user
          the lyrics were nudged without adding permanent chrome */}
      <AnimatePresence />
      <div ref={listRef} className="scroller h-full w-full overflow-y-auto px-8 text-center">
        <div className="py-[38vh]">
          {lines.map((l, i) => (
            <LineRow
              key={i}
              i={i}
              l={l}
              active={i === active}
              past={i < active}
              onTap={onLineTap}
            />
          ))}
        </div>
      </div>
      <p className="pointer-events-none absolute bottom-2 left-0 right-0 text-center text-[11px] font-normal tracking-wide text-ink/25">
        Lyrics may not be accurate
      </p>
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
    const pickLrc = (ref: string): { synced: LrcLine[]; autoOff: number; alts?: LrcLine[][] } | { plain: string } | null => {
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
      // alternate sheets ride along — transcribers disagree on both timing
      // AND text; when the top record can't line-anchor to the video's
      // captions (pidgin written differently, omitted verse), a sibling
      // record often can (Calm Down: the canonical record anchors 16/48,
      // the alternate anchors all 52)
      const alts: LrcLine[][] = []
      for (const rec of ordered) {
        const synced = sane(parseLrc(rec.syncedLyrics!))
        if (!synced) continue
        if (alts.length > 0) {
          // true duplicates only — records sharing text but carrying a
          // different timeline (or vice versa) are genuinely useful alts
          const sig = (a: LrcLine[]) => a.map((l) => `${l.t}:${l.text}`).join()
          if (alts.length < 3 && !alts.some((a) => sig(a) === sig(synced))) alts.push(synced)
          continue
        }
        // auto-calibration: our version longer than the record usually
        // means the extra time is lead-in intro → shift lyrics later.
        // The duration field can flat-out LIE: submitters tag a record with
        // the VIDEO's runtime while pasting canonical timestamps (MONACO:
        // dur=440 but the sheet's last line is at 253s — the canonical
        // audio is ~265s, so the real intro is ~+175, not the 0 a naive
        // diff reports). The record's own timeline is the truth — when the
        // duration field contradicts it by >25s, distrust the field.
        const selfEst = (synced[synced.length - 1]?.t ?? 0) + 12
        const estRecDur =
          rec.duration && Math.abs(rec.duration - selfEst) <= 25
            ? Math.max(rec.duration, selfEst)
            : selfEst
        // positive guess is bounded by where the sheet must still fit in
        // this video (cinematic intros run minutes — MONACO ≈ +173), not
        // by a fixed +30 that can never reach them. Negative guesses stay
        // tight: an overshooting sheet means the upload cut SOMETHING, and
        // trimmed outros are far more common than trimmed intros — without
        // a measurement a big negative shift is a coin flip we'd lose half.
        const g = dur && estRecDur ? Math.max(-15, Math.min(dur - selfEst - 5, dur - estRecDur)) : 0
        alts.push(synced) // index 0 = the chosen sheet — keeps the loop simple
        return { synced, autoOff: Math.abs(g) >= 2.5 ? Math.round(g * 2) / 2 : 0, alts }
      }
      const plain = cand.filter((r) => r.plainLyrics?.trim()).sort(by)[0]?.plainLyrics?.trim()
      return plain ? { plain } : null
    }
    const fetchLrcLib = async (): Promise<{ synced: LrcLine[]; autoOff: number; alts?: LrcLine[][] } | { plain: string } | null> => {
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
    // QQ Music direct — Tencent's catalog is huge where LRCLIB/lyrist run
    // thin (Latin/Asian/regional). Candidates get the same gates as LRCLIB
    // records; all parseable sheets come back as alignment alternates
    const fetchQq = async (): Promise<LrcLine[][] | null> => {
      for (const t of titles) {
        const cands = await yt.qqLyrics(`${artist} ${t}`.trim()).catch(() => null)
        if (!Array.isArray(cands) || !cands.length) continue
        const sheets = cands
          .filter((c) => typeof c?.lyrics === "string")
          .filter((c) => titleLike(c.trackName ?? "", t))
          .filter((c) => !artist || artistSim(c.artistName) > 0 || Boolean(dur && c.duration && Math.abs(c.duration - dur) <= 5))
          .map((c) => {
            const lines = parseLrc(c.lyrics)
            // QQ prepends a "[00:00.00] Title - Artist" card — as a lyric
            // line it shows the song name before anything is sung
            const card = norm(`${c.trackName} ${c.artistName?.split(",")[0] ?? ""}`).trim()
            while (lines.length && lines[0].t < 3 && [card, norm(c.trackName ?? "")].includes(norm(lines[0].text))) lines.shift()
            return sane(lines)
          })
          .filter((s): s is LrcLine[] => Boolean(s))
        if (dur) sheets.sort((a, b) => Math.abs(a[a.length - 1].t + 12 - dur) - Math.abs(b[b.length - 1].t + 12 - dur))
        if (sheets.length) return sheets
      }
      return null
    }
    // Musixmatch — the same timed-lyrics catalog Spotify displays (anonymous
    // client API). Human-curated timing: best-quality sheet when it hits.
    const fetchMxm = async (): Promise<LrcLine[][] | null> => {
      for (const t of titles) {
        const cands = await yt.mxmLyrics(t, artist).catch(() => null)
        if (!Array.isArray(cands) || !cands.length) continue
        const sheets = cands
          .filter((c) => typeof c?.lyrics === "string")
          .filter((c) => titleLike(c.trackName ?? "", t))
          .filter((c) => !artist || artistSim(c.artistName) > 0 || Boolean(dur && c.duration && Math.abs(c.duration - dur) <= 5))
          .map((c) => {
            const lines = parseLrc(c.lyrics)
            const card = norm(`${c.trackName} ${c.artistName?.split(",")[0] ?? ""}`).trim()
            while (lines.length && lines[0].t < 3 && [card, norm(c.trackName ?? "")].includes(norm(lines[0].text))) lines.shift()
            return sane(lines)
          })
          .filter((s): s is LrcLine[] => Boolean(s))
        if (dur) sheets.sort((a, b) => Math.abs(a[a.length - 1].t + 12 - dur) - Math.abs(b[b.length - 1].t + 12 - dur))
        if (sheets.length) return sheets
      }
      return null
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
    // Δ≤2.5s = the SAME edit regardless of title noise: an official-video
    // reupload tagged "// Lyrics // FIFA World Cup" still carries our exact
    // audio structure — it cannot be a different performance at the same
    // runtime, so the perform/live ban must not gate it out
    const sameStruct = (x: { duration?: number }) =>
      !!x.duration && !!dur && Math.abs(x.duration - dur) <= 2.5
    // raw uploader titles carry the real flags — display titles are
    // pre-stripped in main, so title tests must read origTitle first
    const flagTitle = (x: { title?: string; origTitle?: string }) => x.origTitle ?? x.title ?? ""
    const fitsLoose = (x: { streamId?: string; title: string; origTitle?: string; duration?: number; user?: { name?: string } }) =>
      !!x.streamId &&
      titleLike(x.title, title) &&
      // live shows & performances measure the SHOW's timeline (crowd
      // intro, stage banter), not the studio lead-in — "perform … at",
      // festival and award uploads all slip past a bare /live/ test.
      // Same-structure uploads bypass: same runtime = same edit, and the
      // intro we need lives inside exactly those official-video reuploads
      (sameStruct(x)
        ? !/karaoke|in the style of/i.test(flagTitle(x))
        : !/karaoke|cover|tribute|instrumental|in the style of|live\b|en vivo|perform|concert|festival|award|ceremon|grammy|fifa|world cup|super bowl|halftime|fan ?cam|encore/i.test(flagTitle(x))) &&
      artistOkTwin(x) &&
      (!dur || !x.duration || Math.abs(x.duration - dur) <= 30)
    // walk uploads lazily — ownVid first, then same-recording twins (music
    // catalog, then general YouTube for fan lyric videos). `alternates:false`
    // stops after ownVid — only the PLAYING upload can time this audio.
    // Caption probes run CONCURRENTLY per source (one yt-dlp call is ~3s —
    // serial probing burned 20-30s before a measurement could land).
    const forEachVideo = async (
      fn: (vid: string, own: boolean, meta: { title?: string; origTitle?: string; duration?: number } | undefined, cap: { lines: LrcLine[]; wordy?: number } | null) => Promise<boolean>,
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
      const lyricish = (t: { title?: string; origTitle?: string }) =>
        /lyrics?|letra|lyric video/i.test(flagTitle(t)) ? 1 : 0
      const rank = (a: { title?: string; origTitle?: string; duration?: number }, b: { title?: string; origTitle?: string; duration?: number }) =>
        // same-structure first: a Δ≤2.5s twin IS our audio whatever its
        // title says — it must be probed before any other candidate class
        loose
          ? (sameStruct(a) ? 0 : 1) - (sameStruct(b) ? 0 : 1) || lyricish(a) - lyricish(b) || byDur(a, b)
          : byDur(a, b)
      const getCaps = (vid: string) => yt.captions(vid).catch(() => null)
      // batch-evaluate a candidate list: fetch all captions at once (bounded
      // by remaining budget), then walk the ranked results in order
      const batch = async (cands: { streamId?: string; title: string; origTitle?: string; duration?: number; user?: { name?: string } }[]) => {
        const fresh = cands.filter((t) => t.streamId && !seen.has(t.streamId))
        // 3 concurrent probes per round: parallel enough to halve wall time,
        // bounded enough that a track change doesn't strand a fetch storm
        for (let i = 0; i < fresh.length && tried < budget && alive(); i += 3) {
          const slice = fresh.slice(i, i + Math.min(3, budget - tried))
          for (const t of slice) seen.add(t.streamId!)
          tried += slice.length
          const caps = await Promise.all(slice.map((t) => getCaps(t.streamId!)))
          for (let j = 0; j < slice.length; j++) {
            if (!alive()) return true
            if (await fn(slice[j].streamId!, false, slice[j], caps[j])) return true
          }
        }
        return tried >= budget
      }
      if (ownVid && alive()) {
        seen.add(ownVid)
        tried++
        if (await fn(ownVid, true, undefined, await getCaps(ownVid))) return
      }
      if (!alternates) return
      // source order = caption likelihood × ranking quality:
      //  1. yt-dlp real-web ytsearch — official-video reuploads (the
      //     caption+intro twins this walk needs) surface at top ranks
      //  2. Innertube general videoSearch — same web corpus, different
      //     ranking, catches what ytsearch misses
      //  3. upNext + music-catalog search LAST — upNext returns OTHER
      //     songs (radio), and official YTM uploads almost always ship
      //     without caption tracks at all; both mostly burn probes
      const vQueries = [...new Set([`${artist} ${title}`, title, `${artist} ${title} official video`, `${artist} ${title} video oficial`, `${artist} ${title} lyrics`, `${title} lyrics`].filter((x) => x.trim() && x.trim() !== "lyrics"))]
      if (yt.ytsearch) {
        for (const q of vQueries) {
          if (!alive() || tried >= budget) return
          const vids = await yt.ytsearch(q, 8).catch(() => [])
          const gated = vids.filter(gate).sort(rank)
          dbgL(`ytsearch "${q}": ${vids.length} hits, ${gated.length} pass gate`)
          if (await batch(gated)) return
        }
      }
      for (const q of vQueries) {
        if (!alive() || tried >= budget) return
        const vids = await yt.videoSearch(q).catch(() => [])
        const gated = vids.filter(gate).sort(rank)
        dbgL(`vsearch "${q}": ${vids.length} hits, ${gated.length} pass gate`)
        if (await batch(gated)) return
      }
      // last resort only — music-catalog uploads almost never carry
      // captions and upNext returns OTHER songs entirely; they run only
      // if real-web searches left probe budget unspent
      for (const q of twinQueries) {
        if (!alive() || tried >= budget) return
        const res = await yt.search(q).catch(() => null)
        const gated = (res?.tracks ?? []).filter(gate).sort(rank)
        dbgL(`search "${q}": ${res?.tracks?.length ?? 0} hits, ${gated.length} pass gate`)
        if (await batch(gated)) return
      }
      if (ownVid) {
        const rel = await yt.upNext(ownVid).catch(() => [] as { streamId?: string; title: string; origTitle?: string; duration?: number; user?: { name?: string } }[])
        const gated = rel.filter(gate).sort(rank)
        dbgL(`upnext: ${rel.length} hits, ${gated.length} pass gate`)
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
    const refineOffset = async (lrc: LrcLine[], fallback: number, alts: LrcLine[][] = []) => {
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
        const samePool: { off: number; caps: LrcLine[]; aligned: LrcLine[] | null; dur?: number; same: boolean }[] = []
        const canonMeasured: number[] = []
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
          // intro lines prepend at the FRONT — the canonical tail must match.
          // Three-line tail check (not just last line): same-length foreign
          // sheets ending on a common hook can't slip through. Display-only
          // "♪" gap markers never count as sheet lines
          const clean = s.filter((l) => l.text !== "♪")
          return clean.length >= lrc.length && lrc.slice(-3).every((l, i) => clean[clean.length - 3 + i]?.text === l.text)
        }
        const persistAln = (aligned: LrcLine[], intro: LrcLine[]) =>
          setTimeout(() => {
            try {
              if (localStorage.getItem(`lrcoff2-${current.id}`) === null) {
                localStorage.setItem(
                  `lrcaln-${current.id}`,
                  // the fingerprint follows the DISPLAYED sheet — when an
                  // alternate record aligned, its tail is what next play's
                  // restore must recognize
                  JSON.stringify({ f: sheetFp(aligned), t: aligned.map((l) => l.t), i: intro.slice(0, 12) }),
                )
              }
            } catch { /* correction stays session-only */ }
          }, 4000)
        // per-line measured sheet — the "maximum expression" path: intro
        // lines at real cue times + every lyric line anchored to its cue.
        // A successful alignment is the strongest timing evidence we can
        // hold — it supersedes every persisted form: stale pins and auto
        // offsets would double-shift the already video-absolute times, so
        // both keys are dropped before lrcaln- is written.
        const applyAligned = (aligned: LrcLine[], caps: LrcLine[], introAllowed = true) => {
          const shown = gapMarkers(aligned, caps)
          const intro = introAllowed ? introLines(caps, shown[0]?.t - 0.8, 0) : []
          dbg(`aligned lines=${aligned.length} intro=${intro.length} gaps=${shown.length - aligned.length}`)
          setLyrics((cur) => (sameSheet(cur) ? { synced: intro.length ? [...intro, ...shown] : shown, autoOff: 0 } : cur))
          try {
            localStorage.removeItem(`lrcoffa-${current.id}`)
            localStorage.removeItem(`lrcoff2-${current.id}`)
          } catch { /* ok */ }
          pin = null
          persistAln(aligned, intro)
        }
        const applyOff = (off: number, strong: boolean, caps?: LrcLine[]) => {
          // measured offsets legitimately reach multi-minute cinematics
          // (MONACO +173, Telephone +165) — the old ±90 cap silently dropped
          // real measurements and kept a far worse fallback
          if (off < -45 || off > 300 || Math.abs(off - fallback) < 1.5) {
            dbg(`offset ${off.toFixed(1)} rejected (fallback ${fallback.toFixed(1)})`)
            return
          }
          if (pin !== null) {
            if (Math.abs(off - pin) <= 3) return dbg(`pin ${pin} agrees`)
            if (!strong) return dbg(`kept pin ${pin} over weak measurement ${off.toFixed(1)}`)
            dbg(`overrode pin ${pin} with measured ${off.toFixed(1)}`)
            // a Shift+click DURING the walk writes the same key — only drop
            // the pin we actually challenged, not a newer user correction
            try {
              const raw = localStorage.getItem(`lrcoff2-${current.id}`)
              const cur2 = raw ? (JSON.parse(raw) as { o?: number }).o ?? Number(raw) : null
              if (cur2 === pin) localStorage.removeItem(`lrcoff2-${current.id}`)
            } catch { /* ok */ }
            pin = null
          }
          const intro = caps ? introLines(caps, (lrc[0]?.t ?? 0) + off - 0.8, off) : []
          // markers live in the sheet's frame too — the renderer shifts
          // every line by `off`, so caption times must shift back first or
          // each marker lands `off` seconds late
          const shown = caps ? gapMarkers(lrc, caps.map((c) => ({ t: c.t - off, text: c.text }))) : lrc
          dbg(`offset applied +${off.toFixed(1)}s intro=${intro.length} gaps=${shown.length - lrc.length}`)
          setLyrics((cur) => (sameSheet(cur) ? { synced: intro.length ? [...intro, ...shown] : shown, autoOff: off } : cur))
          // persist AFTER the note can surface (the render effect reads
          // keys when autoOff changes — writing first would suppress it);
          // a Shift+click meanwhile wins the key
          setTimeout(() => {
            try {
              if (localStorage.getItem(`lrcoff2-${current.id}`) === null) {
                // a global offset replacing a per-line sheet must drop the
                // stale aligned times or next open restores BOTH
                localStorage.removeItem(`lrcaln-${current.id}`)
                localStorage.setItem(`lrcoffa-${current.id}`, JSON.stringify({ o: off, f: sheetFp(lrc) }))
              }
            } catch { /* correction stays session-only */ }
          }, 4000)
        }
        let applied = false
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
              .sort((a, b) => a.t - b.t)
            // content veto: a same-title DIFFERENT song's sheet passes the
            // metadata gates but its words aren't in this audio — swap for
            // the captions, the right words by definition. Only ground truth
            // may overwrite: ownVid on yt, the stand-in twin on Audius.
            // The wordy gate stops a wrong-LANGUAGE ASR hallucination
            // (e.g. Spanish audio mislabeled en-orig) from vetoing a good
            // DB sheet — that transcript is noise, not a different song.
            if (!lrcContentOk(lrc, clipped) && clipped.length >= 4 && (cap.wordy ?? 1) >= 0.6) {
              if (ownVid && !own) { dbg(`content veto blocked (twin): ${vid}`); return false }
              dbg(`content veto: ${vid} — sheet swapped to captions`)
              setLyrics((cur) => (sameSheet(cur) ? { synced: clipped, autoOff: 0 } : cur))
              applied = true
              return true
            }
            const off = alignOffset(lrc, clipped)
            // a failed quorum here doesn't preclude the next upload
            if (off == null) { dbg(`no quorum: ${vid}`); return false }
            // sanity before counting a vote: with the shift applied, sampled
            // lines must land near their own caption match — a twin whose
            // structure differs can still quorum on hooky lines
            // per-line anchoring beats a global offset whenever coverage
            // allows — it survives drift, dropped/inserted sections, bad
            // canonical lines, everything. For OUR OWN video it is also the
            // authority over timingOk: a structurally divergent sheet (one
            // missing verse) fails the global sanity check yet still aligns
            // line-by-line — that's exactly the case it exists for.
            let aligned = alignLines(lrc, clipped, off)
            // the chosen record's text may diverge from what this upload's
            // captions say (pidgin spellings, an omitted verse) — before
            // settling for a bare offset, let a sibling record try; when one
            // aligns it replaces the sheet wholesale, text and times
            if (aligned == null && alts.length > 1) {
              let triedAlts = 0
              for (const alt of alts) {
                if (alt === lrc) continue
                triedAlts++
                const off2 = alignOffset(alt, clipped)
                if (off2 == null) { dbg(`alt record: no quorum`); continue }
                const al2 = alignLines(alt, clipped, off2)
                if (al2) {
                  aligned = al2
                  dbg(`aligned via alternate record n=${alt.length} off=${off2.toFixed(1)}`)
                  break
                }
                dbg(`alt record: align failed off=${off2.toFixed(1)}`)
              }
              if (!aligned && triedAlts) dbg(`all ${triedAlts} alt records failed`)
            }
            if (own) {
              if (aligned) applyAligned(aligned, clipped, true)
              else if (timingOk(lrc, clipped, off)) applyOff(off, true, clipped)
              else { dbg(`timing veto: ${vid} off=${off.toFixed(1)}`); return false }
              applied = true
              return true
            }
            if (!timingOk(lrc, clipped, off)) { dbg(`timing veto: ${vid} off=${off.toFixed(1)}`); return false }
            // structure, not title, decides what a measurement MEANS:
            //  · Δ≤2.5s runtime → the identical edit — same audio timeline
            //    whatever flags the uploader put in the title (an official-
            //    video reupload tagged "Lyrics // FIFA" still carries the
            //    intro we need)
            //  · flaggy title on a DIFFERENT structure → quarantined; its
            //    ~0 vote must never touch a positive intro guess
            //  · clean title, different structure, measured ≈ fallback →
            //    it independently found our timeline — counts as a vote
            //  · clean title, different structure, measured ≈0 → canonical
            //    evidence: only relevant when our guess is also canonical
            const sameMeta = sameStruct(meta ?? {})
            const flaggy = /lyrics?|letra|lyric video|live\b|en vivo|perform|concert|festival|award|ceremon|grammy|fifa|world cup|super bowl|halftime|fan ?cam|encore|making of|footnotes|behind|reaction|karaoke|cover|sped up|slowed|nightcore/i.test(flagTitle(meta ?? {}))
            if (sameMeta || (!flaggy && Math.abs(off - fallback) <= 4)) {
              samePool.push({ off, caps: clipped, aligned, dur: meta?.duration, same: sameMeta })
              dbg(`measured ${off.toFixed(1)}s on ${vid} sameStruct=${sameMeta}`)
              return true // our structure measured — decisive, stop the walk
            }
            if (flaggy) lyricMeasured.push(off)
            else if (Math.abs(off) <= 3) canonMeasured.push(off)
            else dbg(`discarded twin ${vid} off=${off.toFixed(1)} (foreign structure)`)
            dbg(`measured ${off.toFixed(1)}s on ${vid} flaggy=${flaggy} canon=${!flaggy && Math.abs(off) <= 3}`)
            return false
          },
          { alternates: true, alive: sameTrack, loose: true, budget: 13 },
        )
        dbg(`walk done same=${samePool.length} canon=${canonMeasured.length} lyricOnly=${lyricMeasured.length} alive=${sameTrack()} applied=${applied}`)
        if (!sameTrack() || applied) return
        if (samePool.length) {
          const clusters: number[][] = []
          for (const m of samePool) {
            const c = clusters.find((c) => Math.abs(c[0] - m.off) <= 4)
            if (c) c.push(m.off)
            else clusters.push([m.off])
          }
          const win = clusters.sort((a, b) => b.length - a.length)[0]
          const off = win.slice().sort((a, b) => a - b)[Math.floor(win.length / 2)]
          // every vote here is our structure — a single same-edit upload is
          // strong enough to override a pin
          const winner = samePool.find((m) => win.includes(m.off))
          if (winner?.aligned) applyAligned(winner.aligned, winner.caps, true)
          else applyOff(off, true, winner?.caps)
          return
        }
        // canonical-structure evidence only matters when we already believe
        // the playing upload is canonical — it can confirm ≈0, never erase
        // a positive intro guess
        if (canonMeasured.length && Math.abs(fallback) < 5) {
          canonMeasured.sort((a, b) => a - b)
          applyOff(canonMeasured[Math.floor(canonMeasured.length / 2)], false)
          return
        }
        if (lyricMeasured.length) {
          if (Math.abs(fallback) >= 1.5) return dbg(`kept fallback ${fallback.toFixed(1)} over lyric-only measurements`)
          lyricMeasured.sort((a, b) => a - b)
          applyOff(lyricMeasured[Math.floor(lyricMeasured.length / 2)], false)
          return
        }
        if (fallback !== 0) dbg(`kept fallback ${fallback.toFixed(1)} — no same-structure twin found`)
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
            // a wrong-language ASR hallucination (MONACO's en-orig "carbon
            // demonon" over Spanish audio) is noise — showing it as lyrics
            // is worse than showing nothing
            if ((cap.wordy ?? 1) < 0.6) {
              dbgL(`capsheet: ${vid} rejected (wordy=${cap.wordy})`)
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
            // the stored alignment may belong to an ALTERNATE record that
            // out-anchored the top pick last play — any known sheet whose
            // fingerprint+length matches can receive the times
            const candidates = [body.synced, ...((body as { alts?: LrcLine[][] }).alts ?? [])].filter((s): s is LrcLine[] => Array.isArray(s))
            const host = p?.f && p.t?.length ? candidates.find((s) => sheetFp(s) === p.f && s.length === p.t!.length) : undefined
            if (host) {
              const isLie = Math.abs((p!.t![0] ?? 0) - (host[0]?.t ?? 0)) < 2 && body.autoOff >= 5
              if (isLie) localStorage.removeItem(`lrcaln-${current.id}`)
              else body = { synced: [...(p!.i ?? []), ...host.map((l, i) => ({ ...l, t: p!.t![i] }))], autoOff: 0 }
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
      // Musixmatch + LRCLIB race in parallel — MXM's curated timing is
      // preferred when it hits; every other sheet stays as an alignment
      // alternate in case the winner can't anchor to the audio.
      const [mxm, lrclib] = await Promise.all([fetchMxm(), fetchLrcLib()])
      if (mxm) {
        const alts = [...mxm.slice(1), ...(lrclib && "synced" in lrclib ? [lrclib.synced, ...(lrclib.alts ?? [])] : [])]
        void refineOffset(mxm[0], 0, alts.length ? alts : undefined)
        return finish({ synced: mxm[0], autoOff: 0 })
      }
      if (lrclib && "synced" in lrclib) {
        void refineOffset(lrclib.synced, lrclib.autoOff, lrclib.alts)
        return finish(lrclib)
      }
      // lyrist + textyl + QQ race in parallel — independent hosts, no
      // reason to pay three timeouts serially. Every sheet that parses
      // becomes an alignment alternate: if the first pick can't anchor to
      // the audio, refineOffset retries the rest before giving up.
      const [qq, lyrist, textyl] = await Promise.all([fetchQq(), fetchLyrist(), fetchTextyl()])
      const pool = [...(qq ?? []), ...(lyrist ? [lyrist] : []), ...(textyl ? [textyl] : [])]
      if (pool.length) {
        void refineOffset(pool[0], 0, pool)
        return finish({ synced: pool[0], autoOff: 0 })
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
    })().catch(() => {
      // a stray throw anywhere above must not hang the spinner — finish as
      // "no lyrics" so the panel shows the empty state, not loading forever
      if (live) {
        setLyrics(null)
        setLyricsTried(true)
        setLyricsLoading(false)
      }
    })
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
                    the panel reads as flat black with text floating in a void.
                    The blur runs on a small layer then scales up — a full-
                    viewport blur-3xl re-rasterizes every repaint (CPU hog).
                    The radial mask fades the wash to transparent in every
                    direction, so its bounds can never read as a hard edge. */}
                {current.artwork && (
                  <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden opacity-[0.2] [mask-image:radial-gradient(75%_75%_at_50%_45%,black_25%,transparent_78%)]">
                    <div className="size-56 blur-xl saturate-[0.8] [transform:scale(14)]">
                      <ArtworkImg art={current.artwork} size="150x150" className="size-full object-cover" />
                    </div>
                  </div>
                )}
                {lyricsLoading ? (
                  <Loader2 size={28} className="animate-spin text-ink/50" />
                ) : lyrics && "synced" in lyrics ? (
                  <div className="h-full w-[min(92vw,840px)] [mask-image:linear-gradient(180deg,transparent,black_10%,black_90%,transparent)]">
                    <SyncedLyrics lines={lyrics.synced} autoOff={lyrics.autoOff} />
                  </div>
                ) : lyrics ? (
                  <div className="relative h-full w-[min(92vw,840px)]">
                    <div className="scroller h-full overflow-y-auto overscroll-contain px-2 [mask-image:linear-gradient(180deg,transparent,black_8%,black_92%,transparent)]">
                      <p className="whitespace-pre-line py-8 text-center text-lg font-medium leading-relaxed text-ink/90">
                        {lyrics.plain}
                      </p>
                    </div>
                    <p className="pointer-events-none absolute bottom-2 left-0 right-0 text-center text-[11px] font-normal tracking-wide text-ink/25">
                      Lyrics may not be accurate
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
