import { getStoredConfig, DEFAULT_CONFIG, saveConfig } from '../shared/config'

async function prefill(): Promise<void> {
  const cfg = await getStoredConfig()
  const urlInput = document.getElementById('url') as HTMLInputElement
  const keyInput = document.getElementById('key') as HTMLInputElement
  const tokenInput = document.getElementById('token') as HTMLInputElement
  if (!urlInput.value || !keyInput.value) {
    urlInput.value = cfg.supabaseUrl || DEFAULT_CONFIG.supabaseUrl
    keyInput.value = cfg.anonKey || DEFAULT_CONFIG.anonKey
    tokenInput.value = cfg.accessToken || ''
  }
}

document.getElementById('save')?.addEventListener('click', async () => {
  const url = (document.getElementById('url') as HTMLInputElement).value.replace(/\/+$/, '')
  const key = (document.getElementById('key') as HTMLInputElement).value.trim()
  const accessToken = (document.getElementById('token') as HTMLInputElement).value.trim()
  if (!url || !key) {
    const s = document.getElementById('status')
    if (s) s.textContent = 'Informe a URL e a chave anon.'
    return
  }
  await saveConfig({ supabaseUrl: url, anonKey: key, accessToken: accessToken || undefined })
  const s = document.getElementById('status')
  if (s) s.textContent = 'Salvo ✓'
})

document.getElementById('sync-session')?.addEventListener('click', async () => {
  const status = document.getElementById('status')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  const result = await chrome.tabs.sendMessage(tab.id, { type: 'consecom:request-session' }).catch(() => null) as { accessToken?: string; refreshToken?: string; error?: string } | null
  if (!result?.accessToken || !result.refreshToken) {
    if (status) status.textContent = 'Abra o Vyntra em uma aba e tente novamente.'
    return
  }
  const cfg = await getStoredConfig()
  await saveConfig({ ...cfg, accessToken: result.accessToken, refreshToken: result.refreshToken })
  if (status) status.textContent = 'Sessão sincronizada ✓'
})

document.getElementById('open')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  await chrome.tabs.sendMessage(tab.id, { type: 'consecom:open' }).catch(() => {
    /* content script não carregou nesta aba */
  })
})

void prefill()
