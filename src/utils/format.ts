export function fmtDuration(totalSeconds?: number | null): string {
  // ?? doesn't catch NaN — corrupt persisted durations must not render "NaN:NaN"
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? (totalSeconds as number) : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
  return `${m}:${String(sec).padStart(2, "0")}`
}

export function fmtCount(n?: number | null): string {
  const v = Number.isFinite(n) ? (n as number) : 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return String(v)
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return "Up late?"
  if (h < 12) return "Good morning"
  if (h < 18) return "Good afternoon"
  return "Good evening"
}
