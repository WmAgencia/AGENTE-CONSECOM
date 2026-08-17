import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { saasApi, authUpdateUsername, formatBRL, type SaasMe, type SaasPlan } from '../lib/api'
import { Button, Input } from './ui'

export function ContaPage() {
  const [me, setMe] = useState<SaasMe | null>(null)
  const [plans, setPlans] = useState<SaasPlan[]>([])
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

  // Checkout
  const [coupon, setCoupon] = useState('')
  const [buyBusy, setBuyBusy] = useState(false)
  const [buyMsg, setBuyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [couponInfo, setCouponInfo] = useState<{ total?: number; discountAmount?: number } | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const [m, p] = await Promise.all([saasApi.me(), saasApi.plans()])
        setMe(m)
        setPlans(p)
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

  async function validateCouponFor(plan: SaasPlan) {
    if (!coupon.trim()) { setCouponInfo(null); return }
    try {
      const r = await saasApi.validateCoupon(coupon, plan.id)
      if (r.ok) setCouponInfo({ total: r.total, discountAmount: r.discountAmount })
      else setCouponInfo(null)
    } catch {
      setCouponInfo(null)
    }
  }

  async function buy(plan: SaasPlan) {
    setBuyMsg(null)
    setBuyBusy(true)
    try {
      const r = await saasApi.checkout(plan.id, coupon.trim() || undefined, window.location.href)
      if (r.checkoutUrl) {
        window.location.href = r.checkoutUrl
        return
      }
      setBuyMsg({ ok: true, text: 'Pagamento processado (modo teste). Assinatura ativada!' })
      const m = await saasApi.me()
      setMe(m)
    } catch (e) {
      setBuyMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha no checkout.' })
    } finally {
      setBuyBusy(false)
    }
  }

  if (loading) return <div className="h-full flex items-center justify-center text-muted">Carregando…</div>
  if (error) return <div className="p-8 text-red-400">{error}</div>
  if (!me) return <div className="h-full flex items-center justify-center text-muted">Sua conta não pôde ser carregada.</div>

  const plan = me.plan
  const usedPct = me.usage.lead_limit > 0 ? Math.min(100, Math.round((me.usage.leads_used / me.usage.lead_limit) * 100)) : 0

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

        {/* Perfil + plano */}
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

        {/* Plano atual + uso */}
        <section className="rounded-xl border border-line bg-subtle p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Plano atual</h2>
<span className="text-xs px-2 py-0.5 rounded-full bg-accent-600/20 text-accent-300">
            {plan ? plan.name : 'Sem plano'}
          </span>
          </div>
          {plan ? (
            <>
              <p className="text-sm text-muted mb-3">{plan.description ?? plan.name}</p>
              <div className="flex justify-between text-xs text-muted mb-1">
                <span>{me.usage.leads_used} de {me.usage.lead_limit} leads usados</span>
                <span>{usedPct}%</span>
              </div>
              <div className="h-2 rounded-full bg-subtle-2 overflow-hidden">
                <div className="h-full bg-accent-500 transition-all" style={{ width: `${usedPct}%` }} />
              </div>
              {me.usage.leads_remaining <= 0 && me.usage.lead_limit > 0 && (
                <p className="text-xs text-red-400 mt-2">Você atingiu o limite de leads do plano. Assine um novo plano para continuar.</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">Você ainda não tem um plano ativo.</p>
          )}
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

        {/* Planos */}
        <section className="rounded-xl border border-line bg-subtle p-5">
          <h2 className="text-sm font-semibold mb-3">Planos disponíveis</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {plans.map((p) => (
              <div key={p.id} className="rounded-lg border border-line bg-fg/5 p-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-sm text-accent-300">{formatBRL(p.price)}</span>
                </div>
                {p.description && <p className="text-xs text-muted">{p.description}</p>}
                <p className="text-xs text-muted">{p.lead_limit} leads</p>
                {p.lead_limit > 0 && (
                  <Button onClick={() => buy(p)} loading={buyBusy} size="sm" className="mt-1">
                  {buyBusy ? 'Processando…' : plan?.id === p.id ? 'Ativo' : 'Assinar'}
                </Button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Input
              placeholder="Cupom de desconto"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              className="max-w-xs"
            />
            {plans[0] && (
              <Button onClick={() => validateCouponFor(plans[0])} size="sm">
                Validar
              </Button>
            )}
          </div>
          {couponInfo && (
            <p className="text-xs text-emerald-400 mt-2">
              Desconto aplicado: {formatBRL(couponInfo.discountAmount ?? 0)} · Total: {formatBRL(couponInfo.total ?? 0)}
            </p>
          )}
          {buyMsg && <p className={`text-xs mt-2 ${buyMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{buyMsg.text}</p>}
        </section>
      </div>
    </div>
  )
}