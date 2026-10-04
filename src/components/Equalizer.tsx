export function Equalizer({ playing, className = "" }: { playing: boolean; className?: string }) {
  return (
    <div className={`eq ${playing ? "" : "paused"} ${className}`} aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </div>
  )
}
