import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Vyntra Prospector - Floating Panel',
  version: '1.4.2',
  description: 'Capture empresas do Google Maps, veja o Score Vyntra e importe como leads.',
  permissions: ['storage', 'activeTab', 'tabs'],
  host_permissions: [
    'https://*.google.com/maps/*',
    'https://maps.google.com/*',
    'https://*.supabase.co/*',
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

