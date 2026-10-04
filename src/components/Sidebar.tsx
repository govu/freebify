import { Heart, House, Library, ListMusic, Search, Settings } from "lucide-react"
import { motion } from "motion/react"
import { Link, NavLink } from "react-router-dom"
import { useLibrary } from "../store/library"
import { usePlayer } from "../store/player"
import { ArtworkImg } from "./ArtworkImg"
import { Logo } from "./Logo"

const NAV = [
  { to: "/", icon: House, label: "Home" },
  { to: "/search", icon: Search, label: "Search" },
  { to: "/library", icon: Library, label: "Library" },
]

export function Sidebar() {
  const recents = useLibrary((s) => s.recents)
  const playlists = useLibrary((s) => s.playlists)
  const likedCount = useLibrary((s) => s.likedOrder.length)
  const playTrack = usePlayer((s) => s.playTrack)
  const currentId = usePlayer((s) => s.current?.id)

  return (
    <aside className="flex w-[4.5rem] shrink-0 flex-col border-r border-line bg-panel lg:w-64">
      {/* top of the sidebar doubles as drag region — the padding around
          the logo drags the window; only the link itself stays clickable.
          No wordmark: the mark alone reads cleaner in the chrome area */}
      <div className="drag-region px-4 pb-2 pt-5 lg:px-6">
        <Link to="/" className="no-drag flex w-fit items-center gap-3" aria-label="Freebify home">
          <Logo size={26} className="shrink-0 text-white" />
        </Link>
      </div>

      <nav className="mt-4 flex flex-col gap-1 px-3">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            aria-label={label}
            className={({ isActive }) =>
              `relative flex items-center justify-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors lg:justify-start ${
                isActive ? "text-ink" : "text-dim hover:bg-hover/60 hover:text-ink"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {/* sliding active pill — the highlight glides between nav
                    items instead of popping in and out */}
                {isActive && (
                  <motion.span
                    layoutId="nav-pill"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className="absolute inset-0 rounded-lg bg-hover"
                  />
                )}
                <Icon size={19} className="relative" />
                <span className="relative hidden lg:block">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="scroller mt-5 min-h-0 flex-1 overflow-y-auto border-t border-line px-3 pt-4">
        <p className="mb-2 hidden px-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-faint lg:block">
          Your library
        </p>
        <Link
          to="/library"
          className="flex items-center justify-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-hover lg:justify-start"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white">
            <Heart size={15} className="fill-black text-black" />
          </span>
          <span className="hidden min-w-0 lg:block">
            <span className="block truncate text-sm font-medium">Liked Songs</span>
            <span className="block text-xs text-dim">{likedCount} tracks</span>
          </span>
        </Link>

        {playlists.length > 0 && (
          <div className="mt-1.5 hidden lg:block">
            {playlists.slice(0, 6).map((p) => (
              <Link
                key={p.id}
                to={`/playlist/${p.id}`}
                className="flex items-center gap-3 rounded-lg px-3 py-1.5 transition-colors hover:bg-hover"
              >
                <ListMusic size={16} className="shrink-0 text-dim" />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="block text-xs text-dim">{p.tracks.length} tracks</span>
                </span>
              </Link>
            ))}
            {playlists.length > 6 && (
              <Link
                to="/library"
                className="mt-1 block rounded-lg px-3 py-1.5 text-xs font-semibold text-dim transition-colors hover:bg-hover hover:text-ink"
              >
                +{playlists.length - 6} more — see all
              </Link>
            )}
          </div>
        )}

        {recents.length > 0 && (
          <div className="mt-4 hidden lg:block">
            <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">
              Recently played
            </p>
            {recents.slice(0, 8).map((t) => (
              <button
                key={t.id}
                onClick={() => playTrack(t, recents)}
                title={`${t.title} — ${t.user.name}`}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-hover"
              >
                <ArtworkImg art={t.artwork} size="150x150" alt="" className="size-9 shrink-0 rounded-md" iconSize={14} />
                <span className="min-w-0">
                  {/* text-white vs text-ink was a no-op (both #fff) — the
                      currently-playing row needs a real differentiator */}
                  <span className={`block truncate text-sm ${currentId === t.id ? "text-white underline decoration-white/30 underline-offset-4" : "text-ink"}`}>
                    {t.title}
                  </span>
                  <span className="block truncate text-xs text-dim">{t.user.name}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <NavLink
        to="/settings"
        aria-label="Settings"
        className={({ isActive }) =>
          `mx-3 mb-3 flex items-center justify-center gap-3 rounded-lg border-t border-transparent px-3 py-2.5 text-sm font-semibold transition-colors lg:justify-start ${
            isActive ? "bg-hover text-ink" : "text-dim hover:bg-hover/60 hover:text-ink"
          }`
        }
      >
        <Settings size={18} />
        <span className="hidden lg:block">Settings</span>
      </NavLink>
    </aside>
  )
}
