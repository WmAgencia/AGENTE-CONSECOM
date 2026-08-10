import { useCallback, useState } from 'react'
import { supabase, type Campaign, type QueueMessage } from '../lib/supabase'
import { uploadMedia } from '../lib/storage'

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
    setField({ uploading: true, progress: 0 })
    const kind = inferKind(file)
    const { url, error } = await uploadMedia(file, (p) =>
      setField({ progress: p }),
    )
    if (error || !url) {
      setField({ uploading: false })
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
        <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
          Sequência ({messages.length} etapas)
        </div>
        {messages.length === 0 ? (
          <p className="text-sm text-slate-500 border border-dashed border-white/10 rounded-lg px-4 py-3">
            Ainda não há mensagens. Adicione abaixo a ordem de envio (ex.: 1º
            texto de apresentação, 2º vídeo prévia, 3º áudio...).
          </p>
        ) : (
          <ol className="space-y-2">
            {messages.map((m, i) => (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2"
              >
                <span className="w-6 h-6 shrink-0 rounded-full bg-indigo-600/30 flex items-center justify-center text-xs font-medium">
                  {i + 1}
                </span>
                <button
                  onClick={() => reorder(m.id, -1)}
                  disabled={i === 0}
                  className="text-slate-500 hover:text-white disabled:opacity-30 text-xs"
                  title="Subir"
                >
                  ↑
                </button>
                <button
                  onClick={() => reorder(m.id, 1)}
                  disabled={i === messages.length - 1}
                  className="text-slate-500 hover:text-white disabled:opacity-30 text-xs"
                  title="Descer"
                >
                  ↓
                </button>
                <span className={`${KIND_META[m.kind].cls} px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0`}>
                  {KIND_META[m.kind].label}
                </span>
                <span className="truncate flex-1 text-sm text-slate-300">
                  {m.text || m.media_caption || m.media_url || '...'}
                </span>
                {m.delay_seconds > 0 && (
                  <span className="text-[11px] text-slate-400 shrink-0">+{m.delay_seconds}s</span>
                )}
                <button
                  onClick={() => removeMessage(m.id)}
                  className="text-slate-500 hover:text-rose-400 text-xs shrink-0"
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Nova etapa */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-slate-400">
          Adicionar etapa
        </div>

        <div className="flex flex-wrap gap-2">
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setField({ kind: k })}
              className={`px-3 py-1.5 text-xs rounded-lg border transition ${
                draft.kind === k
                  ? 'border-indigo-500 bg-indigo-600/20 text-white'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
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
            className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
        ) : (
          <div className="space-y-2">
            {draft.media_url ? (
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <span className="truncate">{draft.media_name || 'Arquivo enviado'}</span>
                <button
                  onClick={() => setField({ media_url: '', media_name: '' })}
                  className="text-slate-500 hover:text-rose-400"
                >
                  trocar
                </button>
              </div>
            ) : (
              <label className="block cursor-pointer rounded-lg border border-dashed border-white/20 px-4 py-5 text-center text-sm text-slate-400 hover:border-indigo-500 hover:text-white transition">
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
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
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
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-400">
            Intervalo até a próxima etapa (s):
            <input
              type="number"
              min={0}
              value={draft.delay_seconds}
              onChange={(e) => setField({ delay_seconds: Number(e.target.value) })}
              className="ml-2 w-24 bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-sm outline-none focus:border-indigo-500"
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