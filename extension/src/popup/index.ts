import { getStoredConfig, saveConfig } from '../shared/config'

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

async function load(): Promise<void> {
  const cfg = await getStoredConfig()
  ;($('url') as HTMLInputElement).value = cfg.supabaseUrl || ''
  ;($('key') as HTMLInputElement).value = cfg.anonKey || ''
}

$('save').addEventListener('click', async () => {
  const url = ($('url') as HTMLInputElement).value.trim()
  const key = ($('key') as HTMLInputElement).value.trim()
  if (!url || !key) {
    $('status').textContent = 'Informe a URL e a chave anon.'
    return
  }
  await saveConfig({ supabaseUrl: url, anonKey: key })
  $('status').textContent = 'Salvo ✓'
})

$('open').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'consecom:open' })
})

void load()