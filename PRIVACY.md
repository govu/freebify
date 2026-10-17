# Privacy Policy

_Last updated: October 2026_

**Freebify collects nothing.** There is no account system, no analytics,
no telemetry, no crash reporting, no advertising, and no Freebify server
that could receive your data even if it wanted to.

## What stays on your device

Everything the app remembers is stored locally on your computer and never
transmitted to the authors:

- liked songs, playlists, play history and queue — `localStorage` on your
  machine
- playback preferences (volume, shuffle, repeat, autoplay)
- temporary caches of artwork, lyrics and resolved stream URLs, so the app
  feels instant
- diagnostic logs written to a local folder (opened via
  Settings → "Open logs folder")

You can wipe the caches at any time from Settings → "Clear artwork &
lyrics cache", or delete the app's data directory entirely.

## What third parties see

When you use Freebify, **your device makes direct requests** to the
third-party services that actually provide the catalog and audio — the
same way visiting their websites in a browser would:

- **YouTube / YouTube Music** (Google) — receives the search/browse/stream
  requests needed to play music, from your IP address.
- **Audius** — receives API and stream requests, from your IP address.
- **GitHub** — receives a release-info request when the app checks for
  updates or you open the project website.

Those requests are governed by each service's own privacy policy, not this
one. Freebify's authors never see any of this traffic.

## Discord Rich Presence (optional)

If "Discord status" is enabled in Settings, the app tells the Discord
client *running on your own computer* what you're listening to so it can
show on your Discord profile. This data goes to Discord under Discord's
privacy policy; you can turn it off at any time.

## Spotify playlist import (optional, read-only)

To import a Spotify playlist longer than 100 tracks, Freebify can ask you to
log in to Spotify once. The login screens belong to Spotify and happen
between your device and Spotify only. What Freebify stores from it:

- **the session token lives in the app's memory for the current session
  only** — never on disk, never in the log file, and it is erased the
  moment you close the app (or right away from Settings on request)
- Freebify **never sees your Spotify password** — the browser window you
  type it into belongs to Spotify
- the only thing the token is ever asked for is reading public or your
  own playlists, strictly read-only — it cannot write, edit or remove
  anything from your Spotify account

You can revoke Freebify's access at any time from
https://www.spotify.com/account/apps/.

## Changes

This policy may be updated alongside the app. The current version is
always at https://github.com/govu/freebify.
