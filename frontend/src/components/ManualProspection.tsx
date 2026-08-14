import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { UserPlus, Trash2, Check, AlertCircle } from 'lucide-react'

const API = import.meta.env.VITE_BACKEND_URL ?? 'https://consecom-backend-production.up.railway.app'

interface AddedLead {
  id: string
  name: string
  phone: string
  status: string
  error?: string
}

export function ManualProspection() {
  const [sessionUser, setSessionUser] = useState<string>('')
  const [bulkText, setBulkText] = useState('')
  const [added, setAdded] = useState<AddedLead[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const addLead = useCallback(
    async (name: string, phone: string): Promise<AddedLead> => {
      const r = await fetch(`${API}/api/leads/manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': sessionUser,
        },
        body: JSON.stringify({ name, phone }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        return {
          id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          phone,
          status: 'error',
          error: data?.message ?? data?.error ?? `HTTP ${r.status}`,
        }
      }
      const lead = (data as { ok: boolean; lead: AddedLead }).lead
      return { ...lead, error: undefined }
    },
    [sessionUser],
  )

  const handleBulkAdd = useCallback(async () => {
    if (!sessionUser || busy) return
    setError(null)
    const lines = bulkText.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return

    setBusy(true)
    const results: AddedLead[] = []
    for (const line of lines) {
      const parsed = parseLine(line)
      if (!parsed) continue
      const result = await addLead(parsed.name, parsed.phone)
      results.push(result)
    }
    setAdded((prev) => [...results, ...prev])
    setBulkText('')
    setBusy(false)
  }, [bulkText, sessionUser, busy, addLead])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void handleBulkAdd()
    }
  }

  const clearAdded = () => setAdded([])

  const successCount = added.filter((l) => l.status === 'novo').length
  const errorCount = added.filter((l) => l.error).length

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <UserPlus className="w-5 h-5 text-indigo-400" />
          <h1 className="text-lg font-semibold">Prospecção Manual</h1>
        </div>

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
            className="w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500 resize-y"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleBulkAdd}
              disabled={busy || !bulkText.trim()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              {busy ? (
                <>Adicionando...</>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  Adicionar leads
                </>
              )}
            </button>
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
                    {l.error ?? l.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}