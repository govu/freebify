import { Music2 } from "lucide-react"
import { useMemo, useState } from "react"
import type { Artwork } from "../api/types"

type ImgSize = "150x150" | "480x480" | "1000x1000"

function candidates(art: Artwork, size: ImgSize): string[] {
  const primary = art[size] ?? art["480x480"] ?? art["150x150"] ?? art["1000x1000"]
  if (!primary) return []
  let path = ""
  try {
    path = new URL(primary).pathname
  } catch {
    return [primary]
  }
  return [primary, ...(art.mirrors ?? []).map((m) => `${m}${path}`)]
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
  // render-phase reset (React's recommended pattern): when `art` changes the
  // old idx is stale for THIS paint — resetting in an effect let the broken
  // index flash the placeholder icon for a frame
  const [prevArt, setPrevArt] = useState(art)
  if (prevArt !== art) {
    setPrevArt(art)
    if (idx !== 0) setIdx(0)
    if (loaded) setLoaded(false)
  }

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
