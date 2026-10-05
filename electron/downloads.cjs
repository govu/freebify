// Downloaded-track store — the "offline" layer.
// Audio files + a JSON manifest live in userData/downloads. The renderer
// plays them through the fbx:// scheme (privileges registered before app
// ready in main.cjs): file:// urls would trip webSecurity on the dev
// server origin, and raw paths can't cross the IPC boundary.
const { spawn } = require("child_process")
const path = require("path")
const fs = require("fs")
const { pathToFileURL } = require("url")
const { app, shell, BrowserWindow, protocol, net } = require("electron")
const { binPath, ytdlpAvailable } = require("./youtube.cjs")

// mirror of main.cjs logLine — same file so a grep reads the whole story
function log(tag, msg) {
  try {
    const dir = path.join(app.getPath("userData"), "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "freebify.log"), `${new Date().toISOString()} [${tag}] ${msg}\n`)
  } catch {}
}

const dlDir = () => path.join(app.getPath("userData"), "downloads")
const manifestFile = () => path.join(dlDir(), "downloads.json")

// trackId -> { file, track, addedAt } — track is the renderer's slim track
// object, stored whole so the Downloads page needs zero network to render
let manifest = null // lazy — userData path isn't valid before app ready
let dirty = false
const inFlight = new Map() // id -> { kill: () => void }
// batch downloads (album/playlist "download all") queue here — spawning a
// yt-dlp per track unthrottled would torch CPU + rate limits
const MAX_PARALLEL = 3
const pending = [] // [{id, start}] FIFO

function loadManifest() {
  if (manifest) return
  manifest = {}
  try {
    const raw = JSON.parse(fs.readFileSync(manifestFile(), "utf8"))
    if (raw && typeof raw === "object") manifest = raw
  } catch { /* first run / corrupt — start empty */ }
  // prune entries whose file disappeared — the user can clean the folder
  // in Explorer; a dead manifest entry would serve a 404 forever
  for (const [id, it] of Object.entries(manifest)) {
    if (!it?.file || !fs.existsSync(path.join(dlDir(), it.file))) {
      delete manifest[id]
      dirty = true
    }
  }
}

function saveManifest() {
  if (!dirty || !manifest) return
  try {
    fs.mkdirSync(dlDir(), { recursive: true })
    const tmp = manifestFile() + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(manifest))
    fs.renameSync(tmp, manifestFile())
    dirty = false
  } catch { /* manifest is best-effort */ }
}
setInterval(saveManifest, 30 * 1000).unref?.()
app?.once?.("before-quit", saveManifest)

const emit = (ev) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("dl:event", ev)
  }
}

// manifest keys are track ids — filenames should read like a music folder,
// not a cache: "Artist - Title.ext", sanitized for the filesystem, deduped
// against existing downloads so two same-titled tracks don't overwrite
const safe = (id) => String(id).replace(/[^\w-]/g, "_").slice(0, 80)
const sanitizeName = (s) =>
  s
    .replace(/[<>:"/\\|?*]/g, "").replace(new RegExp("[\u0000-\u001f]", "g"), "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "") // Windows forbids trailing dot/space
    .trim()

function uniqueBase(id, track) {
  const artist = sanitizeName(String(track?.user?.name ?? ""))
  const title = sanitizeName(String(track?.title ?? ""))
  let base = (artist && title ? `${artist} - ${title}` : title || artist || safe(id)).slice(0, 150)
  const taken = new Set()
  try {
    for (const f of fs.readdirSync(dlDir())) taken.add(f.replace(/\.[^.]+(\.part)?$/, ""))
  } catch {}
  // this id's own previous file isn't a collision — redownloads overwrite it
  const own = manifest?.[id]?.file?.replace(/\.[^.]+$/, "")
  if (own) taken.delete(own)
  let cand = base
  let n = 2
  while (taken.has(cand)) cand = `${base} (${n++})`
  return cand
}

// yt-dlp's -o template ends in %(ext)s so the real extension is only known
// after the fact — scan for the finished file (.part = still writing)
const findOutput = (base) =>
  fs
    .readdirSync(dlDir())
    .find((f) => f.startsWith(`${base}.`) && !f.endsWith(".part") && !f.endsWith(".json"))

function commit(id, file, track) {
  manifest[id] = { file, track, addedAt: Date.now() }
  dirty = true
  saveManifest()
  emit({ type: "done", id, item: manifest[id] })
}

function fail(id, msg) {
  emit({ type: "error", id, msg: String(msg ?? "download failed").slice(0, 200) })
}

// run the next queued download when a slot frees
function drain() {
  while (inFlight.size < MAX_PARALLEL && pending.length) {
    const job = pending.shift()
    if (!job || manifest[job.id]) continue
    job.start()
  }
}

// YouTube track → yt-dlp writes the file itself; progress parsed from the
// "[download]  42.3%" lines it prints on stderr
function downloadYt(id, streamId, track) {
  const base = uniqueBase(id, track)
  const args = [
    "-f", "bestaudio[ext=m4a]/bestaudio",
    "--no-playlist",
    "--no-warnings",
    // one progress line per update — parseable without a pty
    "--newline",
    "--socket-timeout", "15",
    "--retries", "3",
    "-o", path.join(dlDir(), `${base}.%(ext)s`),
    `https://music.youtube.com/watch?v=${streamId}`,
  ]
  const child = spawn(binPath(), args, { windowsHide: true })
  inFlight.set(id, { kill: () => { try { child.kill() } catch {} } })
  let buf = ""
  const onData = (d) => {
    buf += d
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ""
    for (const ln of lines) {
      const m = /\[download\]\s+([\d.]+)%/.exec(ln)
      if (m) emit({ type: "progress", id, pct: Math.min(99, Math.round(+m[1])) })
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  const finish = (ok) => {
    inFlight.delete(id)
    drain()
    const file = ok ? findOutput(base) : null
    if (file) commit(id, file, track)
    else fail(id, "yt-dlp couldn't fetch this track")
  }
  child.on("error", () => finish(false))
  child.on("close", (code) => finish(code === 0))
}

// Audius (or any direct https stream) → stream the response to disk with
// content-length progress; .part suffix until complete so a killed download
// never masquerades as a finished file
async function downloadHttp(id, url, track) {
  const ctl = new AbortController()
  inFlight.set(id, { kill: () => ctl.abort() })
  const base = uniqueBase(id, track)
  let part = null
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Freebify/1.0" },
      redirect: "follow",
      signal: ctl.signal,
    })
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`)
    const ext = /mp4|m4a|aac|mp3/i.test(res.headers.get("content-type") ?? "")
      ? (/(mp4|m4a|aac)/i.test(res.headers.get("content-type")) ? "m4a" : "mp3")
      : "mp3"
    part = path.join(dlDir(), `${base}.${ext}.part`)
    const total = Number(res.headers.get("content-length")) || 0
    const out = fs.createWriteStream(part)
    let got = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once("drain", r))
      }
      if (total) emit({ type: "progress", id, pct: Math.min(99, Math.round((got / total) * 100)) })
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())))
    const file = `${base}.${ext}`
    fs.renameSync(part, path.join(dlDir(), file))
    part = null
    commit(id, file, track)
  } catch (e) {
    if (part) { try { fs.unlinkSync(part) } catch {} }
    fail(id, e?.name === "AbortError" ? "cancelled" : e?.message)
    log("dl", `${id}: ${e?.message ?? e}`)
  } finally {
    inFlight.delete(id)
    drain()
  }
}

function register(ipcMain) {
  loadManifest()

  // fbx://dl/<file> — serves downloaded audio to <audio>.src. Basename-only
  // resolution inside dlDir: no traversal, no absolute paths over IPC.
  protocol.handle("fbx", async (req) => {
    try {
      const u = new URL(req.url)
      if (u.hostname !== "dl") return new Response("not found", { status: 404 })
      const name = path.basename(decodeURIComponent(u.pathname))
      const file = path.join(dlDir(), name)
      if (!file.startsWith(dlDir()) || !fs.existsSync(file)) {
        return new Response("not found", { status: 404 })
      }
      // ACAO:* — downloaded tracks route through Web Audio (EQ/normalize)
      // in the renderer; custom-scheme media is cross-origin by default
      const res = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(res.headers)
      headers.set("access-control-allow-origin", "*")
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response("bad request", { status: 400 })
    }
  })

  ipcMain.handle("dl:list", () => {
    loadManifest()
    return Object.entries(manifest)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
  })

  // existence probe for the play path — the store may hold an entry for a
  // file the user deleted since the last refresh
  ipcMain.handle("dl:exists", (_e, id) => {
    loadManifest()
    const it = typeof id === "string" ? manifest[id] : null
    if (!it) return false
    if (fs.existsSync(path.join(dlDir(), it.file))) return true
    delete manifest[id]
    dirty = true
    saveManifest()
    return false
  })

  ipcMain.handle("dl:start", (_e, payload) => {
    loadManifest()
    const p = payload && typeof payload === "object" ? payload : {}
    const { id, source, streamId, url, track } = p
    if (typeof id !== "string" || !id || id.length > 120) return false
    if (!track || typeof track !== "object") return false
    if (manifest[id] || inFlight.has(id) || pending.some((j) => j.id === id)) return true
    try {
      fs.mkdirSync(dlDir(), { recursive: true })
    } catch {
      return false
    }
    emit({ type: "queued", id })
    const start = () => {
      emit({ type: "progress", id, pct: 0 }) // a real start — distinguishes "downloading" from "waiting in queue"
      if (source === "yt" && typeof streamId === "string" && /^[\w-]{6,20}$/.test(streamId)) {
        if (!ytdlpAvailable()) {
          emit({ type: "error", id, msg: "yt-dlp unavailable" })
          return
        }
        downloadYt(id, streamId, track)
        return
      }
      if (typeof url === "string" && /^https:\/\//.test(url)) {
        void downloadHttp(id, url, track)
        return
      }
      emit({ type: "error", id, msg: "unsupported source" })
    }
    if (inFlight.size >= MAX_PARALLEL) pending.push({ id, start })
    else start()
    return true
  })

  ipcMain.handle("dl:remove", (_e, id) => {
    loadManifest()
    if (typeof id !== "string") return false
    const qi = pending.findIndex((j) => j.id === id)
    if (qi >= 0) pending.splice(qi, 1)
    inFlight.get(id)?.kill()
    inFlight.delete(id)
    drain()
    const it = manifest[id]
    if (it) {
      for (const f of [it.file, `${it.file}.part`]) {
        try { fs.unlinkSync(path.join(dlDir(), f)) } catch {}
      }
      delete manifest[id]
      dirty = true
      saveManifest()
    }
    return true
  })

  ipcMain.on("dl:opendir", () => {
    try {
      fs.mkdirSync(dlDir(), { recursive: true })
      void shell.openPath(dlDir())
    } catch {}
  })
}

// MUST run before app.whenReady — standard+stream privileges let <audio>
// elements (and the media pipeline) fetch fbx:// urls like https ones
function privilege() {
  protocol.registerSchemesAsPrivileged([
    { scheme: "fbx", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ])
}

module.exports = { register, privilege }
