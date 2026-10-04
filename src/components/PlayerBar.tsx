import {
  Heart, ListMusic, Loader2, Maximize2, Pause, Play, Repeat, Repeat1,
  Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useState } from "react"
import { Link } from "react-router-dom"
import { useLibrary } from "../store/library"
import { usePlayer, applyVolume } from "../store/player"
import { fmtDuration } from "../utils/format"
import { ArtworkImg } from "./ArtworkImg"
import { Equalizer } from "./Equalizer"
import { Marquee } from "./Marquee"
import { Slider } from "./Slider"

export function PlayerBar() {
  const current = usePlayer((s) => s.current)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const buffering = usePlayer((s) => s.buffering)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const queueOpen = usePlayer((s) => s.queueOpen)

  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const setNpOpen = usePlayer((s) => s.setNpOpen)
  const setQueueOpen = usePlayer((s) => s.setQueueOpen)

  const liked = useLibrary((s) => (current ? Boolean(s.liked[current.id]) : false))
  const toggleLike = useLibrary((s) => s.toggleLike)
  // pulse only when the user actually likes — a track change to an
  // already-liked song shouldn't replay the burst every time
  const [pop, setPop] = useState(0)

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const disabled = !current

  return (
    <motion.footer
      initial={{ y: 96 }}
      animate={{ y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="z-40 grid h-[88px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-4 border-t border-line bg-panel/95 px-4 backdrop-blur"
    >
      {/* current track */}
      <div className="flex min-w-0 items-center gap-3">
        {current ? (
          <>
            <motion.button
              layoutId="np-art"
              onClick={() => setNpOpen(true)}
              aria-label="Open Now Playing"
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              className="relative size-14 shrink-0 overflow-hidden rounded-lg"
            >
              <ArtworkImg art={current.artwork} size="150x150" alt={current.title} className="size-full" />
              {isPlaying && (
                <div className="absolute inset-0 grid place-items-center bg-black/40">
                  <Equalizer playing className="text-white" />
                </div>
              )}
            </motion.button>
            <div className="min-w-0">
              {/* meta crossfades on track change instead of hard-swapping */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={current.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16 }}
                >
                  <Marquee text={current.title} className="text-sm font-semibold" />
                  <Link
                    to={`/artist/${encodeURIComponent(current.user.id)}?n=${encodeURIComponent(current.user.name)}`}
                    className="block truncate text-xs text-dim transition hover:text-ink hover:underline"
                  >
                    {current.user.name}
                  </Link>
                </motion.div>
              </AnimatePresence>
            </div>
            <motion.button
              whileTap={{ scale: 0.8 }}
              onClick={() => {
                if (!liked) setPop((p) => p + 1)
                toggleLike(current)
              }}
              aria-label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
              aria-pressed={liked}
              className={`ml-1 shrink-0 transition ${liked ? "text-ink" : "text-dim hover:text-ink"}`}
            >
              <motion.span
                key={pop}
                initial={pop > 0 ? { scale: 1.55 } : false}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 16 }}
                className="block"
              >
                <Heart size={17} className={liked ? "fill-current" : ""} />
              </motion.span>
            </motion.button>
          </>
        ) : (
          <>
            <div className="grid size-14 shrink-0 place-items-center rounded-lg bg-card text-faint">
              <Play size={20} />
            </div>
            <p className="truncate text-sm text-dim">Pick something to play</p>
          </>
        )}
      </div>

      {/* transport + progress */}
      <div className="flex min-w-0 flex-col items-center gap-1.5">
        <div className="flex items-center gap-5">
          <CtlBtn onClick={toggleShuffle} disabled={disabled} label="Shuffle" active={shuffle} pressed={shuffle}>
            <Shuffle size={16} />
          </CtlBtn>
          <CtlBtn onClick={() => prev()} disabled={disabled} label="Previous">
            <SkipBack size={18} className="fill-current" />
          </CtlBtn>
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={toggle}
            disabled={disabled}
            aria-label={buffering && !isPlaying ? "Cancel loading" : isPlaying ? "Pause" : "Play"}
            className="grid size-10 place-items-center overflow-hidden rounded-full bg-white text-black shadow-lg transition enabled:hover:scale-105 disabled:opacity-40"
          >
            {/* transport icon morphs play ↔ pause ↔ spinner */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={buffering ? "load" : isPlaying ? "pause" : "play"}
                initial={{ scale: 0.4, opacity: 0, rotate: -30 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                exit={{ scale: 0.4, opacity: 0, rotate: 30 }}
                transition={{ duration: 0.14 }}
                className="grid place-items-center"
              >
                {buffering ? (
                  <Loader2 size={19} className="animate-spin" />
                ) : isPlaying ? (
                  <Pause size={19} className="fill-current" />
                ) : (
                  <Play size={19} className="ml-0.5 fill-current" />
                )}
              </motion.span>
            </AnimatePresence>
          </motion.button>
          <CtlBtn onClick={() => next()} disabled={disabled} label="Next">
            <SkipForward size={18} className="fill-current" />
          </CtlBtn>
          <CtlBtn
            onClick={cycleRepeat}
            disabled={disabled}
            label={repeat === "one" ? "Repeat: one" : repeat === "all" ? "Repeat: all" : "Repeat: off"}
            active={repeat !== "off"}
            pressed={repeat !== "off"}
          >
            {repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
          </CtlBtn>
        </div>
        {/* SeekBar subscribes to currentTime itself — the ~4Hz tick used to
            re-render this whole footer (and its layoutId'd artwork) */}
        <SeekBar />
      </div>

      {/* right controls */}
      <div className="flex items-center justify-end gap-3">
        <button
          onClick={() => setQueueOpen(!queueOpen)}
          aria-label="Queue"
          aria-pressed={queueOpen}
          className={`transition hover:text-ink ${queueOpen ? "text-ink" : "text-dim"}`}
        >
          <ListMusic size={18} />
        </button>
        <button onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} className="text-dim transition hover:text-ink">
          <VolumeIcon size={18} />
        </button>
        {/* value stays the real volume while muted — keyboard arrows then
            resume from the user's volume (not 0), matching the global
            ArrowUp/Down shortcut behavior */}
        <Slider
          value={volume}
          max={1}
          onScrub={applyVolume}
          onCommit={(v) => setVolume(v)}
          className="w-24"
          ariaLabel="Volume"
        />
        <button
          onClick={() => setNpOpen(true)}
          disabled={disabled}
          aria-label="Now playing"
          className="text-dim transition enabled:hover:text-ink disabled:opacity-40"
        >
          <Maximize2 size={16} />
        </button>
      </div>
    </motion.footer>
  )
}

function SeekBar() {
  const currentTime = usePlayer((s) => s.currentTime)
  const duration = usePlayer((s) => s.duration)
  const trackDur = usePlayer((s) => s.current?.duration ?? 0)
  const hasTrack = usePlayer((s) => s.current !== null)
  const seek = usePlayer((s) => s.seek)
  const dur = duration || trackDur || 0
  return (
    <div className="flex w-full max-w-xl items-center gap-2">
      <span className="min-w-10 text-right text-[11px] tabular-nums text-dim">{fmtDuration(currentTime)}</span>
      <Slider value={currentTime} max={dur} className="flex-1" onCommit={(v) => seek(v)} smooth ariaLabel="Seek" disabled={!hasTrack} />
      <span className="min-w-10 text-[11px] tabular-nums text-dim">{fmtDuration(dur)}</span>
    </div>
  )
}

function CtlBtn({
  children,
  onClick,
  disabled,
  label,
  active,
  pressed,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  label: string
  active?: boolean
  pressed?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      className={`relative transition disabled:opacity-40 ${
        active ? "text-ink" : "text-dim enabled:hover:text-ink"
      }`}
    >
      {children}
      {active && (
        <motion.span
          layout
          className="absolute -bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-ink"
        />
      )}
    </button>
  )
}
