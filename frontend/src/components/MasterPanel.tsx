import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { masterApi, formatBRL, type MasterDashboard, type MasterPlan, type MasterCoupon, type MasterGateway } from '../lib/api'

type TabKey = 'dashboard' | 'users' | 'plans' | 'coupons' | 'gateways' | 'pixels' | 'extensao' | 'requests' | 'logs'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'users', label: 'Usuários' },
  { key: 'plans', label: 'Planos' },
  { key: 'coupons', label: 'Cupons' },
  { key: 'gateways', label: 'Gateways' },
  { key: 'pixels', label: 'Pixels' },
  { key: 'extensao', label: 'Extensão' },
  { key: 'requests', label: 'Solicitações' },
  { key: 'logs', label: 'Auditoria' },
]

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-subtle p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-subtle p-5">
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      {children}
    </section>
  )
}

const inputCls = 'input'

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
                tab === t.key ? 'bg-indigo-500 text-white' : 'bg-subtle text-muted hover:text-fg'
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
        {tab === 'requests' && <RequestsTab />}
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
  useEffect(() => { masterApi.dashboard().then(setD).catch(() => setD(null)) }, [])
  if (!d) return <Section title="Métricas"><div className="text-muted text-sm">Carregando…</div></Section>
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="Usuários" value={d.users} />
      <Stat label="Ativos" value={d.actives} />
      <Stat label="Tenants" value={d.tenants} />
      <Stat label="Leads" value={d.leads} />
      <Stat label="Assinaturas ativas" value={d.activeSubscriptions} />
      <Stat label="Pagamentos aprovados" value={d.approvedPayments} />
      <Stat label="Receita" value={formatBRL(d.revenue)} />
      <Stat label="Solicitações pendentes" value={d.pendingRequests} />
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
  const [form, setForm] = useState({ name: '', price: '', lead_limit: '', duration_days: '', active: true })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
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
    })
    setMsg({ ok: true, text: 'Plano criado.' })
    setForm({ name: '', price: '', lead_limit: '', duration_days: '', active: true })
    reload()
  }

  return (
    <Section title="Planos">
      <div className="grid sm:grid-cols-5 gap-2 mb-3">
        <input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        <input placeholder="Preço (R$)" type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={inputCls} />
        <input placeholder="Limite de leads" type="number" value={form.lead_limit} onChange={(e) => setForm({ ...form, lead_limit: e.target.value })} className={inputCls} />
        <input placeholder="Duração (dias)" type="number" value={form.duration_days} onChange={(e) => setForm({ ...form, duration_days: e.target.value })} className={inputCls} />
        <button onClick={create} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition">Criar plano</button>
      </div>
      {msg && <p className={`text-xs mb-2 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
      <div className="space-y-2">
        {plans.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <div>
              <span className="font-semibold">{p.name}</span>
              <span className="text-xs text-muted ml-2">{formatBRL(p.price)} · {p.lead_limit} leads{p.duration_days ? ` · ${p.duration_days}d` : ''}</span>
              {!p.active && <span className="text-xs text-amber-400 ml-2">inativo</span>}
            </div>
            <button onClick={() => masterApi.deletePlan(p.id).then(reload)}
              className="text-xs text-red-400 hover:text-red-300 transition">Desativar</button>
          </div>
        ))}
        {plans.length === 0 && <div className="text-sm text-muted">Nenhum plano.</div>}
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
        <button onClick={create} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition">Criar cupom</button>
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
        <button onClick={save} className="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition">Salvar e testar</button>
      </div>
      <div className="space-y-2">
        {gateways.map((g) => (
          <div key={g.id} className="flex items-center justify-between rounded-lg border border-line bg-fg/5 px-3 py-2 text-sm">
            <span className="font-semibold capitalize">{g.provider}</span>
            <span className="text-xs text-muted">{g.sandbox ? 'sandbox' : 'produção'} · {g.enabled ? 'habilitado' : 'desabilitado'}</span>
            <button onClick={() => test(g.id)} disabled={testing === g.id} className="text-xs text-indigo-400 hover:text-indigo-300 transition">
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
      <button onClick={save} className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition">Salvar pixels</button>
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
            <span className="text-indigo-300">{String(l.action ?? '')}</span>
            <span className="text-muted truncate">{String(l.user_id ?? '')}</span>
          </div>
        ))}
        {logs.length === 0 && <div className="text-muted">Sem registros.</div>}
      </div>
    </Section>
  )
}