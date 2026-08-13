import { getStoredConfig, saveConfig, seedAutoConfig } from '../shared/config'

async function refreshStatus(): Promise<void> {
  const cfg = await getStoredConfig()
  const status = document.getElementById('status')
  if (!status) return
  if (cfg.refreshToken) {
    status.textContent = 'Conectado à sua conta Vyntra ✓'
  } else {
    status.textContent = 'Em espera — clique em Reconectar para vincular sua conta.'
  }
}

document.getElementById('open')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  await chrome.tabs.sendMessage(tab.id, { type: 'consecom:open' }).catch(() => {
    /* content script não carregou nesta aba */
  })
})

document.getElementById('reseed')?.addEventListener('click', async () => {
  const status = document.getElementById('status')
  if (status) status.textContent = 'Procurando sessão do Vyntra...'
  const tabs = await chrome.tabs.query({})
  const vyntraTab = tabs.find((tab) => {
    const url = tab.url ?? ''
    return url.includes('frontend-seven-sooty-78.vercel.app') || url.includes('frontend-consecom.vercel.app')
  })
  if (!vyntraTab?.id) {
    if (status) status.textContent = 'Abra o Vyntra em uma aba do navegador.'
    return
  }
  const result = await chrome.tabs.sendMessage(vyntraTab.id, { type: 'consecom:request-session' }).catch(() => null) as { refreshToken?: string; error?: string } | null
  if (!result?.refreshToken) {
    if (status) status.textContent = 'Faça login no Vyntra e tente novamente.'
    return
  }
  const cfg = await getStoredConfig()
  await saveConfig({ ...cfg, refreshToken: result.refreshToken })
  if (status) status.textContent = 'Reconectado ✓'
})

void seedAutoConfig().then(() => refreshStatus())