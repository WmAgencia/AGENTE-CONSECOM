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
  remarket_at: string | null
  first_msg_sent_at: string | null
  created_at: string
  updated_at: string
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  is_active: boolean
  status: 'pronta' | 'em_progresso' | 'finalizada' | 'cancelada'
  started_at: string | null
  finished_at: string | null
  lead_count: number
  success_count: number
  fail_count: number
  created_at: string
}

export interface CaptureSession {
  id: string
  imported_by: string | null
  created_at: string
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
  created_at: string
  campaign?: Pick<Campaign, 'id' | 'name'>
  lead?: Pick<Lead, 'id' | 'name' | 'phone' | 'status'>
}