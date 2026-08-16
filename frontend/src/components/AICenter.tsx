import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Send, Activity, Loader2, TriangleAlert, CircleOff, Play, X, GraduationCap, ShieldCheck, Brain } from 'lucide-react'
import { api, type AiStatus, type AiFlowTestResult, type AiTrainingReply, type AiTrainingPersona } from '../lib/api'
import { MEMORY_PATHS } from '../lib/routes'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'sem atividade'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'agora'
  const m = Math.floor(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `há ${h} h`
  return new Date(iso).toLocaleString('pt-BR')
}

function StatusCard({ status, testing }: { status: AiStatus | null; testing: boolean }) {
  const badge = testing
    ? { icon: <Loader2 className="w-4 h-4 animate-spin" />, label: 'Testando conexão...', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' }
    : !status
      ? { icon: <CircleOff className="w-4 h-4" />, label: 'IA não configurada', cls: 'text-muted bg-subtle border-line-2' }
      : status.configured
        ? { icon: <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />, label: 'IA online', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' }
        : { icon: <TriangleAlert className="w-4 h-4" />, label: 'IA com problema', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' }

  return (
    <div className="rounded-xl border border-line bg-subtle p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className={`flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-full border ${badge.cls}`}>
          <span className="[&>svg]:w-4 [&>svg]:h-4">{badge.icon}</span>
          {badge.label}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-faint mb-1">Modelo</div>
          <div className="font-mono text-xs text-fg">{status?.model ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-faint mb-1">Provedor</div>
          <div className="font-mono text-xs text-fg">{status?.provider ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-faint mb-1">Última atividade</div>
          <div className="text-xs text-secondary">{status ? timeAgo(status.lastActivityAt) : '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-faint mb-1">WhatsApp</div>
          <div className="text-xs text-secondary">{status?.evolutionConfigured ? 'Conectado' : 'Não conectado'}</div>
        </div>
      </div>

      <p className="text-[11px] text-faint flex items-center gap-1.5">
        <Activity className="w-3.5 h-3.5" />
        Dados reais do backend <span className="font-mono">/api/ai/status</span> — estado verdadeiro da integração.
      </p>
    </div>
  )
}

function TrainingChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Olá! Sou um cliente em treinamento. Treine sua abordagem de vendas conversando comigo como se eu fosse um lead real. Eu sou cético e sem pressa.',
    },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [persona, setPersona] = useState<AiTrainingPersona>({
    name: 'Carlos',
    company: 'Clínica Exemplo',
    niche: 'saúde',
    profile: 'dono de pequeno negócio, cético e sem pressa',
  })
  const [personaOpen, setPersonaOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setError('')
    setBusy(true)
    const userMsg: ChatMessage = { id: `u${Date.now()}`, role: 'user', content: text }
    setMessages((m) => [...m, userMsg])
    try {
      const reply = await api.post<AiTrainingReply>('/api/ai/training', {
        message: text,
        persona,
      })
      setMessages((m) => [...m, { id: `a${Date.now()}`, role: 'assistant', content: reply.response }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao falar com o cliente')
      setMessages((m) => [...m, { id: `a${Date.now()}`, role: 'assistant', content: '⚠️ Não consegui contatar a IA agora. Verifique a integração e tente novamente.' }])
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500'
  const labelCls = 'block text-xs text-muted mb-1'

  return (
    <div className="rounded-xl border border-line bg-subtle flex flex-col">
      <div className="px-5 py-3 border-b border-line flex items-center gap-2">
        <GraduationCap className="w-4 h-4 text-teal-300" />
        <span className="text-sm font-semibold">Chat de treinamento</span>
        <span className="text-[11px] text-faint ml-auto">Você = vendedor · IA = cliente</span>
      </div>

      <div className="px-4 py-2 border-b border-line flex items-center gap-2 bg-teal-500/5">
        <ShieldCheck className="w-3.5 h-3.5 text-teal-300" />
        <span className="text-[11px] text-teal-200">
          Sandbox isolado: nada é enviado ao WhatsApp, nenhuma campanha, lead, Kanban ou reunião real.
        </span>
      </div>

      <div className="px-4 py-2 border-b border-line flex items-center gap-2">
        <span className="text-[11px] text-muted">
          Cliente: <b className="text-fg">{persona.name}</b>
          {persona.company ? <> · <span className="text-muted">{persona.company}</span></> : null}
          <span className="text-faint"> · {persona.profile}</span>
        </span>
        <button
          onClick={() => setPersonaOpen((v) => !v)}
          className="ml-auto text-[11px] text-accent-300 hover:text-accent-200 border border-accent-500/30 rounded-md px-2 py-0.5"
        >
          {personaOpen ? 'Fechar' : 'Editar persona'}
        </button>
      </div>

      {personaOpen && (
        <div className="px-4 py-3 border-b border-line bg-subtle-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Nome do cliente</label>
              <input value={persona.name} onChange={(e) => setPersona({ ...persona, name: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Empresa</label>
              <input value={persona.company} onChange={(e) => setPersona({ ...persona, company: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Nicho/área</label>
            <input value={persona.niche} onChange={(e) => setPersona({ ...persona, niche: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Perfil / atitude do cliente</label>
            <input value={persona.profile} onChange={(e) => setPersona({ ...persona, profile: e.target.value })} className={inputCls} />
          </div>
          <p className="text-[11px] text-faint">Dica: descreva o perfil para treinar resistências, orçamento, mandante, etc.</p>
        </div>
      )}

      <div ref={scrollRef} className="h-80 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-teal-700 text-white rounded-br-sm'
                  : 'bg-subtle text-fg rounded-bl-sm'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {error && (
          <div className="text-[11px] text-rose-300 bg-rose-500/10 rounded-xl px-3 py-2">
            {error} — confira se o backend responde.
          </div>
        )}
      </div>

      <form onSubmit={(e) => void submit(e)} className="p-3 border-t border-line flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Fale como vendedor para o cliente (ex: Olá, como posso ajudar seu negócio?)..."
          className="flex-1 bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-teal-500"
        />
        <button type="submit" disabled={busy || !input.trim()} className="px-3.5 py-2 rounded-xl bg-teal-700 hover:bg-teal-600 disabled:opacity-40 transition">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  )
}

function FlowTest() {
  const [open, setOpen] = useState(false)
  const [leadName, setLeadName] = useState('João')
  const [company, setCompany] = useState('Clínica Exemplo')
  const [context, setContext] = useState('Empresa sem site')
  const [initialMessage, setInitialMessage] = useState('Olá, tudo bem?')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<AiFlowTestResult | null>(null)
  const [error, setError] = useState('')

  async function run(e: React.FormEvent) {
    e.preventDefault()
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const res = await api.post<AiFlowTestResult>('/api/ai/flow-test', {
        leadName: leadName.trim() || 'João',
        company: company.trim(),
        context: context.trim(),
        initialMessage: initialMessage.trim() || 'Olá, tudo bem?',
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao executar o teste de fluxo')
    } finally {
      setRunning(false)
    }
  }

  const inputCls = 'w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500'
  const labelCls = 'block text-xs text-muted mb-1'

  return (
    <>
      <div className="rounded-xl border border-line bg-subtle p-5">
        <div className="flex items-center gap-2 mb-2">
          <Play className="w-4 h-4 text-amber-300" />
          <span className="text-sm font-semibold">Fluxo de teste</span>
        </div>
        <p className="text-xs text-muted mb-4">
          Simula o comportamento comercial do agente com a configuração real. Nenhuma mensagem é enviada.
        </p>
        <button onClick={() => setOpen(true)} className="px-4 py-2 text-sm bg-amber-600/80 hover:bg-amber-500 rounded-xl font-medium transition">
          Testar fluxo de mensagem
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-semibold">Testar fluxo de mensagem</div>
                <div className="text-xs text-amber-300 mt-0.5">Modo de teste — nenhuma mensagem será enviada.</div>
              </div>
              <button onClick={() => setOpen(false)} className="text-muted hover:text-fg"><X className="w-5 h-5" /></button>
            </div>

            <form onSubmit={(e) => void run(e)} className="space-y-3 mb-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Nome do lead</label>
                  <input value={leadName} onChange={(e) => setLeadName(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Empresa</label>
                  <input value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Contexto</label>
                <input value={context} onChange={(e) => setContext(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Mensagem inicial</label>
                <textarea value={initialMessage} onChange={(e) => setInitialMessage(e.target.value)} rows={2} className={inputCls} />
              </div>
              {error && <div className="text-xs text-rose-300 bg-rose-500/10 rounded-xl px-3 py-2">{error}</div>}
              <button
                type="submit"
                disabled={running}
                className="px-4 py-2 text-sm bg-amber-600/80 hover:bg-amber-500 disabled:opacity-50 rounded-xl font-medium"
              >
                {running ? <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Executando...</span> : 'Executar teste'}
              </button>
            </form>

            {result && (
              <div className="rounded-xl border border-line-2 bg-subtle-2 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">FLUXO DE TESTE</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">✓ Fluxo executado</span>
                </div>
                <div className="text-xs text-secondary">
                  Lead: <b className="text-fg">{result.lead.name}</b>
                  {result.lead.company ? <> — <span className="text-muted">{result.lead.company}</span></> : null}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-faint mb-1">Etapa</div>
                    <div className="text-sm text-accent-300">{result.etapa}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-faint mb-1">Próxima etapa</div>
                    <div className="text-sm text-fg">{result.proximaEtapa}</div>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-faint mb-1">Mensagem gerada</div>
                  <div className="text-sm text-fg whitespace-pre-wrap bg-field border border-line rounded-xl p-3">
                    {result.signed || result.mensagem}
                  </div>
                </div>
                <div className="text-[10px] text-faint font-mono">
                  {result.model} · {result.provider} · {result.latencyMs}ms · simulação
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export function AICenter() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [testing, setTesting] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setTesting(true)
    setError('')
    try {
      const s = await api.get<AiStatus>('/api/ai/status')
      setStatus(s)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Falha ao consultar status')
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-4xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold mb-1">Central de IA</h1>
        <p className="text-sm text-muted">
          Status em tempo real da integração do agente, com chat de treinamento (atenda um cliente simulado) e teste de fluxo.
        </p>
      </div>

      {error && (
        <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-4 py-3">
          Não foi possível obter o status do backend: {error}
        </div>
      )}

      <StatusCard status={status} testing={testing} />

      <div className="grid gap-5 lg:grid-cols-2">
        <TrainingChat />
        <FlowTest />
      </div>

      {/* Memória Comercial da IA — rota própria /central-ia/memoria */}
      <Link
        to={MEMORY_PATHS.root}
        className="rounded-xl border border-accent-500/20 bg-accent-500/5 p-5 flex items-center gap-4 hover:bg-accent-500/10 transition"
      >
        <div className="p-3 rounded-xl bg-accent-500/15 text-accent-300 shrink-0">
          <Brain className="w-6 h-6" />
        </div>
        <div>
          <div className="font-semibold">Memória Comercial da IA</div>
          <div className="text-xs text-muted mt-0.5">
            Importe conversas reais do WhatsApp, veja os aprendizados extraídos e controle o que entra no contexto comercial da IA.
          </div>
        </div>
        <span className="ml-auto text-accent-300 text-xs font-semibold shrink-0">Abrir →</span>
      </Link>
    </div>
  )
}