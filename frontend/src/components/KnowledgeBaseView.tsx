import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Image,
  Info,
  Link as LinkIcon,
  Mic,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquarePlay,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { supabase, type KbFile, type KbFolder } from '../lib/supabase'
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
  content: string
  source_url: string
  uploading: boolean
  uploadError: string | null
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

const README_PROMPT = `Crie um README comercial para esta Base de Conhecimento.

Organize o conteúdo em Markdown com estas seções:
1. O que é o produto/serviço
2. Para quem é
3. Principais benefícios
4. Funcionalidades e limitações
5. Preços, prazos e condições confirmadas
6. Perguntas frequentes e objeções
7. Exemplos de abordagem comercial
8. Quando encaminhar para uma pessoa

Use somente informações fornecidas. Quando algo não estiver confirmado, marque como [CONFIRMAR]. Não invente preços, garantias, prazos ou funcionalidades.`

const README_DESC_MARKER = '## Descrição'
const README_BODY_MARKER = '## Conteúdo'

const EMPTY_EDITOR: EditorState = {
  file: null,
  name: '',
  kind: 'texto',
  description: '',
  content: '',
  source_url: '',
  uploading: false,
  uploadError: null,
}

const NEW_MENU: Array<{ kind: Kind; label: string; icon: ReactNode }> = [
  { kind: 'texto', label: 'Texto', icon: <FileText size={14} /> },
  { kind: 'readme', label: 'README', icon: <FileText size={14} /> },
  { kind: 'link', label: 'Link', icon: <LinkIcon size={14} /> },
  { kind: 'documento', label: 'Documento', icon: <File size={14} /> },
  { kind: 'audio', label: 'Áudio', icon: <Mic size={14} /> },
  { kind: 'video', label: 'Vídeo', icon: <Film size={14} /> },
  { kind: 'imagem', label: 'Imagem', icon: <Image size={14} /> },
  { kind: 'youtube', label: 'YouTube', icon: <SquarePlay size={14} /> },
]

function fileIcon(kind: Kind) {
  if (kind === 'link') return <LinkIcon size={22} className="text-sky-300" />
  if (kind === 'youtube') return <SquarePlay size={22} className="text-rose-300" />
  if (kind === 'readme') return <FileText size={22} className="text-amber-300" />
  if (kind === 'documento') return <File size={22} className="text-indigo-300" />
  if (kind === 'audio') return <Mic size={22} className="text-emerald-300" />
  if (kind === 'video') return <Film size={22} className="text-fuchsia-300" />
  if (kind === 'imagem') return <Image size={22} className="text-lime-300" />
  return <FileText size={22} className="text-accent-300" />
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

function shortDesc(file: KbFile): string {
  if (file.kind === 'readme') return parseReadmeContent(file.content ?? '').description || 'README'
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
  const dragRef = useRef<{ type: 'file' | 'folder'; id: string } | null>(null)
  const cancelledRef = useRef<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    const parsed = file.kind === 'readme' ? parseReadmeContent(file.content ?? '') : { description: '', body: file.content ?? '' }
    setEditor({
      file,
      name: file.name,
      kind: file.kind,
      description: parsed.description,
      content: parsed.body,
      source_url: file.source_url ?? '',
      uploading: false,
      uploadError: null,
    })
  }

  async function saveFile() {
    if (!editor || !editor.name.trim()) return
    const content = editor.kind === 'readme'
      ? buildReadmeContent(editor.description, editor.content) || null
      : editor.content || null
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
      setEditor(null)
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

  async function uploadEditorFile(file: File) {
    if (!editor) return
    setEditor({ ...editor, uploading: true, uploadError: null })
    const { url, error: uploadError } = await uploadMedia(file)
    if (uploadError) {
      setEditor({ ...editor, uploading: false, uploadError })
      return
    }
    setEditor({ ...editor, source_url: url, uploading: false, uploadError: null })
  }

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
    setError('Prompt de README copiado para a área de transferência.')
    window.setTimeout(() => setError(null), 2500)
  }

  function openContextMenu(event: React.MouseEvent, target: Menu) {
    event.preventDefault()
    event.stopPropagation()
    setNewMenu(false)
    setMenu(target)
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

      {menu && (
        <div className="fixed z-50 w-52 rounded-xl border border-line bg-panel p-1 shadow-2xl" style={{ left: Math.min(menu.x, window.innerWidth - 216), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={(event) => event.stopPropagation()}>
          {menu.type === 'folder' && (
            <>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setCurrentFolder(menu.folder.id); setSearch(''); setMenu(null) }}><Folder size={14} />Abrir</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setRenameItem({ type: 'folder', id: menu.folder.id, name: menu.folder.name }); setRenameName(menu.folder.name); setMenu(null) }}><Pencil size={14} />Renomear</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => { setMoveItem({ type: 'folder', id: menu.folder.id, name: menu.folder.name, parent: menu.folder.parent_id }); setMoveTarget(menu.folder.parent_id ?? ''); setMenu(null) }}><FolderPlus size={14} />Mover</button>
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
              <div className="my-1 border-t border-line" />
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 hover:bg-rose-500/10" onClick={() => void deleteFile(menu.file)}><Trash2 size={14} />Excluir</button>
            </>
          )}
          {menu.type === 'empty' && (
            <>
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

      <Modal open={!!editor} onClose={() => setEditor(null)} title={editor?.file ? 'Editar arquivo' : 'Novo arquivo'} size="lg">
        {editor && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void saveFile() }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">Nome<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
            <label className="text-xs text-muted">Tipo<select value={editor.kind} onChange={(event) => setEditor({ ...editor, kind: event.target.value as Kind })}>
              {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
          {editor.kind === 'readme' && <label className="block text-xs text-muted">Descrição<textarea rows={2} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="Resumo curto do que este README contém (aparece no card e como contexto para a IA)." /></label>}
          {(editor.kind === 'link' || editor.kind === 'youtube') && <label className="text-xs text-muted">URL<input value={editor.source_url} onChange={(event) => setEditor({ ...editor, source_url: event.target.value })} placeholder="https://..." /></label>}
          {(editor.kind === 'documento' || editor.kind === 'audio' || editor.kind === 'video' || editor.kind === 'imagem') && (
            <div className="space-y-2">
              <label className="text-xs text-muted">Arquivo ou link</label>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" icon={<Upload size={14} />} disabled={editor.uploading} onClick={() => { if (fileInputRef.current) { fileInputRef.current.multiple = false; fileInputRef.current.onchange = (event) => { const target = event.target as HTMLInputElement; if (target.files?.[0]) void uploadEditorFile(target.files[0]); target.value = '' } ; fileInputRef.current.click() } }}>{editor.uploading ? 'Enviando...' : 'Enviar arquivo'}</Button>
                <input value={editor.source_url} onChange={(event) => setEditor({ ...editor, source_url: event.target.value })} placeholder="https://..." className="min-w-0 flex-1" />
              </div>
              {editor.uploading && <p className="text-xs text-muted">Enviando arquivo...</p>}
              {editor.uploadError && <p className="text-xs text-rose-300">{editor.uploadError}</p>}
            </div>
          )}
          <label className="block text-xs text-muted">{editor.kind === 'readme' ? 'Conteúdo (Markdown)' : 'Conteúdo'}<textarea rows={14} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} placeholder="Cole aqui informações confirmadas sobre o produto, serviço, preços, objeções..." /></label>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEditor(null)}>Cancelar</Button><Button type="submit" icon={<Check size={14} />}>Salvar</Button></div>
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