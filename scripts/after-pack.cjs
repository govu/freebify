// afterPack — adhoc-sign the bundled yt-dlp on macOS. electron-builder signs
// the .app itself (identity:"-"), but files under Contents/Resources are
// hashed as *resources*, not signed as executables — an unsigned arm64
// Mach-O gets killed by the kernel on spawn, and YouTube playback would be
// silently dead. ensureExecutable() already de-quarantines it at runtime;
// this guarantees it also carries an adhoc signature.
const { execFileSync } = require("child_process")
const { existsSync, chmodSync } = require("fs")
const path = require("path")

exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") return
  const bin = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents", "Resources", "bin", "yt-dlp",
  )
  if (!existsSync(bin)) return
  chmodSync(bin, 0o755)
  try {
    execFileSync("codesign", ["--force", "--sign", "-", bin], { stdio: "pipe" })
  } catch {
    // codesign absent when cross-building — the binary ships its upstream
    // (already adhoc) signature; missing this is not fatal to the build
  }
}
