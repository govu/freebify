// Screenshot driver — runs the REAL app (electron/main.cjs) in an isolated
// profile, navigates each view, and captures at 2x raster density.
// Usage: electron shot-main.cjs   (vite dev must be running on :5173)
const { app, BrowserWindow } = require("electron")
const { mkdirSync, writeFileSync } = require("fs")

app.commandLine.appendSwitch("force-device-scale-factor", "2")

require("./electron/main.cjs")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win
  for (let i = 0; i < 80 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0]
    if (!win) await sleep(400)
  }
  if (!win) { console.error("no app window"); app.quit(); return }
  const wc = win.webContents

  if (wc.isLoading()) await new Promise((r) => wc.once("did-finish-load", r))
  await sleep(3000)

  win.setContentSize(1920, 1032)
  wc.setAudioMuted(true)
  await sleep(600)

  mkdirSync("shots-out", { recursive: true })
  const js = (code) => wc.executeJavaScript(code, true)
  const nav = (p) => js(`history.pushState({},"","${p}");dispatchEvent(new PopStateEvent("popstate"))`)
  const imgsReady = () => js(
    `[...document.images].filter(i=>i.complete&&i.naturalWidth>2).length + "/" + document.images.length`)
  const shot = async (name) => {
    const img = await wc.capturePage()
    writeFileSync(`shots-out/${name}.png`, img.toPNG())
    console.log("shot:", name, JSON.stringify(img.getSize()))
  }
  /* wait until the image count is stable-ish (no placeholders) */
  const waitImgs = async (minLoaded, timeout = 14000) => {
    const t0 = Date.now()
    let last = "0/0"
    while (Date.now() - t0 < timeout) {
      const s = await imgsReady()
      const [ok, all] = s.split("/").map(Number)
      last = s
      if (ok >= minLoaded && ok === all) break
      if (ok >= minLoaded && Date.now() - t0 > timeout * 0.6) break
      await sleep(700)
    }
    return last
  }
  const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7)
  const has = (n) => !ONLY || ONLY.split(",").includes(n)
  const ARTIST_Q = "bad bunny"
  const TRACK_Q = "titi me pregunto bad bunny"

  try {
    /* ---------- HOME ---------- */
  if (has("home")) {
    await nav("/")
    console.log("home imgs:", await waitImgs(40))
    await shot("home")
  }

  if (has("artist")) {
    /* ---------- ARTIST (real yt page) ---------- */
    const artistId = await js(`(async () => {
      const r = await window.freebify.yt.search("${ARTIST_Q}")
      return r.artists?.[0]?.id ?? null
    })()`)
    console.log("artist id:", artistId)
    if (artistId) {
      await nav(`/artist/${artistId}`)
      console.log("artist imgs:", await waitImgs(30))
      await shot("artist")
    }
  }

  if (has("search")) {
    /* ---------- SEARCH ---------- */
    await nav("/search")
    await sleep(800)
    await js(`(() => {
      const i = document.querySelector("input")
      if (!i) return "no input"
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
      setter.call(i, "${ARTIST_Q}")
      i.dispatchEvent(new Event("input", { bubbles: true }))
      return "typed"
    })()`)
    console.log("search imgs:", await waitImgs(30, 16000))
    await shot("search")
  }

  if (has("nowplaying")) {
    /* ---------- NOW PLAYING (real track + lyrics) ---------- */
    const played = await js(`(async () => {
      const r = await window.freebify.yt.search("${TRACK_Q}")
      const t = r.tracks?.[0]
      if (!t) return "no track"
      window.__player.getState().playTrack(t)
      return t.title
    })()`)
    console.log("playing:", played)
    await sleep(5000)                       // stream resolve + playback start
    await js(`window.__player.getState().seek(95)`)
    await js(`window.__player.getState().setNpOpen(true)`)
    await sleep(1500)                       // overlay animates in
    const lyrOn = await js(`(() => {
      const b = document.querySelector("button:has(.lucide-mic-vocal)")
      b?.click(); return b ? "clicked" : "missing"
    })()`)
    console.log("lyrics toggle:", lyrOn)
    await sleep(10000)                      // lyrics fetch + offset align
    const lyrState = await js(`(() => {
      const b = document.querySelector("button:has(.lucide-mic-vocal)")
      const lines = document.querySelectorAll("[title*='jump'], [title*='sync']").length
      return "pressed=" + b?.getAttribute("aria-pressed") + " lines=" + lines
    })()`)
    console.log("lyrics state:", lyrState)
    await shot("nowplaying")
  }
  } catch (e) {
    console.error("shot error:", e?.message ?? e)
  }
  app.quit()
})
