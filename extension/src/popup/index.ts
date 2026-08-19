import { getStoredConfig, seedAutoConfig } from '../shared/config'

async function refreshStatus(): Promise<void> {
  const cfg = await getStoredConfig()
  const status = document.getElementById('status')
  if (!status) return
  if (cfg.extensionKey && cfg.ownerUserId) {
    status.textContent = 'Conectado ✓'
  } else {
    status.textContent = 'Baixe a extensão no painel Vyntra.'
  }
}

document.querySelectorAll<HTMLButtonElement>('.site').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault()
    const url = btn.dataset.url
    if (!url) return
    await chrome.tabs.create({ url })
    window.close()
  })
})

document.getElementById('openHere')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  const status = document.getElementById('status')
  try {
    // Garante que o content script esteja ativo nesta aba (funciona inclusive
    // se a aba estava aberta antes da instalação/recarga da extensão).
    const res = await chrome.runtime.sendMessage({
      type: 'consecom:ensure',
      tabId: tab.id,
      url: tab.url,
    })
    if (res?.ok) {
      await chrome.tabs.sendMessage(tab.id, { type: 'consecom:open' }).catch(() => {})
      window.close()
      return
    }
  } catch {
    /* cai no fallback abaixo */
  }
  if (status) {
    status.textContent = 'Abra o Google Maps para ativar aqui.'
  }
})

void seedAutoConfig().then(() => refreshStatus())