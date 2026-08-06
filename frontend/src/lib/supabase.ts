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
  | 'mensagem_enviada'
  | 'respondendo'
  | 'reuniao_marcada'
  | 'fechado'
  | 'perdido'

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
  created_at: string
  updated_at: string
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  is_active: boolean
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