// Spotify playlist import — anonymous embed reader.
// Spotify's embed page publishes exactly the first 100 tracks of a public
// playlist and nothing more (its own cap): reading beyond that requires a
// Premium-gated Web API grant, which Freebify does not use. CSV import
// (Exportify etc.) is the route for longer lists — it doesn't touch Spotify.
const fs = require("fs")
const path = require("path")
const { app } = require("electron")

function log(tag, msg) {
  try {
    const dir = path.join(app.getPath("userData"), "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "freebify.log"), `${new Date().toISOString()} [${tag}] ${msg}\n`)
  } catch {}
}

// anonymous embed scrape — public playlists only, Spotify caps at 100
async function embedPlaylist(id) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null
  const html = await res.text()
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!m) return null
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity
  const list = entity?.trackList
  if (!entity?.name || !Array.isArray(list) || list.length === 0) return null
  return {
    name: entity.name,
    tracks: list
      .filter((t) => t?.title && t?.subtitle)
      .map((t) => ({ title: t.title, artist: t.subtitle })),
  }
}

// renderer-facing entry → { ok:true, name, tracks: [{title,artist}] }
// → { ok:false } when the playlist isn't public / doesn't exist
async function importPlaylist(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(id)) return { ok: false }
  const emb = await embedPlaylist(id)
  if (!emb) return { ok: false }
  return { ok: true, name: emb.name, tracks: emb.tracks }
}

function register(ipcMain) {
  ipcMain.handle("sp:import", (_e, id) =>
    importPlaylist(id).catch((e) => {
      log("spotify.import", `failed: ${e?.message ?? e}`)
      return { ok: false }
    })
  )
}

module.exports = { register, importPlaylist, embeddedPlaylist: embedPlaylist }
