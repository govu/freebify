// Bakes the current package.json version into docs/index.html as the static
// fallback — if the GitHub API rate-limits a visitor, the page still shows a
// real version instead of "v?". Runs automatically before `npm run dist`.
import { readFileSync, writeFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync("package.json", "utf8"))
const html = readFileSync("docs/index.html", "utf8")
const out = html
  .replace(/id="dlBtn"([^>]*)>[^<]*</, `id="dlBtn"$1>Download Freebify ${version}<`)
  .replace(/<b id="verMeta"[^>]*> · v[^<]*<\/b>/, `<b id="verMeta"> · v${version}</b>`)
if (out !== html) writeFileSync("docs/index.html", out)
console.log(`site fallback version → ${version}`)
