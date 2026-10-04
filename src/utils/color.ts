// LRU-ish cap — a long session samples hundreds of artworks; the map
// would otherwise grow for the process lifetime
const cache = new Map<string, Promise<[number, number, number] | null>>()
const CACHE_CAP = 300

// Extracts the dominant color of an image via canvas sampling.
// Returns null when the image can't be sampled (CORS-tainted or load error).
export function dominantColor(url?: string | null): Promise<[number, number, number] | null> {
  if (!url) return Promise.resolve(null)
  if (!cache.has(url)) {
    const p = extract(url).then((c) => {
      // a CORS-tainted or transiently-broken image would otherwise stay
      // gray for the whole session — only remember successful samples
      if (c === null) cache.delete(url)
      return c
    })
    cache.set(url, p)
    if (cache.size > CACHE_CAP) {
      // Map iterates in insertion order — drop the oldest entries
      for (const k of cache.keys()) {
        cache.delete(k)
        if (cache.size <= CACHE_CAP * 0.8) break
      }
    }
  }
  return cache.get(url)!
}

function extract(url: string): Promise<[number, number, number] | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      try {
        const size = 24
        const canvas = document.createElement("canvas")
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)

        let r = 0, g = 0, b = 0, n = 0
        for (let i = 0; i < data.length; i += 4) {
          const pr = data[i], pg = data[i + 1], pb = data[i + 2]
          const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb
          // Skip near-black and near-white pixels so the color stays vivid
          if (lum < 28 || lum > 235) continue
          r += pr; g += pg; b += pb; n++
        }
        if (n === 0) return resolve(null)
        resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function rgb(c: [number, number, number] | null, fallback = "115 115 115"): string {
  return c ? `${c[0]} ${c[1]} ${c[2]}` : fallback
}
