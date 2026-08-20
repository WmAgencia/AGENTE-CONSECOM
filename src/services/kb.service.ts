/**
 * Base de Conhecimento (Vyntra) — serviço de leitura para o agente.
 *
 * A UI faz CRUD direto via Supabase (padrão do app). Aqui vive o que o BACKEND
 * precisa: montar o contexto da base vinculada a uma campanha (árvore de
 * pastas + arquivos), formatar para o prompt e contabilizar usos.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';

export interface KbFolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  closer_name: string | null;
  closer_phone: string | null;
  closer_instructions: string | null;
}

/** Responsável pelo fechamento configurado na base (herdado pela campanha). */
export interface KbCloser {
  name: string | null;
  phone: string | null;
  instructions: string | null;
}

export interface KbFileRow {
  id: string;
  name: string;
  kind: string;
  content: string | null;
  source_url: string | null;
  usage_count: number;
  folder_id: string | null;
}

export interface KnowledgeFile {
  id: string;
  name: string;
  kind: string;
  content: string | null;
  source_url: string | null;
  folder_path: string;
}

const KB_API_HEADERS = (cfg: { serviceRoleKey: string }): Record<string, string> => ({
  apikey: cfg.serviceRoleKey,
  Authorization: `Bearer ${cfg.serviceRoleKey}`,
});

async function fetchKbFolder(cfg: { url: string; serviceRoleKey: string }, folderId: string): Promise<KbFolderRow | null> {
  const r = await fetch(
    `${cfg.url}/rest/v1/kb_folders?select=id,name,parent_id&id=eq.${encodeURIComponent(folderId)}&limit=1`,
    { headers: KB_API_HEADERS(cfg) },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as KbFolderRow[];
  return rows[0] ?? null;
}

/**
 * Lê o "Responsável pelo fechamento" da base (colunas closer_*). Retorna null
 * quando a coluna ainda não existe no banco (migration pendente) — o contexto
 * da KB continua funcionando sem o responsável.
 */
async function fetchKbCloser(cfg: { url: string; serviceRoleKey: string }, folderId: string): Promise<KbCloser | null> {
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/kb_folders?select=closer_name,closer_phone,closer_instructions&id=eq.${encodeURIComponent(folderId)}&limit=1`,
      { headers: KB_API_HEADERS(cfg) },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{
      closer_name: string | null;
      closer_phone: string | null;
      closer_instructions: string | null;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      name: row.closer_name ?? null,
      phone: row.closer_phone ?? null,
      instructions: row.closer_instructions ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchKbChildrenFolders(cfg: { url: string; serviceRoleKey: string }, parentId: string | null): Promise<KbFolderRow[]> {
  const filter = parentId
    ? `parent_id=eq.${encodeURIComponent(parentId)}`
    : 'parent_id=is.null';
  const r = await fetch(`${cfg.url}/rest/v1/kb_folders?select=id,name,parent_id&${filter}`, {
    headers: KB_API_HEADERS(cfg),
  });
  if (!r.ok) return [];
  return (await r.json()) as KbFolderRow[];
}

async function fetchKbFilesInFolder(cfg: { url: string; serviceRoleKey: string }, folderId: string | null): Promise<KbFileRow[]> {
  const filter = folderId
    ? `folder_id=eq.${encodeURIComponent(folderId)}`
    : 'folder_id=is.null';
  const r = await fetch(
    `${cfg.url}/rest/v1/kb_files?select=id,name,kind,content,source_url,usage_count,folder_id&${filter}&order=name`,
    { headers: KB_API_HEADERS(cfg) },
  );
  if (!r.ok) return [];
  return (await r.json()) as KbFileRow[];
}

/**
 * Coleta a árvore de uma base (DFS) e devolve todos os arquivos com o caminho
 * da pasta (ex.: "Vendas/Proposta"). Retorna null quando a campanha não tem
 * base vinculada.
 */
export async function loadCampaignKnowledge(
  campaignId: string | null | undefined,
): Promise<{ rootId: string; files: KnowledgeFile[]; closer: KbCloser } | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey || !campaignId) return null;

  const c = await fetch(
    `${cfg.url}/rest/v1/campaigns?select=knowledge_base_id&id=eq.${encodeURIComponent(campaignId)}&limit=1`,
    { headers: KB_API_HEADERS(cfg) },
  );
  if (!c.ok) return null;
  const cs = (await c.json()) as Array<{ knowledge_base_id: string | null }>;
  const rootId = cs[0]?.knowledge_base_id ?? null;
  if (!rootId) return null;

  const root = await fetchKbFolder(cfg, rootId);
  if (!root) return null;

  const files: KnowledgeFile[] = [];

  async function walk(folderId: string, path: string): Promise<void> {
    const sub = await fetchKbChildrenFolders(cfg, folderId);
    for (const child of sub) {
      const childPath = path ? `${path}/${child.name}` : child.name;
      const rows = await fetchKbFilesInFolder(cfg, child.id);
      for (const row of rows) {
        files.push({
          id: row.id,
          name: row.name,
          kind: row.kind,
          content: row.content,
          source_url: row.source_url,
          folder_path: childPath,
        });
      }
      await walk(child.id, childPath);
    }
  }

  const rootRows = await fetchKbFilesInFolder(cfg, rootId);
  for (const row of rootRows) {
    files.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      content: row.content,
      source_url: row.source_url,
      folder_path: root.name,
    });
  }
  await walk(rootId, root.name);

  const closer = await fetchKbCloser(cfg, rootId);
  return {
    rootId,
    files,
    closer: closer ?? { name: null, phone: null, instructions: null },
  };
}

/**
 * Formata os arquivos da base como um bloco de contexto para o prompt do
 * agente. Limita o tamanho total para não estourar o contexto do modelo.
 */
export function buildKnowledgeContext(files: KnowledgeFile[], maxChars = 6000): string {
  const blocks: string[] = [];
  let used = 0;

  // O README é a instrução principal da base: SEMPRE vem primeiro, antes de
  // qualquer material, para nunca ser cortado pelo limite de contexto. Os
  // demais arquivos mantêm a ordem original (pasta/alfabética).
  const sorted = [...files].sort((a, b) => {
    const aReadme = a.kind === 'readme' ? 0 : 1;
    const bReadme = b.kind === 'readme' ? 0 : 1;
    return aReadme - bReadme;
  });

  for (const file of sorted) {
    const kind = file.kind === 'readme' ? 'README' : file.kind.toUpperCase();
    const loc = file.folder_path ? `${file.folder_path}/${file.name}` : file.name;
    const body = file.content?.trim() ?? (file.source_url ? `Link: ${file.source_url}` : '(sem conteúdo)');
    const block = `[${kind}] ${loc}\n${body}`;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length + 2;
  }

  if (blocks.length === 0) return '';
  return blocks.join('\n\n');
}

/** Incrementa a contagem de usos de um arquivo (execuções reais do agente). */
export async function incrementKbFileUsage(fileId: string): Promise<void> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey || !fileId) return;
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/kb_files?select=usage_count&id=eq.${encodeURIComponent(fileId)}&limit=1`,
      { headers: KB_API_HEADERS(cfg) },
    );
    if (!r.ok) return;
    const rows = (await r.json()) as Array<{ usage_count: number }>;
    const current = rows[0]?.usage_count ?? 0;
    await fetch(`${cfg.url}/rest/v1/kb_files?id=eq.${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...KB_API_HEADERS(cfg),
      },
      body: JSON.stringify({ usage_count: current + 1 }),
    }).catch(() => {});
  } catch {
    // best-effort
  }
}