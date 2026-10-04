// Freebify mark — concentric rings radiating from a center point:
// a vinyl groove emitting sound. Ownable geometry, reads at any size.
export function Logo({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M41.5 33A19 19 0 1 1 24 5"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle cx="24" cy="24" r="10" stroke="currentColor" strokeWidth="5" />
      <circle cx="24" cy="24" r="3.5" fill="currentColor" />
    </svg>
  )
}
