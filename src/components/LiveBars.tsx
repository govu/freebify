import { useEffect, useRef, useState } from "react"
import { Equalizer } from "./Equalizer"
import { getSpectrum } from "../store/player"

// Live 12-bar spectrum for the player row. Draws from the analyser the audio
// bus already keeps; when the iframe engine owns playback there is no tap, so
// the CSS Equalizer takes over rather than showing a dead flat row.
const BARS = 12
const W = 60
const H = 24

export function LiveBars({ playing, className = "" }: { playing: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!playing) return
    const el = canvas.current
    const ctx = el?.getContext("2d")
    if (!el || !ctx) return
    const dpr = window.devicePixelRatio || 1
    el.width = W * dpr
    el.height = H * dpr
    ctx.scale(dpr, dpr)
    const buf = new Uint8Array(1024)
    // fast attack, slow release - mirrors how a real meter behaves
    const smooth = new Float32Array(BARS)
    let raf = 0
    let alive = true
    let tapped = false
    let lastLive = false
    const barW = 3
    const gap = 2
    const startX = (W - (BARS * (barW + gap))) / 2

    const draw = () => {
      if (!alive) return
      raf = requestAnimationFrame(draw)
      tapped = getSpectrum(buf)
      if (tapped !== lastLive) {
        lastLive = tapped
        setLive(tapped)
      }
      ctx.clearRect(0, 0, W, H)
      if (!tapped) return
      // log-ish bins: lows carry most of the energy, so sample wider as the
      // spectrum climbs to keep every bar moving
      for (let i = 0; i < BARS; i++) {
        const from = Math.floor(Math.pow(i / BARS, 1.7) * 240)
        const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / BARS, 1.7) * 240))
        let peak = 0
        for (let k = from; k < to; k++) peak = Math.max(peak, buf[k] ?? 0)
        const target = peak / 255
        smooth[i] = Math.max(target, smooth[i] * 0.86)
        const h = Math.max(2, smooth[i] * (H - 4))
        ctx.fillStyle = "#fff"
        ctx.beginPath()
        ctx.roundRect(startX + i * (barW + gap), H - h, barW, h, 1.5)
        ctx.fill()
      }
    }
    draw()
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [playing])

  // the canvas is always mounted (hidden until a tap exists) - an effect that
  // waited for `live` before rendering it would read a null ref and never
  // start the loop at all
  return (
    <div className="relative grid place-items-center" style={{ width: W, height: H }} aria-hidden>
      <canvas
        ref={canvas}
        className={playing && live ? "block" : "hidden"}
        style={{ width: W, height: H }}
      />
      {(!playing || !live) && <Equalizer playing={playing} className={className} />}
    </div>
  )
}

// Scales its child with the bass energy of the live signal. 3% is enough to
// feel on a thumbnail without threatening the layout around it.
export function BassPulse({
  active,
  className = "",
  children,
}: {
  active: boolean
  className?: string
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    const el = box.current
    if (!el) return
    const buf = new Uint8Array(1024)
    let raf = 0
    let alive = true
    let cur = 1
    const tick = () => {
      if (!alive) return
      raf = requestAnimationFrame(tick)
      // skip the work when there is no tap (iframe engine)
      if (!getSpectrum(buf)) return
      const bass = (buf[1] + buf[2] + buf[3] + buf[4]) / (4 * 255)
      const target = 1 + Math.min(0.035, bass * 0.035)
      cur += (target - cur) * 0.18
      el.style.transform = `scale(${cur.toFixed(4)})`
    }
    tick()
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      el.style.transform = ""
    }
  }, [active])
  return (
    <div ref={box} className={className} style={{ willChange: "transform" }}>
      {children}
    </div>
  )
}
