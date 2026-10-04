export function CardsRowSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="flex gap-4 overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="w-44 shrink-0">
          <div className="shimmer aspect-square w-full rounded-xl" />
          <div className="shimmer mt-3 h-4 w-3/4 rounded" />
          <div className="shimmer mt-2 h-3 w-1/2 rounded" />
        </div>
      ))}
    </div>
  )
}

export function RowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-3">
          <div className="shimmer size-10 rounded-md" />
          <div className="flex-1">
            <div className="shimmer h-3.5 w-2/5 rounded" />
            <div className="shimmer mt-2 h-3 w-1/4 rounded" />
          </div>
          <div className="shimmer h-3 w-10 rounded" />
        </div>
      ))}
    </div>
  )
}

export function HeroSkeleton({ cover = true }: { cover?: boolean }) {
  return (
    <div className={`flex items-end gap-6 px-6 pb-8 ${cover ? "pt-16" : "min-h-64 flex-col items-start justify-end pt-20"}`}>
      {cover && <div className="shimmer size-52 rounded-xl" />}
      <div className="flex-1 pb-1">
        <div className="shimmer h-4 w-28 rounded" />
        <div className="shimmer mt-4 h-12 w-2/3 rounded-lg" />
        <div className="shimmer mt-5 h-4 w-1/3 rounded" />
      </div>
    </div>
  )
}
