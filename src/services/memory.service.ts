/**
 * Persistência da Memória Comercial da IA no Supabase (REST + service role).
 *
 * Isolamento de privacidade: TODAS as consultas filtram por user_id (a pegada
 * do usuário autenticado no painel, ou o dono da instância WhatsApp no webhook).
 * Nomes/telefones nunca são usados como dado comercial — telas mostram contatos
 * mascarados, e o prompt do agente nunca recebe o transcript bruto.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import type { ExtractedLearning, LearningCategory } from './memory.analyze.js';

interface SupabaseMeta {
  url: string;
  key: string;
}

function sup(): SupabaseMeta | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey
    ? { url: cfg.url.replace(/\/+$/, ''), key: cfg.serviceRoleKey }
    : null;
}

function hdr(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

async function postRows<T = Record<string, unknown>>(
  table: string,
  rows: unknown[],
  prefer: 'return=representation' | 'return=minimal' = 'return=representation',
): Promise<T[]> {
  const s = sup();
  if (!s) return [];
  const res = await fetch(`${s.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...hdr(s.key, true), Prefer: prefer },
    body: JSON.stringify(rows.length === 1 ? rows[0] : rows),
  });
  if (!res.ok) return [];
  if (prefer === 'return=minimal') return [];
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text) as T | T[];
  return Array.isArray(data) ? data : [data];
}

async function patchRow(table: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const s = sup();
  if (!s) return false;
  try {
    const res = await fetch(`${s.url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: hdr(s.key, true),
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteRows(table: string, filter: string): Promise<boolean> {
  const s = sup();
  if (!s) return false;
  try {
    const res = await fetch(`${s.url}/rest/v1/${table}?${filter}`, {
      method: 'DELETE',
      headers: { ...hdr(s.key), Prefer: 'return=minimal' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ===========================================================================
// Imports (lotes)
// ===========================================================================

export interface MemoryImportMeta {
  id: string;
  user_id: string;
  origin: 'zip' | 'txt' | 'csv' | 'arquivo';
  file_name: string;
  source_files: number;
  conversations_found: number;
  conversations_processed: number;
  learnings_generated: number;
  failures: number;
  status: 'processing' | 'done' | 'failed';
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function createImportRow(input: {
  userId: string;
  origin: string;
  fileName: string;
  sourceFiles: number;
  conversationsFound: number;
}): Promise<string | null> {
  const s = sup();
  if (!s) return null;
  try {
    const rows = await postRows<{ id: string }>('ai_memory_imports', [
      {
        user_id: input.userId,
        origin: input.origin,
        file_name: input.fileName.slice(0, 180),
        source_files: input.sourceFiles,
        conversations_found: input.conversationsFound,
        status: 'processing',
      },
    ]);
    return rows[0]?.id ?? null;
  } catch (err) {
    getLogger().warn({ errMessage: err instanceof Error ? err.message : 'unknown' }, 'memory: create import failed');
    return null;
  }
}

export function updateImportRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
  return patchRow('ai_memory_imports', id, patch);
}

export async function getImportRow(id: string): Promise<MemoryImportMeta | null> {
  const s = sup();
  if (!s || !id) return null;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_imports?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as MemoryImportMeta[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function listImports(userId: string, limit = 50): Promise<MemoryImportMeta[]> {
  const s = sup();
  if (!s || !userId) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_imports?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${limit}`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return [];
    return (await res.json()) as MemoryImportMeta[];
  } catch {
    return [];
  }
}

export function deleteImportRow(id: string, userId: string): Promise<boolean> {
  // A cascata do Postgres apaga conversas e aprendizados ligados ao lote.
  return deleteRows('ai_memory_imports', `id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`);
}

// ===========================================================================
// Conversas
// ===========================================================================

export interface MemoryConversationRow {
  id: string;
  user_id: string;
  workspace_id?: string | null;
  import_id?: string | null;
  source_file?: string | null;
  contact_identifier?: string | null;
  contact_name?: string | null;
  messages_count: number;
  direction?: string | null;
  outcome?: string | null;
  status: 'imported' | 'processing' | 'processed' | 'failed';
  error_message?: string | null;
  created_at: string;
  processed_at?: string | null;
}

export interface MemoryConversationFullRow extends MemoryConversationRow {
  transcript: Array<{ role: 'agente' | 'lead'; text: string }>;
}

export interface ConversationInsert {
  userId: string;
  importId: string | null;
  sourceFile: string | null;
  contactName: string | null;
  contactIdentifier: string | null;
  transcript: Array<{ role: 'agente' | 'lead'; text: string }>;
  direction: string;
}

export async function bulkCreateConversations(items: ConversationInsert[]): Promise<Record<string, string>> {
  const s = sup();
  if (!s || items.length === 0) return {};
  const rows = items.map((it) => ({
    user_id: it.userId,
    import_id: it.importId,
    source_file: it.sourceFile,
    contact_name: it.contactName,
    contact_identifier: it.contactIdentifier ? it.contactIdentifier.slice(0, 14) : null,
    messages_count: it.transcript.length,
    direction: it.direction,
    transcript: JSON.stringify(it.transcript.map((m) => ({ role: m.role, text: m.text }))),
    status: 'imported',
  }));
  try {
    const created = await postRows<{ id: string }>('ai_memory_conversations', rows);
    const map: Record<string, string> = {};
    created.forEach((row, i) => {
      if (row?.id && rows[i]) map[rows[i].source_file ?? `#${i}`] = row.id;
    });
    return map;
  } catch {
    return {};
  }
}

export function updateConversationRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
  return patchRow('ai_memory_conversations', id, patch);
}

export async function listConversations(
  userId: string,
  opts?: { importId?: string; status?: string; limit?: number },
): Promise<MemoryConversationRow[]> {
  const s = sup();
  if (!s || !userId) return [];
  const filter = [
    `user_id=eq.${encodeURIComponent(userId)}`,
    opts?.importId ? `import_id=eq.${encodeURIComponent(opts.importId)}` : null,
    opts?.status ? `status=eq.${encodeURIComponent(opts.status)}` : null,
  ].filter(Boolean).join('&');
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_conversations?select=id,source_file,contact_name,contact_identifier,messages_count,direction,outcome,status,created_at,processed_at,error_message,user_id,import_id&${filter}&order=created_at.desc&limit=${opts?.limit ?? 100}`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return [];
    return (await res.json()) as MemoryConversationRow[];
  } catch {
    return [];
  }
}

export async function deleteConversationRow(id: string, userId: string): Promise<boolean> {
  const s = sup();
  if (!s) return false;
  try {
    // Apaga aprendizados ligados à conversa e a própria conversa.
    await deleteRows('ai_memory_learnings', `conversation_id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`);
    return await deleteRows('ai_memory_conversations', `id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`);
  } catch {
    return false;
  }
}

/** Todas as conversas de um lote (com transcript) para o processador. */
/** Normaliza o transcript armazenado (JSON string ou array) para o formato interno. */
export function parseTranscript(raw: unknown): Array<{ role: 'agente' | 'lead'; text: string }> {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => ({
      role: m.role === 'agente' || m.role === 'lead' ? m.role : 'lead',
      text: String(m.text ?? ''),
    }));
}

export async function getConversationsByImport(
  importId: string,
  userId: string,
): Promise<MemoryConversationFullRow[]> {
  const s = sup();
  if (!s || !importId || !userId) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_conversations?select=*&import_id=eq.${encodeURIComponent(importId)}&user_id=eq.${encodeURIComponent(userId)}&limit=500`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<
      MemoryConversationRow & { transcript?: unknown }
    >;
    return rows
      .filter((r) => !!r && !!r.id)
      .map((r) => ({
        ...r,
        transcript: parseTranscript(r.transcript),
      }));
  } catch {
    return [];
  }
}

// ===========================================================================
// Aprendizados
// ===========================================================================

export type LearningOrigin = 'ai' | 'manual';

/**
 * Normaliza QUALQUER formato de evidência vindo do banco para um array de
 * strings (o contrato canônico da aplicação):
 *  - array            -> mapeado/limpo
 *  - JSON string      -> parse seguro (array/objeto/scalar)
 *  - objeto           -> extrai quote/context/texto relevante
 *  - string simples   -> vira um item de evidência
 *  - null/undefined   -> []
 *
 * O crash `evidence.slice(...).map is not a function` acontecia porque o
 * frontend assumia array, mas o valor podia chegar como string/objeto. Nunca
 * mais um formato inesperado deve derrubar a UI.
 */
export function normalizeEvidenceValue(raw: unknown, limit = 3): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((e) => {
        if (e == null) return '';
        if (typeof e === 'string') return e.trim();
        if (typeof e === 'object') return extractEvidenceString(e);
        return String(e);
      })
      .filter((s) => s.length > 0)
      .slice(0, limit);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return normalizeEvidenceValue(parsed, limit);
      if (parsed && typeof parsed === 'object') return normalizeEvidenceValue(parsed, limit);
      if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim().slice(0, 220)];
      return [];
    } catch {
      return [t.slice(0, 220)];
    }
  }
  if (typeof raw === 'object') {
    const item = extractEvidenceString(raw as Record<string, unknown>);
    return item ? [item] : [];
  }
  return [];
}

function extractEvidenceString(o: Record<string, unknown>): string {
  for (const k of ['quote', 'context', 'relevance', 'content', 'text', 'message']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 220);
    if (Array.isArray(v) && v.length > 0) return String(v[0]).slice(0, 220);
  }
  const s = JSON.stringify(o);
  return s && s !== '{}' ? s.slice(0, 220) : '';
}

export interface LearningRow {
  id: string;
  user_id: string;
  import_id?: string | null;
  conversation_id?: string | null;
  category: LearningCategory;
  content: string;
  evidence: string[];
  origin: LearningOrigin;
  confidence: 'alta' | 'media' | 'baixa';
  occurrences: number;
  performance: 'positivo' | 'negativo' | 'neutro';
  status: 'identificado' | 'validado' | 'ativo' | 'inativo';
  important: boolean;
  discovered_at: string;
  created_at: string;
}

export async function bulkCreateLearnings(
  userId: string,
  items: Array<{ importId: string | null; conversationId: string | null; learning: ExtractedLearning }>,
): Promise<number> {
  const s = sup();
  if (!s || items.length === 0) return 0;

  // Dedup em código por (category, content) para evitar duplicatas, já que o
  // banco pode não ter o índice único exigido pelo on_conflict.
  const existing = await listLearnings(userId, { limit: 500 });
  const seen = new Set(existing.map((l) => `${l.category}|${l.content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}`));

  const rows = items
    .filter(({ learning }) => {
      const key = `${learning.category}|${learning.content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ importId, conversationId, learning }) => ({
      user_id: userId,
      import_id: importId,
      conversation_id: conversationId,
      category: learning.category,
      content: learning.content,
      // Coluna JSONB: enviamos o ARRAY (não uma string JSON) para que o
      // banco grave como array e o contrato de evidence fique estável.
      evidence: normalizeEvidenceValue(learning.evidence),
      confidence: learning.confidence,
      occurrences: 1,
      performance: learning.performance,
      status: 'identificado',
      important: false,
    }));

  if (rows.length === 0) return 0;

  try {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const res = await fetch(`${s.url}/rest/v1/ai_memory_learnings`, {
        method: 'POST',
        headers: {
          ...hdr(s.key, true),
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
      });
      if (res.ok) inserted += batch.length;
    }
    return inserted;
  } catch {
    return 0;
  }
}

export async function listLearnings(
  userId: string,
  opts?: { category?: string; status?: string; limit?: number },
): Promise<LearningRow[]> {
  const s = sup();
  if (!s || !userId) return [];
  const filter = [
    `user_id=eq.${encodeURIComponent(userId)}`,
    opts?.category ? `category=eq.${encodeURIComponent(opts.category)}` : null,
    opts?.status ? `status=eq.${encodeURIComponent(opts.status)}` : null,
  ].filter(Boolean).join('&');
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_learnings?select=id,user_id,import_id,conversation_id,category,content,evidence,confidence,occurrences,performance,status,important,discovered_at,created_at&${filter}&order=important.desc,created_at.desc&limit=${opts?.limit ?? 100}`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<
      Omit<LearningRow, 'evidence' | 'origin'> & { evidence?: unknown }
    >;
    // Contrato estável: evidence SEMPRE array de strings + origin derivada.
    return rows
      .filter((r) => !!r && !!r.id)
      .map((r) => ({
        ...r,
        evidence: normalizeEvidenceValue(r.evidence),
        origin: r.import_id || r.conversation_id ? ('ai' as const) : ('manual' as const),
      }));
  } catch {
    return [];
  }
}

/** Cria um aprendizado manual (origin = 'manual', sem import/conversa). */
export async function createLearningRow(
  userId: string,
  input: {
    category: LearningCategory;
    content: string;
    confidence: 'alta' | 'media' | 'baixa';
    performance: 'positivo' | 'negativo' | 'neutro';
    status: 'identificado' | 'validado' | 'ativo' | 'inativo';
    important: boolean;
    evidence?: string[];
  },
): Promise<string | null> {
  const s = sup();
  if (!s) return null;
  try {
    const rows = await postRows<{ id: string }>('ai_memory_learnings', [
      {
        user_id: userId,
        category: input.category,
        content: input.content.slice(0, 400),
        evidence: normalizeEvidenceValue(input.evidence ?? [], 10),
        confidence: input.confidence,
        performance: input.performance,
        status: input.status,
        important: input.important,
        occurrences: 1,
      },
    ]);
    return rows[0]?.id ?? null;
  } catch (err) {
    getLogger().warn({ errMessage: err instanceof Error ? err.message : 'unknown' }, 'memory: create learning failed');
    return null;
  }
}

/** Lotes em processamento (cross-user) para retomada após restart. */
export async function listProcessingImports(limit = 50): Promise<Array<{ id: string; user_id: string }>> {
  const s = sup();
  if (!s) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_imports?select=id,user_id&status=eq.processing&limit=${limit}`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return [];
    return (await res.json()) as Array<{ id: string; user_id: string }>;
  } catch {
    return [];
  }
}

export async function updateLearningRow(id: string, userId: string, patch: Record<string, unknown>): Promise<boolean> {
  const s = sup();
  if (!s) return false;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/ai_memory_learnings?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: hdr(s.key, true),
        body: JSON.stringify(patch),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function deleteLearningRow(id: string, userId: string): Promise<boolean> {
  return deleteRows('ai_memory_learnings', `id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`);
}

// ===========================================================================
// Dashboard
// ===========================================================================

export interface MemoryDashboard {
  conversationsImported: number;
  conversationsProcessed: number;
  learnings: number;
  patterns: number;
  objections: number;
  meetingStrategies: number;
  statusCounts: Record<string, number>;
  recentLearnings: LearningRow[];
  totalImports: number;
}

export async function getDashboard(userId: string): Promise<MemoryDashboard> {
  const empty: MemoryDashboard = {
    conversationsImported: 0,
    conversationsProcessed: 0,
    learnings: 0,
    patterns: 0,
    objections: 0,
    meetingStrategies: 0,
    statusCounts: {},
    recentLearnings: [],
    totalImports: 0,
  };
  const s = sup();
  if (!s || !userId) return empty;

  const count = async (table: string, extra = ''): Promise<number> => {
    try {
      const url = `${s.url}/rest/v1/${table}?select=id&user_id=eq.${encodeURIComponent(userId)}${extra}`;
      const res = await fetch(url, { headers: { ...hdr(s.key), Prefer: 'count=exact', Range: '0-0' } });
      const range = res.headers.get('content-range');
      const m = range?.match(/\/(\d+)$/);
      return m ? Number(m[1]) : 0;
    } catch {
      return 0;
    }
  };

  const [
    conversationsImported,
    conversationsProcessed,
    learnings,
    patterns,
    objections,
    meetingStrategies,
    totalImports,
    statusIdentificado,
    statusValidado,
    statusAtivo,
    statusInativo,
  ] = await Promise.all([
    count('ai_memory_conversations'),
    count('ai_memory_conversations', '&status=eq.processed'),
    count('ai_memory_learnings'),
    count('ai_memory_learnings', '&category=in.(successful_patterns,unsuccessful_patterns,opening_patterns,follow_up_patterns,discovery_questions,value_proposition,communication_style,conversation_patterns)'),
    count('ai_memory_learnings', '&category=in.(common_objections,objection_handling)'),
    count('ai_memory_learnings', '&category=eq.meeting_transition'),
    count('ai_memory_imports'),
    count('ai_memory_learnings', '&status=eq.identificado'),
    count('ai_memory_learnings', '&status=eq.validado'),
    count('ai_memory_learnings', '&status=eq.ativo'),
    count('ai_memory_learnings', '&status=eq.inativo'),
  ]);

  const recent = await listLearnings(userId, { limit: 12 });
  // statusCounts = contagens REAIS por status (não só dos recentes).
  const statusCounts: Record<string, number> = {
    identificado: statusIdentificado,
    validado: statusValidado,
    ativo: statusAtivo,
    inativo: statusInativo,
  };

  return {
    conversationsImported,
    conversationsProcessed,
    learnings,
    patterns,
    objections,
    meetingStrategies,
    statusCounts,
    recentLearnings: recent,
    totalImports,
  };
}

// ===========================================================================
// Integração com o prompt do agente
// ===========================================================================

/**
 * Resolve o user_id dono de uma instância WhatsApp (whatsapp_connections).
 * Usado pelo webhook para carregar apenas a memória DO DONO da conexão.
 */
export async function resolveUserIdForInstance(instance?: string): Promise<string | null> {
  if (!instance) return null;
  const s = sup();
  if (!s) return null;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/whatsapp_connections?select=user_id&instance_name=eq.${encodeURIComponent(instance)}&limit=1`,
      { headers: hdr(s.key) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ user_id: string | null }>;
    return rows[0]?.user_id ?? null;
  } catch {
    return null;
  }
}

const MEMORY_BULETABLE_CATEGORIES = new Set<LearningCategory>([
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
]);

const CATEGORY_LABELS: Record<LearningCategory, string> = {
  communication_style: 'Estilo de comunicação',
  opening_patterns: 'Padrões de abertura',
  discovery_questions: 'Perguntas de descoberta',
  value_proposition: 'Proposta de valor',
  objection_handling: 'Tratamento de objeções',
  meeting_transition: 'Condução à reunião',
  follow_up_patterns: 'Padrões de follow-up',
  successful_patterns: 'Padrões de sucesso',
  unsuccessful_patterns: 'Padrões de recusa',
  common_objections: 'Objeções comuns',
  conversation_patterns: 'Padrões de conversa',
};

/**
 * Monta o bloco "MEMÓRIA COMERCIAL" para o system prompt. Nunca contém
 * telefones/nomes reais (só padrões validados). Retorna null se não houver nada.
 */
export async function loadCommercialMemoryForPrompt(userId: string | null, limit = 10): Promise<string | null> {
  if (!userId) return null;
  const rows = await listLearnings(userId, { limit: 200 });
  const usable = rows
    .filter((l) => l.status === 'ativo' || (l.status === 'validado' && l.important))
    .filter((l) => MEMORY_BULETABLE_CATEGORIES.has(l.category))
    .sort((a, b) => {
      // Prioridade: importantes → performance positiva → recentes.
      if (a.important !== b.important) return a.important ? -1 : 1;
      const perfOrder = { positivo: 0, neutro: 1, negativo: 2 } as const;
      const pa = perfOrder[a.performance as 'positivo' | 'neutro' | 'negativo'] ?? 1;
      const pb = perfOrder[b.performance as 'positivo' | 'neutro' | 'negativo'] ?? 1;
      if (pa !== pb) return pa - pb;
      return b.created_at.localeCompare(a.created_at);
    });

  const selected = usable.slice(0, limit);
  if (selected.length === 0) return null;

  const lines = selected.map((l) => {
    const label = CATEGORY_LABELS[l.category] ?? l.category;
    const marker = l.performance === 'negativo' ? '(evitar)' : l.important ? '(importante)' : '';
    return `- [${label}] ${l.content} ${marker}`.trim();
  });

  return [
    '=== MEMÓRIA COMERCIAL: padrões aprendidos com conversas reais ===',
    ...lines,
    'Use estes padrões validados para refinar abordagem, argumentos e tom. Nunca cite o cliente real ou repita dados pessoais; aplique o padrão, não o texto literal.',
  ].join('\n');
}

export { hdr as _memoryHeaders }; // reuso em testes/pipes internos