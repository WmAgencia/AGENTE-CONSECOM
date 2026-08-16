import type { ReactNode } from 'react'

export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="text-xs text-muted max-w-sm">{description}</p>}
      {action}
    </div>
  )
}