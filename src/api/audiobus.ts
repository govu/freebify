// Web Audio bus — every audible <audio> element routes through a shared
// graph instead of straight to the speakers:
//
//   element → MediaElementSource → fadeGain ─┐
//                                          ├→ EQ chain → normGain → out
//   next element (crossfade)  → fadeGain ──┘
//
// Why the main-process CORS injection matters: createMediaElementSource on a
// cross-origin URL without ACAO outputs silence. electron/main.cjs stamps
// access-control-allow-origin on every "media" response (and downloads.cjs
// does it for fbx:// files), so elements can declare crossOrigin=anonymous
// and feed the graph cleanly.

export const EQ_BANDS = [60, 250, 500, 1_000, 4_000, 8_000, 14_000]

let ctx: AudioContext | null = null
let eqNodes: BiquadFilterNode[] = []
let norm: GainNode | null = null

interface Port {
  src: MediaElementAudioSourceNode
  fade: GainNode
  meter: AnalyserNode
}
const ports = new Map<HTMLAudioElement, Port>()

// EQ is serialized to a single string for persistence — "{db},{db},..."
let eqGains: number[] = EQ_BANDS.map(() => 0)

function ensure(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    // EQ chain: lowshelf, peaking mids, highshelf — small Q so adjacent
    // bands blend instead of ringing
    eqNodes = EQ_BANDS.map((f, i) => {
      const b = ctx!.createBiquadFilter()
      b.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking"
      b.frequency.value = f
      b.Q.value = 1
      b.gain.value = eqGains[i] ?? 0
      return b
    })
    norm = ctx.createGain()
    // chain: ports → eqNodes[0..n] → norm → destination
    for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1])
    eqNodes[eqNodes.length - 1].connect(norm)
    norm.connect(ctx.destination)
    // apply any gain set before first element attached
    norm.gain.value = normGainLinear
  }
  if (ctx.state === "suspended") void ctx.resume()
  return ctx
}

let normGainLinear = 1

/** Route an element into the bus. Safe to call once per element — later
 *  calls return the existing port (MediaElementSource is 1:1 per element). */
export function attach(el: HTMLAudioElement): Port {
  const c = ensure()
  const existing = ports.get(el)
  if (existing) return existing
  const src = c.createMediaElementSource(el)
  const fade = c.createGain()
  const meter = c.createAnalyser()
  meter.fftSize = 2048
  src.connect(fade)
  fade.connect(eqNodes[0])
  fade.connect(meter)
  const p = { src, fade, meter }
  ports.set(el, p)
  return p
}

/** Detach a discarded element — it goes silent; only for elements that will
 *  never be used again (a detached element can't return to direct output). */
export function detach(el: HTMLAudioElement) {
  const p = ports.get(el)
  if (!p) return
  try { p.src.disconnect() } catch { /* noop */ }
  try { p.fade.disconnect() } catch { /* noop */ }
  ports.delete(el)
}

/** Fade an element's contribution: linear ramp from current value to `to`
 *  over `secs` (0 = jump). */
export function fadeTo(el: HTMLAudioElement, to: number, secs: number) {
  const p = ports.get(el)
  if (!p || !ctx) return
  const t = ctx.currentTime
  p.fade.gain.cancelScheduledValues(t)
  p.fade.gain.setValueAtTime(secs > 0 ? p.fade.gain.value : to, t)
  if (secs > 0) p.fade.gain.linearRampToValueAtTime(to, t + secs)
}

export function fadeValue(el: HTMLAudioElement): number {
  return ports.get(el)?.fade.gain.value ?? 1
}

/** Set all seven EQ bands (dB). Applies live — first element attach builds
 *  the graph with these values already in place. */
export function setEq(db: number[]) {
  eqGains = EQ_BANDS.map((_, i) => Math.max(-24, Math.min(24, db[i] ?? 0)))
  if (!ctx) return
  eqNodes.forEach((n, i) => n.gain.setTargetAtTime(eqGains[i], ctx!.currentTime, 0.05))
}

export function getEq(): number[] {
  return [...eqGains]
}

/** Loudness normalization gain (linear). */
export function setNormGain(linear: number) {
  normGainLinear = Math.max(0, Math.min(8, linear))
  if (ctx && norm) norm.gain.setTargetAtTime(normGainLinear, ctx.currentTime, 0.25)
}

export function getNormGain(): number {
  return normGainLinear
}

/** Integrated RMS (linear) of an element's signal — used by the loudness
 *  normalizer. Caller samples over time. */
export function rmsOf(el: HTMLAudioElement): number {
  const p = ports.get(el)
  if (!p || !ctx) return 0
  const buf = new Float32Array(p.meter.fftSize)
  p.meter.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

/** crossOrigin=anonymous MUST be set before the first src assignment —
 *  this helper makes every audio element bus-compatible from birth.
 *  Only inside Electron: a plain browser gets no CORS injection, and a
 *  source without ACAO would hard-fail instead of just bypassing the bus. */
export function mkAudio(url?: string): HTMLAudioElement {
  const a = new Audio()
  if (typeof window !== "undefined" && window.freebify) a.crossOrigin = "anonymous"
  if (url) a.src = url
  return a
}

/** Is the audio pipeline available? Browser fallback keeps direct output. */
export const busAvailable = typeof window !== "undefined" && !!window.freebify

/** AudioContext starts suspended before the first user gesture — retry on
 *  every play so the first real playback unsuspends it. */
export function resume() {
  if (ctx && ctx.state === "suspended") void ctx.resume()
}
