import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, type Lead, type LeadStatus, type ConversationMessage } from '../lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: 'Novo',
  na_fila: 'Na fila',
  enviado: 'Enviado',
  conversando: 'Conversando',
  sem_interesse: 'Sem interesse',
  remarketing: 'Remarketing',
  reuniao_marcada: 'Reunião marcada',
  reuniao_cancelada: 'Reunião cancelada',
  fechado: 'Fechado',
  nao_fechado: 'Não fechado',
  para_ligacao: 'Nº p/ ligação',
}

const AVATAR_COLORS = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-amber-500',
  'bg-indigo-500',
  'bg-teal-500',
  'bg-fuchsia-500',
]

function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"
      />
    </svg>
  )
}

function LockGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"
      />
    </svg>
  )
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000)
  if (diff === 0) return 'Hoje'
  if (diff === 1) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}

export function LeadChat({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userId, setUserId] = useState<string>('')
  const scrollerRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback(async () => {
    const { data, error } = await supabase
      .from('consecom_conversations')
      .select('*')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: true })
      .limit(500)
    if (!error && data) setMessages(data as ConversationMessage[])
  }, [lead.id])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.id) setUserId(data.user.id)
    })
    void loadMessages()
    const ch = supabase
      .channel(`chat-${lead.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'consecom_conversations', filter: `lead_id=eq.${lead.id}` },
        () => void loadMessages(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [loadMessages, lead.id])

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  async function handleSend() {
    const t = text.trim()
    if (!t || sending) return
    if (!userId) {
      setError('Sessão expirada. Faça login novamente.')
      return
    }
    setSending(true)
    setError(null)
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ text: t }),
      })
      if (!r.ok) {
        const d = (await r.json().catch(() => null)) as { message?: string } | null
        setError(d?.message ?? 'Não foi possível enviar a mensagem.')
        return
      }
      setText('')
      await loadMessages()
    } catch {
      setError('Erro de conexão com o servidor.')
    } finally {
      setSending(false)
    }
  }

  const name = lead.name || 'Sem nome'
  const lastUser = useMemo(() => {
    let last: string | null = null
    for (const m of messages) if (m.role === 'user') last = m.created_at
    return last
  }, [messages])
  const subtitle =
    lastUser && Date.now() - new Date(lastUser).getTime() < 10 * 60000
      ? 'online'
      : STATUS_LABEL[lead.status]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-3xl h-[92vh] flex flex-col overflow-hidden rounded-xl border border-line-2 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-3 py-2.5 bg-chat-bar">
          <button onClick={onClose} title="Fechar"
            className="text-secondary hover:text-fg text-2xl leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-subtle-2">
            ‹
          </button>
          <span className="text-emerald-500">
            <WhatsAppGlyph className="w-9 h-9" />
          </span>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm ${avatarColor(name)}`}>
            {(name || '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-fg font-medium text-sm truncate">{name}</div>
            <div className="text-xs text-muted truncate">{subtitle}</div>
          </div>
          <div className="text-muted text-xs">{lead.phone || ''}</div>
        </div>

        {/* Messages */}
        <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 sm:px-8 py-3 space-y-0.5 bg-chat-bg">
          <div className="text-center text-xs text-faint py-1.5">
            <LockGlyph className="inline-block w-3.5 h-3.5 mr-1 -mt-0.5" />
            As mensagens são protegidas com criptografia de ponta a ponta.
          </div>
          {messages.map((m, i) => {
            const incoming = m.role === 'user'
            const prev = messages[i - 1]
            const next = messages[i + 1]
            const prevIncoming = prev ? prev.role === 'user' : undefined
            const nextIncoming = next ? next.role === 'user' : undefined
            const gapPrev = prev ? new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() : Infinity
            const gapNext = next ? new Date(next.created_at).getTime() - new Date(m.created_at).getTime() : Infinity
            const sameSenderPrev = prevIncoming === incoming
            const sameSenderNext = nextIncoming === incoming
            const isFirst = !sameSenderPrev || gapPrev > 10 * 60000
            const isLast = !sameSenderNext || gapNext > 10 * 60000
            const isHuman = m.role === 'assistant' && m.agent_model === 'HUMAN_REPLY'

            const day = new Date(m.created_at).toDateString()
            const showDay = i === 0 || new Date(messages[i - 1].created_at).toDateString() !== day

            return (
              <div key={`${m.id}-${i}`}>
                {showDay && (
                  <div className="text-center my-2">
                    <span className="inline-block text-[11px] text-muted bg-chat-in px-3 py-1 rounded-full shadow">
                      {dayLabel(m.created_at)}
                    </span>
                  </div>
                )}
                <div className={`flex ${incoming ? 'justify-start' : 'justify-end'} ${isFirst ? 'mt-2' : ''}`}>
                  <div
                    className={`relative max-w-[82%] sm:max-w-[70%] px-2.5 py-1.5 text-[13.5px] leading-snug shadow
                      ${incoming ? 'bg-chat-in text-fg ring-1 ring-line' : 'bg-[#005c4b] text-white'}
                      ${incoming ? '' : isHuman ? 'ring-1 ring-emerald-300/30' : ''}`}
                    style={{
                      borderTopLeftRadius: isFirst ? (incoming ? 0 : 12) : 12,
                      borderTopRightRadius: isFirst ? (incoming ? 12 : 0) : 12,
                      borderBottomLeftRadius: isLast ? 12 : (incoming ? 0 : 12),
                      borderBottomRightRadius: isLast ? 12 : (incoming ? 12 : 0),
                    }}
                  >
                    {m.sender_display_name && !incoming && (
                      <div className="text-[10px] text-emerald-100/80 mb-0.5">Enviado por {m.sender_display_name}</div>
                    )}
                    <span className="whitespace-pre-wrap break-words pr-6">{m.content}</span>
                    <span className="absolute bottom-0.5 right-1.5 text-[10px] text-muted/80 select-none">
                      {fmtTime(m.created_at)}
                    </span>
                    {isHuman && (
                      <span className="block text-[10px] text-emerald-200/80 mt-0.5">✔ Você</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {messages.length === 0 && (
            <div className="text-center text-sm text-faint py-10">
              Sem mensagens ainda nesta conversa.
            </div>
          )}
        </div>

        {/* Input */}
        <div className="px-3 sm:px-4 py-2.5 bg-chat-bar">
          {error && (
            <div className="text-xs text-rose-300 mb-1.5">{error}</div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder="Mensagem"
              className="flex-1 bg-chat-input text-fg rounded-lg px-4 py-2.5 text-sm outline-none placeholder:text-faint"
            />
            <button
              onClick={() => void handleSend()}
              disabled={sending || !text.trim()}
              title="Enviar"
              className="w-11 h-11 rounded-full bg-[#00a884] hover:bg-[#02b590] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white"
            >
              {sending ? (
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : (
                <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
                  <path fill="currentColor" d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
                </svg>
              )}
            </button>
          </div>
          <div className="text-center text-[10px] text-faint mt-1.5">
            Enviando como <span className="text-secondary">você</span> · via WhatsApp da Vyntra
          </div>
        </div>
      </div>
    </div>
  )
}
