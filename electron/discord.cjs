// Discord Rich Presence — "Listening to Freebify" on the user's profile,
// same as Spotify. Talks to the running Discord client's local IPC socket;
// when Discord isn't open we retry quietly in the background.
//
// CLIENT_ID comes from the app's Discord Developer Portal application.
const CLIENT_ID = "1556360210031841291" // Freebify — discord.com/developers application id
const ACTIVITY_TYPE_LISTENING = 2

let client = null
let connecting = false
let retryTimer = null
let lastJson = null // last activity we pushed — resend after a reconnect
let enabled = true

function log(msg) {
  try {
    const { app } = require("electron")
    const fs = require("fs")
    const path = require("path")
    const dir = path.join(app.getPath("userData"), "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "freebify.log"), `${new Date().toISOString()} [discord] ${msg}\n`)
  } catch {}
}

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ])
}

async function connect() {
  if (client || connecting || !enabled) return client
  connecting = true
  let c = null
  try {
    const { Client } = await import("@xhayper/discord-rpc")
    c = new Client({ clientId: CLIENT_ID })
    c.on("disconnected", () => {
      if (client === c) client = null
      try {
        c.destroy?.()
      } catch {}
      log("disconnected")
      scheduleRetry()
    })
    // a dead Discord pipe can leave login() pending forever — without the
    // timeout `connecting` stays true and every retry early-returns, so the
    // presence never recovers until app restart
    await withTimeout(c.login(), 10000, "discord login")
    client = c
    c = null // ownership transferred — failure path won't destroy it
    log("connected")
    if (lastJson) await push(lastJson).catch(() => {})
  } catch (e) {
    log(`connect failed: ${e?.message ?? e}`)
    try {
      c?.destroy?.()
    } catch {}
    client = null
    scheduleRetry()
  } finally {
    connecting = false
  }
  return client
}

function scheduleRetry() {
  if (retryTimer || !enabled) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void connect()
  }, 30000)
  retryTimer.unref?.()
}

async function push(activity) {
  const c = await connect()
  if (!c) return
  try {
    // user.setActivity sends the SET_ACTIVITY command over the IPC socket
    await withTimeout(c.user.setActivity(activity), 8000, "setActivity")
  } catch (e) {
    log(`setActivity failed: ${e?.message ?? e}`)
    client = null
    try {
      c.destroy?.()
    } catch {}
    scheduleRetry()
  }
}

// ytimg video thumbs: hqdefault.jpg is a 4:3 frame with letterbox bars baked
// in. maxresdefault is true 16:9 without them — but it 404s on some videos,
// so HEAD-check and keep the original when missing.
async function bestArt(url) {
  if (!/i\.ytimg\.com\/vi\//.test(url)) return url
  const better = url.replace(/\/(hqdefault|mqdefault|sddefault|hq720|default)\.jpg.*$/, "/maxresdefault.jpg")
  if (better === url) return url
  try {
    const r = await fetch(better, { method: "HEAD", signal: AbortSignal.timeout(3000) })
    return r.ok ? better : url
  } catch {
    return url
  }
}

// payload from the renderer: {playing, title, artist, artwork, durationMs,
// positionMs, url} — null clears the presence
async function setPresence(payload) {
  if (!enabled) return
  if (!payload || payload.playing !== true) {
    lastJson = null
    if (client) {
      try {
        await client.user.clearActivity()
      } catch {}
    }
    return
  }
  const activity = {
    type: ACTIVITY_TYPE_LISTENING,
    details: String(payload.title ?? "Unknown title").slice(0, 128),
    state: String(payload.artist ?? "Unknown artist").slice(0, 128),
    largeImageText: "Freebify",
    instance: false,
  }
  let art = typeof payload.artwork === "string" && /^https:/.test(payload.artwork) ? payload.artwork : null
  if (art) art = await bestArt(art)
  // Discord's IPC rewrites external https in large_image to mp:external/*
  // automatically — no dev-portal assets or OAuth needed. large_url makes
  // the artwork clickable (opens the source video).
  if (art) activity.largeImageKey = art
  if (typeof payload.url === "string" && /^https:/.test(payload.url)) activity.largeImageUrl = payload.url
  const dur = Number(payload.durationMs)
  const pos = Number(payload.positionMs)
  if (Number.isFinite(dur) && dur > 0 && Number.isFinite(pos) && pos >= 0) {
    activity.startTimestamp = Math.max(0, Date.now() - Math.round(pos))
    activity.endTimestamp = Date.now() + Math.max(0, Math.round(dur - pos))
  }
  lastJson = activity
  await push(activity)
}

function setEnabled(v) {
  enabled = v !== false
  if (!enabled) {
    lastJson = null
    if (retryTimer) clearTimeout(retryTimer), (retryTimer = null)
    if (client) {
      const c = client
      client = null
      c.user?.clearActivity?.().catch(() => {})
      c.destroy?.()
    }
  } else void connect()
}

// presence dies with the Discord socket or the app — nothing to persist
module.exports = { setPresence, setEnabled }
