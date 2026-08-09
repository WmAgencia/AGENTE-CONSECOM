import { useEffect, useState } from 'react'
import { Puzzle, Download } from 'lucide-react'

// =====================================================================
// Extensão Chrome — download do build atual.
//
// Estratégia de duas fontes (robustez):
//   1) Principal: arquivo estático versionado no próprio repo do frontend
//      (public/downloads/consecom-extension.zip), sempre disponível.
//   2) Metadados (versão) via backend /api/extension/download — opcional;
//      se o backend não responder, o botão continua funcionando usando a
//      fonte estática.
// =====================================================================

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

// Versão estática do build publicado (deve ser mantida em sync com vite.config /
// manifest da extensão).
export const EXTENSION_VERSION = '1.3.0'

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

  useEffect(() => {
    let alive = true
    fetch(`${API}/api/extension/download`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ExtensionDownload) => {
        if (alive) setBackendVersion(d.version)
      })
      .catch((e: unknown) => {
        // Backend indisponível: não é fatal. A fonte estática (zip versionado no
        // repo) garante que o botão de download sempre funcione.
        if (alive) setBackendError(e instanceof Error ? e.message : 'indisponível')
      })
    return () => {
      alive = false
    }
  }, [])

  const version = backendVersion ?? EXTENSION_VERSION
  const href = EXTENSION_ZIP_URL

  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
            <Puzzle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              Extensão Chrome <span className="text-slate-400 text-sm font-normal">· v{version}</span>
            </h2>
            <p className="text-sm text-slate-400">
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

        {backendError && (
          <p className="mt-3 text-xs text-slate-500">
            Metadados via backend {backendError}. Usando build estático versionado (v{EXTENSION_VERSION}).
          </p>
        )}

        <ol className="mt-6 space-y-2 text-sm text-slate-400">
          <li>1. Baixe e descompacte o arquivo.</li>
          <li>
            2. Abra <span className="text-slate-200">chrome://extensions</span> e ative o{' '}
            <span className="text-slate-200">modo de desenvolvedor</span>.
          </li>
          <li>3. Clique em "Carregar sem compactação" e selecione a pasta descompactada.</li>
          <li>4. Abra o Google Maps, faça uma busca, clique em <span className="text-slate-200">PROSPECTAR</span>, ajuste os filtros e importe.</li>
        </ol>
      </div>
    </div>
  )
}
