import { useMemo } from 'react'
import { type Lead } from '../lib/supabase'

export function DashboardView({ leads }: { leads: Lead[] }) {
  const stats = useMemo(() => {
    const goridas = leads.length
    const conversando = leads.filter((l) => l.status === 'conversando').length
    const reuniao = leads.filter((l) => l.status === 'reuniao_marcada').length
    const fechados = leads.filter((l) => l.status === 'fechado').length
    const naoFechados = leads.filter((l) => l.status === 'nao_fechado').length
    const semInteresse = leads.filter((l) => l.status === 'sem_interesse').length
    const remarketing = leads.filter((l) => l.status === 'remarketing').length

    const contactados = conversando + reuniao + fechados + naoFechados + semInteresse + remarketing
    const conversaoReuniao = contactados > 0 ? Math.round((reuniao / contactados) * 100) : 0
    const conclusoes = fechados + naoFechados
    const conversaoFechamento = conclusoes > 0 ? Math.round((fechados / conclusoes) * 100) : 0

    return {
      goridas,
      conversando,
      reuniao,
      fechados,
      naoFechados,
      semInteresse,
      remarketing,
      contactados,
      conversaoReuniao,
      conversaoFechamento,
    }
  }, [leads])

  const s = stats

  const cards: { label: string; value: string | number; sub?: string }[] = [
    { label: 'Taxa de conversão (reunião)', value: `${s.conversaoReuniao}%`, sub: `${s.reuniao} reuniões agendadas` },
    { label: 'Taxa de fechamento', value: `${s.conversaoFechamento}%`, sub: `${s.fechados} de ${s.fechados + s.naoFechados} fecharam` },
    { label: 'Conversando', value: String(s.conversando), sub: `${s.contactados} contatados no total` },
    { label: 'Reuniões marcadas', value: String(s.reuniao) },
    { label: 'Fechados', value: String(s.fechados), sub: `${s.naoFechados} não fechados` },
    { label: 'Sem interesse', value: String(s.semInteresse) },
    { label: 'Remarketing', value: String(s.remarketing) },
  ]

  return (
    <div className="h-full overflow-auto px-6 py-5">
      <h1 className="text-lg font-semibold mb-1">Dashboard</h1>
      <p className="text-sm text-slate-400 mb-6">Métricas estilo Power BI · a IA se autotraina a cada conversa</p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
            <div className="text-xs text-slate-400 uppercase tracking-wide">{c.label}</div>
            <div className="text-3xl font-bold mt-2">{c.value}</div>
            {c.sub && <div className="text-xs text-slate-500 mt-1">{c.sub}</div>}
          </div>
        ))}
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-semibold mb-3 text-slate-300">Funil de conversão</h2>
        <div className="rounded-xl border border-white/5 overflow-hidden">
          {[
            { label: 'Contatados', value: s.contactados, color: 'bg-sky-500' },
            { label: 'Conversando', value: s.conversando, color: 'bg-violet-500' },
            { label: 'Reunião marcada', value: s.reuniao, color: 'bg-emerald-500' },
            { label: 'Fechado', value: s.fechados, color: 'bg-green-500' },
          ].map((f) => (
            <div key={f.label} className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5 last:border-0">
              <span className="w-40 text-xs text-slate-400">{f.label}</span>
              <div className="flex-1 h-2.5 rounded-full bg-white/5 overflow-hidden">
                <div className={`h-full ${f.color}`} style={{ width: s.contactados > 0 ? `${(f.value / s.contactados) * 100}%` : '0%' }} />
              </div>
              <span className="text-xs text-slate-300 w-10 text-right">{f.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}