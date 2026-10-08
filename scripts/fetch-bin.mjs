// Downloads the yt-dlp binary Freebify bundles for YouTube audio
// resolution. Run once after cloning: `npm run fetch-bin`
// Windows → yt-dlp.exe · macOS/Linux → yt-dlp (unix binary, chmod +x)
import { createWriteStream, mkdirSync, existsSync, chmodSync } from "node:fs"
import { get } from "node:https"

// Pinned on purpose: `latest` means an upstream release that broke
// extraction would land in every new build at once. Bump this after
// testing — the app still self-updates the binary at runtime (yt-dlp -U).
const YT_DLP_VERSION = "2026.08.19"
const isWin = process.platform === "win32"
const NAME = isWin ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp"
const BIN_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${NAME}`
const DEST = new URL(`../bin/${isWin ? "yt-dlp.exe" : "yt-dlp"}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

if (existsSync(DEST)) {
  console.log(`[fetch-bin] ${DEST} already exists — skipping`)
  process.exit(0)
}

mkdirSync(new URL("../bin", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { recursive: true })

const download = (url, redirects = 5) =>
  new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0)
        return resolve(download(res.headers.location, redirects - 1))
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
      const file = createWriteStream(DEST)
      res.pipe(file)
      file.on("finish", () => file.close(resolve))
      file.on("error", reject)
    }).on("error", reject)
  })

console.log(`[fetch-bin] downloading ${NAME} …`)
await download(BIN_URL)
if (!isWin) chmodSync(DEST, 0o755)
console.log(`[fetch-bin] saved to ${DEST}`)
