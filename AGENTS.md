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
- youtubei.js notes: explore/home items carry artist/duration/views in `flex_columns[1].title.runs`, not `.artists`.
- **Artist pages**: `getAllSongs()` returns the full ranked list (~100 `MusicResponsiveListItem` + a ContinuationItem we don't chase). Full discography: the Albums/Singles `MusicCarouselShelf`s only ship ~10 rows; their `header.more_content.endpoint` carries an `MPAD<browseId>` — call it **raw** via `yt.actions.execute("/browse", { browseId, client:"YTMUSIC" })` (the endpoint's own params answer "No results", and parse:true leaves items in Memo nodes) → walk the raw JSON for `musicTwoRowItemRenderer` → `mapRawAlbumRow` (same Playlist shape as mapAlbum; subtitle "Album/Single/EP • year" splits the buckets). Carousel rows merge after as safety net; all deduped by browseId. Renderer shows ≤15 rows + "Show all" (`TrackTable context=` keeps the queue on the full list) and Section rows of PlaylistCards. Audius artists get `/users/{id}/albums` via `apiClient.userAlbums`.
- **macOS playback fix**: a downloaded .app quarantines EVERY bundled file — Gatekeeper kills `resources/bin/yt-dlp` on spawn → "no song plays". `ensureExecutable()` (youtube.cjs) runs once before any spawn: `chmod 755`, `xattr -dr com.apple.quarantine` on the bundle, then probes `--version`; if the bundled binary still can't run (App Translocation → read-only path), it copies it to `userData/bin/` and de-quarantines there (`execBin` overrides `binPath()`). `downloads.cjs` awaits it too.

## Lyrics (`src/components/NowPlaying.tsx`)

- Source order for yt tracks: **YTM timed lyrics** (`yt.timedLyrics` → `/next` resolves `MPLYt*` browseId → raw `/browse` with `clientName: ANDROID_MUSIC`/`clientVersion: 7.21.50` → `timedLyricsData[].cueRange.startTimeMilliseconds`; official LyricFind data bound to the exact videoId) → **Musixmatch** (`yt.mxmLyrics` in main — `apic.musixmatch.com` anonymous client API: cached guest `token.get` → `track.search` → `track.subtitle.get?subtitle_format=lrc`; the curated catalog Spotify displays; races LRCLIB and wins when it hits, loser sheets become alignment alternates; guest token refreshes once on 401/419) → **LRCLIB** (strict+fuzzy+title queries, `titleLike`/`artistOk`/`sane` gates) → **lyrist** → **textyl** → **QQ Music** (`yt.qqLyrics` in main — `c.y.qq.com` search + `fcgi-bin/query_lyric_new.fcg`, trans field holds LRC; title/artist/duration gates, `[00:00.00] Title - Artist` header card stripped) → **YouTube captions** (`yt.captions` via yt-dlp `-J` ASR/manual subs; `*-orig` ASR preferred over translated tracks; timedtext PoToken wall → falls back to manifest.googlevideo.com HLS caption playlists, marks `blocked:true` on download failure — short negative TTL, never cached as absent; renderer aborts the twin walk after ~4 blocked probes) → plain text → `pseudoSync`. Last-resort timing truth when captions are unavailable: `yt:audioprobe` fetches the stream head (~1.6MB, decoded → LEADING dead air at `<0.004` RMS ≈ −48dBFS — quiet intros/fade-ins never trigger) plus a ~400KB tail scanned for `moof`/`trun` frame sizes (silent AAC ≈ <90B → TRAILING dead air). A lyric line scheduled inside proven head silence shifts the sheet past it (`off += headSil`); a big intro guess contradicted by proven tail air is trimmed (`off −= tailSil`). `introOff` trusts canonical `recDur` over the sheet's own end — a long instrumental outro used to masquerade as a giant intro and shift the whole sheet late.
- **Sync correction**: `autoOff` delays the whole sheet (`adj = t - offset`); `refineOffset` measures the real offset by fuzzy-matching LRC lines against captions (`alignOffset` — word/bigram Dice via `simTokens`/`simBigrams`, earliest cue within 85% of best score, quorum ≥3 clustered within 4s → median). `forEachVideo` walks caption candidates: the playing video first, then same-recording twins (catalog `yt:search` + general `yt:videosearch` — lyric/fan uploads carry ASR more often than official uploads), loose=±30s duration gate for measurement (intros inflate duration), budget 11, non-"lyric"-titled twins ranked first. Twins only *measure* (never veto content); own video remains ground truth. Manual **Shift+click a line** pins it to now and always wins.
- **Offset persistence**: `lrcoffa-<trackId>-<sheetFp>` = auto-measured (re-verified each play), `lrcoff2-<trackId>-<sheetFp>` = manual pin (deletes auto key). Both carry a fingerprint of the lyric sheet so offsets never leak across different sheets/tracks. Debug tracing via `app.log` → `%LOCALAPPDATA%\freebify\logs\main.log`.

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

Side sessions leave changes uncommitted — the main Freebify project agent batches them into the next versioned release. Don't commit or push unless the user explicitly asks.
