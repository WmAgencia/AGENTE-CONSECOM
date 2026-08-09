import { useEffect, useState } from 'react'
import { Puzzle, Download } from 'lucide-react'

// =====================================================================
// Extensão Chrome — download do build atual publicado no Supabase Storage.
// A URL é obtida do backend (/api/extension/download) que retorna a URL
// pública do .zip já empacotado e publicado por `extension/scripts/publish.mjs`.
// =====================================================================

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

interface ExtensionDownload {
  url: string
  bucket: string
  path: string
  version: string
}

export function ExtensionView() {
  const [data, setData] = useState<ExtensionDownload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${API}/api/extension/download`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ExtensionDownload) => {
        if (alive) setData(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'erro')
      })
    return () => {
      alive = false
    }
  }, [])

  const href = data?.url ?? '#'
  const version = data?.version ? `v${data.version}` : ''

  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
            <Puzzle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              Extensão Chrome {version && <span className="text-slate-400 text-sm font-normal">· {version}</span>}
            </h2>
            <p className="text-sm text-slate-400">
              Capture empresas do Google Maps e importe como leads — agora com Prospecção Automática.
            </p>
          </div>
        </div>

        <a
          href={href}
          download
          aria-disabled={!data}
          className={`mt-4 flex items-center gap-2 justify-center px-4 py-3 rounded-xl text-white text-sm font-medium transition ${
            data
              ? 'bg-emerald-600 hover:bg-emerald-500'
              : 'bg-slate-600 opacity-70 cursor-not-allowed'
          }`}
        >
          <Download className="w-4 h-4" />
          {data ? 'Baixar extensão (.zip)' : 'Carregando link…'}
        </a>

        {error && (
          <p className="mt-3 text-xs text-rose-400">
            Não foi possível obter o link de download: {error}
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
