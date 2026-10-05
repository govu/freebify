const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("freebify", {
  yt: {
    available: () => ipcRenderer.invoke("yt:available"),
    search: (q) => ipcRenderer.invoke("yt:search", q),
    stream: (videoId) => ipcRenderer.invoke("yt:stream", videoId),
    prefetch: (videoId) => ipcRenderer.invoke("yt:prefetch", videoId),
    invalidate: (videoId) => ipcRenderer.invoke("yt:invalidate", videoId),
    artist: (id, nameHint) => ipcRenderer.invoke("yt:artist", id, nameHint),
    album: (id) => ipcRenderer.invoke("yt:album", id),
    playlist: (id) => ipcRenderer.invoke("yt:playlist", id),
    playlists: () => ipcRenderer.invoke("yt:playlists"),
    upNext: (videoId) => ipcRenderer.invoke("yt:upnext", videoId),
    trending: () => ipcRenderer.invoke("yt:trending"),
    charts: () => ipcRenderer.invoke("yt:charts"),
    newReleases: () => ipcRenderer.invoke("yt:newreleases"),
    moods: () => ipcRenderer.invoke("yt:moods"),
    mood: (params) => ipcRenderer.invoke("yt:mood", params),
    playlistArts: (id) => ipcRenderer.invoke("yt:playlistarts", id),
    lyrics: (videoId) => ipcRenderer.invoke("yt:lyrics", videoId),
    captions: (videoId) => ipcRenderer.invoke("yt:captions", videoId),
    timedLyrics: (videoId) => ipcRenderer.invoke("yt:timedlyrics", videoId),
    videoSearch: (q) => ipcRenderer.invoke("yt:videosearch", q),
    ytsearch: (q, n) => ipcRenderer.invoke("yt:ytsearch", q, n),
    spotifyList: (id) => ipcRenderer.invoke("yt:spotifylist", id),
    suggest: (q) => ipcRenderer.invoke("yt:suggest", q),
  },
  dl: {
    // downloaded files live in userData/downloads — the renderer plays
    // them back through the fbx://dl/<file> scheme
    list: () => ipcRenderer.invoke("dl:list"),
    exists: (id) => ipcRenderer.invoke("dl:exists", id),
    start: (payload) => ipcRenderer.invoke("dl:start", payload),
    remove: (id) => ipcRenderer.invoke("dl:remove", id),
    openDir: () => ipcRenderer.send("dl:opendir"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev)
      ipcRenderer.on("dl:event", h)
      return () => ipcRenderer.removeListener("dl:event", h)
    },
  },
  player: {
    // renderer → main: player state for the taskbar thumbnail toolbar
    thumbar: (s) => ipcRenderer.send("player:thumbar", s),
    // main → renderer: thumbnail toolbar button clicks
    onCommand: (cb) => {
      const h = (_e, c) => cb(c)
      ipcRenderer.on("player:cmd", h)
      return () => ipcRenderer.removeListener("player:cmd", h)
    },
    // Discord Rich Presence — now-playing card on the user's profile
    presence: (s) => ipcRenderer.send("player:presence", s),
    presenceEnabled: (v) => ipcRenderer.send("player:presence-enabled", v),
  },
  win: {
    // frameless window chrome drawn by the renderer
    control: (action) => ipcRenderer.send("win:control", action),
    onMaximized: (cb) => {
      const h = (_e, v) => cb(v)
      ipcRenderer.on("win:maximized", h)
      return () => ipcRenderer.removeListener("win:maximized", h)
    },
  },
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    openLogs: () => ipcRenderer.send("app:openLogs"),
    log: (msg) => ipcRenderer.send("app:log", String(msg).slice(0, 500)),
    onDeepLink: (cb) => {
      const h = (_e, p) => cb(p)
      ipcRenderer.on("app:deeplink", h)
      return () => ipcRenderer.removeListener("app:deeplink", h)
    },
    onUpdateReady: (cb) => {
      const h = (_e, v) => cb(v)
      ipcRenderer.on("app:update-ready", h)
      return () => ipcRenderer.removeListener("app:update-ready", h)
    },
    installUpdate: () => ipcRenderer.invoke("app:install-update"),
    updateStatus: () => ipcRenderer.invoke("app:update-status"),
    checkUpdate: () => ipcRenderer.invoke("app:check-update"),
  },
})
