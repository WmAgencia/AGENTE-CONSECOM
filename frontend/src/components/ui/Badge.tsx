const palette: Record<string, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
  green: 'bg-green-500/15 text-green-300 border-green-500/20',
  indigo: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/20',
  violet: 'bg-violet-500/15 text-violet-300 border-violet-500/20',
  sky: 'bg-sky-500/15 text-sky-300 border-sky-500/20',
  cyan: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/20',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
  orange: 'bg-orange-500/15 text-orange-300 border-orange-500/20',
  rose: 'bg-rose-500/15 text-rose-300 border-rose-500/20',
  pink: 'bg-pink-500/15 text-pink-300 border-pink-500/20',
  gray: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/20',
}

const sizes: Record<string, string> = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-xs px-2.5 py-1',
  lg: 'text-sm px-3 py-1.5',
}

export function Badge({ color = 'gray', size = 'sm', children, className }: {
  color?: string
  size?: string
  children: React.ReactNode
  className?: string
}) {
  const c = palette[color] ?? palette.gray
  const s = sizes[size] ?? sizes.sm
  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${c} ${s} ${className ?? ''}`}>
      {children}
    </span>
  )
}