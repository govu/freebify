// Web Audio bus — every audible <audio> element routes through a shared
// graph instead of straight to the speakers:
//
//   element → MediaElementSource → fadeGain → elGain ─┐
//                                                    ├→ EQ chain → out
//   next element (crossfade)  → fadeGain → elGain ────┘
//
// Why the main-process CORS injection matters: createMediaElementSource on a
// cross-origin URL without ACAO outputs silence. electron/main.cjs stamps
// access-control-allow-origin on every "media" response (and downloads.cjs
// does it for fbx:// files), so elements can declare crossOrigin=anonymous
// and feed the graph cleanly.

export const EQ_BANDS = [60, 250, 500, 1_000, 4_000, 8_000, 14_000]

let ctx: AudioContext | null = null
let eqNodes: BiquadFilterNode[] = []

interface Port {
  src: MediaElementAudioSourceNode
  fade: GainNode
  gain: GainNode // per-element loudness — each track keeps its own level mid-crossfade
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
    // chain: ports → eqNodes[0..n] → limiter → destination
    for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1])
    // safety limiter — normalization boosts and EQ gain can push a signal
    // past full scale at high user volume; compressing at -2 dB catches
    // the peaks transparently instead of hard-clipping the output
    const lim = ctx.createDynamicsCompressor()
    lim.threshold.value = -2
    lim.knee.value = 0
    lim.ratio.value = 20
    lim.attack.value = 0.003
    lim.release.value = 0.12
    eqNodes[eqNodes.length - 1].connect(lim)
    lim.connect(ctx.destination)
  }
  if (ctx.state === "suspended") void ctx.resume()
  return ctx
}

/** Route an element into the bus. Safe to call once per element — later
 *  calls return the existing port (MediaElementSource is 1:1 per element). */
export function attach(el: HTMLAudioElement): Port {
  const c = ensure()
  const existing = ports.get(el)
  if (existing) return existing
  const src = c.createMediaElementSource(el)
  const fade = c.createGain()
  const gain = c.createGain()
  const meter = c.createAnalyser()
  meter.fftSize = 2048
  src.connect(fade)
  fade.connect(gain)
  gain.connect(eqNodes[0])
  // meter taps the raw signal — a mid-fade measurement must not read the
  // ramping level as the track's true loudness
  src.connect(meter)
  const p = { src, fade, gain, meter }
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
  // gain stays plugged into the EQ chain otherwise — a detached port would
  // pin the whole node chain in the graph
  try { p.gain.disconnect() } catch { /* noop */ }
  try { p.meter.disconnect() } catch { /* noop */ }
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

/** Equal-power fade — the one that sounds right. A linear ramp on both
 *  elements dips the summed loudness ~3dB at the midpoint (that's the
 *  "volume drops during the transition" effect); cosine out + sine in
 *  keeps the power constant so the mix stays level through the whole
 *  crossfade. From any current value toward `to`, along the circle arc.
 *
 *  `holdFrac` (fade-outs only): the element holds `from` for that share of
 *  the window, then cosine-decays. The outgoing track keeps its ending —
 *  a fade-out over the whole window eats a hard outro, which reads as the
 *  song being "cut early". The incoming still sine-swells the full window,
 *  so the overlap never dips; it just crests slightly fuller mid-fade. */
export function fadeCurve(el: HTMLAudioElement, to: number, secs: number, holdFrac = 0) {
  const p = ports.get(el)
  if (!p || !ctx) return
  const t = ctx.currentTime
  const from = Math.min(1, Math.max(0, p.fade.gain.value))
  const hold = to < from ? Math.min(0.8, Math.max(0, holdFrac)) : 0
  const N = 64
  const curve = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1)
    curve[i] =
      hold > 0 && x <= hold
        ? from
        : from * Math.cos((Math.min(1, (x - hold) / (1 - hold)) * Math.PI) / 2) +
          to * Math.sin((Math.min(1, (x - hold) / (1 - hold)) * Math.PI) / 2)
  }
  p.fade.gain.cancelScheduledValues(t)
  p.fade.gain.setValueAtTime(from, t)
  p.fade.gain.setValueCurveAtTime(curve, t, Math.max(0.01, secs))
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

/** Per-element loudness gain (linear) — each element carries its own
 *  normalization so a crossfade blends two already-leveled signals.
 *
 *  The first-play correction lands ~8s into the song, so the way it MOVES
 *  matters: a setTargetAtTime approach in linear domain covers 63% of the
 *  jump in its first τ — a +8dB fix reads as an audible snap. Instead we
 *  ramp geometrically (constant dB/sec — the perceptually even trajectory)
 *  and rate-limit to ≤3dB/s so big corrections glide instead of step. */
export function setNormGain(el: HTMLAudioElement, linear: number) {
  const p = ports.get(el)
  if (!p || !ctx) return
  const t = ctx.currentTime
  const from = Math.max(0.0001, p.gain.gain.value)
  const to = Math.max(0.0001, Math.min(5, linear))
  p.gain.gain.cancelScheduledValues(t)
  if (Math.abs(to - from) < 0.02) {
    p.gain.gain.setValueAtTime(to, t)
    return
  }
  const db = Math.abs(20 * Math.log10(to / from))
  const secs = Math.min(4, Math.max(0.4, db / 3))
  const N = 48
  const curve = new Float32Array(N)
  const ratio = to / from
  for (let i = 0; i < N; i++) curve[i] = from * Math.pow(ratio, i / (N - 1))
  p.gain.gain.setValueAtTime(from, t)
  p.gain.gain.setValueCurveAtTime(curve, t, secs)
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
