import { AnimatePresence, motion } from "motion/react"
import { ArrowDownToLine, X } from "lucide-react"
import { Suspense, lazy, useEffect, useState } from "react"
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { NowPlaying } from "./components/NowPlaying"
import { PlayerBar } from "./components/PlayerBar"
import { QueuePanel } from "./components/QueuePanel"
import { RewindOverlay } from "./components/Rewind"
import { Sidebar } from "./components/Sidebar"
import { TitleBar } from "./components/TitleBar"
import { Toast } from "./components/Toast"
import { TopBar } from "./components/TopBar"
import { Home } from "./pages/Home"
import { SearchPage } from "./pages/Search"
import { useLibrary } from "./store/library"
import { applyVolume, usePlayer } from "./store/player"
import { isRewindSeen, latestRewind, useRewind } from "./store/rewind"

// Route-level splitting: pages lazy-load off the initial bundle (~40%
// lighter first paint), then idle-prefetch warms every chunk while the
// user is still reading Home — navigation stays instant anyway.
const ArtistPage = lazy(() => import("./pages/Artist").then((m) => ({ default: m.ArtistPage })))
const DownloadsPage = lazy(() => import("./pages/Downloads").then((m) => ({ default: m.DownloadsPage })))
const GenrePage = lazy(() => import("./pages/Genre").then((m) => ({ default: m.GenrePage })))
const LibraryPage = lazy(() => import("./pages/Library").then((m) => ({ default: m.LibraryPage })))
const MoodPage = lazy(() => import("./pages/MoodPage").then((m) => ({ default: m.MoodPage })))
const PlaylistPage = lazy(() => import("./pages/Playlist").then((m) => ({ default: m.PlaylistPage })))
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })))
const StatsPage = lazy(() => import("./pages/Stats").then((m) => ({ default: m.StatsPage })))

const warmPages = () => {
  void import("./pages/Artist")
  void import("./pages/Downloads")
  void import("./pages/Genre")
  void import("./pages/Library")
  void import("./pages/MoodPage")
  void import("./pages/Playlist")
  void import("./pages/Settings")
  void import("./pages/Stats")
}

function ScrollReset() {
  const { pathname } = useLocation()
  useEffect(() => {
    document.getElementById("main-scroll")?.scrollTo({ top: 0 })
  }, [pathname])
  return null
}

// held arrow keys scrub volume — commit to the persisted store only once
// the mashing stops (a set() per repeat tick serializes the whole queue)
let volCommitTimer: ReturnType<typeof setTimeout> | null = null

function useShortcuts() {
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
      const p = usePlayer.getState()
      // the Rewind story owns the keyboard while it's open — Space/arrows
      // navigate slides, not playback
      if (useRewind.getState().active) return
      // Ctrl/Cmd+F — Spotify's in-app find: jump to search AND focus the
      // input (navigating to the same route wouldn't remount/focus it)
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyF") {
        e.preventDefault()
        navigate("/search")
        document.getElementById("search-input")?.focus()
        return
      }
      // Escape must work from inside inputs too — it has no input-level
      // default, so hoist it above the typing guard
      if (e.code === "Escape") {
        // an open ⋯ row menu owns Escape first — its own listener closes
        // it; collapsing the queue/NP under it would swallow the dismiss
        if (document.querySelector('[role="menu"]')) return
        if (p.npOpen) p.setNpOpen(false)
        else if (p.queueOpen && window.innerWidth < 1024) p.setQueueOpen(false)
        else if (typing) (el as HTMLElement).blur()
        return
      }
      if (typing) return
      // modified keys belong to the OS/browser — Ctrl+N must not toggle
      // Now Playing, Alt+L must not like, etc.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // key-repeat: holding Space strobes play/pause 30x/s; holding L spams
      // the persisted like store. Arrows DO want repeat (scrub hold).
      if (e.repeat && !e.code.startsWith("Arrow")) return
      switch (e.code) {
        case "Space":
          // don't hijack a focused button's native activation. Anchors are
          // NOT exempt — Space on a link natively scrolls the page, not
          // activates it, so a focused link would scroll instead of pausing
          if (el.tagName === "BUTTON") return
          e.preventDefault()
          p.toggle()
          break
        case "ArrowRight":
          p.seek(p.currentTime + 10)
          break
        case "ArrowLeft":
          p.seek(Math.max(0, p.currentTime - 10))
          break
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault()
          const v = Math.min(1, Math.max(0, p.volume + (e.code === "ArrowUp" ? 0.05 : -0.05)))
          applyVolume(v)
          if (volCommitTimer) clearTimeout(volCommitTimer)
          volCommitTimer = setTimeout(() => usePlayer.getState().setVolume(v), 250)
          break
        }
        case "KeyM":
          p.toggleMute()
          break
        case "KeyL":
          if (p.current) useLibrary.getState().toggleLike(p.current)
          break
        case "KeyN":
          // no point opening Now Playing for an empty player — it would
          // linger armed and pop open on the first track played later
          if (p.current) p.setNpOpen(!p.npOpen)
          break
        case "KeyQ":
          p.setQueueOpen(!p.queueOpen)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate])
}

// global offline indicator — page-level retry cards can't explain a dead
// network mid-session; this pins a banner the moment connectivity drops
function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine)
  useEffect(() => {
    const off = () => setOffline(true)
    const on = () => setOffline(false)
    window.addEventListener("offline", off)
    window.addEventListener("online", on)
    return () => {
      window.removeEventListener("offline", off)
      window.removeEventListener("online", on)
    }
  }, [])
  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="pointer-events-none fixed left-1/2 top-14 z-[60] -translate-x-1/2 rounded-full bg-panel/90 px-4 py-1.5 text-xs font-semibold text-ink ring-1 ring-line backdrop-blur"
        >
          You're offline — playback may stop until the connection returns
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// fires the monthly Rewind once per month — the story opens by itself the
// first launch after a month closes (and stays replayable from Home/Stats)
function RewindAutoOpen() {
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const r = latestRewind()
        if (r && !isRewindSeen(r.key)) useRewind.getState().open(r)
      } catch {
        /* a rewind surprise must never block app startup */
      }
    }, 3500)
    return () => clearTimeout(t)
  }, [])
  return null
}

export default function App() {
  const npOpen = usePlayer((s) => s.npOpen)
  const queueOpen = usePlayer((s) => s.queueOpen)
  const location = useLocation()
  const navigate = useNavigate()
  useShortcuts()

  // freebify:// deep links from the OS → route inside the app
  useEffect(() => {
    const off = window.freebify?.app?.onDeepLink?.((p) => {
      if (typeof p === "string" && p.startsWith("/")) navigate(p)
    })
    return () => off?.()
  }, [navigate])

  // (update banner mounts itself — it listens for the ready event AND
  // re-asks on mount for updates that landed while the window was hidden)

  // below lg the queue is a fixed overlay — reserve space so its panel
  // doesn't sit on top of content (row actions, card menus, text)
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // after first paint, warm the lazy route chunks in the background —
  // Electron reads them from disk so this is cheap, and the first real
  // navigation to any page then hits an already-resolved module
  useEffect(() => {
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback
    if (idle) {
      const h = idle.call(window, warmPages, { timeout: 4000 })
      return () => (window as unknown as { cancelIdleCallback: (h: number) => void }).cancelIdleCallback(h)
    }
    const t = setTimeout(warmPages, 1500)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="relative flex h-full flex-col">
      {/* no dedicated titlebar strip — window chrome is invisible; drag
          regions live on the top band, controls float top-right */}
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            id="main-scroll"
            className="scroller relative min-h-0 flex-1 overflow-y-auto transition-[padding] duration-200"
            style={queueOpen && narrow ? { paddingRight: 320 } : undefined}
          >
            <TopBar />
            <ScrollReset />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="min-h-full"
              >
                {/* a render-time crash in any page gets contained to a
                    recoverable panel instead of blanking the whole app */}
                <ErrorBoundary resetKey={location.pathname}>
                  {/* lazy routes: no fallback chrome — the fetch is a local
                      file read in Electron, and pages paint their own
                      skeletons the moment the chunk lands */}
                  <Suspense fallback={null}>
                  <Routes location={location}>
                    <Route path="/" element={<Home />} />
                    <Route path="/search" element={<SearchPage />} />
                    <Route path="/library" element={<LibraryPage />} />
                    <Route path="/downloads" element={<DownloadsPage />} />
                    <Route path="/stats" element={<StatsPage />} />
                    <Route path="/artist/:id" element={<ArtistPage />} />
                    <Route path="/playlist/:id" element={<PlaylistPage />} />
                    <Route path="/genre/:name" element={<GenrePage />} />
                    <Route path="/mood/:params" element={<MoodPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                  </Suspense>
                </ErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence>{queueOpen && <QueuePanel />}</AnimatePresence>
      </div>
      <PlayerBar />
      <Toast />
      <OfflineBanner />
      <UpdateBanner />
      <AnimatePresence>{npOpen && <NowPlaying />}</AnimatePresence>
      <RewindOverlay />
      <RewindAutoOpen />
    </div>
  )
}

// persistent "update ready" card — one click installs. The download itself
// already happened in the background (autoDownload); a transient toast was
// too easy to miss and the tray item is one menu too deep.
function UpdateBanner() {
  const [upd, setUpd] = useState<{ version: string; manual: boolean } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    const off = window.freebify?.app?.onUpdateReady?.((p) => {
      // payload is {version, manual} — tolerate a bare string from older builds
      setUpd(typeof p === "string" ? { version: p, manual: false } : p)
      setDismissed(false)
    })
    window.freebify?.app?.updateStatus?.()
      .then((s) => {
        if (s?.pending) setUpd({ version: s.pending, manual: s.manual === true })
      })
      .catch(() => {})
    return () => off?.()
  }, [])
  return (
    <AnimatePresence>
      {upd && !dismissed && (
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="fixed bottom-24 right-5 z-[70] flex items-center gap-3 rounded-xl border border-line bg-card/95 py-2.5 pl-4 pr-2.5 shadow-2xl shadow-black/60 backdrop-blur"
        >
          <ArrowDownToLine size={15} className="shrink-0 text-ink" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-tight text-ink">v{upd.version} {upd.manual ? "available" : "ready"}</p>
            <p className="text-[11px] leading-tight text-dim">{upd.manual ? "Download the new dmg" : "Restart to update"}</p>
          </div>
          <button
            onClick={() => void window.freebify?.app?.installUpdate?.()}
            className="ml-1 shrink-0 rounded-full bg-white px-3.5 py-1.5 text-xs font-bold text-black transition hover:scale-[1.04]"
          >
            {upd.manual ? "Download" : "Restart"}
          </button>
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update"
            className="grid size-6 shrink-0 place-items-center rounded-full text-faint transition hover:bg-white/10 hover:text-ink"
          >
            <X size={12} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
