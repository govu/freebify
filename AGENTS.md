# Freebify

Free, ad-free music streaming app (Spotify-style). Dual catalog: **YouTube Music** (original studio versions) via Electron main + **Audius** open catalog as universal fallback.

## Commands

- `npm run dev` — dev server (Vite, port 5173)
- `npm run build` — typecheck + production build to `dist/`
- `npm run lint` — oxlint
- `npm run dist` — build + package portable exe AND NSIS installer → `C:\Users\Administrator\freebify-release\` (installer = fast launches; portable re-extracts ~120MB each run)

## Stack

Vite 8 + React 19 + TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`, theme tokens in `src/index.css`), Motion (`motion/react`) for animation, Zustand (persist middleware → localStorage), React Router v7, lucide-react icons, Inter Variable font.

## Data layer — Audius REST API (`src/api/audius.ts`)

- Base hosts come from `GET https://api.audius.co` (returns `{data: [hosts]}`); client rotates hosts on failure.
- Every request needs `?app_name=Freebify`.
- Endpoints used: `/v1/tracks/trending` (params: `genre`, `time`=week|month|allTime), `/v1/tracks/search`, `/v1/users/search`, `/v1/playlists/search`, `/v1/playlists/trending`, `/v1/playlists/{id}`, `/v1/playlists/{id}/tracks`, `/v1/users/{id}`, `/v1/users/{id}/tracks`.
- Streaming: `{host}/v1/tracks/{id}/stream` → 302 to signed content-node URL; used directly as `<audio>.src`.
- Gotchas: genre strings are case-sensitive (`Drum & Bass`, `Hip-Hop/Rap` — URL-encoded by URLSearchParams); IDs are opaque hashids; `playlist_name` not `title`; `artwork` keys are `"150x150"/"480x480"/"1000x1000"` + `mirrors` array (ArtworkImg retries through mirrors on error); check `is_streamable`/`is_stream_gated` before queueing.

## YouTube layer (`electron/youtube.cjs` + `src/api/youtube.ts` + `src/api/ytplayer.ts`)

- **Metadata** (search/artist/album/trending): `youtubei.js` (Innertube) in the **main process**, exposed via `window.freebify.yt` (preload `electron/preload.cjs`). yt track ids are `yt-{videoId}`, artists `yt-{channelId}`, albums `ytalb-{browseId}`, editorial playlists `ytpl-{browseId}` (VL-prefixed ids are stripped/retried in `playlist()`).
- **Radio/autoplay**: `yt.music.getUpNext(videoId)` → `PlaylistPanel` (items are `PlaylistPanelVideo` — mapped by `mapPanelVideo`); `maybeFillRadio()` in player.ts appends deduped tracks when <4 remain.
- **Editorial playlists**: `homePlaylists()` collects `MusicTwoRowItem`/`MusicCarouselItem` from `getHomeFeed`/`getExplore` (browseIds `VL|PL|RD|OLAK|MPRE`).
- **Audio**: bundled `bin/yt-dlp.exe` (extraResources → `resources/bin/`) resolves signed googlevideo URLs (cached ~5h, inflight dedup, `--socket-timeout 10 --retries 2`). Do NOT pass `--extractor-args ... -web` — breaks extraction. Self-updates via `yt-dlp -U` 15s after launch.
- **Renderer client** `src/api/youtube.ts`: `ytAvailable()` gates the whole layer — false in a plain browser → every caller falls back to Audius.
- youtubei.js notes: explore/home items carry artist/duration/views in `flex_columns[1].title.runs`, not `.artists`; artist "Top songs" shelf's `bottom_endpoint` browseId → `getPlaylist` gives the full list.

## Player (`src/store/player.ts`)

Two engines behind one store: singleton `<audio>` (Audius + yt-dlp streams) and hidden YouTube IFrame player (`src/api/ytplayer.ts`, `ytEngine`, `warmup()`'d on app start). For yt tracks `loadAt` **races** yt-dlp vs iframe — first to play wins (audio preferred if both ready, iframe killed pre-playback → zero ads). Both engines stop at every `loadAt` — no zombie audio. All engine event listeners are gated by `engine` + `racingSeq` so stale events can't clobber state. **Circuit breaker**: `failAdvance()` skips on failure but stops after 3 consecutive auto-failures instead of burning the queue. Stream prefetch: hover (`prefetchStream` in youtube.ts → TrackTable/TrackCard/QuickTile) + next queue track + top-3 search + top-3 home. Queue + index + history + **radio fill** (`maybeFillRadio` → `yt:upnext`). Repeat off/all/one. `window.__player` exposes the store for e2e. `applyVolume()` scrubs volume without a store write (persist on commit only — a set() per pointermove writes localStorage). Persisted: volume, muted, shuffle, repeat. Library store persists liked + recents + **user playlists** (`LocalPlaylist`, ids `local-*`): ⋯ menu flyout, `/playlist/local-*` LocalPlaylistView (collage cover, inline rename, confirm-delete), "Save to Library" on remote playlists, QueuePanel "save queue as playlist".

## Windows integration

- **Taskbar thumbnail toolbar** (`win.setThumbarButtons`): save / prev / play-pause / next over the taskbar hover preview. Icons in `resources/thumbar/` (extraResources — asar paths don't work for `nativeImage.createFromPath`). Renderer pushes state via `window.freebify.player.thumbar({playing,title,artist})` (subscribe in player.ts); button clicks arrive as `player:cmd` → `onCommand`.
- Media Session API: hardware keys + Windows SMTC overlay with artwork.

## Design language

Strictly neutral (user request): blacks/grays only (`--color-*` tokens in index.css), white = the single accent (buttons, progress, active states). No decorative color, no gradients except subtle white glows and the Now Playing backdrop (dominant artwork color at low opacity via `src/utils/color.ts`).

## Shortcuts

Space play/pause · ←/→ seek 10s · M mute · L like · N now-playing overlay.

## Repo / releases

GitHub: **govu** (owner) — `https://github.com/govu/freebify`. Releases are tagged `v<version>` and published via `gh release create` with `Freebify-setup.exe`, `Freebify-portable.exe`, `latest.yml`, blockmap. Landing page at `docs/index.html` resolves `releases/latest` at runtime (versionless asset names).

## Commits

Never add tool/agent attribution (no "Generated with", no Co-Authored-By trailers) — commits read as the repo owner's own work.
