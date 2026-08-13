import { useEffect, useState } from 'react'
import { Puzzle, Download } from 'lucide-react'
import { supabase } from '../lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

export const EXTENSION_VERSION = '1.4.3'
export const EXTENSION_ZIP_URL = '/downloads/consecom-extension.zip'

interface ExtensionDownload {
  url: string
  bucket: string
  path: string
  version: string
}

export function ExtensionView() {
  const [backendVersion, setBackendVersion] = useState<string | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [tokenStatus, setTokenStatus] = useState('')

  useEffect(() => {
    let alive = true
    fetch(`${API}/api/extension/download`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ExtensionDownload) => {
        if (alive) setBackendVersion(d.version)
      })
      .catch((e: unknown) => {
        if (alive) setBackendError(e instanceof Error ? e.message : 'indisponível')
      })
    return () => {
      alive = false
    }
  }, [])

  const version = backendVersion ?? EXTENSION_VERSION
  const href = EXTENSION_ZIP_URL

  async function copySessionToken() {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) {
      setTokenStatus('Sessão expirada. Entre novamente no Vyntra.')
      return
    }
    await navigator.clipboard.writeText(token)
    setTokenStatus('Token copiado. Cole-o na configuração da extensão.')
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
              Capture empresas do Google Maps e importe como leads — agora com Prospecção Automática.
            </p>
          </div>
        </div>

        <a
          href={href}
          download="consecom-extension.zip"
          className="mt-4 flex items-center gap-2 justify-center px-4 py-3 rounded-xl text-white text-sm font-medium transition bg-emerald-600 hover:bg-emerald-500 focus:ring-2 focus:ring-emerald-400 focus:outline-none"
        >
          <Download className="w-4 h-4" />
          Baixar extensão (.zip)
        </a>

         <button
           onClick={() => void copySessionToken()}
           className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium border border-line-2 text-secondary hover:bg-subtle transition"
         >
           Copiar token da sessão (alternativo)
         </button>
        {tokenStatus && <p className="mt-2 text-xs text-emerald-300">{tokenStatus}</p>}

        {backendError && (
          <p className="mt-3 text-xs text-faint">
            Metadados via backend {backendError}. Usando build estático versionado (v{EXTENSION_VERSION}).
          </p>
        )}

        <ol className="mt-6 space-y-2 text-sm text-muted">
          <li>1. Baixe e descompacte o arquivo.</li>
          <li>2. Abra <span className="text-fg">chrome://extensions</span> e ative o <span className="text-fg">modo de desenvolvedor</span>.</li>
          <li>3. Clique em "Carregar sem compactação" e selecione a pasta descompactada.</li>
           <li>4. Abra o Vyntra em uma aba, abra o popup da extensão e clique em <span className="text-fg">Sincronizar sessão do Vyntra</span>.</li>
           <li>5. Abra o Google Maps, faça uma busca, clique em <span className="text-fg">PROSPECTAR</span>, ajuste os filtros e importe.</li>
        </ol>
      </div>
    </div>
  )
}
