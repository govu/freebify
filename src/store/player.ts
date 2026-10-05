import { create } from "zustand"
import { rotateHost, streamUrl } from "../api/audius"
import { prefetchStream, yt } from "../api/youtube"
import { ytEngine } from "../api/ytplayer"
import { attach, detach, fadeTo, fadeCurve, mkAudio, resume, rmsOf, busAvailable, setEq as busSetEq, setNormGain } from "../api/audiobus"
import type { RepeatMode, Track } from "../api/types"
import { useLibrary } from "./library"
import { useDownloads } from "./downloads"
import { isObj, isValidTrack, repairTrack, safeStorage, sanitizeTrackList, slimTrack } from "./storage"

// The live media element. Swapped at track boundaries for the prebuffered
// "next" element — that's what makes auto-advance/next start in <100ms
// instead of buffering a fresh connection every track.
let audio = bindAudio(mkAudio())

// a fully buffered hidden Audio for the upcoming track — created while the
// current one plays so the hand-off is instant
let prebuffer: { id: string; el: HTMLAudioElement } | null = null

function dropPrebuffer() {
  if (!prebuffer) return
  prebuffer.el.removeAttribute("src")
  prebuffer.el.load() // releases the decoded buffer
  prebuffer = null
}

// promote the prebuffered element to the live one — the buffer/network
// Elements being faded out live here until their curve lands — a hard
// pause mid-ramp chops the tail and pops. retireAudio() lets the
// scheduled AudioParam curve die naturally, then tears the element down.
const retiring = new Set<HTMLAudioElement>()
let fadeEndsAt = 0 // wall-clock when the longest scheduled fade-out lands

function retireAudio(el: HTMLAudioElement, midFade = false, tailSecs = 0.3) {
  if (!el || retiring.has(el)) return
  retiring.add(el)
  // midFade: its cos curve is already running to zero — re-ramping would
  // double-fade it; just wait for the scheduled landing, then tear down.
  if (!midFade && busAvailable) {
    try {
      attach(el)
      fadeCurve(el, 0, tailSecs)
    } catch { /* detached/empty element — kill handles it */ }
  }
  const wait = midFade
    ? Math.max(0, fadeEndsAt - Date.now()) + 150
    : tailSecs * 1000 + 120
  setTimeout(() => {
    try {
      el.pause()
      el.removeAttribute("src")
      el.load()
    } catch { /* element already gone */ }
    detach(el)
    retiring.delete(el)
  }, Math.max(80, wait))
}

// state comes along, so play() starts in <100ms. `keepRamp` = the element
// is mid fade-in curve — leave the sine arc to land at 1; snapping it
// open is the audible "jump" crossfades get wrong.
function adoptAudio(el: HTMLAudioElement, keepRamp = false) {
  const s = usePlayer.getState()
  const old = audio
  // keepRamp means old is the element mid fade-out — its curve is
  // scheduled; we just wait for it to land instead of cutting the tail
  retireAudio(old, keepRamp)
  bindAudio(el)
  audio = el
  audio.volume = Math.min(1, Math.max(0, s.volume))
  audio.muted = s.muted
  if (busAvailable && !keepRamp) fadeTo(el, 1, 0.1)
  // the adopted element was already playing through its fade-in, so its
  // "playing"/"canplay" events fired while still gated (a !== audio) —
  // without this, a `waiting` blip on the outgoing element would leave
  // the transport spinner stuck on forever
  if (!el.paused) usePlayer.setState({ buffering: false, isPlaying: true })
}

interface PlayerState {
  queue: Track[]
  index: number
  history: number[]
  current: Track | null
  isPlaying: boolean
  buffering: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  npOpen: boolean
  queueOpen: boolean
  notice: string | null
  autoplay: boolean
  eq: number[] // 7-band dB gains — flat when all zero
  normOn: boolean // loudness normalization (per-track measured gain)
  fadeSecs: number // crossfade seconds — 0 = off

  playContext: (tracks: Track[], index: number) => void
  playTrack: (t: Track, context?: Track[]) => void
  toggle: () => void
  next: (auto?: boolean) => void
  prev: () => void
  seek: (t: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setNpOpen: (v: boolean) => void
  setQueueOpen: (v: boolean) => void
  setAutoplay: (v: boolean) => void
  setEqBand: (i: number, db: number) => void
  setEq: (gains: number[]) => void
  setNormOn: (v: boolean) => void
  setFadeSecs: (v: number) => void
  enqueue: (t: Track) => void
  playNextUp: (t: Track) => void
  removeAt: (i: number) => void
  clearQueue: () => void
  jumpTo: (i: number) => void
  moveInQueue: (from: number, to: number) => void
  startRadio: () => void
}

let streamRetries = 0
let loadSeq = 0
// Consecutive auto-advance failures — the circuit breaker that stops a
// failing stream from burning through the whole queue.
let autoFailStreak = 0
// seq of the load currently racing engines; iframe callbacks are inert
// while a race is pending (its outcome arrives via play()'s promise)
let racingSeq = 0
// loadSeq value that assigned the current <audio> src — stale media
// events queued for a previous src can't skip/burn the new track
let audioLoadSeq = -1
// which engine currently owns playback: "audio" (<audio> element, incl.
// yt-dlp extracted streams) or "yt" (hidden YouTube iframe player)
let engine: "audio" | "yt" = "audio"
// module handle to the store-internal loadAt (failAdvance advances past
// dead tracks directly — next() would honor repeat-one and replay them)
let loadAtRef: ((i: number, startPos?: number) => void) | null = null

const MAX_AUTO_SKIPS = 3

// Transient, user-facing notice (toast) — auto-dismisses.
let noticeTimer: number | null = null
export function notify(msg: string) {
  usePlayer.setState({ notice: msg })
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => usePlayer.setState({ notice: null }), 4500)
}

// A load failed after all engines were tried. Skip to the next track —
// but if several tracks fail in a row, stop instead of visibly cycling
// through the entire queue.
function failAdvance() {
  const s = usePlayer.getState()
  const ni = s.index + 1
  loadPendingSeq = 0
  if (++autoFailStreak >= MAX_AUTO_SKIPS || ni >= s.queue.length) {
    autoFailStreak = 0
    ytEngine.stop()
    audio.pause()
    usePlayer.setState({ buffering: false, isPlaying: false })
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
    notify("Couldn't play — check your connection and try again")
    return
  }
  // advance past the dead track directly — next(true) would honor
  // repeat-one and replay the corpse
  loadAtRef?.(ni)
}

// Watchdog: if a load stays buffering without playing for too long
// (audio.play() rejected without an error event, a hung URL…), count it
// as a failure instead of spinning forever.
let watchdogTimer: number | null = null
let loadCancelledSeq = 0
// set to the pending load's seq while nothing has played yet — cleared on
// first 'playing'. Distinguishes "user paused a load-in-flight" (cancel)
// from "user paused during a mid-playback buffer stall" (just resume).
let loadPendingSeq = 0
function armWatchdog(seq: number) {
  if (watchdogTimer) clearTimeout(watchdogTimer)
  watchdogTimer = window.setTimeout(() => {
    const s = usePlayer.getState()
    if (seq !== loadSeq || loadCancelledSeq === seq) return
    if (s.buffering && !s.isPlaying) failAdvance()
    // 30s: the worst-case hidden-player init is ~30s (API 10s + ready 12s +
    // play 8s) — a shorter watchdog skips viable tracks on slow machines
  }, 30000)
}
function disarmWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

// Mid-playback stall guard: the load watchdog only covers pending loads —
// a stream that stalls DURING play (waiting/onBuffering with isPlaying
// still true) would hang silently forever without this.
let stallTimer: number | null = null
function armStall() {
  if (stallTimer) clearTimeout(stallTimer)
  const mark = usePlayer.getState().currentTime
  stallTimer = window.setTimeout(() => {
    const s = usePlayer.getState()
    if (!(s.buffering && s.isPlaying)) return
    // the playback clock is still moving — the buffering flag got stuck
    // (a gated event cleared nothing), not the audio. Clearing it beats
    // failAdvance() killing a track the user is happily listening to
    if (s.currentTime > mark + 0.5) {
      usePlayer.setState({ buffering: false })
      return
    }
    failAdvance()
  }, 20000)
}
function disarmStall() {
  if (stallTimer) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

// shared gate — Audius gated/unavailable tracks are unplayable
const isPlayable = (t: Track) => t.is_streamable !== false && t.is_stream_gated !== true

// set when the persisted session is restored at boot — the queue/current
// are visible but no engine is loaded yet; toggle() loads it on demand
let restoredSession = false
let resumePos = 0

async function resolveStream(track: Track): Promise<string | null> {
  // a downloaded copy always wins — instant start and works fully offline.
  // the manifest can lag reality (file deleted in Explorer), so verify
  // before serving the fbx:// url; a stale entry would error-loop the
  // <audio> element instead of falling through to the network
  const item = useDownloads.getState().items[track.id]
  if (item) {
    const ok = await (window.freebify?.dl?.exists?.(track.id) ?? Promise.resolve(false)).catch(() => false)
    if (ok) return `fbx://dl/${encodeURIComponent(item.file)}`
    useDownloads.getState().dropLocal(track.id)
  }
  if (track.source === "yt") {
    if (!track.streamId) return null // never send yt- ids to the Audius endpoint
    try {
      return await yt.stream(track.streamId)
    } catch {
      return null
    }
  }
  return streamUrl(track.id)
}

function prefetchNextTrack() {
  const { queue, index, shuffle } = usePlayer.getState()
  // downloaded tracks need no warm-up — the local file IS the warm path
  const dls = useDownloads.getState().items
  if (!shuffle) {
    // warm the next few — the yt-dlp semaphore caps concurrency anyway, and
    // the cache makes repeat resolutions free. Covers instant next-track
    // starts plus clicking a few rows down without waiting for a resolve.
    for (const next of queue.slice(index + 1, index + 5)) {
      if (next?.source === "yt" && next.streamId && !dls[next.id]) {
        void yt.prefetch(next.streamId).catch(() => null)
      }
    }
    // deeper warm-up for the immediate next track: a real media element
    // holding an already-buffered stream — next() then starts in <100ms.
    // runs on every 'playing' event (each resume!) — reuse the existing
    // buffer for the same track instead of refetching the stream
    const first = queue[index + 1]
    if (first?.source === "yt" && first.streamId && !dls[first.id] && engine === "audio" && prebuffer?.id !== first.id) {
      void yt
        .prefetch(first.streamId)
        .then((url) => {
          if (!url) return
          const s = usePlayer.getState()
          if (s.queue[s.index + 1]?.id !== first.id || engine !== "audio") return
          dropPrebuffer()
          const el = mkAudio(url)
          el.preload = "auto"
          // a dead stream URL must not sit here invisibly — flush it from
          // the stream cache and rebuild once, so the boundary gets either
          // a healthy buffer or a fresh resolve instead of the corpse
          el.addEventListener("error", () => {
            if (prebuffer?.el !== el) return
            dropPrebuffer()
            if (first.streamId) void yt.invalidate?.(first.streamId).catch(() => null)
            if (prebufferFailedFor !== first.id) {
              prebufferFailedFor = first.id
              setTimeout(() => prefetchNextTrack(), 4000)
            }
          }, { once: true })
          el.load()
          prebuffer = { id: first.id, el }
        })
        .catch(() => null)
    }
  }
  maybeFillRadio()
}

// ---- autoplay radio (Spotify-style "similar content") ----------------
// When the queue is about to run out, append YouTube Music's "up next"
// recommendations for the current song so playback never dead-ends.
// Keyed to the track AND the queue instance — replaying the same song in
// a fresh queue fills again (a stale flag used to dead-end the queue).
let radioFilledFor: { id: string; tail: string } | null = null

// radio results often carry "the same song, other versions" (covers,
// re-uploads, "Nueva Versión") — YouTube treats them as related because
// the title matches. Spotify radio never does this: normalize titles and
// drop anything that collapses to the seed's own title.
const normTitle = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*(\([^)]*\)|\[[^\]]*\]|\|.*)$/, "")
    .replace(/\s+/g, " ")
    .trim()

function genreMix(vid: string, seed: Track): Promise<Track[]> {
  return yt.upNext(vid).then(async (more) => {
    // niche videos can return a sparse panel — top up with the artist's
    // own songs so the queue always keeps going
    if (more.length < 8 && seed.user?.name && seed.user.name !== "Unknown artist") {
      const extra = await yt.search(seed.user.name).then((r) => r.tracks).catch(() => [] as Track[])
      const seen = new Set(more.map((t) => t.streamId))
      more = [...more, ...extra.filter((t) => t.streamId && !seen.has(t.streamId))].slice(0, 40)
    }
    const seedTitle = normTitle(seed.title)
    const titles = new Set<string>()
    return more.filter((t) => {
      const n = normTitle(t.title)
      if (!t.streamId || n === seedTitle || titles.has(n)) return false
      titles.add(n)
      return true
    })
  })
}

function maybeFillRadio() {
  const { queue, index, current, autoplay } = usePlayer.getState()
  if (!autoplay) return
  if (!current || current.source !== "yt" || !current.streamId) return
  if (queue.length - index > 10) return // enough queued already
  // queue identity changes on every mutation — compare the actual upcoming
  // tail so a removeAt/reorder can't retrigger the whole refetch
  const tail = queue
    .slice(Math.max(0, index), index + 4)
    .map((t) => t.id)
    .join(",")
  if (radioFilledFor?.id === current.id && radioFilledFor.tail === tail) return
  radioFilledFor = { id: current.id, tail }
  const vid = current.streamId
  void (async () => {
    try {
      const more = await genreMix(vid, current)
      const s = usePlayer.getState()
      if (s.current?.id !== current.id) return
      const have = new Set(s.queue.map((t) => t.streamId ?? t.id))
      const haveTitles = new Set(s.queue.map((t) => normTitle(t.title)))
      const add = more.filter((t) => t.streamId && !have.has(t.streamId) && !haveTitles.has(normTitle(t.title)))
      if (!add.length) {
        // an empty fetch must not poison the flag — after a network blip
        // the queue would dead-end forever at track's end; clear so the
        // next queue mutation retries
        radioFilledFor = null
        return
      }
      // the panel also carries durations — backfill "0:00" rows where possible
      const byVid = new Map(more.map((t) => [t.streamId, t]))
      const patched = s.queue.map((t) =>
        !t.duration && t.streamId ? { ...t, duration: byVid.get(t.streamId!)?.duration ?? t.duration } : t
      )
      usePlayer.setState({ queue: [...patched, ...add] })
    } catch {
      // transient failure — clear the flag so the next play retries
      // instead of dead-ending the queue for this track
      radioFilledFor = null
    }
  })()
}

export const usePlayer = create<PlayerState>()(
    (set, get) => {
      const loadAt = async (index: number, startPos = 0) => {
        const track = get().queue[index]
        if (!track) return
        restoredSession = false
        streamRetries = 0
        const seq = ++loadSeq
        racingSeq = 0
        loadPendingSeq = seq
        // an in-flight crossfade is resolved by this load — if we're
        // adopting the element that's mid fade-in, BOTH scheduled curves
        // must keep running (outgoing dies to zero, incoming climbs to 1)
        const adopting = Boolean(
          busAvailable && prebuffer && prebuffer.el === incomingEl && prebuffer.id === track.id
        )
        cancelCrossfade(prebuffer?.id === track.id ? prebuffer.el : undefined, adopting)
        // stop BOTH engines immediately — the previous track must not keep
        // sounding while the next one resolves. NOT on adopt: `audio` is
        // the fading element; retireAudio lets its tail die on schedule.
        ytEngine.stop()
        if (!adopting) {
          audio.pause()
          if (busAvailable) fadeTo(audio, 1, 0) // reset out-fade before reuse
          audio.removeAttribute("src")
          audio.load() // fully reset the media element — drops stale network/decode state
        }
        // isPlaying MUST reset here: a stopped iframe emits no events and
        // the audio 'pause' is gated out — leaving it true kills the
        // watchdog and misreports state while buffering. EXCEPT on adopt:
        // the incoming element is already audible — flipping isPlaying
        // for ~100ms is the "play button while music plays" flicker.
        set({
          index, current: track,
          isPlaying: adopting,
          currentTime: adopting ? prebuffer?.el.currentTime ?? 0 : startPos,
          duration: track.duration ?? 0,
          buffering: !adopting,
        })
        armWatchdog(seq)
        // mid-fade adoption: the element already owns the stream and its
        // sine arc — no re-resolve, no iframe race, no double audio
        if (adopting && prebuffer) {
          engine = "audio"
          audioLoadSeq = seq
          adoptAudio(prebuffer.el, true)
          prebuffer = null
          useLibrary.getState().addRecent(track)
          applyLoudness(track)
          updateMediaSession(track)
          prefetchNextTrack()
          return
        }
        if (track.source === "yt" && track.streamId && !useDownloads.getState().items[track.id]) {
          // Race: pure audio (yt-dlp, zero ads) vs hidden iframe (instant start).
          // Whichever plays first wins; if the url arrives first the iframe is
          // stopped before it ever plays. While racingSeq is set, the iframe's
          // error/ended callbacks stay inert — its fate arrives via ifrP.
          racingSeq = seq
          const urlP = resolveStream(track)
          const ifrP = ytEngine.play(track.streamId, startPos)
          // finalize the iframe win EARLY, from ifrP itself — otherwise the
          // engine handover waits for the losing urlP (up to ~18s) while the
          // iframe already plays: gated events dead, toggle() routed to the
          // wrong engine, an ended video's next(true) swallowed.
          let audioWon = false
          const finalizeYt = (ok: boolean) => {
            if (seq !== loadSeq || !ok || audioWon) return
            racingSeq = 0
            engine = "yt"
            ytEngine.setVolume(get().volume)
            ytEngine.setMuted(get().muted)
          }
          void ifrP.then(finalizeYt)
          const url = await urlP
          if (seq !== loadSeq) return // newer load already stopped/cleans the engine
          if (url && !ytEngine.playing) {
            // pure audio arrived before the iframe started — use it (zero ads)
            audioWon = true // a late ifrP.then(true) must not re-steal the engine
            engine = "audio"
            racingSeq = 0
            ytEngine.stop()
            if (prebuffer?.id === track.id && !prebuffer.el.error) {
              // the upcoming element was already buffering — instant start
              adoptAudio(prebuffer.el, adopting)
              prebuffer = null
            } else {
              dropPrebuffer()
              audio.src = url
            }
            audioLoadSeq = seq
            if (startPos > 0) {
              if (audio.readyState >= 1) audio.currentTime = startPos
              // once:true listeners survive a superseding load's reset —
              // gate so an old startPos can't jump a newer track
              else audio.addEventListener("loadedmetadata", () => {
                if (seq === loadSeq && audioLoadSeq === seq) audio.currentTime = startPos
              }, { once: true })
            }
            void audio.play().catch(() => {})
          } else if (!url) {
            // pure-audio extraction failed — the iframe is the only hope.
            // check staleness BEFORE touching engine/racingSeq: if a newer
            // load superseded us mid-await, those belong to it now
            const ok = await ifrP
            if (seq !== loadSeq) return
            if (!ok) {
              racingSeq = 0
              engine = "audio"
              failAdvance()
              return
            }
            finalizeYt(ok) // covers ifrP resolving after urlP
          } else {
            // iframe already audible — keep it; resolved url stays cached
            finalizeYt(true)
          }
        } else {
          const url = await resolveStream(track)
          if (seq !== loadSeq) return
          if (!url) {
            failAdvance()
            return
          }
          engine = "audio"
          dropPrebuffer()
          audio.src = url
          audioLoadSeq = seq
          if (startPos > 0) {
            if (audio.readyState >= 1) audio.currentTime = startPos
            else audio.addEventListener("loadedmetadata", () => {
              if (seq === loadSeq && audioLoadSeq === seq) audio.currentTime = startPos
            }, { once: true })
          }
          void audio.play().catch(() => {})
        }
        useLibrary.getState().addRecent(track)
        applyLoudness(track)
        updateMediaSession(track)
        // an adopted mid-fade element never re-fires 'playing' — without
        // this the NEXT transition would have no prebuffer and hard-cut
        prefetchNextTrack()
      }
      loadAtRef = loadAt

      return {
        queue: [],
        index: -1,
        history: [],
        current: null,
        isPlaying: false,
        buffering: false,
        currentTime: 0,
        duration: 0,
        volume: 0.85,
        muted: false,
        shuffle: false,
        repeat: "off",
        npOpen: false,
        queueOpen: false,
        notice: null,
        eq: [0, 0, 0, 0, 0, 0, 0],
        normOn: true,
        fadeSecs: 4,
        autoplay: true,

        playContext: (tracks, index) => {
          const playable = tracks.filter(isPlayable)
          if (!playable.length) {
            notify("Nothing playable in this list")
            return
          }
          const target = tracks[index]
          // find by position first — the same track can appear twice in a
          // list and id-matching would land on the earlier twin's slot
          let i =
            target && playable.indexOf(target) >= 0
              ? playable.indexOf(target)
              : playable.findIndex((t) => t.id === target?.id)
          // clicked a gated/unavailable row — play nothing, don't hijack #1
          if (i < 0) {
            notify("That track isn't available for streaming")
            return
          }
          autoFailStreak = 0
          set({ queue: playable, history: [] })
          loadAt(i)
          // warm the tracks the user is most likely to hit next — the
          // resolve lands in cache long before they'd ever click it
          playable.slice(i + 1, i + 5).forEach(prefetchStream)
        },

        playTrack: (t, context) => {
          if (!isPlayable(t)) {
            notify("That track isn't available for streaming")
            return
          }
          autoFailStreak = 0
          if (context) {
            const i = context.findIndex((x) => x.id === t.id)
            if (i >= 0) {
              get().playContext(context, i)
              return
            }
          }
          set({ queue: [t], history: [] })
          loadAt(0)
        },

        toggle: () => {
          const { current, isPlaying, buffering, index } = get()
          if (!current) return
          // restored session — nothing is loaded yet; start it at the
          // persisted position instead of pausing a silent engine
          if (restoredSession && !isPlaying) {
            const pos = resumePos
            restoredSession = false
            resumePos = 0
            void loadAt(index, pos)
            return
          }
          // cancelled/failed load left a dead element (no src or a spent
          // error state) — replay it instead of pressing play on a corpse
          if (!isPlaying && !buffering && engine === "audio" && (!audio.src || audio.error)) {
            void loadAt(index)
            return
          }
          // pausing a LOAD IN FLIGHT cancels it (invalidates its seq, stops
          // both engines). loadPendingSeq is only live before first 'playing'
          // — a mid-playback buffer stall pauses/resumes normally instead.
          if (buffering && !isPlaying && loadPendingSeq === loadSeq) {
            loadCancelledSeq = loadSeq
            ++loadSeq
            racingSeq = 0
            ytEngine.stop()
            audio.pause()
            audio.removeAttribute("src")
            audio.load()
            // the cancelled load may have left engine === "yt" pointing at a
            // dead player — reset so the next Play hits the replay path
            engine = "audio"
            set({ buffering: false })
            return
          }
          if (engine === "yt") {
            if (isPlaying) ytEngine.pause()
            else if (ytEngine.isActive) ytEngine.resume()
            else void loadAt(index) // dead/stopped player — reload, don't ghost-play
          } else if (isPlaying) {
            cancelCrossfade() // a paused fade must not keep playing the next track
            // dip, don't cut: 220ms fade-out then pause. UI flips to
            // "paused" instantly; the sound eases out underneath
            pauseRequested = true
            set({ isPlaying: false })
            if (busAvailable && audio.src) {
              const el = audio
              fadeCurve(el, 0, 0.22)
              setTimeout(() => {
                pauseRequested = false
                // a resume during the dip must win — el stays put
                if (el === audio && !usePlayer.getState().isPlaying) el.pause()
              }, 260)
            } else audio.pause()
          } else {
            pauseRequested = false
            void audio.play().catch(() => {})
            // if the element just dipped out (gain ≈ 0), climb back in —
            // no-op for elements already at full gain
            if (busAvailable) fadeCurve(audio, 1, 0.15)
          }
        },

        next: (auto = false) => {
          const { queue, index, history, shuffle, repeat } = get()
          if (queue.length === 0) return
          if (auto && repeat === "one") {
            if (engine === "yt") {
              ytEngine.seek(0)
              ytEngine.resume()
            } else {
              audio.currentTime = 0
              void audio.play().catch(() => {})
            }
            return
          }
          if (!auto) autoFailStreak = 0
          let nextIndex = index + 1
          if (shuffle && queue.length > 1) {
            const options = queue.map((_, i) => i).filter((i) => i !== index)
            nextIndex = options[Math.floor(Math.random() * options.length)]
          }
          if (nextIndex >= queue.length) {
            if (repeat === "all") nextIndex = 0
            else if (!auto) return // manual next on the last track — nothing after
            else {
              // queue ran out mid-fade — tear down the overlap cleanly
              // instead of leaving a playing orphan element
              cancelCrossfade()
              set({ isPlaying: false, buffering: false })
              if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
              return
            }
          }
          set({ history: [...history.slice(-63), index] })
          loadAt(nextIndex)
        },

        prev: () => {
          const { queue, index, history } = get()
          if (queue.length === 0) return
          // store currentTime — engine clocks lie on a restored session
          // (nothing is loaded yet but the saved position is what matters)
          const pos = get().currentTime
          if (pos > 3) {
            get().seek(0) // also updates resumePos correctly
            return
          }
          autoFailStreak = 0
          const prevIndex = history.length > 0 ? history[history.length - 1] : index - 1
          set({ history: history.slice(0, -1) })
          if (prevIndex >= 0) loadAt(prevIndex)
          else get().seek(0)
        },

        seek: (t) => {
          if (!Number.isFinite(t) || !get().current) return
          const dur = get().duration || get().current?.duration || 0
          const clamped = dur > 0 ? Math.min(Math.max(0, t), dur) : Math.max(0, t)
          // scrubbing a restored (not yet loaded) session just moves the
          // resume position — engines pick it up on the next play. Write it
          // too, or quitting before play restores the stale spot.
          if (restoredSession) {
            resumePos = clamped
            set({ currentTime: clamped })
            saveResume()
            return
          }
          if (incomingEl) cancelCrossfade() // scrubbing mid-fade — snap back, the outgoing track is the one being moved
          if (engine === "yt") ytEngine.seek(clamped)
          else audio.currentTime = clamped
          set({ currentTime: clamped })
        },

        setVolume: (v) => {
          if (!Number.isFinite(v)) return // NaN would throw on audio.volume
          const vol = Math.min(1, Math.max(0, v))
          // raising volume while muted must unmute the ENGINES, not just the
          // flag — otherwise the UI un-mutes but nothing sounds
          if (vol > 0 && get().muted) {
            audio.muted = false
            ytEngine.setMuted(false)
          }
          audio.volume = vol
          ytEngine.setVolume(vol)
          set({ volume: vol, muted: vol === 0 ? get().muted : false })
        },

        toggleMute: () => {
          const m = !get().muted
          audio.muted = m
          ytEngine.setMuted(m)
          set({ muted: m })
        },

        toggleShuffle: () => set({ shuffle: !get().shuffle }),

        cycleRepeat: () => {
          const order: RepeatMode[] = ["off", "all", "one"]
          set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] })
        },

        setNpOpen: (v) => set({ npOpen: v }),
        setQueueOpen: (v) => set({ queueOpen: v }),

        setEqBand: (i, db) => {
          const eq = get().eq.slice(0, 7)
          eq[i] = db
          busSetEq(eq)
          set({ eq })
        },
        setEq: (gains) => {
          const eq = gains.slice(0, 7)
          while (eq.length < 7) eq.push(0)
          busSetEq(eq)
          set({ eq })
        },
        setNormOn: (v) => {
          set({ normOn: v })
          const cur = get().current
          if (cur) applyLoudness(cur) // re-measure/applies stored or resets to 1
        },
        setFadeSecs: (v) => set({ fadeSecs: Math.max(0, Math.min(12, Math.round(v))) }),

        enqueue: (t) => {
          if (!isPlayable(t)) {
            notify("That track isn't available for streaming")
            return
          }
          // idle player — start the queued track instead of silently piling up
          if (get().index === -1 || get().queue.length === 0) {
            autoFailStreak = 0
            set({ queue: [t], history: [] })
            loadAt(0)
            return
          }
          // runtime queue cap — persist only saves 300; an unbounded queue
          // would diverge index↔current on restore and bloat memory. Dropping
          // old entries would rebase every stored position — refuse instead.
          set((s) => {
            if (s.queue.length >= 500) {
              notify("Queue is full")
              return s
            }
            return { queue: [...s.queue, t] }
          })
          notify("Added to queue")
        },
        playNextUp: (t) => {
          if (!isPlayable(t)) {
            notify("That track isn't available for streaming")
            return
          }
          if (get().index === -1 || get().queue.length === 0) {
            autoFailStreak = 0
            set({ queue: [t], history: [] })
            loadAt(0)
            return
          }
          set((s) => {
            const q = [...s.queue]
            q.splice(s.index + 1, 0, t)
            // history stores positions — everything past the insert point
            // shifted by one
            return { queue: q, history: s.history.map((h) => (h > s.index ? h + 1 : h)) }
          })
          notify("Will play next")
        },
        removeAt: (i) => {
          const { queue, index, history } = get()
          if (i < 0 || i >= queue.length || i === index) return
          const q = queue.filter((_, n) => n !== i)
          // rebase index + history (they store positions, not ids)
          const ni = i < index ? index - 1 : index
          const h = history
            .filter((h) => h !== i)
            .map((h) => (h > i ? h - 1 : h))
          set({ queue: q, index: ni, history: h })
        },
        clearQueue: () => {
          const { current, index } = get()
          // keep what's playing — clear upcoming + history
          set(index >= 0 && current ? { queue: [current], index: 0, history: [] } : { queue: [], index: -1, history: [] })
        },
        jumpTo: (i) => {
          const { queue, index, history } = get()
          if (i === index || i < 0 || i >= queue.length || !isPlayable(queue[i])) return
          autoFailStreak = 0
          // same contract as next() — Prev must return to the track heard
          // before the jump, not to index-1
          if (index >= 0) set({ history: [...history.slice(-63), index] })
          loadAt(i)
        },
        moveInQueue: (from, to) => {
          const { queue, index } = get()
          if (from === to || from === index || from < 0 || from >= queue.length || to < 0 || to >= queue.length) return
          const q = [...queue]
          const [item] = q.splice(from, 1)
          q.splice(to, 0, item)
          const ni = index > from && index <= to ? index - 1 : index < from && index >= to ? index + 1 : index
          set({ queue: q, index: ni, history: get().history.map((h) => (h === from ? to : h > from && h <= to ? h - 1 : h < from && h >= to ? h + 1 : h)) })
        },
        // "Go to song radio" — clears everything after the current track and
        // re-seeds with the genre mix (like Spotify's radio). What you were
        // playing keeps playing; NEXT UP becomes similar songs.
        startRadio: () => {
          const { current } = get()
          if (!current || current.source !== "yt" || !current.streamId) return
          const vid = current.streamId
          void (async () => {
            const mix = await genreMix(vid, current).catch(() => [] as Track[])
            const s = get()
            if (s.current?.id !== current.id || !mix.length) return
            // a radio REPLACES what follows (same as Spotify); history stays
            radioFilledFor = { id: current.id, tail: mix.slice(0, 4).map((t) => t.id).join(",") }
            set({ queue: [...s.queue.slice(0, s.index + 1), ...mix] })
            notify("Radio started — similar songs queued")
          })()
        },
        setAutoplay: (v) => set({ autoplay: v }),
      }
    },
)

// ---- persistence — manual, not the persist middleware ----
// zustand's persist wraps setState: EVERY set() ran partialize + stringify
// (~300-track queue → ~150-450KB) including the 4Hz currentTime tick —
// megabytes of GC garbage per second during all playback. Here a write
// only happens when a persisted key actually changed, debounced.
const PERSIST_NAME = "freebify-player"

const partialize = (s: PlayerState) => ({
  volume: s.volume,
  muted: s.muted,
  shuffle: s.shuffle,
  repeat: s.repeat,
  autoplay: s.autoplay,
  eq: s.eq,
  normOn: s.normOn,
  fadeSecs: s.fadeSecs,
  queue: s.queue.map(slimTrack).slice(0, 300),
  index: s.index,
  current: s.current ? slimTrack(s.current) : null,
})

function mergePersisted(persisted: unknown, current: PlayerState): PlayerState {
  if (!isObj(persisted)) return current
  {
        const queue = sanitizeTrackList(persisted.queue, 300)
        let index =
          typeof persisted.index === "number" && Number.isFinite(persisted.index)
            ? Math.min(Math.max(-1, Math.trunc(persisted.index)), queue.length - 1)
            : -1
        const cur = isValidTrack(persisted.current)
          ? slimTrack(repairTrack(persisted.current as Track))
          : index >= 0
            ? queue[index]
            : null
        // corrupt blob: a current track with index -1 (or an index pointing
        // elsewhere) makes toggle()/next() load the wrong slot — realign
        // onto the track's own position
        if (cur) {
          const found = queue.findIndex((t) => t.id === cur.id)
          index = found >= 0 ? found : Math.max(0, index)
        }
        // resume position is kept in a side key (see below) — keyed by
        // track identity so we never restore a position onto a different
        // song than the one it was saved for
        let pos = 0
        try {
          const r = JSON.parse(localStorage.getItem("freebify-resume") ?? "null")
          const vid = cur?.streamId ?? cur?.id
          if (isObj(r) && typeof r.t === "number" && r.t > 0 && r.vid === vid) pos = r.t
        } catch {
          /* ignore */
        }
        // a real session survived restart — engines load lazily on play
        if (queue.length > 0 && cur) {
          restoredSession = true
          resumePos = pos
        } else {
          pos = 0
        }
        return {
          ...current,
          volume:
            typeof persisted.volume === "number" && Number.isFinite(persisted.volume)
              ? Math.min(1, Math.max(0, persisted.volume))
              : current.volume,
          muted: typeof persisted.muted === "boolean" ? persisted.muted : current.muted,
          shuffle: typeof persisted.shuffle === "boolean" ? persisted.shuffle : current.shuffle,
          repeat: persisted.repeat === "all" || persisted.repeat === "one" ? persisted.repeat : "off",
          autoplay: typeof persisted.autoplay === "boolean" ? persisted.autoplay : true,
          eq:
            Array.isArray(persisted.eq) && persisted.eq.length === 7 && persisted.eq.every((n: unknown) => typeof n === "number" && Number.isFinite(n))
              ? persisted.eq.map((n: number) => Math.max(-24, Math.min(24, n)))
              : current.eq,
          normOn: typeof persisted.normOn === "boolean" ? persisted.normOn : true,
          fadeSecs:
            typeof persisted.fadeSecs === "number" && Number.isFinite(persisted.fadeSecs)
              ? Math.max(0, Math.min(12, Math.round(persisted.fadeSecs)))
              : current.fadeSecs,
          queue,
          index,
          current: cur,
          currentTime: pos,
          isPlaying: false,
          buffering: false,
        }
  }
}

// hydrate once at module load — same sanitization path as before
try {
  const raw = safeStorage.getItem(PERSIST_NAME)
  if (raw) {
    const parsed = JSON.parse(raw) as unknown
    const persisted = isObj(parsed) && isObj(parsed.state) ? parsed.state : parsed
    usePlayer.setState(mergePersisted(persisted, usePlayer.getState()))
  }
} catch (err) {
  console.error("[freebify] corrupt player state, resetting", err)
  safeStorage.removeItem(PERSIST_NAME)
}
// hydrate the audio bus — EQ survives restarts before the first element plays
if (busAvailable) busSetEq(usePlayer.getState().eq)

// write only when a persisted key actually changed — the 4Hz currentTime
// tick used to serialize the whole queue into GC garbage on every beat
let persistTimer: ReturnType<typeof setTimeout> | null = null
usePlayer.subscribe((s, prev) => {
  if (
    s.queue === prev.queue &&
    s.index === prev.index &&
    s.current === prev.current &&
    s.volume === prev.volume &&
    s.muted === prev.muted &&
    s.shuffle === prev.shuffle &&
    s.repeat === prev.repeat &&
    s.autoplay === prev.autoplay &&
    s.eq === prev.eq &&
    s.normOn === prev.normOn &&
    s.fadeSecs === prev.fadeSecs
  ) return
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    safeStorage.setItem(
      PERSIST_NAME,
      JSON.stringify({ state: partialize(usePlayer.getState()), version: 1 }),
    )
  }, 300)
})

// ---- crossfade + loudness normalization --------------------------------
// Crossfade rides the existing prebuffer: the next element starts early on
// its own Web Audio gain while the live element fades out; when the ramp
// ends we advance the store exactly like a natural boundary (next(true) →
// loadAt → adoptAudio), so index/history/queue logic isn't duplicated.
let fadeTimer: ReturnType<typeof setTimeout> | null = null
let incomingEl: HTMLAudioElement | null = null
let fadingEl: HTMLAudioElement | null = null
// set while the pause dip is draining — 'ended' inside that window is the
// track dying, not an advance request
let pauseRequested = false
// one prebuffer rebuild per track id — a persistent bad host shouldn't
// spin a resolve/error loop forever
let prebufferFailedFor: string | null = null

function cancelCrossfade(keep?: HTMLAudioElement, adopt = false) {
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = null
  }
  if (incomingEl) {
    if (incomingEl === keep) {
      // adopt: the sine curve is still climbing to 1 — hands off. Any
      // other keep (resume after pause) needs the snap-open.
      if (!adopt) fadeTo(incomingEl, 1, 0.1)
    } else {
      // stays usable as a prebuffer — but if it was mid fade-in it's
      // audibly up; pausing hard pops. Ease it silent first, then reset.
      const el = incomingEl
      if (busAvailable) fadeCurve(el, 0, 0.2)
      setTimeout(() => {
        // reborn inside the window — adopted as live or re-faded — leave it
        if (el === incomingEl || el === audio) return
        try {
          el.pause()
          el.currentTime = 0
        } catch { /* metadata may not be in yet */ }
        fadeTo(el, 1, 0)
      }, 220)
    }
  }
  // adopt: the outgoing's cos curve keeps running to zero — restoring it
  // to 1 would pop it back to full volume for the rest of the fade
  if (fadingEl && fadingEl === audio && !adopt) fadeTo(audio, 1, 0.12)
  fadingEl = null
  incomingEl = null
}

function startCrossfade(secs: number) {
  if (!prebuffer || !busAvailable) return
  const nxt = prebuffer.el
  // HAVE_FUTURE_DATA: fading into an element that can't produce samples
  // yet is just a silent dip, not a crossfade — let the natural 'ended'
  // handoff take it instead
  if (nxt.error) {
    dropPrebuffer()
    return
  }
  if (nxt.readyState < 3) return
  const s = usePlayer.getState()
  incomingEl = nxt
  fadingEl = audio
  attach(nxt)
  nxt.volume = audio.volume
  nxt.muted = audio.muted
  // the incoming track's own measured loudness — both sides of the fade
  // are already leveled, so the blend never swells or sinks
  const ndb = loudFor(prebuffer.id)
  if (ndb !== undefined && s.normOn) setNormGain(nxt, 10 ** (ndb / 20))
  fadeTo(nxt, 0, 0)
  void nxt.play().catch(() => cancelCrossfade(nxt))
  // equal-power arcs: power sums to ~1 through the midpoint — no dip,
  // no sudden jump at either end (d(sin)/dx → 0 as x → 1)
  fadeCurve(nxt, 1, secs)
  fadeCurve(audio, 0, secs)
  fadeEndsAt = Date.now() + secs * 1000
  // hand over at ~55% — the incoming dominates the mix from there on, so
  // the UI flips (title, progress, controls) while the outgoing tail is
  // still audibly dying underneath. Waiting for 100% made the bar show a
  // dead track while a different song was already the one you hear.
  fadeTimer = setTimeout(() => {
    fadeTimer = null
    // keep incomingEl/fadingEl set — next(true) → loadAt reads incomingEl
    // to adopt the element while its sine curve is still climbing, and to
    // let the outgoing cos tail die on schedule instead of pausing mid-ramp
    usePlayer.getState().next(true)
    // if nothing adopted them (e.g. queue ended), don't leak ghost elements
    setTimeout(() => {
      if (incomingEl || fadingEl) cancelCrossfade()
    }, Math.max(0, fadeEndsAt - Date.now()) + 400)
  }, secs * 550)
}

// ---- per-track loudness -------------------------------------------------
// First play of a track measures integrated RMS for ~8s and stores the
// offset vs the target level; replays (and tracks already measured) get the
// gain applied instantly. Persisted map is small: id → dB.
const LOUD_KEY = "freebify-loudness"
const TARGET_RMS_DB = -18

function loudMap(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOUD_KEY) ?? "{}")
    return isObj(raw) ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function loudFor(id: string): number | undefined {
  const v = loudMap()[id]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function loudSave(id: string, db: number) {
  const m = loudMap()
  m[id] = db
  const keys = Object.keys(m)
  if (keys.length > 3000) delete m[keys[0]] // oldest wins eviction
  try {
    localStorage.setItem(LOUD_KEY, JSON.stringify(m))
  } catch { /* quota — normalization is best-effort */ }
}

let meterTimer: ReturnType<typeof setInterval> | null = null

function stopLoudnessMeter() {
  if (meterTimer) clearInterval(meterTimer)
  meterTimer = null
}

// Apply the stored gain immediately, or start measuring. Called once the
// audio engine owns playback for a track. The gain lives ON the element's
// port — a crossfade keeps each song at its own normalized level.
function applyLoudness(track: Track) {
  stopLoudnessMeter()
  if (!busAvailable) return
  const el = audio
  const stored = loudFor(track.id)
  const want = usePlayer.getState().normOn
  if (stored !== undefined) {
    setNormGain(el, want ? 10 ** (stored / 20) : 1)
    return
  }
  setNormGain(el, 1)
  if (!want) return
  let acc = 0
  let n = 0
  meterTimer = setInterval(() => {
    if (audio !== el || usePlayer.getState().current?.id !== track.id) return stopLoudnessMeter()
    if (el.paused) return
    const r = rmsOf(el)
    if (r > 1e-4) {
      acc += r
      n++
    }
    if (n >= 20) {
      const db = Math.max(-9, Math.min(14, TARGET_RMS_DB - 20 * Math.log10(acc / n)))
      loudSave(track.id, db)
      // the element may have been adopted into a fade meanwhile — apply to
      // whichever port this element still owns
      setNormGain(el, usePlayer.getState().normOn ? 10 ** (db / 20) : 1)
      stopLoudnessMeter()
    }
  }, 400)
}

// ---- wire the <audio> element into the store ----
// Every listener is gated by engine === "audio": while the iframe owns
// playback (or a load race is in flight), stale audio events must not
// clobber player state. Listeners reference their own element `a` — safe
// through prebuffer swaps.
function bindAudio(a: HTMLAudioElement): HTMLAudioElement {
  a.preload = "auto"
  if (busAvailable) attach(a)
  // events from a swapped-out element (adoptAudio paused/reset it) must not
  // touch state — only the live element owns the store
  const on = (ev: string, fn: () => void) =>
    a.addEventListener(ev, () => {
      if (a !== audio) return
      fn()
    })
  on("play", () => {
    if (engine !== "audio") return
    resume()
    usePlayer.setState({ isPlaying: true, buffering: false })
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"
  })
  on("pause", () => {
    if (engine !== "audio") return
    disarmStall()
    saveResume()
    // a waiting→pause sequence would otherwise leave the spinner stuck on
    // a paused control
    usePlayer.setState({ isPlaying: false, buffering: false })
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
  })
  on("waiting", () => {
    if (engine !== "audio") return
    // a stall on the element being faded OUT isn't user-visible — the
    // incoming track is already covering it; don't flash the spinner
    if (a === fadingEl) return
    usePlayer.setState({ buffering: true })
    armStall()
  })
  on("playing", () => {
    if (engine !== "audio") return
    autoFailStreak = 0
    loadPendingSeq = 0
    disarmWatchdog()
    disarmStall()
    usePlayer.setState({ buffering: false })
    prefetchNextTrack()
  })
  on("canplay", () => {
    if (engine === "audio") {
      disarmStall()
      usePlayer.setState({ buffering: false })
    }
  })
  on("timeupdate", () => {
    if (engine === "audio" && !a.seeking) usePlayer.setState({ currentTime: a.currentTime })
    // crossfade trigger — only sequential queues (shuffle resolves its pick
    // at transition time, so no crossfade there) with a prebuffer ready
    const st = usePlayer.getState()
    const secs = st.fadeSecs
    if (
      busAvailable &&
      secs > 0 &&
      !incomingEl &&
      !st.shuffle &&
      st.repeat !== "one" &&
      st.isPlaying &&
      engine === "audio" &&
      a === audio &&
      Number.isFinite(a.duration) &&
      // a fade longer than the track itself would kick in at second 0 —
      // cap the window so crossfade always means "the last N seconds"
      a.duration > secs + 2 &&
      a.duration - a.currentTime > 0.5 &&
      a.duration - a.currentTime <= secs &&
      prebuffer?.id === st.queue[st.index + 1]?.id
    ) {
      startCrossfade(secs)
    }
  })
  on("durationchange", () => {
    if (engine === "audio" && Number.isFinite(a.duration) && a.duration > 0)
      usePlayer.setState({ duration: a.duration })
  })
  on("ended", () => {
    // the fade timer already scheduled the advance — an 'ended' landing on
    // top would count as a SECOND next
    if (engine !== "audio" || audioLoadSeq !== loadSeq || a === fadingEl) return
    // user just hit pause — the dip keeps the element live ~260ms, and if it
    // reaches the end inside that window the stray advance would ghost-play.
    // NOT isPlaying-based: Chrome fires 'pause' before 'ended', so isPlaying
    // is always false here — gating on it kills every natural advance.
    if (pauseRequested) {
      pauseRequested = false
      return
    }
    usePlayer.getState().next(true)
  })
  on("error", () => {
    if (engine !== "audio" || audioLoadSeq !== loadSeq) return
    // a dying element mid-crossfade may error from the pause/reset dance —
    // the incoming track already owns the listener's ears; retrying this
    // element (or failAdvance) would double-skip
    if (a === fadingEl) return
    const s = usePlayer.getState()
    if (streamRetries < 1 && s.current) {
      // stream hiccup — rotate host / re-resolve and retry the same track once
      streamRetries++
      const t = s.current
      const seqAtErr = loadSeq
      rotateHost()
      void (async () => {
        // a dead yt-dlp URL would just be re-served from cache — drop it and
        // let the hidden iframe take over (the designed fallback)
        if (t.source === "yt" && t.streamId) {
          void yt.invalidate?.(t.streamId).catch(() => null)
          // engine up front — gated iframe events (error/ended/paused) must
          // route normally during the recovery attempt, not be swallowed
          engine = "yt"
          const ok = await ytEngine.play(t.streamId)
          // a newer load or a mid-load cancel must not resurrect this retry
          if (seqAtErr !== loadSeq || usePlayer.getState().current?.id !== t.id) return
          if (ok) {
            ytEngine.setVolume(usePlayer.getState().volume)
            ytEngine.setMuted(usePlayer.getState().muted)
            return
          }
          engine = "audio" // iframe failed too — keep trying the url below
        }
        const url = await resolveStream(t)
        // a is captured at bind time — if the live element was adopted away
        // meanwhile, writing here would ghost-play on a detached element
        if (seqAtErr !== loadSeq || a !== audio ||
            usePlayer.getState().current?.id !== t.id || engine !== "audio") return
        if (url) {
          a.src = url
          void a.play().catch(() => {})
        } else {
          failAdvance()
        }
      })()
    } else {
      failAdvance()
    }
  })
  return a
}

// ---- wire the hidden YouTube engine into the store (once) ----
// Callbacks are gated the same way: iframe events only drive state while
// it owns playback. While racingSeq is set, errors/endings are reported
// through play()'s promise inside loadAt instead.
ytEngine.setEvents({
  onPlaying: (d) => {
    // always accepted — whichever engine actually emitted sound wins
    autoFailStreak = 0
    loadPendingSeq = 0
    disarmWatchdog()
    disarmStall()
    usePlayer.setState({ isPlaying: true, buffering: false, ...(d > 0 ? { duration: d } : {}) })
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"
    prefetchNextTrack()
  },
  onDuration: (d) => {
    // the iframe emits duration late via the poll — backfill tracks whose
    // metadata arrived with duration 0
    if (engine === "yt" && Number.isFinite(d) && d > 0) usePlayer.setState({ duration: d })
  },
  onPaused: () => {
    if (engine !== "yt" || racingSeq !== 0) return
    saveResume()
    usePlayer.setState({ isPlaying: false })
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
  },
  onBuffering: () => {
    if (engine === "yt" || racingSeq !== 0) {
      usePlayer.setState({ buffering: true })
      if (engine === "yt") armStall()
    }
  },
  onEnded: () => {
    if (engine === "yt" && racingSeq === 0) usePlayer.getState().next(true)
  },
  onTime: (t) => {
    if (engine === "yt") usePlayer.setState({ currentTime: t })
  },
  onError: () => {
    // the video died while the iframe OWNED playback — move on. While a
    // race is pending, the failure arrives via play()'s promise instead.
    if (engine !== "yt" || racingSeq !== 0) return
    failAdvance()
  },
})

// Apply volume to the live engines without a store write — used while the
// volume slider is scrubbing (persist only on commit; a set() per
// pointermove serializes the store to localStorage and janks the drag).
export function applyVolume(v: number) {
  if (!Number.isFinite(v)) return
  const vol = Math.min(1, Math.max(0, v))
  if (vol > 0 && usePlayer.getState().muted) {
    audio.muted = false
    ytEngine.setMuted(false)
  }
  audio.volume = vol
  ytEngine.setVolume(vol)
}

// expose store for debugging / e2e verification
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>
  w.__player = usePlayer
  if (import.meta.env.DEV)
    w.__fade = () => ({
      incoming: incomingEl
        ? { t: incomingEl.currentTime, paused: incomingEl.paused, rs: incomingEl.readyState }
        : null,
      fading: fadingEl ? { t: fadingEl.currentTime, paused: fadingEl.paused } : null,
      prebuffer: prebuffer
        ? { id: prebuffer.id, rs: prebuffer.el.readyState, err: !!prebuffer.el.error, t: prebuffer.el.currentTime }
        : null,
      timer: fadeTimer !== null,
      retiring: retiring.size,
      engine,
    })
}

// restore persisted audio settings on boot
{
  const { volume, muted } = usePlayer.getState()
  audio.volume = volume
  audio.muted = muted
}

// ---- resume-position side key (cheap writes, never on the tick path) ----
function saveResume() {
  const { currentTime, current } = usePlayer.getState()
  try {
    if (current && currentTime > 0)
      localStorage.setItem(
        "freebify-resume",
        JSON.stringify({ vid: current.streamId ?? current.id, t: currentTime })
      )
    else localStorage.removeItem("freebify-resume")
  } catch {
    /* ignore */
  }
}
window.setInterval(() => {
  if (usePlayer.getState().isPlaying) saveResume()
}, 8000)
window.addEventListener("beforeunload", saveResume)

// ---- OS media controls (Windows SMTC / hardware media keys) ----
function updateMediaSession(track: Track) {
  if (!("mediaSession" in navigator)) return
  const art = track.artwork
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    // a malformed track (bad API row that slipped validation) must not
    // throw mid-load — the watchdog would cover it, but it'd be a silent
    // unhandled rejection first
    artist: track.user?.name ?? "",
    album: track.album?.name ?? "Freebify",
    artwork: (
      [
        { src: art?.["150x150"], sizes: "150x150" },
        { src: art?.["480x480"], sizes: "480x480" },
        { src: art?.["1000x1000"], sizes: "1000x1000" },
      ] as MediaImage[]
    ).filter((a) => Boolean(a.src)),
  })
}

if ("mediaSession" in navigator) {
  // route through toggle() — it knows about restored sessions, pending
  // loads, and which engine owns playback
  navigator.mediaSession.setActionHandler("play", () => {
    if (!usePlayer.getState().isPlaying) usePlayer.getState().toggle()
  })
  navigator.mediaSession.setActionHandler("pause", () => {
    if (usePlayer.getState().isPlaying) usePlayer.getState().toggle()
  })
  navigator.mediaSession.setActionHandler("previoustrack", () => usePlayer.getState().prev())
  navigator.mediaSession.setActionHandler("nexttrack", () => usePlayer.getState().next())
  navigator.mediaSession.setActionHandler("seekto", (d) => {
    if (d.seekTime != null) usePlayer.getState().seek(d.seekTime)
  })
  navigator.mediaSession.setActionHandler("seekbackward", (d) => {
    const s = usePlayer.getState()
    s.seek(Math.max(0, s.currentTime - (d.seekOffset ?? 10)))
  })
  navigator.mediaSession.setActionHandler("seekforward", (d) => {
    const s = usePlayer.getState()
    s.seek(s.currentTime + (d.seekOffset ?? 10))
  })
}

// ---- Windows taskbar thumbnail toolbar ----
// main process sends commands from the hover buttons; we push play/pause
// state back so the toolbar shows the right icon and tooltip.
{
  const bridge = window.freebify?.player
  bridge?.onCommand?.((c) => {
    const s = usePlayer.getState()
    if (c === "toggle") s.toggle()
    else if (c === "next") s.next()
    else if (c === "prev") s.prev()
    else if (c === "like") {
      const cur = s.current
      if (cur) useLibrary.getState().toggleLike(cur)
    }
  })
  let lastSig = ""
  let lastProgress = -1
  const pushThumbar = (s: ReturnType<typeof usePlayer.getState>) =>
    bridge?.thumbar({
      playing: s.isPlaying,
      title: s.current?.title,
      artist: s.current?.user?.name,
      progress: s.isPlaying && s.duration > 0 ? Math.min(1, s.currentTime / s.duration) : -1,
    })
  // push a state immediately — otherwise the toolbar only ever appears
  // after the first play/pause state change
  bridge?.thumbar({ playing: false })

  // boot warm-up — a relaunched session should play instantly too: resolve
  // the restored track + the next few through the low-priority lane while
  // the UI finishes painting
  setTimeout(() => {
    const s = usePlayer.getState()
    s.queue.slice(s.index, s.index + 5).forEach(prefetchStream)
  }, 1200)
  usePlayer.subscribe((s) => {
    const sig = `${s.isPlaying}|${s.current?.id ?? ""}`
    const progress = s.isPlaying && s.duration > 0 ? Math.round((s.currentTime / s.duration) * 40) / 40 : -1
    if (sig === lastSig && progress === lastProgress) return
    lastSig = sig
    lastProgress = progress
    pushThumbar(s)
  })

  // Discord Rich Presence — Discord renders the progress bar itself from
  // start/end timestamps, so only real transitions need a push: track
  // change, play/pause, and seeks (>3s position jumps). A presenceEnabled
  // broadcast toggles the whole feature from Settings.
  let rpcEnabled = localStorage.getItem("freebify-discord") !== "off"
  let rpcLastKey = ""
  const pushPresence = (s: ReturnType<typeof usePlayer.getState>) => {
    if (!rpcEnabled) return
    const cur = s.current
    bridge?.presence?.(
      cur && s.isPlaying
        ? {
            playing: true,
            title: cur.title,
            artist: cur.user?.name,
            artwork: cur.artwork?.["480x480"] ?? cur.artwork?.["150x150"],
            durationMs: Math.round((s.duration || cur.duration || 0) * 1000),
            positionMs: Math.round(s.currentTime * 1000),
            url: cur.id.startsWith("yt-")
              ? `https://music.youtube.com/watch?v=${cur.id.slice(3)}`
              : undefined,
          }
        : null
    )
  }
  usePlayer.subscribe((s, prev) => {
    const cur = s.current
    const key = s.isPlaying ? `${cur?.id}|play` : cur ? `${cur.id}|paused` : "idle"
    const jumped = Math.abs(s.currentTime - (prev?.currentTime ?? 0)) > 3
    if (key === rpcLastKey && !jumped) return
    rpcLastKey = key
    pushPresence(s)
  })
  window.addEventListener("freebify:discord-toggle", (e) => {
    rpcEnabled = (e as CustomEvent<boolean>).detail !== false
    bridge?.presenceEnabled?.(rpcEnabled)
    if (!rpcEnabled) bridge?.presence?.(null)
    else pushPresence(usePlayer.getState())
  })
  bridge?.presenceEnabled?.(rpcEnabled)
}
