import { useState } from 'react'
import { Download, Link2, CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

// =====================================================================
// App mobile — baixar o APK e conectar o celular à conta já logada.
//
// Fluxo de auto-login (#deep-link):
//   1. Usuário (logado no painel) toca "Conectar neste aparelho".
//   2. Geramos vyntra://auth?access_token=...&refresh_token=...
//      usando a sessão ativa.
//   3. O app (instalado) recebe o link, troca por sessão permanente
//      e entra sem pedir senha.
// =====================================================================

const APK_URL = '/apk/vyntra-mobile-1.1.0.apk'
const APP_VERSION = '1.1.0'

export function MobileAppView() {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    setError(null)
    const { data, error } = await supabase.auth.getSession()
    if (error || !data.session) {
      setError('Sessão expirada. Faça login novamente.')
      return
    }
    const { access_token, refresh_token } = data.session
    const url = `vyntra://auth?access_token=${encodeURIComponent(
      access_token,
    )}&refresh_token=${encodeURIComponent(refresh_token)}`

    // Abre o deep link (app já instalado) OU tenta via redirect
    const win = window.open(url, '_blank')
    if (win) {
      setSent(true)
      window.setTimeout(() => setSent(false), 5000)
    } else {
      setError('Não foi possível abrir o link. Verifique se o app está instalado.')
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
        <div className="flex items-center gap-3 mb-2">
          <img
            src="/vyntra-logo.png"
            alt="Vyntra"
            className="w-10 h-10 rounded-xl object-contain bg-white"
          />
          <div>
            <h2 className="text-lg font-semibold">Vyntra Mobile</h2>
            <p className="text-sm text-slate-400">
              v{APP_VERSION} — Acompanhe reuniões, alarmes e alertas no celular.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 mt-4">
          <a
            href={APK_URL}
            download
            className="flex items-center gap-2 justify-center px-4 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition"
          >
            <Download className="w-4 h-4" />
            Baixar APK (Android)
          </a>
          <button
            onClick={() => void connect()}
            className="flex items-center gap-2 justify-center px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-sm font-medium transition border border-white/10"
          >
            <Link2 className="w-4 h-4 text-indigo-300" />
            Conectar neste aparelho
          </button>
        </div>

        {sent && (
          <div className="mt-4 flex items-center gap-2 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Link enviado ao app. Ele deve abrir sozinho e entrar na sua conta.
          </div>
        )}
        {error && (
          <div className="mt-4 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5">
            {error}
          </div>
        )}

        <ol className="mt-6 space-y-2 text-sm text-slate-400">
          <li>
            1. Baixe o APK e instale no seu celular (permita "fontes desconhecidas").
          </li>
          <li>
            2. Abra o app uma vez — ele exibe "Conecte seu app".
          </li>
          <li>
            3. Volte aqui e toque em <span className="text-slate-200">"Conectar neste aparelho"</span>.
          </li>
        </ol>
      </div>
    </div>
  )
}
