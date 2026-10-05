// Downloads the yt-dlp binary Freebify bundles for YouTube audio
// resolution. Run once after cloning: `npm run fetch-bin`
// Windows → yt-dlp.exe · macOS/Linux → yt-dlp (unix binary, chmod +x)
import { createWriteStream, mkdirSync, existsSync, chmodSync } from "node:fs"
import { get } from "node:https"

const isWin = process.platform === "win32"
const NAME = isWin ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp"
const BIN_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${NAME}`
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
