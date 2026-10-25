// Deezer public API (no key, no account) used as a discovery source when
// YouTube Music's own up-next panel is exhausted. The API sends no CORS
// header, so the renderer can't call it directly: everything runs here and
// reaches the UI as a plain list of titles.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
const MAX_RELATED = 6
const PER_ARTIST = 3

async function json(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// → [{ title, artist, duration }] mixing top tracks of artists related to
//   `artist`, round-robin so one act doesn't fill the whole batch
async function radioFor(artist, title, limit = 12) {
  const name = String(artist ?? "").trim()
  if (!name || name === "Unknown artist") return []
  const found = await json(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=1`)
  const id = found?.data?.[0]?.id
  if (!id) return []
  const related = await json(`https://api.deezer.com/artist/${id}/related?limit=${MAX_RELATED}`)
  const artists = (related?.data ?? []).slice(0, MAX_RELATED)
  if (!artists.length) return []
  const lists = await Promise.all(
    artists.map((a) =>
      json(`https://api.deezer.com/artist/${a.id}/top?limit=${PER_ARTIST}`).then((j) => ({
        name: String(a.name ?? "").trim(),
        tracks: j?.data ?? [],
      }))
    )
  )
  const seed = String(title ?? "").trim().toLowerCase()
  const seen = new Set()
  const out = []
  for (let round = 0; round < PER_ARTIST; round++) {
    for (const list of lists) {
      const t = list.tracks[round]
      if (!t) continue
      const songTitle = String(t.title ?? "").trim()
      const songArtist = String(t.artist?.name ?? list.name ?? "").trim()
      const key = `${songArtist} ${songTitle}`.toLowerCase()
      if (!songTitle || !songArtist || seen.has(key) || seed === songTitle.toLowerCase()) continue
      seen.add(key)
      out.push({
        title: songTitle,
        artist: songArtist,
        ...(Number.isFinite(t.duration) && t.duration > 0 ? { duration: Math.round(t.duration) } : {}),
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

function register(ipcMain) {
  ipcMain.handle("dz:radio", (_e, artist, title, limit) => radioFor(artist, title, limit))
}

module.exports = { register, radioFor }
