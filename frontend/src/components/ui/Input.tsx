import { forwardRef } from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  icon?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, icon, className, id, ...rest }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-')
    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-secondary">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">{icon}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={[
              'w-full rounded-xl border border-line-2 bg-field px-3 py-2.5 text-sm text-fg placeholder:text-faint',
              'outline-none transition-all duration-200',
              'hover:border-line-strong',
              'focus:border-accent-500 focus:shadow-glow',
              error ? 'border-rose-400 focus:border-rose-400 focus:shadow-[0_0_0_3px_rgba(251,113,133,0.25)]' : '',
              icon ? 'pl-9' : '',
              className ?? '',
            ].join(' ')}
            {...rest}
          />
        </div>
        {error && <p className="text-xs text-rose-400">{error}</p>}
        {hint && !error && <p className="text-xs text-faint">{hint}</p>}
      </div>
    )
  },
)
Input.displayName = 'Input'