import { Music2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { Artwork } from "../api/types"

type ImgSize = "150x150" | "480x480" | "1000x1000"

// persisted tracks (library/recents/playlists/queue) can carry ytimg URLs
// with signed params that have long since expired — the bare path always
// serves, so strip at render the same way cleanThumb does at fetch
const stripSigned = (u: string) => u.replace(/(ytimg\.com\/[^?]+)\?.*$/, "$1")

function candidates(art: Artwork, size: ImgSize): string[] {
  const primary = art[size] ?? art["480x480"] ?? art["150x150"] ?? art["1000x1000"]
  if (!primary) return []
  let path = ""
  try {
    path = new URL(primary).pathname
  } catch {
    return [primary]
  }
  // YouTube's maxresdefault only exists for HD uploads — when the chosen size
  // 404s, the next size down is the fallback that actually renders. Mirrors
  // only exist for Audius, so key-fallback is what saves yt artwork.
  const sizes: ImgSize[] = ["1000x1000", "480x480", "150x150"]
  const rest = sizes.filter((s) => s !== size).map((s) => art[s]).filter((u): u is string => Boolean(u) && u !== primary)
  return [stripSigned(primary), ...(art.mirrors ?? []).map((m) => `${m}${path}`), ...rest.map(stripSigned), ...(art.fallback ? [art.fallback] : [])]
}

interface ArtworkImgProps {
  art: Artwork | null | undefined
  size?: ImgSize
  alt?: string
  className?: string
  iconSize?: number
}

// Renders Audius artwork, retrying through the content-node mirrors on failure.
export function ArtworkImg({ art, size = "480x480", alt = "", className = "", iconSize = 20 }: ArtworkImgProps) {
  const urls = useMemo(() => (art ? candidates(art, size) : []), [art, size])
  const [idx, setIdx] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [retry, setRetry] = useState(0)
  // render-phase reset (React's recommended pattern): when `art` changes the
  // old idx is stale for THIS paint — resetting in an effect let the broken
  // index flash the placeholder icon for a frame
  const [prevArt, setPrevArt] = useState(art)
  if (prevArt !== art) {
    setPrevArt(art)
    if (idx !== 0) setIdx(0)
    if (loaded) setLoaded(false)
    if (retry !== 0) setRetry(0)
  }
  // every candidate failed — often transient rate-limiting (429), which
  // lifts in seconds. Back off and retry the list a few times before
  // settling on the placeholder, then stop hammering.
  useEffect(() => {
    if (idx < urls.length || urls.length === 0 || retry >= 3) return
    const h = setTimeout(() => {
      setIdx(0)
      setLoaded(false)
      setRetry((r) => r + 1)
    }, 4000 * (retry + 1))
    return () => clearTimeout(h)
  }, [idx, urls.length, retry])

  if (urls.length === 0 || idx >= urls.length) {
    return (
      <div className={`grid place-items-center bg-gradient-to-br from-hover to-panel text-faint ${className}`}>
        <Music2 size={iconSize} />
      </div>
    )
  }

  return (
    <img
      key={urls[idx]}
      ref={(el) => {
        // cached images can finish loading before React attaches onLoad —
        // without this they stay opacity-0 forever ("a veces no salen")
        if (el?.complete && el.naturalWidth > 0) setLoaded(true)
      }}
      src={urls[idx]}
      alt={alt}
      loading="lazy"
      draggable={false}
      onLoad={() => setLoaded(true)}
      onError={() => {
        setIdx((i) => i + 1)
        setLoaded(false)
      }}
      className={`object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"} ${className}`}
    />
  )
}
