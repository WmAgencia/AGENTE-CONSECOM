import { useId } from 'react'

/* ===== Mini biblioteca de gráficos SVG (design system Vyntra) =====
 * Sem dependências externas. Todos os charts herdam os tokens CSS
 * (--c-accent-*, --c-line, etc.) e respeitam prefers-reduced-motion. */

export function fmtK(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

// ===== Sparkline (mini área, usado em KPIs) =====
export function Sparkline({ data, width = 96, height = 32, color = 'var(--c-accent-500)' }: {
  data: number[]
  width?: number
  height?: number
  color?: string
}) {
  const id = useId()
  if (data.length < 2) {
    return <div className="text-[10px] text-faint" style={{ width, height }}>sem dados</div>
  }
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const pad = 2
  const step = (width - pad * 2) / (data.length - 1)
  const pts = data.map((v, i) => {
    const x = pad + i * step
    const y = height - pad - ((v - min) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ===== BarChart (vertical) =====
export function BarChart({ data, height = 160, format }: {
  data: Array<{ label: string; value: number }>
  height?: number
  format?: (n: number) => string
}) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="w-full flex items-end gap-1" style={{ height }}>
      {data.map((d, i) => {
        const h = Math.max(4, (d.value / max) * (height - 26))
        return (
          <div key={d.label + i} className="flex-1 flex flex-col items-center justify-end gap-1.5 min-w-0 group">
            <div className="text-[10px] font-semibold text-fg opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
              {format ? format(d.value) : fmtK(d.value)}
            </div>
            <div
              className="w-full max-w-[28px] rounded-t-md bg-gradient-to-t from-accent-700 to-accent-400 transition-all duration-500 group-hover:brightness-110"
              style={{ height: h }}
            />
            <div className="text-[10px] text-faint truncate w-full text-center">{d.label}</div>
          </div>
        )
      })}
    </div>
  )
}

// ===== AreaChart (suavizado, com gradiente) =====
export function AreaChart({ data, height = 180, format, color = 'var(--c-accent-500)' }: {
  data: Array<{ label: string; value: number }>
  height?: number
  format?: (n: number) => string
  color?: string
}) {
  const id = useId()
  const W = 100
  const H = 100
  const padX = 0
  const padTop = 6
  const padBottom = 4
  if (data.length < 2) {
    return <div className="text-xs text-faint flex items-center justify-center" style={{ height }}>Sem dados suficientes</div>
  }
  const max = Math.max(...data.map((d) => d.value), 1)
  const min = Math.min(...data.map((d) => d.value), 0)
  const range = max - min || 1
  const step = (W - padX * 2) / (data.length - 1)
  const pts = data.map((d, i) => {
    const x = padX + i * step
    const y = H - padBottom - ((d.value - min) / range) * (H - padTop - padBottom)
    return [x, y] as const
  })
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `0,${H - padBottom} ${line} ${W},${H - padBottom}`
  const last = data[data.length - 1]!
  const lastPt = pts[pts.length - 1]!

  return (
    <div className="relative" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="var(--c-line)" strokeWidth="0.3" strokeDasharray="1.5 1.5" />
        ))}
        <polygon points={area} fill={`url(#${id})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={lastPt[0]} cy={lastPt[1]} r="1.6" fill={color} stroke="var(--c-panel)" strokeWidth="0.6" />
      </svg>
      <div className="absolute top-0 right-2 text-[10px] font-bold tabular-nums text-fg bg-panel/80 backdrop-blur rounded px-1.5 py-0.5 border border-line">
        {format ? format(last.value) : fmtK(last.value)}
      </div>
      <div className="absolute bottom-0 inset-x-0 flex justify-between text-[10px] text-faint pt-1">
        <span>{data[0]!.label}</span>
        <span>{data[data.length - 1]!.label}</span>
      </div>
    </div>
  )
}

// ===== DonutChart (proporções) =====
export function DonutChart({ data, size = 150, thickness = 18, format }: {
  data: Array<{ label: string; value: number; color?: string }>
  size?: number
  thickness?: number
  format?: (n: number) => string
}) {
  const total = data.reduce((acc, d) => acc + Math.max(0, d.value), 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const palette = ['var(--c-accent-500)', 'var(--c-accent-300)', 'var(--c-sky-500, #38bdf8)', 'var(--c-amber-500, #f59e0b)', 'var(--c-rose-500, #f43f5e)', 'var(--c-violet-500, #8b5cf6)']
  let acc = 0
  if (total <= 0) {
    return (
      <div className="flex items-center justify-center text-xs text-faint" style={{ width: size, height: size }}>
        Sem dados
      </div>
    )
  }
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--c-line)" strokeWidth={thickness} fill="none" />
          {data.map((d, i) => {
            const frac = Math.max(0, d.value) / total
            const len = frac * c
            const offset = -acc * c
            acc += frac
            const col = d.color ?? palette[i % palette.length]
            if (len <= 0) return null
            return (
              <circle
                key={d.label + i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                stroke={col}
                strokeWidth={thickness}
                fill="none"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={offset}
                style={{ transition: 'stroke-dashoffset 0.5s ease' }}
              />
            )
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-xl font-bold tabular-nums">{format ? format(total) : fmtK(total)}</div>
          <div className="text-[10px] text-faint uppercase tracking-wide">total</div>
        </div>
      </div>
      <div className="space-y-1.5 min-w-0">
        {data.map((d, i) => {
          const frac = total > 0 ? Math.round((Math.max(0, d.value) / total) * 100) : 0
          const col = d.color ?? palette[i % palette.length]
          return (
            <div key={d.label + i} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: col }} />
              <span className="text-muted truncate max-w-[110px]">{d.label}</span>
              <span className="ml-auto font-semibold tabular-nums">{frac}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===== HorizontalBars (ranking / funil) =====
export function HorizontalBars({ data, format }: {
  data: Array<{ label: string; value: number }>
  format?: (n: number) => string
}) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => {
        const w = Math.max(4, (d.value / max) * 100)
        const colors = ['bg-accent-500', 'bg-accent-400', 'bg-sky-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500']
        return (
          <div key={d.label + i} className="flex items-center gap-3">
            <span className="w-36 text-xs text-muted truncate">{d.label}</span>
            <div className="flex-1 h-3 rounded-full bg-subtle overflow-hidden">
              <div className={`h-full ${colors[i % colors.length]} rounded-full transition-all duration-500`} style={{ width: `${w}%` }} />
            </div>
            <span className="text-xs font-semibold text-secondary tabular-nums w-12 text-right">
              {format ? format(d.value) : fmtK(d.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ===== KpiCard (cartão de métrica com sparkline) =====
export function KpiCard({ label, value, hint, icon, trend, spark, accent }: {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  trend?: number | null
  spark?: number[]
  accent?: string
}) {
  const acc = accent ?? 'var(--c-accent-500)'
  return (
    <div className="bi-kpi rounded-2xl border border-line bg-panel p-4 shadow-1 transition-shadow duration-200 hover:shadow-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted uppercase tracking-wide font-medium">{label}</div>
        {icon && (
          <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ color: acc, background: 'var(--c-subtle-2)' }}>
            {icon}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2 mt-2">
        <div className="text-2xl font-bold tabular-nums tracking-tight">{value}</div>
        {spark && spark.length > 1 && <Sparkline data={spark} color={acc} width={72} height={26} />}
      </div>
      {(hint || trend != null) && (
        <div className="flex items-center gap-2 mt-1.5">
          {trend != null && (
            <span
              className={`inline-flex items-center gap-0.5 text-[10px] font-bold rounded-full px-1.5 py-0.5 ${
                trend >= 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
              }`}
            >
              {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}%
            </span>
          )}
          {hint && <span className="text-[11px] text-faint truncate">{hint}</span>}
        </div>
      )}
    </div>
  )
}
