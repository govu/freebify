import { motion } from "motion/react"
import { FolderOpen, Heart, Infinity as InfinityIcon, Keyboard, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useLibrary } from "../store/library"
import { notify, usePlayer } from "../store/player"

interface AppInfo {
  version: string
  electron: string
  chromium: string
  platform: string
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →", "Seek 10 seconds"],
  ["↑ / ↓", "Volume"],
  ["M", "Mute"],
  ["L", "Like current track"],
  ["N", "Now Playing"],
  ["Q", "Queue"],
  ["Ctrl+F", "Search"],
  ["Esc", "Close panels"],
]

export function SettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const autoplay = usePlayer((s) => s.autoplay)
  const setAutoplay = usePlayer((s) => s.setAutoplay)
  const playlists = useLibrary((s) => s.playlists)
  const liked = useLibrary((s) => s.liked)

  useEffect(() => {
    window.freebify?.app?.info().then(setInfo).catch(() => {})
  }, [])

  const clearCache = () => {
    try {
      // wipe only our keys — not the persisted library/player (those are
      // the user's data, not cache)
      const keep = new Set(["freebify-library", "freebify-player", "freebify-resume"])
      for (const k of Object.keys(localStorage)) {
        if (!keep.has(k)) localStorage.removeItem(k)
      }
      notify("Cache cleared — your library is untouched")
    } catch {
      notify("Couldn't clear the cache")
    }
  }

  return (
    <div className="-mt-12 px-6 pb-10 pt-16">
      <h1 className="mb-8 text-3xl font-black tracking-tight">Settings</h1>

      <div className="max-w-xl space-y-3">
        {/* playback */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-dim">Playback</h2>
          <button
            onClick={() => setAutoplay(!autoplay)}
            aria-pressed={autoplay}
            className="flex w-full items-center gap-3 text-left"
          >
            <InfinityIcon size={16} className={autoplay ? "text-ink" : "text-faint"} />
            <span className="flex-1">
              <span className="block text-sm font-medium">Autoplay similar songs</span>
              <span className="block text-xs text-dim">Keep the queue going when it ends</span>
            </span>
            <span className={`relative h-5 w-9 rounded-full transition-colors ${autoplay ? "bg-ink" : "bg-hover"}`}>
              <motion.span
                layout
                transition={{ type: "spring", stiffness: 500, damping: 34 }}
                className={`absolute top-1 size-3 rounded-full ${autoplay ? "left-5 bg-black" : "left-1 bg-dim"}`}
              />
            </span>
          </button>
        </section>

        {/* library */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-dim">Library</h2>
          <p className="text-sm text-dim">
            {Object.keys(liked).length} liked songs · {playlists.length} playlists — stored locally on this device.
          </p>
          <button
            onClick={clearCache}
            className="mt-4 flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
          >
            <Trash2 size={13} /> Clear artwork & lyrics cache
          </button>
        </section>

        {/* shortcuts */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-dim">
            <Keyboard size={15} /> Keyboard shortcuts
          </h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3">
            {SHORTCUTS.map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2.5 text-xs">
                <kbd className="rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink">
                  {key}
                </kbd>
                <span className="text-dim">{desc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* about + diagnostics */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-dim">About</h2>
          <p className="text-sm font-semibold">Freebify {info ? `v${info.version}` : ""}</p>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            Free, ad-free music. Catalog metadata via YouTube Music & the Audius open catalog —
            Freebify is a player, not a host; it doesn't upload or share anything.
            {info && (
              <span className="mt-1 block text-faint">
                Electron {info.electron} · Chromium {info.chromium}
              </span>
            )}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {window.freebify?.app?.openLogs && (
              <button
                onClick={() => window.freebify!.app!.openLogs()}
                className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
              >
                <FolderOpen size={13} /> Open logs folder
              </button>
            )}
            <a
              href="https://github.com/govu/freebify"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Heart size={13} /> Open source — contribute on GitHub
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}
