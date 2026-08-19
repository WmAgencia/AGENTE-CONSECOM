import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest'

export default defineConfig({
  plugins: [
    crx({
      manifest,
      contentScripts: {
        // Conteúdo do content script como bundle IIFE autocontido (sem
        // import/export de topo). Necessário porque o mesmo arquivo é injetado
        // como script clássico tanto pelo manifest (content_scripts) quanto
        // pelo chrome.scripting.executeScript — e executeScript NÃO executa
        // módulos ES, então "import" de topo quebraria ("Cannot use import
        // statement outside a module").
        standaloneFiles: ['src/content/index.ts'],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})