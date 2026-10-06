// Offline matrix: runs the REAL alignment functions (extracted+compiled to
// lyrics-pure.mjs by extract.mjs) against real data — LRCLIB sheets and
// yt-dlp captions. Ground truth = each lyric line's best caption anchor.
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
const F = await import("./lyrics-pure.mjs")

async function getCaps(vid, dur) {
  let j = null
  for (let a = 0; a < 3 && !j; a++) {
    try { j = JSON.parse(execFileSync("bin/yt-dlp.exe", ["-J", "--skip-download", `https://www.youtube.com/watch?v=${vid}`], { encoding: "utf8", timeout: 90000, maxBuffer: 64 << 20 })) }
    catch { await new Promise((r) => setTimeout(r, 4000)) }
  }
  if (!j) return null
  const subs = j.subtitles ?? {}, autos = j.automatic_captions ?? {}
  const pick = (dict) => {
    const keys = Object.keys(dict).filter((k) => Array.isArray(dict[k]) && dict[k].length && !k.startsWith("live_chat"))
    if (!keys.length) return null
    const orig = keys.filter((k) => k.endsWith("-orig"))
    const ks = orig.length ? orig : keys
    for (const k of ks) {
      const f = dict[k].find((x) => x.ext === "json3") ?? dict[k].find((x) => x.ext === "vtt")
      if (f) return { f, lang: k }
    }
    return null
  }
  const sub = pick(subs), asr = pick(autos)
  const origLang = Object.keys(autos).find((k) => k.endsWith("-orig"))?.replace(/-orig$/, "")
  const fmt = sub && asr && origLang && !sub.lang.startsWith(origLang) ? asr : sub ?? asr
  if (!fmt) return null
  let txt = null
  for (let a = 0; a < 3 && !txt; a++) {
    try {
      const r = await fetch(fmt.f.url)
      const t = await r.text()
      if (t.trim().startsWith("{") || t.includes("-->")) txt = t
    } catch { /* retry */ }
    if (!txt) await new Promise((r) => setTimeout(r, 3000))
  }
  if (!txt) return null
  let evs = []
  if (fmt.f.ext === "json3") {
    const b = JSON.parse(txt)
    // mirror production captionLines: rolling-context rows are dropped,
    // stacked multi-row cues keep all their text
    for (const e of b.events ?? []) {
      if (typeof e.tStartMs !== "number" || !e.segs) continue
      const rows = e.segs.map((s) => s.utf8 ?? "").join("").split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
      if (!rows.length) continue
      if (e.aAppend && evs.length) { evs.at(-1).text = F.capText(`${evs.at(-1).text} ${rows.at(-1)}`); continue }
      const t = e.tStartMs / 1000
      if (rows.length > 1 && evs.length && evs.at(-1).text === rows.at(-2)) evs.push({ t, text: F.capText(rows.at(-1)) })
      else evs.push({ t, text: F.capText(rows.join(" ")) })
    }
    evs = evs.filter((c) => c.text)
  } else {
    // minimal vtt cue parse
    const re = /(\d+):(\d+):(\d+\.\d+)\s*-->/g
    let m
    const parts = txt.split(/\r?\n/)
    let i = 0
    while (i < parts.length) {
      const tm = /^(\d+):(\d+):(\d+\.\d+)\s*-->/.exec(parts[i])
      if (tm) {
        const t = +tm[1] * 3600 + +tm[2] * 60 + +tm[3]
        const text = F.capText(parts[i + 1] ?? "")
        if (text) evs.push({ t, text })
        i += 2
      } else i++
    }
  }
  const clipped = evs.filter((l) => l.t <= (dur ?? 9999) + 15).sort((a, b) => a.t - b.t)
  return { lines: clipped, lang: fmt.lang }
}

async function getSheet(artist, title, dur) {
  let lr = null
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://lrclib.net/api/search?" + new URLSearchParams({ track_name: title, artist_name: artist }))
      if (r.ok) { lr = await r.json(); break }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000 + a * 2000))
  }
  if (!Array.isArray(lr)) return null
  const recs = lr.filter((r) => r.syncedLyrics?.trim())
  if (!recs.length) return null
  const rec = recs.sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur))[0]
  const lines = rec.syncedLyrics.split("\n").map((l) => { const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/); return m ? { t: +m[1] * 60 + +m[2], text: m[3].trim() } : null }).filter(Boolean).filter((l) => l.text)
  return { lines, rec }
}

// honest eval: a placed line is RIGHT if a similar caption exists within
// ±3s of where it was placed (any occurrence of a repeated line is a valid
// landing); UNCOVERED when no caption exists near it at all; WRONG when a
// different-text cue sits at its spot
function evalAligned(aligned, caps) {
  const pool = caps.map((c) => ({ t: c.t, w: new Set(F.simTokens(c.text)), bi: F.simBigrams(c.text) }))
  let right = 0, wrong = 0, uncovered = 0
  const wrongList = []
  for (const l of aligned) {
    const w = new Set(F.simTokens(l.text)), bi = F.simBigrams(l.text)
    if (w.size < 3) continue
    let nearSim = 0, anyNear = false
    for (const c of pool) {
      if (Math.abs(c.t - l.t) > 3) continue
      anyNear = true
      const s = F.lineSim(w, bi, c.w, c.bi)
      if (s > nearSim) nearSim = s
    }
    if (nearSim >= 0.45) right++
    else if (anyNear) { wrong++; wrongList.push(l.t.toFixed(0) + ":" + l.text.slice(0, 25)) }
    else uncovered++
  }
  return { right, wrong, uncovered, wrongList: wrongList.slice(0, 5) }
}

const matrix = JSON.parse(readFileSync(process.argv.find((a) => a.endsWith(".json")) ?? "lyrics-matrix.json", "utf8"))
for (const m of matrix) {
  const out = { song: `${m.artist} — ${m.title}` }
  try {
    const cap = await getCaps(m.vid, m.dur)
    const sheet = await getSheet(m.artist, m.title, m.dur)
    if (!sheet) { console.log(JSON.stringify({ ...out, err: "no sheet" })); continue }
    const lrc = sheet.lines
    out.sheetN = lrc.length
    out.sheetFirst = +lrc[0].t.toFixed(1)
    out.caps = cap ? cap.lines.length : 0
    out.capLang = cap?.lang
    const selfEst = lrc.at(-1).t + 12
    const estRecDur = sheet.rec.duration && Math.abs(sheet.rec.duration - selfEst) <= 25 ? Math.max(sheet.rec.duration, selfEst) : selfEst
    out.fb = +Math.max(-45, Math.min(m.dur - selfEst - 5, m.dur - estRecDur)).toFixed(1)
    if (!cap) { console.log(JSON.stringify({ ...out, verdict: "no-own-captions" })); continue }
    const off = F.alignOffset(lrc, cap.lines)
    out.measured = off
    if (off == null) { console.log(JSON.stringify({ ...out, verdict: "no-quorum" })); continue }
    out.timingOk = F.timingOk(lrc, cap.lines, off)
    const aligned = F.alignLines(lrc, cap.lines, off)
    if (aligned) {
      out.eval = evalAligned(aligned, cap.lines)
      out.verdict = "aligned"
    } else out.verdict = out.timingOk ? "offset-only" : "rejected"
    console.log(JSON.stringify(out))
  } catch (e) {
    console.log(JSON.stringify({ ...out, err: String(e?.message ?? e).slice(0, 140) }))
  }
}
