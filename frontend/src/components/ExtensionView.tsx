import { useEffect, useState } from 'react'
import { Puzzle, Download } from 'lucide-react'
import { downloadPersonalizedExtension } from '../lib/extensionDownload'
import { Button } from './ui'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

export const EXTENSION_VERSION = '1.25.0'

export function ExtensionView() {
  const [backendVersion, setBackendVersion] = useState<string | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    let alive = true
    fetch(`${API}/api/extension/version`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { version?: string }) => {
        if (alive) setBackendVersion(d.version ?? null)
      })
      .catch((e: unknown) => {
        if (alive) setBackendError(e instanceof Error ? e.message : 'indisponível')
      })
    return () => {
      alive = false
    }
  }, [])

  const version = backendVersion ?? EXTENSION_VERSION

  async function handleDownload() {
    setStatus('Gerando extensão para a sua conta...')
    const result = await downloadPersonalizedExtension()
    setStatus(result.message)
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-2xl border border-line bg-subtle p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
            <Puzzle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              Extensão Chrome <span className="text-muted text-sm font-normal">· v{version}</span>
            </h2>
            <p className="text-sm text-muted">
              Capture empresas do Google Maps e importe como leads — já conectada à sua conta Vyntra.
            </p>
          </div>
        </div>

        <Button
          onClick={() => void handleDownload()}
          variant="primary"
          className="mt-4 flex items-center gap-2 justify-center"
        >
          <Download className="w-4 h-4" />
          Baixar extensão para a minha conta (.zip)
        </Button>

        {status && <p className="mt-2 text-xs text-emerald-300">{status}</p>}

        {backendError && (
          <p className="mt-3 text-xs text-faint">
            Metadados via backend {backendError}. Usando build local (v{EXTENSION_VERSION}).
          </p>
        )}

        <ol className="mt-6 space-y-2 text-sm text-muted">
          <li>1. Baixe e descompacte o arquivo.</li>
          <li>2. Abra <span className="text-fg">chrome://extensions</span> e ative o <span className="text-fg">modo de desenvolvedor</span>.</li>
          <li>3. Clique em "Carregar sem compactação" e selecione a pasta descompactada — a extensão já virá conectada à sua conta.</li>
          <li>4. Abra o Google Maps, faça uma busca, clique em <span className="text-fg">PROSPECTAR</span>, ajuste os filtros e importe.</li>
        </ol>
      </div>
    </div>
  )
}