import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface StoredConfig {
  supabaseUrl: string
  anonKey: string
}

const CONFIG_KEY = 'consecom-config'

export async function getStoredConfig(): Promise<StoredConfig> {
  const stored = (await chrome.storage.sync.get(CONFIG_KEY)) as Record<string, Partial<StoredConfig> | undefined>
  const cfg = stored[CONFIG_KEY] ?? {}
  return {
    supabaseUrl: cfg.supabaseUrl ?? '',
    anonKey: cfg.anonKey ?? '',
  }
}

export async function saveConfig(cfg: StoredConfig): Promise<void> {
  await chrome.storage.sync.set({ [CONFIG_KEY]: cfg })
}

export function getClient(cfg: StoredConfig): SupabaseClient | null {
  if (!cfg.supabaseUrl || !cfg.anonKey) return null
  return createClient(cfg.supabaseUrl, cfg.anonKey)
}

/** Formata URL pública de um arquivo no bucket de mídia. */
export function mediaPublicUrl(cfg: StoredConfig, path: string): string {
  const base = cfg.supabaseUrl.replace(/\/$/, '')
  return `${base}/storage/v1/object/public/${path.replace(/^\/+/, '')}`
}