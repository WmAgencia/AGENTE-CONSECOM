import type { ReactNode } from 'react'

export function Card({ title, subtitle, children, className, actions }: {
  title?: string
  subtitle?: string
  children: ReactNode
  className?: string
  actions?: ReactNode
}) {
  return (
    <div className={`bi-card rounded-2xl border border-line bg-panel p-5 shadow-1 transition-shadow duration-200 hover:shadow-2 ${className ?? ''}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}
