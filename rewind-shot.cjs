// Rewind e2e — seeds a finished month of stats, reloads, and captures the
// story slides as the auto-prompt fires. Usage: electron rewind-shot.cjs
// (vite dev must be running on :5173)
const { app, BrowserWindow } = require("electron")
const { mkdirSync, writeFileSync } = require("fs")

app.commandLine.appendSwitch("force-device-scale-factor", "1")
require("./electron/main.cjs")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// last month's key, local time — latestRewind() only fires for CLOSED months
const prev = new Date(); prev.setDate(1); prev.setMonth(prev.getMonth() - 1)
const MK = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`

const t = (id, vid, title, artist, plays, ms) => ({
  track: {
    id: `yt-${vid}`, streamId: vid, source: "yt", title, duration: 220,
    play_count: 0, repost_count: 0, favorite_count: 0,
    artwork: { "480x480": `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, fallback: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` },
    user: { id: `yt-${artist}`, streamId: "", handle: "", name: artist, is_verified: false, follower_count: 0, track_count: 0, profile_picture: null, cover_photo: null },
  },
  plays, ms,
})
const a = (name, vid, plays, ms) => ({ name, art: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, plays, ms })

const seed = {
  state: {
    tracks: {}, artists: {}, days: {},
    months: {
      [MK]: {
        ms: 9_450_000, plays: 214,
        tracks: {
          "yt-kJQP7kiw5Fk": t("kJQP7kiw5Fk", "kJQP7kiw5Fk", "Despacito", "Luis Fonsi", 41, 520_000),
          "yt-JGwWNGJdvx8": t("JGwWNGJdvx8", "JGwWNGJdvx8", "Shape of You", "Ed Sheeran", 33, 390_000),
          "yt-RgKAFK5djSk": t("RgKAFK5djSk", "RgKAFK5djSk", "See You Again", "Wiz Khalifa", 27, 310_000),
          "yt-OPf0YbXqDm0": t("OPf0YbXqDm0", "OPf0YbXqDm0", "Uptown Funk", "Mark Ronson", 19, 260_000),
          "yt-09R8_2nJtjg": t("09R8_2nJtjg", "09R8_2nJtjg", "Sugar", "Maroon 5", 15, 190_000),
        },
        artists: {
          "Luis Fonsi": a("Luis Fonsi", "kJQP7kiw5Fk", 74, 1_800_000),
          "Ed Sheeran": a("Ed Sheeran", "JGwWNGJdvx8", 61, 1_500_000),
          "Wiz Khalifa": a("Wiz Khalifa", "RgKAFK5djSk", 40, 980_000),
        },
      },
    },
    totalMs: 9_450_000, totalPlays: 214,
  },
  version: 2,
}

app.whenReady().then(async () => {
  let win
  for (let i = 0; i < 80 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0]
    if (!win) await sleep(400)
  }
  if (!win) { console.error("no app window"); app.quit(); return }
  const wc = win.webContents
  if (wc.isLoading()) await new Promise((r) => wc.once("did-finish-load", r))
  await sleep(2500)
  win.setContentSize(1440, 900)
  wc.setAudioMuted(true)
  wc.on("console-message", (_e, _l, msg) => { if (/error|warn/i.test(msg)) console.log("console:", msg.slice(0, 200)) })

  mkdirSync("shots-out", { recursive: true })
  const js = (code) => wc.executeJavaScript(code, true)
  const shot = async (name) => {
    const img = await wc.capturePage()
    writeFileSync(`shots-out/${name}.png`, img.toPNG())
    console.log("shot:", name, JSON.stringify(img.getSize()))
  }
  const key = (code) => js(`window.dispatchEvent(new KeyboardEvent("keydown",{code:"${code}"}))`)

  try {
    // seed a finished month through the store itself — a raw localStorage
    // write gets clobbered by the app's own beforeunload flush persist
    const seeded = await js(`(() => {
      window.__stats.setState(${JSON.stringify(seed.state)})
      return Object.keys(window.__stats.getState().months)
    })()`)
    console.log("seeded months:", JSON.stringify(seeded))
    await sleep(400) // let persist flush the write
    await js(`location.reload()`)
    await new Promise((r) => wc.once("did-finish-load", r))
    await sleep(2800)

    // home card visible?
    console.log("rewind card:", await js(`!![...document.querySelectorAll("button")].find(b=>/Rewind|so far/.test(b.textContent))`))

    await sleep(2200) // auto-prompt fires ~3.5s after mount
    console.log("overlay open:", await js(`!!document.querySelector('[role="dialog"]')`))
    await sleep(1200)
    await shot("rewind-1-intro")

    await key("ArrowRight"); await sleep(1500); await shot("rewind-2-minutes")
    await key("ArrowRight"); await sleep(1400); await shot("rewind-3-artist")
    await key("ArrowRight"); await sleep(1600); await shot("rewind-4-tracks")
    await key("ArrowRight"); await sleep(1500); await shot("rewind-5-outro")

    // esc closes back to the app
    await key("Escape"); await sleep(700)
    console.log("overlay closed:", await js(`!document.querySelector('[role="dialog"]')`))
    await sleep(1200)
    await shot("rewind-6-homecard")
  } catch (e) {
    console.error("rewind-shot error:", e?.message ?? e)
  }
  app.quit()
})
