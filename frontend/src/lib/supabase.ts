import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env',
  )
}

export const supabase = createClient(url, anonKey)

export type LeadStatus =
  | 'novo'
  | 'na_fila'
  | 'enviado'
  | 'conversando'
  | 'sem_interesse'
  | 'remarketing'
  | 'reuniao_marcada'
  | 'reuniao_cancelada'
  | 'fechado'
  | 'nao_fechado'
   | 'para_ligacao'
  | 'responder_depois'

export interface Lead {
  id: string
  name: string | null
  phone: string | null
  category: string | null
  website: string | null
  address: string | null
  city: string | null
  state: string | null
  rating: number | null
  reviews: number | null
  niche: string | null
  status: LeadStatus
  last_message_sent: string | null
  meeting_at: string | null
  meeting_notes: string | null
  session_id: string | null
  campaign_id: string | null
  no_interest_until: string | null
  closed_reason: string | null
  closed_at: string | null
  sale_value?: number | null
  meeting_outcome?: string | null
  sale_status?: string | null
  remarket_at: string | null
  first_msg_sent_at: string | null
  call_reason?: string | null
  call_moved_at?: string | null
  score?: number | null
  score_factors?: unknown
  strategy_id?: string | null
  source?: string | null
  source_detail?: string | null
  is_active_in_prospecting?: boolean
  owner_user_id?: string | null
  import_state?: 'imported' | 'distributed' | 'blocked'
  phone_normalized?: string | null
  imported_at?: string | null
  distributed_at?: string | null
  created_at: string
  updated_at: string
  ai_control?: 'ai' | 'human'
}

export interface ConversationMessage {
  id: string
  lead_id: string
  role: 'user' | 'assistant'
  content: string
  agent_model: string | null
  sender_display_name?: string | null
  created_at: string
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  is_active: boolean
  status: 'pronta' | 'em_progresso' | 'pausada' | 'finalizada' | 'cancelada' | 'agendada' | 'waiting_connection'
  scheduled_at: string | null
  started_at: string | null
  finished_at: string | null
  lead_count: number
  success_count: number
  fail_count: number
  whatsapp_instance: string | null
  connection_ids?: string[] | null
  owner_user_id?: string | null
  position?: number | null
  created_at: string
}

export interface CaptureSession {
  id: string
  imported_by: string | null
  created_at: string
}

export type WhatsAppConnStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface WhatsAppConnection {
  id: string
  user_id: string | null
  workspace_id: string | null
  instance_name: string
  phone_number: string | null
  whatsapp_name: string | null
  display_name: string | null
  status: WhatsAppConnStatus
  qr_code: string | null
  last_sync_at: string | null
  created_at: string
  updated_at: string
  rotation_of?: string | null
  superseded_by?: string | null
}

export interface QueueMessage {
  id: string
  campaign_id: string
  position: number
  kind: 'text' | 'audio' | 'video' | 'image' | 'document'
  text: string | null
  media_url: string | null
  media_caption: string | null
  delay_seconds: number
}

export interface LeadContact {
  id: string
  user_id: string
  lead_id: string
  contacted_at: string
}

export type SendRunStatus = 'pending' | 'running' | 'done' | 'failed'

export interface SendRun {
  id: string
  campaign_id: string
  lead_id: string
  status: SendRunStatus
  current_position: number
  next_send_at: string | null
  last_sent_at: string | null
  fail_reason?: string | null
  created_at: string
  position?: number | null
  campaign?: Pick<Campaign, 'id' | 'name'>
  lead?: Pick<Lead, 'id' | 'name' | 'phone' | 'status'>
  connection_id?: string | null
  connection_instance?: string | null
}

export interface FollowUp {
  id: string
  lead_id: string
  scheduled_date: string
  scheduled_time: string | null
  message: string
  status: 'agendado' | 'processando' | 'enviado' | 'falhou' | 'cancelado'
  source: 'ia' | 'operador'
  connection_id: string | null
  connection_instance: string | null
  conversation_id: string | null
  origin_context: string | null
  failure_reason: string | null
  created_at: string
  sent_at: string | null
  lead?: Pick<Lead, 'id' | 'name' | 'phone' | 'status'>
}
