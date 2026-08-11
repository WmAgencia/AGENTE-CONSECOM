import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarDays,
  BellRing,
  Bell,
  Settings,
  Home as HomeIcon,
  MessageSquareText,
} from 'lucide-react'
import { LocalNotifications } from '@capacitor/local-notifications'
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
import { ChatScreen } from './screens/ChatScreen'
import { MeetingsScreen } from './screens/MeetingsScreen'
import { AlarmsScreen } from './screens/AlarmsScreen'
import { NotificationsScreen } from './screens/NotificationsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ConnectScreen } from './screens/ConnectScreen'
import type { ReminderPrefs, NotifPrefs } from './lib/types'
import { loadReminderPrefs, loadNotifPrefs, setLeadReminder, clearLeadReminder } from './lib/types'

type Tab = 'chat' | 'hoje' | 'reunioes' | 'alarmes' | 'notificacoes' | 'ajustes'

type AuthState = 'loading' | 'signed-out' | 'signed-in'

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading')
  const [tab, setTab] = useState<Tab>('chat')
  const [data, setData] = useState<DashboardSnapshot | null>(null)
  const [reminder, setReminder] = useState<ReminderPrefs | null>(null)
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [notifBadge, setNotifBadge] = useState(0)
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
    void requestNotificationPermission()
  }, [auth])

  // ---- Notificações locais: badge + abertura por toque (deep link) ----
  useEffect(() => {
    if (auth !== 'signed-in') return
    let disposed = false

    void LocalNotifications.addListener('localNotificationReceived', () => {
      if (!disposed) setNotifBadge((n) => n + 1)
    })
    void LocalNotifications.addListener(
      'localNotificationActionPerformed',
      ({ notification }) => {
        if (disposed) return
        setNotifBadge(0)
        const extra = notification.extra as { tab?: Tab } | undefined
        if (extra?.tab) setTab(extra.tab)
      },
    )

    return () => {
      disposed = true
    }
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

  const handleSoundChanged = useCallback(async () => {
    const p = await loadReminderPrefs()
    setReminder(p)
    if (dataRef.current) await syncAlarms(dataRef.current.leads)
  }, [])

  const openTab = useCallback((t: Tab) => {
    setTab(t)
    if (t === 'notificacoes') setNotifBadge(0)
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

  const navPrimary: { key: Tab; label: string; icon: typeof MessageSquareText }[] = [
    { key: 'chat', label: 'Chat', icon: MessageSquareText },
  ]
  const navMiddle: { key: Tab; label: string; icon: typeof HomeIcon }[] = [
    { key: 'hoje', label: 'Hoje', icon: HomeIcon },
    { key: 'reunioes', label: 'Reuniões', icon: CalendarDays },
    { key: 'alarmes', label: 'Alarmes', icon: Bell },
    { key: 'notificacoes', label: 'Avisos', icon: BellRing },
  ]

  return (
    <div className="h-full flex max-w-5xl mx-auto">
      {/* Sidebar esquerda */}
      <aside className="w-20 shrink-0 border-r border-white/10 bg-[#0d0d14] flex flex-col safe-top safe-bottom">
        <div className="px-4 pt-3 pb-4 flex justify-center">
          <img
            src="assets/icon-only.png"
            alt="Vyntra"
            className="w-9 h-9 rounded-xl object-contain bg-white"
          />
        </div>

        {/* Chat — função principal, no topo */}
        <nav className="flex-1 flex flex-col items-center gap-1 px-2 overflow-y-auto">
          {navPrimary.map(({ key, label, icon: Icon }) => (
            <SidebarItem
              key={key}
              active={tab === key}
              label={label}
              icon={Icon}
              onClick={() => openTab(key)}
            />
          ))}
          <div className="w-8 h-px bg-white/10 my-1" />
          {navMiddle.map(({ key, label, icon: Icon }) => (
            <SidebarItem
              key={key}
              active={tab === key}
              label={label}
              icon={Icon}
              badge={key === 'notificacoes' ? notifBadge : 0}
              onClick={() => openTab(key)}
            />
          ))}
        </nav>

        {/* Configurações — no rodapé */}
        <nav className="px-2 pb-4 flex flex-col items-center">
          <SidebarItem
            active={tab === 'ajustes'}
            label="Ajustes"
            icon={Settings}
            onClick={() => openTab('ajustes')}
          />
        </nav>
      </aside>

      {/* Conteúdo */}
      <main className="flex-1 flex flex-col min-w-0">
        {tab === 'chat' ? (
          <div className="flex-1 min-h-0 px-4 pt-4 pb-4 safe-top overflow-hidden">
            <ChatScreen />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 pb-10 pt-4 safe-top">
            {tab === 'hoje' && (
              <HomeScreen
                data={data}
                reminder={reminder}
                lastSync={lastSync}
                syncError={syncError}
                onRefresh={() => void runSync()}
                onOpenTab={(t) => openTab(t)}
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
        )}
      </main>
    </div>
  )
}

function SidebarItem({
  active,
  label,
  icon: Icon,
  badge = 0,
  onClick,
}: {
  active: boolean
  label: string
  icon: typeof HomeIcon
  badge?: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`relative w-full flex flex-col items-center gap-1 py-2.5 rounded-xl transition ${
        active ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-500 hover:bg-white/5'
      }`}
    >
      <Icon className="w-5 h-5" />
      <span className="text-[9px] leading-tight text-center">{label}</span>
      {badge > 0 && (
        <span className="absolute top-1 right-2 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  )
}
