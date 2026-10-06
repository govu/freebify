// Lyrics accuracy matrix: plays each track in the live app, samples the lit
// line vs audio clock, then scores each transition against the video's OWN
// caption ground truth (fuzzy-matched). Error = litTime - realTime, per line.
import { execFileSync } from "node:child_process"
import fs from "node:fs"

const LOG = "C:/Users/Administrator/AppData/Roaming/freebify/logs/freebify.log"
const CDP = "http://localhost:9333"
const targets = await (await fetch(`${CDP}/json`)).json()
const page = targets.find((t) => t.type === "page")
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const ev = (e) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: e, awaitPromise: true, returnByValue: true } })) })
const V = (r) => r?.result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// same tokenizers as NowPlaying
const simTokens = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter((x) => x.length > 1)
const lineSim = (a, b) => {
  const wa = new Set(simTokens(a)), wb = new Set(simTokens(b))
  if (!wa.size || !wb.size) return 0
  let inter = 0; for (const w of wa) if (wb.has(w)) inter++
  return (2 * inter) / (wa.size + wb.size)
}
const capsOf = (vid) => {
  try {
    const j = JSON.parse(execFileSync("bin/yt-dlp.exe", ["-J", "--skip-download", `https://www.youtube.com/watch?v=${vid}`], { encoding: "utf8", timeout: 40000, maxBuffer: 64 << 20 }))
    const subs = j.subtitles ?? {}, autos = j.automatic_captions ?? {}
    const pick = (pool) => {
      const keys = Object.keys(pool).filter((k) => !/live_chat/.test(k))
      const en = keys.find((k) => /-orig$/.test(k)) ?? keys.find((k) => k === "en") ?? keys.find((k) => /^en/.test(k)) ?? keys[0]
      if (!en) return null
      const fmts = pool[en] ?? []
      const f = fmts.find((x) => x.ext === "json3") ?? fmts.find((x) => x.ext === "srv3") ?? fmts.find((x) => x.ext === "vtt")
      return f?.url ?? null
    }
    const url = pick(subs) ?? pick(autos)
    if (!url) return null
    const raw = execFileSync("bin/yt-dlp.exe", ["--skip-download", "--sub-format", "json3", "-o", "-", url], { encoding: "utf8", timeout: 30000, maxBuffer: 64 << 20 }).trim()
    // url direct download instead
    const txt = raw.startsWith("{") ? raw : null
    const body = txt ? JSON.parse(txt) : JSON.parse(execFileSync("curl", ["-s", url], { encoding: "utf8", timeout: 30000, maxBuffer: 64 << 20 }))
    const events = body.events ?? []
    const cues = []
    for (const ev of events) {
      if (!ev.segs) continue
      const text = ev.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").replace(/\[.*?\]|>>|♪/g, "").trim()
      if (!text || /^[a-z]+$/.test(text) === false && !/\p{L}{2,}/u.test(text)) continue
      if (text.length < 2) continue
      cues.push({ t: (ev.tStartMs ?? 0) / 1000, text })
    }
    return cues
  } catch (e) { return null }
}

const SONGS = JSON.parse(fs.readFileSync("lyrics-songs.json", "utf8"))
const results = []
for (const s of SONGS) {
  console.log(`\n=== ${s.artist} — ${s.title} (${s.vid}, ${s.dur}s) ===`)
  const logLen = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0
  await ev(`window.__player.getState().playTrack(${JSON.stringify(s.track)})`)
  await sleep(2500)
  await ev(`window.__player.getState().setNpOpen(true)`)
  await sleep(600)
  // ensure lyrics open (toggle only if panel lacks lines)
  const st = await ev(`(() => ({ n: document.querySelectorAll('[data-l]').length }))()`)
  if ((V(st)?.n ?? 0) === 0) await ev(`document.querySelector('[aria-label=Lyrics]')?.click()`)
  // wait for walk done (log grows with "walk done" or 70s timeout)
  const t0 = Date.now()
  let walkDone = false
  while (Date.now() - t0 < 75000) {
    await sleep(3000)
    const tail = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").slice(logLen) : ""
    if (/walk done|offset applied|aligned lines=/.test(tail)) { walkDone = true; break }
  }
  const tailLog = fs.readFileSync(LOG, "utf8").slice(logLen).split("\n").filter((l) => /lyrics:/.test(l))
  console.log(tailLog.map((l) => "  " + l.split("] ")[1]).join("\n"))
  // sample lit line for ~80s
  const samples = []
  for (let i = 0; i < 32; i++) {
    await sleep(2500)
    const r = await ev(`(() => {
      const p = window.__player.getState()
      const els = [...document.querySelectorAll('[data-l]')]
      const lit = els.findIndex(el => el.className.includes('scale-[1.04]'))
      return { t: +p.currentTime.toFixed(2), lit, txt: lit >= 0 ? els[lit].textContent.slice(0, 60) : null, n: els.length }
    })()`)
    const v = V(r); if (v?.t != null) samples.push(v)
  }
  // ground truth: this video's own captions
  const caps = capsOf(s.vid)
  let err = null
  if (caps?.length > 10) {
    const errs = []
    for (const smp of samples) {
      if (smp.lit < 0 || !smp.txt) continue
      let best = 0, bestT = null
      for (const c of caps) { const sim = lineSim(smp.txt, c.text); if (sim > best) { best = sim; bestT = c.t } }
      if (best >= 0.55 && bestT != null) errs.push(+(smp.t - bestT).toFixed(2))
    }
    errs.sort((a, b) => a - b)
    err = errs.length ? { n: errs.length, med: errs[Math.floor(errs.length / 2)], p90: errs[Math.floor(errs.length * 0.9)] } : null
  }
  const res = { song: `${s.artist} — ${s.title}`, vid: s.vid, walkDone, lines: samples[0]?.n ?? 0, samples: samples.length, litSamples: samples.filter((x) => x.lit >= 0).length, captionCues: caps?.length ?? 0, err }
  results.push(res)
  console.log("  RESULT:", JSON.stringify(res))
}
console.log("\n===== SUMMARY =====")
for (const r of results) console.log(JSON.stringify(r))
process.exit(0)
