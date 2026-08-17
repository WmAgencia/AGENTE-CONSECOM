import { useEffect, useState } from 'react'
import { LogOut, Zap, ShoppingCart, ArrowDownToLine, History, ShieldCheck, Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  saasApi,
  authUpdateUsername,
  type SaasMe,
  type CreditTransaction,
} from '../lib/api'
import { Button } from './ui'
import { LeadsWidget } from './LeadsWidget'
import { useNavigate } from 'react-router-dom'

const KIND_META: Record<CreditTransaction['kind'], { label: string; cls: string }> = {
  purchase: { label: 'Compra', cls: 'text-emerald-400' },
  trial: { label: 'Plano TESTE', cls: 'text-accent-300' },
  consumption: { label: 'Consumo', cls: 'text-amber-400' },
  refund: { label: 'Reembolso', cls: 'text-sky-400' },
  adjustment: { label: 'Ajuste', cls: 'text-faint' },
}

export function ContaPage() {
  const navigate = useNavigate()
  const [me, setMe] = useState<SaasMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Nome de usuário
  const [username, setUsername] = useState('')
  const [userMsg, setUserMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [userBusy, setUserBusy] = useState(false)

  // Segurança
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pwdBusy, setPwdBusy] = useState(false)

  // Plano TESTE
  const [trialBusy, setTrialBusy] = useState(false)
  const [trialMsg, setTrialMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const m = await saasApi.me()
        setMe(m)
        setUsername(m.user.username ?? '')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Falha ao carregar a conta')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function saveUsername() {
    setUserMsg(null)
    if (!username.trim()) {
      setUserMsg({ ok: false, text: 'Digite um nome de usuário.' })
      return
    }
    setUserBusy(true)
    try {
      const saved = await authUpdateUsername(username.trim())
      setUserMsg({ ok: true, text: 'Nome de usuário atualizado.' })
      setMe((m) => (m ? { ...m, user: { ...m.user, username: saved } } : m))
    } catch (e) {
      setUserMsg({ ok: false, text: e instanceof Error ? e.message : 'Não foi possível salvar.' })
    } finally {
      setUserBusy(false)
    }
  }

  async function logout() {
    await supabase.auth.signOut()
  }

  async function changePassword() {
    setPwdMsg(null)
    if (!cur || !next || !confirm) {
      setPwdMsg({ ok: false, text: 'Preencha senha atual, nova e confirmação.' })
      return
    }
    if (next !== confirm) {
      setPwdMsg({ ok: false, text: 'Nova senha e confirmação não conferem.' })
      return
    }
    setPwdBusy(true)
    try {
      await saasApi.changePassword(cur, next, confirm)
      setPwdMsg({ ok: true, text: 'Senha alterada com sucesso.' })
      setCur(''); setNext(''); setConfirm('')
    } catch (e) {
      setPwdMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao alterar a senha.' })
    } finally {
      setPwdBusy(false)
    }
  }

  async function activateTrial() {
    setTrialMsg(null)
    setTrialBusy(true)
    try {
      const deviceId = localStorage.getItem('vyntra-device-id')
      await saasApi.redeemTrial(deviceId ?? undefined)
      const m = await saasApi.me()
      setMe(m)
      setTrialMsg({ ok: true, text: 'Plano TESTE ativado! Seus 250 leads de teste já estão disponíveis.' })
    } catch (e) {
      setTrialMsg({ ok: false, text: e instanceof Error ? e.message : 'Não foi possível ativar o TESTE.' })
    } finally {
      setTrialBusy(false)
    }
  }

  if (loading) return <div className="h-full flex items-center justify-center text-muted">Carregando…</div>
  if (error) return <div className="p-8 text-red-400">{error}</div>
  if (!me) return <div className="h-full flex items-center justify-center text-muted">Sua conta não pôde ser carregada.</div>

  const plan = me.plan
  const isTrial = plan?.slug === 'teste'

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Minha conta</h1>
          <button
            onClick={() => void logout()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 transition"
            title="Sair da conta"
          >
            <LogOut className="w-4 h-4" />
            Sair da conta
          </button>
        </div>

        {/* Plano + saldo em tempo real */}
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Plano atual</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-accent-600/20 text-accent-300">
              {plan ? plan.name : 'Sem plano'}
            </span>
          </div>

          <LeadsWidget onBuy={() => navigate('/planos')} />

          {plan ? (
            <div className="text-sm text-muted flex items-center gap-2">
              <Zap className="w-4 h-4 text-accent-400" />
              {plan.description ?? plan.name}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted">Você ainda não tem um plano ativo.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => navigate('/planos')} icon={<ShoppingCart className="w-4 h-4" />}>
                  Ver planos
                </Button>
                {!me.trialUsed && !isTrial && (
                  <Button variant="outline" onClick={activateTrial} loading={trialBusy} icon={<Sparkles className="w-4 h-4" />}>
                    {trialBusy ? 'Ativando…' : 'Ativar plano TESTE grátis'}
                  </Button>
                )}
              </div>
              {trialMsg && <p className={`text-xs ${trialMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{trialMsg.text}</p>}
              {me.trialUsed && !isTrial && (
                <p className="text-xs text-faint flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Você já utilizou o plano TESTE desta conta.
                </p>
              )}
            </div>
          )}

          {plan && plan.slug !== 'teste' && !me.trialUsed && (
            <Button variant="outline" size="sm" onClick={activateTrial} loading={trialBusy}>
              {trialBusy ? 'Ativando…' : 'Ativar plano TESTE'}
            </Button>
          )}
        </section>

        {/* Histórico de compras e consumo */}
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-faint" />
            <h2 className="text-sm font-semibold">Movimentações de leads</h2>
          </div>
          {me.ledger && me.ledger.length > 0 ? (
            <div className="divide-y divide-line">
              {me.ledger.map((t) => {
                const meta = KIND_META[t.kind]
                const d = t.delta > 0 ? `+${t.delta}` : String(t.delta)
                return (
                  <div key={t.id} className="flex items-center justify-between py-2.5 text-sm">
                    <div className="min-w-0">
                      <span className={`font-semibold ${meta.cls}`}>{meta.label}</span>
                      <span className="text-xs text-faint ml-2">{t.note ?? ''}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`font-mono font-bold ${t.delta > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{d} leads</span>
                      <span className="text-[11px] text-faint w-20 text-right">
                        {new Date(t.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-sm text-muted flex items-center gap-2">
              <ArrowDownToLine className="w-4 h-4 text-faint" />
              Nenhuma movimentação ainda. {plan ? 'Importe leads pela extensão para ver o consumo aqui.' : 'Escolha um plano para começar.'}
            </div>
          )}
        </section>

        {/* Perfil */}
        <section className="rounded-xl border border-line bg-subtle p-5">
          <h2 className="text-sm font-semibold mb-3">Perfil</h2>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div><div className="text-faint text-xs">E-mail</div><div>{me.user.email}</div></div>
            <div><div className="text-faint text-xs">Papel</div><div>{me.user.role === 'MASTER' ? 'Administrador' : 'Usuário'}</div></div>
            <div><div className="text-faint text-xs">Status</div><div className={me.user.status === 'active' ? 'text-emerald-400' : 'text-red-400'}>{me.user.status === 'active' ? 'Ativo' : 'Bloqueado'}</div></div>
            <div><div className="text-faint text-xs">Tenant</div><div className="font-mono text-xs break-all">{me.tenantId}</div></div>
          </div>

          {/* Nome de usuário */}
          <div className="mt-4 pt-4 border-t border-line">
            <div className="text-xs text-faint mb-1">Nome de usuário (login por usuário)</div>
            <div className="flex items-center gap-2 max-w-md">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="escolha um usuário (ex.: wesleytune)"
                className="input flex-1"
              />
              <Button onClick={() => void saveUsername()} loading={userBusy} className="flex items-center gap-2">
                {userBusy ? 'Salvando…' : 'Salvar'}
              </Button>
            </div>
            {userMsg && <p className={`text-xs mt-2 ${userMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{userMsg.text}</p>}
          </div>
        </section>

        {/* Segurança */}
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-3">
          <h2 className="text-sm font-semibold">Segurança</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <input type="password" placeholder="Senha atual" value={cur} onChange={(e) => setCur(e.target.value)}
              className="input" />
            <input type="password" placeholder="Nova senha (mín. 8)" value={next} onChange={(e) => setNext(e.target.value)}
              className="input" />
            <input type="password" placeholder="Confirmar nova senha" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              className="input sm:col-span-2" />
          </div>
          {pwdMsg && <p className={`text-xs ${pwdMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{pwdMsg.text}</p>}
          <Button onClick={changePassword} loading={pwdBusy}>
            {pwdBusy ? 'Alterando…' : 'Alterar senha'}
          </Button>
        </section>
      </div>
    </div>
  )
}