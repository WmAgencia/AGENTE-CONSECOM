// Background service worker — faz as chamadas de rede ao backend (sem CORS,
// via host_permissions) e semeia o auto-config do .zip personalizado.
import { seedAutoConfig } from '../shared/config'

// O .zip personalizado baixado do painel vem com `auto-config.json` contendo
// a extensionKey + ownerUserId. Semeia o chrome.storage para a extensão já
// nascer vinculada à conta do usuário — sem interface de token.
void seedAutoConfig()

const API_BASE = 'https://consecom-backend-production.up.railway.app'

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
  return false
})

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null) {
    void chrome.tabs.sendMessage(tab.id, { type: 'consecom:ping' })
  }
})
