// Spotify playlist import — the ONLY consumer of the Spotify Web API.
// Strictly read-only (playlist-read-*): the user's own OAuth session
// unlocks the FULL track list, which the anonymous embed page caps at 100.
//
// Privacy contract the UI makes (and this file must keep true):
// - no Spotify servers of ours exist — every request goes straight from
//   the user's machine to accounts.spotify.com / api.spotify.com
// - the token lives in this module's MEMORY ONLY: never persisted, never
//   written to the log file, never sent over IPC to the renderer
// - closing the app erases it; `forget()` erases it on demand
const crypto = require("crypto")
const fs = require("fs")
const http = require("http")
const path = require("path")
const { app, BrowserWindow } = require("electron")

const CLIENT_ID = "6868fab689ff4c2ebfe0566801474075"
// both URIs are registered on the Spotify dashboard — loopback is the
// primary (the auth child window navigates straight into our receiver);
// the custom scheme exists as belt-and-braces for a cold-start callback
const REDIRECT = "http://127.0.0.1:41810/callback"
const SCOPE = "playlist-read-private playlist-read-public"
const API = "https://api.spotify.com/v1"
// 200 pages x 100 = 20k — Spotify's own UI tops out far below this
const MAX_TRACKS = 20000

function log(tag, msg) {
  try {
    const dir = path.join(app.getPath("userData"), "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "freebify.log"), `${new Date().toISOString()} [${tag}] ${msg}\n`)
  } catch {}
}

let token = null // { value, expiresAt } — memory only

const EXPIRY_SKEW = 60 * 1000 // refresh a minute early, don't test 401s on users

function connected() {
  return Boolean(token && Date.now() < token.expiresAt)
}

function forget() {
  token = null
}

// ---------- OAuth: PKCE over a child window + loopback receiver ----------

// the success/error page the auth window ends on — neutral, no branding
const CALLBACK_HTML =
  '<meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#fff;font-family:sans-serif"><div style="text-align:center"><p style="font-size:15px">Playlist authorized.</p><p style="font-size:13px;color:#a3a3a3;margin-top:6px">You can close this window.</p></div></body>'

// runs the PKCE dance and resolves { code, verifier } — or null when the
// window was closed / the user denied / the loopback never received a code
async function openAuthWindow(state) {
  const verifier = crypto.randomBytes(64).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  })
  const authUrl = `https://accounts.spotify.com/authorize?${params}`

  return new Promise((resolveOuter) => {
    let settled = false
    let srv = null
    let win = null
    const done = (code) => {
      if (settled) return
      settled = true
      try {
        srv?.close?.()
      } catch {}
      if (win && !win.isDestroyed()) win.close()
      resolveOuter(code ? { code, verifier } : null)
    }

    // the receiver must be bound BEFORE the auth window ever redirects —
    // a bind failure (port taken by another pending login) resolves null
    srv = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404)
        return void res.end()
      }
      const q = new URL(req.url, "http://127.0.0.1")
      const err = q.searchParams.get("error")
      const code = q.searchParams.get("code")
      const gotState = q.searchParams.get("state")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      // don't wait for the ACK — grab retries (favicon etc.) would rerun this
      res.end(CALLBACK_HTML)
      done(!err && code && gotState === state ? code : null)
    })
    srv.on("error", (e) => {
      log("spotify.auth", `loopback bind failed: ${e?.code ?? e}`)
      done(null)
    })
    srv.listen(41810, "127.0.0.1")

    try {
      const parent = BrowserWindow.getAllWindows()[0]
      win = new BrowserWindow({
        width: 460,
        height: 740,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        show: true,
        title: "Spotify",
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      win.on("closed", () => done(null))
      // user denied / Spotify errored — the query comes back with ?error=
      // on the redirect URI; cancel before the page even loads
      win.webContents.on("will-redirect", (e, url) => {
        if (url.startsWith(REDIRECT) && /[?&]error=/.test(url)) {
          e.preventDefault()
          log("spotify.auth", "denied: " + url.match(/error=[\w_]+/)?.[0])
          done(null)
        }
      })
      void win.loadURL(authUrl)
    } catch (e) {
      log("spotify.auth", `window failed: ${e?.message ?? e}`)
      done(null)
    }
  })
}

async function tokenExchange(form) {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      log("spotify.auth", `exchange ${res.status}`)
      return null
    }
    const j = await res.json()
    return j?.access_token ? j : null
  } catch (e) {
    log("spotify.auth", `exchange failed: ${e?.message ?? e}`)
    return null
  }
}

// returns true when a usable token is in memory afterwards
async function connect() {
  if (connected()) return true
  const state = crypto.randomBytes(16).toString("base64url")
  const auth = await openAuthWindow(state)
  if (!auth) return false
  const tok = await tokenExchange({
    grant_type: "authorization_code",
    code: auth.code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: auth.verifier,
  })
  if (!tok) return false
  token = {
    value: tok.access_token,
    expiresAt: Date.now() + Math.max(60, Number(tok.expires_in) || 3600) * 1000 - EXPIRY_SKEW,
  }
  return true
}

// ---------- playlist readers ----------

// first page + continuation walking against the user's own session
async function apiPlaylist(id) {
  if (!token) return null
  const headers = { Authorization: `Bearer ${token.value}` }
  try {
    const meta = await fetch(`${API}/playlists/${id}?fields=name`, {
      headers,
      signal: AbortSignal.timeout(15000),
    })
    if (meta.status === 401 || meta.status === 403) {
      log("spotify.import", `auth rejected (${meta.status}) — clearing token`)
      token = null
      return null
    }
    if (!meta.ok) {
      log("spotify.import", `playlist meta ${meta.status}`)
      return null
    }
    const name = (await meta.json())?.name
    if (!name) return null
    const tracks = []
    let url = `${API}/playlists/${id}/tracks?limit=100&offset=0&fields=next,items(track)`
    while (url && tracks.length < MAX_TRACKS) {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
      if (r.status === 401 || r.status === 403) {
        token = null
        return null
      }
      if (!r.ok) {
        log("spotify.import", `tracks ${r.status} @${tracks.length}`)
        return null
      }
      const j = await r.json()
      for (const it of j.items ?? []) {
        const t = it?.track
        if (!t || t.is_local) continue
        const title = String(t.name ?? "")
        const artist = (t.artists ?? [])
          .map((a) => a?.name)
          .filter(Boolean)
          .join(", ")
        if (title && artist) tracks.push({ title, artist })
      }
      url = j.next
    }
    return { name, tracks }
  } catch (e) {
    log("spotify.import", `api failed: ${e?.message ?? e}`)
    return null
  }
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

// renderer-facing entry:
//   importPlaylist(id)          → token if already connected, else embed
//   importPlaylist(id,{connect})→ run the OAuth flow first, then the API
// → { ok:true, source, name, tracks: [{title,artist}], capped }
// → { ok:false } when nothing readable exists
async function importPlaylist(id, opts = {}) {
  if (typeof id !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(id)) return { ok: false }
  if (opts.connect) {
    const ok = await connect()
    if (!ok) return { ok: false, connectFailed: true }
  }
  if (connected()) {
    const api = await apiPlaylist(id)
    if (api) {
      log("spotify.import", `api ok: ${api.tracks.length} tracks`)
      return { ok: true, source: "api", name: api.name, tracks: api.tracks, capped: false }
    }
    // 401 cleared the token — fall through to the embed once
  }
  const emb = await embedPlaylist(id)
  if (!emb) return { ok: false }
  return {
    ok: true,
    source: "embed",
    name: emb.name,
    tracks: emb.tracks,
    capped: emb.tracks.length >= 100,
  }
}

function register(ipcMain) {
  ipcMain.handle("sp:import", (_e, id, opts) =>
    importPlaylist(id, opts ?? {}).catch((e) => {
      log("spotify.import", `failed: ${e?.message ?? e}`)
      return { ok: false }
    })
  )
  ipcMain.handle("sp:connected", () => connected())
  ipcMain.handle("sp:forget", () => {
    forget()
    return true
  })
}

module.exports = { register, importPlaylist, embeddedPlaylist: embedPlaylist, forget, connected, connect }
