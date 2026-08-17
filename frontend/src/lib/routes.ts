import { type LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  SquareKanban,
  Megaphone,
  Users,
  Plug,
  Settings,
  Puzzle,
  BellRing,
  Bot,
  ContactRound,
  CalendarDays,
  UserPlus,
  UserCircle,
  Gem,
} from 'lucide-react'

export type Tab =
  | 'dashboard'
  | 'kanban'
  | 'campanhas'
  | 'agenda'
  | 'leads'
  | 'importados'
  | 'contatos'
  | 'ia'
  | 'conexoes'
  | 'agente'
  | 'voz'
  | 'extensao'
  | 'app-mobile'
  | 'prospeccao-manual'
  | 'planos'
  | 'conta'

export interface NavItem {
  key: Tab
  label: string
  icon: LucideIcon
  path: string
}

/** Cada tela relevante tem uma rota REAL (refrescar/voltar/links diretos funcionam). */
export const TAB_PATHS: Record<Tab, string> = {
  dashboard: '/dashboard',
  kanban: '/kanban',
  campanhas: '/campanhas',
  agenda: '/agenda',
  leads: '/leads',
  importados: '/importados',
  contatos: '/contatos',
  ia: '/central-ia',
  conexoes: '/conexoes',
  agente: '/agente',
  voz: '/voz',
  extensao: '/extensao',
  'app-mobile': '/app-mobile',
  'prospeccao-manual': '/prospeccao-manual',
  planos: '/planos',
  conta: '/conta',
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: TAB_PATHS.dashboard },
  { key: 'kanban', label: 'Kanban', icon: SquareKanban, path: TAB_PATHS.kanban },
  { key: 'campanhas', label: 'Campanhas', icon: Megaphone, path: TAB_PATHS.campanhas },
  { key: 'agenda', label: 'Agenda', icon: CalendarDays, path: TAB_PATHS.agenda },
  { key: 'leads', label: 'Histórico de Leads', icon: Users, path: TAB_PATHS.leads },
  { key: 'importados', label: 'Importados', icon: Users, path: TAB_PATHS.importados },
  { key: 'contatos', label: 'Contatos', icon: ContactRound, path: TAB_PATHS.contatos },
  { key: 'ia', label: 'Central da IA', icon: Bot, path: TAB_PATHS.ia },
  { key: 'conexoes', label: 'Conexões', icon: Plug, path: TAB_PATHS.conexoes },
  { key: 'agente', label: 'Config. do Agente', icon: Settings, path: TAB_PATHS.agente },
  { key: 'voz', label: 'Voz', icon: BellRing, path: TAB_PATHS.voz },
  { key: 'extensao', label: 'Extensão e app', icon: Puzzle, path: TAB_PATHS.extensao },
  { key: 'prospeccao-manual', label: 'Prospecção Manual', icon: UserPlus, path: '/prospeccao-manual' },
  { key: 'planos', label: 'Planos', icon: Gem, path: TAB_PATHS.planos },
  { key: 'conta', label: 'Conta', icon: UserCircle, path: TAB_PATHS.conta },
]

export const DEFAULT_TAB: Tab = 'kanban'

/** Rota da Memória Comercial da IA (dentro da Central de IA). */
export const MEMORY_PATHS = {
  root: '/central-ia/memoria',
  lotes: '/central-ia/memoria/lotes',
  conversas: '/central-ia/memoria/conversas',
  aprendizados: '/central-ia/memoria/aprendizados',
} as const

/** Resolve a aba ativa a partir do pathname (subrotas herdam a aba do pai). */
export function resolveTabFromPath(pathname: string): Tab | null {
  if (pathname === '/') return DEFAULT_TAB
  for (const item of NAV_ITEMS) {
    if (pathname === item.path || pathname.startsWith(item.path + '/')) return item.key
  }
  return null
}

/** Resolve a sub-aba da Memória Comercial a partir do pathname. */
export type MemoryTab = 'lotes' | 'conversas' | 'aprendizados'

export function resolveMemoryTabFromPath(pathname: string): MemoryTab {
  if (pathname.endsWith('/conversas')) return 'conversas'
  if (pathname.endsWith('/aprendizados')) return 'aprendizados'
  return 'lotes'
}
