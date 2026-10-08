import { motion } from "motion/react"
import { Download, FolderOpen, Gamepad2, Heart, Infinity as InfinityIcon, Keyboard, Power, Scale, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { LANGS, t, useI18n, useT } from "../i18n"
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

// first column: keycap label — "settings.k.*" entries resolve via the locale
// fallback (unknown keys return themselves), so literal keycaps pass through
const SHORTCUTS: [string, string][] = [
  ["settings.k.space", "settings.sc.playPause"],
  ["← / →", "settings.sc.seek"],
  ["↑ / ↓", "settings.sc.volume"],
  ["M", "settings.sc.mute"],
  ["L", "settings.sc.like"],
  ["N", "settings.sc.nowPlaying"],
  ["Q", "settings.sc.queue"],
  ["Ctrl+F", "settings.sc.search"],
  ["Esc", "settings.sc.closePanels"],
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
  const lang = useI18n((s) => s.lang)
  const setLang = useI18n((s) => s.setLang)
  const tt = useT()

  const checkUpdates = async () => {
    const fn = window.freebify?.app?.checkUpdate
    if (!fn || checking) return
    setChecking(true)
    try {
      const r = await fn()
      if (r?.pending) notify(t("settings.update.pending", { v: r.pending }))
      else if (r?.update) notify(t("settings.update.available", { v: r.latest ?? "" }))
      else if (r?.failed) notify(t("settings.update.failedLater"))
      else notify(t("settings.update.latest"))
    } catch {
      notify(t("settings.update.failed"))
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
      notify(t("settings.cacheCleared"))
    } catch {
      notify(t("settings.cacheFailed"))
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
      notify(t("settings.backupExported"))
    } catch { notify(t("settings.exportFailed")) }
  }

  return (
    <div className="-mt-12 px-6 pb-10 pt-16">
      <h1 className="mb-8 text-3xl font-black tracking-tight">{tt("settings.title")}</h1>

      <div className="max-w-xl space-y-3">
        {/* playback */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold text-dim">{tt("settings.playback")}</h2>
          <button
            onClick={() => setAutoplay(!autoplay)}
            aria-pressed={autoplay}
            className="flex w-full items-center gap-3 text-left"
          >
            <InfinityIcon size={16} className={autoplay ? "text-ink" : "text-faint"} />
            <span className="flex-1">
              <span className="block text-sm font-medium">{tt("settings.autoplay")}</span>
              <span className="block text-xs text-dim">{tt("settings.autoplay.sub")}</span>
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
              <span className="block text-sm font-medium">{tt("settings.discord")}</span>
              <span className="block text-xs text-dim">{tt("settings.discord.sub")}</span>
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
                <span className="block text-sm font-medium">{tt("settings.login")}</span>
                <span className="block text-xs text-dim">{tt("settings.login.sub")}</span>
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

        {/* language */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="text-sm font-semibold text-dim">{tt("settings.language")}</h2>
          <p className="mt-0.5 text-xs text-faint">{tt("settings.language.sub")}</p>
          <div className="mt-3 flex gap-2">
            {LANGS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLang(l.id)}
                aria-pressed={lang === l.id}
                className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition ${
                  lang === l.id
                    ? "border-transparent bg-ink text-black"
                    : "border-line text-dim hover:border-dim hover:text-ink"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </section>

        {/* library */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold text-dim">{tt("settings.library")}</h2>
          <p className="text-sm text-dim">
            {tt("settings.libraryStats", { liked: Object.keys(liked).length, playlists: playlists.length })}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={clearCache}
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Trash2 size={13} /> {tt("settings.clearCache")}
            </button>
            <button
              onClick={exportData}
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Download size={13} /> {tt("settings.export")}
            </button>
          </div>
        </section>

        {/* shortcuts */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-dim">
            <Keyboard size={15} /> {tt("settings.shortcuts")}
          </h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3">
            {SHORTCUTS.map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2.5 text-xs">
                <kbd className="rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink">
                  {tt(key)}
                </kbd>
                <span className="text-dim">{tt(desc)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* about + diagnostics */}
        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold text-dim">{tt("settings.about")}</h2>
          <p className="text-sm font-semibold">Freebify {info ? `v${info.version}` : ""}</p>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            {tt("settings.aboutBody")}
            {info && (
              <span className="mt-1 block text-faint">
                {tt("settings.aboutVersions", { electron: info.electron, chromium: info.chromium })}
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
                {checking ? tt("settings.checking") : tt("settings.checkUpdates")}
              </button>
            )}
            {window.freebify?.app?.openLogs && (
              <button
                onClick={() => window.freebify!.app!.openLogs()}
                className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
              >
                <FolderOpen size={13} /> {tt("settings.openLogs")}
              </button>
            )}
            <a
              href="https://github.com/govu/freebify"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Heart size={13} /> {tt("settings.contribute")}
            </a>
            <a
              href="https://github.com/govu/freebify/blob/main/DISCLAIMER.md"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-semibold text-dim transition hover:border-dim hover:text-ink"
            >
              <Scale size={13} /> {tt("settings.legal")}
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}
