import { useEffect, useRef, useState } from 'react'
import { supabase, type WhatsAppConnection } from '../lib/supabase'

const API = import.meta.env.VITE_BACKEND_URL ?? 'https://consecom-backend-production.up.railway.app'
const POPUP_SECONDS = 60

type AlertKind = 'rotation' | 'reconnect'

interface QrAlert {
  kind: AlertKind
  connection: WhatsAppConnection
  name: string
  qr: string | null
}

function normalizeQr(value: string | null | undefined): string | null {
  if (!value) return null
  let s = value.trim()
  if (!s.startsWith('data:image/png;base64,')) return null
  const b64 = s.slice('data:image/png;base64,'.length)
  if (b64.length < 80) return null
  return s
}

function displayName(c: WhatsAppConnection): string {
  return c.display_name ?? c.whatsapp_name ?? c.phone_number ?? c.instance_name
}

/**
 * Popup GLOBAL de QR Code, montado no Shell (aparece em qualquer tela).
 *
 * Dois gatilhos:
 *  1. ROTAÇÃO (rotation_of set, status pending/connecting): instância nova
 *     criada para a campanha — escanear conecta e o backend troca as
 *     referências (campaigns/send_runs) e apaga a instância antiga.
 *  2. RECONEXÃO (conexão conectada caiu sozinha): mostra o QR para
 *     reconectar mantendo a MESMA instância, exibindo o nome cadastrado.
 *
 * Cada alerta tem timer de 1 minuto. "Pular" fecha o alerta (na rotação,
 * mantém a instância antiga via POST /api/campaigns/rotation/skip).
 */
export function ConnectionQrOverlay() {
  const [alerts, setAlerts] = useState<QrAlert[]>([])
  const [secondsLeft, setSecondsLeft] = useState(POPUP_SECONDS)
  const alertsRef = useRef<QrAlert[]>([])
  const prevStatusRef = useRef<Record<string, string>>({})
  const seenRef = useRef<Set<string>>(new Set())
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null))
  }, [])

  const syncAlerts = (updater: (prev: QrAlert[]) => QrAlert[]) => {
    setAlerts((prev) => {
      const next = updater(prev)
      alertsRef.current = next
      return next
    })
  }

  const dismiss = (alert: QrAlert) => {
    seenRef.current.add(`${alert.kind}:${alert.connection.id}`)
    syncAlerts((prev) => prev.filter((a) => !(a.kind === alert.kind && a.connection.id === alert.connection.id)))
  }

  const skipRotation = async (alert: QrAlert) => {
    if (alert.kind !== 'rotation') {
      dismiss(alert)
      return
    }
    try {
      await fetch(`${API}/api/campaigns/rotation/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId ?? '' },
        body: JSON.stringify({ connectionId: alert.connection.id }),
      })
    } catch {
      // backend inacessível — mesmo assim fecha o alerta localmente
    }
    dismiss(alert)
  }

  const refreshQr = async (conn: WhatsAppConnection) => {
    try {
      const res = await fetch(`${API}/api/connections/whatsapp/connect/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId ?? '' },
        body: JSON.stringify({ id: conn.id }),
      })
      if (!res.ok) return
      const data = (await res.json()) as { qrCode?: string }
      const qr = normalizeQr(data.qrCode)
      if (qr) {
        syncAlerts((prev) =>
          prev.map((a) =>
            a.connection.id === conn.id ? { ...a, qr } : a,
          ),
        )
      }
    } catch {
      // sem QR ainda — o webhook QRCODE_UPDATED pode chegar depois
    }
  }

  useEffect(() => {
    if (!alerts.length) return
    const current = alerts[0]
    setSecondsLeft(POPUP_SECONDS)
    // Se um alerta de reconexão ainda não tem QR, busca na Evolution.
    if (current.kind === 'reconnect' && !current.qr) {
      void refreshQr(current.connection)
    }
    const t = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(t)
          void skipRotation(current)
          return POPUP_SECONDS
        }
        return s - 1
      })
    }, 1000)
    return () => window.clearInterval(t)
  }, [alerts.length > 0 ? alerts[0]?.connection.id : null, userId])

  useEffect(() => {
    const ch = supabase
      .channel('qr-overlay')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_connections' },
        (payload) => {
          const row = payload.new as WhatsAppConnection | null
          if (!row) return
          const prev = prevStatusRef.current[row.id]
          const key = `${row.rotation_of ? 'rotation' : 'reconnect'}:${row.id}`

          // Conexão conectada => remove qualquer alerta dela (rotação concluída).
          if (row.status === 'connected') {
            prevStatusRef.current[row.id] = row.status
            seenRef.current.delete(key)
            syncAlerts((prevAlerts) => prevAlerts.filter((a) => a.connection.id !== row.id))
            return
          }

          const isRotation = Boolean(row.rotation_of)
          const isActivePending = row.status === 'pending' || row.status === 'connecting'
          const fellSpontaneously = prev === 'connected' && (row.status === 'disconnected' || row.status === 'error') && !row.rotation_of && !row.superseded_by

          if (isRotation && isActivePending && !seenRef.current.has(key)) {
            seenRef.current.add(key)
            syncAlerts((prevAlerts) => {
              if (prevAlerts.some((a) => a.connection.id === row.id)) return prevAlerts
              return [...prevAlerts, { kind: 'rotation', connection: row, name: displayName(row), qr: normalizeQr(row.qr_code) }]
            })
          } else if (fellSpontaneously && !seenRef.current.has(key)) {
            seenRef.current.add(key)
            syncAlerts((prevAlerts) => {
              if (prevAlerts.some((a) => a.connection.id === row.id)) return prevAlerts
              return [...prevAlerts, { kind: 'reconnect', connection: row, name: displayName(row), qr: normalizeQr(row.qr_code) }]
            })
          }

          // Atualiza o QR em tempo real (webhook QRCODE_UPDATED).
          const newQr = normalizeQr(row.qr_code)
          if (newQr) {
            syncAlerts((prevAlerts) =>
              prevAlerts.map((a) => (a.connection.id === row.id ? { ...a, qr: newQr } : a)),
            )
          }

          prevStatusRef.current[row.id] = row.status
        },
      )
      .subscribe()

    // Carga inicial: detecta rotações pendentes já existentes.
    void supabase
      .from('whatsapp_connections')
      .select('*')
      .then(({ data, error }) => {
        if (error || !data) return
        const rows = data as WhatsAppConnection[]
        const prevMap: Record<string, string> = {}
        for (const r of rows) prevMap[r.id] = r.status
        prevStatusRef.current = prevMap
        const pendings = rows.filter(
          (r) => r.rotation_of && (r.status === 'pending' || r.status === 'connecting') && !r.superseded_by,
        )
        const pendingAlerts: QrAlert[] = pendings
          .filter((r) => !seenRef.current.has(`rotation:${r.id}`))
          .map((r) => {
            seenRef.current.add(`rotation:${r.id}`)
            return { kind: 'rotation', connection: r, name: displayName(r), qr: normalizeQr(r.qr_code) }
          })
        if (pendingAlerts.length) syncAlerts((prevAlerts) => [...prevAlerts, ...pendingAlerts])
      })

    return () => {
      supabase.removeChannel(ch)
    }
  }, [])

  const current = alerts[0]
  if (!current) return null

  const total = alerts.length
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0">
            <div className="font-semibold">
              {current.kind === 'rotation' ? '🔄 Novo WhatsApp pronto para escanear' : '📵 WhatsApp desconectou'}
            </div>
            <div className="text-sm text-fg font-medium mt-1 truncate">
              {current.name}
            </div>
          </div>
          {total > 1 && (
            <span className="shrink-0 text-[11px] px-2 py-1 rounded-full bg-subtle text-muted">
              {1} de {total}
            </span>
          )}
        </div>

        {current.kind === 'rotation' && (
          <p className="text-xs text-muted mb-3">
            Escaneie para usar esta instância nova na campanha. A instância
            antiga será apagada automaticamente após conectar.
          </p>
        )}
        {current.kind === 'reconnect' && (
          <p className="text-xs text-muted mb-3">
            Este WhatsApp caiu sozinho. Escaneie para reconectar nesta mesma
            instância e continuar a campanha.
          </p>
        )}

        <div className="rounded-xl bg-white p-3 flex items-center justify-center min-h-56">
          {current.qr ? (
            <img src={current.qr} alt="QR Code do WhatsApp" className="w-52 h-52 object-contain" />
          ) : (
            <div className="text-center text-faint text-sm px-4">
              Aguardando QR Code…
              <button
                onClick={() => void refreshQr(current.connection)}
                className="block mx-auto mt-2 text-[11px] px-3 py-1.5 rounded-lg bg-subtle hover:bg-subtle-2 text-secondary"
              >
                Gerar QR novamente
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-4">
          <div className="text-[11px] text-faint">
            Expira em {secondsLeft}s
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void skipRotation(current)}
              className="px-3 py-1.5 text-sm bg-subtle hover:bg-subtle-2 rounded-lg text-secondary"
            >
              {current.kind === 'rotation' ? 'Pular' : 'Fechar'}
            </button>
          </div>
        </div>
        {current.kind === 'rotation' && (
          <p className="text-[10px] text-faint mt-2">
            "Pular" mantém a instância atual do WhatsApp.
          </p>
        )}
      </div>
    </div>
  )
}
