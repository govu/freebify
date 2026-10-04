const { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } = require("electron")
const fs = require("fs")
const path = require("path")
const { pathToFileURL } = require("url")
const youtube = require("./youtube.cjs")

// dev is only ever a local vite server — a packaged exe must never flip
// into remote-URL loading via argv/env (it would hand the bridge to a
// remote document)
const isDev = !app.isPackaged
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173"

// keep the taskbar group/notification identity stable across restarts —
// Windows keys pinned icons and toast attribution to this id
app.setAppUserModelId("com.freebify.app")

// ---- Windows taskbar thumbnail toolbar (like Spotify's hover controls) ----
const thumbarDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "thumbar")
    : path.join(__dirname, "..", "resources", "thumbar")
// nativeImage objects are cached — createFromPath on every refresh would
// leak GDI handles on each play/pause flip
const iconCache = new Map()
const thumbIcon = (name) => {
  let img = iconCache.get(name)
  if (!img) {
    img = nativeImage.createFromPath(path.join(thumbarDir(), name))
    iconCache.set(name, img)
  }
  return img
}
let thumbarPlaying = false
let tray = null

function createTray() {
  if (tray) return
  tray = new Tray(thumbIcon("tray.png"))
  tray.setToolTip("Freebify")
  const show = () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
  const send = (cmd) => () => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send("player:cmd", cmd)
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Freebify", click: show },
      { type: "separator" },
      { label: "Play / Pause", click: send("toggle") },
      { label: "Next", click: send("next") },
      { label: "Previous", click: send("prev") },
      { type: "separator" },
      { label: "Quit", click: quit },
    ])
  )
  tray.on("click", show)
}

function refreshThumbar(win) {
  if (!win || win.isDestroyed()) return
  const send = (cmd) => () => {
    if (!win.isDestroyed()) win.webContents.send("player:cmd", cmd)
  }
  // must only be called once the window has a real taskbar entry —
  // setThumbarButtons on a not-yet-shown window silently no-ops
  if (!win.isVisible()) {
    win.once("show", () => refreshThumbar(win))
    return
  }
  win.setThumbarButtons([
    { tooltip: "Save to Liked Songs", icon: thumbIcon("plus.png"), click: send("like") },
    { tooltip: "Previous", icon: thumbIcon("prev.png"), click: send("prev") },
    {
      tooltip: thumbarPlaying ? "Pause" : "Play",
      icon: thumbIcon(thumbarPlaying ? "pause.png" : "play.png"),
      click: send("toggle"),
    },
    { tooltip: "Next", icon: thumbIcon("next.png"), click: send("next") },
  ])
}

// ---- window bounds persistence ----
const boundsFile = () => path.join(app.getPath("userData"), "window-bounds.json")
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"))
    if (
      Number.isInteger(b.width) && Number.isInteger(b.height) &&
      b.width >= 940 && b.height >= 620
    ) {
      return {
        width: Math.min(b.width, 3840),
        height: Math.min(b.height, 2160),
        x: Number.isInteger(b.x) ? b.x : undefined,
        y: Number.isInteger(b.y) ? b.y : undefined,
        maximized: b.maximized === true,
      }
    }
  } catch {
    /* first run / corrupt — defaults */
  }
  return { width: 1280, height: 820 }
}
function saveBounds(win) {
  try {
    const b = win.getNormalBounds()
    fs.writeFileSync(
      boundsFile(),
      JSON.stringify({ ...b, maximized: win.isMaximized() })
    )
  } catch {
    /* ignore */
  }
}

// Music apps legitimately need autoplay (next-track advance, queue).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")

// ---- lightweight file logging — support needs a real trail, not just
// console output nobody can read once the window is gone ----
const logsDir = () => path.join(app.getPath("userData"), "logs")
function logLine(level, msg) {
  try {
    fs.mkdirSync(logsDir(), { recursive: true })
    const f = path.join(logsDir(), "freebify.log")
    // cap at ~1MB — rotate by truncation, not unbounded growth
    if (fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024) {
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(-512 * 1024))
    }
    fs.appendFileSync(f, `${new Date().toISOString()} [${level}] ${String(msg).slice(0, 2000)}\n`)
  } catch {
    /* logging must never throw */
  }
}
process.on("uncaughtException", (e) => logLine("fatal", `uncaughtException: ${e?.stack ?? e}`))
process.on("unhandledRejection", (e) => logLine("error", `unhandledRejection: ${e?.stack ?? e}`))

// freebify:// deep links — registered in dev too so protocol testing works;
// the renderer navigates to the link's path
app.setAsDefaultProtocolClient?.("freebify")
function handleDeepLink(argv) {
  const link = argv.find((a) => typeof a === "string" && a.startsWith("freebify://"))
  if (!link) return
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send("app:deeplink", link.replace(/^freebify:\/\//, "/"))
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}
// macOS delivers via event instead of argv
app.on("open-url", (e, url) => {
  e.preventDefault()
  if (url?.startsWith("freebify://")) {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send("app:deeplink", url.replace(/^freebify:\/\//, "/"))
  }
})

// explicit quit — the X button hides to the tray (music keeps playing,
// like Spotify); only these paths actually end the app
let allowQuit = false
const quit = () => {
  allowQuit = true
  app.quit()
}
app.on("before-quit", () => {
  allowQuit = true
})
// cap renderer-crash respawns — a reproducible crash used to destroy→
// create→crash in an endless flicker loop
let crashRespawns = 0
let crashWindowStart = 0

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", (_e, argv) => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    handleDeepLink(argv)
  })

  app.whenReady().then(() => {
    app.setName("Freebify")
    logLine("info", `Freebify ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform})`)
    youtube.register(ipcMain)
    handleDeepLink(process.argv)

    // auto-update via electron-updater → GitHub Releases (publish config
    // in package.json). Errors are non-fatal — a 404 placeholder repo or
    // no network just means "no update this run". NSIS builds self-update;
    // portable builds can't (no installer) — latest.yml is still published
    // so portable users get a "new version" hint via the releases page.
    if (app.isPackaged && !process.argv.includes("--portable")) {
      try {
        const { autoUpdater } = require("electron-updater")
        autoUpdater.logger = { info: (m) => logLine("update", m), warn: (m) => logLine("update", m), error: (m) => logLine("update", m), debug: () => {} }
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = true
        autoUpdater.on("update-downloaded", (info) => {
          logLine("update", `downloaded ${info.version} — installs on quit`)
          const win = BrowserWindow.getAllWindows()[0]
          win?.webContents.send("app:update-ready", info.version)
        })
        autoUpdater.on("error", (e) => logLine("update", `check failed: ${e?.message ?? e}`))
        void autoUpdater.checkForUpdates().catch(() => {})
        setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000).unref()
      } catch (e) {
        logLine("update", `updater unavailable: ${e?.message ?? e}`)
      }
    }

    // production ships no application menu — the default one leaks
    // Ctrl+R reloads and devtools accelerators into the packaged app
    if (!isDev) {
      Menu.setApplicationMenu(null)
      // CSP via headers (a meta tag would also apply in dev and kill HMR):
      // self + https media/images/scripts the app legitimately needs —
      // YouTube iframe API, googlevideo/audius streams, remote artwork.
      const { session } = require("electron")
      const CSP = [
        "default-src 'self'",
        "script-src 'self' https://www.youtube.com https://s.ytimg.com",
        "style-src 'self' 'unsafe-inline'", // React inline styles
        "img-src 'self' https: data:",
        "media-src 'self' https:",
        "connect-src 'self' https:",
        "font-src 'self' data:",
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; ")
      session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
        // only OUR document — stamping this CSP onto YouTube's own embed
        // responses would replace their policy (and break on their changes)
        if (d.resourceType !== "mainFrame") return cb({})
        cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": [CSP] } })
      })
    }

    // frameless window controls — the renderer draws its own min/max/close
    ipcMain.on("win:control", (e, action) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return
      if (action === "minimize") win.minimize()
      else if (action === "maximize") (win.isMaximized() ? win.unmaximize() : win.maximize())
      else if (action === "close") win.close()
    })

    // renderer pushes player state → swap play/pause icon + tooltip text.
    // validate the payload — it crosses an IPC boundary
    ipcMain.on("player:thumbar", (_e, s) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || !s || typeof s !== "object") return
      thumbarPlaying = s.playing === true
      refreshThumbar(win)
      const title = typeof s.title === "string" ? s.title.slice(0, 200) : ""
      const artist = typeof s.artist === "string" ? s.artist.slice(0, 200) : ""
      const tip = title ? `${title} — ${artist || "Freebify"}` : "Freebify"
      win.setThumbnailToolTip(tip)
      tray?.setToolTip(tip)
      // taskbar progress bar — green fill tracking the song, like Spotify's
      const p = typeof s.progress === "number" && Number.isFinite(s.progress) ? s.progress : -1
      win.setProgressBar(p >= 0 && p <= 1 ? p : -1)
    })

    // app info + diagnostics for the Settings page
    ipcMain.handle("app:info", () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      platform: process.platform,
    }))
    ipcMain.on("app:openLogs", () => {
      try {
        fs.mkdirSync(logsDir(), { recursive: true })
        void shell.openPath(logsDir())
      } catch {
        /* ignore */
      }
    })
    ipcMain.on("app:log", (_e, msg) => logLine("renderer", msg))

    createTray()
    createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// only these schemes may leave the app — a javascript:/data:/file: URL
// reaching openExternal would be a real problem
const SAFE_EXTERNAL = /^https?:\/\//i

function createWindow() {
  const bounds = loadBounds()
  // restored x/y may live on a monitor that's no longer attached — if no
  // display's work area overlaps the rect, let the OS center it instead
  if (bounds.x !== undefined && bounds.y !== undefined) {
    const visible = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return (
        bounds.x < wa.x + wa.width &&
        bounds.x + bounds.width > wa.x &&
        bounds.y < wa.y + wa.height &&
        bounds.y + bounds.height > wa.y
      )
    })
    if (!visible) {
      bounds.x = undefined
      bounds.y = undefined
    }
  }
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0a0a0a",
    // frameless — the app draws its own window chrome (drag strip +
    // min/max/close) like Spotify does
    frame: false,
    autoHideMenuBar: true,
    title: "Freebify",
    icon: path.join(__dirname, "icon.png"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // the preload only uses ipcRenderer — no need for an unsandboxed
      // renderer process at all
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  })

  if (bounds.maximized) win.maximize()
  // first paint only when ready — avoids the white flash on cold start
  win.once("ready-to-show", () => {
    win.show()
    refreshThumbar(win)
  })
  win.on("show", () => refreshThumbar(win))
  // frameless renderer needs to swap its restore/maximize glyph. A launch-
  // time maximize() fires before the page loads, so push the real state
  // once the document is up (the message above would be dropped silently)
  win.on("maximize", () => win.webContents.send("win:maximized", true))
  win.on("unmaximize", () => win.webContents.send("win:maximized", false))
  win.webContents.on("did-finish-load", () =>
    win.webContents.send("win:maximized", win.isMaximized())
  )
  win.on("close", (e) => {
    saveBounds(win)
    // X hides to the tray — music apps keep playing in the background;
    // Quit lives on the tray menu (allowQuit) so the app exits cleanly
    if (!allowQuit && !isDev) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (SAFE_EXTERNAL.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  // no in-app navigation away from our document — YouTube embeds run in
  // their own child frame, so the main frame should never navigate. Exact
  // match only: any file:// URL would get the preload + bridge attached.
  const appUrl = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href
  win.webContents.on("will-navigate", (e, url) => {
    const allowed = isDev ? url === DEV_URL || url.startsWith(DEV_URL + "/") : url === appUrl
    if (!allowed) e.preventDefault()
  })

  // deny every permission prompt by default — a music app needs none of
  // them except clipboard write (the Copy-link features use it)
  const allowedPerm = (perm) => perm === "clipboard-sanitized-write"
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(allowedPerm(perm)))
  win.webContents.session.setPermissionCheckHandler((_wc, perm) => allowedPerm(perm))

  // a crashed renderer shouldn't leave a dead window — relaunch it, but
  // cap respawns: a reproducible crash used to flicker-destroy forever
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[freebify] renderer gone:", details.reason)
    logLine("fatal", `renderer gone: ${details.reason}`)
    if (!win.isDestroyed()) {
      const now = Date.now()
      if (now - crashWindowStart > 60000) {
        crashWindowStart = now
        crashRespawns = 0
      }
      if (++crashRespawns > 3) {
        logLine("fatal", "renderer crashed 3x in 60s — giving up")
        quit()
        return
      }
      win.destroy()
      createWindow()
    }
  })

  refreshThumbar(win) // defers until show if the window isn't visible yet

  if (isDev) {
    win.loadURL(DEV_URL).catch(() => {})
    // vite may still be starting when electron launches — retry once
    win.webContents.on("did-fail-load", () => {
      setTimeout(() => win.loadURL(DEV_URL).catch(() => {}), 800)
    })
  } else {
    // production needs the same resilience: a failed loadFile (corrupt
    // asar, AV quarantine) used to leave a permanently INVISIBLE window —
    // show:false until ready-to-show which never fires. Retry twice, then
    // show the window anyway so the user sees SOMETHING (even an error).
    let loadAttempts = 0
    const loadApp = () => {
      loadAttempts++
      win.loadFile(path.join(__dirname, "..", "dist", "index.html")).catch((e) => {
        logLine("error", `loadFile failed (${loadAttempts}): ${e?.message ?? e}`)
        if (loadAttempts < 3) setTimeout(loadApp, 800)
        else win.show() // dead page is better than a ghost process
      })
    }
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      logLine("error", `did-fail-load ${code} ${desc} (attempt ${loadAttempts})`)
      if (loadAttempts < 3) setTimeout(loadApp, 800)
      else win.show()
    })
    loadApp()
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
