import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
  Plus,
  Pencil,
  Search,
  Eye,
} from 'lucide-react'
import { Button } from './ui'
import {
  memoryApi,
  categoryLabel,
  normalizeEvidence,
  type MemoryDashboard,
  type MemoryImport,
  type MemoryConversation,
  type MemoryLearning,
  type LearningCategory,
  type LearningStatus,
} from '../lib/api'
import { MEMORY_PATHS, resolveMemoryTabFromPath } from '../lib/routes'

type Tab = 'lotes' | 'conversas' | 'aprendizados'

type LearningFilter = 'all' | 'ativo' | 'inativo' | 'ai' | 'manual' | 'pendente'

interface FileState {
  name: string
  status: 'queued' | 'uploading' | 'done' | 'error'
  detail?: string
}

const STATUS_BADGE: Record<LearningStatus, { label: string; cls: string }> = {
  identificado: { label: 'Identificado', cls: 'text-secondary bg-subtle border-line-2' },
  validado: { label: 'Validado', cls: 'text-accent-300 bg-accent-600/10 border-accent-500/30' },
  ativo: { label: 'Ativo', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  inativo: { label: 'Inativo', cls: 'text-muted bg-subtle border-line-2' },
}

const CATEGORY_CHIP: Record<string, string> = {
  communication_style: 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  opening_patterns: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  discovery_questions: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  value_proposition: 'text-accent-300 bg-accent-600/10 border-accent-500/30',
  objection_handling: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  meeting_transition: 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30',
  follow_up_patterns: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30',
  successful_patterns: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  unsuccessful_patterns: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  common_objections: 'text-orange-300 bg-orange-500/10 border-orange-500/30',
  conversation_patterns: 'text-secondary bg-subtle border-line-2',
}

const OUTCOME_LABEL: Record<string, string> = {
  reuniao: 'Conduzida a reuni├úo',
  sem_interesse: 'Sem interesse',
  interesse: 'Interesse',
}

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  imported: { label: 'Importada', cls: 'text-secondary bg-subtle border-line-2' },
  processing: { label: 'ProcessandoÔÇª', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
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
  saida: 'sa├¡da',
  entrada: 'entrada',
  misto: 'misto',
}

const CATEGORY_OPTIONS: LearningCategory[] = [
  'communication_style',
  'opening_patterns',
  'discovery_questions',
  'value_proposition',
  'objection_handling',
  'meeting_transition',
  'follow_up_patterns',
  'successful_patterns',
  'unsuccessful_patterns',
  'common_objections',
  'conversation_patterns',
]

const FILTER_OPTIONS: { key: LearningFilter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'ativo', label: 'Ativos' },
  { key: 'inativo', label: 'Inativos' },
  { key: 'ai', label: 'Gerados pela IA' },
  { key: 'manual', label: 'Manuais' },
  { key: 'pendente', label: 'Pendentes' },
]

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

interface LearningForm {
  category: LearningCategory
  content: string
  confidence: 'alta' | 'media' | 'baixa'
  performance: 'positivo' | 'negativo' | 'neutro'
  status: LearningStatus
  important: boolean
  evidenceText: string
}

const EMPTY_FORM: LearningForm = {
  category: 'communication_style',
  content: '',
  confidence: 'media',
  performance: 'neutro',
  status: 'identificado',
  important: false,
  evidenceText: '',
}

export function CommercialMemory() {
  const navigate = useNavigate()
  const location = useLocation()
  const tab: Tab = resolveMemoryTabFromPath(location.pathname)

  const [dash, setDash] = useState<MemoryDashboard | null>(null)
  const [imports, setImports] = useState<MemoryImport[]>([])
  const [convs, setConvs] = useState<MemoryConversation[]>([])
  const [learnings, setLearnings] = useState<MemoryLearning[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const processingActive = imports.some((i) => i.status === 'processing')

  const [modal, setModal] = useState<null | { mode: 'create' } | { mode: 'edit'; learning: MemoryLearning }>(null)
  const [form, setForm] = useState<LearningForm>(EMPTY_FORM)
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState<LearningFilter>('all')
  const [query, setQuery] = useState('')
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set())

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
        if (tab === 'conversas') {
          setConvs(await memoryApi.conversations())
        } else if (tab === 'aprendizados') {
          setLearnings(await memoryApi.learnings())
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Falha ao carregar mem├│ria comercial')
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
  }, [tab])

  function switchTab(t: Tab) {
    navigate(t === 'conversas' ? MEMORY_PATHS.conversas : t === 'aprendizados' ? MEMORY_PATHS.aprendizados : MEMORY_PATHS.lotes)
  }

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

  function openCreate() {
    setForm(EMPTY_FORM)
    setModalError('')
    setModal({ mode: 'create' })
  }

  function openEdit(l: MemoryLearning) {
    setForm({
      category: l.category,
      content: l.content,
      confidence: l.confidence,
      performance: l.performance,
      status: l.status,
      important: l.important,
      evidenceText: normalizeEvidence(l.evidence).join('\n'),
    })
    setModalError('')
    setModal({ mode: 'edit', learning: l })
  }

  async function saveLearning() {
    const content = form.content.trim()
    if (!content) {
      setModalError('Escreva o aprendizado (ex.: "Sempre entender o problema antes de apresentar pre├ºo").')
      return
    }
    setSaving(true)
    setModalError('')
    try {
      const evidence = form.evidenceText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10)
      if (modal?.mode === 'create') {
        await memoryApi.createLearning({
          category: form.category,
          content,
          confidence: form.confidence,
          performance: form.performance,
          status: form.status,
          important: form.important,
          ...(evidence.length ? { evidence } : {}),
        })
      } else if (modal?.mode === 'edit' && modal.learning) {
        await memoryApi.updateLearning(modal.learning.id, {
          category: form.category,
          content,
          confidence: form.confidence,
          performance: form.performance,
          status: form.status,
          important: form.important,
          ...(evidence.length ? { evidence } : {}),
        })
      }
      setModal(null)
      await refresh()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Falha ao salvar aprendizado')
    } finally {
      setSaving(false)
    }
  }

  async function onToggleActive(l: MemoryLearning) {
    try {
      await memoryApi.updateLearning(l.id, { status: l.status === 'ativo' ? 'inativo' : 'ativo' })
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

  const filteredLearnings = learnings
    .filter((l) => {
      switch (filter) {
        case 'ativo':
          return l.status === 'ativo'
        case 'inativo':
          return l.status === 'inativo'
        case 'pendente':
          return l.status === 'identificado'
        case 'ai':
          return l.origin === 'ai'
        case 'manual':
          return l.origin === 'manual'
        default:
          return true
      }
    })
    .filter((l) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return (
        l.content.toLowerCase().includes(q) ||
        categoryLabel(l.category).toLowerCase().includes(q) ||
        l.category.toLowerCase().includes(q)
      )
    })

  const inProcessing = Math.max(0, (dash?.conversationsImported ?? 0) - (dash?.conversationsProcessed ?? 0))

  return (
    <div className="h-full overflow-auto rounded-xl border border-line bg-subtle">
      {/* ===== Header ===== */}
      <div className="px-5 py-4 border-b border-line flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <Brain className="w-5 h-5 text-accent-300" />
          <div>
            <div className="text-sm font-semibold">Mem├│ria Comercial da IA</div>
            <div className="text-[11px] text-faint">
              Importe conversas reais e transforme em aprendizados que orientam a IA ÔÇö sem alterar a persona.
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {processingActive && (
            <span className="flex items-center gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2.5 py-1">
              <Loader2 className="w-3 h-3 animate-spin" /> ProcessandoÔÇª
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="primary" onClick={openCreate} size="sm">
            <Plus className="w-3.5 h-3.5" />
            Adicionar aprendizado
          </Button>
          <Button variant="primary" onClick={openImport} disabled={uploading} loading={uploading} size="sm">
            <Upload className="w-3.5 h-3.5" />
            Importar conversas
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-4 px-3 py-2 rounded-xl text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 flex items-center gap-2">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="p-5 space-y-5">
        {/* ===== Stats (n├║meros reais do dashboard) ===== */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Conversas importadas', value: dash?.conversationsImported ?? 0, accent: 'text-fg' },
            { label: 'Processadas', value: dash?.conversationsProcessed ?? 0, accent: 'text-emerald-300' },
            { label: 'Em processamento', value: inProcessing, accent: 'text-amber-300' },
            { label: 'Aprendizados', value: dash?.learnings ?? 0, accent: 'text-accent-300' },
            { label: 'Ativos/validados', value: (dash?.statusCounts.ativo ?? 0) + (dash?.statusCounts.validado ?? 0), accent: 'text-emerald-300' },
            { label: 'Pendentes', value: dash?.statusCounts.identificado ?? 0, accent: 'text-amber-300' },
            { label: 'Padr├Áes extra├¡dos', value: dash?.patterns ?? 0, accent: 'text-sky-300' },
            { label: 'Obje├º├Áes mapeadas', value: dash?.objections ?? 0, accent: 'text-orange-300' },
            { label: 'Estrat├®gias de reuni├úo', value: dash?.meetingStrategies ?? 0, accent: 'text-fuchsia-300' },
            { label: 'Lotes de importa├º├úo', value: dash?.totalImports ?? 0, accent: 'text-fg' },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-line bg-subtle-2 px-3 py-2.5">
              <div className={`text-lg font-semibold leading-tight ${s.accent}`}>{s.value}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-faint">{s.label}</div>
            </div>
          ))}
        </div>

        {/* ===== O que a IA aprendeu ===== */}
        {tab === 'aprendizados' && learnings.length > 0 && (
          <div className="rounded-xl border border-line bg-subtle p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-emerald-300" />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">O que a IA aprendeu</span>
            </div>
            <ul className="space-y-1.5">
              {learnings
                .slice()
                .sort((a, b) => Number(b.important) - Number(a.important))
                .slice(0, 7)
                .map((l) => (
                  <li key={l.id} className="text-xs text-secondary flex gap-2">
                    <ArrowRight className="w-3.5 h-3.5 text-accent-300 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-semibold text-fg">[{categoryLabel(l.category)}]</span>{' '}
                      {l.content}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="text-[10px] text-faint mt-2">
              Padr├Áes validados s├úo injetados no contexto comercial da IA ({learnings.length} no total).
            </p>
          </div>
        )}

        {/* ===== Tabs (rotas reais) ===== */}
        <div className="flex items-center gap-1 border-b border-line pb-1">
          {([
            { key: 'lotes', label: 'Lotes', icon: Database },
            { key: 'conversas', label: 'Conversas', icon: MessageSquareText },
            { key: 'aprendizados', label: 'Aprendizados', icon: Sparkles },
          ] as const).map((t) => {
            const active = tab === t.key
            const Icon = t.icon
            return (
              <button
                key={t.key}
                onClick={() => switchTab(t.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-medium transition ${
                  active ? 'text-fg bg-subtle border border-b-0 border-line-2' : 'text-muted hover:text-fg'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {t.key === 'aprendizados' && learnings.length > 0 && (
                  <span className="ml-0.5 text-[10px] px-1.5 rounded-full bg-accent-600/20 text-accent-300">{learnings.length}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* ===== Lotes ===== */}
        {tab === 'lotes' && (
          <div className="space-y-2">
            {imports.length === 0 && (
              <div className="text-xs text-faint py-6 text-center">Nenhum lote importado ainda. Clique em ÔÇ£Importar conversasÔÇØ.</div>
            )}
            {imports.map((imp) => (
              <div key={imp.id} className="rounded-xl border border-line bg-subtle-2 px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-fg font-medium">{imp.file_name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase text-muted bg-subtle border-line-2">
                      {ORIGIN_LABEL[imp.origin] ?? imp.origin}
                    </span>
                    {imp.status === 'processing' && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-300">
                        <Loader2 className="w-3 h-3 animate-spin" /> {imp.conversations_processed}/{imp.conversations_found}
                      </span>
                    )}
                    {imp.status === 'done' && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                        <CheckCircle2 className="w-3 h-3" /> conclu├¡do
                      </span>
                    )}
                    {imp.status === 'failed' && (
                      <span className="flex items-center gap-1 text-[10px] text-rose-300">
                        <TriangleAlert className="w-3 h-3" /> falhou
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-faint mt-0.5">
                    {imp.conversations_found} conversas ┬À {imp.learnings_generated} aprendizados
                    {imp.failures > 0 ? ` ┬À ${imp.failures} falhas` : ''} ┬À {new Date(imp.created_at).toLocaleString('pt-BR')}
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() => void onDeleteImport(imp.id, imp.file_name)}
                  size="sm"
                  title="Excluir lote"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* ===== Conversas ===== */}
        {tab === 'conversas' && (
          <div className="space-y-2">
            {convs.length === 0 && <div className="text-xs text-faint py-6 text-center">Nenhuma conversa importada.</div>}
            {convs.map((c) => {
              const st = STATUS_TEXT[c.status] ?? STATUS_TEXT.imported
              return (
                <div key={c.id} className="rounded-xl border border-line bg-subtle-2 px-4 py-3 flex flex-wrap items-center gap-3">
                  <MessageSquareText className="w-4 h-4 text-accent-300 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-fg font-medium truncate">
                        {c.contact_name ?? c.source_file ?? 'Conversa'}
                      </span>
                      {c.outcome && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30">
                          {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                        </span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
                    </div>
                    <div className="text-[11px] text-faint mt-0.5">
                      {c.messages_count} mensagens ┬À {c.direction ? (DIRECTION_LABEL[c.direction] ?? c.direction) : 'ÔÇö'}
                      {c.source_file ? ` ┬À ${c.source_file}` : ''} ┬À {new Date(c.created_at).toLocaleString('pt-BR')}
                    </div>
                    {c.status === 'failed' && (
                      <div className="text-[10px] text-rose-300 mt-0.5">{c.error_message ?? 'falha na an├ílise'}</div>
                    )}
                  </div>
                  <button
                    onClick={() => void onReprocess(c.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition"
                    title="Reanalisar conversa (gera ou atualiza aprendizados, sem duplicar)"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Reanalisar
                  </button>
                  <button
                    onClick={() => void onDeleteConversation(c.id)}
                    className="p-2 rounded-xl text-faint hover:text-rose-300 hover:bg-rose-500/10 transition"
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
          <div className="space-y-3">
            {/* Filtros + busca */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-subtle-2 border border-line text-muted">
                <Search className="w-3.5 h-3.5 shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar por t├¡tulo, conte├║do ou categoriaÔÇª"
                  className="bg-transparent outline-none text-xs text-fg placeholder-slate-500 w-52"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {FILTER_OPTIONS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
                      filter === f.key
                        ? 'bg-accent-600/20 text-accent-200 border-accent-500/40'
                        : 'text-muted border-line-2 hover:text-fg'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <span className="ml-auto text-[11px] text-faint">{filteredLearnings.length} de {learnings.length}</span>
            </div>

            {learnings.length === 0 && (
              <div className="text-xs text-faint py-6 text-center">
                Nenhum aprendizado ainda. Importe conversas para a IA extrair padr├Áes ou use ÔÇ£+ Adicionar aprendizadoÔÇØ.
              </div>
            )}
            {filteredLearnings.length === 0 && learnings.length > 0 && (
              <div className="text-xs text-faint py-6 text-center">Nenhum aprendizado corresponde ao filtro/busca.</div>
            )}
            {filteredLearnings.map((l) => {
              const badge = STATUS_BADGE[l.status]
              const chip = CATEGORY_CHIP[l.category] ?? CATEGORY_CHIP.conversation_patterns
              const evidence = normalizeEvidence(l.evidence)
              const expanded = expandedEvidence.has(l.id)
              return (
                <div key={l.id} className="rounded-xl border border-line bg-subtle-2 px-4 py-3 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${chip}`}>{categoryLabel(l.category)}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                          l.origin === 'manual'
                            ? 'text-sky-300 bg-sky-500/10 border-sky-500/30'
                            : 'text-violet-300 bg-violet-500/10 border-violet-500/30'
                        }`}
                      >
                        {l.origin === 'manual' ? 'Manual' : 'Gerado pela IA'}
                      </span>
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
                              : 'text-muted bg-subtle border-line-2'
                        }`}
                      >
                        confian├ºa {l.confidence}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-fg leading-snug">{l.content}</p>
                    {evidence.length > 0 ? (
                      <div className="mt-1.5">
                        <button
                          onClick={() =>
                            setExpandedEvidence((prev) => {
                              const next = new Set(prev)
                              if (next.has(l.id)) next.delete(l.id)
                              else next.add(l.id)
                              return next
                            })
                          }
                          className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-faint hover:text-accent-300 transition"
                        >
                          <Eye className="w-3 h-3" />
                          {evidence.length === 1 ? '1 evid├¬ncia' : `${evidence.length} evid├¬ncias`}
                        </button>
                        {(expanded || evidence.length <= 2) && (
                          <div className="mt-1 space-y-1">
                            {(expanded ? evidence : evidence.slice(0, 2)).map((e, i) => (
                              <div key={i} className="text-[11px] text-muted bg-subtle border border-line rounded-md px-2 py-1">
                                ÔÇ£{e}ÔÇØ
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1.5 text-[10px] text-slate-600">Evid├¬ncia n├úo dispon├¡vel</div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button
                      onClick={() => void onToggleImportant(l)}
                      className={`p-1.5 rounded-xl transition ${l.important ? 'text-amber-300 bg-amber-500/15' : 'text-faint hover:text-amber-300 hover:bg-subtle'}`}
                      title={l.important ? 'Desmarcar importante' : 'Marcar importante'}
                    >
                      <Star className="w-4 h-4" fill={l.important ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      onClick={() => openEdit(l)}
                      className="p-1.5 rounded-xl text-faint hover:text-fg hover:bg-subtle transition"
                      title="Editar aprendizado"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => void onToggleActive(l)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-xl text-[11px] border transition ${
                        l.status === 'ativo'
                          ? 'text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10'
                          : 'text-muted border-line-2 hover:text-fg hover:bg-subtle'
                      }`}
                      title={l.status === 'ativo' ? 'Desativar (n├úo entra na mem├│ria)' : 'Ativar (entra na mem├│ria comercial)'}
                    >
                      <Clock className="w-3 h-3" /> {l.status === 'ativo' ? 'Desativar' : 'Ativar'}
                    </button>
                    <button
                      onClick={() => void onDeleteLearning(l.id)}
                      className="p-1.5 rounded-xl text-faint hover:text-rose-300 hover:bg-rose-500/10 transition"
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

      {/* ===== Modal de importa├º├úo ===== */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !uploading && setImportOpen(false)}>
          <div
            className="w-full max-w-xl rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-semibold flex items-center gap-2">
                  <Upload className="w-4 h-4 text-accent-300" />
                  Importar conversas
                </div>
                <div className="text-xs text-muted mt-0.5">
                  Aceita .txt (exporta├º├úo do WhatsApp), .csv e .zip com v├írios arquivos. At├® 100MB por arquivo.
                </div>
              </div>
              <button
                onClick={() => !uploading && setImportOpen(false)}
                disabled={uploading}
                className="text-muted hover:text-fg"
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
                dragOver ? 'border-accent-400 bg-accent-500/5' : 'border-line-2 hover:border-line-strong'
              }`}
            >
              <FileUp className="w-8 h-8 text-faint mb-2" />
              <div className="text-sm text-secondary">Arraste aqui ou clique para selecionar</div>
              <div className="text-[11px] text-faint mt-1">Voc├¬ pode enviar v├írios arquivos de uma vez</div>
            </div>

            {fileList.length > 0 && (
              <div className="mt-4 space-y-1.5">
                {fileList.map((f) => (
                  <div key={f.name} className="flex items-center gap-2 text-xs">
                    {f.status === 'uploading' && <Loader2 className="w-3.5 h-3.5 text-amber-300 animate-spin" />}
                    {f.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />}
                    {f.status === 'error' && <TriangleAlert className="w-3.5 h-3.5 text-rose-300" />}
                    {f.status === 'queued' && <Clock className="w-3.5 h-3.5 text-faint" />}
                    <span className="truncate text-secondary flex-1">{f.name}</span>
                    <span className="text-faint shrink-0">
                      {f.status === 'uploading' && 'enviandoÔÇª'}
                      {f.status === 'done' && 'importado'}
                      {f.status === 'error' && (f.detail ?? 'erro')}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <p className="text-[10px] text-faint">
                As conversas s├úo analisadas em background automaticamente. Os aprendizados ficam como ÔÇ£IdentificadosÔÇØ ÔÇö voc├¬ decide o que ativar.
              </p>
<Button
                onClick={() => !uploading && setImportOpen(false)}
                disabled={uploading}
                loading={uploading}
              >
                {uploading ? 'Importando…' : 'Concluir'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Modal de aprendizado (criar/editar) ===== */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !saving && setModal(null)}>
          <div
            className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-semibold flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-300" />
                  {modal.mode === 'create' ? 'Adicionar aprendizado' : 'Editar aprendizado'}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {modal.mode === 'edit' && modal.learning
                    ? `Origem: ${modal.learning.origin === 'manual' ? 'Manual' : 'Gerado pela IA'}`
                    : 'Conhecimento manual que orientar├í a IA.'}
                </div>
              </div>
              <button onClick={() => !saving && setModal(null)} className="text-muted hover:text-fg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-muted mb-1">Aprendizado *</label>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  rows={3}
                  placeholder="Ex.: Sempre entender o problema antes de apresentar pre├ºo"
                  className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500 text-fg"
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted mb-1">Categoria</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value as LearningCategory })}
                    className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500 text-fg"
                  >
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c} value={c}>{categoryLabel(c)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Confian├ºa</label>
                  <select
                    value={form.confidence}
                    onChange={(e) => setForm({ ...form, confidence: e.target.value as LearningForm['confidence'] })}
                    className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500 text-fg"
                  >
                    <option value="alta">Alta</option>
                    <option value="media">M├®dia</option>
                    <option value="baixa">Baixa</option>
                  </select>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted mb-1">Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as LearningStatus })}
                    className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500 text-fg"
                  >
                    <option value="identificado">Identificado (pendente)</option>
                    <option value="validado">Validado</option>
                    <option value="ativo">Ativo (na mem├│ria)</option>
                    <option value="inativo">Inativo</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Performance</label>
                  <select
                    value={form.performance}
                    onChange={(e) => setForm({ ...form, performance: e.target.value as LearningForm['performance'] })}
                    className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500 text-fg"
                  >
                    <option value="neutro">Neutro</option>
                    <option value="positivo">Funcionou</option>
                    <option value="negativo">Recusa</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Evid├¬ncias (opcional ÔÇö uma por linha)</label>
                <textarea
                  value={form.evidenceText}
                  onChange={(e) => setForm({ ...form, evidenceText: e.target.value })}
                  rows={3}
                  placeholder={'Trecho 1\nTrecho 2'}
                  className="w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-500 text-fg"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.important}
                  onChange={(e) => setForm({ ...form, important: e.target.checked })}
                  className="accent-emerald-500"
                />
                Marcar como importante
              </label>
              <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.status === 'ativo'}
                  onChange={(e) => setForm({ ...form, status: e.target.checked ? 'ativo' : 'inativo' })}
                  className="accent-emerald-500"
                />
                Usar na mem├│ria comercial
              </label>

              {modalError && (
                <div className="text-xs text-rose-300 bg-rose-500/10 rounded-xl px-3 py-2">{modalError}</div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => !saving && setModal(null)}
                  disabled={saving}
                  className="px-4 py-2 rounded-xl text-sm text-muted hover:text-fg transition disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => void saveLearning()}
                  disabled={saving}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium text-white transition"
                >
                  {saving ? <span className="inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> SalvandoÔÇª</span> : 'Salvar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
