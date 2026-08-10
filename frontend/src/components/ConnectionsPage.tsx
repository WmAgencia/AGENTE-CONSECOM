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

interface Conn {
  id: string
  instance_name: string
  phone_number: string | null
  whatsapp_name: string | null
  status: ConnStatus
  qr_code: string | null
  last_sync_at: string | null
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
  const [conn, setConn] = useState<Conn | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [notifGroup, setNotifGroup] = useState<NotifGroup | null>(null)
  const [loading, setLoading] = useState(false)
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
      if (data.connection) {
        setConn(data.connection)
        const normalized = normalizeQr(data.connection.qr_code)
        if (normalized) {
          setQr(normalized)
        } else if (data.connection.status === 'connected') {
          // Não estamos mais aguardando scan — limpa QR local.
          setQr(null)
        }
      }
    }
  }, [sessionUser])

  const loadNotifGroup = useCallback(async () => {
    if (!sessionUser) return
    const { data } = await supabase.from('notification_groups').select('*').eq('user_id', sessionUser).eq('enabled', true).limit(1).single()
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

  // Polling: refresh connection status every 5s when connecting
  useEffect(() => {
    if (!conn || conn.status === 'connected' || conn.status === 'disconnected') return
    const t = setInterval(loadConn, 5000)
    return () => clearInterval(t)
  }, [conn, loadConn])

  // Quando conectar, esconde QR local imediatamente (sem precisar esperar polling)
  useEffect(() => {
    if (conn?.status === 'connected' || conn?.status === 'disconnected') {
      setQr(null)
    }
  }, [conn?.status])

  async function connect() {
    if (!sessionUser) return
    setLoading(true)
    try {
      const r = await fetch(`${API}/api/connections/whatsapp/connect`, {
        method: 'POST',
        headers: { 'x-user-id': sessionUser },
      })
      if (r.ok) {
        const data = await r.json()
        const normalized = normalizeQr(data.qrCode)
        if (normalized) setQr(normalized)
        loadConn()
      }
    } finally {
      setLoading(false)
    }
  }

  async function newQR() {
    if (!sessionUser) return
    setLoading(true)
    try {
      // Rota "refresh" pedida no spec (POST /api/connections/whatsapp/connect/refresh).
      // /qr continua funcionando como alias.
      const r = await fetch(`${API}/api/connections/whatsapp/connect/refresh`, {
        method: 'POST',
        headers: { 'x-user-id': sessionUser },
      })
      if (r.ok) {
        const data = await r.json()
        const normalized = normalizeQr(data.qrCode)
        if (normalized) {
          setQr(normalized)
        } else {
          // Sem QR imediato — mantém o anterior mas força polling
          loadConn()
        }
      } else {
        const err = await r.json().catch(() => ({}))
        console.error('refresh failed', err)
      }
    } finally {
      setLoading(false)
    }
  }

  async function disconnect() {
    if (!sessionUser) return
    setLoading(true)
    try {
      const r = await fetch(`${API}/api/connections/whatsapp`, {
        method: 'DELETE',
        headers: { 'x-user-id': sessionUser },
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        const msg = err.error === 'no_connection'
          ? 'Nenhum WhatsApp conectado para desconectar.'
          : err.error ?? `Falha ao desconectar (HTTP ${r.status}).`
        window.alert(msg)
        return
      }
      setQr(null)
      await loadConn()
    } finally {
      setLoading(false)
    }
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
    setLoading(true)
    await fetch(`${API}/api/connections/groups/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': sessionUser },
      body: JSON.stringify({ groupId: notifGroup.group_id }),
    })
    setLoading(false)
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

  const statusColor =
    conn?.status === 'connected' ? 'text-emerald-400'
    : conn?.status === 'connecting' || conn?.status === 'pending' ? 'text-amber-400'
    : conn?.status === 'error' ? 'text-red-400'
    : 'text-slate-400'
  const statusLabel =
    conn?.status === 'connected' ? 'Conectado'
    : conn?.status === 'connecting' ? 'Aguardando conexão'
    : conn?.status === 'pending' ? 'Aguardando'
    : conn?.status === 'error' ? 'Erro'
    : conn?.status === 'disconnected' ? 'Desconectado'
    : 'Sem conexão'

  const filteredGroups = groups.filter((g) => g.name.toLowerCase().includes(groupSearch.toLowerCase()))

  const input = 'w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500'
  const label = 'block text-xs text-slate-400 mb-1'
  const btn = 'px-3 py-2 text-sm rounded-lg font-medium transition'
  const btnPrimary = `${btn} bg-indigo-600 hover:bg-indigo-500 text-white`
  const btnGhost = `${btn} bg-white/5 hover:bg-white/10 text-slate-300`
  const btnDanger = `${btn} bg-red-600/20 hover:bg-red-600/40 text-red-300`

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-3xl">
      <h1 className="text-lg font-semibold mb-1">Conexões</h1>
      <p className="text-sm text-slate-400 mb-6">Gerencie suas integrações externas.</p>

      <div className="space-y-6">
        {/* === CARD 1: WhatsApp === */}
        <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">WhatsApp</h2>
            <span className={`text-sm font-medium ${statusColor}`}>
              <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                style={{
                  background: conn?.status === 'connected' ? '#34d399'
                    : conn?.status === 'connecting' || conn?.status === 'pending' ? '#fbbf24'
                    : conn?.status === 'error' ? '#f87171'
                    : '#64748b',
                }}
              />
              {statusLabel}
            </span>
          </div>

          {conn?.phone_number && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className={label}>Número conectado</span>
                <span className="text-slate-200">{conn.phone_number}</span>
              </div>
              <div>
                <span className={label}>Nome do WhatsApp</span>
                <span className="text-slate-200">{conn.whatsapp_name ?? '—'}</span>
              </div>
              <div>
                <span className={label}>Última sincronização</span>
                <span className="text-slate-200">{conn.last_sync_at ? new Date(conn.last_sync_at).toLocaleString('pt-BR') : '—'}</span>
              </div>
            </div>
          )}

          {/* QR Code area */}
          {(conn?.status === 'connecting' || conn?.status === 'pending' || (!conn && loading)) && qr && (
            <div className="flex flex-col items-center py-4">
              <div className="bg-white rounded-lg p-3 mb-3">
                <img src={qr} alt="QR Code" className="w-48 h-48" />
             </div>
              <p className="text-sm text-slate-400 text-center max-w-xs">
                Escaneie o QR Code pelo WhatsApp → Dispositivos conectados → Conectar dispositivo.
             </p>
           </div>
          )}

          {loading && !qr && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
              <span className="ml-3 text-sm text-slate-400">Gerando QR Code…</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {!conn && (
              <button onClick={connect} className={btnPrimary} disabled={loading}>
                Conectar WhatsApp
              </button>
            )}
            {conn && (conn.status === 'connecting' || conn.status === 'pending') && (
              <>
                <button onClick={newQR} className={btnGhost} disabled={loading}>
                  Gerar novo QR Code
                </button>
              </>
            )}
            {conn && conn.status === 'connected' && (
              <button onClick={disconnect} className={btnDanger} disabled={loading}>
                Desconectar
              </button>
            )}
            {conn && conn.status === 'disconnected' && (
              <button onClick={newQR} className={btnPrimary} disabled={loading}>
                Reconectar
              </button>
            )}
            {conn && conn.status === 'error' && (
              <button onClick={newQR} className={btnPrimary} disabled={loading}>
                Tentar novamente
              </button>
            )}
          </div>
        </section>

        {/* === CARD 2: Grupo de Notificações === */}
        <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-300">Grupo de Notificações</h2>

          {conn?.status !== 'connected' ? (
            <p className="text-sm text-slate-500">
              Conecte o WhatsApp primeiro para selecionar um grupo de notificações.
            </p>
          ) : notifGroup ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className={label}>Grupo selecionado</span>
                  <span className="text-slate-200">{notifGroup.group_name}</span>
                </div>
                <div>
                  <span className={label}>ID do grupo</span>
                  <span className="text-slate-200 text-xs font-mono break-all">{notifGroup.group_id}</span>
                </div>
                <div>
                  <span className={label}>Status</span>
                  <span className="text-emerald-400">Ativo</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={testGroup} className={btnGhost} disabled={loading}>
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
                  <p className="text-sm text-slate-500 py-4 text-center">Nenhum grupo encontrado.</p>
                ) : (
                  filteredGroups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => selectGroup(g)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-sm text-slate-200 transition"
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
        <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-300">Preferências de Notificação</h2>
          <div className="space-y-3">
            {([
              ['notify_meetings', 'Notificar novas reuniões'],
              ['notify_reschedules', 'Notificar reuniões reagendadas'],
              ['notify_cancellations', 'Notificar reuniões canceladas'],
              ['notify_sales', 'Notificar novos clientes fechados'],
              ['notify_campaigns', 'Notificar campanhas finalizadas'],
              ['daily_summary', 'Enviar resumo diário'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-3 text-sm text-slate-300 cursor-pointer">
                <button
                  type="button"
                  onClick={() => toggleSetting(key, !settings[key])}
                  className={`relative w-11 h-6 rounded-full transition ${settings[key] ? 'bg-indigo-500' : 'bg-white/10'}`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings[key] ? 'left-5' : 'left-0.5'}`}
                  />
                </button>
                {label}
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
