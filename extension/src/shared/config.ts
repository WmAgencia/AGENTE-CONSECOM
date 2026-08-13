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

/** Nome do arquivo embutido no .zip personalizado gerado pelo backend. */
const AUTO_CONFIG_FILE = '_auto-config.json'

/**
 * Lê `_auto-config.json` (presente no .zip PERSONALIZADO baixado do painel) e
 * faz merge na config salva. O arquivo contém o refresh token da sessão do
 * usuário logado no Vyntra — não há mais interface de access token.
 * Retorna true quando o arquivo existiu e foi aplicado.
 */
export async function seedAutoConfig(force = false): Promise<boolean> {
  try {
    const res = await fetch(chrome.runtime.getURL(AUTO_CONFIG_FILE))
    if (!res.ok) return false
    const auto = (await res.json()) as Partial<StoredConfig>
    const refreshToken = typeof auto.refreshToken === 'string' ? auto.refreshToken : undefined
    if (auto.supabaseUrl || auto.anonKey || refreshToken) {
      const cfg = await getStoredConfig()
      await saveConfig({
        supabaseUrl: auto.supabaseUrl || cfg.supabaseUrl,
        anonKey: auto.anonKey || cfg.anonKey,
        accessToken: force ? undefined : cfg.accessToken,
        refreshToken: refreshToken || cfg.refreshToken,
      })
      return true
    }
    return false
  } catch {
    return false
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
