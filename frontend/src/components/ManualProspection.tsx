import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { UserPlus, Trash2, Check, AlertCircle, Link2, Loader2, Pencil, X, ArrowRight } from 'lucide-react'
import { Button } from './ui'

const API = import.meta.env.VITE_BACKEND_URL ?? 'https://consecom-backend-production.up.railway.app'

interface AddedLead {
  id: string
  name: string
  phone: string
  status: 'added' | 'duplicate' | 'invalid' | 'error' | string
  error?: string
  message?: string
}

interface UrlContact {
  index: number
  name: string
  phone: string
  phone_normalized: string | null
  whatsapp: boolean
  context?: string | null
  selected: boolean
}

export function ManualProspection() {
  const [sessionUser, setSessionUser] = useState<string>('')
  const [bulkText, setBulkText] = useState('')
  const [added, setAdded] = useState<AddedLead[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [tab, setTab] = useState<'manual' | 'url'>('manual')

  // Estado da prospecção por URL.
  const [url, setUrl] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [preview, setPreview] = useState<UrlContact[] | null>(null)
  const [previewTitle, setPreviewTitle] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<AddedLead[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')

  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.id) setSessionUser(data.user.id)
    })
  }, [])

  const parseLine = (line: string): { name: string; phone: string } | null => {
    const trimmed = line.trim()
    if (!trimmed) return null
    // Quando houver vírgula, o que está depois da última é o telefone.
    // Quando não houver vírgula, tenta extrair o final como telefone.
    let name: string
    let phone: string
    const lastComma = trimmed.lastIndexOf(',')
    if (lastComma >= 0 && lastComma < trimmed.length - 1) {
      name = trimmed.slice(0, lastComma).trim()
      phone = trimmed.slice(lastComma + 1).trim()
    } else {
      // Sem vírgula: tenta separar números do final
      const match = trimmed.match(/(.+?)([\d\s\-\(\)\+]+)$/)
      if (match && match[1].trim().length > 0) {
        name = match[1].trim()
        phone = match[2].trim()
      } else {
        name = trimmed
        phone = ''
      }
    }
    if (!phone) return null
    return { name, phone }
  }

  const handleBulkAdd = useCallback(async () => {
    if (!sessionUser || busy) return
    setError(null)
    const lines = bulkText.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return

    const parsedLeads = lines
      .map((line) => parseLine(line))
      .filter((p): p is { name: string; phone: string } => p !== null)

    if (parsedLeads.length === 0) {
      setError('Nenhum contato válido encontrado nas linhas.')
      return
    }

    setBusy(true)
    try {
      const r = await fetch(`${API}/api/leads/manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': sessionUser,
        },
        body: JSON.stringify({ leads: parsedLeads }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        const msg = (data as { message?: string; error?: string })?.message ?? (data as { error?: string })?.error ?? `HTTP ${r.status}`
        setError(typeof msg === 'string' ? msg : 'Falha ao adicionar leads.')
        return
      }
      const results = (data as { results?: AddedLead[] }).results ?? []
      const mapped: AddedLead[] = results.map((res) => ({
        id: res.id ?? `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: res.name ?? '',
        phone: res.phone ?? '',
        status: res.status,
        error: res.status !== 'added' ? res.message ?? res.error : undefined,
      }))
      setAdded((prev) => [...mapped, ...prev])
      setBulkText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro de conexão com o servidor.')
    } finally {
      setBusy(false)
    }
  }, [bulkText, sessionUser, busy])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void handleBulkAdd()
    }
  }

  const clearAdded = () => setAdded([])

  const successCount = added.filter((l) => l.status === 'added').length
  const errorCount = added.filter((l) => l.status !== 'added').length

  const statusLabel = (l: AddedLead): string => {
    if (l.error) return l.error
    if (l.status === 'added') return 'Adicionado'
    if (l.status === 'duplicate') return 'Duplicado'
    if (l.status === 'invalid') return 'Inválido'
    return l.status
  }

  // --- Prospecção por URL ---

  const handleProspect = useCallback(async () => {
    if (!sessionUser || urlBusy) return
    setUrlError(null)
    const trimmed = url.trim()
    if (!trimmed) {
      setUrlError('Informe a URL da página.')
      return
    }
    setUrlBusy(true)
    setPreview(null)
    setImported([])
    try {
      const r = await fetch(`${API}/api/leads/prospect-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': sessionUser,
        },
        body: JSON.stringify({ url: trimmed }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        const msg = (data as { message?: string })?.message ?? (data as { error?: string })?.error ?? `HTTP ${r.status}`
        setUrlError(typeof msg === 'string' ? msg : 'Não foi possível prospectar a URL.')
        return
      }
      setPreview((data as { contacts?: UrlContact[] }).contacts ?? [])
      setPreviewTitle((data as { title?: string }).title ?? '')
      setPreviewUrl((data as { url?: string }).url ?? trimmed)
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : 'Erro de conexão com o servidor.')
    } finally {
      setUrlBusy(false)
    }
  }, [sessionUser, urlBusy, url])

  const togglePreview = (index: number) => {
    setPreview((prev) => prev?.map((c) => (c.index === index ? { ...c, selected: !c.selected } : c)) ?? null)
  }

  const startEdit = (index: number) => {
    const contact = preview?.find((c) => c.index === index)
    if (!contact) return
    setEditing(index)
    setEditName(contact.name)
    setEditPhone(contact.phone)
  }

  const saveEdit = () => {
    if (editing === null) return
    setPreview((prev) =>
      prev?.map((c) =>
        c.index === editing ? { ...c, name: editName.trim(), phone: editPhone.trim() } : c,
      ) ?? null,
    )
    setEditing(null)
  }

  const removePreview = (index: number) => {
    setPreview((prev) => prev?.filter((c) => c.index !== index) ?? null)
  }

  const importSelected = useCallback(async () => {
    if (!sessionUser || importing) return
    const selected = preview?.filter((c) => c.selected) ?? []
    if (selected.length === 0) {
      setUrlError('Selecione ao menos um lead para importar.')
      return
    }
    setImporting(true)
    setUrlError(null)
    try {
      const r = await fetch(`${API}/api/leads/prospect-import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': sessionUser,
        },
        body: JSON.stringify({ url: previewUrl, leads: selected }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        const msg = (data as { message?: string })?.message ?? (data as { error?: string })?.error ?? `HTTP ${r.status}`
        setUrlError(typeof msg === 'string' ? msg : 'Falha ao importar os leads.')
        return
      }
      const results = (data as { results?: AddedLead[] }).results ?? []
      const mapped: AddedLead[] = results.map((res) => ({
        id: res.id ?? `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: res.name ?? '',
        phone: res.phone ?? '',
        status: res.status,
        error: res.status !== 'added' ? res.message ?? res.error : undefined,
      }))
      setImported(mapped)
      setAdded((prev) => [...mapped, ...prev])
      setPreview(null)
      setPreviewTitle('')
      setPreviewUrl('')
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : 'Erro de conexão com o servidor.')
    } finally {
      setImporting(false)
    }
  }, [sessionUser, importing, preview, previewUrl])

  const previewSelectedCount = preview?.filter((c) => c.selected).length ?? 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <UserPlus className="w-5 h-5 text-accent-300" />
          <h1 className="text-lg font-semibold">Prospecção</h1>
        </div>

        <div className="flex gap-1">
          <span
            onClick={() => setTab('manual')}
            className={`px-4 py-1.5 rounded-xl text-sm font-medium cursor-pointer transition ${tab === 'manual' ? 'bg-accent-600 text-white' : 'text-muted hover:text-fg'}`}
          >
            Manual
          </span>
          <span
            onClick={() => setTab('url')}
            className={`px-4 py-1.5 rounded-xl text-sm font-medium cursor-pointer transition flex items-center gap-1.5 ${tab === 'url' ? 'bg-accent-600 text-white' : 'text-muted hover:text-fg'}`}
          >
            <Link2 className="w-4 h-4" />
            Por URL
          </span>
        </div>

        {tab === 'manual' && (
          <>
        <p className="text-sm text-secondary">
          Cole os contatos abaixo, um por linha. Formato:{' '}
          <code className="bg-subtle px-1.5 py-0.5 rounded text-xs">
            Nome, (DD) 99999-9999
          </code>
        </p>

        <div className="space-y-2">
<textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              'Ana Silva, (15) 99999-8888\nJoão Pedro, 11 99888-7766\nMaria Santos, (21) 97777-6655'
            }
            rows={8}
            className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 resize-y"
          />
          <div className="flex items-center gap-3">
            <Button
              onClick={handleBulkAdd}
              disabled={busy || !bulkText.trim()}
              loading={busy}
              className="flex items-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              Adicionar leads
            </Button>
            <span className="text-xs text-muted">
              Ctrl+Enter para adicionar rapidamente
            </span>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        {added.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                Adicionados ({successCount} ok, {errorCount} erro)
              </div>
              <button
                onClick={clearAdded}
                className="text-xs text-muted hover:text-fg flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Limpar
              </button>
            </div>
            {successCount > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                <div className="text-sm text-emerald-300">
                  Leads importados com sucesso. Distribua para uma campanha na página Importados.
                </div>
                <button
                  onClick={() => navigate('/importados')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white"
                >
                  Ir para Importados
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}
            <div className="space-y-1.5">
              {added.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm"
                >
                  {l.error ? (
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  ) : (
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 text-fg">{l.name}</span>
                  <span className="text-xs text-muted">{l.phone}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      l.error
                        ? 'bg-rose-500/10 text-rose-300'
                        : 'bg-emerald-500/10 text-emerald-300'
                    }`}
                  >
                    {statusLabel(l)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
          </>
        )}

        {tab === 'url' && (
          <>
        <p className="text-sm text-secondary">
          Cole o endereço de uma página que lista contatos (diretórios, sites
          corporativos, páginas com WhatsApp). O VYNTRA extrai nome e telefone
          e mostra uma prévia para você revisar antes de importar.
        </p>

        <div className="space-y-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleProspect()
              }
            }}
            placeholder="https://exemplo.com.br/contatos"
            className="w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent-500"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleProspect}
              disabled={urlBusy || !url.trim()}
              className="px-4 py-2 bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              {urlBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Prospectando...
                </>
              ) : (
                <>
                  <Link2 className="w-4 h-4" />
                  Prospectar URL
                </>
              )}
            </button>
            <span className="text-xs text-muted">Enter para iniciar</span>
          </div>
        </div>

        {urlError && (
          <div className="flex items-center gap-2 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4" />
            {urlError}
          </div>
        )}

        {imported.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">
              Importados ({imported.filter((l) => l.status === 'added').length} ok,{' '}
              {imported.filter((l) => l.status !== 'added').length} erro)
            </div>
            <div className="space-y-1.5">
              {imported.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm"
                >
                  {l.error ? (
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  ) : (
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 text-fg">{l.name}</span>
                  <span className="text-xs text-muted">{l.phone}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      l.error
                        ? 'bg-rose-500/10 text-rose-300'
                        : 'bg-emerald-500/10 text-emerald-300'
                    }`}
                  >
                    {statusLabel(l)}
                  </span>
                </div>
              ))}
            </div>
            {imported.some((l) => l.status === 'added' && l.id) && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                <div className="text-sm text-emerald-300">
                  Leads importados com sucesso. Distribua para uma campanha na página Importados.
                </div>
                <button
                  onClick={() => navigate('/importados')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white"
                >
                  Ir para Importados
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}

        {preview && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {preview.length} contato(s) encontrados
                {previewTitle ? ` · ${previewTitle}` : ''}
              </div>
              <span className="text-xs text-muted truncate max-w-[40%]">{previewUrl}</span>
            </div>
            <div className="rounded-lg border border-line overflow-hidden">
              <div className="px-4 py-2 border-b border-line text-sm font-medium flex items-center justify-between">
                <span>Selecionar todos ({previewSelectedCount}/{preview.length})</span>
                <button
                  onClick={() => setPreview((prev) => prev?.map((c) => ({ ...c, selected: true })) ?? null)}
                  className="text-xs text-accent-300 hover:text-accent-200"
                >
                  Todos
                </button>
              </div>
              {preview.map((c) => (
                <div key={c.index} className="flex items-center gap-3 px-4 py-2 border-b border-line last:border-0">
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={() => togglePreview(c.index)}
                    className="accent-emerald-600"
                  />
                  <div className="flex-1 min-w-0">
                    {editing === c.index ? (
                      <div className="flex flex-col gap-1">
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="bg-field border border-line-2 rounded px-2 py-1 text-sm"
                          placeholder="Nome"
                        />
                        <input
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          className="bg-field border border-line-2 rounded px-2 py-1 text-sm"
                          placeholder="Telefone"
                        />
                        <div className="flex gap-2">
                          <button onClick={saveEdit} className="text-xs text-emerald-400 hover:text-emerald-300">
                            Salvar
                          </button>
                          <button onClick={() => setEditing(null)} className="text-xs text-muted hover:text-fg">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <span className="block text-sm truncate">{c.name || 'Sem nome'}</span>
                        <span className="block text-xs text-faint">
                          {c.phone} {c.whatsapp ? '· WhatsApp' : ''}
                          {c.context && c.context !== c.name ? ` · ${c.context}` : ''}
                        </span>
                      </>
                    )}
                  </div>
                  {editing !== c.index && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => startEdit(c.index)}
                        className="text-muted hover:text-fg"
                        title="Editar"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => removePreview(c.index)}
                        className="text-rose-400 hover:text-rose-300"
                        title="Remover"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={importSelected}
              disabled={importing || previewSelectedCount === 0}
              className="px-4 py-2 rounded-lg bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-40 text-sm font-medium"
            >
              {importing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin inline" /> Importando...
                </>
              ) : (
                `Importar ${previewSelectedCount} lead(s)`
              )}
            </button>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  )
}