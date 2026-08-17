import { useEffect, useMemo, useState } from 'react'
import { Check, Sparkles, ShoppingCart, Loader2, ArrowLeft, CreditCard, Zap, ShieldCheck, QrCode, Copy } from 'lucide-react'
import { saasApi, formatBRL, type SaasPlan, type SaasMe } from '../lib/api'
import { LeadsWidget } from './LeadsWidget'
import { Button } from './ui'

type MercadoClient = {
  createCardToken(input: Record<string, string>): Promise<{ id?: string }>
  getPaymentMethods(input: { bin: string }): Promise<Array<{ id?: string; issuer?: { id?: string } }>>
}

async function loadMercadoClient(): Promise<MercadoClient> {
  const key = await saasApi.paymentPublicKey()
  if (!key) throw new Error('O gateway ainda não está configurado para cartão.')
  const current = (window as unknown as { MercadoPago?: (publicKey: string, options: { locale: string }) => MercadoClient }).MercadoPago
  if (current) return current(key, { locale: 'pt-BR' })
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://sdk.mercadopago.com/js/v2'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Não foi possível carregar o checkout seguro.'))
    document.head.appendChild(script)
  })
  const factory = (window as unknown as { MercadoPago?: (publicKey: string, options: { locale: string }) => MercadoClient }).MercadoPago
  if (!factory) throw new Error('SDK do Mercado Pago indisponível.')
  return factory(key, { locale: 'pt-BR' })
}

interface Props {
  onBack?: () => void
}

/** Página premium de planos com checkout integrado (fluxo completo). */
export function PlansPage({ onBack }: Props) {
  const [plans, setPlans] = useState<SaasPlan[]>([])
  const [me, setMe] = useState<SaasMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SaasPlan | null>(null)
  const [coupon, setCoupon] = useState('')
  const [couponInfo, setCouponInfo] = useState<{ ok: boolean; discountAmount?: number; total?: number; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [method, setMethod] = useState<'pix' | 'card'>('pix')
  const [cpf, setCpf] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [card, setCard] = useState({ number: '', holder: '', month: '', year: '', cvv: '' })
  const [pix, setPix] = useState<{ code: string; image?: string } | null>(null)

  const sorted = useMemo(() => [...plans].sort((a, b) => a.display_order - b.display_order), [plans])
  const featured = sorted.find((p) => p.featured)
  const currentPlanId = me?.plan?.id ?? null

  useEffect(() => {
    ;(async () => {
      try {
        const [p, m] = await Promise.all([saasApi.plans(), saasApi.me()])
        setPlans(p)
        setMe(m)
        setEmail(m.user.email)
      } catch {
        /* err handled below */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function validateCoupon() {
    setCouponInfo(null)
    if (!selected) return
    if (!coupon.trim()) { setCouponInfo(null); return }
    try {
      const r = await saasApi.validateCoupon(coupon, selected.id)
      if (r.ok) setCouponInfo({ ok: true, discountAmount: r.discountAmount, total: r.total })
      else setCouponInfo({ ok: false, error: 'Cupom inválido.' })
    } catch {
      setCouponInfo({ ok: false, error: 'Cupom não pode ser validado agora.' })
    }
  }

  async function buy() {
    if (!selected) return
    setMsg(null)
    setBusy(true)
    try {
      let cardToken: string | undefined
      let paymentMethodId: string | undefined
      let issuerId: string | undefined
      if (method === 'card') {
        const mp = await loadMercadoClient()
        const token = await mp.createCardToken({ cardNumber: card.number.replace(/\s/g, ''), cardholderName: card.holder, cardExpirationMonth: card.month, cardExpirationYear: card.year, securityCode: card.cvv, identificationType: 'CPF', identificationNumber: cpf.replace(/\D/g, '') })
        if (!token.id) throw new Error('Não foi possível validar o cartão.')
        cardToken = token.id
        const methods = await mp.getPaymentMethods({ bin: card.number.replace(/\D/g, '').slice(0, 6) })
        paymentMethodId = methods[0]?.id
        issuerId = methods[0]?.issuer?.id
        if (!paymentMethodId) throw new Error('Bandeira do cartão não identificada.')
      }
      const r = await saasApi.transparentPayment({ planId: selected.id, couponCode: coupon.trim() || undefined, method, cpf, phone, email, paymentMethodId, cardToken, installments: 1, issuerId })
      if (method === 'pix' && r.qrCode) {
        setPix({ code: r.qrCode, image: r.qrCodeBase64 ?? undefined })
        setMsg({ ok: true, text: 'Pix criado. Pague pelo QR Code ou copie o código abaixo.' })
      } else {
        const m = await saasApi.me()
        setMe(m)
        setMsg({ ok: true, text: r.status === 'approved' ? 'Pagamento aprovado. Seu saldo de leads foi liberado!' : 'Pagamento recebido e aguardando confirmação.' })
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha no checkout.' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-accent-400" />
          <span className="text-sm text-muted">Carregando planos…</span>
        </div>
      </div>
    )
  }

  // Checkout: fluxo concentrado em um card com resumo.
  if (selected) {
    return (
      <div className="h-full overflow-auto">
        <div className="max-w-3xl mx-auto p-6 space-y-5">
          <button onClick={() => setSelected(null)} className="inline-flex items-center gap-2 text-sm text-muted hover:text-fg transition">
            <ArrowLeft className="w-4 h-4" />
            Voltar para os planos
          </button>

          <div className="rounded-2xl border border-line bg-subtle p-6 space-y-5" style={{ boxShadow: 'var(--shadow-2)' }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold">{selected.name}</h2>
                  {selected.badge_label && (
                    <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-accent-600/20 text-accent-300">MAIS ESCOLHIDO</span>
                  )}
                </div>
                <p className="text-sm text-muted mt-1">{selected.description ?? selected.name}</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-extrabold text-accent-300">{formatBRL(selected.price)}</div>
                <div className="text-xs text-faint">pagamento único</div>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2 rounded-xl border border-line bg-fg/5 px-3 py-2.5">
                <Zap className="w-4 h-4 text-accent-400" />
                <span><b>{selected.lead_limit}</b> leads</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-fg/5 px-3 py-2.5">
                <Sparkles className="w-4 h-4 text-accent-400" />
                <span>{selected.campaign_equivalence >= 999 ? 'Campanhas ilimitadas' : `${selected.campaign_equivalence} campanhas`}</span>
              </div>
            </div>

            {Array.isArray(selected.features) && selected.features.length > 0 && (
              <ul className="space-y-1.5">
                {selected.features.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-secondary">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    {String(f)}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={coupon}
                onChange={(e) => setCoupon(e.target.value)}
                placeholder="Cupom de desconto"
                className="input flex-1"
                disabled={busy}
              />
              <Button variant="outline" onClick={validateCoupon} disabled={busy || !coupon.trim()} size="md">
                Validar
              </Button>
            </div>
            {couponInfo && (
              <p className={`text-xs ${couponInfo.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {couponInfo.ok
                  ? `Desconto de ${formatBRL(couponInfo.discountAmount ?? 0)} — total ${formatBRL(couponInfo.total ?? selected.price)}`
                  : couponInfo.error}
              </p>
            )}

            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setMethod('pix')} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${method === 'pix' ? 'border-accent-500 bg-accent-600/15 text-accent-300' : 'border-line bg-subtle text-muted'}`}><QrCode className="inline w-4 h-4 mr-1" /> Pix</button>
              <button type="button" onClick={() => setMethod('card')} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${method === 'card' ? 'border-accent-500 bg-accent-600/15 text-accent-300' : 'border-line bg-subtle text-muted'}`}><CreditCard className="inline w-4 h-4 mr-1" /> Cartão</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF" inputMode="numeric" className="input" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Celular" inputMode="tel" className="input" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" type="email" className="input sm:col-span-1" />
            </div>
            {method === 'card' && (
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} placeholder="Número do cartão" inputMode="numeric" className="input sm:col-span-2" />
                <input value={card.holder} onChange={(e) => setCard({ ...card, holder: e.target.value })} placeholder="Nome no cartão" className="input sm:col-span-2" />
                <input value={card.month} onChange={(e) => setCard({ ...card, month: e.target.value })} placeholder="Mês" inputMode="numeric" className="input" />
                <input value={card.year} onChange={(e) => setCard({ ...card, year: e.target.value })} placeholder="Ano" inputMode="numeric" className="input" />
                <input value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value })} placeholder="CVV" inputMode="numeric" className="input" />
              </div>
            )}
            {pix && (
              <div className="rounded-xl border border-accent-500/25 bg-accent-500/5 p-4 space-y-3 text-center">
                {pix.image && <img src={`data:image/png;base64,${pix.image}`} alt="QR Code Pix" className="mx-auto w-44 h-44" />}
                <button type="button" onClick={() => void navigator.clipboard.writeText(pix.code)} className="inline-flex items-center gap-2 text-xs text-accent-300 hover:text-accent-200"><Copy size={14} /> Copiar código Pix</button>
              </div>
            )}

            <div className="rounded-xl border border-line bg-fg/5 px-4 py-3 flex items-center gap-3 text-sm">
              <CreditCard className="w-5 h-5 text-accent-400" />
              <div className="flex-1">
                <div className="font-semibold">{formatBRL(couponInfo?.ok ? (couponInfo.total ?? selected.price) : selected.price)}</div>
                <div className="text-xs text-faint">Plano {selected.name} · {selected.lead_limit} leads</div>
              </div>
              <div className="text-[10px] text-faint uppercase tracking-wide px-2 py-1 rounded-full bg-subtle-2">Checkout seguro</div>
            </div>

            {msg && <p className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}

            <Button size="lg" loading={busy} className="w-full" onClick={buy} disabled={currentPlanId === selected.id}>
              {busy ? 'Processando…' : currentPlanId === selected.id ? 'Plano ativo' : `Assinar ${selected.name}`}
            </Button>
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-faint">
              <ShieldCheck className="w-3.5 h-3.5" />
              Pagamento processado por gateway seguro. Você recebe os leads na hora.
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="text-center space-y-2 pt-2">
          <h1 className="text-2xl font-extrabold tracking-tight">Escolha o seu plano</h1>
          <p className="text-sm text-muted max-w-xl mx-auto">
            Leve o Vyntra para o seu processo comercial. Quanto maior o plano, mais leads e campanhas você opera em paralelo.
          </p>
        </div>

        <div className="max-w-md mx-auto">
          <LeadsWidget onBuy={() => undefined} />
        </div>

        <div className="grid md:grid-cols-3 gap-4 items-stretch">
          {sorted.map((p) => {
            const isFeatured = p.featured || (featured && p.id === featured.id)
            return (
              <div
                key={p.id}
                className={`relative rounded-2xl border p-5 flex flex-col gap-3 transition-all duration-200 hover:-translate-y-0.5 ${
                  isFeatured
                    ? 'border-accent-400/50 bg-accent-600/5'
                    : 'border-line bg-subtle'
                }`}
                style={{ boxShadow: isFeatured ? '0 0 0 1px var(--c-accent-400), 0 16px 40px -20px var(--c-accent-400)' : 'var(--shadow-2)' }}
              >
                {isFeatured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-accent-600 text-white shadow-2">
                    MAIS ESCOLHIDO
                  </span>
                )}
                <div className="flex items-center justify-between">
                  <span className="font-bold text-lg">{p.name}</span>
                  {p.badge_label && !isFeatured && (
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-subtle-2 text-faint">{p.badge_label}</span>
                  )}
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-extrabold">{formatBRL(p.price)}</span>
                  <span className="text-xs text-faint">/ único</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Zap className={`w-4 h-4 ${isFeatured ? 'text-accent-300' : 'text-faint'}`} />
                  <span><b>{p.lead_limit}</b> leads</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Sparkles className={`w-4 h-4 ${isFeatured ? 'text-accent-300' : 'text-faint'}`} />
                  <span>{p.campaign_equivalence >= 999 ? 'Campanhas ilimitadas' : `${p.campaign_equivalence} campanhas`}</span>
                </div>
                <p className="text-xs text-muted leading-snug">{p.description}</p>
                {Array.isArray(p.features) && p.features.length > 0 && (
                  <ul className="space-y-1.5 mt-auto">
                    {p.features.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs text-secondary">
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        {String(f)}
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  variant={isFeatured ? 'primary' : 'outline'}
                  className="w-full mt-2"
                  disabled={currentPlanId === p.id}
                  onClick={() => setSelected(p)}
                >
                  {currentPlanId === p.id ? (
                    'Plano atual'
                  ) : (
                    <>
                      <ShoppingCart className="w-4 h-4" />
                      {p.slug === 'teste' ? 'Ativar teste' : 'Assinar'}
                    </>
                  )}
                </Button>
              </div>
            )
          })}
        </div>

        {sorted.length === 0 && (
          <div className="text-center text-sm text-muted py-12">Nenhum plano disponível no momento.</div>
        )}

        <div className="flex justify-center pt-2">
          <Button variant="ghost" onClick={onBack ?? (() => window.history.back())}>
            Voltar ao painel
          </Button>
        </div>
      </div>
    </div>
  )
}
