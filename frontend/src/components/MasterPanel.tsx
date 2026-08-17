import { useEffect, useState } from 'react'
import { ArrowLeft, Users, Wallet, Activity, CreditCard, Inbox, Database, ShieldCheck, TrendingUp } from 'lucide-react'
import { masterApi, formatBRL, type MasterDashboard, type MasterPlan, type MasterCoupon, type MasterGateway } from '../lib/api'
import { KpiCard, BarChart, AreaChart, DonutChart, HorizontalBars } from './charts'
import { Button } from './ui'

type TabKey = 'dashboard' | 'users' | 'plans' | 'coupons' | 'gateways' | 'pixels' | 'extensao' | 'referencias' | 'requests' | 'logs' | 'antifraude'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'users', label: 'Usuários' },
  { key: 'plans', label: 'Planos' },
  { key: 'coupons', label: 'Cupons' },
  { key: 'gateways', label: 'Gateways' },
  { key: 'pixels', label: 'Pixels' },
  { key: 'extensao', label: 'Extensão' },
  { key: 'referencias', label: 'Referências' },
  { key: 'requests', label: 'Solicitações' },
  { key: 'antifraude', label: 'Antifraude' },
  { key: 'logs', label: 'Auditoria' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-subtle p-5">
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      {children}
    </section>
  )
}

const inputCls = 'input'

function RefCard({ title, description, value, onChange, onTest, onSave, onRemove, isLoading, currentRef }: {
  title: string; description: string; value: string; onChange: (v: string) => void; onTest: () => void; onSave: () => void; onRemove: () => void; isLoading: boolean; currentRef: string | null
}) {
  return (
    <div className="rounded-lg border border-line bg-bg p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted mt-0.5 mb-3">{description}</p>
      <label className="text-xs text-muted block mb-1">URL de referência</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://exemplo.com" className={`${inputCls} mb-2`} />
      <div className="text-xs mb-3">{currentRef ? (
        <span className="text-emerald-400 flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" /> Referência configurada</span>
      ) : <span className="text-muted">Nenhuma referência configurada</span>}</div>
      <div className="flex flex-wrap gap-2">
        <button onClick={onTest} disabled={isLoading} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-subtle text-fg hover:bg-line transition disabled:opacity-50">{isLoading ? 'Testando…' : 'Testar URL'}</button>
        <button onClick={onSave} disabled={isLoading} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 transition
disabled:opacity-50">Salvar referência</button>
        <button onClick={onRemove} disabled={isLoading} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-300 hover:text-red-200 hover:bg-red-500/10 transition disabled:opacity-50">Remover referência</button>
      </div>
    </div>
  )
}

function VisualReferencesTab() {
  const [refs, setRefs] = useState<{ landing_reference_url: string | null; dashboard_reference_url: string | null } | null>(null)
  const [landingUrl, setLandingUrl] = useState('')
  const [dashboardUrl, setDashboardUrl] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  useEffect(() => {
    masterApi.visualReferences().then((r) => {
      setRefs(r)
      setLandingUrl(r.landing_reference_url ?? '')
      setDashboardUrl(r.dashboard_reference_url ?? '')
    }).catch(() => setRefs(null))
  }, [])

  async function testUrl(field: 'landing' | 'dashboard') {
    const raw = field === 'landing' ? landingUrl : dashboardUrl
    if (!raw.trim()) { setMsg({ ok: false, text: 'Informe uma URL antes de testar.' }); setTimeout(() => setMsg(null), 4000); return }
    try { const u = new URL(raw.trim()); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Use http(s)://') } catch { setMsg({ ok: false, text: 'URL malformada. Use https://...' }); setTimeout(() => setMsg(null), 4000); return }
    setLoading(field); setMsg(null)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    try {
      const r = await fetch(raw.trim(), { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' })
      clearTimeout(t)
      if (r.status < 400 || r.status === 301 || r.status === 302) setMsg({ ok: true, text: `URL acessível (HTTP ${r.status}).` })
      else setMsg({ ok: false, text: `Resposta HTTP ${r.status} ao acessar a URL.` })
    } catch (e) {
      clearTimeout(t)
      const em = e instanceof Error ? e.message : String(e)
      setMsg({ ok: false, text: em === 'The user aborted a request.' ? 'Timeout (8s) ao acessar a URL.' : `Falha ao acessar: ${em}` })
    } finally { setLoading(null); setTimeout(() => setMsg(null), 6000) }
  }

  async function saveRef(field: 'landing' | 'dashboard') {
    const raw = field === 'landing' ? landingUrl : dashboardUrl
    if (!raw.trim()) { setMsg({ ok: false, text: 'URL vazia. Preencha ou use Remover.' }); setTimeout(() => setMsg(null), 4000); return }
    try { const u = new URL(raw.trim()); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Use http(s)://') } catch { setMsg({ ok: false, text: 'URL inválida. Aceitamos apenas http(s):// válido.' }); setTimeout(() => setMsg(null), 4000); return }
    const patch: Record<string, string | null> = {}
    if (field === 'landing') patch.landing_reference_url = raw.trim(); else patch.dashboard_reference_url = raw.trim()
    const r = await masterApi.saveVisualReferences(patch)
    if (r) setRefs({ landing_reference_url: r.landing_reference_url ?? null, dashboard_reference_url: r.dashboard_reference_url ?? null })
    setMsg({ ok: true, text: 'Referência salva.' }); setTimeout(() => setMsg(null), 4000)
  }

  async function removeRef(field: 'landing' | 'dashboard') {
    const patch: Record<string, string | null> = {}
    if (field === 'landing') { patch.landing_reference_url = null; setLandingUrl('') } else { patch.dashboard_reference_url = null; setDashboardUrl('') }
    const r = await masterApi.saveVisualReferences(patch)
    if (r) setRefs({ landing_reference_url: r.landing_reference_url ?? null, dashboard_reference_url: r.dashboard_reference_url ?? null })
    setMsg({ ok: true, text: 'Referência removida.' }); setTimeout(() => setMsg(null), 4000)
  }

  return (
    <Section title="Referências de Interface">
      <p className="text-xs text-muted mb-4">Informe URLs de referência visual para Landing Page e Painel do Usuário. A equipe utilizará essas páginas como inspiração de UX/UI, preservando a identidade e marca do Vyntra.</p>
      {msg && <div className={`text-xs font-semibold mb-3 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>}
      {!refs && <div className="text-sm text-muted">Carregando…</div>}
      {refs && (
        <div className="grid lg:grid-cols-2 gap-5">
          <RefCard title="Landing Page" description="Ex.: https://nexxus-pro.online/" value={landingUrl} onChange={setLandingUrl} onTest={() => testUrl('landing')} onSave={() => saveRef('landing')} onRemove={() => removeRef('landing')} isLoading={loading === 'landing'} currentRef={refs.landing_reference_url} />
          <RefCard title="Painel do Usuário" description="Ex.: https://nexxus-pro.online/members" value={dashboardUrl} onChange={setDashboardUrl} onTest={() => testUrl('dashboard')} onSave={() => saveRef('dashboard')} onRemove={() => removeRef('dashboard')} isLoading={loading === 'dashboard'} currentRef={refs.dashboard_reference_url} />
        </div>
      )}
    </Section>
  )
}

export function MasterPanel({ onBack }: { onBack?: () => void }) {
  const [tab, setTab] = useState<TabKey>('dashboard')

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            {onBack && (
              <button onClick={onBack}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-subtle hover:bg-subtle-2 border border-line-2 transition"
                title="Voltar ao app">
                <ArrowLeft className="w-4 h-4" />
                Voltar ao app
              </button>
            )}
            <div>
              <h1 className="text-xl font-semibold">Painel Master</h1>
              <p className="text-xs text-muted">Gestão de usuários, planos, pagamentos e configurações</p>
            </div>
          </div>
          <span className="text-xs px-2 py-1 rounded-full bg-amber-500/15 text-amber-300">Administração</span>
        </div>

        <div className="flex gap-2 flex-wrap">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                tab === t.key ? 'bg-accent-600 text-white' : 'bg-subtle text-muted hover:text-fg'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'plans' && <PlansTab />}
        {tab === 'coupons' && <CouponsTab />}
        {tab === 'gateways' && <GatewaysTab />}
        {tab === 'pixels' && <PixelsTab />}
        {tab === 'extensao' && <ExtensionSitesTab />}
        {tab === 'referencias' && <VisualReferencesTab />}
        {tab === 'requests' && <RequestsTab />}
        {tab === 'antifraude' && <AntifraudTab />}
        {tab === 'logs' && <LogsTab />}
      </div>
    </div>
  )
}

function ExtensionSitesTab() {
  const [sites, setSites] = useState<{ maps: boolean; webmotors: boolean; wepsy: boolean } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    masterApi.extensionSites().then(setSites).catch(() => setSites(null))
  }, [])

  async function toggle(key: 'maps' | 'webmotors' | 'wepsy') {
    if (!sites) return
    const next = { ...sites, [key]: !sites[key] }
    setSites(next)
    try {
      await masterApi.updateExtensionSites({ [key]: next[key] })
      setMsg({ ok: true, text: 'Configuração salva. A extensão será atualizada na próxima abertura.' })
    } catch {
      setSites(sites)
      setMsg({ ok: false, text: 'Erro ao salvar. Tente novamente.' })
    }
    setTimeout(() => setMsg(null), 4000)
  }

  const rows = [
    { key: 'maps' as const, label: 'Google Maps', desc: 'Busca por palavra-chave (ex.: "Psicólogos em Sorocaba")' },
    { key: 'webmotors' as const, label: 'WebMotors', desc: 'Busca por cidade e estado (lojas e concessionárias)' },
    { key: 'wepsy' as const, label: 'Wepsy', desc: 'Busca por cidade e estado (psicólogos)' },
  ]

  return (
    <Section title="Sites ativos na extensão">
      <p className="text-xs text-muted mb-4">Ligue ou desligue cada site. Quando desligado, a opção fica esmaecida e cinza na extensão e o site não opera.</p>
      {!sites && <div className="text-sm text-muted">Carregando…</div>}
      {sites && (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg p-4">
              <div>
                <div className="text-sm font-semibold">{r.label}</div>
                <div className="text-xs text-muted mt-0.5">{r.desc}</div>
              </div>
              <button onClick={() => void toggle(r.key)}
                className={`relative w-11 h-6 rounded-full transition ${sites[r.key] ? 'bg-emerald-500' : 'bg-zinc-600'}`}
                title={sites[r.key] ? 'Ativo' : 'Desativado'}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${sites[r.key] ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          ))}
          {msg && (
            <div className={`text-xs font-semibold ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>
          )}
        </div>
      )}
    </Section>
  )
}

function DashboardTab() {
  const [d, setD] = useState<MasterDashboard | null>(null)
  const [error, setError] = useState('')
  const load = () => {
    setError('')
    masterApi.dashboard().then(setD).catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar métricas.'))
  }
  useEffect(() => { load() }, [])
  if (!d && !error) return <Section title="Métricas"><div className="text-muted text-sm animate-pulse-soft">Carregando…</div></Section>
  if (!d) return <Section title="Métricas"><div className="text-rose-400 text-sm">{error}</div></Section>

  const s = d.series
  const activePct = d.users > 0 ? Math.round((d.actives / d.users) * 100) : 0
  const paidPct = d.subscriptions > 0 ? Math.round((d.activeSubscriptions / d.subscriptions) * 100) : 0

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-secondary">Visão geral da operação</h2>
        <Button variant="ghost" size="sm" onClick={load}>Atualizar</Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Receita total" value={formatBRL(d.revenue)} icon={<Wallet className="w-4 h-4" />} trend={null} spark={s.revenueByMonth.map((x) => x.value)} hint={`${d.approvedPayments} pagamentos aprovados`} />
        <KpiCard label="Usuários" value={String(d.users)} icon={<Users className="w-4 h-4" />} trend={activePct >= 60 ? activePct : null} hint={`${d.actives} ativos · ${d.masters} masters`} />
        <KpiCard label="Assinaturas" value={String(d.subscriptions)} icon={<CreditCard className="w-4 h-4" />} trend={paidPct >= 50 ? paidPct : null} hint={`${d.activeSubscriptions} ativas`} />
        <KpiCard label="Leads" value={String(d.leads)} icon={<Database className="w-4 h-4" />} trend={null} spark={s.leadsByMonth.map((x) => x.value)} hint="no funil de prospecção" />
      </div>

      {/* Receita + status */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Receita por mês (aprovados)">
          <AreaChart data={s.revenueByMonth} height={190} format={(n) => formatBRL(n)} />
        </Section>
        <Section title="Status dos pagamentos">
          <DonutChart data={s.paymentsByStatus.map((x) => ({ label: x.label, value: x.value }))} />
        </Section>
        <Section title="Assinaturas por plano">
          <HorizontalBars data={s.subsByPlan} format={(n) => String(n)} />
        </Section>
      </div>

      {/* Crescimento + usuários */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Leads por mês">
          <BarChart data={s.leadsByMonth} height={150} />
        </Section>
        <Section title="Usuários por papel">
          <DonutChart data={s.usersByRole.map((x) => ({ label: x.label, value: x.value }))} />
        </Section>
        <Section title="Status das assinaturas">
          <HorizontalBars data={s.subsByStatus} format={(n) => String(n)} />
        </Section>
      </div>

      {/* Operacional */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Tenants" value={String(d.tenants)} icon={<ShieldCheck className="w-4 h-4" />} spark={s.tenantsByMonth.map((x) => x.value)} hint="workspaces" />
        <KpiCard label="Solicitações" value={String(d.requests)} icon={<Inbox className="w-4 h-4" />} trend={null} hint={`${d.pendingRequests} pendentes`} />
        <KpiCard label="Planos" value={String(d.plans)} icon={<TrendingUp className="w-4 h-4" />} hint="no catálogo" />
        <KpiCard label="Usuários bloqueados" value={String(s.usersByStatus.find((x) => x.label === 'Bloqueados')?.value ?? 0)} icon={<Activity className="w-4 h-4" />} hint={d.masters ? `${d.masters} master` : ''} />
      </div>

      {/* Requests por status */}
      <Section title="Solicitações de fonte por status">
        <HorizontalBars data={s.requestsByStatus} format={(n) => String(n)} />
      </Section>
    </div>
  )
}

function UsersTab() {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([])
  const [msg, setMsg] = useState('')
  useEffect(() => { masterApi.users().then(setUsers).catch(() => setUsers([])) }, [])

  async function setRole(id: string, role: string) {
    await masterApi.updateUser(id, { role })
    setMsg('Usuário atualizado')
    masterApi.users().then(setUsers)
  }
  async function setStatus(id: string, status: string) {
    await masterApi.updateUser(id, { status })
    setMsg('Status atualizado')
    masterApi.users().then(setUsers)
  }

  return (
    <Section title="Usuários e tenants">
      {msg && <p className="text-xs text-emerald-400 mb-2">{msg}</p>}
      <div className="space-y-2">
        {users.map((u) => (
          <div key={String(u.id)} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate">{String(u.email ?? 'sem e-mail')}</div>
              <div className="text-xs text-muted font-mono break-all">{String(u.tenant_id ?? '')}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select value={String(u.role ?? 'USER')} onChange={(e) => setRole(String(u.id), e.target.value)} className="input !w-auto !py-1">
                <option value="USER">Usuário</option>
                <option value="MASTER">Master</option>
              </select>
              <select value={String(u.status ?? 'active')} onChange={(e) => setStatus(String(u.id), e.target.value)} className="input !w-auto !py-1">
                <option value="active">Ativo</option>
                <option value="blocked">Bloqueado</option>
              </select>
            </div>
          </div>
        ))}
        {users.length === 0 && <div className="text-sm text-muted">Nenhum usuário.</div>}
      </div>
    </Section>
  )
}

function PlansTab() {
  const [plans, setPlans] = useState<MasterPlan[]>([])
  const [form, setForm] = useState({
    name: '', price: '', lead_limit: '', duration_days: '', active: true,
    featured: false, display_order: '', campaign_equivalence: '', badge_label: '',
  })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const reload = () => masterApi.plans().then(setPlans).catch(() => setPlans([]))
  useEffect(() => { reload() }, [])

  async function create() {
    if (!form.name) { setMsg({ ok: false, text: 'Nome é obrigatório.' }); return }
    await masterApi.createPlan({
      name: form.name,
      price: Number(form.price) || 0,
      lead_limit: Number(form.lead_limit) || 0,
      duration_days: form.duration_days === '' ? null : Number(form.duration_days),
      active: form.active,
      featured: form.featured,
      display_order: Number(form.display_order) || 0,
      campaign_equivalence: Number(form.campaign_equivalence) || 0,
      badge_label: form.badge_label || null,
    })
    setMsg({ ok: true, text: 'Plano criado.' })
    setForm({ name: '', price: '', lead_limit: '', duration_days: '', active: true, featured: false, display_order: '', campaign_equivalence: '', badge_label: '' })
    reload()
  }

  function startEdit(p: MasterPlan) {
    setEditing(p.id)
    setForm({
      name: p.name, price: String(p.price), lead_limit: String(p.lead_limit),
      duration_days: p.duration_days != null ? String(p.duration_days) : '',
      active: p.active, featured: p.featured,
      display_order: String(p.display_order ?? 0),
      campaign_equivalence: String(p.campaign_equivalence ?? 0),
      badge_label: p.badge_label ?? '',
    })
  }

  async function saveEdit(id: string) {
    await masterApi.updatePlan(id, {
      name: form.name || undefined,
      price: form.price === '' ? undefined : Number(form.price),
      lead_limit: form.lead_limit === '' ? undefined : Number(form.lead_limit),
      duration_days: form.duration_days === '' ? null : Number(form.duration_days),
      active: form.active,
      featured: form.featured,
      display_order: Number(form.display_order) || 0,
      campaign_equivalence: Number(form.campaign_equivalence) || 0,
      badge_label: form.badge_label || null,
    })
    setMsg({ ok: true, text: 'Plano atualizado.' })
    setEditing(null)
    reload()
  }

  const isEditing = editing !== null

  return (
    <Section title="Planos">
      <div className="grid sm:grid-cols-4 gap-2 mb-2">
        <input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        <input placeholder="Preço (R$)" type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={inputCls} />
        <input placeholder="Limite de leads" type="number" value={form.lead_limit} onChange={(e) => setForm({ ...form, lead_limit: e.target.value })} className={inputCls} />
        <input placeholder="Duração (dias)" type="number" value={form.duration_days} onChange={(e) => setForm({ ...form, duration_days: e.target.value })} className={inputCls} />
      </div>
      <div className="grid sm:grid-cols-4 gap-2 mb-2">
        <input placeholder="Ordem de exibição" type="number" value={form.display_order} onChange={(e) => setForm({ ...form, display_order: e.target.value })} className={inputCls} />
        <input placeholder="Campanhas incl." type="number" value={form.campaign_equivalence} onChange={(e) => setForm({ ...form, campaign_equivalence: e.target.value })} className={inputCls} />
        <input placeholder="Badge (ex.: MAIS ESCOLHIDO)" value={form.badge_label} onChange={(e) => setForm({ ...form, badge_label: e.target.value })} className={inputCls} />
        <label className="flex items-center gap-2 text-xs text-muted px-1">
          <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />
          Destaque (featured)
        </label>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Ativo
        </label>
        {isEditing ? (
          <>
            <button onClick={() => saveEdit(editing)} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 transition">Salvar alterações</button>
            <button onClick={() => { setEditing(null); setForm({ name: '', price: '', lead_limit: '', duration_days: '', active: true, featured: false, display_order: '', campaign_equivalence: '', badge_label: '' }) }} className="px-3 py-2 rounded-lg text-xs font-semibold bg-subtle text-muted hover:text-fg transition">Cancelar</button>
          </>
        ) : (
          <button onClick={create} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 transition">Criar plano</button>
        )}
      </div>
      {msg && <p className={`text-xs mb-2 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
      <div className="space-y-2">
        {[...plans].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)).map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{p.name}</span>
              {p.featured && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-accent-600/20 text-accent-300">featured</span>}
              <span className="text-xs text-muted">{formatBRL(p.price)} · {p.lead_limit} leads · {p.campaign_equivalence >= 999 ? 'camp. ilimitadas' : `${p.campaign_equivalence} camp.`}{p.duration_days ? ` · ${p.duration_days}d` : ''}</span>
              {!p.active && <span className="text-xs text-amber-400">inativo</span>}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => startEdit(p)} className="text-xs text-accent-300 hover:text-accent-200 transition">Editar</button>
              <button onClick={() => masterApi.deletePlan(p.id).then(reload)}
                className="text-xs text-red-400 hover:text-red-300 transition">Desativar</button>
            </div>
          </div>
        ))}
        {plans.length === 0 && <div className="text-sm text-muted">Nenhum plano.</div>}
      </div>
    </Section>
  )
}

function AntifraudTab() {
  const [data, setData] = useState<{ redemptions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; stats: { total: number; highRisk: number; blockedEvents: number; uniqueIps: number; uniqueDevices: number } } | null>(null)
  const reload = () => masterApi.antifraud().then(setData).catch(() => setData(null))
  useEffect(() => { reload() }, [])

  if (!data) return <Section title="Antifraude (plano TESTE)"><div className="text-sm text-muted">Carregando…</div></Section>

  const stats: Array<{ label: string; value: number }> = [
    { label: 'Resgates de TESTE', value: data.stats.total },
    { label: 'Alto risco', value: data.stats.highRisk },
    { label: 'Bloqueios', value: data.stats.blockedEvents },
    { label: 'IPs distintos', value: data.stats.uniqueIps },
    { label: 'Dispositivos', value: data.stats.uniqueDevices },
  ]

  return (
    <Section title="Antifraude (plano TESTE)">
      <p className="text-xs text-muted mb-4">Resgates do plano TESTE com hashing de identidade (e-mail, telefone, IP, dispositivo), ativação atômica e trilha de segurança.</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-fg/5 px-3 py-2.5">
            <div className="text-xl font-bold">{s.value}</div>
            <div className="text-[11px] text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Resgates</h3>
          <div className="space-y-2">
            {data.redemptions.map((r) => (
              <div key={String(r.id)} className="rounded-lg border border-line bg-fg/5 px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{(r.user as Record<string, unknown>)?.email ? String((r.user as Record<string, unknown>).email) : (r.user_id as string)}</span>
                  <span className={`px-1.5 py-0.5 rounded-full font-bold uppercase text-[9px] ${Number(r.risk_score) >= 70 ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                    risco {String(r.risk_score)}
                  </span>
                </div>
                <div className="text-faint mt-1 flex flex-wrap gap-x-3">
                  <span>IP {String(r.ip_hash ?? '-').slice(0, 10)}…</span>
                  <span>dev {String(r.device_hash ?? '-').slice(0, 10)}…</span>
                  <span>{new Date(String(r.redeemed_at)).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            ))}
            {data.redemptions.length === 0 && <div className="text-sm text-muted">Nenhum resgate ainda.</div>}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Eventos de segurança</h3>
          <div className="space-y-2">
            {data.events.slice(0, 30).map((e) => (
              <div key={String(e.id)} className="rounded-lg border border-line bg-fg/5 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-accent-300">{String(e.event_type)}</span>
                  <span className="text-faint">{new Date(String(e.created_at)).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="text-faint mt-0.5">razão: {String(e.reason ?? '-')} · risco {String(e.risk_score)}</div>
              </div>
            ))}
            {data.events.length === 0 && <div className="text-sm text-muted">Nenhum evento registrado.</div>}
          </div>
        </div>
      </div>
    </Section>
  )
}

function CouponsTab() {
  const [coupons, setCoupons] = useState<MasterCoupon[]>([])
  const [form, setForm] = useState({ code: '', discount_type: 'percentage', discount_value: '', usage_limit: '', active: true })
  const [msg, setMsg] = useState<string>('')
  const reload = () => masterApi.coupons().then(setCoupons).catch(() => setCoupons([]))
  useEffect(() => { reload() }, [])

  async function create() {
    if (!form.code || !form.discount_value) { setMsg('Código e valor são obrigatórios.'); return }
    await masterApi.createCoupon({
      code: form.code,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value) || 0,
      usage_limit: form.usage_limit === '' ? null : Number(form.usage_limit),
      active: form.active,
    })
    setMsg('Cupom criado.')
    setForm({ code: '', discount_type: 'percentage', discount_value: '', usage_limit: '', active: true })
    reload()
  }

  return (
    <Section title="Cupons">
      <div className="grid sm:grid-cols-5 gap-2 mb-3">
        <input placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} />
        <select value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value })} className={inputCls}>
          <option value="percentage">%</option>
          <option value="fixed">R$ fixo</option>
        </select>
        <input placeholder="Valor" type="number" value={form.discount_value} onChange={(e) => setForm({ ...form, discount_value: e.target.value })} className={inputCls} />
        <input placeholder="Limite de uso" type="number" value={form.usage_limit} onChange={(e) => setForm({ ...form, usage_limit: e.target.value })} className={inputCls} />
        <button onClick={create} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 transition">Criar cupom</button>
      </div>
      {msg && <p className="text-xs text-emerald-400 mb-2">{msg}</p>}
      <div className="space-y-2">
        {coupons.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <span className="font-mono font-semibold">{c.code}</span>
            <span className="text-xs text-muted">
              {c.discount_type === 'percentage' ? `${c.discount_value}%` : formatBRL(c.discount_value)}
              {' · '}{c.usage_count}{c.usage_limit != null ? `/${c.usage_limit}` : ''} usos
              {!c.active && ' · inativo'}
            </span>
            <button onClick={() => masterApi.deleteCoupon(c.id).then(reload)} className="text-xs text-red-400 hover:text-red-300 transition">Desativar</button>
          </div>
        ))}
        {coupons.length === 0 && <div className="text-sm text-muted">Nenhum cupom.</div>}
      </div>
    </Section>
  )
}

function GatewaysTab() {
  const [gateways, setGateways] = useState<MasterGateway[]>([])
  const [form, setForm] = useState({ accessToken: '', sandbox: true })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const reload = () => masterApi.gateways().then(setGateways).catch(() => setGateways([]))
  useEffect(() => { reload() }, [])

  async function save() {
    if (!form.accessToken) { setMsg({ ok: false, text: 'Access token é obrigatório.' }); return }
    try {
      await masterApi.saveGateway({ provider: 'mercadopago', accessToken: form.accessToken, sandbox: form.sandbox, active: true })
      setMsg({ ok: true, text: 'Gateway configurado e testado com sucesso.' })
      setForm({ accessToken: '', sandbox: true })
      reload()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao configurar o gateway.' })
    }
  }

  async function test(id: string) {
    setTesting(id)
    const r = await masterApi.testGateway(id)
    setMsg({ ok: r.ok, text: r.ok ? 'Conexão OK.' : (r.error ?? 'Falha na conexão.') })
    setTesting(null)
  }

  return (
    <Section title="Gateway de pagamento">
      {msg && <p className={`text-xs mb-2 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
      <div className="grid sm:grid-cols-3 gap-2 mb-3">
        <input placeholder="Access token (Mercado Pago)" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} className={inputCls} type="password" />
        <select value={form.sandbox ? '1' : '0'} onChange={(e) => setForm({ ...form, sandbox: e.target.value === '1' })} className={inputCls}>
          <option value="1">Sandbox (teste)</option>
          <option value="0">Produção</option>
        </select>
        <button onClick={save} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-accent-600 hover:bg-accent-500 transition">Salvar e testar</button>
      </div>
      <div className="space-y-2">
        {gateways.map((g) => (
          <div key={g.id} className="flex items-center justify-between rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <span className="font-semibold capitalize">{g.provider}</span>
            <span className="text-xs text-muted">{g.sandbox ? 'sandbox' : 'produção'} · {g.enabled ? 'habilitado' : 'desabilitado'}</span>
            <button onClick={() => test(g.id)} disabled={testing === g.id} className="text-xs text-accent-400 hover:text-accent-300 transition">
              {testing === g.id ? 'Testando…' : 'Testar conexão'}
            </button>
          </div>
        ))}
        {gateways.length === 0 && <div className="text-sm text-muted">Nenhum gateway configurado.</div>}
      </div>
    </Section>
  )
}

function PixelsTab() {
  const [pix, setPix] = useState<Record<string, unknown> | null>(null)
  const [msg, setMsg] = useState('')
  const reload = () => masterApi.pixels().then(setPix).catch(() => setPix(null))
  useEffect(() => { reload() }, [])

  async function save() {
    await masterApi.updatePixels({
      meta_pixel_id: String(pix?.meta_pixel_id ?? ''),
      meta_pixel_active: !!pix?.meta_pixel_active,
      tiktok_pixel_id: String(pix?.tiktok_pixel_id ?? ''),
      tiktok_pixel_active: !!pix?.tiktok_pixel_active,
    })
    setMsg('Pixels salvos.')
    reload()
  }

  return (
    <Section title="Pixels de marketing">
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <label className="text-sm space-y-1">
          <span className="text-xs text-muted">Meta (Facebook) Pixel ID</span>
          <input value={String(pix?.meta_pixel_id ?? '')} onChange={(e) => setPix({ ...pix, meta_pixel_id: e.target.value })} className={inputCls} />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-xs text-muted">TikTok Pixel ID</span>
          <input value={String(pix?.tiktok_pixel_id ?? '')} onChange={(e) => setPix({ ...pix, tiktok_pixel_id: e.target.value })} className={inputCls} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm mb-1">
        <input type="checkbox" checked={!!pix?.meta_pixel_active} onChange={(e) => setPix({ ...pix, meta_pixel_active: e.target.checked })} />
        Ativar pixel Meta
      </label>
      <label className="flex items-center gap-2 text-sm mb-3">
        <input type="checkbox" checked={!!pix?.tiktok_pixel_active} onChange={(e) => setPix({ ...pix, tiktok_pixel_active: e.target.checked })} />
        Ativar pixel TikTok
      </label>
      {msg && <p className="text-xs text-emerald-400 mb-2">{msg}</p>}
      <button onClick={save} className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-accent-600 hover:bg-accent-500 transition">Salvar pixels</button>
    </Section>
  )
}

function RequestsTab() {
  const [requests, setRequests] = useState<Array<Record<string, unknown>>>([])
  const reload = () => masterApi.sourceRequests().then(setRequests).catch(() => setRequests([]))
  useEffect(() => { reload() }, [])
  const statuses = ['recebida', 'em_analise', 'aprovada', 'rejeitada', 'implementada']

  return (
    <Section title="Solicitações de novas fontes">
      <div className="space-y-2">
        {requests.map((r) => (
          <div key={String(r.id)} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{String(r.url ?? '')}</div>
              <div className="text-xs text-muted">por {String(r.requested_by ?? 'anon')}</div>
            </div>
            <select value={String(r.status ?? 'recebida')} onChange={(e) => masterApi.updateSourceRequest(String(r.id), e.target.value).then(reload)} className="input !w-auto !py-1 shrink-0">
              {statuses.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
        ))}
        {requests.length === 0 && <div className="text-sm text-muted">Nenhuma solicitação.</div>}
      </div>
    </Section>
  )
}

function LogsTab() {
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([])
  useEffect(() => { masterApi.auditLogs(100).then(setLogs).catch(() => setLogs([])) }, [])
  return (
    <Section title="Logs de auditoria">
      <div className="space-y-1 text-xs font-mono">
        {logs.map((l) => (
          <div key={String(l.id)} className="flex gap-2 py-1 border-b border-line last:border-0">
            <span className="text-faint">{String(l.created_at ?? '').slice(0, 19)}</span>
            <span className="text-accent-300">{String(l.action ?? '')}</span>
            <span className="text-muted truncate">{String(l.user_id ?? '')}</span>
          </div>
        ))}
        {logs.length === 0 && <div className="text-muted">Sem registros.</div>}
      </div>
    </Section>
  )
}