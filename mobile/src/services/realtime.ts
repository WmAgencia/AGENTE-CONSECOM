import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { loadNotifPrefs, type NotifPrefs } from '../lib/types'
import { notifyEvent } from './alarms'

// =====================================================================
// Ponte Realtime -> Notificações.
// Subscreve nas tabelas já habilitadas na publicação supabase_realtime e
// dispara notificações locais conforme as preferências do usuário (#8).
// Tudo é local: nenhuma infraestrutura de push externa.
// =====================================================================

type Row = Record<string, unknown>
let idSeq = 1
const nextId = () => 10_000 + idSeq++

const has = (o: Row, k: string) => o[k] != null

export async function enabled(prefs: NotifPrefs, key: keyof NotifPrefs): Promise<boolean> {
  const p = prefs ?? (await loadNotifPrefs())
  return p[key]
}

function oldRow<T extends Row>(payload: RealtimePostgresChangesPayload<T>): T | null {
  const o = payload.old as T | null
  return o ?? null
}
function newRow<T extends Row>(payload: RealtimePostgresChangesPayload<T>): T | null {
  return payload.new as T | null
}

export function subscribeRealtimeNotifications(): () => void {
  let stopped = false

  void (async () => {
    const prefs = await loadNotifPrefs()

    const channel = supabase
      .channel('mobile-notifs')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'leads' },
        (payload) => {
          void handleLeadUpdate(payload as RealtimePostgresChangesPayload<Row>, prefs)
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'consecom_conversations' },
        (payload) => {
          void handleLeadReply(payload as RealtimePostgresChangesPayload<Row>, prefs)
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaigns' },
        (payload) => {
          void handleCampaign(payload as RealtimePostgresChangesPayload<Row>, prefs)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'whatsapp_connections' },
        (payload) => {
          void handleConnection(payload as RealtimePostgresChangesPayload<Row>, prefs)
        },
      )

    channel.subscribe()

    stopped
  })()

  return () => {
    stopped = true
    void supabase.removeChannel(supabase.channel('mobile-notifs'))
  }
}

async function handleLeadUpdate(
  payload: RealtimePostgresChangesPayload<Row>,
  prefs: NotifPrefs,
): Promise<void> {
  const old = oldRow(payload)
  const next = newRow(payload)
  if (!next) return

  const prevStatus = old?.status
  const status = next.status

  if (status === 'reuniao_marcada' && prevStatus !== 'reuniao_marcada') {
    if (await enabled(prefs, 'reuniao_marcada')) {
      await notifyEvent(
        'Reunião marcada',
        `Nova reunião: ${String(next.name ?? 'sem nome')}`,
        nextId(),
      )
    }
  } else if (status === 'reuniao_cancelada') {
    if (await enabled(prefs, 'reuniao_cancelada')) {
      await notifyEvent(
        'Reunião cancelada',
        `${String(next.name ?? 'Lead')} cancelou a reunião.`,
        nextId(),
      )
    }
  } else if (
    status === 'reuniao_marcada' &&
    prevStatus === 'reuniao_marcada' &&
    old &&
    has(old, 'meeting_at') &&
    old.meeting_at !== next.meeting_at
  ) {
    if (await enabled(prefs, 'reuniao_reagendada')) {
      await notifyEvent('Reunião reagendada', `${String(next.name ?? 'Lead')} mudou o horário.`, nextId())
    }
  }
}

async function handleLeadReply(
  payload: RealtimePostgresChangesPayload<Row>,
  prefs: NotifPrefs,
): Promise<void> {
  const row = newRow(payload)
  if (!row || row.role !== 'user') return
  if (await enabled(prefs, 'lead_respondeu')) {
    await notifyEvent(
      'Lead respondeu',
      `${String(row.content ?? 'Nova mensagem do lead').slice(0, 90)}`,
      nextId(),
    )
  }
}

async function handleCampaign(
  payload: RealtimePostgresChangesPayload<Row>,
  prefs: NotifPrefs,
): Promise<void> {
  const next = newRow(payload)
  const old = oldRow(payload)
  if (!next) return
  const name = String(next.name ?? 'Campanha')

  const prev = old?.status
  const status = next.status

  if (status === 'em_progresso' && prev !== 'em_progresso') {
    if (await enabled(prefs, 'campanha_iniciada')) {
      await notifyEvent('Campanha iniciada', `${name} começou a rodar.`, nextId())
    }
  } else if (status === 'finalizada' && prev !== 'finalizada') {
    if (await enabled(prefs, 'campanha_concluida')) {
      await notifyEvent('Campanha concluída', `${name} terminou.`, nextId())
    }
  } else if (status === 'cancelada') {
    if (await enabled(prefs, 'campanha_erro')) {
      await notifyEvent('Campanha cancelada', `${name} foi cancelada.`, nextId())
    }
  }
}

async function handleConnection(
  payload: RealtimePostgresChangesPayload<Row>,
  prefs: NotifPrefs,
): Promise<void> {
  const old = oldRow(payload)
  const next = newRow(payload)
  if (!next) return
  const prev = old?.status
  const status = next.status

  if (status !== 'connected' && prev === 'connected') {
    if (await enabled(prefs, 'whatsapp_desconectado')) {
      await notifyEvent(
        'WhatsApp desconectado',
        `Instância ${String(next.instance_name ?? '')} caiu. Reconecte no painel.`,
        nextId(),
      )
    }
  }
}