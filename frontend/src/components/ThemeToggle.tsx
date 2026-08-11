import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'

/** Botão de troca de tema (claro/escuro). Usa as cores do tema atual. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      title={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
      aria-label={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
      className={`p-2 rounded-lg text-muted hover:text-fg hover:bg-subtle transition ${className}`}
    >
      {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
    </button>
  )
}
