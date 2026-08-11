import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'consecom-theme'

export const DEFAULT_THEME: Theme = 'light'

/** Aplica o tema no <html> (data-theme) e persiste a escolha. */
export function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark'
  } else {
    delete document.documentElement.dataset.theme
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // localStorage indisponível (modo privado) — segue apenas em memória.
  }
}

/** Tema salvo pelo usuário; padrão claro. */
export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'dark' ? 'dark' : 'light'
  } catch {
    return DEFAULT_THEME
  }
}

interface ThemeContextValue {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/** Provê o tema atual para todos os ThemeToggle (sidebar, mobile e login). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme())

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}

/** Hook do tema: retorna o tema atual e uma função que alterna entre eles. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    const initial = getStoredTheme()
    return { theme: initial, toggleTheme: () => applyTheme(initial === 'dark' ? 'light' : 'dark') }
  }
  return ctx
}
