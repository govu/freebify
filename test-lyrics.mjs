// CDP driver: plays Dai Dai on the REAL profile (bad pin included), opens
// the lyrics view, and samples which line is lit vs the audio clock.
const CDP = "http://localhost:9333"
const targets = await (await fetch(`${CDP}/json`)).json()
const page = targets.find((t) => t.type === "page")
if (!page) { console.log("no page target"); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const ev = async (expression) => {
  const i = ++id
  const m = await new Promise((r) => { pending.set(i, r); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })) })
  if (m.result?.exceptionDetails) return { err: m.result.exceptionDetails.exception?.description ?? "exc" }
  return m.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log("state:", JSON.stringify(await ev(`(() => { const s = window.__player?.getState?.(); return s ? { cur: s.current?.id, playing: s.isPlaying, np: s.npOpen } : null })()`)))

// queue the exact track object the user had playing (yt-fcnDmrtj6Sk, 241s)
await ev(`window.__player.getState().playTrack({ id: "yt-fcnDmrtj6Sk", source: "yt", streamId: "fcnDmrtj6Sk", title: "Dai Dai", duration: 241, play_count: 0, repost_count: 0, favorite_count: 0, genre: null, permalink: "https://music.youtube.com/watch?v=fcnDmrtj6Sk", artwork: { "150x150": "https://i.ytimg.com/vi/fcnDmrtj6Sk/hqdefault.jpg", "480x480": "https://i.ytimg.com/vi/fcnDmrtj6Sk/hqdefault.jpg" }, user: { id: "yt-UC", streamId: null, name: "Shakira", handle: "Shakira", is_verified: false, follower_count: 0 }, is_streamable: true })`)
await sleep(1500)
await ev(`window.__player.getState().setNpOpen(true)`)
await sleep(1200)
// open lyrics (mic button)
console.log("mic click:", await ev(`(() => { const b = document.querySelector('[aria-label="Lyrics"]'); if (b) { b.click(); return "clicked" } return "no button" })()`))

// sample every 4s for ~150s: audio clock vs lit line vs stored offsets
for (let i = 0; i < 38; i++) {
  await sleep(4000)
  const s = await ev(`(() => {
    const p = window.__player.getState()
    const act = document.querySelector('[data-l].text-ink, [data-l].scale-\\\\[1\\\\.04\\\\]')
    const lit = [...document.querySelectorAll("[data-l]")].findIndex(el => el.className.includes("scale-[1.04]"))
    const litText = lit >= 0 ? document.querySelectorAll("[data-l]")[lit].textContent.slice(0,50) : null
    const offs = Object.keys(localStorage).filter(k => k.startsWith("lrcoff")).map(k => k + "=" + localStorage.getItem(k))
    return { t: Math.round(p.currentTime * 10) / 10, playing: p.isPlaying, lit, litText, offs }
  })()`)
  console.log(`[${i}]`, JSON.stringify(s))
}
process.exit(0)
