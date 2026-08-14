import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

type ConnStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * Normaliza o conteúdo do QR para um data URI PNG bem-formado:
 *  - remove prefixos duplicados (`data:image/png;base64,data:image/png;base64,...`)
 *  - tira espaços, quebras de linha, vírgulas perdidas
 *  - garante exatamente UM prefixo `data:image/png;base64,`
 *  - retorna null se não for um base64 PNG plausível
 *
 * A mesma lógica vive no backend em `src/utils/qr.ts` — manter em sincronia.
 */
function normalizeQr(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  let s = value.trim()
  if (!s) return null

  const PREFIX = 'data:image/png;base64,'
  // Remove prefixos repetidos no começo
  while (s.toLowerCase().startsWith(PREFIX.toLowerCase())) {
    s = s.slice(PREFIX.length).trim()
  }
  // Remove qualquer outro prefixo data: ao longo do texto (concatenação múltipla)
  s = s.replace(/data:image\/png;base64,/gi, '')

  // Mantém só caracteres válidos de base64
  s = s.replace(/[^A-Za-z0-9+/=]/g, '')
  if (s.length < 80) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null

  return `${PREFIX}${s}`
}

/** Extrai o número visível do JID ("55119999@s.whatsapp.net" -> "55 11999…"). */
function formatPhone(phone: string | null): string {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  return digits
}

interface Conn {
  id: string
  instance_name: string
  phone_number: string | null
  whatsapp_name: string | null
  display_name: string | null
  status: ConnStatus
  qr_code: string | null
  last_sync_at: string | null
  created_at?: string
}

interface Group {
  id: string
  name: string
}

interface NotifGroup {
  id: string
  group_id: string
  group_name: string
  enabled: boolean
}

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

export function ConnectionsPage() {
  const [conns, setConns] = useState<Conn[]>([])
  const [qrByConn, setQrByConn] = useState<Record<string, string>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [notifGroup, setNotifGroup] = useState<NotifGroup | null>(null)
  const [groupError, setGroupError] = useState<string | null>(null)
  const [groupSearch, setGroupSearch] = useState('')
  const [showGroupList, setShowGroupList] = useState(false)
  const [settings, setSettings] = useState<Record<string, boolean>>({
    notify_meetings: true,
    notify_reschedules: true,
    notify_cancellations: true,
    notify_sales: true,
    notify_campaigns: true,
    daily_summary: false,
  })

  const [sessionUser, setSessionUser] = useState<string>('')
  const [displayNameDrafts, setDisplayNameDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.id) setSessionUser(data.user.id)
    })
  }, [])

  const loadConn = useCallback(async () => {
    if (!sessionUser) return
    const r = await fetch(`${API}/api/connections/whatsapp`, { headers: { 'x-user-id': sessionUser } })
    if (r.ok) {
      const data = await r.json()
      const raw: Conn[] = (data.connections && data.connections.length > 0)
        ? data.connections
        : data.connection
          ? [data.connection]
          : []
      const ignored = new Set(['consecom-user-9a6d110f-9a7-5'])
      const list = raw.filter((c) => !ignored.has(c.instance_name))
      setConns(list)
      const qrMap: Record<string, string> = {}
      const ignored = new Set(['consecom-user-9a6d110f-9a7-5'])
      for (const c of list) {
        if (ignored.has(c.instance_name)) continue
        const n = normalizeQr(c.qr_code)
        if (n) qrMap[c.id] = n
      }
      setQrByConn(qrMap)
    }
  }, [sessionUser])

  const loadNotifGroup = useCallback(async () => {
    if (!sessionUser) return
    const { data } = await supabase.from('notification_groups').select('*').eq('user_id', sessionUser).eq('enabled', true).limit(1).maybeSingle()
    if (data) setNotifGroup(data as NotifGroup)
  }, [sessionUser])

  const loadSettings = useCallback(async () => {
    if (!sessionUser) return
    const { data } = await supabase.from('notification_settings').select('key,value').eq('user_id', sessionUser)
    if (data) {
      const m: Record<string, boolean> = { ...settings }
      data.forEach((r: { key: string; value: unknown }) => {
        m[r.key] = r.value === true || r.value === 'true'
      })
      setSettings(m)
    }
  }, [sessionUser])

  useEffect(() => {
    if (!sessionUser) return
    loadConn()
    loadNotifGroup()
    loadSettings()
  }, [sessionUser, loadConn, loadNotifGroup, loadSettings])

  const busy = (id?: string) => (id && id !== null ? loadingId === id : loadingId !== null)

  /** Cria uma NOVA conexão (multi-WhatsApp). Sem forceNew na primária ausente. */
  async function addConnection(forceNew: boolean) {
    if (!sessionUser) return
    setLoadingId('__new__')
    try {
      const r = await fetch(`${API}/api/connections/whatsapp/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': sessionUser },
        body: forceNew ? JSON.stringify({ forceNew: true }) : undefined,
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        window.alert(err.error ?? `Falha ao conectar (HTTP ${r.status}).`)
        return
      }
      const data = await r.json()
      if (data.connection) {
        const n = normalizeQr(data.qrCode ?? data.connection.qr_code)
        setQrByConn((p) => (n ? { ...p, [data.connection.id]: n } : p))
        await loadConn()
      }
    } finally {
      setLoadingId(null)
    }
  }

  async function newQR(c: Conn) {
    if (!sessionUser) return
    setLoadingId(c.id)
    try {
      const r = await fetch(`${API}/api/connections/whatsapp/connect/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': sessionUser },
        body: JSON.stringify({ id: c.id }),
      })
      if (r.ok) {
        const data = await r.json()
        const n = normalizeQr(data.qrCode ?? data.connection?.qr_code)
        if (n) setQrByConn((p) => ({ ...p, [c.id]: n }))
        await loadConn()
      } else {
        const err = await r.json().catch(() => ({}))
        console.error('refresh failed', err)
      }
    } finally {
      setLoadingId(null)
    }
  }

  async function disconnect(c: Conn) {
    if (!sessionUser) return
    setLoadingId(c.id)
    try {
      const r = await fetch(`${API}/api/connections/whatsapp`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-user-id': sessionUser },
        body: JSON.stringify({ id: c.id }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        const msg = err.error === 'no_connection'
          ? 'Nenhum WhatsApp conectado para desconectar.'
          : err.error === 'evolution_logout_failed'
            ? 'Falha ao encerrar a sessão no WhatsApp. Tente novamente.'
            : err.error ?? `Falha ao desconectar (HTTP ${r.status}).`
        window.alert(msg)
        return
      }
      setQrByConn((p) => {
        const q = { ...p }
        delete q[c.id]
        return q
      })
      await loadConn()
    } finally {
      setLoadingId(null)
    }
  }

  async function saveDisplayName(c: Conn) {
    const value = displayNameDrafts[c.id] ?? c.display_name ?? ''
    const displayName = value.trim() || null
    const { error } = await supabase
      .from('whatsapp_connections')
      .update({ display_name: displayName })
      .eq('id', c.id)
    if (error) {
      window.alert('Não foi possível salvar o nome desta conexão.')
      return
    }
    setConns((items) => items.map((item) => item.id === c.id ? { ...item, display_name: displayName } : item))
    setDisplayNameDrafts((items) => ({ ...items, [c.id]: displayName ?? '' }))
  }

  async function loadGroups() {
    if (!sessionUser) return
    setGroupError(null)
    try {
      const r = await fetch(`${API}/api/connections/whatsapp/groups`, { headers: { 'x-user-id': sessionUser } })
      if (r.ok) {
        const data = await r.json()
        if (data.groups) setGroups(data.groups)
      } else {
        const err = await r.json().catch(() => ({}))
        setGroupError(err.error ?? 'Falha ao carregar grupos.')
      }
    } catch (e) {
      console.error('loadGroups failed', e)
      setGroupError('Não foi possível carregar os grupos. Verifique a conexão.')
    } finally {
      setShowGroupList(true)
    }
  }

  async function selectGroup(g: Group) {
    if (!sessionUser) return
    if (notifGroup) {
      await supabase.from('notification_groups').delete().eq('id', notifGroup.id)
    }
    const { data, error } = await supabase
      .from('notification_groups')
      .insert({ user_id: sessionUser, group_id: g.id, group_name: g.name, enabled: true })
      .select()
      .single()
    if (!error && data) {
      setNotifGroup(data as NotifGroup)
    }
    setShowGroupList(false)
  }

  async function removeGroup() {
    if (!notifGroup || !sessionUser) return
    await supabase.from('notification_groups').delete().eq('id', notifGroup.id)
    setNotifGroup(null)
  }

  async function testGroup() {
    if (!notifGroup || !sessionUser) return
    setLoadingId('__group__')
    await fetch(`${API}/api/connections/groups/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': sessionUser },
      body: JSON.stringify({ groupId: notifGroup.group_id }),
    })
    setLoadingId(null)
  }

  async function toggleSetting(key: string, value: boolean) {
    const ns = { ...settings, [key]: value }
    setSettings(ns)
    if (!sessionUser) return
    await supabase.from('notification_settings').upsert(
      { user_id: sessionUser, key, value: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,key' },
    )
  }

  // REALTIME: reage na hora a mudanças de status/QR das conexões
  // (webhook da Evolution, reconexão, worker sincronizando status).
  // O fallback de polling a cada 10s cobre mudanças que o realtime perder.
  useEffect(() => {
    if (!sessionUser) return
    const channel = supabase
      .channel('connections-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_connections' }, () => {
        void loadConn()
      })
      .subscribe()
    const fallback = setInterval(() => void loadConn(), 10000)
    return () => {
      supabase.removeChannel(channel)
      clearInterval(fallback)
    }
  }, [sessionUser, loadConn])

  const statusColor = (st: ConnStatus) =>
    st === 'connected' ? 'text-emerald-400'
    : st === 'connecting' || st === 'pending' ? 'text-amber-400'
    : st === 'error' ? 'text-red-400'
    : 'text-muted'

  const statusDot = (st: ConnStatus) =>
    st === 'connected' ? '#34d399'
    : st === 'connecting' || st === 'pending' ? '#fbbf24'
    : st === 'error' ? '#f87171'
    : '#64748b'

  const statusLabel = (st: ConnStatus) =>
    st === 'connected' ? 'Conectado'
    : st === 'connecting' ? 'Aguardando conexão'
    : st === 'pending' ? 'Aguardando'
    : st === 'error' ? 'Erro'
    : st === 'disconnected' ? 'Desconectado'
    : 'Sem conexão'

  const filteredGroups = groups.filter((g) => g.name.toLowerCase().includes(groupSearch.toLowerCase()))

  const input = 'w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500'
  const label = 'block text-xs text-muted mb-1'
  const btn = 'px-3 py-2 text-sm rounded-lg font-medium transition'
  const btnPrimary = `${btn} bg-indigo-600 hover:bg-indigo-500 text-white`
  const btnGhost = `${btn} bg-subtle hover:bg-subtle-2 text-secondary`
  const btnDanger = `${btn} bg-red-600/20 hover:bg-red-600/40 text-red-300`

  const hasConnected = conns.some((c) => c.status === 'connected')

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-3xl">
      <h1 className="text-lg font-semibold mb-1">Conexões</h1>
      <p className="text-sm text-muted mb-6">Gerencie suas integrações externas.</p>

      <div className="space-y-6">
        {/* === CARD 1: WhatsApp (multi-conexão) === */}
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-secondary">WhatsApp</h2>
            <span className="text-sm font-medium text-muted">
              {conns.length} conexão{conns.length !== 1 ? 'ões' : ''}
            </span>
          </div>

          {conns.length === 0 && (
            <button onClick={() => addConnection(false)} className={btnPrimary} disabled={busy()}>
              Conectar WhatsApp
            </button>
          )}

          {/* Lista de conexões */}
          <div className="space-y-4">
            {conns.map((c, idx) => {
              const qr = qrByConn[c.id]
              const connecting = c.status === 'connecting' || c.status === 'pending'
              return (
                <div key={c.id} className="rounded-xl border border-line-2 bg-subtle-2 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-secondary">
                      WhatsApp {idx + 1}
                    </span>
                    <span className={`text-sm font-medium ${statusColor(c.status)}`}>
                      <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                        style={{ background: statusDot(c.status) }}
                      />
                      {statusLabel(c.status)}
                    </span>
                  </div>

                  {/* Dados da conexão */}
                  {(c.status === 'connected' || c.phone_number) && (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className={label}>Número conectado</span>
                        <span className="text-fg">{c.phone_number ? formatPhone(c.phone_number) : '—'}</span>
                      </div>
                      <div>
                        <span className={label}>Nome do WhatsApp</span>
                        <span className="text-fg">{c.whatsapp_name ?? '—'}</span>
                      </div>
                      <div>
                        <label className={label} htmlFor={`display-name-${c.id}`}>Nome que aparecerá nas mensagens</label>
                        <input
                          id={`display-name-${c.id}`}
                          value={displayNameDrafts[c.id] ?? c.display_name ?? ''}
                          placeholder="Ex.: João"
                          maxLength={80}
                          className="w-full rounded-md border border-line-2 bg-subtle-2 px-2 py-1 text-sm text-fg"
                          onChange={(event) => setDisplayNameDrafts((items) => ({ ...items, [c.id]: event.target.value }))}
                        />
                        <button onClick={() => void saveDisplayName(c)} className={`${btnGhost} mt-2`} disabled={busy(c.id)}>
                          Salvar alterações
                        </button>
                      </div>
                      {c.last_sync_at && (
                        <div>
                          <span className={label}>Última sincronização</span>
                          <span className="text-fg">{new Date(c.last_sync_at).toLocaleString('pt-BR')}</span>
                        </div>
                      )}
                      <div>
                        <span className={label}>Instância</span>
                        <span className="text-fg text-xs font-mono break-all">{c.instance_name}</span>
                      </div>
                    </div>
                  )}

                  {/* QR Code area */}
                  {connecting && qr && (
                    <div className="flex flex-col items-center py-2">
                      <div className="bg-white rounded-lg p-3 mb-3">
                        <img src={qr} alt={`QR Code ${idx + 1}`} className="w-48 h-48" />
                      </div>
                      <p className="text-sm text-muted text-center max-w-xs">
                        Escaneie o QR Code pelo WhatsApp → Dispositivos conectados → Conectar dispositivo.
                      </p>
                    </div>
                  )}
                  {connecting && !qr && (
                    <div className="flex items-center justify-center py-4">
                      <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
                      <span className="ml-3 text-sm text-muted">Gerando QR Code…</span>
                    </div>
                  )}

                  {/* Ações por conexão */}
                  <div className="flex flex-wrap gap-2">
                    {c.status === 'connected' && (
                      <button onClick={() => disconnect(c)} className={btnDanger} disabled={busy(c.id)}>
                        Desconectar
                      </button>
                    )}
                    {connecting && (
                      <button onClick={() => newQR(c)} className={btnGhost} disabled={busy(c.id)}>
                        Gerar novo QR Code
                      </button>
                    )}
                    {(c.status === 'disconnected') && (
                      <button onClick={() => newQR(c)} className={btnPrimary} disabled={busy(c.id)}>
                        Reconectar
                      </button>
                    )}
                    {c.status === 'error' && (
                      <button onClick={() => newQR(c)} className={btnPrimary} disabled={busy(c.id)}>
                        Tentar novamente
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Conectar outro WhatsApp */}
          <div className="pt-2">
            <button onClick={() => addConnection(true)} className={btnGhost} disabled={busy('__new__')}
              title="Conecta um segundo número sem desconectar o atual">
              + Conectar outro WhatsApp
            </button>
          </div>
        </section>

        {/* === CARD 2: Grupo de Notificações === */}
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <h2 className="text-sm font-semibold text-secondary">Grupo de Notificações</h2>

          {!hasConnected ? (
            <p className="text-sm text-faint">
              Conecte o WhatsApp primeiro para selecionar um grupo de notificações.
            </p>
          ) : notifGroup ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className={label}>Grupo selecionado</span>
                  <span className="text-fg">{notifGroup.group_name}</span>
                </div>
                <div>
                  <span className={label}>ID do grupo</span>
                  <span className="text-fg text-xs font-mono break-all">{notifGroup.group_id}</span>
                </div>
                <div>
                  <span className={label}>Status</span>
                  <span className="text-emerald-400">Ativo</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={testGroup} className={btnGhost} disabled={busy('__group__')}>
                  Testar envio
                </button>
                <button onClick={loadGroups} className={btnGhost}>
                  Alterar grupo
                </button>
                <button onClick={removeGroup} className={btnDanger}>
                  Remover grupo
                </button>
              </div>
            </div>
          ) : showGroupList ? (
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Buscar grupos…"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                className={input}
              />
              <div className="max-h-64 overflow-auto space-y-1">
                {groupError ? (
                  <p className="text-sm text-red-300 py-4 text-center">{groupError}</p>
                ) : filteredGroups.length === 0 ? (
                  <p className="text-sm text-faint py-4 text-center">Nenhum grupo encontrado.</p>
                ) : (
                  filteredGroups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => selectGroup(g)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-subtle text-sm text-fg transition"
                    >
                      {g.name}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <button onClick={loadGroups} className={btnPrimary}>
              Selecionar grupo
            </button>
          )}
        </section>

        {/* === CARD 3: Preferências de Notificação === */}
        <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
          <h2 className="text-sm font-semibold text-secondary">Preferências de Notificação</h2>
          <div className="space-y-3">
            {([
              ['notify_meetings', 'Notificar novas reuniões'],
              ['notify_reschedules', 'Notificar reuniões reagendadas'],
              ['notify_cancellations', 'Notificar reuniões canceladas'],
              ['notify_sales', 'Notificar novos clientes fechados'],
              ['notify_campaigns', 'Notificar campanhas finalizadas'],
              ['daily_summary', 'Enviar resumo diário'],
            ] as const).map(([key, labelText]) => (
              <label key={key} className="flex items-center gap-3 text-sm text-secondary cursor-pointer">
                <button
                  type="button"
                  onClick={() => toggleSetting(key, !settings[key])}
                  className={`relative w-11 h-6 rounded-full transition ${settings[key] ? 'bg-indigo-500' : 'bg-subtle-2'}`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings[key] ? 'left-5' : 'left-0.5'}`}
                  />
                </button>
                {labelText}
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
