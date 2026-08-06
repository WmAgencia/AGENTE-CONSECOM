// Background service worker — mantém estado mínimo e escuta cliques no ícone.

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null) {
    void chrome.tabs.sendMessage(tab.id, { type: 'consecom:ping' })
  }
})

// Reage quando o usuário pede pra reabrir o painel em uma aba do Maps.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'consecom:open') {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id != null && /\/maps/i.test(tab.url ?? '')) {
        await chrome.tabs.sendMessage(tab.id, { type: 'consecom:open' }).catch(() => {})
      }
    })()
  }
  return true
})