import { getStoredConfig, seedAutoConfig } from '../shared/config'

async function refreshStatus(): Promise<void> {
  const cfg = await getStoredConfig()
  const status = document.getElementById('status')
  if (!status) return
  if (cfg.extensionKey && cfg.ownerUserId) {
    status.textContent = 'Conectado à sua conta Vyntra ✓'
  } else {
    status.textContent = 'Baixe a extensão no painel Vyntra para vincular sua conta.'
  }
}

document.getElementById('open')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  await chrome.tabs.sendMessage(tab.id, { type: 'consecom:open' }).catch(() => {
    /* content script não carregou nesta aba */
  })
})

void seedAutoConfig().then(() => refreshStatus())
