# Freebify

A free, ad-free music streaming desktop app — a Spotify-style experience
powered by the YouTube Music catalog, with the Audius open catalog as a
built-in fallback so playback never dead-ends.

![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey)
![Stack](https://img.shields.io/badge/stack-Electron%20%C2%B7%20React%2019%20%C2%B7%20TypeScript%20%C2%B7%20Tailwind%20v4-lightgrey)

**[Download & website → govu.github.io/freebify](https://govu.github.io/freebify/)**

## Features

- **Full official catalog** — search YouTube Music for original studio
  recordings, artists, albums and editorial playlists (no remixes/edits
  cluttering results; non-original Audius content is filtered too)
- **Zero ads** — audio plays through extracted pure-audio streams when
  available; a hidden YouTube IFrame player races it for instant start
- **Autoplay radio** — when your queue runs out, related tracks from the
  current song keep the music going (like Spotify's autoplay)
- **Playlists** — create, rename, delete; add tracks from any ⋯ menu;
  collage covers; save remote playlists/albums to your library
- **Library** — liked songs and recently played, persisted locally
- **Artist pages** — verified artists with monthly-listener counts, top
  songs and play counts
- **Windows integration** — taskbar thumbnail toolbar (hover the app icon:
  save / previous / play-pause / next), media-session hotkeys, SMTC overlay
- **Instant feel** — stream URLs are resolved on hover and prefetched for
  top results and the next queue track; playback usually starts in <1s
- **Neutral dark UI** — strictly blacks/grays with a white accent, smooth
  motion, animated equalizer, Now Playing overlay

## How playback works

1. **Metadata** — `youtubei.js` (Innertube) in the Electron main process:
   search, artist, album, playlist, trending, and "up next" radio.
2. **Audio** — bundled `yt-dlp` resolves signed googlevideo audio URLs
   (cached ~5h, deduplicated in-flight requests).
3. **Race** — for each track, pure-audio extraction and the hidden IFrame
   player start in parallel. The first to actually play wins; if the clean
   audio URL wins, the iframe is stopped before producing sound — so the
   ad-free path is preferred whenever it works.
4. **Fallbacks** — iframe errors/extraction failures retry in place, then
   skip (a circuit breaker stops the queue instead of burning through it),
   and Audius covers anything YouTube can't serve.

## Development

```bash
npm install          # requires Node 20+
npm run dev          # Vite dev server (browser preview, Audius only)
npm run dev:electron # full app: Vite + Electron against the dev server
```

## Packaging

```bash
npm run build                # typecheck + bundle to dist/
npm run dist                 # Windows: portable exe + NSIS installer → release/
```

**Windows + macOS + Linux builds are produced by CI**: pushing a `v*` tag runs
`.github/workflows/release.yml`, which builds on `windows-latest`,
`macos-latest` (dmg + zip for x64 **and** arm64) and `ubuntu-latest`
(AppImage + deb) and uploads every artifact plus the `latest*.yml` update
manifests into the matching GitHub Release.

> **macOS caveat:** the app is unsigned (no Apple Developer cert). First
> launch: right-click the app → **Open**, or `xattr -dr com.apple.quarantine
> /Applications/Freebify.app` (also clears quarantine on the bundled yt-dlp
> binary). Auto-update doesn't apply unsigned mac builds — grab the new dmg.

> **Note on `yt-dlp`:** the binary lives in `bin/yt-dlp.exe` and ships as an
> extra resource. It self-updates (`yt-dlp -U`) 15s after launch because
> YouTube changes frequently — keep it updated when releasing.

## Legal

**Freebify is a media player, not a music service.** It hosts, stores,
uploads and sells nothing — every byte of audio and metadata is fetched
by the user's own device, directly from the third-party platforms that
serve it (YouTube Music / the Audius public API), under those platforms'
own terms. The software itself contains no copyrighted material and has
substantial lawful uses; responsibility for complying with each platform's
terms and local law rests with the person running it. Not affiliated with
or endorsed by Spotify, YouTube, Google, Audius, or any rights holder.
Free, open-source (GPL-3.0), non-commercial, no accounts, no tracking —
for personal use.

- [DISCLAIMER.md](DISCLAIMER.md) — full legal disclaimer, why & how
- [TERMS.md](TERMS.md) — terms of use (no warranty, liability limits)
- [PRIVACY.md](PRIVACY.md) — privacy policy (spoiler: collects nothing)
- [LICENSE](LICENSE) — GNU GPL v3.0
