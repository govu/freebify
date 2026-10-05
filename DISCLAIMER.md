# Disclaimer

**TL;DR — Freebify is a media player, not a music service.** It is a piece
of software you run on your own computer. It hosts nothing, stores nothing,
uploads nothing, and sells nothing. Every byte of audio or metadata is
fetched by *your* device, at *your* request, directly from third-party
servers operated by their respective platforms — the same way a web
browser does.

## What Freebify is (and is not)

Freebify is an open-source desktop application that provides a unified
interface for playing audio that is already publicly accessible on the
internet. Functionally it is comparable to a web browser or a media player
such as VLC: it sends requests to publicly reachable endpoints and renders
or plays back what those endpoints return.

Freebify:

- **does not host** any audio, video, artwork, lyrics, or metadata
- **does not operate any servers** that store, cache, relay, or proxy
  copyrighted content — there is no "Freebify backend" at all
- **does not redistribute** any media; streams travel directly between the
  third-party platform and the end user's machine
- **does not contain** copyrighted material — the source code and binaries
  are a user interface and a networking client, nothing more
- **does not require an account**, collect personal data, or track usage
- **is not affiliated with, endorsed by, or sponsored by** Spotify,
  YouTube, YouTube Music, Google, Audius, or any label, artist, or rights
  holder. All trademarks belong to their respective owners.

## Where the content comes from

All catalog metadata and audio are requested client-side, in real time,
from two public sources:

- **YouTube / YouTube Music** — via the same public web API (Innertube) and
  publicly served media URLs that any browser uses when visiting
  music.youtube.com. Audio resolution is performed locally on the user's
  machine by the bundled, unmodified, open-source
  [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) tool.
- **Audius** — via the official public Audius REST API
  (`https://api.audius.co`), which explicitly licenses its catalog for
  third-party apps under the Audius API terms.

Whether a given stream may be accessed in a given context is determined by
the hosting platform, not by Freebify. If a platform restricts or removes
content, Freebify simply cannot play it.

## Why this is legal territory for a *tool*, not a *service*

Software that is capable of accessing public streams is not itself an
infringement of copyright. Courts have long recognized that technology
with **substantial non-infringing uses** — playing openly licensed music
(Audius), personal media, Creative-Commons works, or content the user has
rights to — is lawful to develop and distribute, even if some users might
misuse it. This is the same legal footing as web browsers, download
managers, media players, and every app that embeds YouTube playback.

Responsibility for complying with each platform's Terms of Service and
with local copyright law rests with **the person operating the software**.
By using Freebify you are making direct requests to third-party services
from your own device and IP address — you are the client, not Freebify.
See [TERMS.md](TERMS.md).

## No commercial interest

Freebify is free, contains no advertising, has no paid tier, no donations
baked into playback, and generates no revenue from streams. It is a
non-commercial, educational open-source project maintained for personal
use and as a demonstration of desktop app engineering.

## Takedown / rights-holder contact

Because Freebify hosts and distributes no content, there is nothing on
"Freebify's servers" to remove — there are no such servers. If you are a
rights holder and want content restricted, the effective channel is the
platform that actually serves it:

- YouTube / YouTube Music: https://support.google.com/youtube/answer/2807622
- Audius: https://audius.co/legal/terms-of-use

If you believe the Freebify *software itself* infringes your rights (e.g.
trademark or bundled assets), open an issue at
https://github.com/govu/freebify/issues — the project is maintained in the
open and valid complaints are addressed promptly.

## Warranty and liability

Freebify is provided **"as is"**, without warranty of any kind, express or
implied, including but not limited to warranties of merchantability,
fitness for a particular purpose, and non-infringement. In no event shall
the authors or contributors be liable for any claim, damages, or other
liability arising from, out of, or in connection with the software or the
use or other dealings in the software — including how end users choose to
use it. See [LICENSE](LICENSE) (GPL-3.0, sections 15–17) and
[TERMS.md](TERMS.md).
