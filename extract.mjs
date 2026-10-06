import { readFileSync, writeFileSync } from "node:fs"
const src = readFileSync("src/components/NowPlaying.tsx", "utf8")
// pure fns all live at column 0 — end boundary = next top-level `const`/`function`
const names = ["simTokens", "simBigrams", "dice", "lineSim", "capText", "alignOffset", "alignLines", "lrcContentOk", "timingOk"]
const got = []
for (const n of names) {
  const re = new RegExp(`^const ${n} = `, "m")
  const m = re.exec(src)
  if (!m) { console.log(`skip ${n}: not found`); continue }
  const rest = src.slice(m.index)
  const nxt = rest.slice(1).search(/^(const |function |let )/m)
  if (nxt < 0) { console.log(`skip ${n}: no end`); continue }
  got.push(rest.slice(0, nxt + 1).trimEnd())
}
const out = `export interface LrcLine { t: number; text: string }\n${got.join("\n")}\nexport { ${names.join(", ")} }\n`
writeFileSync("lyrics-pure.ts", out)
console.log("wrote", out.length, "chars;", got.length, "fns")
