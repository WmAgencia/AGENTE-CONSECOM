import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, BellRing, Bell, Settings, Home as HomeIcon } from 'lucide-react'
import { supabase } from './lib/supabase'
import { registerDeepLinkHandler } from './lib/deeplink'
import {
  ensureChannels,
  requestNotificationPermission,
  syncAlarms,
  setDefaultReminder,
} from './services/alarms'
import { subscribeRealtimeNotifications } from './services/realtime'
import { fetchDashboard, type DashboardSnapshot } from './services/data'
import { HomeScreen } from './screens/HomeScreen'
import { MeetingsScreen } from './screens/MeetingsScreen'
import { AlarmsScreen } from './screens/AlarmsScreen'
import { NotificationsScreen } from './screens/NotificationsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ConnectScreen } from './screens/ConnectScreen'
import type { ReminderPrefs, NotifPrefs } from './lib/types'
import { loadReminderPrefs, loadNotifPrefs, setLeadReminder, clearLeadReminder } from './lib/types'

type Tab = 'hoje' | 'reunioes' | 'alarmes' | 'notificacoes' | 'ajustes'

type AuthState = 'loading' | 'signed-out' | 'signed-in'

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading')
  const [tab, setTab] = useState<Tab>('hoje')
  const [data, setData] = useState<DashboardSnapshot | null>(null)
  const [reminder, setReminder] = useState<ReminderPrefs | null>(null)
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<number | null>(null)
  const dataRef = useRef<DashboardSnapshot | null>(null)

  // ---- Autenticação: sessão persistida ou deep-link do site ----
  useEffect(() => {
    let disposed = false
    const refresh = () => {
      if (disposed) return
      supabase.auth.getSession().then(({ data: s }) => {
        setAuth(s.session ? 'signed-in' : 'signed-out')
      })
    }

    refresh()
    const { data: sub } = supabase.auth.onAuthStateChange(() => refresh())
    const disposeDeepLink = registerDeepLinkHandler(() => {
      // Ao receber sessão via deep-link, recarrega e entra direto
      setAuth('signed-in')
    })

    return () => {
      disposed = true
      sub.subscription.unsubscribe()
      disposeDeepLink()
    }
  }, [])

  // ---- Bootstrap de canais + preferências + permissão de notificação ----
  useEffect(() => {
    if (auth !== 'signed-in') return
    void ensureChannels().catch(() => undefined)
    void loadReminderPrefs().then(setReminder)
    void loadNotifPrefs().then(setNotifPrefs)
    // Permissão de notificação na primeira abertura (UX com rationale)
    void requestNotificationPermission()
  }, [auth])

  // ---- Sync de alarmes + dados ----
  const runSync = useCallback(async () => {
    if (auth !== 'signed-in') return
    try {
      const snapshot = await fetchDashboard()
      dataRef.current = snapshot
      setData(snapshot)
      await syncAlarms(snapshot.leads)
      setSyncError(null)
      setLastSync(Date.now())
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Falha ao sincronizar')
    }
  }, [auth])

  useEffect(() => {
    if (auth === 'signed-in') void runSync()
  }, [auth, runSync])

  // ---- Realtime: re-sync em mudanças relevantes + notificações de eventos ----
  useEffect(() => {
    if (auth !== 'signed-in') return

    const unsubNotifs = subscribeRealtimeNotifications()
    const channel = supabase
      .channel('mobile-refresh')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leads' },
        () => void runSync(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaigns' },
        () => void runSync(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'consecom_conversations' },
        () => void runSync(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_connections' },
        () => void runSync(),
      )
      .subscribe()

    // Refresco periódico (fallback offline / reconexão)
    const t = window.setInterval(() => void runSync(), 60_000)

    return () => {
      unsubNotifs()
      void supabase.removeChannel(channel)
      window.clearInterval(t)
    }
  }, [auth, runSync])

  // ---- Handlers compartilhados ----
  const handleReminderChange = useCallback(
    async (minutes: number) => {
      await setDefaultReminder(minutes)
      const p = await loadReminderPrefs()
      setReminder(p)
      if (dataRef.current) await syncAlarms(dataRef.current.leads)
    },
    [],
  )

  const handleLeadReminderChange = useCallback(
    async (leadId: string, minutes: number) => {
      const p = await setLeadReminder(leadId, minutes)
      setReminder(p)
      if (dataRef.current) await syncAlarms(dataRef.current.leads)
    },
    [],
  )

  const handleClearLeadReminder = useCallback(async (leadId: string) => {
    const p = await clearLeadReminder(leadId)
    setReminder(p)
    if (dataRef.current) await syncAlarms(dataRef.current.leads)
  }, [])

  // Som/volume/vibração mudou (padrão ou por reunião) -> reaplica o plano
  const handleSoundChanged = useCallback(async () => {
    const p = await loadReminderPrefs()
    setReminder(p)
    if (dataRef.current) await syncAlarms(dataRef.current.leads)
  }, [])

  if (auth === 'loading') {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-slate-400">Carregando…</div>
      </div>
    )
  }

  if (auth === 'signed-out') {
    return <ConnectScreen />
  }

  return (
    <div className="h-full flex flex-col max-w-lg mx-auto">
      <div className="flex-1 overflow-y-auto safe-top px-4 pb-28">
        {tab === 'hoje' && (
          <HomeScreen
            data={data}
            reminder={reminder}
            lastSync={lastSync}
            syncError={syncError}
            onRefresh={() => void runSync()}
            onOpenTab={(t) => setTab(t)}
          />
        )}
        {tab === 'reunioes' && (
          <MeetingsScreen
            leads={data?.leads ?? []}
            reminder={reminder}
            onLeadReminderChange={handleLeadReminderChange}
            onClearLeadReminder={handleClearLeadReminder}
            onSoundChanged={() => void handleSoundChanged()}
            onRefresh={() => void runSync()}
          />
        )}
        {tab === 'alarmes' && (
          <AlarmsScreen
            leads={data?.leads ?? []}
            reminder={reminder}
            lastSync={lastSync}
            onLeadReminderChange={handleLeadReminderChange}
            onClearLeadReminder={handleClearLeadReminder}
          />
        )}
        {tab === 'notificacoes' && (
          <NotificationsScreen prefs={notifPrefs} onChange={setNotifPrefs} />
        )}
        {tab === 'ajustes' && (
          <SettingsScreen
            reminder={reminder}
            onReminderChange={handleReminderChange}
            onSoundChanged={() => void handleSoundChanged()}
            lastSync={lastSync}
          />
        )}
      </div>

      <nav className="fixed bottom-0 inset-x-0 border-t border-white/10 bg-[#0d0d14]/95 backdrop-blur safe-bottom">
        <div className="grid grid-cols-5 max-w-lg mx-auto">
          {(
            [
              { key: 'hoje', label: 'Hoje', icon: HomeIcon },
              { key: 'reunioes', label: 'Reuniões', icon: CalendarDays },
              { key: 'alarmes', label: 'Alarmes', icon: Bell },
              { key: 'notificacoes', label: 'Avisos', icon: BellRing },
              { key: 'ajustes', label: 'Ajustes', icon: Settings },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex flex-col items-center gap-1 py-3 text-[10px] transition ${
                tab === key ? 'text-indigo-300' : 'text-slate-500'
              }`}
            >
              <Icon className="w-5 h-5" />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
