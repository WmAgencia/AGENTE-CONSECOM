import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Consecom — Captura de Leads',
  version: '1.5.0',
  description: 'Capture empresas do Google Maps e importe para o painel Consecom.',
  permissions: ['storage', 'activeTab', 'tabs'],
  host_permissions: [
    'https://*.google.com/maps/*',
    'https://maps.google.com/*',
    'https://*.supabase.co/*',
  ],
  action: {
    default_title: 'Consecom',
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
      matches: [
        'https://*.google.com/maps/*',
        'https://www.google.com/maps/*',
        'https://maps.google.com/*',
      ],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
})

