import { useEffect, useMemo, useRef, useState } from 'react'
import {
  UploadCloud, FileSpreadsheet, Table, CheckCircle2, XCircle, AlertTriangle, RefreshCcw,
  Users, Loader2, ChevronLeft, AlertCircle, ContactRound,
} from 'lucide-react'
import { contactsApi, type ContactImportResponse, type Contact, type ContactList } from '../lib/api'
import { parseSpreadsheet, validateContacts, type ValidationReport } from '../lib/contacts'
import { Button } from './ui'

function fmtDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

type ListsState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export function ContactsView() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ValidationReport | null>(null)
  const [guessedCols, setGuessedCols] = useState<{ nameCol: string; phoneCol: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState<ContactImportResponse | null>(null)
  const [error, setError] = useState('')

  // Listas — estado inicial SEMPRE array; loading/erro separados.
  const [lists, setLists] = useState<ContactList[]>([])
  const [listsState, setListsState] = useState<ListsState>({ kind: 'loading' })

  // Detalhe expandido de uma lista (contatos).
  const [activeList, setActiveList] = useState<ContactList | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsState, setContactsState] = useState<ListsState>({ kind: 'loading' })

  async function loadLists() {
    setListsState({ kind: 'loading' })
    try {
      const data = await contactsApi.lists()
      setLists(Array.isArray(data) ? data : [])
      setListsState({ kind: 'ready' })
    } catch (e) {
      setLists([])
      setListsState({ kind: 'error', message: e instanceof Error ? e.message : 'Falha ao carregar contatos' })
    }
  }

  async function loadListDetail(list: ContactList) {
    setActiveList(list)
    setContacts([])
    setContactsState({ kind: 'loading' })
    try {
      const data = await contactsApi.listLeads(list.id)
      setContacts(Array.isArray(data) ? data : [])
      setContactsState({ kind: 'ready' })
    } catch (e) {
      setContacts([])
      setContactsState({ kind: 'error', message: e instanceof Error ? e.message : 'Falha ao carregar contatos' })
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

  async function importAll() {
    if (!parsed || !parsed.valid.length) return
    setImporting(true)
    setError('')
    setDone(null)
    try {
      // Contrato real do backend: { listName, contacts: [{name, phone}] }.
      const listName = `Importação ${new Date().toISOString().slice(0, 10)}`
      const res = await contactsApi.import(
        listName,
        parsed.valid.map((c) => ({ name: c.name, phone: c.phone })),
      )
      setDone(res)
      if (!res.ok) {
        const detail = res.firstError?.body ?? `Falha ao gravar ${res.summary.errors} contato(s).`
        console.error('[CONTACTS] import partial/failed', { summary: res.summary, firstError: res.firstError })
        setError(detail)
      }
      // Se a lista foi criada no backend, usa o id retornado para atualizar a UI.
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
          <p className="text-sm text-muted">Importe uma planilha (.csv ou .xlsx) com nomes e telefones para povoar a prospecção.</p>
        </div>
        <button onClick={() => void loadLists()} className="text-xs text-muted hover:text-fg inline-flex items-center gap-1.5">
          <RefreshCcw className="w-3.5 h-3.5" /> Atualizar listas
        </button>
      </div>

      {/* ===== Importação ===== */}
      <div className="rounded-xl border border-line bg-subtle p-5">
        <div className="flex items-center gap-2 mb-3">
          <FileSpreadsheet className="w-4 h-4 text-accent-300" />
          <span className="text-sm font-semibold">Importar planilha</span>
        </div>

        <label
          className="block border-2 border-dashed border-line-2 hover:border-accent-500/50 rounded-xl px-6 py-8 text-center cursor-pointer transition"
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
          <UploadCloud className="w-8 h-8 mx-auto text-faint mb-2" />
          <div className="text-sm text-secondary">
            {fileName || 'Arraste um arquivo ou clique para escolher'}
          </div>
          <div className="text-xs text-faint mt-1">Colunas esperadas: <b>nome</b> e <b>telefone</b> (qualquer ordem).</div>
        </label>

        {!fileName && (
          <div className="mt-3 text-xs text-faint flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            A detecção de colunas é automática: <code>nome</code>, <code>name</code>, <code>cliente</code> e <code>telefone</code>, <code>phone</code>, <code>whatsapp</code>, <code>celular</code>. Exemplo: <code>nome,telefone</code>.
          </div>
        )}

        {error && <div className="mt-3 text-xs text-rose-300 bg-rose-500/10 rounded-xl px-3 py-2">{error}</div>}
      </div>

      {/* ===== Validação ===== */}
      {parsed && stats && (
        <div className="rounded-xl border border-line bg-subtle p-5">
          <div className="flex items-center gap-2 mb-4">
            <Table className="w-4 h-4 text-accent-300" />
            <span className="text-sm font-semibold">Validação</span>
            <span className="text-xs text-faint ml-auto font-mono">{fileName}</span>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-1.5 text-emerald-300 text-sm font-semibold">
                <CheckCircle2 className="w-4 h-4" /> {stats.valid}
              </div>
              <div className="text-[11px] text-muted mt-0.5">válidos</div>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="flex items-center gap-1.5 text-amber-300 text-sm font-semibold">
                <AlertTriangle className="w-4 h-4" /> {stats.invalid}
              </div>
              <div className="text-[11px] text-muted mt-0.5">inválidos</div>
            </div>
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-3">
              <div className="flex items-center gap-1.5 text-rose-300 text-sm font-semibold">
                <XCircle className="w-4 h-4" /> {stats.dupes}
              </div>
              <div className="text-[11px] text-muted mt-0.5">duplicados (arquivo)</div>
            </div>
          </div>

          {guessedCols && (
            <div className="text-[11px] text-muted mb-3 flex flex-wrap gap-x-4 gap-y-1">
              <span>Coluna <b className="text-fg">nome</b>: <code className="text-emerald-300">{guessedCols.nameCol || '—'}</code></span>
              <span>Coluna <b className="text-fg">telefone</b>: <code className="text-emerald-300">{guessedCols.phoneCol || '—'}</code></span>
              {!guessedCols.phoneCol && (
                <span className="text-rose-300">⚠ nenhuma coluna de telefone detectada — o arquivo pode ser inválido</span>
              )}
            </div>
          )}

<Button
            onClick={() => void importAll()}
            disabled={importing || !stats.valid}
            loading={importing}
            className="inline-flex items-center gap-2"
          >
            {importing ? 'Importando...' : `Importar ${stats.valid} contato${stats.valid === 1 ? '' : 's'}`}
          </Button>

          {done && (
            <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              Importação concluída: <b>{done.summary.created}</b> criados, <b>{done.summary.duplicates}</b> duplicados, <b>{done.summary.errors}</b> erros.
            </div>
          )}

          {stats.invalid > 0 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wide text-faint mb-2">Linhas ignoradas</div>
              <div className="max-h-40 overflow-auto space-y-1">
                {parsed.invalid.slice(0, 50).map((i, idx) => (
                  <div key={idx} className="text-xs text-muted flex gap-2 items-center">
                    <span className="text-slate-600 font-mono">L{i.row}</span>
                    <span className="truncate">{i.name}</span>
                    <span className="text-slate-600 truncate">{i.phone}</span>
                    <span className="ml-auto text-[10px] uppercase">{i.reason}</span>
                  </div>
                ))}
                {parsed.invalid.length > 50 && (
                  <div className="text-[11px] text-faint">… e mais {parsed.invalid.length - 50} linhas</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== Listas + contatos ===== */}
      {activeList ? (
        <div className="rounded-xl border border-line bg-subtle p-5">
          <Button variant="secondary"
            onClick={() => setActiveList(null)}
            className="inline-flex items-center gap-1 mb-3"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Voltar para listas
          </Button>
          <div className="flex items-center gap-2 mb-4">
            <ContactRound className="w-4 h-4 text-accent-300" />
            <span className="text-sm font-semibold">{activeList.name}</span>
            <span className="text-xs text-faint">{activeList.count} contatos</span>
          </div>

          {contactsState.kind === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando contatos…
            </div>
          )}

          {contactsState.kind === 'error' && (
            <ErrorBlock onRetry={() => void loadListDetail(activeList)} message={contactsState.message} />
          )}

          {contactsState.kind === 'ready' && contacts.length === 0 && (
            <div className="text-sm text-faint py-6 text-center">
              Nenhum contato nesta lista.
            </div>
          )}

          {contactsState.kind === 'ready' && contacts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-faint border-b border-line">
                    <th className="py-2 pr-3 font-medium">Nome</th>
                    <th className="py-2 pr-3 font-medium">Telefone</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-3 text-fg">{c.name}</td>
                      <td className="py-2 pr-3 text-muted font-mono text-xs">{c.phone}</td>
                      <td className="py-2 text-muted">{c.status ?? 'novo'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-subtle p-5">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-accent-300" />
            <span className="text-sm font-semibold">Listas importadas</span>
            {listsState.kind === 'loading' && <Loader2 className="w-4 h-4 animate-spin text-faint ml-auto" />}
          </div>

          {listsState.kind === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando listas…
            </div>
          )}

          {listsState.kind === 'error' && (
            <ErrorBlock onRetry={() => void loadLists()} message={listsState.message} />
          )}

          {listsState.kind === 'ready' && lists.length === 0 && (
            <div className="text-sm text-faint py-6 text-center">
              Nenhum contato encontrado.
              <br />
              Importe seus contatos para começar uma campanha.
            </div>
          )}

          {listsState.kind === 'ready' && lists.length > 0 && (
            <div className="space-y-1">
              {lists.map((l) => (
                <button
                  key={l.id}
                  onClick={() => void loadListDetail(l)}
                  className="w-full flex items-center gap-3 text-sm py-2 border-b border-line last:border-0 hover:bg-subtle rounded px-2 -mx-2 transition"
                >
                  <span className="truncate text-fg">{l.name}</span>
                  <span className="text-slate-600 text-xs">{l.count} contatos</span>
                  <span className="ml-auto text-xs text-faint">{fmtDate(l.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ErrorBlock({ onRetry, message }: { onRetry: () => void; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <div className="flex items-center gap-2 text-sm text-rose-300">
        <AlertCircle className="w-4 h-4" />
        Não foi possível carregar os contatos.
      </div>
      <div className="text-xs text-faint">{message}</div>
      <button
        onClick={onRetry}
        className="px-4 py-2 text-sm bg-accent-600 text-white hover:bg-accent-500 rounded-xl font-medium inline-flex items-center gap-2 transition"
      >
        <RefreshCcw className="w-3.5 h-3.5" /> Tentar novamente
      </button>
    </div>
  )
}
