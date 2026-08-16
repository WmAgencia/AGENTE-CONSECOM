import { forwardRef } from 'react'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center rounded-xl font-medium transition-all duration-200 focus-visible:shadow-glow disabled:opacity-50 disabled:pointer-events-none select-none'

const variants: Record<Variant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-500 active:bg-accent-700 shadow-2 hover:shadow-3',
  secondary: 'bg-subtle-2 text-fg hover:bg-subtle border border-line',
  outline: 'border border-line-2 text-secondary hover:border-faint hover:bg-subtle',
  ghost: 'text-secondary hover:bg-subtle hover:text-fg',
  danger: 'bg-rose-500 text-white hover:bg-rose-400 active:bg-rose-600 shadow-2',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2.5',
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: React.ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, icon, children, className, disabled, ...rest }, ref) => {
    const isIconOnly = !children && !!icon
    const iconSize = size === 'lg' ? 18 : size === 'sm' ? 14 : 16
    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${sizes[size]} ${isIconOnly ? 'px-0 w-10' : ''} ${className ?? ''}`}
        disabled={disabled ?? loading}
        {...rest}
      >
        {loading ? (
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : icon ? (
          <span style={{ width: iconSize, height: iconSize, display: 'inline-flex' }}>{icon}</span>
        ) : null}
        {children}
      </button>
    )
  },
)
Button.displayName = 'Button'