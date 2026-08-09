import { supabase } from '../lib/supabase'
import type {
  Lead,
  Campaign,
  WhatsAppConnection,
  ConversationMessage,
} from '../lib/types'

// =====================================================================
// Consultas de dados do app — mesmo Supabase/REST do painel, autenticado
// pela sessão do usuário (RLS protege os dados, igual ao web).
// =====================================================================

export async function fetchLeads(): Promise<Lead[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Lead[]
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabase.from('campaigns').select('*').order('created_at')
  if (error) throw error
  return (data ?? []) as Campaign[]
}

export async function fetchConnections(): Promise<WhatsAppConnection[]> {
  const { data, error } = await supabase
    .from('whatsapp_connections')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as WhatsAppConnection[]
}

export async function fetchRecentMessages(limit = 20): Promise<ConversationMessage[]> {
  const { data, error } = await supabase
    .from('consecom_conversations')
    .select('*')
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as ConversationMessage[]
}

export interface DashboardSnapshot {
  leads: Lead[]
  campaigns: Campaign[]
  connections: WhatsAppConnection[]
  replies: ConversationMessage[]
}

export async function fetchDashboard(): Promise<DashboardSnapshot> {
  const [leads, campaigns, connections, replies] = await Promise.all([
    fetchLeads(),
    fetchCampaigns(),
    fetchConnections(),
    fetchRecentMessages(),
  ])
  return { leads, campaigns, connections, replies }
}
