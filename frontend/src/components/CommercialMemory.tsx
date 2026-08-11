import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Brain,
  RefreshCw,
  Loader2,
  Upload,
  X,
  Trash2,
  RotateCcw,
  Star,
  MessageSquareText,
  Sparkles,
  Database,
  TriangleAlert,
  CheckCircle2,
  Clock,
  ArrowRight,
  FileUp,
} from 'lucide-react'
import {
  memoryApi,
  categoryLabel,
  type MemoryDashboard,
  type MemoryImport,
  type MemoryConversation,
  type MemoryLearning,
  type LearningStatus,
} from '../lib/api'

type Tab = 'imports' | 'conversas' | 'aprendizados'

interface FileState {
  name: string
  status: 'queued' | 'uploading' | 'done' | 'error'
  detail?: string
}

const STATUS_BADGE: Record<LearningStatus, { label: string; cls: string }> = {
  identificado: { label: 'Identificado', cls: 'text-slate-300 bg-white/5 border-white/10' },
  validado: { label: 'Validado', cls: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30' },
  ativo: { label: 'Ativo', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  inativo: { label: 'Inativo', cls: 'text-slate-400 bg-white/5 border-white/10' },
}

const NEXT_STATUS: Record<LearningStatus, LearningStatus> = {
  identificado: 'validado',
  validado: 'ativo',
  ativo: 'inativo',
  inativo: 'identificado',
}

const CATEGORY_CHIP: Record<string, string> = {
  communication_style: 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  opening_patterns: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  discovery_questions: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  value_proposition: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30',
  objection_handling: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  meeting_transition: 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30',
  follow_up_patterns: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30',
  successful_patterns: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  unsuccessful_patterns: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  common_objections: 'text-orange-300 bg-orange-500/10 border-orange-500/30',
  conversation_patterns: 'text-slate-300 bg-white/5 border-white/10',
}

const OUTCOME_LABEL: Record<string, string> = {
  reuniao: 'Conduzida a reunião',
  sem_interesse: 'Sem interesse',
  interesse: 'Interesse',
}

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  imported: { label: 'Importada', cls: 'text-slate-300 bg-white/5 border-white/10' },
  processing: { label: 'Processando…', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  processed: { label: 'Processada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  failed: { label: 'Falhou', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
}

const ORIGIN_LABEL: Record<string, string> = {
  zip: 'ZIP',
  txt: 'TXT',
  csv: 'CSV',
  arquivo: 'Arquivo',
}

const DIRECTION_LABEL: Record<string, string> = {
  saida: 'saída',
  entrada: 'entrada',
  misto: 'misto',
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_UPLOAD_MB = 100

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'))
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer
      const bytes = new Uint8Array(buf)
      let bin = ''
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      resolve(btoa(bin))
    }
    reader.readAsArrayBuffer(file)
  })
}

export function CommercialMemory() {
  const [dash, setDash] = useState<MemoryDashboard | null>(null)
  const [imports, setImports] = useState<MemoryImport[]>([])
  const [convs, setConvs] = useState<MemoryConversation[]>([])
  const [learnings, setLearnings] = useState<MemoryLearning[]>([])
  const [tab, setTab] = useState<Tab>('imports')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const processingActive = imports.some((i) => i.status === 'processing')

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true)
      setError('')
      try {
        const [d, imb] = await Promise.all([
          memoryApi.dashboard(),
          memoryApi.imports().catch(() => [] as MemoryImport[]),
        ])
        setDash(d)
        setImports(imb)
        if (!opts?.silent) {
          if (tab === 'conversas') {
            setConvs(await memoryApi.conversations())
          } else if (tab === 'aprendizados') {
            setLearnings(await memoryApi.learnings())
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Falha ao carregar memória comercial')
      } finally {
        if (!opts?.silent) setLoading(false)
      }
    },
    [tab],
  )

  // Polling: enquanto houver lote em processamento, atualiza silenciosamente.
  useEffect(() => {
    if (!processingActive) return
    const t = window.setInterval(() => void refresh({ silent: true }), 2500)
    return () => window.clearInterval(t)
  }, [processingActive, refresh])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openImport() {
    setImportOpen(true)
    setFileStates({})
    window.setTimeout(() => fileInputRef.current?.click(), 50)
  }

  function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return
    const states: Record<string, FileState> = {}
    for (const f of list) {
      states[f.name] = { name: f.name, status: 'queued' }
    }
    setFileStates((prev) => ({ ...prev, ...states }))
    void runImports(list)
  }

  async function runImports(files: File[]) {
    setUploading(true)
    try {
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          setFileStates((prev) => ({
            ...prev,
            [file.name]: {
              name: file.name,
              status: 'error',
              detail: `Arquivo de ${(file.size / 1024 / 1024).toFixed(1)}MB excede o limite de ${MAX_UPLOAD_MB}MB. Separe em arquivos menores.`,
            },
          }))
          continue
        }
        setFileStates((prev) => ({ ...prev, [file.name]: { name: file.name, status: 'uploading' } }))
        try {
          const isZip = /\.zip$/i.test(file.name)
          const content = isZip ? await fileToBase64(file) : await file.text()
          await memoryApi.import(file.name, content, 'auto')
          setFileStates((prev) => ({ ...prev, [file.name]: { name: file.name, status: 'done' } }))
        } catch (err) {
          setFileStates((prev) => ({
            ...prev,
            [file.name]: {
              name: file.name,
              status: 'error',
              detail: err instanceof Error ? err.message : 'Falha no upload',
            },
          }))
        }
      }
      await refresh()
    } finally {
      setUploading(false)
    }
  }

  async function onDeleteImport(id: string, name: string) {
    if (!window.confirm(`Excluir o lote "${name}" e todos os aprendizados dele?`)) return
    try {
      await memoryApi.deleteImport(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao excluir lote')
    }
  }

  async function onDeleteConversation(id: string) {
    if (!window.confirm('Excluir esta conversa e os aprendizados ligados a ela?')) return
    try {
      await memoryApi.deleteConversation(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao excluir conversa')
    }
  }

  async function onReprocess(id: string) {
    try {
      await memoryApi.reprocessConversation(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao reprocessar conversa')
    }
  }

  async function onToggleStatus(l: MemoryLearning) {
    try {
      await memoryApi.updateLearning(l.id, { status: NEXT_STATUS[l.status] })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao atualizar aprendizado')
    }
  }

  async function onToggleImportant(l: MemoryLearning) {
    try {
      await memoryApi.updateLearning(l.id, { important: !l.important })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao marcar aprendizado')
    }
  }

  async function onDeleteLearning(id: string) {
    if (!window.confirm('Remover este aprendizado?')) return
    try {
      await memoryApi.deleteLearning(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao remover aprendizado')
    }
  }

  const fileList = Object.values(fileStates)

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02]">
      {/* ===== Header ===== */}
      <div className="px-5 py-4 border-b border-white/5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <Brain className="w-5 h-5 text-indigo-300" />
          <div>
            <div className="text-sm font-semibold">Memória Comercial da IA</div>
            <div className="text-[11px] text-slate-500">
              Importe conversas reais e transforme em aprendizados que orientam a IA — sem alterar a persona.
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {processingActive && (
            <span className="flex items-center gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2.5 py-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Processando…
            </span>
          )}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-40 transition"
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={openImport}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white disabled:opacity-50 transition"
          >
            <Upload className="w-3.5 h-3.5" />
            Importar conversas
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-4 px-3 py-2 rounded-lg text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 flex items-center gap-2">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="p-5 space-y-5">
        {/* ===== Stats ===== */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Conversas importadas', value: dash?.conversationsImported ?? 0, accent: 'text-slate-200' },
            { label: 'Processadas', value: dash?.conversationsProcessed ?? 0, accent: 'text-emerald-300' },
            { label: 'Aprendizados', value: dash?.learnings ?? 0, accent: 'text-indigo-300' },
            { label: 'Padrões extraídos', value: dash?.patterns ?? 0, accent: 'text-sky-300' },
            { label: 'Objeções mapeadas', value: dash?.objections ?? 0, accent: 'text-amber-300' },
            { label: 'Estratégias de reunião', value: dash?.meetingStrategies ?? 0, accent: 'text-fuchsia-300' },
            { label: 'Ativos/validados', value: (dash?.statusCounts.ativo ?? 0) + (dash?.statusCounts.validado ?? 0), accent: 'text-emerald-300' },
            { label: 'Lotes de importação', value: dash?.totalImports ?? 0, accent: 'text-slate-200' },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
              <div className={`text-lg font-semibold leading-tight ${s.accent}`}>{s.value}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>

        {/* ===== O que a IA aprendeu ===== */}
        {learnings.length > 0 && (
          <div className="rounded-lg border border-white/5 bg-black/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-emerald-300" />
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">O que a IA aprendeu</span>
            </div>
            <ul className="space-y-1.5">
              {learnings
                .slice()
                .sort((a, b) => Number(b.important) - Number(a.important))
                .slice(0, 7)
                .map((l) => (
                  <li key={l.id} className="text-xs text-slate-300 flex gap-2">
                    <ArrowRight className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-semibold text-slate-200">[{categoryLabel(l.category)}]</span>{' '}
                      {l.content}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="text-[10px] text-slate-500 mt-2">
              Padrões validados são injetados no contexto comercial da IA ({learnings.length} no total).
            </p>
          </div>
        )}

        {/* ===== Tabs ===== */}
        <div className="flex items-center gap-1 border-b border-white/5 pb-1">
          {([
            { key: 'imports', label: 'Lotes', icon: Database },
            { key: 'conversas', label: 'Conversas', icon: MessageSquareText },
            { key: 'aprendizados', label: 'Aprendizados', icon: Sparkles },
          ] as const).map((t) => {
            const active = tab === t.key
            const Icon = t.icon
            return (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key)
                  void refresh()
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-medium transition ${
                  active ? 'text-white bg-white/5 border border-b-0 border-white/10' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {t.key === 'aprendizados' && learnings.length > 0 && (
                  <span className="ml-0.5 text-[10px] px-1.5 rounded-full bg-indigo-500/20 text-indigo-300">{learnings.length}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* ===== Lotes ===== */}
        {tab === 'imports' && (
          <div className="space-y-2">
            {imports.length === 0 && (
              <div className="text-xs text-slate-500 py-6 text-center">Nenhum lote importado ainda. Clique em “Importar conversas”.</div>
            )}
            {imports.map((imp) => (
              <div key={imp.id} className="rounded-lg border border-white/5 bg-black/20 px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-slate-200 font-medium">{imp.file_name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase text-slate-400 bg-white/5 border-white/10">
                      {ORIGIN_LABEL[imp.origin] ?? imp.origin}
                    </span>
                    {imp.status === 'processing' && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-300">
                        <Loader2 className="w-3 h-3 animate-spin" /> {imp.conversations_processed}/{imp.conversations_found}
                      </span>
                    )}
                    {imp.status === 'done' && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                        <CheckCircle2 className="w-3 h-3" /> concluído
                      </span>
                    )}
                    {imp.status === 'failed' && (
                      <span className="flex items-center gap-1 text-[10px] text-rose-300">
                        <TriangleAlert className="w-3 h-3" /> falhou
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {imp.conversations_found} conversas · {imp.learnings_generated} aprendizados
                    {imp.failures > 0 ? ` · ${imp.failures} falhas` : ''} · {new Date(imp.created_at).toLocaleString('pt-BR')}
                  </div>
                </div>
                <button
                  onClick={() => void onDeleteImport(imp.id, imp.file_name)}
                  className="p-2 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
                  title="Excluir lote"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ===== Conversas ===== */}
        {tab === 'conversas' && (
          <div className="space-y-2">
            {convs.length === 0 && <div className="text-xs text-slate-500 py-6 text-center">Nenhuma conversa importada.</div>}
            {convs.map((c) => {
              const st = STATUS_TEXT[c.status] ?? STATUS_TEXT.imported
              return (
                <div key={c.id} className="rounded-lg border border-white/5 bg-black/20 px-4 py-3 flex flex-wrap items-center gap-3">
                  <MessageSquareText className="w-4 h-4 text-indigo-300 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-slate-200 font-medium truncate">
                        {c.contact_name ?? c.source_file ?? 'Conversa'}
                      </span>
                      {c.outcome && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30">
                          {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                        </span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {c.messages_count} mensagens · {c.direction ? (DIRECTION_LABEL[c.direction] ?? c.direction) : '—'}
                      {c.source_file ? ` · ${c.source_file}` : ''} · {new Date(c.created_at).toLocaleString('pt-BR')}
                    </div>
                    {c.status === 'failed' && (
                      <div className="text-[10px] text-rose-300 mt-0.5">{c.error_message ?? 'falha na análise'}</div>
                    )}
                  </div>
                  {c.status === 'failed' && (
                    <button
                      onClick={() => void onReprocess(c.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Reprocessar
                    </button>
                  )}
                  <button
                    onClick={() => void onDeleteConversation(c.id)}
                    className="p-2 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
                    title="Excluir conversa"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* ===== Aprendizados ===== */}
        {tab === 'aprendizados' && (
          <div className="space-y-2">
            {learnings.length === 0 && (
              <div className="text-xs text-slate-500 py-6 text-center">
                Nenhum aprendizado ainda. Importe conversas para a IA extrair padrões.
              </div>
            )}
            {learnings.map((l) => {
              const badge = STATUS_BADGE[l.status]
              const chip = CATEGORY_CHIP[l.category] ?? CATEGORY_CHIP.conversation_patterns
              return (
                <div key={l.id} className="rounded-lg border border-white/5 bg-black/20 px-4 py-3 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${chip}`}>{categoryLabel(l.category)}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                      {l.important && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30">
                          importante
                        </span>
                      )}
                      {l.performance !== 'neutro' && (
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                            l.performance === 'positivo'
                              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                              : 'text-rose-300 bg-rose-500/10 border-rose-500/30'
                          }`}
                        >
                          {l.performance === 'positivo' ? 'funcionou' : 'recusa'}
                        </span>
                      )}
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                          l.confidence === 'alta'
                            ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                            : l.confidence === 'media'
                              ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                              : 'text-slate-400 bg-white/5 border-white/10'
                        }`}
                      >
                        confiança {l.confidence}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200 leading-snug">{l.content}</p>
                    {l.evidence.length > 0 && (
                      <div className="mt-1.5 space-y-1">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">Evidências</span>
                        {l.evidence.slice(0, 2).map((e, i) => (
                          <div key={i} className="text-[11px] text-slate-400 bg-white/[0.03] border border-white/5 rounded-md px-2 py-1">
                            “{e}”
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button
                      onClick={() => void onToggleImportant(l)}
                      className={`p-1.5 rounded-lg transition ${l.important ? 'text-amber-300 bg-amber-500/15' : 'text-slate-500 hover:text-amber-300 hover:bg-white/5'}`}
                      title={l.important ? 'Desmarcar importante' : 'Marcar importante'}
                    >
                      <Star className="w-4 h-4" fill={l.important ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      onClick={() => void onToggleStatus(l)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/10 transition"
                      title="Avançar status (identificado → validado → ativo → inativo)"
                    >
                      <Clock className="w-3 h-3" /> {l.status}
                    </button>
                    <button
                      onClick={() => void onDeleteLearning(l.id)}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
                      title="Remover aprendizado"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ===== Modal de importação ===== */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !uploading && setImportOpen(false)}>
          <div
            className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#16161f] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-semibold flex items-center gap-2">
                  <Upload className="w-4 h-4 text-indigo-300" />
                  Importar conversas
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  Aceita .txt (exportação do WhatsApp), .csv e .zip com vários arquivos. Até 100MB por arquivo.
                </div>
              </div>
              <button
                onClick={() => !uploading && setImportOpen(false)}
                disabled={uploading}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.csv,.zip,text/plain,text/csv,application/zip,application/octet-stream"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files)
                e.target.value = ''
              }}
            />

            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                if (e.dataTransfer.files) handleFiles(e.dataTransfer.files)
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl px-6 py-8 flex flex-col items-center justify-center text-center transition cursor-pointer ${
                dragOver ? 'border-indigo-400 bg-indigo-500/5' : 'border-white/10 hover:border-white/20'
              }`}
            >
              <FileUp className="w-8 h-8 text-slate-500 mb-2" />
              <div className="text-sm text-slate-300">Arraste aqui ou clique para selecionar</div>
              <div className="text-[11px] text-slate-500 mt-1">Você pode enviar vários arquivos de uma vez</div>
            </div>

            {fileList.length > 0 && (
              <div className="mt-4 space-y-1.5">
                {fileList.map((f) => (
                  <div key={f.name} className="flex items-center gap-2 text-xs">
                    {f.status === 'uploading' && <Loader2 className="w-3.5 h-3.5 text-amber-300 animate-spin" />}
                    {f.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />}
                    {f.status === 'error' && <TriangleAlert className="w-3.5 h-3.5 text-rose-300" />}
                    {f.status === 'queued' && <Clock className="w-3.5 h-3.5 text-slate-500" />}
                    <span className="truncate text-slate-300 flex-1">{f.name}</span>
                    <span className="text-slate-500 shrink-0">
                      {f.status === 'uploading' && 'enviando…'}
                      {f.status === 'done' && 'importado'}
                      {f.status === 'error' && (f.detail ?? 'erro')}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <p className="text-[10px] text-slate-500">
                Os aprendizados são extraídos em background e ficam como “Identificados” — você decide o que ativar.
              </p>
              <button
                onClick={() => !uploading && setImportOpen(false)}
                disabled={uploading}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium text-white transition"
              >
                {uploading ? 'Importando…' : 'Concluir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}