import { motion } from "motion/react"
import { Heart, Play, Plus, Search } from "lucide-react"
import { useShallow } from "zustand/react/shallow"
import { Link, useNavigate } from "react-router-dom"
import { LocalPlaylistCard, Section, TrackCard } from "../components/Cards"
import { TrackTable } from "../components/TrackTable"
import { useLibrary } from "../store/library"
import { usePlayer } from "../store/player"

export function LibraryPage() {
  // shallow-compare — a fresh array every snapshot would re-render this
  // page on ANY library write (recents update on every track play)
  const likedTracks = useLibrary(
    useShallow((s) => s.likedOrder.map((id) => s.liked[id]).filter(Boolean))
  )
  const recents = useLibrary((s) => s.recents)
  const playlists = useLibrary((s) => s.playlists)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const playContext = usePlayer((s) => s.playContext)
  const navigate = useNavigate()

  return (
    <div className="-mt-12 pb-10">
      {/* hero */}
      <div
        className="relative flex items-end gap-6 px-6 pb-8 pt-20"
        style={{
          background:
            "linear-gradient(180deg, rgb(255 255 255 / 0.1), transparent), radial-gradient(60% 100% at 80% 0%, rgb(255 255 255 / 0.05), transparent)",
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="grid size-40 shrink-0 place-items-center rounded-2xl bg-white shadow-2xl shadow-black/50 sm:size-52"
        >
          <Heart size={72} className="fill-black text-black" />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.08 }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-ink/70">Playlist</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-6xl">Liked Songs</h1>
          <p className="mt-3 text-sm text-dim">{likedTracks.length} tracks</p>
        </motion.div>
      </div>

      {/* user playlists */}
      <div className="px-6 pb-2">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-tight">Your playlists</h2>
          <button
            onClick={() => navigate(`/playlist/${createPlaylist()}`)}
            className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-semibold text-dim transition hover:border-dim hover:text-ink"
          >
            <Plus size={15} /> New playlist
          </button>
        </div>
        {playlists.length > 0 ? (
          <div className="no-scrollbar -mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
            {playlists.map((p) => (
              <LocalPlaylistCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-dim">
            Create a playlist and add songs from the ··· menu on any track.
          </p>
        )}
      </div>

      <div className="px-6">
        {likedTracks.length > 0 ? (
          <>
            <button
              onClick={() => playContext(likedTracks, 0)}
              className="mb-6 flex items-center gap-2 rounded-full bg-white px-8 py-3 text-sm font-bold text-black shadow-lg shadow-black/50 transition hover:scale-[1.03]"
            >
              <Play size={16} className="fill-current" /> Play all
            </button>
            <TrackTable tracks={likedTracks} />
          </>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center rounded-2xl border border-dashed border-line py-20 text-center"
          >
            <Heart size={44} className="text-faint" />
            <p className="mt-4 text-lg font-semibold">Songs you like will live here</p>
            <p className="mt-1 text-sm text-dim">Tap the heart on any track to save it.</p>
            <Link
              to="/search"
              className="mt-6 flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black transition hover:scale-105"
            >
              <Search size={15} /> Find something to love
            </Link>
          </motion.div>
        )}
      </div>

      {recents.length > 0 && (
        <div className="mt-10">
          <Section title="Recently played">
            {recents.slice(0, 12).map((t) => (
              <TrackCard key={t.id} t={t} context={recents} />
            ))}
          </Section>
        </div>
      )}
    </div>
  )
}
