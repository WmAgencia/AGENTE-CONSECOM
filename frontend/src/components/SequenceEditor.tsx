import { useCallback, useState } from 'react'
import { supabase, type Campaign, type QueueMessage } from '../lib/supabase'
import { MAX_VIDEO_BYTES, VIDEO_TOO_LARGE_MESSAGE, uploadMedia } from '../lib/storage'
import {
  SUPPORTED_VARIABLES,
  renderTemplate,
  unresolvedVariables,
} from '../lib/template'

type Kind = QueueMessage['kind']

const KIND_META: Record<Kind, { label: string; cls: string }> = {
  text: { label: 'Texto', cls: 'bg-sky-500/15 text-sky-300' },
  audio: { label: 'Áudio', cls: 'bg-amber-500/15 text-amber-300' },
  video: { label: 'Vídeo', cls: 'bg-rose-500/15 text-rose-300' },
  image: { label: 'Imagem', cls: 'bg-emerald-500/15 text-emerald-300' },
  document: { label: 'Doc', cls: 'bg-violet-500/15 text-violet-300' },
}

const KIND_ORDER: Kind[] = ['text', 'audio', 'video', 'image', 'document']

// Placeholders dinâmicos disponíveis para personalizar a mensagem
// Ex.: "{nome_empresa}", "{cidade}", "{categoria}" — substituídos no envio.

interface Draft {
  kind: Kind
  text: string
  caption: string
  media_url: string
  media_name: string
  delay_seconds: number
  uploading: boolean
  progress: number
}

function emptyDraft(): Draft {
  return {
    kind: 'text',
    text: '',
    caption: '',
    media_url: '',
    media_name: '',
    delay_seconds: 0,
    uploading: false,
    progress: 0,
  }
}

export function SequenceEditor({
  campaign,
  messages,
  onSaved,
}: {
  campaign: Campaign
  messages: QueueMessage[]
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>('')

  const setField = useCallback(
    (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })),
    [],
  )

  async function handleFile(file: File) {
    if (!file) return
    if (file.type.toLowerCase().startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
      setError(VIDEO_TOO_LARGE_MESSAGE)
      return
    }
    setError('')
    setField({ uploading: true, progress: 0 })
    try {
      const kind = inferKind(file)
      const { url, error } = await uploadMedia(file, (p) =>
        setField({ progress: p }),
      )
      if (error || !url) {
        setError(`Erro no envio do arquivo: ${error}`)
        return
      }
      setField({
        uploading: false,
        progress: 100,
        media_url: url,
        media_name: file.name,
        kind,
      })
    } catch (e) {
      setError(`Erro no envio do arquivo: ${e instanceof Error ? e.message : 'erro desconhecido'}`)
    } finally {
      setField({ uploading: false })
    }
  }

  async function addMessage() {
    if (saving) return
    const nextPosition =
      messages.length > 0 ? Math.max(...messages.map((m) => m.position)) + 1 : 0

    if (draft.kind !== 'text') {
      if (!draft.media_url) {
        setError('Envie um arquivo para esta etapa.')
        return
      }
    } else if (!draft.text.trim()) {
      setError('Escreva o texto da mensagem.')
      return
    }

    const payload: Partial<QueueMessage> = {
      campaign_id: campaign.id,
      position: nextPosition,
      kind: draft.kind,
      text: draft.kind === 'text' ? draft.text.trim() : draft.text.trim() || null,
      media_url: draft.media_url || null,
      media_caption: draft.caption.trim() || null,
      delay_seconds: Number(draft.delay_seconds) || 0,
    }

    setSaving(true)
    const { error } = await supabase.from('queue_messages').insert(payload)
    setSaving(false)
    if (error) {
      setError(error.message)
      return
    }
    setDraft(emptyDraft())
    setError('')
    onSaved()
  }

  async function removeMessage(id: string) {
    const { error } = await supabase.from('queue_messages').delete().eq('id', id)
    if (error) {
      setError(`Não foi possível remover a etapa: ${error.message}`)
      return
    }
    setError('')
    onSaved()
  }

  const unresolved =
    draft.kind === 'text'
      ? unresolvedVariables(draft.text)
      : unresolvedVariables(draft.caption)
  const preview =
    draft.kind === 'text'
      ? renderTemplate(draft.text)
      : renderTemplate(draft.caption)

  function insertVariable(token: string) {
    const target = draft.kind === 'text' ? 'text' : 'caption'
    const current = draft[target] || ''
    const value = `{${token}}`
    if (current.includes(value)) return
    setField({ [target]: current ? `${current} ${value}` : value } as Partial<Draft>)
  }

  async function reorder(id: string, dir: -1 | 1) {
    const idx = messages.findIndex((m) => m.id === id)
    const swapWith = messages[idx + dir]
    if (!swapWith) return
    const { error: e1 } = await supabase
      .from('queue_messages')
      .update({ position: swapWith.position })
      .eq('id', id)
    if (e1) {
      setError(`Não foi possível reordenar: ${e1.message}`)
      return
    }
    const { error: e2 } = await supabase
      .from('queue_messages')
      .update({ position: messages[idx].position })
      .eq('id', swapWith.id)
    if (e2) {
      setError(`Não foi possível reordenar: ${e2.message}`)
      return
    }
    setError('')
    onSaved()
  }

  return (
    <div className="space-y-4">
      {/* Sequência atual */}
      <div>
        <div className="text-xs uppercase tracking-wide text-muted mb-2">
          Sequência ({messages.length} etapas)
        </div>
        {messages.length === 0 ? (
          <p className="text-sm text-faint border border-dashed border-line-2 rounded-lg px-4 py-3">
            Ainda não há mensagens. Adicione abaixo a ordem de envio (ex.: 1º
            texto de apresentação, 2º vídeo prévia, 3º áudio...).
          </p>
        ) : (
          <ol className="space-y-2">
            {messages.map((m, i) => (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-lg border border-line bg-subtle px-3 py-2"
              >
                <span className="w-6 h-6 shrink-0 rounded-full bg-indigo-600/30 flex items-center justify-center text-xs font-medium">
                  {i + 1}
                </span>
                <button
                  onClick={() => reorder(m.id, -1)}
                  disabled={i === 0}
                  className="text-faint hover:text-fg disabled:opacity-30 text-xs"
                  title="Subir"
                >
                  ↑
                </button>
                <button
                  onClick={() => reorder(m.id, 1)}
                  disabled={i === messages.length - 1}
                  className="text-faint hover:text-fg disabled:opacity-30 text-xs"
                  title="Descer"
                >
                  ↓
                </button>
                <span className={`${KIND_META[m.kind].cls} px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0`}>
                  {KIND_META[m.kind].label}
                </span>
                <span className="truncate flex-1 text-sm text-secondary">
                  {m.text || m.media_caption || m.media_url || '...'}
                </span>
                {m.delay_seconds > 0 && (
                  <span className="text-[11px] text-muted shrink-0">+{m.delay_seconds}s</span>
                )}
                <button
                  onClick={() => removeMessage(m.id)}
                  className="text-faint hover:text-rose-400 text-xs shrink-0"
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Nova etapa */}
      <div className="rounded-xl border border-line-2 bg-subtle p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted">
          Adicionar etapa
        </div>

        <div className="flex flex-wrap gap-2">
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setField({ kind: k })}
              className={`px-3 py-1.5 text-xs rounded-lg border transition ${
                draft.kind === k
                  ? 'border-indigo-500 bg-indigo-600/20 text-fg'
                  : 'border-line-2 bg-subtle text-secondary hover:bg-subtle-2'
              }`}
            >
              {KIND_META[k].label}
            </button>
          ))}
        </div>

        {draft.kind === 'text' ? (
          <textarea
            value={draft.text}
            onChange={(e) => setField({ text: e.target.value })}
            rows={4}
            placeholder="Escreva a mensagem de texto. Use variáveis como {nome_empresa}..."
            className="w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
        ) : (
          <div className="space-y-2">
            {draft.media_url ? (
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <span className="truncate">{draft.media_name || 'Arquivo enviado'}</span>
                <button
                  onClick={() => setField({ media_url: '', media_name: '' })}
                  className="text-faint hover:text-rose-400"
                >
                  trocar
                </button>
              </div>
            ) : (
              <label className="block cursor-pointer rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-sm text-muted hover:border-indigo-500 hover:text-fg transition">
                {draft.uploading
                  ? `Enviando... ${draft.progress}%`
                  : `Clique para enviar o arquivo (${KIND_META[draft.kind].label})`}
                <input
                  type="file"
                  accept={acceptForKind(draft.kind)}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handleFile(f)
                  }}
                />
              </label>
            )}
            {draft.uploading && (
              <div className="h-1.5 rounded-full bg-subtle-2 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${draft.progress}%` }}
                />
              </div>
            )}
            <input
              value={draft.caption}
              onChange={(e) => setField({ caption: e.target.value })}
              placeholder={`Legenda (opcional) — pode usar variáveis (ex: {nome_empresa})`}
              className="w-full bg-field border border-line-2 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
            />
          </div>
        )}

        <div className="space-y-2">
            <div>
              <div className="text-[11px] text-faint mb-1">Inserir variável</div>
              <div className="flex flex-wrap gap-1.5">
                {SUPPORTED_VARIABLES.map((v) => (
                  <button
                    key={v.token}
                    type="button"
                    onClick={() => insertVariable(v.token)}
                    title={v.description}
                    className="text-[11px] px-2 py-1 rounded-md border border-line-2 bg-subtle text-secondary hover:border-indigo-500 hover:text-fg transition"
                  >
                    {'{' + v.token + '}'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-faint mb-1">
                Preview (com dados de exemplo)
              </div>
              <div className="rounded-lg border border-line-2 bg-subtle-2 px-3 py-2 text-sm text-secondary whitespace-pre-wrap break-words">
                {preview || <span className="text-slate-600">—</span>}
              </div>
              {unresolved.length > 0 && (
                <p className="text-[11px] text-amber-400 mt-1">
                  Variáveis não reconhecidas (ficam literais no envio):{' '}
                  {unresolved.map((u) => `{${u}}`).join(', ')}
                </p>
              )}
            </div>
          </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-muted">
            Intervalo até a próxima etapa (s):
            <input
              type="number"
              min={0}
              value={draft.delay_seconds}
              onChange={(e) => setField({ delay_seconds: Number(e.target.value) })}
              className="ml-2 w-24 bg-field border border-line-2 rounded-lg px-2 py-1 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <button
            onClick={addMessage}
            disabled={saving}
            className="ml-auto px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium"
          >
            {saving ? 'Salvando...' : '+ Adicionar etapa'}
          </button>
        </div>

        {error && <p className="text-sm text-rose-400">{error}</p>}
      </div>
    </div>
  )
}

function inferKind(file: File): Kind {
  const t = file.type.split('/')[0]
  if (t === 'audio') return 'audio'
  if (t === 'video') return 'video'
  if (t === 'image') return 'image'
  return 'document'
}

function acceptForKind(kind: Kind): string {
  switch (kind) {
    case 'audio':
      return 'audio/*'
    case 'video':
      return 'video/*'
    case 'image':
      return 'image/*'
    case 'document':
      return '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv'
    default:
      return '*/*'
  }
}
