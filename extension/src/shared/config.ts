export interface StoredConfig {
  /** Chave de API embutida no .zip personalizado (header x-extension-key). */
  extensionKey?: string
  /** UUID do usuário dono (gravado no auto-config.json pelo backend). */
  ownerUserId?: string
}

const CONFIG_KEY = 'consecom-config-v3'

export const DEFAULT_CONFIG: StoredConfig = {}

export async function getStoredConfig(): Promise<StoredConfig> {
  let stored: Record<string, Partial<StoredConfig> | undefined> = {}
  try {
    stored = (await chrome.storage.sync.get(CONFIG_KEY)) as Record<string, Partial<StoredConfig> | undefined>
  } catch {
    // Extension context invalidated (extension recarregada). Usa defaults.
  }
  const cfg = stored[CONFIG_KEY] ?? {}
  return {
    extensionKey: cfg.extensionKey || undefined,
    ownerUserId: cfg.ownerUserId || undefined,
  }
}

export async function saveConfig(cfg: StoredConfig): Promise<void> {
  try {
    await chrome.storage.sync.set({ [CONFIG_KEY]: cfg })
  } catch {
    // Extension context invalidated — a próxima sessão salva normalmente.
  }
}

/** Nome do arquivo embutido no .zip personalizado gerado pelo backend. */
const AUTO_CONFIG_FILE = 'auto-config.json'

/**
 * Lê `auto-config.json` (presente no .zip PERSONALIZADO baixado do painel) e
 * guarda a extensionKey + ownerUserId. Sem isso, a extensão não consegue
 * importar (o backend devolve 403). Retorna true quando o arquivo existiu.
 */
export async function seedAutoConfig(force = false): Promise<boolean> {
  try {
    const res = await fetch(chrome.runtime.getURL(AUTO_CONFIG_FILE))
    if (!res.ok) return false
    const auto = (await res.json()) as Partial<StoredConfig>
    const extensionKey = typeof auto.extensionKey === 'string' ? auto.extensionKey : undefined
    const ownerUserId = typeof auto.ownerUserId === 'string' ? auto.ownerUserId : undefined
    if (extensionKey || ownerUserId) {
      const cfg = await getStoredConfig()
      await saveConfig({
        extensionKey: extensionKey || cfg.extensionKey,
        ownerUserId: ownerUserId || cfg.ownerUserId,
      })
      return true
    }
    return false
  } catch {
    return false
  }
}
