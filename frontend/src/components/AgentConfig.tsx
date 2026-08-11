import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface AgentCfg {
  agent_name: string
  company: string
  greeting: string
  objective: string
  service: string
  project: string
  remarket_active: boolean
  remarket_days: number
  remarket_message: string
  no_interest_months: number
}

const DEFAULTS: AgentCfg = {
  agent_name: '',
  company: '',
  greeting: 'Olá! Meu nome é {nome_ia}, da {empresa}.',
  objective: 'Apresentar nosso serviço/projeto e marcar uma reunião com o responsável.',
  service: 'Descreva aqui o serviço ou projeto que o agente apresenta.',
  project: '',
  remarket_active: false,
  remarket_days: 1,
  remarket_message: 'E aí, conseguiu olhar a mensagem que enviei ontem? Posso te passar mais detalhes :)',
  no_interest_months: 6,
}

export function AgentConfig() {
  const [cfg, setCfg] = useState<AgentCfg>({ ...DEFAULTS, project: '' })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const { data, error } = await supabase.from('agent_settings').select('*')
    if (error) return
    if (data?.length) {
      const map: Record<string, unknown> = {}
      data.forEach((r) => { map[r.key] = r.value })
      setCfg({
        agent_name: (map.agent_name as string) ?? DEFAULTS.agent_name,
        company: (map.company as string) ?? DEFAULTS.company,
        greeting: (map.greeting as string) ?? DEFAULTS.greeting,
        objective: (map.objective as string) ?? DEFAULTS.objective,
        service: (map.service as string) ?? DEFAULTS.service,
        project: (map.project as string) ?? DEFAULTS.project,
        remarket_active: (map.remarket_active as boolean) ?? DEFAULTS.remarket_active,
        remarket_days: (map.remarket_days as number) ?? DEFAULTS.remarket_days,
        remarket_message: (map.remarket_message as string) ?? DEFAULTS.remarket_message,
        no_interest_months: (map.no_interest_months as number) ?? DEFAULTS.no_interest_months,
      })
    }
  }

  async function save() {
    setSaved(false)
    const rows = Object.entries(cfg).map(([k, v]) => ({ key: k, value: v, updated_at: new Date().toISOString() }))
    const { error } = await supabase.from('agent_settings').upsert(rows, { onConflict: 'key' })
    if (error) return
    setSaved(true)
  }

  function set<K extends keyof AgentCfg>(key: K, val: AgentCfg[K]) {
    setCfg((c) => ({ ...c, [key]: val }))
  }

  const input = 'w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500'
  const label = 'block text-xs text-muted mb-1'

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-3xl">
      <h1 className="text-lg font-semibold mb-1">Configuração do Agente</h1>
      <p className="text-sm text-muted mb-6">Como a IA apresenta o serviço/projeto e conduz o remarketing.</p>

      <div className="space-y-6">
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <h2 className="text-sm font-semibold text-secondary">Apresentação</h2>
          <div>
            <label className={label}>Nome do agente</label>
            <input value={cfg.agent_name} onChange={(e) => set('agent_name', e.target.value)} placeholder="Ex: Alex" className={input} />
            <p className="text-[11px] text-faint mt-1">Quando definido, aparece em *negrito* acima de toda mensagem enviada pela IA.</p>
          </div>
          <div>
            <label className={label}>Sobre a empresa</label>
            <textarea value={cfg.company} onChange={(e) => set('company', e.target.value)} placeholder="Explique a empresa, o mercado, o que ela vende, diferenciais, público-alvo..." rows={4} className={input} />
            <p className="text-[11px] text-faint mt-1">A IA usa esse contexto para entender o negócio e vender melhor.</p>
          </div>
          <div>
            <label className={label}>Mensagem de saudação</label>
            <input value={cfg.greeting} onChange={(e) => set('greeting', e.target.value)} className={input} />
          </div>
          <div>
            <label className={label}>Objetivo da IA</label>
            <textarea value={cfg.objective} onChange={(e) => set('objective', e.target.value)} rows={3} className={input} />
          </div>
          <div>
            <label className={label}>Serviço que apresenta</label>
            <textarea value={cfg.service} onChange={(e) => set('service', e.target.value)} rows={3} className={input} />
          </div>
          <div>
            <label className={label}>Projeto / proposta (opcional)</label>
            <textarea value={cfg.project} onChange={(e) => set('project', e.target.value)} rows={3} className={input} />
          </div>
        </section>

        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <h2 className="text-sm font-semibold text-secondary">Remarketing automático</h2>
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input type="checkbox" checked={cfg.remarket_active} onChange={(e) => set('remarket_active', e.target.checked)} className="accent-indigo-500" />
            Reenviar mensagem para quem não respondeu
          </label>
          <div>
            <label className={label}>Dias até reenviar</label>
            <input type="number" min={1} value={cfg.remarket_days} onChange={(e) => set('remarket_days', Number(e.target.value))} className={input} />
          </div>
          <div>
            <label className={label}>Mensagem de remarketing</label>
            <textarea value={cfg.remarket_message} onChange={(e) => set('remarket_message', e.target.value)} rows={2} className={input} />
          </div>
        </section>

        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <h2 className="text-sm font-semibold text-secondary">Sem interesse</h2>
          <div>
            <label className={label}>Prazo de bloqueio (meses)</label>
            <input type="number" min={1} value={cfg.no_interest_months} onChange={(e) => set('no_interest_months', Number(e.target.value))} className={input} />
            <p className="text-[11px] text-faint mt-1">Enquanto vigente, a extensão mostra o lead como "Sem interesse".</p>
          </div>
        </section>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button onClick={() => void save()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg font-medium">
          Salvar configuração
        </button>
        {saved && <span className="text-xs text-emerald-300">Salvo ✓</span>}
      </div>
    </div>
  )
}