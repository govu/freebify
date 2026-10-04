import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState } from "react"
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { NowPlaying } from "./components/NowPlaying"
import { PlayerBar } from "./components/PlayerBar"
import { QueuePanel } from "./components/QueuePanel"
import { Sidebar } from "./components/Sidebar"
import { TitleBar } from "./components/TitleBar"
import { Toast } from "./components/Toast"
import { TopBar } from "./components/TopBar"
import { ArtistPage } from "./pages/Artist"
import { GenrePage } from "./pages/Genre"
import { Home } from "./pages/Home"
import { LibraryPage } from "./pages/Library"
import { MoodPage } from "./pages/MoodPage"
import { PlaylistPage } from "./pages/Playlist"
import { SearchPage } from "./pages/Search"
import { SettingsPage } from "./pages/Settings"
import { useLibrary } from "./store/library"
import { applyVolume, notify, usePlayer } from "./store/player"

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

  // "update downloaded" → one quiet toast; it installs on quit
  useEffect(() => {
    const off = window.freebify?.app?.onUpdateReady?.((v) =>
      notify(`Update ready — v${v} installs when you quit`),
    )
    return () => off?.()
  }, [])

  return (
    <div className="relative flex h-full flex-col">
      {/* no dedicated titlebar strip — window chrome is invisible; drag
          regions live on the top band, controls float top-right */}
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <div id="main-scroll" className="scroller relative min-h-0 flex-1 overflow-y-auto">
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
                  <Routes location={location}>
                    <Route path="/" element={<Home />} />
                    <Route path="/search" element={<SearchPage />} />
                    <Route path="/library" element={<LibraryPage />} />
                    <Route path="/artist/:id" element={<ArtistPage />} />
                    <Route path="/playlist/:id" element={<PlaylistPage />} />
                    <Route path="/genre/:name" element={<GenrePage />} />
                    <Route path="/mood/:params" element={<MoodPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
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
      <AnimatePresence>{npOpen && <NowPlaying />}</AnimatePresence>
    </div>
  )
}
