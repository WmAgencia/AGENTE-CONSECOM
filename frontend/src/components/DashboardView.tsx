import { useEffect, useMemo, useRef, useState } from 'react'
import { Target, RefreshCw, TrendingUp, CalendarDays, Coins, Users, MessagesSquare, ChevronDown } from 'lucide-react'
import { type Lead } from '../lib/supabase'
import {
  commercialApi,
  formatBRL,
  formatNumber,
  formatMonth,
  type CommercialDashboard,
  type GoalInput,
  type ProjectionResult,
} from '../lib/api'

// ===== ProgressRing (anel de progresso da meta vs real) =====
function ProgressRing({ pct, size = 140 }: { pct: number | null; size?: number }) {
  const r = (size - 14) / 2
  const c = 2 * Math.PI * r
  const safe = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const color = safe >= 100 ? '#22c55e' : safe >= 70 ? '#22c55e' : safe >= 40 ? '#f59e0b' : '#f43f5e'
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="10" fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * safe) / 100}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-2xl font-bold" style={{ color }}>{pct == null ? '—' : `${Math.round(pct)}%`}</div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wide">da meta</div>
      </div>
    </div>
  )
}

// ===== Card base =====
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-white/5 bg-white/[0.02] p-5 ${className}`}>{children}</div>
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Card>
      <div className="text-xs text-slate-400 uppercase tracking-wide">{label}</div>
      <div className={`text-3xl font-bold mt-2 ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </Card>
  )
}

function RateCell({ label, value, tooltip }: { label: string; value: number | null; tooltip?: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5" title={tooltip}>
      <div className="text-xs text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-bold mt-2">
        {value == null ? <span className="text-base text-slate-500 font-normal">Sem dados suficientes</span> : `${value}%`}
      </div>
    </div>
  )
}

// ===== Modal de meta / calculadora de projeção =====
function GoalModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: CommercialDashboard['goal']
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<GoalInput>({
    goal_amount: initial?.goal_amount != null ? Number(initial.goal_amount) : 100000,
    period_days: initial?.period_days ?? 30,
    avg_ticket: initial?.avg_ticket != null ? Number(initial.avg_ticket) : 3000,
    meeting_close_rate: initial?.meeting_close_rate != null ? Number(initial.meeting_close_rate) : 50,
    leads_per_day: initial?.leads_per_day != null ? Number(initial.leads_per_day) : null,
  })
  const [projection, setProjection] = useState<ProjectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const debounceRef = useRef<number | null>(null)

  // Calculadora em tempo real — calcula a projeção SEM persistir.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      commercialApi
        .simulate(form)
        .then(setProjection)
        .catch(() => setProjection(null))
    }, 350)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.goal_amount, form.avg_ticket, form.meeting_close_rate, form.leads_per_day, form.period_days])

  function set<K extends keyof GoalInput>(key: K, value: GoalInput[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await commercialApi.saveGoal(form)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar a meta.')
    } finally {
      setBusy(false)
    }
  }

  const p = projection

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#16161f] p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-indigo-400" />
            <div>
              <div className="font-semibold">Configurar meta comercial</div>
              <div className="text-xs text-slate-400">A projeção é calculada em tempo real conforme você digita</div>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-xs text-slate-400">
            Meta de faturamento (R$)
            <input type="number" min={0} value={form.goal_amount || ''}
              onChange={(e) => set('goal_amount', Number(e.target.value) || 0)}
              className="mt-1 w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          </label>
          <label className="block text-xs text-slate-400">
            Período (dias)
            <select value={form.period_days} onChange={(e) => set('period_days', Number(e.target.value) as 30 | 60 | 90)}
              className="mt-1 w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500">
              <option value={30}>30 dias</option>
              <option value={60}>60 dias</option>
              <option value={90}>90 dias</option>
            </select>
          </label>
          <label className="block text-xs text-slate-400">
            Ticket médio (R$)
            <input type="number" min={0} value={form.avg_ticket || ''}
              onChange={(e) => set('avg_ticket', Number(e.target.value) || 0)}
              className="mt-1 w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          </label>
          <label className="block text-xs text-slate-400">
            Conversão reunião → venda (%)
            <input type="number" min={0} max={100} value={form.meeting_close_rate || ''}
              onChange={(e) => set('meeting_close_rate', Number(e.target.value) || 0)}
              className="mt-1 w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          </label>
          <label className="block text-xs text-slate-400 sm:col-span-2">
            Leads/dia (opcional — para estimar conversões necessárias)
            <input type="number" min={0} value={form.leads_per_day ?? ''}
              onChange={(e) => set('leads_per_day', e.target.value ? Number(e.target.value) : null)}
              placeholder="Ex.: 20"
              className="mt-1 w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          </label>
        </div>

        <div className="mt-5 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-300 uppercase tracking-wide mb-3">
            <TrendingUp className="w-4 h-4" /> Projeção (calculadora)
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-[10px] text-slate-400 uppercase">Vendas necessárias</div>
              <div className="text-lg font-bold">{p ? formatNumber(p.vendasNecessarias) : '…'}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-slate-400 uppercase">Reuniões necessárias</div>
              <div className="text-lg font-bold">{p ? formatNumber(p.reunioesNecessarias) : '…'}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-slate-400 uppercase">Reuniões/dia</div>
              <div className="text-lg font-bold">{p ? formatNumber(p.reunioesPorDia) : '…'}</div>
            </div>
            {p?.leadsPorDia != null && (
              <>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 uppercase">Leads no período</div>
                  <div className="text-lg font-bold">{p.leadsNecessarios != null ? formatNumber(p.leadsNecessarios) : '—'}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 uppercase">Conv. lead→reunião nec.</div>
                  <div className="text-lg font-bold">{p.conversaoLeadReuniaoNecessaria != null ? `${p.conversaoLeadReuniaoNecessaria}%` : '—'}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 uppercase">Conv. lead→venda nec.</div>
                  <div className="text-lg font-bold">{p.conversaoLeadVendaNecessaria != null ? `${p.conversaoLeadVendaNecessaria}%` : '—'}</div>
                </div>
              </>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-rose-400 mt-3">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
          <button onClick={() => void save()} disabled={busy} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium">
            {busy ? 'Salvando...' : 'Salvar meta'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== DashboardView =====
export function DashboardView({ leads }: { leads: Lead[] }) {
  const [data, setData] = useState<CommercialDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showGoal, setShowGoal] = useState(false)
  const [expanded, setExpanded] = useState<'historico' | null>(null)

  async function load() {
    try {
      const d = await commercialApi.dashboard()
      setData(d)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar dashboard.')
    } finally {
      setLoading(false)
    }
  }

  // Recarrega quando os leads mudam (real-time via App) e ao montar.
  const leadsKey = leads.length
  useEffect(() => {
    let active = true
    const t = window.setTimeout(() => {
      void load().then(() => { if (active) setLoading(false) })
    }, 250)
    return () => { active = false; window.clearTimeout(t) }
  }, [leadsKey])

  useEffect(() => {
    void load()
  }, [])

  const goal = data?.goal ?? null
  const real = data?.real
  const projection = data?.projection

  const historico = useMemo(() => real?.historico ?? [], [real])
  const maxHistorico = historico.length > 0 ? Math.max(...historico.map((h) => h.faturamento)) : 0

  return (
    <div className="h-full overflow-auto px-6 py-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="text-lg font-semibold">Metas e Inteligência Comercial</h1>
          <p className="text-sm text-slate-400">Projeção vs resultados reais — tudo com dados reais, sem estimativas fictícias</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} className="flex items-center gap-2 text-xs text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg px-3 py-2 transition">
            <RefreshCw className="w-3.5 h-3.5" /> Atualizar
          </button>
          <button onClick={() => setShowGoal(true)} className="flex items-center gap-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-2 transition">
            <Target className="w-3.5 h-3.5" /> {goal ? 'Editar meta' : 'Configurar meta'}
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-4">
          <div className="h-40 rounded-xl border border-white/5 bg-white/[0.02] animate-pulse" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-xl border border-white/5 bg-white/[0.02] animate-pulse" />)}
          </div>
        </div>
      ) : error ? (
        <Card>
          <p className="text-sm text-rose-400">{error}</p>
          <button onClick={() => void load()} className="mt-3 text-xs text-indigo-300 hover:text-white">Tentar novamente</button>
        </Card>
      ) : real ? (
        <>
          {/* Meta vs Real + faturamento */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-slate-400 uppercase tracking-wide">Faturamento real</div>
                <div className="text-[11px] text-slate-500">Σ vendas fechadas com valor</div>
              </div>
              <div className="text-4xl font-bold">{formatBRL(real.faturamento)}</div>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-white/[0.03] p-3">
                  <div className="text-[10px] text-slate-400 uppercase">Vendas fechadas</div>
                  <div className="text-xl font-semibold">{formatNumber(real.vendas)}</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-3">
                  <div className="text-[10px] text-slate-400 uppercase">Com valor</div>
                  <div className="text-xl font-semibold">{formatNumber(real.vendasComValor)}</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-3">
                  <div className="text-[10px] text-slate-400 uppercase">Leads trabalhados</div>
                  <div className="text-xl font-semibold">{formatNumber(real.leadsTrabalhados)}</div>
                </div>
              </div>
            </Card>

            <Card className="flex flex-col items-center justify-center">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-3">Meta vs real</div>
              {goal ? (
                <>
                  <ProgressRing pct={real.metaAtingida} />
                  <div className="mt-3 text-center text-sm">
                    <span className="text-emerald-300">{formatBRL(real.faturamento)}</span>
                    <span className="text-slate-500"> de </span>
                    <span className="text-slate-200">{formatBRL(goal.goal_amount)}</span>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {real.diasRestantes > 0
                      ? `${real.diasRestantes} dia${real.diasRestantes === 1 ? '' : 's'} restante${real.diasRestantes === 1 ? '' : 's'}`
                      : 'Período encerrado'}
                    {real.rPorDiaNecessario != null && (
                      <> · precisa de <span className="text-indigo-300">{formatBRL(real.rPorDiaNecessario)}/dia</span></>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-3xl font-bold text-slate-600">—</div>
                  <p className="text-sm text-slate-500 mt-3 text-center">
                    Configure uma meta para acompanhar o progresso do faturamento.
                  </p>
                  <button onClick={() => setShowGoal(true)} className="mt-4 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-2">
                    Configurar meta
                  </button>
                </>
              )}
            </Card>
          </div>

          {/* Hoje */}
          <div className="mt-4">
            <h2 className="text-sm font-semibold mb-3 text-slate-300 flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-indigo-400" /> Hoje
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Faturamento hoje" value={formatBRL(real.hoje.faturamento)} accent="text-emerald-300" sub={`${real.hoje.vendas} venda${real.hoje.vendas === 1 ? '' : 's'} hoje`} />
              <StatCard label="Reuniões hoje" value={formatNumber(real.hoje.reunioes)} sub="agendadas para hoje" />
              <StatCard label="Faturamento total" value={formatBRL(real.faturamento)} sub="período da meta" />
            </div>
          </div>

          {/* Projeção vs Real */}
          {goal && projection && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold mb-3 text-slate-300 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-indigo-400" /> Projeção para atingir a meta
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Vendas necessárias" value={formatNumber(projection.vendasNecessarias)} sub="meta ÷ ticket médio" />
                <StatCard label="Reuniões necessárias" value={formatNumber(projection.reunioesNecessarias)} sub={`com ${goal.meeting_close_rate}% de conversão`} />
                <StatCard label="Reuniões/dia" value={formatNumber(projection.reunioesPorDia)} sub={`em ${goal.period_days} dias`} />
                <StatCard label="Leads necessários" value={projection.leadsNecessarios != null ? formatNumber(projection.leadsNecessarios) : '—'} sub={projection.leadsPorDia != null ? `${formatNumber(projection.leadsPorDia)}/dia configurado` : 'Configure leads/dia para calcular'} />
              </div>
            </div>
          )}

          {/* Conversões reais */}
          <div className="mt-6">
            <h2 className="text-sm font-semibold mb-3 text-slate-300 flex items-center gap-2">
              <Coins className="w-4 h-4 text-indigo-400" /> Conversões reais
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <RateCell label="Lead → Reunião" value={real.conversaoLeadReuniao} tooltip={`${real.reunioesMarcadas} reuniões marcadas ÷ ${real.leadsTrabalhados} leads trabalhados`} />
              <RateCell label="Reunião → Venda" value={real.conversaoReuniaoVenda} tooltip={`${real.vendas} vendas ÷ ${real.reunioesRealizadas} reuniões realizadas`} />
              <RateCell label="Lead → Venda" value={real.conversaoLeadVenda} tooltip={`${real.vendas} vendas ÷ ${real.leadsTrabalhados} leads trabalhados`} />
            </div>
          </div>

          {/* Funil */}
          <div className="mt-6">
            <h2 className="text-sm font-semibold mb-3 text-slate-300 flex items-center gap-2">
              <Users className="w-4 h-4 text-indigo-400" /> Funil de conversão
            </h2>
            <Card>
              {real.funnel.map((f, i) => {
                const denom = real.funnel[0]?.value || 0
                const width = denom > 0 ? (f.value / denom) * 100 : 0
                const colors = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-green-500', 'bg-indigo-500']
                return (
                  <div key={f.label} className="flex items-center gap-3 px-1 py-2.5 border-b border-white/5 last:border-0">
                    <span className="w-44 text-xs text-slate-400">{f.label}</span>
                    <div className="flex-1 h-2.5 rounded-full bg-white/5 overflow-hidden">
                      <div className={`h-full ${colors[i % colors.length]}`} style={{ width: `${width}%` }} />
                    </div>
                    <span className="text-xs text-slate-300 w-10 text-right">{f.value}</span>
                  </div>
                )
              })}
            </Card>
          </div>

          {/* Histórico */}
          <div className="mt-6">
            <button
              onClick={() => setExpanded(expanded === 'historico' ? null : 'historico')}
              className="w-full flex items-center justify-between text-sm font-semibold text-slate-300 mb-3 hover:text-white transition"
            >
              <span className="flex items-center gap-2">
                <MessagesSquare className="w-4 h-4 text-indigo-400" /> Faturamento histórico vs meta
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${expanded === 'historico' ? 'rotate-180' : ''}`} />
            </button>
            {expanded === 'historico' && (
              <Card>
                {historico.length === 0 ? (
                  <p className="text-sm text-slate-500">Sem vendas registradas ainda. Feche vendas com valor no Kanban para ver o histórico.</p>
                ) : (
                  <div className="space-y-3">
                    {historico.map((h) => (
                      <div key={h.mes} className="flex items-center gap-3">
                        <span className="w-14 text-xs text-slate-400 uppercase">{formatMonth(h.mes)}</span>
                        <div className="flex-1 h-6 rounded-md bg-white/5 overflow-hidden relative">
                          <div
                            className={`h-full ${goal && h.faturamento >= goal.goal_amount ? 'bg-green-500' : 'bg-indigo-500'}`}
                            style={{ width: `${maxHistorico > 0 ? (h.faturamento / maxHistorico) * 100 : 0}%` }}
                          />
                          <span className="absolute right-2 inset-y-0 flex items-center text-[11px] text-slate-300 font-medium">
                            {formatBRL(h.faturamento)}
                          </span>
                        </div>
                        {goal && <span className="text-[10px] text-slate-500 w-20 text-right">meta {formatBRL(goal.goal_amount)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        </>
      ) : null}

      {showGoal && <GoalModal initial={goal} onClose={() => setShowGoal(false)} onSaved={() => void load()} />}
    </div>
  )
}
