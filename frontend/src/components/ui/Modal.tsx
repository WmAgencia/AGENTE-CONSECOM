import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const sizes: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-xl',
    lg: 'max-w-3xl',
    xl: 'max-w-5xl',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`w-full ${sizes[size]} max-h-[90vh] overflow-y-auto rounded-2xl border border-line-2 bg-panel shadow-2xl animate-modal-in`}
      >
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-line">
            <div className="min-w-0">
              {title && <div className="font-semibold text-sm sm:text-base">{title}</div>}
              {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 -mr-1.5 rounded-lg text-muted hover:text-fg hover:bg-subtle transition-colors"
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-1">{footer}</div>}
      </div>
    </div>
  )
}