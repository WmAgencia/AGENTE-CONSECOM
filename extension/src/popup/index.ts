import { getStoredConfig, DEFAULT_CONFIG, saveConfig } from '../shared/config'

async function prefill(): Promise<void> {
  const cfg = await getStoredConfig()
  const urlInput = document.getElementById('url') as HTMLInputElement
  const keyInput = document.getElementById('key') as HTMLInputElement
  if (!urlInput.value || !keyInput.value) {
    urlInput.value = cfg.supabaseUrl || DEFAULT_CONFIG.supabaseUrl
    keyInput.value = cfg.anonKey || DEFAULT_CONFIG.anonKey
  }
}

document.getElementById('save')?.addEventListener('click', async () => {
  const url = (document.getElementById('url') as HTMLInputElement).value.replace(/\/+$/, '')
  const key = (document.getElementById('key') as HTMLInputElement).value.trim()
  if (!url || !key) {
    const s = document.getElementById('status')
    if (s) s.textContent = 'Informe a URL e a chave anon.'
    return
  }
  await saveConfig({ supabaseUrl: url, anonKey: key })
  const s = document.getElementById('status')
  if (s) s.textContent = 'Salvo ✓'
})

document.getElementById('open')?.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'consecom:open' })
})

void prefill()