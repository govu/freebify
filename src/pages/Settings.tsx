import { motion } from "motion/react"
import { Download, FolderOpen, Gamepad2, Heart, Infinity as InfinityIcon, Keyboard, Power, Scale, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useLibrary } from "../store/library"
import { notify, usePlayer } from "../store/player"
import { useStats } from "../store/stats"

interface AppInfo {
  version: string
  electron: string
  chromium: string
  platform: string
  canUpdate?: boolean
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
  const [discord, setDiscord] = useState(() => {
    try {
      return localStorage.getItem("freebify-discord") !== "off"
    } catch {
      return true
    }
  })
  const [checking, setChecking] = useState(false)
  const [loginItem, setLoginItem] = useState(false)

  const checkUpdates = async () => {
    const fn = window.freebify?.app?.checkUpdate
    if (!fn || checking) return
    setChecking(true)
    try {
      const r = await fn()
      if (r?.pending) notify(`v${r.pending} is ready — restart from the banner`)
      else if (r?.update) notify(`v${r.latest} available — downloading in the background`)
      else if (r?.failed) notify("Update check failed. Try again later")
      else notify("You're up to date")
    } catch {
      notify("Update check failed")
    }
    setChecking(false)
  }

  const toggleDiscord = () => {
    const next = !discord
    setDiscord(next)
    try {
      localStorage.setItem("freebify-discord", next ? "on" : "off")
    } catch { /* storage unavailable — pref stays session-only */ }
    window.dispatchEvent(new CustomEvent("freebify:discord-toggle", { detail: next }))
  }

  const toggleLogin = () => {
    const next = !loginItem
    void window.freebify?.app?.login?.set(next).then((ok) => {
      if (ok) setLoginItem(next)
    })
  }

  useEffect(() => {
    window.freebify?.app?.info().then(setInfo).catch(() => {})
    window.freebify?.app?.login?.get().then(setLoginItem).catch(() => {})
  }, [])

  const clearCache = () => {
    try {
      // wipe only our keys — not the persisted library/player (those are
      // the user's data, not cache)
      const keep = new Set(["freebify-library", "freebify-player", "freebify-resume"])
      for (const k of Object.keys(localStorage)) {
        if (!keep.has(k)) localStorage.removeItem(k)
      }
      notify("Cache cleared. Your library is untouched")
    } catch {
      notify("Couldn't clear the cache")
    }
  }

  const exportData = () => {
    try {
      const { liked, likedOrder, recents, playlists } = useLibrary.getState()
      const { tracks, artists, days, months, totalMs, totalPlays } = useStats.getState()
      const blob = new Blob([JSON.stringify({
        app: "freebify", version: 1, exportedAt: new Date().toISOString(),
        library: { liked, likedOrder, recents, playlists },
        stats: { tracks, artists, days, months, totalMs, totalPlays },
      }, null, 0)], { type: "application/json" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `freebify-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      notify("Backup exported")
    } catch { notify("Export failed") }
  }

  return (
    <div className="-mt-12 px-6 pb-10 pt-16">
      <h1 className="mb-8 text-3xl font-black tracking-tight">Settings</h1>

      <div className="max-w-xl space-y-3">
        {/* playback */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold text-dim">Playback</h2>
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
          <button
            onClick={toggleDiscord}
            aria-pressed={discord}
            className="mt-3 flex w-full items-center gap-3 text-left"
          >
            <Gamepad2 size={16} className={discord ? "text-ink" : "text-faint"} />
            <span className="flex-1">
              <span className="block text-sm font-medium">Discord status</span>
              <span className="block text-xs text-dim">Show what you're listening to on your profile</span>
            </span>
            <span className={`relative h-5 w-9 rounded-full transition-colors ${discord ? "bg-ink" : "bg-hover"}`}>
              <motion.span
                layout
                transition={{ type: "spring", stiffness: 500, damping: 34 }}
                className={`absolute top-1 size-3 rounded-full ${discord ? "left-5 bg-black" : "left-1 bg-dim"}`}
              />
            </span>
          </button>
          {window.freebify?.app?.login && (
            <button
              onClick={toggleLogin}
              aria-pressed={loginItem}
              className="mt-3 flex w-full items-center gap-3 text-left"
            >
              <Power size={16} className={loginItem ? "text-ink" : "text-faint"} />
              <span className="flex-1">
                <span className="block text-sm font-medium">Open Freebify when you sign in</span>
                <span className="block text-xs text-dim">Start with your desktop, ready in the background</span>
              </span>
              <span className={`relative h-5 w-9 rounded-full transition-colors ${loginItem ? "bg-ink" : "bg-hover"}`}>
                <motion.span
                  layout
                  transition={{ type: "spring", stiffness: 500, damping: 34 }}
                  className={`absolute top-1 size-3 rounded-full ${loginItem ? "left-5 bg-black" : "left-1 bg-dim"}`}
                />
              </span>
            </button>
          )}
        </section>

        {/* library */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold text-dim">Library</h2>
          <p className="text-sm text-dim">
            {Object.keys(liked).length} liked songs · {playlists.length} playlists — stored locally on this device.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={clearCache}
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Trash2 size={13} /> Clear artwork & lyrics cache
            </button>
            <button
              onClick={exportData}
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Download size={13} /> Export library & stats
            </button>
          </div>
        </section>

        {/* shortcuts */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-dim">
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
          <h2 className="mb-3 text-sm font-semibold text-dim">About</h2>
          <p className="text-sm font-semibold">Freebify {info ? `v${info.version}` : ""}</p>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            Free, ad-free music. Freebify is a player, not a host — all audio & metadata are fetched
            by your device, directly from YouTube Music & the Audius public API, under their own
            terms. For personal, non-commercial use. Not affiliated with Spotify, YouTube, Google
            or Audius.
            {info && (
              <span className="mt-1 block text-faint">
                Electron {info.electron} · Chromium {info.chromium}
              </span>
            )}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {info?.canUpdate && (
              <button
                onClick={() => void checkUpdates()}
                disabled={checking}
                className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink disabled:opacity-50"
              >
                {checking ? "Checking…" : "Check for updates"}
              </button>
            )}
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
            <a
              href="https://github.com/govu/freebify/blob/main/DISCLAIMER.md"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Scale size={13} /> Legal — disclaimer & terms
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}
