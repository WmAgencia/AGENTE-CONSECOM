import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface StoredConfig {
  supabaseUrl: string
  anonKey: string
  /** Access token da sessão autenticada no painel Vyntra. */
  accessToken?: string
  refreshToken?: string
}

const CONFIG_KEY = 'consecom-config-v2'

export const DEFAULT_CONFIG: StoredConfig = {
  supabaseUrl: 'https://nzexythhastovjwuedsh.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZXh5dGhoYXN0b3Zqd3VlZHNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNDc0MzksImV4cCI6MjEwMTYyMzQzOX0.-yXujArRcUSuPN0jQRNEnx9hZAz-oyi-GgpnNm5ciZo',
}

export async function getStoredConfig(): Promise<StoredConfig> {
  let stored: Record<string, Partial<StoredConfig> | undefined> = {}
  try {
    stored = (await chrome.storage.sync.get(CONFIG_KEY)) as Record<string, Partial<StoredConfig> | undefined>
  } catch {
    // Extension context invalidated (extension recarregada). Usa defaults.
  }
  const cfg = stored[CONFIG_KEY] ?? {}
  const result: StoredConfig = {
    supabaseUrl: cfg.supabaseUrl || DEFAULT_CONFIG.supabaseUrl,
    anonKey: cfg.anonKey || DEFAULT_CONFIG.anonKey,
    accessToken: cfg.accessToken || undefined,
    refreshToken: cfg.refreshToken || undefined,
  }
  return result
}

export async function saveConfig(cfg: StoredConfig): Promise<void> {
  try {
    await chrome.storage.sync.set({ [CONFIG_KEY]: cfg })
  } catch {
    // Extension context invalidated — a próxima sessão salva normalmente.
  }
}

let cachedClient: SupabaseClient | null = null
let cachedUrl = ''
let cachedKey = ''

export function getClient(cfg: StoredConfig): SupabaseClient | null {
  if (!cfg.supabaseUrl || !cfg.anonKey) return null
  if (cachedClient && cachedUrl === cfg.supabaseUrl && cachedKey === cfg.anonKey) {
    return cachedClient
  }
  cachedClient = createClient(cfg.supabaseUrl, cfg.anonKey, cfg.accessToken
    ? { global: { headers: { Authorization: `Bearer ${cfg.accessToken}` } } }
    : undefined)
  cachedUrl = cfg.supabaseUrl
  cachedKey = cfg.anonKey
  return cachedClient
}

/** Formata URL pÃºblica de um arquivo no bucket de mÃ­dia. */
export function mediaPublicUrl(cfg: StoredConfig, path: string): string {
  const base = cfg.supabaseUrl.replace(/\/$/, '')
  return `${base}/storage/v1/object/public/${path.replace(/^\/+/, '')}`
}
