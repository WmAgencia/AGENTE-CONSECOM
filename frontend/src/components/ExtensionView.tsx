import { Puzzle, Download } from 'lucide-react'

// =====================================================================
// Extensão Chrome — download do build atual (extension/dist zipado).
// =====================================================================

const EXTENSION_URL = '/downloads/consecom-extension.zip'

export function ExtensionView() {
  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
            <Puzzle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Extensão Chrome</h2>
            <p className="text-sm text-slate-400">
              Capture empresas do Google Maps e importe como leads.
            </p>
          </div>
        </div>

        <a
          href={EXTENSION_URL}
          download
          className="mt-4 flex items-center gap-2 justify-center px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition"
        >
          <Download className="w-4 h-4" />
          Baixar extensão (.zip)
        </a>

        <ol className="mt-6 space-y-2 text-sm text-slate-400">
          <li>1. Baixe e descompacte o arquivo.</li>
          <li>
            2. Abra <span className="text-slate-200">chrome://extensions</span> e ative o{" "}
            <span className="text-slate-200">modo de desenvolvedor</span>.
          </li>
          <li>3. Clique em "Carregar sem compactação" e selecione a pasta descompactada.</li>
          <li>4. Abra o Google Maps, faça uma busca e use o painel flutuante para importar.</li>
        </ol>
      </div>
    </div>
  )
}
