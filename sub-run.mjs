// Test-only shim: this IP is currently 429-blocked on youtube.com/api/timedtext
// (the caption body endpoint — LRCLIB and -J work fine). Route ONLY timedtext
// fetches through the r.jina.ai reader proxy; everything else goes direct.
// Usage: node sub-run.mjs lyrics-matrix-sub.json
const origFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  if (!/youtube\.com\/api\/timedtext/.test(url)) return origFetch(input, init)
  const direct = await origFetch(input, init).catch(() => null)
  if (direct && direct.status !== 429) return direct
  const res = await origFetch("https://r.jina.ai/" + url, { signal: AbortSignal.timeout(90000) })
  const txt = await res.text()
  const i = txt.indexOf("Markdown Content:")
  const body = i >= 0 ? txt.slice(i + "Markdown Content:".length).replace(/^\s+/, "") : txt
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
}
await import("./lyrics-harness.mjs")
