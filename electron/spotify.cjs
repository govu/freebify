// Spotify playlist import. Two readers, no account and no Premium:
//   1. Pathfinder: the embed page ships an anonymous web-player session
//      token; api-partner.spotify.com paginates the FULL track list with it
//      (100 per page). This is Spotify's own client API, not the developer
//      Web API, so the Premium wall that blocks api.spotify.com does not apply.
//   2. Embed scrape: the first 100 tracks Spotify publishes publicly. Always
//      tried first (it also carries the token) and used as the fallback.
// Nothing is stored: the token lives for one request chain and is dropped.
const fs = require("fs")
const path = require("path")

const PATHFINDER = "https://api-partner.spotify.com/pathfinder/v1/query"
// persisted query for `fetchPlaylist`; Spotify rotates it with web releases,
// so a failure is expected someday and simply falls back to the embed list
const FETCH_PLAYLIST_HASH = "8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a"
const PAGE = 100
const MAX_PAGES = 100 // 10k tracks, far beyond any real playlist

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

function log(tag, msg) {
  try {
    // electron is required lazily (and only inside the app) so the parsers
    // stay usable from plain node, and so tests never touch the binary
    let dir
    if (process.versions.electron) {
      dir = path.join(require("electron").app.getPath("userData"), "logs")
    } else {
      const base = process.env.APPDATA || process.env.LOCALAPPDATA || require("os").tmpdir()
      dir = path.join(base, "freebify", "logs")
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "freebify.log"), `${new Date().toISOString()} [${tag}] ${msg}\n`)
  } catch {}
}

// ---------- embed page ----------

function parseEmbed(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!m) return null
  let pageProps
  try {
    pageProps = JSON.parse(m[1])?.props?.pageProps
  } catch {
    return null
  }
  const entity = pageProps?.state?.data?.entity
  const list = entity?.trackList
  if (!entity?.name || !Array.isArray(list) || list.length === 0) return null
  return {
    name: entity.name,
    // totalCount exists when Spotify knows the list is longer than the embed
    total: Number.isFinite(entity.totalCount) ? entity.totalCount : list.length,
    token: pageProps?.state?.settings?.session?.accessToken ?? null,
    tracks: list
      .filter((t) => t?.title && t?.subtitle)
      .map((t) => ({ title: t.title, artist: t.subtitle })),
  }
}

async function fetchEmbed(id) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null
  return parseEmbed(await res.text())
}

// ---------- pathfinder (anonymous web-player session) ----------

function mapItem(item) {
  const t = item?.itemV2?.data ?? item?.itemV3?.data ?? item?.item?.data
  if (!t) return null
  if (t.__typename && t.__typename !== "Track") return null // episodes, local files
  const title = String(t.name ?? "").trim()
  const artists = (t.artists?.items ?? t.albumOfTrack?.artists?.items ?? [])
    .map((a) => a?.profile?.name)
    .filter(Boolean)
  if (!title || artists.length === 0) return null
  const ms = Number(t.trackDuration?.totalMilliseconds)
  return {
    title,
    artist: artists.join(", "),
    ...(Number.isFinite(ms) && ms > 0 ? { duration: Math.round(ms / 1000) } : {}),
  }
}

async function pathfinder(id, token) {
  const uri = `spotify:playlist:${id}`
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/html,application/json",
    Referer: "https://open.spotify.com/",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": UA,
  }
  // one page of 100. Returns null when Spotify refuses - the caller decides
  // whether the pages it already has are still worth importing.
  const page = async (offset) => {
    const body = JSON.stringify({
      variables: { uri, offset, limit: PAGE, enableWatchFeedEntrypoint: true },
      operationName: "fetchPlaylist",
      extensions: { persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST_HASH } },
    })
    const res = await fetch(PATHFINDER, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      log("spotify.import", `pathfinder ${res.status} at offset ${offset}`)
      return null
    }
    try {
      return (await res.json())?.data?.playlistV2 ?? null
    } catch {
      log("spotify.import", "pathfinder returned a non-JSON body")
      return null
    }
  }

  const mk = (raw) => {
    const content = raw?.content
    const items = Array.isArray(content?.items) ? content.items : []
    const tracks = []
    for (const it of items) {
      const t = mapItem(it)
      if (t) tracks.push(t)
    }
    return {
      name: String(raw?.name ?? ""),
      items: items.length,
      total: Number.isFinite(content?.totalCount) ? content.totalCount : 0,
      tracks,
    }
  }

  const first = await page(0)
  if (!first) return null
  const head = mk(first)
  const total = head.total || head.items
  const tracks = head.tracks
  let name = head.name

  // pages past the first are independent offsets, so a 1000 track list is
  // ten simultaneous requests instead of ten round trips one after another
  const PAGE_CONC = 5
  const offsets = []
  for (let o = PAGE; o < total && offsets.length < MAX_PAGES; o += PAGE) offsets.push(o)
  for (let i = 0; i < offsets.length; i += PAGE_CONC) {
    const batch = offsets.slice(i, i + PAGE_CONC)
    const pages = await Promise.all(batch.map((o) => page(o)))
    // a silent refusal mid-list keeps what we already have - a partial
    // playlist beats no playlist, and the UI marks it as limited
    let stopped = false
    for (const raw of pages) {
      if (!raw) {
        stopped = true
        break
      }
      const p = mk(raw)
      name ||= p.name
      tracks.push(...p.tracks)
    }
    if (stopped) break
  }

  if (tracks.length === 0) return null
  if (tracks.length < total - 1) log("spotify.import", `pathfinder short: ${tracks.length}/${total}`)
  return { name, tracks, total }
}

// ---------- renderer entry ----------

// → { ok:true, name, tracks, limited, source } ; limited = Spotify only
//   published its first 100 and the full read failed
// → { ok:false } when the playlist isn't public / doesn't exist
async function importPlaylist(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(id)) return { ok: false }
  try {
    const emb = await fetchEmbed(id)
    if (!emb) return { ok: false }
    if (emb.token) {
      const full = await pathfinder(id, emb.token)
      if (full && full.tracks.length >= emb.tracks.length) {
        log("spotify.import", `pathfinder ok: ${full.tracks.length} tracks`)
        return {
          ok: true,
          source: "pathfinder",
          name: full.name || emb.name,
          tracks: full.tracks,
          limited: Number.isFinite(full.total) && full.tracks.length < full.total,
        }
      }
      if (full) {
        log("spotify.import", `pathfinder returned ${full.tracks.length}, embed had ${emb.tracks.length}`)
      }
    }
    log("spotify.import", `embed ok: ${emb.tracks.length} tracks`)
    return {
      ok: true,
      source: "embed",
      name: emb.name,
      tracks: emb.tracks,
      limited: emb.total > emb.tracks.length || emb.tracks.length >= 100,
    }
  } catch (e) {
    log("spotify.import", `failed: ${e?.message ?? e}`)
    return { ok: false }
  }
}

function register(ipcMain) {
  ipcMain.handle("sp:import", (_e, id) => importPlaylist(id))
}

module.exports = { register, importPlaylist, parseEmbed, pathfinder }
