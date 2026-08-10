import { useEffect, useMemo, useRef, useState } from 'react'
import {
  UploadCloud, FileSpreadsheet, Table, CheckCircle2, XCircle, AlertTriangle, RefreshCcw, ListChecks, Users, Loader2,
} from 'lucide-react'
import { api, type ContactImportResponse, type ContactList } from '../lib/api'
import { parseSpreadsheet, validateContacts, type ParsedContact, type ValidationReport } from '../lib/contacts'

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function ContactsView() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ValidationReport | null>(null)
  const [guessedCols, setGuessedCols] = useState<{ nameCol: string; phoneCol: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState<ContactImportResponse | null>(null)
  const [error, setError] = useState('')
  const [lists, setLists] = useState<ContactList[]>([])
  const [loadingLists, setLoadingLists] = useState(false)

  async function loadLists() {
    setLoadingLists(true)
    try {
      const data = await api.get<ContactList[]>('/api/contacts/lists')
      setLists(data)
    } catch {
      setLists([])
    } finally {
      setLoadingLists(false)
    }
  }

  function handleFile(file: File) {
    setFileName(file.name)
    setDone(null)
    setError('')
    void (async () => {
      try {
        const res = await parseSpreadsheet(file)
        setGuessedCols(res.guessed)
        setParsed(validateContacts(res.rows, res.guessed))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Falha ao ler o arquivo')
        setParsed(null)
      }
    })()
  }

  const stats = useMemo(() => {
    if (!parsed) return null
    return {
      valid: parsed.valid.length,
      invalid: parsed.invalid.length,
      dupes: parsed.duplicates.length,
    }
  }, [parsed])

  async function sendContact(contact: ParsedContact) {
    const res = await api.post<ContactImportResponse>('/api/contacts/import', {
      items: [{ name: contact.name, phone: contact.phone }],
      source: 'frontend-import',
      listName: `Importação ${new Date().toISOString().slice(0, 10)}`,
    })
    return res.summary.created
  }

  async function importAll() {
    if (!parsed || !parsed.valid.length) return
    setImporting(true)
    setError('')
    setDone(null)
    try {
      let created = 0
      let errors = 0
      for (const c of parsed.valid) {
        try {
          created += await sendContact(c)
        } catch {
          errors++
        }
      }
      setDone({
        ok: true,
        summary: {
          total: parsed.valid.length,
          valid: parsed.valid.length,
          created,
          duplicates: 0,
          invalid: 0,
          errors,
        },
        listId: null,
        listName: `Importação ${new Date().toISOString().slice(0, 10)}`,
      })
      await loadLists()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao importar contatos')
    } finally {
      setImporting(false)
    }
  }

  useEffect(() => {
    void loadLists()
  }, [])

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold mb-1">Contatos</h1>
          <p className="text-sm text-slate-400">Importe uma planilha (.csv ou .xlsx) com nomes e telefones para povoar a prospecção.</p>
        </div>
        <button onClick={() => void loadLists()} className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1.5">
          <RefreshCcw className="w-3.5 h-3.5" /> Atualizar listas
        </button>
      </div>

      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-3">
          <FileSpreadsheet className="w-4 h-4 text-indigo-300" />
          <span className="text-sm font-semibold">Importar planilha</span>
        </div>

        <label
          className="block border-2 border-dashed border-white/10 hover:border-indigo-500/50 rounded-xl px-6 py-8 text-center cursor-pointer transition"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const f = e.dataTransfer.files?.[0]
            if (f) handleFile(f)
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
          <UploadCloud className="w-8 h-8 mx-auto text-slate-500 mb-2" />
          <div className="text-sm text-slate-300">
            {fileName || 'Arraste um arquivo ou clique para escolher'}
          </div>
          <div className="text-xs text-slate-500 mt-1">Colunas esperadas: <b>nome</b> e <b>telefone</b> (qualquer ordem).</div>
        </label>

        {!fileName && (
          <div className="mt-3 text-xs text-slate-500 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            A detecção de colunas é automática: <code>nome</code>, <code>name</code>, <code>cliente</code> e <code>telefone</code>, <code>phone</code>, <code>whatsapp</code>, <code>celular</code>.
          </div>
        )}

        {error && <div className="mt-3 text-xs text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">{error}</div>}
      </div>

      {parsed && stats && (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex items-center gap-2 mb-4">
            <Table className="w-4 h-4 text-indigo-300" />
            <span className="text-sm font-semibold">Validação</span>
            <span className="text-xs text-slate-500 ml-auto font-mono">{fileName}</span>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-1.5 text-emerald-300 text-sm font-semibold">
                <CheckCircle2 className="w-4 h-4" /> {stats.valid}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">válidos</div>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="flex items-center gap-1.5 text-amber-300 text-sm font-semibold">
                <AlertTriangle className="w-4 h-4" /> {stats.invalid}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">inválidos</div>
            </div>
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
              <div className="flex items-center gap-1.5 text-rose-300 text-sm font-semibold">
                <XCircle className="w-4 h-4" /> {stats.dupes}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">duplicados</div>
            </div>
          </div>

          {guessedCols && (
            <div className="text-[11px] text-slate-400 mb-3 flex flex-wrap gap-x-4 gap-y-1">
              <span>Coluna <b className="text-slate-200">nome</b>: <code className="text-emerald-300">{guessedCols.nameCol || '—'}</code></span>
              <span>Coluna <b className="text-slate-200">telefone</b>: <code className="text-emerald-300">{guessedCols.phoneCol || '—'}</code></span>
              {!guessedCols.phoneCol && (
                <span className="text-rose-300">⚠ nenhuma coluna de telefone detectada — o arquivo pode ser inválido</span>
              )}
            </div>
          )}

          <button
            onClick={() => void importAll()}
            disabled={importing || !stats.valid}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg font-medium inline-flex items-center gap-2 transition"
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
            {importing ? 'Importando...' : `Importar ${stats.valid} contato${stats.valid === 1 ? '' : 's'}`}
          </button>

          {done && (
            <div className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              Importação concluída: <b>{done.summary.created}</b> criados, <b>{done.summary.duplicates}</b> duplicados, <b>{done.summary.errors}</b> erros.
            </div>
          )}

          {stats.invalid > 0 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Linhas ignoradas</div>
              <div className="max-h-40 overflow-auto space-y-1">
                {parsed.invalid.slice(0, 50).map((i, idx) => (
                  <div key={idx} className="text-xs text-slate-400 flex gap-2 items-center">
                    <span className="text-slate-600 font-mono">L{i.row}</span>
                    <span className="truncate">{i.name}</span>
                    <span className="text-slate-600 truncate">{i.phone}</span>
                    <span className="ml-auto text-[10px] uppercase">{i.reason}</span>
                  </div>
                ))}
                {parsed.invalid.length > 50 && (
                  <div className="text-[11px] text-slate-500">… e mais {parsed.invalid.length - 50} linhas</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-indigo-300" />
          <span className="text-sm font-semibold">Listas importadas</span>
          {loadingLists && <Loader2 className="w-4 h-4 animate-spin text-slate-500 ml-auto" />}
        </div>
        {lists.length === 0 && !loadingLists && (
          <div className="text-sm text-slate-500">
            Nenhuma lista importada ainda. Crie uma lista na aba <b>Leads</b> ou importe uma planilha acima.
          </div>
        )}
        <div className="space-y-1">
          {lists.map((l) => (
            <div key={l.id} className="flex items-center gap-3 text-sm py-2 border-b border-white/5 last:border-0">
              <span className="truncate text-slate-200">{l.name}</span>
              <span className="text-slate-600 text-xs">{l.count} contatos</span>
              <span className="ml-auto text-xs text-slate-500">{fmtDate(l.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}