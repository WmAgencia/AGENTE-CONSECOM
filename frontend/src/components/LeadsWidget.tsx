import { useEffect, useState } from 'react'
import { Zap, ShoppingCart } from 'lucide-react'
import { saasApi, type SaasBalance, type SaasMe, type SaasPlan } from '../lib/api'

export type LeadsLevel = 'none' | 'normal' | 'low' | 'critical' | 'zero'

export function levelFromBalance(b: SaasBalance | null): LeadsLevel {
  if (!b || !b.limited || b.acquired <= 0) return 'none'
  if (b.available <= 0) return 'zero'
  const pct = (b.available / b.acquired) * 100
  if (pct <= 15) return 'critical'
  if (pct <= 40) return 'low'
  return 'normal'
}

const LEVEL_META: Record<LeadsLevel, { label: string; bar: string; text: string; ring: string }> = {
  none: { label: 'Sem plano', bar: 'bg-subtle-2', text: 'text-muted', ring: 'border-line-2' },
  normal: { label: 'Disponível', bar: 'bg-accent-500', text: 'text-accent-300', ring: 'border-accent-500/40' },
  low: { label: 'Acabando', bar: 'bg-amber-400', text: 'text-amber-300', ring: 'border-amber-400/40' },
  critical: { label: 'Crítico', bar: 'bg-rose-500', text: 'text-rose-400', ring: 'border-rose-500/40' },
  zero: { label: 'Esgotado', bar: 'bg-rose-600', text: 'text-rose-400', ring: 'border-rose-500/50' },
}

interface Props {
  compact?: boolean
  onBuy?: () => void
}

/**
 * Widget "Seus leads": saldo em tempo real (adquiridos - consumidos),
 * barra de progresso e alerta de consumo. Usado no sidebar (compact)
 * e na página de planos/checkout (com CTA).
 */
export function LeadsWidget({ compact, onBuy }: Props) {
  const [me, setMe] = useState<SaasMe | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    saasApi.me().then((m) => alive && setMe(m)).catch(() => alive && setMe(null)).finally(() => alive && setLoading(false))
    const poll = window.setInterval(() => {
      saasApi.me().then((m) => alive && setMe(m)).catch(() => undefined)
    }, 60_000)
    return () => {
      alive = false
      window.clearInterval(poll)
    }
  }, [])

  const balance: SaasBalance | null = me?.balance ?? null
  const level = levelFromBalance(balance)
  const meta = LEVEL_META[level]
  const pct = balance && balance.acquired > 0 ? Math.min(100, Math.round((balance.used / balance.acquired) * 100)) : 0
  const plan: SaasPlan | null = me?.plan ?? null

  if (loading) {
    return (
      <div className="rounded-xl border border-line bg-subtle p-3 space-y-2 animate-pulse-soft">
        <div className="h-3 w-20 bg-subtle-2 rounded" />
        <div className="h-2 w-full bg-subtle-2 rounded-full" />
      </div>
    )
  }

  if (!balance || level === 'none') {
    return (
      <div className={`rounded-xl border ${meta.ring} bg-subtle p-3 space-y-2`}>
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-faint" />
          <span className="text-xs font-semibold text-secondary">Seus leads</span>
        </div>
        <p className="text-xs text-muted leading-snug">
          Sem plano ativo. Comece com o <b>TESTE</b> (250 leads) e escale quando quiser.
        </p>
        {onBuy && (
          <button
            onClick={onBuy}
            className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 active:bg-accent-700 transition-all duration-200"
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            Ver planos
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`rounded-xl border ${meta.ring} bg-subtle p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className={`w-3.5 h-3.5 ${meta.text}`} />
          <span className="text-xs font-semibold text-secondary">Seus leads</span>
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-subtle-2 ${meta.text}`}>
          {meta.label}
        </span>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <span className="text-xl font-bold text-fg leading-none">{balance.available}</span>
          <span className="text-xs text-faint ml-1">disponíveis</span>
        </div>
        <div className="text-right text-[11px] text-faint">
          <div>{balance.used} usados</div>
          <div className="font-mono">{plan?.name ?? ''}</div>
        </div>
      </div>

      <div className="h-2 rounded-full bg-subtle-2 overflow-hidden" title={`${balance.used} de ${balance.acquired} leads usados`}>
        <div className={`h-full ${meta.bar} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>

      {level === 'zero' || level === 'critical' ? (
        <div className={`text-[11px] leading-snug ${meta.text}`}>
          {level === 'zero'
            ? 'Você atingiu o limite do plano. Compre mais leads para continuar.'
            : 'Seu saldo de leads está quase no fim. Garanta mais antes de esgotar.'}
        </div>
      ) : null}

      {onBuy && (
        <button
          onClick={onBuy}
          className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 active:bg-accent-700 transition-all duration-200"
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          Comprar mais leads
        </button>
      )}

      {compact && level !== 'normal' && (
        <div className={`text-[10px] ${meta.text}`}>
          {pct}% do plano consumido
        </div>
      )}
    </div>
  )
}