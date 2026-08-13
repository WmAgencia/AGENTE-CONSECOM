import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Play, Pause, Sparkles, WifiOff, AudioLines, Trash2 } from 'lucide-react'
import { sendMessage, loadHistory, saveHistory, getConversationId, resetConversation, clearHistory, type ChatMessage } from '../services/aiChat'
import { newChatId, formatAudioDuration, formatChatTimestamp } from '../lib/chat'
import { VoiceInput, type VoiceAudio } from '../components/VoiceInput'

// =====================================================================
// ASSISTENTE PESSOAL da VYNTRA — simples, mobile-first.
// Executa ações REAIS (agenda, campanhas, leads) sob o comando do
// operador. Usa o endpoint dedicado /api/personal/chat — NUNCA o agente
// comercial (/api/ai/chat).
// =====================================================================

export function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  const bottomRef = useRef<HTMLDivElement | null>(null)
  const conversationIdRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        conversationIdRef.current = await getConversationId()
      } catch {
        /* sessão expira apenas quando desconecta */
      }
      const history = await loadHistory()
      if (!alive) return
      // Apenas a nova sessão (v1 do histórico pessoal); ignora o histórico
      // antigo do agente comercial se ainda houver (as chaves diferem).
      setMessages(history)
      setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  async function handleClearConversation() {
    if (clearing) return
    setClearing(true)
    try {
      await resetConversation()
      await clearHistory()
      setMessages([])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao limpar a conversa')
    } finally {
      setClearing(false)
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, typing])

  async function pushLocal(msg: ChatMessage) {
    setMessages((prev) => {
      const next = [...prev, msg]
      void saveHistory(next)
      return next
    })
  }

  const handleSendText = useCallback(async () => {
    const content = text.trim()
    if (!content || typing) return
    setText('')

    const userMsg: ChatMessage = {
      id: newChatId(),
      role: 'user',
      content,
      createdAt: Date.now(),
    }
    await pushLocal(userMsg)
    setTyping(true)
    setError(null)

    try {
      const convId =
        conversationIdRef.current ?? (await getConversationId())
      conversationIdRef.current = convId
      const res = await sendMessage(content, convId)
      await pushLocal({
        id: newChatId(),
        role: 'assistant',
        content: res.response,
        createdAt: Date.now(),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao falar com a IA')
    } finally {
      setTyping(false)
    }
  }, [text, typing])

  const handleVoiceSend = useCallback(
    async (voiceText: string, audio?: VoiceAudio) => {
      const userMsg: ChatMessage = {
        id: newChatId(),
        role: 'user',
        content: voiceText,
        audioUri: audio?.uri,
        audioDurationMs: audio?.durationMs,
        createdAt: Date.now(),
      }
      await pushLocal(userMsg)

      const content = voiceText.trim()
      if (!content) {
        // Áudio gravado, mas sem transcrição (sem reconhecimento no aparelho).
        setError('Áudio salvo sem transcrição. Verifique o reconhecimento de voz e tente novamente.')
        return
      }

      setTyping(true)
      setError(null)
      try {
        const convId = conversationIdRef.current ?? (await getConversationId())
        conversationIdRef.current = convId
        const res = await sendMessage(content, convId)
        await pushLocal({
          id: newChatId(),
          role: 'assistant',
          content: res.response,
          createdAt: Date.now(),
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Falha ao falar com a IA')
      } finally {
        setTyping(false)
      }
    },
    [],
  )

  function audioSrc(uri: string): string {
    if (uri.startsWith('http')) return uri
    return Capacitor.convertFileSrc(uri)
  }

  function togglePlay(msg: ChatMessage) {
    if (playingId === msg.id) {
      const el = document.getElementById(`audio-${msg.id}`) as HTMLAudioElement | null
      el?.pause()
      setPlayingId(null)
      return
    }
    setPlayingId(msg.id)
    const el = document.getElementById(`audio-${msg.id}`) as HTMLAudioElement | null
    void el?.play()
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-2.5 px-1 pt-1 pb-3">
        <div className="w-9 h-9 rounded-xl bg-indigo-500/20 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-indigo-300" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold leading-tight">Assistente Pessoal</h1>
          <p className="text-[11px] text-slate-400">
            Agenda, campanhas e leads — sob seu comando.
          </p>
        </div>
        <button
          onClick={() => void handleClearConversation()}
          disabled={clearing || messages.length === 0}
          className="w-9 h-9 rounded-xl bg-white/[0.06] flex items-center justify-center text-slate-400 hover:text-rose-300 disabled:opacity-30"
          aria-label="Limpar conversa"
          title="Limpar conversa"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs px-3 py-2.5 flex items-center gap-2 mb-2">
          <WifiOff className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto -mx-4 px-4 space-y-3 pb-4">
        {!loaded ? (
          <p className="text-center text-sm text-slate-500 py-10">Carregando…</p>
        ) : messages.length === 0 ? (
          <div className="text-center py-14 space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.04] flex items-center justify-center mx-auto">
              <AudioLines className="w-6 h-6 text-indigo-300" />
            </div>
            <p className="text-sm text-slate-400">
              Peça, consulte ou dê comandos por texto ou voz.
            </p>
            <p className="text-xs text-slate-500 px-6">
              Ex.: "Quais reuniões tenho amanhã?" ou "Pausa a campanha da
              loja física".
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 ${
                  m.role === 'user'
                    ? 'bg-indigo-500/90 text-white rounded-br-md'
                    : 'bg-white/[0.06] text-slate-200 rounded-bl-md'
                }`}
              >
                {m.audioUri && (
                  <div className="flex items-center gap-2 mb-1">
                    <button
                      onClick={() => togglePlay(m)}
                      className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        m.role === 'user'
                          ? 'bg-white/20 text-white'
                          : 'bg-indigo-500/20 text-indigo-200'
                      }`}
                      aria-label="Reproduzir áudio"
                    >
                      {playingId === m.id ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                    </button>
                    <span className="text-xs opacity-80">
                      {formatAudioDuration(m.audioDurationMs ?? 0)}
                    </span>
                    <audio
                      id={`audio-${m.id}`}
                      src={audioSrc(m.audioUri)}
                      onEnded={() => setPlayingId(null)}
                      className="hidden"
                    />
                  </div>
                )}
                {m.content ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {m.content}
                  </p>
                ) : (
                  <p className="text-xs opacity-70 italic">Mensagem de voz</p>
                )}
                <div
                  className={`mt-1 text-[10px] ${
                    m.role === 'user' ? 'text-white/60' : 'text-slate-500'
                  }`}
                >
                  {formatChatTimestamp(m.createdAt)}
                </div>
              </div>
            </div>
          ))
        )}

        {typing && (
          <div className="flex justify-start">
            <div className="bg-white/[0.06] rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-indigo-300" />
              <span className="flex gap-1">
                {[0, 150, 300].map((d, i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Barra de entrada */}
      <div className="sticky bottom-0 pt-2">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSendText()
              }
            }}
            rows={1}
            placeholder="Comande seu assistente pessoal…"
            className="flex-1 resize-none rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-indigo-500 max-h-32"
          />
          {text.trim() ? (
            <button
              onClick={() => void handleSendText()}
              disabled={typing}
              className="w-11 h-11 rounded-full bg-indigo-500 text-white flex items-center justify-center shrink-0 disabled:opacity-50"
              aria-label="Enviar mensagem"
            >
              <SendIcon />
            </button>
          ) : (
            <div className="shrink-0">
              <VoiceInput
                onSendMessage={handleVoiceSend}
                disabled={typing || !loaded}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )
}
