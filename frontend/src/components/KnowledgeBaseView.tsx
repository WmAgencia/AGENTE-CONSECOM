import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardPaste,
  Copy,
  ExternalLink,
  File as FileIcon,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Image,
  Info,
  Link as LinkIcon,
  Loader2,
  Mic,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  Square,
  SquarePlay,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { supabase, type KbFile, type KbFolder } from '../lib/supabase'
import { validateAudioFile } from '../lib/storage'
import { Button, Modal } from './ui'
import { uploadMedia } from '../lib/storage'

type Kind = KbFile['kind']
type Menu =
  | { type: 'empty'; x: number; y: number }
  | { type: 'folder'; x: number; y: number; folder: KbFolder }
  | { type: 'file'; x: number; y: number; file: KbFile }

type EditorState = {
  file: KbFile | null
  name: string
  kind: Kind
  description: string
  whenToUse: string
  content: string
  source_url: string
  uploading: boolean
  uploadError: string | null
  fileMeta: { name: string; size: number; duration: number } | null
}

type UploadItem = {
  key: string
  name: string
  status: 'uploading' | 'done' | 'error'
  percent: number
  error?: string
}

const KIND_LABEL: Record<Kind, string> = {
  texto: 'Texto',
  readme: 'README',
  link: 'Link',
  documento: 'Documento',
  video: 'Vídeo',
  imagem: 'Imagem',
  audio: 'Áudio',
  youtube: 'YouTube',
}

const CONTENT_PLACEHOLDER: Record<Kind, string> = {
  texto: 'Cole aqui informações confirmadas sobre o produto, serviço, preços, objeções...',
  readme: 'Conteúdo em Markdown...',
  link: 'Anotações sobre o link (o que é, para que serve, quando usar)...',
  youtube: 'Anotações sobre o vídeo (o que mostra, quando enviar)...',
  documento: 'Descrição do documento (opcional)...',
  audio: 'Transcrição ou resumo do áudio...',
  video: 'Descrição do vídeo...',
  imagem: 'Descrição da imagem...',
}

const README_PROMPT = `Você será meu entrevistador para construir uma Base de Conhecimento completa para uma inteligência artificial comercial.

SUA FUNÇÃO NESTA CONVERSA NÃO É GERAR O README IMEDIATAMENTE.

Primeiro, você deverá me entrevistar detalhadamente para compreender completamente minha empresa, produto, serviço, público, processo comercial, posicionamento, comunicação, preços, regras, objeções, diferenciais, limitações, materiais disponíveis e comportamento esperado da IA.

REGRAS DA ENTREVISTA
- Faça todas as perguntas necessárias para eliminar lacunas de informação.
- Não tenha pressa para gerar o documento.
- Faça perguntas complementares sempre que minha resposta for vaga, incompleta ou gerar alguma dúvida.
- Se uma resposta abrir uma nova questão importante, aprofunde antes de seguir. Exemplo: se eu disser "temos um sistema", não pule para a próxima pergunta — pergunte o que exatamente esse sistema faz, depois quais partes dele são mais utilizadas, depois se existe alguma limitação ou problema que os clientes costumam mencionar, e assim por diante.
- Organize a entrevista em blocos para não ficar confusa: Empresa, Produto/Serviço, Público-alvo, Processo comercial, Comunicação, Preços, Objeções, Materiais, Encaminhamento humano, Regras e limitações, Cenários especiais e Revisão final.

A ENTREVISTA DEVE INVESTIGAR, NO MÍNIMO:

1) EMPRESA
Nome; o que a empresa faz; história; posicionamento; região de atuação; público; diferenciais; concorrentes; como deseja ser percebida.

2) PRODUTO/SERVIÇO
O que é; como funciona; para quem serve; problemas que resolve; benefícios; funcionalidades; limitações; o que está incluso; o que não está incluso.

3) PÚBLICO-ALVO
Nicho; perfil do cliente; características; dores; necessidades; desejos; objeções; nível de conhecimento sobre o problema; situação atual.

4) PROCESSO COMERCIAL
Como iniciar uma conversa; objetivo da abordagem; como qualificar; perguntas importantes; como apresentar o produto; quando mostrar materiais; quando enviar áudio; quando enviar vídeo; quando enviar links; quando falar preço; como lidar com objeções; quando marcar reunião; quando encaminhar para humano; quando encerrar.

5) COMUNICAÇÃO
Persona da IA; nome que deve utilizar; tom de voz; formalidade; vocabulário; expressões que pode utilizar; expressões proibidas; uso de emojis; tamanho ideal das mensagens; como adaptar a linguagem ao cliente.

6) PREÇOS
Preço padrão; condições de pagamento; descontos autorizados; limite de negociação; o que a IA pode negociar; o que somente um humano pode negociar; informações que nunca podem ser reveladas.

7) OBJEÇÕES
Pergunte quais são as principais objeções e como devem ser tratadas. Exemplos: está caro; já tenho sistema; não tenho interesse; vou pensar; me manda depois; preciso falar com alguém; quero desconto; quero conhecer antes; não confio; tenho outra solução.

8) ENCAMINHAMENTO HUMANO
Quem é o responsável; quando encaminhar; como comunicar ao lead; o que a IA deve fazer depois do encaminhamento; o que NÃO deve fazer depois do encaminhamento.

9) CONHECIMENTO E MATERIAIS
Pergunte sobre: PDFs, documentos, vídeos, áudios, links, páginas, apresentações, demonstrações, FAQs e materiais comerciais. E principalmente QUANDO cada material deve ser utilizado. Exemplo: "Este vídeo só deve ser enviado depois que o lead demonstrar interesse." Isso é extremamente importante.

10) CENÁRIOS ESPECIAIS
Pergunte sobre situações específicas que a IA pode enfrentar: cliente indevido, pedido de desconto, comparação com concorrente, urgência, cancelamento de reunião, cliente que some no meio da conversa, atendimento fora do horário comercial, etc.

AO FINALIZAR A ENTREVISTA
Revise todas as respostas; identifique possíveis contradições; identifique informações faltantes; faça perguntas adicionais se necessário. SOMENTE depois gere o README.

O README FINAL DEVE SER:
- estruturado; extremamente claro; detalhado; sem informações inventadas; sem assumir informações que não foram fornecidas; organizado por categorias; pronto para ser utilizado como Base de Conhecimento de uma IA comercial.

O README DEVE CONTER, ALÉM DAS SEÇÕES DE CONTEÚDO, AS SEÇÕES OBRIGATÓRIAS:
- FLUXO DE CONVERSA: descreva passo a passo: abordagem → resposta → classificação → apresentação → descoberta → qualificação → valor → materiais → objeções → preço → intenção → encaminhamento/encerramento.
- REGRAS DE DECISÃO: regras objetivas que a IA deve seguir para decidir cada passo do fluxo.
- QUANDO USAR CADA MATERIAL: para cada material, o momento exato de utilizá-lo na conversa.
- QUANDO NÃO USAR CADA MATERIAL: situações em que o material NÃO deve ser enviado.
- INFORMAÇÕES QUE A IA NÃO PODE INVENTAR: preços, prazos, garantias, condições e qualquer informação não confirmada — a IA deve marcar como [CONFIRMAR] e nunca inventar.
- QUANDO ENCAMINHAR PARA HUMANO: condições exatas de encaminhamento, como comunicar ao lead e o que a IA deve fazer (e não fazer) depois do encaminhamento.

O resultado final deve ser um README OPERACIONAL, não apenas uma descrição da empresa.`

const README_DESC_MARKER = '## Descrição'
const README_BODY_MARKER = '## Conteúdo'
const MEDIA_DESC_MARKER = '## Descrição'
const MEDIA_USE_MARKER = '## Quando utilizar'

/** Estilos consistentes dos campos do editor (referência visual Google Drive). */
const FIELD = 'w-full rounded-xl border border-line-2 bg-field px-3 py-2.5 text-sm text-fg placeholder:text-faint outline-none transition-all duration-200 hover:border-line-strong focus:border-accent-500 focus:shadow-glow'
const FIELD_LABEL = 'mb-1.5 block text-xs font-semibold text-secondary'
const NAME_FIELD = 'w-full rounded-xl border-2 border-line-strong bg-field px-3.5 py-3 text-base font-medium text-fg placeholder:text-faint outline-none transition-all duration-200 hover:border-accent-500/60 focus:border-accent-500 focus:shadow-glow'

const EMPTY_EDITOR: EditorState = {
  file: null,
  name: '',
  kind: 'texto',
  description: '',
  whenToUse: '',
  content: '',
  source_url: '',
  uploading: false,
  uploadError: null,
  fileMeta: null,
}

const NEW_MENU: Array<{ kind: Kind; label: string; icon: ReactNode }> = [
  { kind: 'texto', label: 'Texto', icon: <FileText size={14} /> },
  { kind: 'readme', label: 'README', icon: <FileText size={14} /> },
  { kind: 'link', label: 'Link', icon: <LinkIcon size={14} /> },
  { kind: 'documento', label: 'Documento', icon: <FileIcon size={14} /> },
  { kind: 'audio', label: 'Áudio', icon: <Mic size={14} /> },
  { kind: 'video', label: 'Vídeo', icon: <Film size={14} /> },
  { kind: 'imagem', label: 'Imagem', icon: <Image size={14} /> },
  { kind: 'youtube', label: 'YouTube', icon: <SquarePlay size={14} /> },
]

function fileIcon(kind: Kind, size = 22) {
  if (kind === 'link') return <LinkIcon size={size} className="text-sky-300" />
  if (kind === 'youtube') return <SquarePlay size={size} className="text-rose-300" />
  if (kind === 'readme') return <FileText size={size} className="text-amber-300" />
  if (kind === 'documento') return <FileIcon size={size} className="text-indigo-300" />
  if (kind === 'audio') return <Mic size={size} className="text-emerald-300" />
  if (kind === 'video') return <Film size={size} className="text-fuchsia-300" />
  if (kind === 'imagem') return <Image size={size} className="text-lime-300" />
  return <FileText size={size} className="text-accent-300" />
}

function buildReadmeContent(description: string, content: string): string {
  const parts: string[] = []
  if (description.trim()) parts.push(`${README_DESC_MARKER}\n${description.trim()}`)
  if (content.trim()) parts.push(`${README_BODY_MARKER}\n${content.trim()}`)
  return parts.join('\n\n')
}

function parseReadmeContent(content: string): { description: string; body: string } {
  if (!content) return { description: '', body: '' }
  const descIdx = content.indexOf(README_DESC_MARKER)
  const bodyIdx = content.indexOf(README_BODY_MARKER)
  const desc = descIdx >= 0 ? content.slice(descIdx + README_DESC_MARKER.length, bodyIdx >= 0 ? bodyIdx : undefined).trim() : ''
  const body = bodyIdx >= 0 ? content.slice(bodyIdx + README_BODY_MARKER.length).trim() : ''
  return { description: desc, body }
}

function parseStructuredContent(kind: Kind, content: string): { description: string; whenToUse: string; body: string } {
  if (!content) return { description: '', whenToUse: '', body: '' }
  if (kind === 'readme') {
    const parsed = parseReadmeContent(content)
    return { description: parsed.description, whenToUse: '', body: parsed.body }
  }
  if (kind === 'audio' || kind === 'video' || kind === 'youtube') {
    const descIdx = content.indexOf(MEDIA_DESC_MARKER)
    const useIdx = content.indexOf(MEDIA_USE_MARKER)
    if (descIdx < 0 && useIdx < 0) {
      return { description: content.trim(), whenToUse: '', body: '' }
    }
    const description = descIdx >= 0
      ? content.slice(descIdx + MEDIA_DESC_MARKER.length, useIdx >= 0 ? useIdx : undefined).trim()
      : ''
    const whenToUse = useIdx >= 0 ? content.slice(useIdx + MEDIA_USE_MARKER.length).trim() : ''
    return { description, whenToUse, body: '' }
  }
  return { description: content.trim(), whenToUse: '', body: content.trim() }
}

function buildStructuredContent(kind: Kind, editor: Pick<EditorState, 'description' | 'whenToUse' | 'content'>): string | null {
  if (kind === 'readme') return buildReadmeContent(editor.description, editor.content)
  if (kind === 'audio' || kind === 'video' || kind === 'youtube') {
    const parts: string[] = []
    if (editor.description.trim()) parts.push(`${MEDIA_DESC_MARKER}\n${editor.description.trim()}`)
    if (editor.whenToUse.trim()) parts.push(`${MEDIA_USE_MARKER}\n${editor.whenToUse.trim()}`)
    return parts.join('\n\n')
  }
  return editor.content || null
}

function shortDesc(file: KbFile): string {
  if (file.kind === 'readme') return parseReadmeContent(file.content ?? '').description || 'README'
  if (file.kind === 'audio' || file.kind === 'video' || file.kind === 'youtube') {
    const parsed = parseStructuredContent(file.kind, file.content ?? '')
    return parsed.description || file.source_url || KIND_LABEL[file.kind]
  }
  if (file.content) return file.content.replace(/[#>*_`\-]/g, '').trim().slice(0, 90)
  if (file.source_url) return file.source_url
  return KIND_LABEL[file.kind]
}

function inferKind(file: File): Kind {
  const type = file.type.toLowerCase()
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('image/')) return 'imagem'
  return 'documento'
}

function prettyDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

export function KnowledgeBaseView() {
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [files, setFiles] = useState<KbFile[]>([])
  const [campaignCounts, setCampaignCounts] = useState<Map<string, number>>(new Map())
  const [currentFolder, setCurrentFolder] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [newMenu, setNewMenu] = useState(false)
  const [renameItem, setRenameItem] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [renameName, setRenameName] = useState('')
  const [moveItem, setMoveItem] = useState<{ type: 'file' | 'folder'; id: string; name: string; parent: string | null } | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [details, setDetails] = useState<KbFile | null>(null)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [clipSource, setClipSource] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editorDrag, setEditorDrag] = useState(false)
  const [editorProgress, setEditorProgress] = useState(0)
  const [audioSource, setAudioSource] = useState<'upload' | 'record'>('upload')
  const [recState, setRecState] = useState<'idle' | 'requesting' | 'recording'>('idle')
  const [recSeconds, setRecSeconds] = useState(0)
  const [recordedSeconds, setRecordedSeconds] = useState(0)
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null)
  const [recordedFile, setRecordedFile] = useState<File | null>(null)
  const [recordedError, setRecordedError] = useState<string | null>(null)
  const dragRef = useRef<{ type: 'file' | 'folder'; id: string } | null>(null)
  const cancelledRef = useRef<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorFileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recTimerRef = useRef(0)
  const recordedUrlRef = useRef<string | null>(null)
  const noticeTimerRef = useRef(0)
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard
  const clipSourceRef = useRef(clipSource)
  clipSourceRef.current = clipSource
  const currentFolderRef = useRef(currentFolder)
  currentFolderRef.current = currentFolder
  const foldersRef = useRef(folders)
  foldersRef.current = folders
  const filesRef = useRef(files)
  filesRef.current = files

  function flashNotice(message: string) {
    setNotice(message)
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2500)
  }

  async function load() {
    setLoading(true)
    setError(null)
    const [folderResult, fileResult, campaignResult] = await Promise.all([
      supabase.from('kb_folders').select('*').order('name'),
      supabase.from('kb_files').select('*').order('name'),
      supabase.from('campaigns').select('knowledge_base_id'),
    ])
    if (folderResult.error || fileResult.error) {
      setError(folderResult.error?.message ?? fileResult.error?.message ?? 'Não foi possível carregar a base.')
    } else {
      setFolders((folderResult.data ?? []) as KbFolder[])
      setFiles((fileResult.data ?? []) as KbFile[])
    }
    if (campaignResult.error) {
      setCampaignCounts(new Map())
    } else {
      const counts = new Map<string, number>()
      for (const row of (campaignResult.data ?? []) as Array<{ knowledge_base_id: string | null }>) {
        if (row.knowledge_base_id) counts.set(row.knowledge_base_id, (counts.get(row.knowledge_base_id) ?? 0) + 1)
      }
      setCampaignCounts(counts)
    }
    setLoading(false)
  }

  useEffect(() => {
    void load()
    const channel = supabase
      .channel('knowledge-base')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_folders' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_files' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, () => void load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const current = currentFolder ? folderById.get(currentFolder) ?? null : null
  const breadcrumbs = useMemo(() => {
    const result: KbFolder[] = []
    let cursor = current
    while (cursor) {
      result.unshift(cursor)
      cursor = cursor.parent_id ? folderById.get(cursor.parent_id) ?? null : null
    }
    return result
  }, [current, folderById])

  const visibleFolders = useMemo(() => folders.filter((folder) => folder.parent_id === currentFolder && folder.name.toLowerCase().includes(search.toLowerCase())), [folders, currentFolder, search])
  const visibleFiles = useMemo(() => files.filter((file) => file.folder_id === currentFolder && file.name.toLowerCase().includes(search.toLowerCase())), [files, currentFolder, search])

  const flatFolders = useMemo(() => {
    function path(folder: KbFolder): string {
      const parent = folder.parent_id ? folderById.get(folder.parent_id) : null
      return parent ? `${path(parent)} / ${folder.name}` : folder.name
    }
    return folders.map((folder) => ({ ...folder, label: path(folder) }))
  }, [folders, folderById])

  const countsByFolder = useMemo(() => {
    const filesCount = new Map<string, number>()
    const foldersCount = new Map<string, number>()
    for (const file of files) {
      if (file.folder_id) filesCount.set(file.folder_id, (filesCount.get(file.folder_id) ?? 0) + 1)
    }
    for (const folder of folders) {
      if (folder.parent_id) foldersCount.set(folder.parent_id, (foldersCount.get(folder.parent_id) ?? 0) + 1)
    }
    return { filesCount, foldersCount }
  }, [files, folders])

  async function createFolder() {
    const name = newFolderName.trim()
    if (!name) return
    const { error: insertError } = await supabase.from('kb_folders').insert({ name, parent_id: currentFolder })
    if (insertError) setError(insertError.message)
    else {
      setNewFolderName('')
      setNewFolderOpen(false)
      await load()
    }
  }

  function openNewFile(kind: Kind = 'texto') {
    setNewMenu(false)
    setMenu(null)
    setEditor({ ...EMPTY_EDITOR, kind })
  }

  function openFile(file: KbFile) {
    const parsed = parseStructuredContent(file.kind, file.content ?? '')
    setEditor({
      file,
      name: file.name,
      kind: file.kind,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      content: parsed.body,
      source_url: file.source_url ?? '',
      uploading: false,
      uploadError: null,
      fileMeta: null,
    })
  }

  async function saveFile() {
    if (!editor || !editor.name.trim()) return
    const content = buildStructuredContent(editor.kind, editor)
    const payload = {
      name: editor.name.trim(),
      kind: editor.kind,
      content,
      source_url: editor.source_url || null,
      folder_id: editor.file?.folder_id ?? currentFolder,
      updated_at: new Date().toISOString(),
    }
    const result = editor.file
      ? await supabase.from('kb_files').update(payload).eq('id', editor.file.id)
      : await supabase.from('kb_files').insert(payload)
    if (result.error) setError(result.error.message)
    else {
      closeEditor()
      await load()
    }
  }

  async function doRename() {
    if (!renameItem || !renameName.trim()) return
    const table = renameItem.type === 'folder' ? 'kb_folders' : 'kb_files'
    const { error: updateError } = await supabase
      .from(table)
      .update({ name: renameName.trim(), updated_at: new Date().toISOString() })
      .eq('id', renameItem.id)
    if (updateError) setError(updateError.message)
    setRenameItem(null)
    await load()
  }

  async function deleteFolder(folder: KbFolder) {
    setMenu(null)
    if (!window.confirm(`Excluir a pasta "${folder.name}" e todo seu conteúdo?`)) return
    await supabase.from('kb_folders').delete().eq('id', folder.id)
    if (currentFolder === folder.id) setCurrentFolder(folder.parent_id)
    await load()
  }

  async function deleteFile(file: KbFile) {
    setMenu(null)
    if (!window.confirm(`Excluir "${file.name}"?`)) return
    await supabase.from('kb_files').delete().eq('id', file.id)
    await load()
  }

  async function duplicateFile(file: KbFile) {
    setMenu(null)
    await supabase.from('kb_files').insert({
      name: `${file.name} (cópia)`,
      kind: file.kind,
      content: file.content,
      source_url: file.source_url,
      folder_id: file.folder_id,
    })
    await load()
  }

  function descendantsOf(folderId: string): Set<string> {
    const result = new Set<string>()
    const walk = (id: string) => {
      for (const folder of folders) {
        if (folder.parent_id === id && !result.has(folder.id)) {
          result.add(folder.id)
          walk(folder.id)
        }
      }
    }
    walk(folderId)
    return result
  }

  async function moveItemToTarget() {
    if (!moveItem) return
    const target = moveTarget || null
    if (moveItem.type === 'folder' && (target === moveItem.id || descendantsOf(moveItem.id).has(target ?? ''))) {
      setError('Não é possível mover uma pasta para dentro dela mesma.')
      return
    }
    const table = moveItem.type === 'folder' ? 'kb_folders' : 'kb_files'
    const column = moveItem.type === 'folder' ? 'parent_id' : 'folder_id'
    const { error: updateError } = await supabase
      .from(table)
      .update({ [column]: target, updated_at: new Date().toISOString() })
      .eq('id', moveItem.id)
    if (updateError) setError(updateError.message)
    setMoveItem(null)
    await load()
  }

  function copyItem(type: 'file' | 'folder', id: string, name: string) {
    setClipSource({ type, id, name })
    setClipboard({ mode: 'copy', type, id, name })
    flashNotice(`Copiado: ${name} — pressione Ctrl+V para colar.`)
  }

  function cutItem(type: 'file' | 'folder', id: string, name: string) {
    setClipSource({ type, id, name })
    setClipboard({ mode: 'cut', type, id, name })
    flashNotice(`Recortado: ${name} — pressione Ctrl+V para colar.`)
  }

  function clearClipboard() {
    setClipboard(null)
  }

  async function duplicateFolderRecursive(
    sourceId: string,
    parentId: string | null,
    foldersNow: KbFolder[],
    filesNow: KbFile[],
  ): Promise<void> {
    const folder = foldersNow.find((f) => f.id === sourceId)
    if (!folder) return
    const { data: inserted, error } = await supabase.from('kb_folders').insert({ name: `${folder.name} (cópia)`, parent_id: parentId }).select('id')
    if (error || !inserted?.[0]) return
    const newId = inserted[0].id
    for (const child of foldersNow.filter((f) => f.parent_id === sourceId)) {
      await duplicateFolderRecursive(child.id, newId, foldersNow, filesNow)
    }
    for (const file of filesNow.filter((f) => f.folder_id === sourceId)) {
      await supabase.from('kb_files').insert({ name: file.name, kind: file.kind, content: file.content, source_url: file.source_url, folder_id: newId })
    }
  }

  async function pasteClipboard() {
    const clip = clipboardRef.current
    if (!clip) return
    setClipboard(null)
    const targetFolder = currentFolderRef.current
    const foldersNow = foldersRef.current
    const filesNow = filesRef.current
    const descOf = (folderId: string): Set<string> => {
      const result = new Set<string>()
      const walk = (id: string) => {
        for (const folder of foldersNow) {
          if (folder.parent_id === id && !result.has(folder.id)) {
            result.add(folder.id)
            walk(folder.id)
          }
        }
      }
      walk(folderId)
      return result
    }
    try {
      if (clip.mode === 'cut') {
        if (clip.type === 'folder') {
          if (targetFolder === clip.id || descOf(clip.id).has(targetFolder ?? '')) {
            setError('Não é possível mover uma pasta para dentro dela mesma.')
            return
          }
          await supabase.from('kb_folders').update({ parent_id: targetFolder, updated_at: new Date().toISOString() }).eq('id', clip.id)
        } else {
          await supabase.from('kb_files').update({ folder_id: targetFolder, updated_at: new Date().toISOString() }).eq('id', clip.id)
        }
        flashNotice(`Movido: ${clip.name}`)
      } else {
        if (clip.type === 'file') {
          const file = filesNow.find((f) => f.id === clip.id)
          if (file) {
            await supabase.from('kb_files').insert({ name: `${file.name} (cópia)`, kind: file.kind, content: file.content, source_url: file.source_url, folder_id: targetFolder })
          }
        } else {
          await duplicateFolderRecursive(clip.id, targetFolder, foldersNow, filesNow)
        }
        flashNotice(`Duplicado: ${clip.name}`)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível colar.')
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      const src = clipSourceRef.current
      if (key === 'c' && src) {
        setClipboard({ mode: 'copy', ...src })
        flashNotice(`Copiado: ${src.name}`)
      } else if (key === 'x' && src) {
        setClipboard({ mode: 'cut', ...src })
        flashNotice(`Recortado: ${src.name}`)
      } else if (key === 'v' && clipboardRef.current) {
        event.preventDefault()
        void pasteClipboard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function measureAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    audio.preload = 'metadata'
    const done = (value: number) => { URL.revokeObjectURL(url); resolve(value) }
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0)
    audio.onerror = () => done(0)
    audio.src = url
  })
}

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function uploadEditorFile(file: File) {
    if (!editor) return
    const meta = file.type.toLowerCase().startsWith('audio/')
      ? { name: file.name, size: file.size, duration: await measureAudioDuration(file) }
      : { name: file.name, size: file.size, duration: 0 }
    setEditorProgress(0)
    const timer = window.setInterval(() => {
      setEditorProgress((percent) => Math.min(percent + Math.round(Math.random() * 9) + 4, 92))
    }, 300)
    setEditor({ ...editor, uploading: true, uploadError: null, fileMeta: meta })
    const { url, error: uploadError } = await uploadMedia(file)
    window.clearInterval(timer)
    if (uploadError) {
      setEditor({ ...editor, uploading: false, uploadError, fileMeta: meta })
      return
    }
    setEditorProgress(100)
    setEditor({ ...editor, source_url: url, uploading: false, uploadError: null, fileMeta: meta })
  }

  function validateEditorFile(file: File, kind: Kind): string | null {
    if (kind === 'audio') return validateAudioFile(file)
    if (kind === 'video') {
      if (!file.type.toLowerCase().startsWith('video/')) return 'O arquivo precisa ser um vídeo.'
      return null
    }
    if (kind === 'imagem') {
      if (!file.type.toLowerCase().startsWith('image/')) return 'O arquivo precisa ser uma imagem.'
      return null
    }
    if (kind === 'documento') {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase()
      const ok = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'].includes(ext)
        || ['pdf', 'document', 'sheet', 'presentation', 'text/plain', 'text/csv'].some((m) => file.type.toLowerCase().includes(m))
      if (!ok) return 'Formato de documento não suportado. Use PDF, DOCX, XLSX, PPTX, TXT ou CSV.'
      return null
    }
    return null
  }

  function handleEditorFile(file: File) {
    if (!editor) return
    const error = validateEditorFile(file, editor.kind)
    if (error) {
      setEditor({ ...editor, uploadError: error })
      return
    }
    void uploadEditorFile(file)
  }

  function pickEditorFile() {
    if (!editor || !editorFileInputRef.current) return
    editorFileInputRef.current.multiple = false
    editorFileInputRef.current.accept = editor.kind === 'audio' ? 'audio/*,.ogg,.opus' : editor.kind === 'video' ? 'video/*' : editor.kind === 'imagem' ? 'image/*' : ''
    editorFileInputRef.current.onchange = (event) => {
      const target = event.target as HTMLInputElement
      const file = target.files?.[0]
      target.value = ''
      if (file) handleEditorFile(file)
    }
    editorFileInputRef.current.click()
  }

  function removeEditorFile() {
    if (!editor) return
    setEditor({ ...editor, source_url: '', fileMeta: null, uploadError: null })
  }

  async function startRecording() {
    if (!editor || editor.kind !== 'audio') return
    setRecState('requesting')
    setRecordedError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      mediaRecorderRef.current = recorder
      recChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const type = mime || 'audio/webm'
        const blob = new Blob(recChunksRef.current, { type })
        const file = new File([blob], `gravacao-${Date.now()}.webm`, { type })
        setRecordedFile(file)
        setRecordedSeconds(recSeconds)
        const url = URL.createObjectURL(file)
        if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
        recordedUrlRef.current = url
        setRecordedUrl(url)
        setRecState('idle')
        window.clearInterval(recTimerRef.current)
        setRecSeconds(0)
      }
      recorder.start()
      setRecSeconds(0)
      setRecState('recording')
      window.clearInterval(recTimerRef.current)
      recTimerRef.current = window.setInterval(() => setRecSeconds((seconds) => seconds + 1), 1000)
    } catch (err) {
      setRecState('idle')
      setRecordedError('Não foi possível acessar o microfone. Verifique a permissão no navegador e tente novamente.')
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  function cancelRecording() {
    stopRecording()
    mediaRecorderRef.current = null
    window.clearInterval(recTimerRef.current)
    setRecSeconds(0)
    setRecordedSeconds(0)
    setRecState('idle')
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setRecordedUrl(null)
    setRecordedFile(null)
    setRecordedError(null)
  }

  async function saveRecording() {
    if (!editor || !recordedFile) return
    setEditorProgress(0)
    const timer = window.setInterval(() => {
      setEditorProgress((percent) => Math.min(percent + Math.round(Math.random() * 9) + 4, 92))
    }, 300)
    setEditor({ ...editor, uploading: true, uploadError: null, fileMeta: { name: recordedFile.name, size: recordedFile.size, duration: recordedSeconds } })
    const { url, error: uploadError } = await uploadMedia(recordedFile)
    window.clearInterval(timer)
    if (uploadError) {
      setEditor({ ...editor, uploading: false, uploadError })
      return
    }
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setRecordedUrl(null)
    setRecordedFile(null)
    setRecordedSeconds(0)
    setAudioSource('upload')
    setEditorProgress(100)
    setEditor({ ...editor, source_url: url, uploading: false, uploadError: null, fileMeta: { name: recordedFile.name, size: recordedFile.size, duration: recordedSeconds } })
  }

  function closeEditor() {
    stopRecording()
    mediaRecorderRef.current = null
    window.clearInterval(recTimerRef.current)
    setRecSeconds(0)
    setRecordedSeconds(0)
    setRecState('idle')
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setRecordedUrl(null)
    setRecordedFile(null)
    setRecordedError(null)
    setEditorDrag(false)
    setEditorProgress(0)
    setAudioSource('upload')
    setEditor(null)
  }

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      window.clearInterval(recTimerRef.current)
      if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    }
  }, [])

  function triggerUpload() {
    setMenu(null)
    setNewMenu(false)
    fileInputRef.current?.click()
  }

  async function uploadFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList)
    if (!incoming.length) return
    const keyed = incoming.map((file, index) => ({ key: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`, file }))
    setUploads((prev) => [...prev, ...keyed.map(({ key, file }) => ({ key, name: file.name, status: 'uploading' as const, percent: 0 }))])
    for (const { key, file } of keyed) {
      const timer = window.setInterval(() => {
        setUploads((prev) => prev.map((item) => item.key === key && item.status === 'uploading' ? { ...item, percent: Math.min(item.percent + Math.round(Math.random() * 8) + 3, 92) } : item))
      }, 350)
      const { url, error: uploadError } = await uploadMedia(file)
      window.clearInterval(timer)
      if (cancelledRef.current.has(key)) {
        cancelledRef.current.delete(key)
        setUploads((prev) => prev.filter((item) => item.key !== key))
        continue
      }
      if (uploadError) {
        setUploads((prev) => prev.map((item) => item.key === key ? { ...item, status: 'error', percent: 100, error: uploadError } : item))
        continue
      }
      const insertResult = await supabase.from('kb_files').insert({
        name: file.name.replace(/\.[^.]+$/, ''),
        kind: inferKind(file),
        source_url: url,
        content: null,
        folder_id: currentFolder,
      })
      setUploads((prev) => prev.map((item) => item.key === key ? { ...item, status: insertResult.error ? 'error' : 'done', percent: 100, error: insertResult.error?.message } : item))
    }
    await load()
  }

  function cancelUpload(key: string) {
    cancelledRef.current.add(key)
    setUploads((prev) => prev.filter((item) => item.key !== key))
  }

  function clearUploads() {
    setUploads([])
  }

  async function copyReadmePrompt() {
    setMenu(null)
    await navigator.clipboard.writeText(README_PROMPT)
    flashNotice('Prompt de README copiado para a área de transferência.')
  }

  function handleEditorPaste(event: React.ClipboardEvent) {
    if (!editor || editor.kind !== 'imagem') return
    const items = Array.from(event.clipboardData?.items ?? [])
    const imageItem = items.find((item) => item.type.startsWith('image/'))
    const file = imageItem?.getAsFile()
    if (file) {
      event.preventDefault()
      handleEditorFile(file)
    }
  }

  function openContextMenu(event: React.MouseEvent, target: Menu) {
    event.preventDefault()
    event.stopPropagation()
    setNewMenu(false)
    setMenu(target)
    // Registra o item do clique para os atalhos Ctrl+C / Ctrl+X.
    if (target.type === 'folder') setClipSource({ type: 'folder', id: target.folder.id, name: target.folder.name })
    else if (target.type === 'file') setClipSource({ type: 'file', id: target.file.id, name: target.file.name })
  }

  const canDropFolder = (folderId: string): boolean => {
    const dragging = dragRef.current
    if (!dragging) return true
    if (dragging.type === 'folder') return dragging.id !== folderId && !descendantsOf(folderId).has(dragging.id)
    return true
  }

  function handleDropOnFolder(folderId: string) {
    const dragging = dragRef.current
    if (!dragging) return
    if (dragging.type === 'folder') {
      if (dragging.id === folderId || descendantsOf(folderId).has(dragging.id)) return
      void supabase.from('kb_folders').update({ parent_id: folderId, updated_at: new Date().toISOString() }).eq('id', dragging.id).then(() => load())
    } else {
      void supabase.from('kb_files').update({ folder_id: folderId, updated_at: new Date().toISOString() }).eq('id', dragging.id).then(() => load())
    }
    dragRef.current = null
    setDropTarget(null)
  }

  const gridId = `kb-drop-zone-${currentFolder ?? 'root'}`
  const uploadActive = uploads.some((item) => item.status === 'uploading')

  return (
    <div className="h-full overflow-auto px-4 py-5 sm:px-6">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Base de Conhecimento</h1>
            <p className="text-sm text-muted mt-1">Organize fatos, materiais e respostas que a IA pode usar nas campanhas.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void copyReadmePrompt()} icon={<Copy size={14} />}>Copiar prompt para criar README</Button>
            <Button variant="secondary" onClick={() => setNewFolderOpen(true)} icon={<FolderPlus size={14} />}>Nova pasta</Button>
            <div className="relative">
              <Button onClick={() => setNewMenu((value) => !value)} icon={<Plus size={14} />}>Novo</Button>
              {newMenu && <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-line bg-panel p-1 shadow-xl" onClick={() => setNewMenu(false)}>
                {NEW_MENU.map((item) => <button key={item.kind} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => openNewFile(item.kind)}>{item.icon}{item.label}</button>)}
                <div className="my-1 border-t border-line" />
                <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={triggerUpload}><Upload size={14} />Enviar arquivos</button>
              </div>}
            </div>
          </div>
        </div>

        {notice && (
          <div className="rounded-xl bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-300">{notice}</div>
        )}
        {clipboard && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent-500/30 bg-accent-500/10 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2 text-accent-200">
              {clipboard.mode === 'cut' ? <Scissors size={14} className="shrink-0" /> : <Copy size={14} className="shrink-0" />}
              <span className="truncate">
                <strong className="text-fg">{clipboard.name}</strong>
                {clipboard.mode === 'cut' ? ' — Ctrl+V move para a pasta atual' : ' — Ctrl+V duplica na pasta atual'}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void pasteClipboard()}>Colar aqui</Button>
              <button type="button" onClick={clearClipboard} className="rounded p-1 text-muted hover:text-fg" title="Cancelar cópia/recorte">✕</button>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-1 text-sm min-w-0">
              <button className="text-accent-300 hover:text-accent-200" onClick={() => setCurrentFolder(null)}>Minha base</button>
              {breadcrumbs.map((folder) => <span key={folder.id} className="flex items-center gap-1 min-w-0"><ChevronRight size={14} className="text-faint" /><button className="truncate hover:text-fg" onClick={() => setCurrentFolder(folder.id)}>{folder.name}</button></span>)}
            </div>
            <label className="relative w-full sm:w-64">
              <Search size={15} className="absolute left-3 top-2.5 text-faint" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nesta pasta" className="w-full pl-9" />
            </label>
          </div>

          {currentFolder && <button className="mx-4 mt-4 inline-flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setCurrentFolder(current?.parent_id ?? null)}><ArrowLeft size={13} /> Voltar</button>}
          {loading ? <div className="p-8 text-sm text-muted">Carregando base...</div> : error && !error.startsWith('Prompt') ? <div className="m-4 rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div> : null}

          {!loading && !visibleFolders.length && !visibleFiles.length && (
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); void uploadFiles(event.dataTransfer.files) }}
              className="m-4 cursor-pointer rounded-xl border border-dashed border-line p-12 text-center text-sm text-muted transition hover:border-accent-500/50 hover:text-fg"
              onClick={triggerUpload}
            >
              <Upload size={22} className="mx-auto mb-2 text-faint" />
              Esta pasta está vazia.
              <br />Arraste arquivos aqui ou clique para enviar, ou use o menu <strong className="text-fg">Novo</strong>.
            </div>
          )}

          {(visibleFolders.length > 0 || visibleFiles.length > 0) && (
            <div
              id={gridId}
              className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); void uploadFiles(event.dataTransfer.files) }}
              onContextMenu={(event) => openContextMenu(event, { type: 'empty', x: event.clientX, y: event.clientY })}
            >
              {visibleFolders.map((folder) => {
                const fileCount = countsByFolder.filesCount.get(folder.id) ?? 0
                const subCount = countsByFolder.foldersCount.get(folder.id) ?? 0
                const campaignCount = campaignCounts.get(folder.id) ?? 0
                return (
                  <div
                    key={folder.id}
                    draggable
                    onDragStart={() => { dragRef.current = { type: 'folder', id: folder.id } }}
                    onDragEnd={() => { dragRef.current = null; setDropTarget(null) }}
                    onDragOver={(event) => { if (canDropFolder(folder.id)) { event.preventDefault(); setDropTarget(folder.id) } }}
                    onDragLeave={() => setDropTarget((value) => value === folder.id ? null : value)}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDropTarget(null); handleDropOnFolder(folder.id) }}
                    onContextMenu={(event) => openContextMenu(event, { type: 'folder', x: event.clientX, y: event.clientY, folder })}
                    className={`group relative rounded-xl border bg-subtle p-4 transition hover:border-accent-500/50 ${dropTarget === folder.id ? 'border-accent-400 ring-2 ring-accent-400/30' : 'border-line'}`}
                  >
                    <button className="flex w-full items-center gap-3 text-left" onClick={() => { setCurrentFolder(folder.id); setSearch('') }}>
                      <Folder size={25} className="shrink-0 text-amber-300" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{folder.name}</span>
                        <span className="mt-0.5 block text-[11px] text-faint">
                          {fileCount} arquivo{fileCount === 1 ? '' : 's'}{subCount ? ` · ${subCount} pasta${subCount === 1 ? '' : 's'}` : ''}
                          {campaignCount ? ` · ${campaignCount} campanha${campaignCount === 1 ? '' : 's'}` : ''} · {prettyDate(folder.updated_at)}
                        </span>
                      </span>
                    </button>
                    <button title="Mais opções" className="absolute right-2 top-2 rounded p-1.5 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-panel hover:text-fg" onClick={(event) => { event.stopPropagation(); openContextMenu(event, { type: 'folder', x: event.clientX, y: event.clientY, folder }) }}><MoreHorizontal size={14} /></button>
                  </div>
                )
              })}

              {visibleFiles.map((file) => (
                <div
                  key={file.id}
                  draggable
                  onDragStart={() => { dragRef.current = { type: 'file', id: file.id } }}
                  onDragEnd={() => { dragRef.current = null; setDropTarget(null) }}
                  onContextMenu={(event) => openContextMenu(event, { type: 'file', x: event.clientX, y: event.clientY, file })}
                  className="group relative rounded-xl border border-line bg-subtle p-4 transition hover:border-accent-500/50"
                >
                  <button className="flex w-full items-start gap-3 text-left" onClick={() => openFile(file)}>
                    {fileIcon(file.kind)}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{file.name}</span>
                      <span className="mt-1 block text-[11px] text-faint">{shortDesc(file)}</span>
                      <span className="mt-1 block text-[11px] text-faint">{file.usage_count || 0} usos · {KIND_LABEL[file.kind]} · {prettyDate(file.updated_at)}</span>
                    </span>
                  </button>
                  <button title="Mais opções" className="absolute right-2 top-2 rounded p-1.5 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-panel hover:text-fg" onClick={(event) => { event.stopPropagation(); openContextMenu(event, { type: 'file', x: event.clientX, y: event.clientY, file }) }}><MoreHorizontal size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {(uploads.length > 0 || uploadActive) && (
          <div className="rounded-2xl border border-line bg-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Envio de arquivos</h3>
              <Button variant="ghost" size="sm" onClick={clearUploads}>Limpar</Button>
            </div>
            <div className="space-y-2">
              {uploads.map((item) => (
                <div key={item.key} className="flex items-center gap-3 rounded-lg border border-line bg-subtle px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      <span className={item.status === 'error' ? 'text-rose-300' : item.status === 'done' ? 'text-emerald-300' : 'text-muted'}>
                        {item.status === 'uploading' ? `Enviando ${item.percent}%` : item.status === 'done' ? 'Concluído' : item.error ?? 'Erro'}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
                      <div className={`h-full rounded-full transition-all ${item.status === 'error' ? 'bg-rose-400' : 'bg-accent-400'}`} style={{ width: `${item.status === 'uploading' ? item.percent : 100}%` }} />
                    </div>
                  </div>
                  {item.status === 'uploading'
                    ? <button title="Cancelar" className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg" onClick={() => cancelUpload(item.key)}><X size={14} /></button>
                    : item.status === 'done' ? <Check size={14} className="text-emerald-300" /> : <X size={14} className="text-rose-300" />}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.target.files) void uploadFiles(event.target.files); event.target.value = '' }} />
      <input ref={editorFileInputRef} type="file" className="hidden" />

      {menu && (
        <div className="fixed z-50 w-52 rounded-xl border border-line bg-panel p-1 shadow-2xl" style={{ left: Math.min(menu.x, window.innerWidth - 216), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={(event) => event.stopPropagation()}>
          {menu.type === 'folder' && (
            <>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setCurrentFolder(menu.folder.id); setSearch(''); setMenu(null) }}><Folder size={14} />Abrir</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setRenameItem({ type: 'folder', id: menu.folder.id, name: menu.folder.name }); setRenameName(menu.folder.name); setMenu(null) }}><Pencil size={14} />Renomear</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setMoveItem({ type: 'folder', id: menu.folder.id, name: menu.folder.name, parent: menu.folder.parent_id }); setMoveTarget(menu.folder.parent_id ?? ''); setMenu(null) }}><FolderPlus size={14} />Mover</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { copyItem('folder', menu.folder.id, menu.folder.name); setMenu(null) }}><Copy size={14} />Copiar</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { cutItem('folder', menu.folder.id, menu.folder.name); setMenu(null) }}><Scissors size={14} />Recortar</button>
              <div className="my-1 border-t border-line" />
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 hover:bg-rose-500/10" onClick={() => void deleteFolder(menu.folder)}><Trash2 size={14} />Excluir</button>
            </>
          )}
          {menu.type === 'file' && (
            <>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { openFile(menu.file); setMenu(null) }}><Pencil size={14} />Abrir / Editar</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setDetails(menu.file); setMenu(null) }}><Info size={14} />Detalhes</button>
              {menu.file.source_url && <a className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" href={menu.file.source_url} target="_blank" rel="noreferrer" onClick={() => setMenu(null)}><ExternalLink size={14} />Abrir link</a>}
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setRenameItem({ type: 'file', id: menu.file.id, name: menu.file.name }); setRenameName(menu.file.name); setMenu(null) }}><Pencil size={14} />Renomear</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setMoveItem({ type: 'file', id: menu.file.id, name: menu.file.name, parent: menu.file.folder_id }); setMoveTarget(menu.file.folder_id ?? ''); setMenu(null) }}><FolderPlus size={14} />Mover</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => void duplicateFile(menu.file)}><Copy size={14} />Duplicar</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { cutItem('file', menu.file.id, menu.file.name); setMenu(null) }}><Scissors size={14} />Recortar</button>
              <div className="my-1 border-t border-line" />
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 hover:bg-rose-500/10" onClick={() => void deleteFile(menu.file)}><Trash2 size={14} />Excluir</button>
            </>
          )}
          {menu.type === 'empty' && (
            <>
              {clipboard && <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-accent-300 hover:bg-subtle" onClick={() => { setMenu(null); void pasteClipboard() }}><ClipboardPaste size={14} />Colar aqui</button>}
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => setNewFolderOpen(true)}><FolderPlus size={14} />Nova pasta</button>
              {NEW_MENU.map((item) => <button key={item.kind} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => openNewFile(item.kind)}>{item.icon}Novo {item.label}</button>)}
              <div className="my-1 border-t border-line" />
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={triggerUpload}><Upload size={14} />Enviar arquivos</button>
            </>
          )}
        </div>
      )}

      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title="Nova pasta">
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createFolder() }}>
          <input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="Nome da pasta" />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setNewFolderOpen(false)}>Cancelar</Button><Button type="submit">Criar</Button></div>
        </form>
      </Modal>

      <Modal open={!!renameItem} onClose={() => setRenameItem(null)} title={renameItem?.type === 'folder' ? 'Renomear pasta' : 'Renomear arquivo'}>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void doRename() }}>
          <input autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} placeholder="Novo nome" />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setRenameItem(null)}>Cancelar</Button><Button type="submit" icon={<Check size={14} />}>Salvar</Button></div>
        </form>
      </Modal>

      <Modal open={!!editor} onClose={closeEditor} title={editor?.file ? 'Editar arquivo' : 'Novo arquivo'} subtitle={editor ? `Tipo: ${KIND_LABEL[editor.kind]}` : undefined} size="lg">
        {editor && <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void saveFile() }} onPaste={handleEditorPaste}>
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-fg">Nome</label>
            <input autoFocus className={NAME_FIELD} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="Ex.: Preços de implantação" />
            <span className="mt-1.5 block text-[11px] text-faint">Nome do arquivo, exibido na base e usado pela IA como referência.</span>
          </div>

          {editor.kind === 'readme' && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300/30 bg-amber-300/5 px-3 py-2.5">
              <Button type="button" variant="secondary" size="sm" icon={<Copy size={14} />} onClick={() => void copyReadmePrompt()}>Copiar prompt para criar README</Button>
              <span className="text-[11px] text-faint">Cole o prompt no ChatGPT: ele entrevista você e gera o README completo.</span>
            </div>
          )}

          {(editor.kind === 'link' || editor.kind === 'youtube') && (
            <div>
              <label className={FIELD_LABEL}>{editor.kind === 'youtube' ? 'URL do YouTube' : 'URL'}</label>
              <input className={FIELD} value={editor.source_url} onChange={(event) => setEditor({ ...editor, source_url: event.target.value })} placeholder="https://..." />
              <span className="mt-1.5 block text-[11px] text-faint">{editor.kind === 'youtube' ? 'Cole o endereço do vídeo que a IA deve enviar.' : 'Endereço que a IA deve enviar na conversa.'}</span>
            </div>
          )}

          {editor.kind === 'audio' && (
            <div className="space-y-3">
              <div className="flex items-center gap-1 rounded-xl bg-subtle p-1">
                <button type="button" onClick={() => setAudioSource('upload')} className={audioSource === 'upload' ? 'flex-1 rounded-lg bg-panel px-3 py-1.5 text-xs font-semibold text-fg shadow-sm' : 'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:text-fg'}>Enviar arquivo</button>
                <button type="button" onClick={() => setAudioSource('record')} className={audioSource === 'record' ? 'flex-1 rounded-lg bg-panel px-3 py-1.5 text-xs font-semibold text-fg shadow-sm' : 'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:text-fg'}>Gravar áudio</button>
              </div>
              {audioSource === 'upload' ? (
                <>
                  <div className={`relative rounded-xl border-2 border-dashed p-4 text-center transition-colors ${editorDrag ? 'border-accent-500 bg-accent-500/5' : 'border-line-strong hover:border-accent-500/50'} ${editor.uploading ? 'pointer-events-none opacity-60' : ''}`}
                    onDragOver={(event) => { event.preventDefault(); setEditorDrag(true) }}
                    onDragLeave={() => setEditorDrag(false)}
                    onDrop={(event) => { event.preventDefault(); setEditorDrag(false); const file = event.dataTransfer.files?.[0]; if (file) handleEditorFile(file) }}>
                    <div className="flex flex-col items-center gap-2 py-2">
                      {editor.uploading ? <Loader2 size={26} className="animate-spin text-accent-400" /> : <Mic size={26} className="text-muted" />}
                      <p className="text-sm font-medium text-fg">{editor.uploading ? 'Enviando áudio...' : 'Arraste o arquivo aqui'}</p>
                      <p className="text-xs text-muted">ou</p>
                      <Button type="button" variant="secondary" size="sm" icon={<Upload size={14} />} disabled={editor.uploading} onClick={pickEditorFile}>Clique para selecionar</Button>
                      <p className="text-[11px] text-faint">MP3, OGG, WAV, M4A, AAC, AMR ou WebM · até 64 MB</p>
                      {editor.uploading && <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-subtle"><div className="h-full rounded-full bg-accent-500 transition-all duration-300" style={{ width: `${editorProgress}%` }} /></div>}
                    </div>
                  </div>
                  {editor.source_url && (
                    <div className="space-y-2 rounded-xl border border-line bg-panel p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Mic size={16} className="shrink-0 text-emerald-300" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-fg">{editor.fileMeta?.name || editor.name || 'Áudio'}</p>
                            {editor.fileMeta && <p className="text-[11px] text-muted">{formatDuration(editor.fileMeta.duration)} · {formatBytes(editor.fileMeta.size)}</p>}
                          </div>
                        </div>
                        <button type="button" onClick={removeEditorFile} title="Remover áudio" className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-subtle hover:text-rose-300"><X size={15} /></button>
                      </div>
                      <audio controls src={editor.source_url} preload="metadata" className="w-full" />
                    </div>
                  )}
                  <div>
                    <label className={FIELD_LABEL}>Ou informe uma URL (opcional)</label>
                    <input className={FIELD} value={editor.source_url} onChange={(event) => setEditor({ ...editor, source_url: event.target.value })} placeholder="https://..." />
                  </div>
                </>
              ) : (
                <div className="space-y-3 rounded-xl border border-line bg-subtle p-4 text-center">
                  {recState === 'recording' ? (
                    <>
                      <div className="flex items-center justify-center gap-3">
                        <span className="relative flex h-4 w-4"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span><span className="relative inline-flex h-4 w-4 rounded-full bg-rose-500"></span></span>
                        <span className="font-mono text-xl font-semibold text-fg">{formatDuration(recSeconds)}</span>
                      </div>
                      <Button type="button" variant="danger" size="sm" icon={<Square size={14} />} onClick={stopRecording}>Parar gravação</Button>
                    </>
                  ) : recordedUrl ? (
                    <>
                      <Mic size={26} className="mx-auto text-emerald-300" />
                      <p className="text-sm font-medium text-fg">Gravação pronta</p>
                      <audio controls src={recordedUrl} className="mx-auto w-full max-w-sm" />
                      <p className="text-[11px] text-faint">{formatDuration(recordedSeconds)} · pronto para usar</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button type="button" variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={cancelRecording}>Gravar novamente</Button>
                        <Button type="button" size="sm" icon={<Check size={14} />} disabled={editor.uploading} onClick={() => void saveRecording()}>{editor.uploading ? 'Enviando...' : 'Usar este áudio'}</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Mic size={26} className="mx-auto text-muted" />
                      <p className="text-sm font-medium text-fg">Gravar áudio</p>
                      <p className="text-xs text-muted">O navegador vai pedir permissão para usar o microfone.</p>
                      <Button type="button" size="sm" icon={<Mic size={14} />} disabled={recState === 'requesting'} onClick={() => void startRecording()}>{recState === 'requesting' ? 'Solicitando acesso...' : 'Iniciar gravação'}</Button>
                    </>
                  )}
                  {recordedError && <p className="text-xs text-rose-300">{recordedError}</p>}
                </div>
              )}
            </div>
          )}

          {(editor.kind === 'video' || editor.kind === 'imagem' || editor.kind === 'documento') && (
            <div className="space-y-3">
              <div className={`relative rounded-xl border-2 border-dashed p-4 text-center transition-colors ${editorDrag ? 'border-accent-500 bg-accent-500/5' : 'border-line-strong hover:border-accent-500/50'} ${editor.uploading ? 'pointer-events-none opacity-60' : ''}`}
                onDragOver={(event) => { event.preventDefault(); setEditorDrag(true) }}
                onDragLeave={() => setEditorDrag(false)}
                onDrop={(event) => { event.preventDefault(); setEditorDrag(false); const file = event.dataTransfer.files?.[0]; if (file) handleEditorFile(file) }}>
                <div className="flex flex-col items-center gap-2 py-2">
                  {editor.uploading ? <Loader2 size={26} className="animate-spin text-accent-400" /> : <Upload size={26} className="text-muted" />}
                  <p className="text-sm font-medium text-fg">{editor.uploading ? 'Enviando...' : 'Arraste o arquivo aqui'}</p>
                  <p className="text-xs text-muted">ou</p>
                  <Button type="button" variant="secondary" size="sm" icon={<Upload size={14} />} disabled={editor.uploading} onClick={pickEditorFile}>Clique para selecionar</Button>
                  <p className="text-[11px] text-faint">{editor.kind === 'video' ? 'MP4, MOV, WebM etc. · até 65 MB' : editor.kind === 'imagem' ? 'JPG, PNG, GIF ou WebP' : 'PDF, DOCX, XLSX, PPTX, TXT ou CSV'}</p>
                  {editor.uploading && <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-subtle"><div className="h-full rounded-full bg-accent-500 transition-all duration-300" style={{ width: `${editorProgress}%` }} /></div>}
                </div>
              </div>
              {editor.kind === 'imagem' && editor.source_url && (
                <div className="space-y-2 rounded-xl border border-line bg-panel p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-fg">{editor.fileMeta?.name ?? 'Imagem'}</p>
                    <button type="button" onClick={removeEditorFile} title="Remover imagem" className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-subtle hover:text-rose-300"><X size={15} /></button>
                  </div>
                  <img src={editor.source_url} alt="Prévia" className="max-h-52 w-full rounded-lg object-contain bg-subtle" />
                </div>
              )}
              <div>
                <label className={FIELD_LABEL}>Ou informe uma URL (opcional)</label>
                <input className={FIELD} value={editor.source_url} onChange={(event) => setEditor({ ...editor, source_url: event.target.value })} placeholder="https://..." />
              </div>
            </div>
          )}

          {editor.kind === 'readme' && (
            <div>
              <label className={FIELD_LABEL}>Descrição</label>
              <textarea rows={2} className={FIELD} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="Resumo curto do que este README contém (aparece no card e como contexto para a IA)." />
            </div>
          )}

          {(editor.kind === 'audio' || editor.kind === 'video' || editor.kind === 'youtube') && (
            <>
              <div>
                <label className={FIELD_LABEL}>Descrição</label>
                <textarea rows={2} className={FIELD} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="O que é este material e o que ele mostra." />
              </div>
              <div>
                <label className={FIELD_LABEL}>Quando utilizar</label>
                <textarea rows={2} className={FIELD} value={editor.whenToUse} onChange={(event) => setEditor({ ...editor, whenToUse: event.target.value })} placeholder="Ex.: Enviar somente depois que o lead demonstrar interesse." />
                <span className="mt-1.5 block text-[11px] text-faint">O momento exato em que a IA deve enviar este material.</span>
              </div>
            </>
          )}

          {(editor.kind === 'link' || editor.kind === 'documento' || editor.kind === 'imagem') && (
            <div>
              <label className={FIELD_LABEL}>Descrição</label>
              <textarea rows={3} className={FIELD} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} placeholder={CONTENT_PLACEHOLDER[editor.kind]} />
            </div>
          )}

          {(editor.kind === 'texto' || editor.kind === 'readme') && (
            <div>
              <label className={FIELD_LABEL}>{editor.kind === 'readme' ? 'Conteúdo (Markdown)' : 'Conteúdo'}</label>
              <textarea rows={14} className={FIELD} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} placeholder={CONTENT_PLACEHOLDER[editor.kind]} />
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-line pt-4"><Button type="button" variant="secondary" onClick={closeEditor}>Cancelar</Button><Button type="submit" icon={<Check size={14} />}>Salvar</Button></div>
        </form>}
      </Modal>

      <Modal open={!!moveItem} onClose={() => setMoveItem(null)} title={moveItem?.type === 'folder' ? 'Mover pasta' : 'Mover arquivo'}>
        <div className="space-y-4">
          <p className="text-sm text-muted">Escolha a pasta de destino para <strong className="text-fg">{moveItem?.name}</strong>.</p>
          <select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
            <option value="">Minha base</option>
            {flatFolders.filter((folder) => folder.id !== moveItem?.id && !(moveItem?.type === 'folder' && descendantsOf(moveItem.id).has(folder.id))).map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
          </select>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setMoveItem(null)}>Cancelar</Button><Button onClick={() => void moveItemToTarget()}>Mover</Button></div>
        </div>
      </Modal>

      <Modal open={!!details} onClose={() => setDetails(null)} title="Detalhes do arquivo">
        {details && <div className="space-y-3 text-sm">
          <div className="flex items-center gap-3">{fileIcon(details.kind)}<div><p className="font-medium">{details.name}</p><p className="text-xs text-muted">{KIND_LABEL[details.kind]}</p></div></div>
          {details.kind === 'readme' && parseReadmeContent(details.content ?? '').description && <div><p className="mb-1 text-xs font-medium text-muted">Descrição</p><p className="text-fg">{parseReadmeContent(details.content ?? '').description}</p></div>}
          {(details.kind === 'audio' || details.kind === 'video' || details.kind === 'youtube') && (() => {
            const parsed = parseStructuredContent(details.kind, details.content ?? '')
            return <>
              {parsed.description && <div><p className="mb-1 text-xs font-medium text-muted">Descrição</p><p className="text-fg">{parsed.description}</p></div>}
              {parsed.whenToUse && <div><p className="mb-1 text-xs font-medium text-muted">Quando utilizar</p><p className="text-fg">{parsed.whenToUse}</p></div>}
            </>
          })()}
          {details.kind === 'audio' && details.source_url && <div><audio controls src={details.source_url} preload="metadata" className="w-full" /></div>}
          {details.content && <div><p className="mb-1 text-xs font-medium text-muted">Conteúdo</p><p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-subtle p-3 text-fg">{details.content}</p></div>}
          {details.source_url && <div><p className="mb-1 text-xs font-medium text-muted">Link</p><a href={details.source_url} target="_blank" rel="noreferrer" className="break-all text-accent-300 hover:text-accent-200">{details.source_url}</a></div>}
          <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 text-xs text-muted">
            <span>Criado em {prettyDate(details.created_at)}</span>
            <span>Atualizado em {prettyDate(details.updated_at)}</span>
            <span>{details.usage_count || 0} usos nas campanhas</span>
            <span>{details.folder_id ? 'Dentro de uma pasta' : 'Na raiz da base'}</span>
          </div>
        </div>}
      </Modal>
    </div>
  )
}