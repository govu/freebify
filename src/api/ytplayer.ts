// YouTube IFrame Player API engine — invisible embedded player used as a
// resilient fallback when direct audio extraction (yt-dlp) fails.
// The official player gives us play/pause/seek/volume/ended events.

declare global {
  interface Window {
    YT?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<any> | null = null

function loadApi(): Promise<any> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      window.onYouTubeIframeAPIReady = undefined
      ok ? resolve(window.YT) : reject(new Error("iframe_api failed"))
    }
    window.onYouTubeIframeAPIReady = () => finish(true)
    // retries after a timeout must not stack duplicate <script> tags — a
    // still-loading earlier tag resolves us via the re-armed callback anyway
    if (!document.querySelector('script[src$="iframe_api"]')) {
      const s = document.createElement("script")
      s.src = "https://www.youtube.com/iframe_api"
      s.onerror = () => finish(false)
      document.head.appendChild(s)
    }
    // don't hang forever
    const timer = window.setTimeout(
      () => (window.YT?.Player ? finish(true) : finish(false)),
      10000
    )
  }).catch((e) => {
    // never cache a rejection — one offline launch would brick the
    // fallback engine for the whole session otherwise
    apiPromise = null
    throw e
  })
  return apiPromise
}

export interface YtEngineEvents {
  onPlaying?: (duration: number) => void
  onPaused?: () => void
  onBuffering?: () => void
  onEnded?: () => void
  onError?: (code: number) => void
  onTime?: (t: number) => void
  onDuration?: (d: number) => void
}

class YtEngine {
  private player: any = null
  private readyPromise: Promise<void> | null = null
  private pollTimer: number | null = null
  private playTimer: number | null = null
  private events: YtEngineEvents = {}
  // the video play() last loaded — postMessage events carry no id, so we
  // verify the player's current video before attributing PLAYING/ERROR/
  // ENDED to the pending attempt. Stale events for a superseded video
  // would otherwise "win" a race or kill a healthy track.
  private expectedVid = ""
  private durEmitted = false
  // applied onto every new video — otherwise the first ~second plays at
  // YouTube's default volume (100%) before the store's values land
  private lastVol = 1
  private lastMuted = false
  isActive = false

  // the video the player reports must match what play() loaded — else the
  // event belongs to a superseded video and is inert
  private vidOk(): boolean {
    if (!this.expectedVid) return true
    try {
      const vid = this.player?.getVideoData?.()?.video_id
      return !vid || vid === this.expectedVid
    } catch {
      return true
    }
  }

  private settlePlay(ok: boolean) {
    if (this.playTimer !== null) {
      clearTimeout(this.playTimer)
      this.playTimer = null
    }
    this.pendingPlay?.(ok)
    this.pendingPlay = null
  }

  private async ensure(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const YT = await loadApi()
        // reuse the host across retries — a timed-out attempt used to
        // append a duplicate player every time (zombie iframes). A stale
        // <iframe> (the API replaced the div but kept the id) must go.
        let host = document.getElementById("yt-frame-host")
        if (host?.tagName === "IFRAME") {
          host.remove()
          host = null
        }
        if (!host) {
          host = document.createElement("div")
          host.id = "yt-frame-host"
          host.style.cssText =
            "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none"
          document.body.appendChild(host)
        }
        let readyTimer = 0
        await new Promise<void>((resolve, reject) => {
          this.player = new YT.Player(host, {
            width: 200,
            height: 200,
            playerVars: {
              autoplay: 0,
              controls: 0,
              disablekb: 1,
              fs: 0,
              iv_load_policy: 3,
              modestbranding: 1,
              rel: 0,
              playsinline: 1,
            },
            events: {
              onReady: () => {
                clearTimeout(readyTimer)
                resolve()
              },
              onStateChange: (e: any) => this.handleState(e.data),
              onError: (e: any) => {
                // stale error for a superseded video — drop entirely
                if (!this.vidOk()) return
                this.settlePlay(false)
                this.playing = false
                this.stopPoll()
                // inert while stopped — a late error for a superseded
                // video must not kill the healthy current track
                if (this.isActive) this.events.onError?.(e?.data ?? 0)
              },
            },
          })
          readyTimer = window.setTimeout(() => reject(new Error("player ready timeout")), 12000)
        })
      })().catch((e) => {
        this.teardown()
        throw e
      })
    }
    return this.readyPromise
  }

  // a successful readyPromise caches forever — but a player that died
  // post-init (widget crash, iframe GC'd) would burn the 8s play timeout
  // on every track forever. Tearing down lets the next play() rebuild.
  private teardown() {
    try {
      this.player?.destroy?.()
    } catch {
      /* ignore */
    }
    this.player = null
    this.readyPromise = null
    this.stopPoll()
    this.settlePlay(false)
  }

  private pendingPlay: ((ok: boolean) => void) | null = null
  private gen = 0
  playing = false

  private handleState(state: number) {
    // inert while stopped/superseded — a late PLAYING must never resurrect it
    if (!this.isActive || !this.vidOk()) return
    // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (state === 1) {
      this.playing = true
      this.startPoll()
      this.events.onPlaying?.(this.duration())
      this.settlePlay(true)
    } else if (state === 2) {
      this.playing = false
      this.stopPoll()
      this.events.onPaused?.()
    } else if (state === 3) {
      this.events.onBuffering?.()
    } else if (state === 0) {
      this.playing = false
      this.stopPoll()
      this.settlePlay(false) // ended before ever playing = failed load
      this.events.onEnded?.()
    }
  }

  private startPoll() {
    this.stopPoll()
    this.pollTimer = window.setInterval(() => {
      try {
        const t = this.player?.getCurrentTime?.()
        if (Number.isFinite(t)) this.events.onTime?.(t)
        // duration arrives after metadata — emit it once it exists instead
        // of trusting the one read at first PLAYING (often still 0)
        if (!this.durEmitted) {
          const d = this.duration()
          if (d > 0) {
            this.durEmitted = true
            this.events.onDuration?.(d)
          }
        }
      } catch {
        /* ignore */
      }
    }, 500)
  }

  private stopPoll() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  setEvents(ev: YtEngineEvents) {
    this.events = ev
  }

  /** Preload the IFrame API + hidden player so the first play starts fast */
  warmup() {
    void this.ensure().catch(() => {
      /* cold start still possible — play() retries ensure() itself */
    })
  }

  /**
   * Resolves true once the video actually reaches PLAYING state.
   * startSeconds avoids the audible head-start a post-PLAYING seek causes.
   */
  async play(videoId: string, startSeconds = 0, retried = false): Promise<boolean> {
    const g = ++this.gen
    try {
      await this.ensure()
      if (this.gen !== g) return false // superseded while the player was initializing
      this.isActive = true
      this.expectedVid = videoId
      this.durEmitted = false
      // settle any previous attempt still waiting on its pendingPlay —
      // overwriting the slot would leave that play() promise hanging
      this.settlePlay(false)
      const started = new Promise<boolean>((resolve) => {
        this.pendingPlay = resolve
        this.playTimer = window.setTimeout(() => {
          if (this.pendingPlay === resolve) {
            this.pendingPlay = null
            this.playTimer = null
            resolve(false)
          }
        }, 8000)
      })
      // volume/mute BEFORE the first frame — the embed otherwise plays a
      // beat at 100% before the store's values land
      try {
        this.player.setVolume?.(Math.round(this.lastVol * 100))
        this.lastMuted ? this.player.mute?.() : this.player.unMute?.()
      } catch {
        /* ignore */
      }
      this.player.loadVideoById(
        startSeconds > 0 ? { videoId, startSeconds } : videoId
      )
      const ok = await started
      // a superseding play() may have re-activated while this one awaited —
      // only a still-current failure may clear the flag
      if (!ok && this.gen === g) {
        this.isActive = false
        // never resolved in 8s — the player may be dead (events stopped
        // arriving entirely). Rebuild once so the NEXT call doesn't burn
        // another timeout on a corpse.
        if (!retried) {
          this.teardown()
          return this.play(videoId, startSeconds, true)
        }
      }
      return ok
    } catch {
      return false
    }
  }

  pause() {
    try {
      this.player?.pauseVideo?.()
    } catch {
      /* ignore */
    }
  }

  resume() {
    try {
      this.player?.playVideo?.()
    } catch {
      /* ignore */
    }
  }

  stop() {
    this.gen++
    this.isActive = false
    this.playing = false
    this.settlePlay(false)
    this.stopPoll()
    try {
      this.player?.stopVideo?.()
    } catch {
      /* ignore */
    }
  }

  seek(sec: number) {
    try {
      this.player?.seekTo?.(sec, true)
    } catch {
      /* ignore */
    }
  }

  setVolume(v: number) {
    this.lastVol = v
    try {
      this.player?.setVolume?.(Math.round(v * 100))
    } catch {
      /* ignore */
    }
  }

  setMuted(m: boolean) {
    this.lastMuted = m
    try {
      m ? this.player?.mute?.() : this.player?.unMute?.()
    } catch {
      /* ignore */
    }
  }

  // ?? only catches null/undefined — an unstarted or errored player can
  // return NaN, which would poison currentTime/duration/resume state
  duration(): number {
    try {
      const d = this.player?.getDuration?.()
      return Number.isFinite(d) ? d : 0
    } catch {
      return 0
    }
  }

  currentTime(): number {
    try {
      const t = this.player?.getCurrentTime?.()
      return Number.isFinite(t) ? t : 0
    } catch {
      return 0
    }
  }
}

export const ytEngine = new YtEngine()
