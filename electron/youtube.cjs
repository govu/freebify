// YouTube Music service running in the Electron main process.
// - Metadata (search, artists, albums, trending) via youtubei.js (Innertube)
// - Stream URLs via bundled yt-dlp binary (signed googlevideo URLs)
const { execFile } = require("child_process")
const path = require("path")
const fs = require("fs")
const { app } = require("electron")

// mirror of main.cjs logLine — same file so a grep reads the whole story
function log(tag, msg) {
  try {
    const dir = path.join(app.getPath("userData"), "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "freebify.log"), `${new Date().toISOString()} [${tag}] ${msg}\n`)
  } catch {}
}

// ---------- yt-dlp ----------
let execBin = null // set by ensureExecutable when the bundled path can't run
function binPath() {
  if (execBin) return execBin
  // unix builds ship the bare binary as "yt-dlp" — no .exe outside win32
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  const rel = app?.isPackaged
    ? path.join(process.resourcesPath, "bin", name)
    : path.join(__dirname, "..", "bin", name)
  return rel
}

function ytdlpAvailable() {
  try {
    return fs.existsSync(binPath())
  } catch {
    return false
  }
}

// On macOS a downloaded .app carries com.apple.quarantine on EVERY bundled
// file — Gatekeeper intercepts spawn() of the unsigned yt-dlp binary and
// kills it (EACCES/dialog), which reads as "no song ever plays". Strip the
// attribute from the whole bundle once, re-assert the exec bit, and PROBE
// the binary: if it still can't run (App Translocation mounts a read-only
// path when launched straight from the dmg), copy it into the writable
// userData dir — files we write and de-quarantine ourselves are ours.
let dequarantineP = null
function ensureExecutable() {
  if (process.platform === "win32" || !app?.isPackaged) return Promise.resolve()
  if (!dequarantineP) {
    dequarantineP = (async () => {
      const probe = (p) =>
        new Promise((res) => execFile(p, ["--version"], { timeout: 8000 }, (e) => res(!e)))
      const bundled = binPath()
      try {
        fs.chmodSync(bundled, 0o755)
      } catch { /* read-only bundle — probe may still pass */ }
      if (process.platform === "darwin") {
        const bundle = path.join(process.resourcesPath, "..", "..")
        // hung xattr would pend dequarantineP forever → every yt-dlp call
        // queues behind it and times out at 25s per play
        await new Promise((r) =>
          execFile("/usr/bin/xattr", ["-dr", "com.apple.quarantine", bundle], { timeout: 10000 }, () => r()),
        )
      }
      if (await probe(bundled)) return
      // bundled binary untrusted/dead → writable copy under our control
      const alt = path.join(app.getPath("userData"), "bin", "yt-dlp")
      try {
        fs.mkdirSync(path.dirname(alt), { recursive: true })
        fs.copyFileSync(bundled, alt)
        fs.chmodSync(alt, 0o755)
        if (process.platform === "darwin") {
          await new Promise((r) =>
            execFile("/usr/bin/xattr", ["-d", "com.apple.quarantine", alt], { timeout: 10000 }, () => r()),
          )
        }
        if (await probe(alt)) execBin = alt
        else log("ytdlp", "bundled binary could not be executed (quarantine?)")
      } catch (e) {
        log("ytdlp", `exec fallback failed: ${e?.message ?? e}`)
      }
    })()
    // a failed de-quarantine must not poison the session — transient
    // Gatekeeper/lock errors retry on the next call instead of caching
    // a dead bundled path forever
    dequarantineP.catch(() => null).then(() => {
      if (!execBin && process.platform !== "win32") {
        // if the bundled probe failed AND no fallback was adopted, allow
        // one future retry (flag reset so a later call re-runs the chain)
        const p = dequarantineP
        setTimeout(() => {
          if (dequarantineP === p && !execBin) dequarantineP = null
        }, 60000)
      }
    })
  }
  return dequarantineP
}

function runYtdlp(args, timeout = 18000) {
  return new Promise((resolve, reject) => {
    ensureExecutable().then(
      () => {
        execFile(binPath(), args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        })
      },
      reject,
    )
  })
}

// stream url cache: videoId -> { url, expiresAt }. googlevideo URLs live
// ~6h, so we persist them to disk — a replay/resume after relaunch hits a
// still-valid URL and starts instantly instead of re-running yt-dlp.
const streamCache = new Map()
const inflight = new Map()
// keys whose job actually started running (holds a dlp slot) — an on-demand
// click may join a STARTED prefetch, but must never queue behind a waiting one
const inflightStarted = new Set()
// videoIds whose last served URL was invalidated as dead — if the fast
// probes handed us an IP-bound URL once, don't let them poison the retry
const probeBad = new Set()
let cacheDirty = false

const cacheFile = () => path.join(app.getPath("userData"), "stream-cache.json")

// lazy load — module scope runs before app.setName("Freebify"), and getPath
// resolves the pre-rename dir there. First use is always post-ready.
let cacheLoaded = false
function loadStreamCache() {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8"))
    const now = Date.now()
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (v?.url && v.expiresAt > now + 60_000) streamCache.set(k, v)
      }
    }
  } catch { /* first run / corrupt — start empty */ }
}

function persistStreamCache() {
  if (!cacheDirty) return
  try {
    const obj = Object.fromEntries(streamCache)
    const tmp = cacheFile() + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(obj))
    fs.renameSync(tmp, cacheFile())
    // only clear after the write lands — a failed rename with the flag
    // already reset would silently drop every entry since the last flush
    cacheDirty = false
  } catch { /* cache is best-effort */ }
}
setInterval(persistStreamCache, 60 * 1000).unref?.()
app?.once?.("before-quit", persistStreamCache)

// ---------- opportunistic third-party resolvers ----------
// Public Piped/Invidious instances are flaky but when one answers it
// returns a direct googlevideo URL in <1s — versus ~5s for yt-dlp. We race
// them alongside yt-dlp on real playback clicks only: first non-null audio
// URL wins. Zero cost when they're down (which is often).
const FAST_HOSTS = [
  { kind: "piped", base: "https://pipedapi.adminforge.de" },
  { kind: "piped", base: "https://api.piped.private.coffee" },
  { kind: "piped", base: "https://pipedapi.reallyaweso.me" },
  { kind: "inv", base: "https://inv.nadeko.net" },
  { kind: "inv", base: "https://invidious.nerdvpn.de" },
]

// accepts an optional parent signal — when the race resolves, losers are
// aborted instead of burning bandwidth on requests nobody reads
async function probeHost({ kind, base }, videoId, parentSignal) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 6000)
  const onParentAbort = () => ctl.abort()
  parentSignal?.addEventListener("abort", onParentAbort, { once: true })
  try {
    const res = await fetch(
      kind === "piped"
        ? `${base}/streams/${videoId}`
        : `${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`,
      { headers: { "User-Agent": "Freebify/1.0" }, signal: ctl.signal }
    )
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    if (!json) return null
    const streams =
      kind === "piped"
        ? (json.audioStreams ?? [])
            .filter((s) => /audio/.test(s.mimeType ?? ""))
            .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        : (json.adaptiveFormats ?? [])
            .filter((f) => /^audio\//.test(f.type ?? ""))
            .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    const url = streams[0]?.url
    if (typeof url !== "string") return null
    // substring-matching googlevideo.com would admit evil.tld/googlevideo.com
    // or googlevideo.com.evil.tld — the URL becomes <audio>.src AND lands in
    // the persisted cache, so it must be a real googlevideo host
    let host = null
    try {
      host = new URL(url).hostname
    } catch {
      return null
    }
    return host === "googlevideo.com" || host.endsWith(".googlevideo.com") ? url : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}

function firstNonNull(promises) {
  return new Promise((resolve) => {
    if (!promises.length) return resolve(null)
    let settled = 0
    for (const p of promises) {
      p.then((v) => {
        if (v != null) resolve(v)
        else if (++settled === promises.length) resolve(null)
      }).catch(() => {
        if (++settled === promises.length) resolve(null)
      })
    }
  })
}

// Cap concurrent yt-dlp.exe spawns with a two-tier semaphore: prefetches
// (hover/visibility warm-up) may hold at most 2 slots, while real playback
// clicks always have ≥3 free slots and jump ahead of queued prefetches.
// A mouse sweep over a track table can fire dozens of prefetches — without
// this they'd starve the resolve that actually matters.
let activeDlp = 0
let activePrefetch = 0
const MAX_DLP = 5
const MAX_PREFETCH = 2
const dlpQueue = []

function pumpDlp() {
  while (activeDlp < MAX_DLP) {
    const idx = dlpQueue.findIndex((q) => !q.prefetch || activePrefetch < MAX_PREFETCH)
    if (idx === -1) return
    const [q] = dlpQueue.splice(idx, 1)
    activeDlp++
    if (q.prefetch) activePrefetch++
    const done = () => {
      activeDlp--
      if (q.prefetch) activePrefetch--
      pumpDlp()
    }
    // armor against a synchronous throw inside job() — the slot is already
    // claimed at this point, so a sync throw would leak it permanently
    void Promise.resolve()
      .then(q.job)
      .then(done, done)
  }
}

const MAX_QUEUED_PREFETCH = 12

function withDlpSlot(job, prefetch) {
  return new Promise((resolve, reject) => {
    const entry = { prefetch, drop: () => resolve(null), job: () => job().then(resolve, reject) }
    if (prefetch) {
      // a mouse sweep across a table can queue dozens of prefetches for
      // tracks never played — keep only the freshest handful, oldest first
      while (dlpQueue.filter((q) => q.prefetch).length >= MAX_QUEUED_PREFETCH) {
        const i = dlpQueue.findIndex((q) => q.prefetch)
        if (i === -1) break
        dlpQueue.splice(i, 1)[0].drop()
      }
      dlpQueue.push(entry)
    } else {
      // on-demand click → ahead of every queued prefetch
      const i = dlpQueue.findIndex((q) => q.prefetch)
      if (i === -1) dlpQueue.push(entry)
      else dlpQueue.splice(i, 0, entry)
    }
    pumpDlp()
  })
}

// sweep expired + cap growth — the cache would otherwise grow for the
// process lifetime (radio autoplay can resolve hundreds of urls a day)
const STREAM_CACHE_CAP = 600
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of streamCache) if (v.expiresAt <= now) streamCache.delete(k)
  if (streamCache.size > STREAM_CACHE_CAP) {
    for (const k of streamCache.keys()) {
      streamCache.delete(k)
      if (streamCache.size <= STREAM_CACHE_CAP * 0.8) break
    }
  }
}, 10 * 60 * 1000).unref?.()

async function resolveStreamUrl(videoId, prefetch = false) {
  loadStreamCache()
  const hit = streamCache.get(videoId)
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.url
  const key = prefetch ? `${videoId}:lo` : videoId
  if (inflight.has(key)) return inflight.get(key)
  // a live on-demand resolve already covers this prefetch — and a prefetch
  // must never steal a slot an actual click needs, so it gets its own key
  if (prefetch && inflight.has(videoId)) return inflight.get(videoId)
  // a click landing mid-prefetch joins the already-running job instead of
  // spawning a second yt-dlp — but only once it's started; joining a queued
  // prefetch would wait behind MAX_PREFETCH
  const loKey = `${videoId}:lo`
  if (!prefetch && inflight.has(loKey) && inflightStarted.has(loKey)) return inflight.get(loKey)

  const job = (async () => {
    try {
      const dlpResolve = () =>
        withDlpSlot(
          () => {
            inflightStarted.add(key)
            return runYtdlp([
              "-f", "bestaudio[ext=m4a]/bestaudio",
              "-g",
              "--no-playlist",
              "--no-warnings",
              // skips a HEAD probe per track — a dead URL is caught by the
              // <audio> error path anyway, and the iframe still backs it up
              "--no-check-formats",
              "--socket-timeout", "10",
              "--retries", "2",
              `https://music.youtube.com/watch?v=${videoId}`,
            ])
          },
          prefetch
        ).then((out) => {
          const url = out.trim().split(/\r?\n/)[0].trim()
          return url.startsWith("http") ? url : null
        })

      // on-demand clicks race the fast hosts against yt-dlp — whichever
      // returns a usable URL first wins; prefetches stay cheap and quiet.
      // When the race resolves, abort the losing probes so 4 dead in-flight
      // requests don't burn bandwidth/hammer public instances per click.
      const url =
        prefetch || probeBad.has(videoId)
          ? await dlpResolve()
          : await (async () => {
              const raceCtl = new AbortController()
              try {
                return await firstNonNull([
                  ...FAST_HOSTS.map((h) => probeHost(h, videoId, raceCtl.signal)),
                  dlpResolve(),
                ])
              } finally {
                raceCtl.abort()
              }
            })()

      if (!url) return null
      let expiresAt = Date.now() + 5 * 3600 * 1000
      const m = /[?&]expire=(\d+)/.exec(url)
      if (m) expiresAt = Number(m[1]) * 1000
      streamCache.set(videoId, { url, expiresAt })
      cacheDirty = true
      return url
    } catch {
      return null
    } finally {
      inflight.delete(key)
      inflightStarted.delete(key)
    }
  })()

  inflight.set(key, job)
  return job
}

// ---------- Innertube (metadata) ----------
let ytPromise = null
let ParserRef = null // captured from the same module import — lets us parse
                     // arbitrary /browse pages (charts, moods, new releases)
                     // that the Music client has no method for
// consecutive request failures — a session created with generate_session_
// locally can go stale mid-run (visitor-data expiry, flagging). Without a
// reset every metadata call fails until the app restarts.
let ytFails = 0
function ytFail(e) {
  if (++ytFails >= 4) {
    ytPromise = null
    ytFails = 0
  }
  return e
}
function ytOk() {
  ytFails = 0
}
function getYt() {
  if (!ytPromise) {
    // Innertube.create has no internal timeout — a dead-but-silent network
    // would leave it pending forever and every getYt() would return that
    // same never-settling promise (metadata dead for the whole session).
    // The race frees ytPromise so the next call retries cleanly.
    ytPromise = Promise.race([
      import("youtubei.js").then(({ Innertube, Parser }) => {
        ParserRef = Parser
        return Innertube.create({
          generate_session_locally: true,
          // we never decipher streams here (yt-dlp does that) — skipping the
          // remote player fetch makes init faster and removes a failure mode
          retrieve_player: false,
        })
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("innertube init timeout")), 15000)
      ),
    ]).catch(() => {
      // don't cache the failure — a launch-while-offline should recover
      // on the next call instead of disabling YouTube for the session
      ytPromise = null
      return null
    })
  }
  return ytPromise
}

// Recursively collect nodes of given parser types (cycle-safe, depth-capped)
function collect(node, types, out = [], seen = new WeakSet(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 60 || seen.has(node)) return out
  seen.add(node)
  if (types.includes(node.type)) out.push(node)
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) for (const x of v) collect(x, types, out, seen, depth + 1)
      else collect(v, types, out, seen, depth + 1)
    }
  }
  return out
}

const thumbList = (item) =>
  item.thumbnails ??
  (Array.isArray(item.thumbnail) ? item.thumbnail : item.thumbnail?.contents) ??
  []
const cleanThumb = (url) =>
  // i.ytimg thumbs carry signed context params (?sqp=…&rs=…) — those
  // signatures can expire and take a persisted artwork URL with them.
  // The bare path always serves the image.
  url ? url.replace(/(ytimg\.com\/[^?]+)\?.*$/, "$1") : null
const thumbAt = (item) => {
  const thumbs = thumbList(item)
  // pick by declared width — ytimg lists ascend small→large but
  // googleusercontent artist thumbs descend (last = a 60px sliver)
  const best = [...thumbs].sort((a, b) => (b?.width ?? 0) - (a?.width ?? 0))[0]
  return cleanThumb(best?.url ?? thumbs[thumbs.length - 1]?.url ?? thumbs[0]?.url ?? null)
}
// smallest thumb ≥150px — lists render this key at ~40px and were
// downloading/decoding 1200px bitmaps per row
const smallThumb = (item) => {
  const thumbs = thumbList(item)
  const pick = thumbs.find((t) => (t?.width ?? 0) >= 150) ?? thumbs[0] ?? thumbs[thumbs.length - 1]
  return cleanThumb(pick?.url ?? null)
}

const bigThumb = (url) =>
  url ? url.replace(/=w\d+-h\d+[^,]*/, "=w544-h544-l90-rj") : null

// same transform for an arbitrary size — used where only a URL is in scope
const urlThumb = (url, size) =>
  url ? url.replace(/=w\d+-h\d+[^,]*/, `=w${size}-h${size}-l90-rj`) : null

const text = (v) => {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  if (typeof v.text === "string") return v.text
  if (typeof v.content === "string") return v.content
  if (Array.isArray(v.runs)) return v.runs.map((r) => text(r)).join("")
  // anything else would stringify to "[object Object]" — return empty
  return ""
}

function artistFromSubtitle(sub) {
  if (!sub) return ""
  const parts = sub
    .split("•")
    .map((s) => s.trim())
    .filter(
      (p) =>
        p &&
        !/^(song|single|album|video|episode|canci[oó]n|sencillo|[aá]lbum)$/i.test(p) &&
        !/views|plays|reproducciones/i.test(p) &&
        !/^\d{1,3}:\d{2}/.test(p) &&
        !/^\d{4}$/.test(p)
    )
  return parts[0] ?? ""
}

// item_type can be album/artist/playlist/podcast_show — those carry a
// browseId (MPREb…, UC…, VL…) in `id`, NOT a videoId. Real videoIds are
// ALWAYS exactly 11 chars; browse ids are longer — length is the reliable
// discriminator (a prefix regex would reject the ~0.2% of songs whose
// videoId legitimately starts RD/PL/UC…)

function mapSong(item) {
  const videoId = item.id ?? item.endpoint?.payload?.videoId
  if (typeof videoId !== "string" || videoId.length !== 11) return null
  const artists = item.artists ?? []
  const artist = artists[0] ?? item.authors?.[0]
  let artistName = text(artist?.name ?? artist) || artistFromSubtitle(text(item.subtitle))
  let channelId = artist?.channel_id ?? artist?.endpoint?.payload?.browseId ?? null
  let durationSec =
    item.duration?.seconds ?? parseDuration(text(item.duration?.text ?? item.duration)) ?? 0
  let playCount =
    parseCount(text(item.views)) ??
    parseCount(text(item.view_count)) ??
    parseCount(text(item.short_view_count))

  // explore/home items keep artist & duration in flex column runs
  if (!artistName || !durationSec || playCount == null) {
    const runs = (item.flex_columns ?? [])
      .slice(1)
      .flatMap((c) => c?.title?.runs ?? [])
    // artist runs carry channel browseIds (UC/MPLA/FE) — accepting ANY
    // browse run would bind the album's MPRE… or playlist's VL… id as the
    // artist and make the artist link a guaranteed dead end
    const artistRun = runs.find((r) => /^(UC|MPLA|FE)/.test(r.endpoint?.payload?.browseId ?? ""))
    artistName ||= text(artistRun?.text)
    channelId ??= artistRun?.endpoint?.payload?.browseId ?? null
    if (!durationSec) {
      durationSec = parseDuration(runs.find((r) => /^\d{1,3}:\d{2}/.test(r.text ?? ""))?.text ?? "") ?? 0
    }
    playCount ??=
      parseCount(
        runs.find((r) => /views|plays|reproducciones|reproducci|vistas/i.test(r.text ?? ""))?.text
      ) ??
      // some lists carry the count as a bare compact number ("1.1B")
      // with no word — never matches durations (3:14) or years (2020)
      parseCount(runs.find((r) => /^\d[\d.,]*\s*[KMB]$/i.test((r.text ?? "").trim()))?.text)
  }

  artistName ||= "Unknown artist"
  const title = (text(item.title) || "Untitled").replace(
    /\s*[\(\[](video oficial|official video|official audio|audio oficial|official music video|video lyric|lyric video|visualizer)[\)\]]/gi,
    ""
  )
  const thumb = thumbAt(item)
  return {
    id: `yt-${videoId}`,
    source: "yt",
    streamId: videoId,
    title,
    duration: durationSec,
    play_count: playCount ?? 0,
    repost_count: 0,
    favorite_count: 0,
    genre: null,
    permalink: `https://music.youtube.com/watch?v=${videoId}`,
    artwork: thumb
      ? { "150x150": smallThumb(item) ?? thumb, "480x480": bigThumb(thumb) ?? thumb, "1000x1000": bigThumb(thumb) ?? thumb }
      : null,
    user: {
      id: `yt-${channelId ?? artistName}`,
      streamId: channelId,
      name: artistName,
      handle: artistName,
      is_verified: false,
      follower_count: 0,
      track_count: 0,
      profile_picture: null,
      cover_photo: null,
    },
    album: item.album ? { id: item.album.id, name: text(item.album.name) } : null,
  }
}

function parseDuration(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(s || "")
  if (!m) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])
}

function parseCount(s) {
  if (!s) return null
  const m = /([\d.,]+)\s*([KMB])?/i.exec(s)
  if (!m) return null
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] ?? 1
  // "1,234,567" / "1.234.567" (no suffix) → all separators are thousands.
  // "1,2M" / "1.2M" → the separator is a decimal point.
  const num = m[2] ? m[1].replace(/,/g, ".") : m[1].replace(/[.,]/g, "")
  return Math.round(parseFloat(num) * mult)
}

// "Artist • 824M monthly audience" → 824000000
function audienceFrom(item) {
  const sub = text(item.subtitle) || text(item.subscribers)
  const seg =
    sub.split("•").find((p) => /audience|subscriber|oyente|seguidor/i.test(p)) ?? sub
  return parseCount(seg) ?? 0
}

// real verification badge — never hardcode it; search artist items and
// artist page headers carry MusicInlineBadge nodes with the checkmark
function hasVerifiedBadge(item) {
  for (const b of collect(item, ["MusicInlineBadge"])) {
    const s = `${b.icon_type ?? ""} ${b.style ?? ""} ${text(b.tooltip)} ${text(b.label)}`.toLowerCase()
    if (s.includes("verif") || s.includes("official artist")) return true
  }
  for (const b of item?.badges ?? []) {
    if (JSON.stringify(b).toLowerCase().includes("verif")) return true
  }
  return false
}

function mapArtist(item) {
  const channelId = item.id ?? item.endpoint?.payload?.browseId
  // a song/album row sneaking into artist results hands us a videoId or
  // MPRE… — clicking it routes a junk id/name into yt:artist → null page
  if (typeof channelId !== "string" || !/^(UC|MPLA|FE)/.test(channelId)) return null
  const name = text(item.title) || text(item.name) || "Artist"
  const thumb = thumbAt(item)
  return {
    id: `yt-${channelId}`,
    streamId: channelId,
    name,
    handle: name,
    is_verified: hasVerifiedBadge(item),
    follower_count: audienceFrom(item),
    track_count: 0,
    profile_picture: thumb
      ? { "150x150": smallThumb(item) ?? thumb, "480x480": bigThumb(thumb) ?? thumb, "1000x1000": bigThumb(thumb) ?? thumb }
      : null,
    cover_photo: null,
  }
}

// Raw musicTwoRowItemRenderer → same Playlist shape as mapAlbum. The
// artist discography browse (MPAD…) returns unparsed JSON — the Parser
// leaves it inside Memo nodes — so the raw renderer is mapped directly.
// kind comes from the subtitle ("Single • 2023" / "EP • 2021" vs "Album").
function mapRawAlbumRow(r, artistName) {
  const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId
  const name = (r?.title?.runs ?? []).map((x) => x.text).join("").trim()
  if (!browseId || !name) return null
  const sub = (r?.subtitle?.runs ?? []).map((x) => x.text).join(" ")
  const thumbs = r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? []
  const big = thumbs[thumbs.length - 1]?.url ?? null
  return {
    kind: /single|sencillo|\bep\b/i.test(sub) ? "single" : "album",
    pl: {
      id: `ytalb-${browseId}`,
      streamId: browseId,
      playlist_name: name,
      is_album: true,
      artwork: big ? { "150x150": thumbs[0]?.url ?? big, "480x480": big, "1000x1000": big } : null,
      track_count: 0,
      permalink: `https://music.youtube.com/browse/${browseId}`,
      user: {
        id: `yt-${artistName}`,
        streamId: null,
        name: artistName,
        handle: artistName,
        is_verified: false,
        follower_count: 0,
        track_count: 0,
        profile_picture: null,
        cover_photo: null,
      },
    },
  }
}

function mapAlbum(item) {
  const browseId = item.id ?? item.endpoint?.payload?.browseId
  if (!browseId) return null
  const name = text(item.title) || "Album"
  const thumb = thumbAt(item)
  // subtitle is "Album • Artist" — pull the artist part (and its channel
  // id when the run carries a browse endpoint) instead of the whole string
  const sub = text(item.subtitle)
  // v18 album rows set `item.author = {name, channel_id}` instead of
  // artists/subtitle runs — without it every album card is "Various Artists"
  const candidates = item.artists ?? item.subtitle?.runs ?? (item.author ? [item.author] : [])
  const artistRun = candidates.find?.((r) => r?.endpoint?.payload?.browseId ?? r?.channel_id) ?? candidates[0]
  const artistName =
    text(artistRun?.text ?? artistRun?.name ?? artistRun) || artistFromSubtitle(sub) || "Various Artists"
  const channelId = artistRun?.endpoint?.payload?.browseId ?? artistRun?.channel_id ?? null
  return {
    id: `ytalb-${browseId}`,
    streamId: browseId,
    playlist_name: name,
    is_album: true,
    artwork: thumb
      ? { "150x150": smallThumb(item) ?? thumb, "480x480": bigThumb(thumb) ?? thumb, "1000x1000": bigThumb(thumb) ?? thumb }
      : null,
    track_count: 0,
    permalink: `https://music.youtube.com/browse/${browseId}`,
    user: {
      id: `yt-${channelId ?? artistName}`,
      streamId: channelId,
      name: artistName,
      handle: artistName,
      is_verified: false,
      follower_count: 0,
      track_count: 0,
      profile_picture: null,
      cover_photo: null,
    },
  }
}

const songsOf = (res) =>
  collect(res, ["MusicResponsiveListItem"])
    .map(mapSong)
    .filter(Boolean)

// PlaylistPanelVideo items (from getUpNext / radio autoplay)
function mapPanelVideo(item) {
  const videoId = item.video_id ?? item.id ?? item.endpoint?.payload?.videoId
  // videoIds are exactly 11 chars — anything else (a browseId leaking
  // through) resolves to a guaranteed stream failure downstream
  if (typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)) return null
  // PlaylistPanelVideo stores the byline as the plain-string `author` —
  // the short/long_byline fields don't exist on this class
  const runs = item.artists ?? []
  const artistRun = runs.find((r) => r.endpoint?.payload?.browseId) ?? runs[0]
  const artistName = text(artistRun?.text ?? artistRun?.name) || text(item.author) || "Unknown artist"
  const channelId = artistRun?.endpoint?.payload?.browseId ?? artistRun?.channel_id ?? null
  const durationSec =
    item.duration?.seconds ??
    parseDuration(text(item.duration)) ??
    parseDuration(text(item.length_text?.text ?? item.length_text)) ??
    0
  // panel thumbs are 4:3 i.ytimg URLs — derive stable sizes from the videoId
  const vi = `https://i.ytimg.com/vi/${videoId}`
  const title = (text(item.title?.text ?? item.title) || "Untitled").replace(
    /\s*[\(\[](video oficial|official video|official audio|audio oficial|official music video|video lyric|lyric video|visualizer)[\)\]]/gi,
    ""
  )
  return {
    id: `yt-${videoId}`,
    source: "yt",
    streamId: videoId,
    title,
    duration: durationSec,
    play_count: 0,
    repost_count: 0,
    favorite_count: 0,
    genre: null,
    permalink: `https://music.youtube.com/watch?v=${videoId}`,
    artwork: {
      "150x150": `${vi}/mqdefault.jpg`,
      "480x480": `${vi}/hqdefault.jpg`,
      "1000x1000": `${vi}/hqdefault.jpg`,
    },
    user: {
      id: `yt-${channelId ?? artistName}`,
      streamId: channelId,
      name: artistName,
      handle: artistName,
      is_verified: false,
      follower_count: 0,
      track_count: 0,
      profile_picture: null,
      cover_photo: null,
    },
    // the panel class carries {id, name, year} — free album data
    album: item.album ? { id: item.album.id, name: text(item.album.name) } : null,
  }
}

// Editorial playlists / albums surfaced on the YT Music home feed
function mapYPlaylist(item) {
  const browseId =
    item.id ??
    item.endpoint?.payload?.browseId ??
    item.navigation_endpoint?.browse_endpoint?.browse_id
  // OLAK release ids DO resolve — but as VL playlists (getPlaylist
  // auto-prepends VL → VLOLAK…), not via getAlbum (which wants MPR*).
  // Route them through the playlist path, keep the "Album" label.
  if (!browseId || !/^(VL|PL|RD|OLAK|MPRE)/.test(browseId)) return null
  const isAlbum = browseId.startsWith("MPRE") || browseId.startsWith("OLAK")
  const route = browseId.startsWith("MPRE") ? "ytalb" : "ytpl"
  const name = text(item.title) || "Playlist"
  const thumb = thumbAt(item)
  const owner = text(item.subtitle) || "YouTube Music"
  return {
    id: `${route}-${browseId}`,
    streamId: browseId,
    playlist_name: name,
    is_album: isAlbum,
    description: null,
    artwork: thumb
      ? { "150x150": smallThumb(item) ?? thumb, "480x480": bigThumb(thumb) ?? thumb, "1000x1000": bigThumb(thumb) ?? thumb }
      : null,
    track_count: 0,
    total_play_count: 0,
    permalink: isAlbum
      ? `https://music.youtube.com/browse/${browseId}`
      : `https://music.youtube.com/playlist?list=${browseId}`,
    user: {
      id: "yt-va",
      // "YouTube Music" is the literal curator credit — but the user doesn't
      // want the brand stamped under every card; "Editorial" reads cleaner
      name: (owner.replace(/^playlist\s*•?\s*/i, "").split("•")[0].trim() || "Editorial").replace(
        /^YouTube Music$/i,
        "Editorial"
      ),
      handle: "Editorial",
      is_verified: false,
      follower_count: 0,
      track_count: 0,
      profile_picture: null,
      cover_photo: null,
    },
  }
}

// ---------- IPC surface ----------
async function search(query) {
  const yt = await getYt()
  if (!yt) return { tracks: [], artists: [], playlists: [] }
  const [songs, artists, albums] = await Promise.allSettled([
    yt.music.search(query, { type: "song" }),
    yt.music.search(query, { type: "artist" }),
    yt.music.search(query, { type: "album" }),
  ])
  // all three rejecting almost always means a dead session, not a bad query
  if (songs.status === "rejected" && artists.status === "rejected" && albums.status === "rejected")
    ytFail(songs.reason)
  else ytOk()
  // `?.` on value — a fulfilled-but-null search would TypeError and reject
  // the whole Promise.allSettled result, nuking sections that succeeded
  const content = (r) =>
    r.status === "fulfilled" ? (r.value?.contents ?? r.value?.results ?? r.value) : null
  return {
    tracks: songsOf(content(songs)).slice(0, 20),
    artists: collect(content(artists), ["MusicTwoRowItem", "MusicResponsiveListItem"])
      .map(mapArtist)
      .filter(Boolean)
      .slice(0, 8),
    playlists: collect(content(albums), ["MusicTwoRowItem", "MusicResponsiveListItem"])
      .map(mapAlbum)
      .filter(Boolean)
      .slice(0, 8),
  }
}

// general YouTube search (videos, not the music catalog) — caption source
// for lyrics alignment: fan lyric videos almost always carry ASR/manual
// subs while official audio uploads often ship none at all
async function videoSearch(query) {
  const yt = await getYt()
  if (!yt) return []
  const res = await yt.search(query).catch((e) => (log("vsearch", `${query}: ${e?.message}`), null))
  if (!res) return []
  return (res.results ?? [])
    .filter((it) => it.type === "Video" && it.id)
    .map((it) => ({
      streamId: it.id,
      title: text(it.title) || "",
      duration: it.duration?.seconds ?? parseDuration(text(it.duration?.text ?? "")) ?? 0,
      user: { id: it.author?.id ?? "", name: it.author?.name ?? "" },
    }))
    .slice(0, 10)
}

// last-resort imagery: any artist with songs has cover art — an artist page
// should never render as a blank header just because YouTube ships no photos
const trackArtwork = (tracks) =>
  tracks.find((t) => t?.artwork?.["480x480"] || t?.artwork?.["150x150"])?.artwork ?? null
const artToPicture = (art) =>
  art
    ? {
        "150x150": art["150x150"] ?? art["480x480"],
        "480x480": art["480x480"] ?? art["150x150"],
        "1000x1000": art["1000x1000"] ?? art["480x480"] ?? art["150x150"],
      }
    : null
const artToCover = (art) =>
  art ? { "640x": art["480x480"] ?? art["150x150"], "2000x": art["1000x1000"] ?? art["480x480"] ?? art["150x150"] } : null

const headerArtList = (header) => {
  // immersive headers carry a bare thumbnails array; older layouts wrap it
  // in MusicThumbnail nodes — cover both, dedup, biggest first
  const direct = thumbList(header)
  const nodes = collect(header, ["MusicThumbnail"]).flatMap((n) =>
    Array.isArray(n.contents) ? n.contents : [n]
  )
  const seen = new Set()
  return [...direct, ...nodes]
    .filter((t) => t?.url)
    .map((t) => ({ url: cleanThumb(t.url), width: t.width ?? 0 }))
    .filter((t) => t.url && !seen.has(t.url) && seen.add(t.url))
    .sort((a, b) => b.width - a.width)
}

const headerArt = (header, minWidth = 0) => {
  const all = headerArtList(header)
  // smallest thumb that still clears the bar — sorted desc so the last
  // qualifying entry is the tightest fit; fall back to the biggest
  const pick = [...all].reverse().find((t) => t.width >= minWidth) ?? all[0]
  return pick?.url ?? null
}

async function artist(channelIdOrName, nameHint) {
  const yt = await getYt()
  if (!yt) return null
  let id = channelIdOrName
  // MPLA wraps the WHOLE channel id (MPLA + UCxxx = MPLAUCxxx) — strip the
  // prefix, don't re-add UC (UC${id.slice(4)} produced the invalid UCUCxxx)
  if (id?.startsWith("MPLA")) id = id.slice(4)
  const searchArtists = async (query) => {
    const res = await yt.music.search(query, { type: "artist" }).catch((e) => (log("artist", `searchArtists ${query}: ${e?.message}`), null))
    const items = collect(res?.contents ?? res?.results ?? res ?? [], ["MusicTwoRowItem", "MusicResponsiveListItem"])
    log("artist", `searchArtists '${query}' → res ${res ? res.constructor?.name : "null"}, items ${items.length}`)
    return items.map(mapArtist).find(Boolean)
  }
  let searchHit = null
  if (!id || !/^UC[\w-]{8,}/.test(id)) {
    // resolve by name — the caller's display name beats the raw id token
    const a = await searchArtists(nameHint ?? channelIdOrName)
    if (!a) return null
    searchHit = a
    id = a.streamId
  }
  // nameHint rescue runs in PARALLEL with the channel fetch — a dead UC id
  // would otherwise burn most of the IPC timeout before the rescue started
  const hitP = !searchHit && nameHint ? searchArtists(nameHint).catch(() => null) : Promise.resolve(null)
  const degrade = async (hit) => {
    if (!hit) return null
    const res = await yt.music.search(hit.name, { type: "song" }).catch(() => null)
    const tracks = collect(res?.contents ?? res?.results ?? res ?? [], [
      "MusicResponsiveListItem",
      "MusicTwoRowItem",
    ])
      .map(mapSong)
      .filter((t) => t?.streamId)
      .slice(0, 30)
    // mapArtist can come back as bare "Artist" when the row's title lives in
    // flex_columns — the caller's display name is the better label
    const art = trackArtwork(tracks)
    return {
      user: {
        ...hit,
        name: nameHint || hit.name,
        id: `yt-${hit.streamId}`,
        track_count: tracks.length,
        profile_picture: hit.profile_picture ?? artToPicture(art),
        cover_photo: hit.cover_photo ?? artToCover(art),
      },
      tracks,
    }
  }
  const [page0, hit0] = await Promise.all([yt.music.getArtist(id).catch((e) => (ytFail(e), null)), hitP])
  let page = page0
  if (!searchHit) searchHit = hit0
  log("artist", `'${channelIdOrName}' hint=${nameHint ?? "-"} → page ${page ? "y" : "n"}, hit ${searchHit?.name ?? "null"}`)
  if (page) {
    // getArtist resolves "valid but empty" pages for garbage channel ids —
    // no header name AND no shelves means the channel is a phantom; treat it
    // as dead so the nameHint rescue below can find the real artist
    const hdr = page.header?.contents ?? page.header ?? {}
    if (!text(hdr.title ?? hdr.name) && !collect(page, ["MusicShelf"]).length) page = null
  }
  if (!page) {
    // channel-shaped but dead (private/deleted/bogus browseId) — the artist
    // still exists; recover by name before giving up on them entirely
    if (!searchHit) return null
    // re-resolve: the search hit's real channel may load a full page
    if (searchHit.streamId && searchHit.streamId !== id) {
      const retry = await yt.music.getArtist(searchHit.streamId).catch(() => null)
      if (retry) {
        page = retry
        id = searchHit.streamId
      }
    }
    if (!page) {
      const d = await degrade(searchHit)
      log("artist", `degrade '${searchHit.name}' → ${d ? `${d.tracks.length} tracks` : "null"}`)
      return d
    }
  }

  try {
  const header = page.header?.contents ?? page.header ?? {}
  const name = text(header.title ?? header.name) || searchHit?.name || nameHint || channelIdOrName
  const bannerList = headerArtList(header).map((t) => t.url)
  const banner = bannerList[0] ?? null
  const avatar = headerArt(header, 240)

  // The "Top songs" shelf links to a playlist with the full list; in parallel
  // resolve the monthly audience AND the square avatar from artist search —
  // the immersive header only carries wide banner crops, and a circle avatar
  // center-cropped from a banner usually beheads the face
  let tracks = []
  const metaP = (async () => {
    const meta = await yt.music.search(name, { type: "artist" }).catch(() => null)
    const items = collect(meta?.contents ?? meta?.results ?? meta, [
      "MusicTwoRowItem",
      "MusicResponsiveListItem",
    ])
      .map(mapArtist)
      .filter(Boolean)
    // no `?? items[0]` — a shared/stylized name would attribute a
    // DIFFERENT artist's audience to this page; wrong data beats no data
    return items.find((a) => a.streamId === id) ?? null
  })()

  const shelves = collect(page, ["MusicShelf"])
  const songsShelf = shelves.find((s) => /songs|canciones/i.test(text(s.title))) ?? shelves[0]
  // v18 MusicShelf stores bottomEndpoint as `.endpoint` (bottom_endpoint
  // doesn't exist) and watchPlaylistEndpoints carry playlistId not browseId
  const songsPl =
    songsShelf?.endpoint?.payload?.browseId ??
    songsShelf?.endpoint?.payload?.playlistId ??
    songsShelf?.bottom_endpoint?.payload?.browseId
  // getAllSongs resolves the complete ranked list (~100 vs the shelf's 30);
  // the playlist endpoint and the page's inline rows stay as fallbacks
  try {
    const all = await page.getAllSongs?.()
    if (all) tracks = songsOf(all)
  } catch { /* fall through to the shelf endpoint */ }
  if (!tracks.length && songsPl) {
    const pl = await yt.music.getPlaylist(songsPl).catch(() => null)
    if (pl) tracks = songsOf(pl)
  }
  if (!tracks.length) tracks = songsOf(page)
  tracks = tracks.slice(0, 150)

  // Full discography: the Albums/Singles carousels ship only ~10 rows, but
  // their more_content button carries an MPAD browseId. Calling the RAW
  // browseId returns the complete release grid — the endpoint's own params
  // answer "No results". One browse covers both sections; subtitle text
  // splits singles from albums. Carousel rows merge after as a safety net.
  const discog = { albums: [], singles: [] }
  const relShelves = collect(page, ["MusicCarouselShelf"]).filter((s) =>
    /album|álbum|single|sencillo|\bep\b/i.test(text(s.header?.title)),
  )
  let rawRows = []
  const seenBid = new Set()
  for (const shelf of relShelves) {
    const bid = shelf.header?.more_content?.endpoint?.payload?.browseId
    if (!bid || seenBid.has(bid)) continue
    seenBid.add(bid)
    try {
      const res = await yt.actions.execute("/browse", { browseId: bid, client: "YTMUSIC" })
      const rows = []
      const walk = (n) => {
        if (!n || typeof n !== "object") return
        if (Array.isArray(n)) { n.forEach(walk); return }
        if (n.musicTwoRowItemRenderer) rows.push(n.musicTwoRowItemRenderer)
        for (const v of Object.values(n)) if (v && typeof v === "object") walk(v)
      }
      walk(res?.data ?? res)
      if (rows.length > rawRows.length) rawRows = rows
    } catch { /* keep the carousel rows */ }
  }
  const seenRel = new Set()
  const pushRel = (bucket, pl) => {
    if (!pl?.streamId || seenRel.has(pl.streamId)) return
    seenRel.add(pl.streamId)
    discog[bucket].push(pl)
  }
  for (const r of rawRows) {
    const m = mapRawAlbumRow(r, name)
    if (m) pushRel(m.kind === "single" ? "singles" : "albums", m.pl)
  }
  for (const shelf of relShelves) {
    const bucket = /album|álbum/i.test(text(shelf.header?.title)) ? "albums" : "singles"
    collect(shelf, ["MusicTwoRowItem"])
      .map(mapAlbum)
      .filter(Boolean)
      // discography subtitles are "Album • year" — mapAlbum degrades to
      // "Various Artists" there; these are THIS artist's own releases
      .forEach((pl) => pushRel(bucket, { ...pl, user: { ...pl.user, name } }))
  }

  const self = await metaP
  // square-crop any googleusercontent url — artist avatars are circles, and
  // a 544 square pulled from a banner center beats a landscape sliver
  const sq = (u, s) => (u ? u.replace(/=w\d+-h\d+[^,]*/, `=w${s}-h${s}-l90-rj`) : null)
  const pic = self?.profile_picture ?? (avatar ?? banner
    ? { "150x150": sq(avatar ?? banner, 240), "480x480": sq(avatar ?? banner, 544), "1000x1000": sq(avatar ?? banner, 1024) }
    : null) ?? artToPicture(trackArtwork(tracks))
  return {
    user: {
      id: `yt-${id}`,
      streamId: id,
      name,
      handle: name,
      is_verified: hasVerifiedBadge(page?.header ?? page),
      follower_count: self?.follower_count ?? 0,
      track_count: tracks.length,
      profile_picture: pic,
      cover_photo: banner
        ? // distinct fallbacks — one googleusercontent token can 404/429 while
          // another size of the same banner still works
          { "2000x": banner, "640x": bannerList.find((u) => u !== banner) ?? banner }
        : (pic ? { "640x": pic["480x480"], "2000x": pic["1000x1000"] } : null) ?? artToCover(trackArtwork(tracks)),
    },
    tracks,
    albums: discog.albums,
    singles: discog.singles,
  }
  } catch (e) {
    // a malformed shelf/header shouldn't nuke a whole artist page — degrade
    // to the search hit instead of "Artist not found"
    log("artist", `post-process failed for '${channelIdOrName}': ${e?.message ?? e}`)
    if (searchHit) return degrade(searchHit)
    return null
  }
}

async function album(browseId) {
  const yt = await getYt()
  if (!yt) return null
  const page = await yt.music.getAlbum(browseId).catch((e) => (ytFail(e), null))
  if (!page) return null
  const tracks = songsOf(page)
  const header = page.header?.contents ?? page.header ?? {}
  const name = text(header.title ?? header.name) || "Album"
  const thumb = headerArt(header)
  return {
    playlist: {
      id: `ytalb-${browseId}`,
      streamId: browseId,
      playlist_name: name,
      is_album: true,
      description: null,
      artwork: thumb
        ? { "150x150": urlThumb(thumb, 150) ?? thumb, "480x480": bigThumb(thumb) ?? thumb, "1000x1000": bigThumb(thumb) ?? thumb }
        : null,
      track_count: tracks.length,
      user: {
        id: "yt-va",
        name: text(header.subtitle ?? header.artists) || "Various Artists",
        handle: "Various",
        is_verified: false,
        follower_count: 0,
        track_count: 0,
        profile_picture: null,
        cover_photo: null,
      },
    },
    tracks,
  }
}

async function trending() {
  const yt = await getYt()
  if (!yt) return []
  // explore -> trending songs; fall back to home feed
  for (const method of ["getExplore", "getHomeFeed"]) {
    try {
      const page = await yt.music[method]()
      ytOk()
      const tracks = songsOf(page)
      if (tracks.length) return tracks.slice(0, 16)
    } catch (e) {
      ytFail(e)
      /* try next */
    }
  }
  return []
}

// Autoplay radio — the "up next" recommendations YouTube Music generates
// for a video. Powers continuous playback when the queue runs out.
async function upNext(videoId) {
  const yt = await getYt()
  if (!yt) return []
  try {
    const panel = await yt.music.getUpNext(videoId)
    ytOk()
    return collect(panel, ["PlaylistPanelVideo", "MusicResponsiveListItem"])
      .map((it) => (it.type === "PlaylistPanelVideo" ? mapPanelVideo(it) : mapSong(it)))
      .filter(Boolean)
      .slice(0, 40)
  } catch (e) {
    ytFail(e)
    return []
  }
}

// Editorial playlists & albums from the YouTube Music home feed
async function homePlaylists() {
  const yt = await getYt()
  if (!yt) return []
  const out = []
  for (const method of ["getHomeFeed", "getExplore"]) {
    try {
      const page = await yt.music[method]()
      for (const it of collect(page, ["MusicTwoRowItem", "MusicCarouselItem", "MusicResponsiveListItem"])) {
        const p = mapYPlaylist(it)
        if (p && !out.some((x) => x.id === p.id)) out.push(p)
        if (out.length >= 14) return out
      }
    } catch (e) {
      // session-level failures count toward rotation like the rest —
      // a catalog dying only on these paths used to never reset
      ytFail(e)
    }
  }
  return out
}

// Full editorial playlist by browse id (accepts VL-prefixed ids too)
async function playlist(browseId) {
  const yt = await getYt()
  if (!yt) return null
  // getPlaylist auto-prepends VL, so for "VLabc" candidates 1&2 were
  // identical and for "PLabc" all three resolved to VLPLabc — a dead
  // playlist cost 3 sequential RTTs. Dedupe to ≤2 real candidates.
  const stripped = browseId.replace(/^VL/, "")
  const candidates = [...new Set([stripped, browseId])]
  let page = null
  for (const pid of candidates) {
    page = await yt.music.getPlaylist(pid).catch((e) => (ytFail(e), null))
    if (page) break
  }
  if (!page) return null
  const tracks = songsOf(page).slice(0, 100)
  const header = page.header?.contents ?? page.header ?? {}
  const name = text(header.title ?? header.name) || "Playlist"
  // the playlist's own header art first — not the first track's cover
  const thumb = headerArt(header) ?? thumbAt(item0(page))
  return {
    playlist: {
      id: `ytpl-${browseId}`,
      streamId: browseId,
      playlist_name: name,
      is_album: false,
      description: text(header.description) || null,
      artwork: thumb
        ? { "150x150": urlThumb(thumb, 150) ?? thumb, "480x480": bigThumb(thumb) ?? thumb, "1000x1000": bigThumb(thumb) ?? thumb }
        : null,
      track_count: tracks.length,
      total_play_count: 0,
      permalink: `https://music.youtube.com/playlist?list=${browseId.replace(/^VL/, "")}`,
      user: {
        id: "yt-va",
        name: "YouTube Music",
        handle: "YouTube Music",
        is_verified: false,
        follower_count: 0,
        track_count: 0,
        profile_picture: null,
        cover_photo: null,
      },
    },
    tracks,
  }
}

const item0 = (res) => collect(res, ["MusicResponsiveListItem"])[0]

// ---------- generic /browse pages (charts, moods, new releases) ----------
// The Music client has no methods for these, but they're regular browse
// endpoints — fetch raw and run the response through the library's parser
// so the same node shapes (MusicShelf/TwoRowItem/ResponsiveListItem) appear.
async function browsePage(browseId, params) {
  const yt = await getYt()
  if (!yt || !ParserRef) return null
  try {
    const raw = await yt.actions.execute("/browse", {
      browseId,
      ...(params ? { params } : {}),
      client: "YTMUSIC",
    })
    return ParserRef.parseResponse(raw.data)
  } catch (e) {
    ytFail(e)
    return null
  }
}

// Unwrap page.contents (a SuperParsedResult) into the top-level node
const pageRoot = (page) => {
  const c = page?.contents
  if (!c) return null
  if (c.is_node) return c.item()
  if (c.is_array) return c.array()?.[0] ?? null
  return null
}

// Country-localized charts: the FEmusic_charts page embeds VLPL…/RDAMPL…
// chart playlists for the user's region plus a Top-artists shelf.
async function charts() {
  const yt = await getYt()
  const page = await browsePage("FEmusic_charts")
  if (!yt || !page) return null
  const root = pageRoot(page)

  // chart playlists — ordered, first VLPL is the songs chart for the region
  const plIds = []
  for (const ep of collect(root, ["NavigationEndpoint"])) {
    const bid = ep.payload?.browseId
    if (typeof bid === "string" && bid.startsWith("VLPL") && !plIds.includes(bid)) plIds.push(bid)
  }
  let tracks = []
  for (const bid of plIds) {
    const pl = await yt.music.getPlaylist(bid).catch((e) => (ytFail(e), null))
    const t = pl ? songsOf(pl) : []
    if (t.length >= 10) {
      tracks = t.slice(0, 50)
      break
    }
  }
  // fall back to whatever song rows the page itself carries
  if (!tracks.length) tracks = songsOf(root).slice(0, 50)

  // Top-artists shelf rows: items whose endpoints lead to UC… channels
  const artists = []
  for (const it of collect(root, ["MusicResponsiveListItem", "MusicTwoRowItem"])) {
    const ep = collect(it, ["NavigationEndpoint"]).find((e) =>
      /^UC[\w-]{8,}/.test(e.payload?.browseId ?? "")
    )
    if (!ep) continue
    // chart shelf items are MusicResponsiveListItem — their getters return
    // undefined; the real name/subscriber text lives in flex_columns
    const a = mapArtist({
      id: ep.payload.browseId,
      title: it.title ?? it.name ?? it.flex_columns?.[0]?.title,
      subtitle: it.subtitle ?? it.subscribers ?? it.flex_columns?.[1]?.title,
      thumbnails: it.thumbnails ?? it.thumbnail,
      badges: it.badges,
    })
    if (a && !artists.some((x) => x.streamId === a.streamId)) artists.push(a)
    if (artists.length >= 20) break
  }
  return { tracks, artists }
}

// New albums & singles — the explore landing links to FEmusic_new_releases
async function newReleases() {
  const page = await browsePage("FEmusic_new_releases")
  if (!page) return []
  return collect(pageRoot(page), ["MusicTwoRowItem", "MusicResponsiveListItem"])
    .map(mapYPlaylist)
    .filter(Boolean)
    .slice(0, 16)
}

// Mood/genre category directory — each MusicNavigationButton carries the
// opaque `params` token that unlocks its category page
async function moods() {
  const page = await browsePage("FEmusic_moods_and_genres")
  if (!page) return []
  const out = []
  for (const b of collect(pageRoot(page), ["MusicNavigationButton"])) {
    const name = text(b.button_text ?? b.text ?? b.title)
    const params = b.endpoint?.payload?.params
    if (name && params && !out.some((m) => m.name === name)) out.push({ name, params })
  }
  return out
}

// A single mood category page — playlists + featured songs
async function mood(params) {
  const page = await browsePage("FEmusic_moods_and_genres_category", params)
  if (!page) return null
  const root = pageRoot(page)
  const playlists = collect(root, ["MusicTwoRowItem", "MusicResponsiveListItem"])
    .map(mapYPlaylist)
    .filter(Boolean)
    .slice(0, 24)
  const tracks = songsOf(root).slice(0, 30)
  const name = text(root?.title ?? root?.header?.title) || null
  return { name, playlists, tracks }
}

// Collage art for playlist cards — the editorial covers have the YouTube
// Music logo baked in (ugly). The first 4 track artworks make a proper
// Spotify-style collage instead. Cached — every card on Home asks for one.
const plArtCache = new Map()
// a full getPlaylist/getAlbum fetch per card just for 4 thumbs is heavy —
// cap at 2 concurrent so a Home mount can't fire 30 Innertube parses at once
let plArtActive = 0
const plArtQueue = []
function pumpPlArt() {
  while (plArtActive < 2 && plArtQueue.length) {
    const job = plArtQueue.shift()
    plArtActive++
    void Promise.resolve()
      .then(job)
      .finally(() => {
        plArtActive--
        pumpPlArt()
      })
  }
}
async function playlistArts(browseId) {
  // cache stores the in-flight PROMISE too — cards mounting together share
  // one fetch instead of N
  if (plArtCache.has(browseId)) return plArtCache.get(browseId)
  const p = new Promise((resolve) => {
    plArtQueue.push(async () => {
      try {
        const yt = await getYt()
        if (!yt) return resolve([])
        // MPRE ids are albums — getPlaylist would 404 them; getAlbum returns
        // the same node tree with a track list under .items
        const req = browseId.startsWith("MPR")
          ? yt.music.getAlbum(browseId)
          : yt.music.getPlaylist(browseId)
        // no timeout in youtubei.js — a silent network would pin a queue
        // slot forever; two such jobs would starve the whole collage queue
        const res = await Promise.race([
          req.catch((e) => (ytFail(e), null)),
          new Promise((r) => setTimeout(() => r(null), 12000)),
        ])
        resolve(
          res
            ? songsOf(res)
                .slice(0, 4)
                .map((t) => t.artwork?.["150x150"])
                .filter(Boolean)
            : [],
        )
      } catch {
        // a throwing getter inside songsOf must never reject the job —
        // the cached promise would never settle and the queue would stall
        resolve([])
      }
    })
    pumpPlArt()
  })
  plArtCache.set(browseId, p)
  if (plArtCache.size > 80) plArtCache.delete(plArtCache.keys().next().value)
  return p
}

// ---------- captions → synced lyrics ----------
// Last-resort synced lyrics: the video's own caption tracks (manual subs on
// lyric videos, otherwise ASR — which exists for nearly every music upload).
// `yt-dlp -J` exposes every caption format's URL without downloading media.

// emit each cue's newest row only — rolling ASR windows repeat the previous
// line as their first row, so last-row + dedupe reconstructs the lyric sheet
function captionLines(body, ext) {
  const out = []
  const push = (t, text) => {
    const clean = String(text).replace(/\s+/g, " ").trim()
    if (!clean || out.at(-1)?.text === clean) return
    out.push({ t, text: clean })
  }
  if (ext === "json3") {
    try {
      const j = JSON.parse(body)
      for (const ev of j.events ?? []) {
        if (typeof ev.tStartMs !== "number" || !ev.segs) continue
        const rows = ev.segs
          .map((s) => s.utf8 ?? "")
          .join("")
          .split(/\r?\n/)
          .map((r) => r.trim())
          .filter(Boolean)
        if (!rows.length) continue
        // append events carry continuation words for the PREVIOUS cue —
        // as standalone lines they'd fragment the pool into false matches
        if (ev.aAppend && out.length) {
          out.at(-1).text = `${out.at(-1).text} ${rows.at(-1)}`
          continue
        }
        push(ev.tStartMs / 1000, rows.at(-1))
      }
    } catch {}
    return out
  }
  let m
  if (ext === "srv3") {
    const re = /<text[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/text>/g
    while ((m = re.exec(body))) {
      const row = m[2].replace(/<[^>]+>/g, "\n").split(/\n+/).map((r) => r.trim()).filter(Boolean).at(-1)
      if (row) push(Number(m[1]) / 1000, row)
    }
    return out
  }
  // vtt — inline <mm:ss.mmm> karaoke markers + <c> tags get stripped
  const re = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->[^\n]*\n([\s\S]*?)(?=\r?\n\s*\r?\n|$)/g
  while ((m = re.exec(body))) {
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
    const clean = m[5].replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ")
    const rows = clean.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
    if (rows.length) push(t, rows.at(-1))
  }
  return out
}

// prefer a latin/euro language the lyrics are most likely sung in, else the
// first available track; json3 parses cleanest, srv3/vtt are fallbacks
const CAP_LANGS = ["es", "en", "pt", "it", "fr", "de"]
function pickCaptionFmt(dict) {
  if (!dict || typeof dict !== "object") return null
  let keys = Object.keys(dict).filter((k) => Array.isArray(dict[k]) && dict[k].length)
  if (!keys.length) return null
  // automatic_captions lists ~150 machine-TRANSLATED targets alongside the
  // one real track — picking a CAP_LANGS member here hands back e.g. a
  // Spanish translation of English audio, which then never matches the
  // lyrics. The "*-orig" key is the ASR of the actual audio: always first
  const orig = keys.filter((k) => k.endsWith("-orig"))
  if (orig.length) keys = orig
  else {
    const rank = (k) => {
      const i = CAP_LANGS.findIndex((l) => k === l || k.startsWith(`${l}-`))
      return i === -1 ? CAP_LANGS.length : i
    }
    keys.sort((a, b) => rank(a) - rank(b))
  }
  // walk languages in preference order — the top pick may only carry a
  // format we can't parse (ttml) while a lower one has json3/vtt
  for (const k of keys) {
    const fmts = dict[k]
    const fmt = fmts.find((f) => f.ext === "json3") ?? fmts.find((f) => f.ext === "srv3") ?? fmts.find((f) => f.ext === "vtt")
    if (fmt) return { ...fmt, lang: k }
  }
  return null
}

// resolved results (null included — a video with no captions shouldn't
// re-run a 5s yt-dlp -J every time the lyrics panel reopens)
const capCache = new Map()
const capInflight = new Map()
async function captions(videoId) {
  if (!ytdlpAvailable()) return null
  if (capCache.has(videoId)) return capCache.get(videoId)
  if (capInflight.has(videoId)) return capInflight.get(videoId)
  const job = (async () => {
    // only cache once -J succeeds — a thrown yt-dlp/network error is
    // transient and must retry next time, not stick as a false negative
    const done = (result) => {
      capCache.set(videoId, result)
      if (capCache.size > 60) capCache.delete(capCache.keys().next().value)
      return result
    }
    try {
      const out = await runYtdlp(
        [
          "-J", "--no-playlist", "--no-warnings",
          "--socket-timeout", "10", "--retries", "2",
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        30000
      )
      const info = JSON.parse(out)
      const sub = pickCaptionFmt(info.subtitles)
      const asr = pickCaptionFmt(info.automatic_captions)
      // manual subs in a DIFFERENT language than the audio are translated
      // subtitles — they'd fail every lyric-content check anyway; the
      // original-language ASR is the truthful transcript
      const origLang = Object.keys(info.automatic_captions ?? {})
        .find((k) => k.endsWith("-orig"))
        ?.replace(/-orig$/, "")
      const fmt =
        sub && asr && origLang && !sub.lang.startsWith(origLang) ? asr : sub ?? asr
      if (!fmt?.url) return done(null)
      const res = await fetch(fmt.url, { headers: { "User-Agent": "Freebify/1.0" }, signal: AbortSignal.timeout(9000) })
      // transient fetch/parse failures must NOT cache — a 403'd signed url
      // or an odd format would otherwise poison the video all session
      if (!res.ok) return null
      const lines = captionLines(await res.text(), fmt.ext)
      if (lines.length < 4) return null
      return done({ lines })
    } catch (e) {
      log("captions", `${videoId}: ${e?.message ?? e}`)
      return null
    } finally {
      capInflight.delete(videoId)
    }
  })()
  capInflight.set(videoId, job)
  return job
}

// Full synced-where-available lyrics for the Now Playing panel
async function lyrics(videoId) {
  const yt = await getYt()
  if (!yt) return null
  try {
    const res = await yt.music.getLyrics(videoId)
    const body = text(res?.description ?? res?.lyrics ?? res?.text)
    return body ? { lyrics: body } : null
  } catch (e) {
    ytFail(e)
    return null
  }
}

// Search autocomplete — bolded prefix runs map to a plain suggestion list
async function suggestions(query) {
  const yt = await getYt()
  if (!yt) return []
  try {
    const res = await yt.music.getSearchSuggestions(query)
    return collect(res, ["SearchSuggestion"])
      .map((s) => text(s.suggestion))
      .filter(Boolean)
      .slice(0, 8)
  } catch (e) {
    ytFail(e)
    return []
  }
}

async function available() {
  const [yt, bin] = await Promise.all([getYt(), Promise.resolve(ytdlpAvailable())])
  return { meta: Boolean(yt), bin: bin }
}

// ---------- registration ----------
// validate every argument crossing the IPC boundary — the renderer is our
// own code, but defense in depth is cheap here
const VID = /^[\w-]{6,20}$/
const BID = /^[\w-]{4,64}$/
const Q = (v) => (typeof v === "string" ? v.slice(0, 200) : "")
// a stalled Innertube request must never leave a spinner hanging forever
const withTimeout = (p, ms = 15000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(null)
      }
    )
  })

function register(ipcMain) {
  // warm the binary: the first yt-dlp spawn on Windows pays PE-load +
  // AV-scan cost (~300-800ms). A throwaway --version at startup moves that
  // off the critical path of the user's first click.
  if (ytdlpAvailable()) {
    // via runYtdlp so the mac de-quarantine lands before this first spawn too
    runYtdlp(["--version"], 8000).catch(() => {})
  }

  // no raw available() here — Innertube.create() has no timeout of its own
  // and on a dead-but-silent network the promise never settles, hanging
  // every page's first ytAvailable() await (skeletons forever, no Audius
  // fallback). Timeout → report unavailable so pages degrade gracefully.
  ipcMain.handle("yt:available", () =>
    withTimeout(available(), 12000).then(
      (r) => r ?? { meta: false, bin: false },
      () => ({ meta: false, bin: false })
    )
  )
  ipcMain.handle("yt:search", (_e, q) =>
    withTimeout(search(Q(q)), 20000).then(
      (r) => r ?? { tracks: [], artists: [], playlists: [] },
      () => ({ tracks: [], artists: [], playlists: [] })
    )
  )
  ipcMain.handle("yt:stream", (_e, videoId) =>
    typeof videoId === "string" && VID.test(videoId)
      ? withTimeout(resolveStreamUrl(videoId), 25000)
      : null
  )
  // warm-up lane — same cache, but queued behind real playback clicks
  ipcMain.handle("yt:prefetch", (_e, videoId) =>
    typeof videoId === "string" && VID.test(videoId)
      ? withTimeout(resolveStreamUrl(videoId, true), 25000)
      : null
  )
  ipcMain.handle("yt:invalidate", (_e, videoId) => {
    if (typeof videoId === "string" && VID.test(videoId)) {
      streamCache.delete(videoId)
      // the delete must reach disk — before-quit flushes skip clean caches,
      // so an invalidated dead URL would resurrect on relaunch
      cacheDirty = true
      // if a fast-probe URL was the dead one (IP-bound to the instance's
      // egress), the next resolve must not take the probe branch again
      probeBad.add(videoId)
      if (probeBad.size > 200) probeBad.delete(probeBad.keys().next().value)
    }
    return true
  })
  ipcMain.handle("yt:artist", (_e, id, nameHint) =>
    typeof id === "string" && id.length < 80
      ? withTimeout(artist(id, typeof nameHint === "string" && nameHint.length < 80 ? nameHint : undefined), 25000).catch(
          () => null
        )
      : null
  )
  ipcMain.handle("yt:album", (_e, id) =>
    typeof id === "string" && BID.test(id) ? withTimeout(album(id), 20000).catch(() => null) : null
  )
  ipcMain.handle("yt:playlist", (_e, id) =>
    typeof id === "string" && BID.test(id) ? withTimeout(playlist(id), 25000).catch(() => null) : null
  )
  ipcMain.handle("yt:playlists", () => withTimeout(homePlaylists(), 20000).then((r) => r ?? [], () => []))
  ipcMain.handle("yt:upnext", (_e, videoId) =>
    typeof videoId === "string" && VID.test(videoId) ? withTimeout(upNext(videoId), 20000).then((r) => r ?? [], () => []) : []
  )
  ipcMain.handle("yt:trending", () => withTimeout(trending(), 20000).then((r) => r ?? [], () => []))
  ipcMain.handle("yt:charts", () =>
    withTimeout(charts(), 25000).then((r) => r ?? { tracks: [], artists: [] }, () => ({ tracks: [], artists: [] }))
  )
  ipcMain.handle("yt:newreleases", () => withTimeout(newReleases(), 20000).then((r) => r ?? [], () => []))
  ipcMain.handle("yt:moods", () => withTimeout(moods(), 20000).then((r) => r ?? [], () => []))
  ipcMain.handle("yt:mood", (_e, params) =>
    typeof params === "string" && params.length < 200
      ? withTimeout(mood(params), 20000).catch(() => null)
      : null
  )
  ipcMain.handle("yt:playlistarts", (_e, id) =>
    typeof id === "string" && BID.test(id) ? withTimeout(playlistArts(id), 20000).then((r) => r ?? [], () => []) : []
  )
  ipcMain.handle("yt:lyrics", (_e, videoId) =>
    typeof videoId === "string" && VID.test(videoId) ? withTimeout(lyrics(videoId), 15000).catch(() => null) : null
  )
  ipcMain.handle("yt:captions", (_e, videoId) =>
    typeof videoId === "string" && VID.test(videoId) ? withTimeout(captions(videoId), 40000).catch(() => null) : null
  )
  ipcMain.handle("yt:videosearch", (_e, q) =>
    typeof q === "string" && q.length < 100 ? withTimeout(videoSearch(Q(q)), 15000).catch(() => []) : []
  )
  ipcMain.handle("yt:suggest", (_e, q) =>
    typeof q === "string" && q.length < 100 ? withTimeout(suggestions(Q(q)), 8000).then((r) => r ?? [], () => []) : []
  )

  // keep yt-dlp updated — YouTube changes frequently. Skip inside the
  // portable exe (temp-extracted) and at most once per day.
  if (ytdlpAvailable() && !process.env.PORTABLE_EXECUTABLE_DIR) {
    const stamp = path.join(app.getPath("userData"), "ytdlp-update.txt")
    const last = (() => {
      try {
        return +fs.readFileSync(stamp, "utf8") || 0
      } catch {
        return 0
      }
    })()
    if (Date.now() - last > 24 * 60 * 60 * 1000) {
      // stamp BEFORE the attempt — a persistent failure (offline, AV lock)
      // would otherwise retry a 30s self-update on every single launch
      try {
        fs.writeFileSync(stamp, String(Date.now()))
      } catch {}
      setTimeout(() => {
        runYtdlp(["-U"], 30000).catch(() => {})
      }, 15000)
    }
  }
}

module.exports = { register, binPath, ytdlpAvailable, ensureExecutable }
