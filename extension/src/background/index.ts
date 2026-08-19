// Background service worker — faz as chamadas de rede ao backend (sem CORS,
// via host_permissions), semeia o auto-config do .zip personalizado e garante
// que o content script esteja ativo no Google Maps (inclusive após instalar/
// recarregar a extensão com o Maps já aberto, ou após navegação SPA).
import { seedAutoConfig } from '../shared/config'
import contentScriptUrl from '../content/index?script&iife'

// O .zip personalizado baixado do painel vem com `auto-config.json` contendo
// a extensionKey + ownerUserId. Semeia o chrome.storage para a extensão já
// nascer vinculada à conta do usuário — sem interface de token.
void seedAutoConfig()

const API_BASE = 'https://consecom-backend-production.up.railway.app'

const MAPS_HOST_RE = /(^|\.)maps\.google\.(com|[a-z]{2,3}(\.\w{1,2})?)$/
const GOOGLE_HOST_RE = /google\.([a-z]{2,3})(\.[a-z]{2})?$/

function isMapsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname.toLowerCase()
    if (MAPS_HOST_RE.test(h)) return true
    if (GOOGLE_HOST_RE.test(h)) return u.pathname.startsWith('/maps/')
    return false
  } catch {
    return false
  }
}

function isProspectableUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    if (isMapsUrl(url)) return true
    if (/(^|\.)wepsy\.com\.br$/.test(h)) return true
    if (/(^|\.)webmotors\.com\.br$/.test(h)) return true
    return false
  } catch {
    return false
  }
}

/**
 * Garante que o content script esteja rodando na aba. Se a aba é do Google
 * Maps (ou site de adaptador) e ainda não há um scanner, injeta dinamicamente
 * o content script compilado (mesmo arquivo declarado no manifest).
 */
async function ensureInjected(tabId: number, url: string | undefined): Promise<boolean> {
  if (!url || !isProspectableUrl(url)) return false
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'consecom:ping' })
    return true
  } catch {
    /* não injetado ainda — injeta abaixo */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [contentScriptUrl],
    })
    return true
  } catch (err) {
    console.warn('[vyntra] falha ao injetar content script:', err)
    return false
  }
}

/** Injeta o content script em todas as abas abertas do Google Maps. */
async function injectIntoOpenMapsTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (tab.id != null && isMapsUrl(tab.url ?? '')) {
      void ensureInjected(tab.id, tab.url)
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenMapsTabs()
})

chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenMapsTabs()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Navegação SPA do Maps não dispara onUpdated, mas mudanças de URL/hash
  // pontuais e loads subsequentes são cobertos aqui (guarda do ping evita
  // injeção duplicada).
  if (changeInfo.status === 'loading' && isMapsUrl(tab.url ?? '')) {
    void ensureInjected(tabId, tab.url)
  }
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'consecom:api') {
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}${msg.path}`, {
          method: msg.method ?? 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(typeof msg.extensionKey === 'string' ? { 'x-extension-key': msg.extensionKey } : {}),
            ...(msg.headers ?? {}),
          },
          body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
        })
        const text = await res.text()
        let data: unknown = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = text
        }
        sendResponse({ ok: res.ok, status: res.status, data })
      } catch (err) {
        sendResponse({
          ok: false,
          status: 0,
          data: { message: err instanceof Error ? err.message : String(err) },
        })
      }
    })()
    return true
  }

  // Usado pelo popup ("Abrir nesta página") para ativar o painel mesmo em
  // abas que estavam abertas antes da instalação/recarga da extensão.
  if (msg?.type === 'consecom:ensure') {
    void (async () => {
      const ok = await ensureInjected(msg.tabId as number, msg.url as string | undefined)
      sendResponse({ ok })
    })()
    return true
  }

  return false
})