import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Vyntra Prospector - Floating Panel',
  version: '1.24.0',
  description: 'Capture empresas do Google Maps ou contatos de qualquer página, veja o Score Vyntra e importe como leads.',
  permissions: ['storage', 'activeTab', 'tabs', 'scripting'],
  // Hosts usados pelo Google Maps (o executeScript dinâmico do background
  // precisa de host_permissions cobrindo o host exato da aba — conteúdo do
  // content_scripts NÃO vale para chrome.scripting.executeScript).
  // `*.google.com` NÃO cobre o domínio "nu" nem outros ccTLDs como .com.br.
  host_permissions: [
    'https://*.google.com/maps/*',
    'https://google.com/maps/*',
    'https://maps.google.com/*',
    'https://*.google.com.br/maps/*',
    'https://google.com.br/maps/*',
    'https://maps.google.com.br/*',
    'https://consecom-backend-production.up.railway.app/*',
  ],
  action: {
    default_title: 'Vyntra Prospector',
    default_popup: 'src/popup/index.html',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
})
