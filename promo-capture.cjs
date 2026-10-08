const { app, BrowserWindow } = require("electron")
const { mkdirSync, writeFileSync } = require("fs")

const FPS = 60
const TOTAL = 17.8
const OUT = "promo-frames"

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1920, height: 1080, show: false,
    webPreferences: { offscreen: true, nodeIntegration: false },
  })
  win.webContents.on("console-message", (_e, _l, m) => console.log("[page]", m))
  await win.loadFile("promo.html")
  await new Promise(r => setTimeout(r, 1200)) // fonts + gsap settle
  mkdirSync(OUT, { recursive: true })
  const frames = Math.ceil(TOTAL * FPS)
  const t0 = Date.now()
  for (let i = 0; i < frames; i++) {
    const t = i / FPS
    await win.webContents.executeJavaScript(`__seek(${t})`)
    const img = await win.webContents.capturePage()
    writeFileSync(`${OUT}/f${String(i).padStart(4, "0")}.png`, img.toPNG())
    if (i % 60 === 0) console.log(`frame ${i}/${frames}`)
  }
  console.log(`done ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  app.quit()
})
