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
    suggest: (q) => ipcRenderer.invoke("yt:suggest", q),
  },
  player: {
    // renderer → main: player state for the taskbar thumbnail toolbar
    thumbar: (s) => ipcRenderer.send("player:thumbar", s),
    // main → renderer: thumbnail toolbar button clicks
    onCommand: (cb) => ipcRenderer.on("player:cmd", (_e, c) => cb(c)),
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
  },
})
