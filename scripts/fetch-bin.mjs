// Downloads the yt-dlp.exe binary Freebify bundles for YouTube audio
// resolution. Run once after cloning: `npm run fetch-bin`
import { createWriteStream, mkdirSync, existsSync } from "node:fs"
import { get } from "node:https"

const URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
const DEST = new URL("../bin/yt-dlp.exe", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

if (existsSync(DEST)) {
  console.log("[fetch-bin] bin/yt-dlp.exe already exists — skipping")
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

console.log("[fetch-bin] downloading yt-dlp.exe …")
await download(URL)
console.log(`[fetch-bin] saved to ${DEST}`)
