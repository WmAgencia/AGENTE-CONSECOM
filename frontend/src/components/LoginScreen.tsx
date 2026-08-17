import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { authLogin } from '../lib/api'
import { ThemeToggle } from './ThemeToggle'
import { Button, Input, Badge } from './ui'

export function LoginScreen() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authLogin(identifier, password)
      const { error } = await supabase.auth.setSession({
        access_token: res.access_token,
        refresh_token: res.refresh_token,
      })
      if (error) setError(error.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao entrar.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{
        background: 'radial-gradient(ellipse 80% 60% at 50% -10%, var(--c-subtle-2), transparent), var(--c-app)',
      }}
    >
      {/* Orbs decorativos (motion sutil via CSS) */}
      <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-40"
        style={{ background: 'radial-gradient(circle, var(--c-accent-200), transparent 70%)', filter: 'blur(80px)' }} />
      <div className="pointer-events-none absolute -bottom-40 -right-40 w-[28rem] h-[28rem] rounded-full opacity-30"
        style={{ background: 'radial-gradient(circle, var(--c-accent-300), transparent 70%)', filter: 'blur(100px)' }} />

      <div className="fixed top-4 right-4 z-50 flex items-center gap-3">
        <Link
          to="/"
          className="text-xs font-medium text-muted hover:text-fg transition-colors px-2 py-1.5 rounded-lg hover:bg-subtle"
        >
          ← Voltar ao site
        </Link>
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[28rem] relative animate-fade-in-up">
        {/* Card */}
        <div className="rounded-3xl border border-line bg-panel/80 backdrop-blur-xl p-8 shadow-3"
          style={{ boxShadow: '0 25px 50px -12px rgba(0,0,0,0.08), 0 0 0 1px var(--c-line)' }}>

          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-2xl font-extrabold text-white shadow-2 mb-4 tracking-tight">
              V
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Vyntra</h1>
            <p className="text-sm text-muted mt-1">Painel de Prospecção Inteligente</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <Input
              label="E-mail ou nome de usuário"
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="voce@empresa.com ou wesleytune"
              autoComplete="username"
              required
            />
            <Input
              label="Senha"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />

            {error && (
              <div className="animate-fade-in">
                <Badge color="rose" size="md" className="w-full justify-center">
                  {error}
                </Badge>
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              className="w-full"
            >
              {loading ? 'Entrando…' : 'Entrar no painel'}
            </Button>
          </form>

          <p className="text-center text-[11px] text-faint mt-6">
            Acesso restrito a usuários autorizados.
          </p>
        </div>
      </div>
    </div>
  )
}