export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`inline-block rounded-lg animate-shimmer ${className}`} />
}

export function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

export function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-line">
      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
      <Skeleton className="h-8 w-16 rounded-lg" />
    </div>
  )
}