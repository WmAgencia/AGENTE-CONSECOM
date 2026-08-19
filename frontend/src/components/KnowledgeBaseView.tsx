import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  Link as LinkIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { supabase, type KbFile, type KbFolder } from '../lib/supabase'
import { Button, Modal } from './ui'

type EditorState = {
  file: KbFile | null
  name: string
  kind: KbFile['kind']
  content: string
  source_url: string
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

const EMPTY_EDITOR: EditorState = {
  file: null,
  name: '',
  kind: 'texto',
  content: '',
  source_url: '',
}

function fileIcon(kind: KbFile['kind']) {
  if (kind === 'link' || kind === 'youtube') return <LinkIcon size={22} className="text-sky-300" />
  if (kind === 'readme') return <FileText size={22} className="text-amber-300" />
  return <FileText size={22} className="text-accent-300" />
}

export function KnowledgeBaseView() {
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [files, setFiles] = useState<KbFile[]>([])
  const [currentFolder, setCurrentFolder] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [moveFile, setMoveFile] = useState<KbFile | null>(null)
  const [moveTarget, setMoveTarget] = useState<string>('')
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  async function load() {
    setLoading(true)
    setError(null)
    const [folderResult, fileResult] = await Promise.all([
      supabase.from('kb_folders').select('*').order('name'),
      supabase.from('kb_files').select('*').order('name'),
    ])
    if (folderResult.error || fileResult.error) {
      setError(folderResult.error?.message ?? fileResult.error?.message ?? 'Não foi possível carregar a base.')
    } else {
      setFolders((folderResult.data ?? []) as KbFolder[])
      setFiles((fileResult.data ?? []) as KbFile[])
    }
    setLoading(false)
  }

  useEffect(() => {
    void load()
    const channel = supabase
      .channel('knowledge-base')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_folders' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_files' }, () => void load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [])

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

  function openNewFile() {
    setEditor({ ...EMPTY_EDITOR, name: '', content: '' })
  }

  function openFile(file: KbFile) {
    setEditor({ file, name: file.name, kind: file.kind, content: file.content ?? '', source_url: file.source_url ?? '' })
  }

  async function saveFile() {
    if (!editor || !editor.name.trim()) return
    const payload = {
      name: editor.name.trim(),
      kind: editor.kind,
      content: editor.content || null,
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

  async function renameFolder(folder: KbFolder) {
    const name = window.prompt('Novo nome da pasta', folder.name)?.trim()
    if (!name || name === folder.name) return
    await supabase.from('kb_folders').update({ name, updated_at: new Date().toISOString() }).eq('id', folder.id)
    await load()
  }

  async function renameFile(file: KbFile) {
    const name = window.prompt('Novo nome do arquivo', file.name)?.trim()
    if (!name || name === file.name) return
    await supabase.from('kb_files').update({ name, updated_at: new Date().toISOString() }).eq('id', file.id)
    await load()
  }

  async function deleteFolder(folder: KbFolder) {
    if (!window.confirm(`Excluir a pasta "${folder.name}" e todo seu conteúdo?`)) return
    await supabase.from('kb_folders').delete().eq('id', folder.id)
    if (currentFolder === folder.id) setCurrentFolder(folder.parent_id)
    await load()
  }

  async function deleteFile(file: KbFile) {
    if (!window.confirm(`Excluir "${file.name}"?`)) return
    await supabase.from('kb_files').delete().eq('id', file.id)
    await load()
  }

  async function duplicateFile(file: KbFile) {
    await supabase.from('kb_files').insert({
      name: `${file.name} (cópia)`,
      kind: file.kind,
      content: file.content,
      source_url: file.source_url,
      folder_id: file.folder_id,
    })
    await load()
  }

  async function moveSelectedFile() {
    if (!moveFile) return
    await supabase.from('kb_files').update({ folder_id: moveTarget || null, updated_at: new Date().toISOString() }).eq('id', moveFile.id)
    setMoveFile(null)
    await load()
  }

  async function copyReadmePrompt() {
    await navigator.clipboard.writeText(README_PROMPT)
    setError('Prompt de README copiado para a área de transferência.')
    window.setTimeout(() => setError(null), 2500)
  }

  const flatFolders = useMemo(() => {
    function path(folder: KbFolder): string {
      const parent = folder.parent_id ? folderById.get(folder.parent_id) : null
      return parent ? `${path(parent)} / ${folder.name}` : folder.name
    }
    return folders.map((folder) => ({ ...folder, label: path(folder) }))
  }, [folders, folderById])

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
            <Button onClick={openNewFile} icon={<Plus size={14} />}>Novo arquivo</Button>
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

          {!loading && !visibleFolders.length && !visibleFiles.length && <div className="p-12 text-center text-sm text-muted">Esta pasta está vazia. Crie uma pasta ou arquivo para começar.</div>}
          {(visibleFolders.length > 0 || visibleFiles.length > 0) && <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
            {visibleFolders.map((folder) => <div key={folder.id} className="group rounded-xl border border-line bg-subtle p-4 hover:border-accent-500/50 transition">
              <button className="flex w-full items-center gap-3 text-left" onClick={() => { setCurrentFolder(folder.id); setSearch('') }}><Folder size={25} className="shrink-0 text-amber-300" /><span className="truncate text-sm font-medium">{folder.name}</span></button>
              <div className="mt-3 flex justify-end gap-1 opacity-70 group-hover:opacity-100">
                <button title="Renomear" className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg" onClick={() => void renameFolder(folder)}><Pencil size={13} /></button>
                <button title="Excluir" className="rounded p-1.5 text-muted hover:bg-rose-500/10 hover:text-rose-300" onClick={() => void deleteFolder(folder)}><Trash2 size={13} /></button>
              </div>
            </div>)}
            {visibleFiles.map((file) => <div key={file.id} className="group rounded-xl border border-line bg-subtle p-4 hover:border-accent-500/50 transition">
              <button className="flex w-full items-start gap-3 text-left" onClick={() => openFile(file)}>{fileIcon(file.kind)}<span className="min-w-0"><span className="block truncate text-sm font-medium">{file.name}</span><span className="mt-1 block text-[11px] text-faint">{file.usage_count || 0} usos · {file.kind}</span></span></button>
              <div className="mt-3 flex justify-end gap-1 opacity-70 group-hover:opacity-100">
                <button title="Renomear" className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg" onClick={() => void renameFile(file)}><Pencil size={13} /></button>
                <button title="Duplicar" className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg" onClick={() => void duplicateFile(file)}><Copy size={13} /></button>
                <button title="Mover" className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg" onClick={() => { setMoveFile(file); setMoveTarget(file.folder_id ?? '') }}><MoreHorizontal size={13} /></button>
                <button title="Excluir" className="rounded p-1.5 text-muted hover:bg-rose-500/10 hover:text-rose-300" onClick={() => void deleteFile(file)}><Trash2 size={13} /></button>
              </div>
            </div>)}
          </div>}
        </div>
      </div>

      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title="Nova pasta">
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createFolder() }}>
          <input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="Nome da pasta" />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setNewFolderOpen(false)}>Cancelar</Button><Button type="submit">Criar</Button></div>
        </form>
      </Modal>

      <Modal open={!!editor} onClose={() => setEditor(null)} title={editor?.file ? 'Editar arquivo' : 'Novo arquivo'} size="lg">
        {editor && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void saveFile() }}>
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-muted">Nome<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label><label className="text-xs text-muted">Tipo<select value={editor.kind} onChange={(event) => setEditor({ ...editor, kind: event.target.value as KbFile['kind'] })}><option value="texto">Texto</option><option value="readme">README</option><option value="link">Link</option><option value="documento">Documento</option><option value="youtube">YouTube</option></select></label></div>
          {(editor.kind === 'link' || editor.kind === 'youtube') && <label className="text-xs text-muted">URL<input value={editor.source_url} onChange={(event) => setEditor({ ...editor, source_url: event.target.value })} placeholder="https://..." /></label>}
          <label className="block text-xs text-muted">Conteúdo<textarea rows={14} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} placeholder="Cole aqui informações confirmadas sobre o produto, serviço, preços, objeções..." /></label>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEditor(null)}>Cancelar</Button><Button type="submit" icon={<Check size={14} />}>Salvar</Button></div>
        </form>}
      </Modal>

      <Modal open={!!moveFile} onClose={() => setMoveFile(null)} title="Mover arquivo">
        <div className="space-y-4"><p className="text-sm text-muted">Escolha a pasta de destino para <strong className="text-fg">{moveFile?.name}</strong>.</p><select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}><option value="">Minha base</option>{flatFolders.filter((folder) => folder.id !== moveFile?.folder_id).map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}</select><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setMoveFile(null)}>Cancelar</Button><Button onClick={() => void moveSelectedFile()}>Mover</Button></div></div>
      </Modal>
    </div>
  )
}
