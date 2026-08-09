import { Smartphone, CheckCircle2 } from 'lucide-react'

// Tela exibida quando não há sessão: o usuário conecta o app a partir do
// painel web (já logado) — sem digitar senha. O site abre consecom://auth?...,
// o app troca o token por sessão e entra sozinho.
export function ConnectScreen() {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center mx-auto mb-5">
          <Smartphone className="w-7 h-7 text-white" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Conecte seu app</h1>
        <p className="text-sm text-slate-400 mb-6">
          Este aparelho ainda não está conectado à sua conta. Você pode se
          conectar direto do painel, sem digitar senha.
        </p>

        <ol className="text-left space-y-4 mb-8">
          {[
            'Abra o painel Consecom no computador ou navegador',
            'Acesse a página "App mobile"',
            'Toque em "Conectar neste aparelho"',
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs font-semibold mt-0.5 shrink-0">
                {i + 1}
              </div>
              <span className="text-sm text-slate-300">{step}</span>
            </li>
          ))}
        </ol>

        <div className="text-xs text-slate-500 flex items-center justify-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          Ao abrir o link, este app entra sozinho na sua conta.
        </div>
      </div>
    </div>
  )
}
