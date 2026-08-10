/**
 * Memória Comercial da IA — rotas do painel VYNTRA.
 *
 *  - POST   /api/ai/memory/import                -> importa conversas (ZIP/TXT/CSV)
 *  - GET    /api/ai/memory/dashboard             -> métricas agregadas + aprendizados recentes
 *  - GET    /api/ai/memory/imports               -> histórico de lotes
 *  - GET    /api/ai/memory/imports/:id           -> lote + conversas (para progresso)
 *  - GET    /api/ai/memory/conversations         -> lista conversas importadas
 *  - POST   /api/ai/memory/conversations/:id/reprocess -> reprocessa uma conversa
 *  - DELETE /api/ai/memory/conversations/:id     -> exclui conversa (apaga aprendizados ligados)
 *  - GET    /api/ai/memory/learnings             -> lista aprendizados
 *  - PATCH  /api/ai/memory/learnings/:id         -> controle manual (status/importante/conteúdo)
 *  - DELETE /api/ai/memory/learnings/:id         -> remove aprendizado
 *
 * Auth: `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` (mesmo padrão das
 * demais rotas do painel). Tudo é isolado por user_id (privacidade).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { loadAgentName } from '../services/supabase.leads.js';
import {
  buildConversations,
  detectContentKind,
  parseZipToText,
  type ContentKind,
  type ParsedMessage,
} from '../services/memory.parse.js';
import {
  createImportRow,
  bulkCreateConversations,
  listImports,
  getImportRow,
  listConversations,
  deleteConversationRow,
  updateConversationRow,
  deleteImportRow,
  listLearnings,
  updateLearningRow,
  deleteLearningRow,
  getDashboard,
  type MemoryConversationRow,
} from '../services/memory.service.js';
import {
  startImportBackground,
  isImportPending,
} from '../services/memory.processor.js';

const importBodySchema = z.object({
  fileName: z.string().min(1).max(180),
  content: z.string().min(1).max(8_000_000),
  kind: z.enum(['auto', 'txt', 'csv', 'zip']).default('auto'),
});

const listQuerySchema = z.object({
  importId: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const learningPatchSchema = z.object({
  status: z.enum(['identificado', 'validado', 'ativo', 'inativo']).optional(),
  important: z.boolean().optional(),
  content: z.string().min(1).max(400).optional(),
  category: z.string().min(1).max(60).optional(),
  confidence: z.enum(['alta', 'media', 'baixa']).optional(),
});

async function resolveSupabaseUser(
  token: string | undefined,
): Promise<{ id: string } | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !token) return null;
  try {
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === 'string' && body.id.length > 0
      ? { id: body.id }
      : null;
  } catch {
    return null;
  }
}

function bearer(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = req.headers['authorization'];
  return extractBearerToken(typeof h === 'string' ? h : undefined);
}

function computeDirection(messages: Array<ParsedMessage & { role?: 'agente' | 'lead' }>): string {
  const agents = messages.filter((m) => m.role === 'agente').length;
  const leads = messages.length - agents;
  if (leads === 0) return 'saida';
  const ratio = agents / leads;
  if (ratio > 1.2) return 'saida';
  if (ratio < 0.8) return 'entrada';
  return 'misto';
}

export function registerMemoryRoutes(app: FastifyInstance): void {
  const log = getLogger();

  // ------------------------------------------------------------------ IMPORT
  app.post('/api/ai/memory/import', {
    // Conversas exportadas podem ser grandes (múltiplos MB em base64).
    bodyLimit: 25 * 1024 * 1024,
  }, async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const parsed = importBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }

    const { fileName, content } = parsed.data;
    const raw = content.replace(/^\uFEFF/, '');
    const kind: ContentKind =
      parsed.data.kind === 'auto' ? detectContentKind(raw) : parsed.data.kind;

    let sources: Array<{ fileName: string; content: string; kind: ContentKind }>;
    if (kind === 'zip') {
      const entries = parseZipToText(raw);
      sources = entries.map((e) => ({
        fileName: e.fileName,
        content: e.content.replace(/^\uFEFF/, ''),
        kind: e.kind,
      }));
    } else {
      sources = [{ fileName, content: raw, kind }];
    }

    if (kind === 'zip' && sources.length === 0) {
      return reply.status(422).send({
        error: 'no_conversations',
        message: 'Nenhum arquivo de texto (.txt/.csv) encontrado dentro do ZIP.',
        statusCode: 422,
      });
    }

    const agentName = await loadAgentName();
    const conversations = buildConversations(sources, agentName);
    if (conversations.length === 0 || conversations.every((c) => c.messages.length < 2)) {
      return reply.status(422).send({
        error: 'no_conversations',
        message:
          'Nenhuma conversa reconhecida no arquivo. Verifique se é uma exportação de WhatsApp (.txt/.csv) ou um ZIP com arquivos de texto.',
        statusCode: 422,
      });
    }

    const importId = await createImportRow({
      userId: user.id,
      origin: kind,
      fileName,
      sourceFiles: sources.length,
      conversationsFound: conversations.length,
    });
    if (!importId) {
      return reply.status(502).send({ error: 'store_failed', statusCode: 502 });
    }

    const inserted = await bulkCreateConversations(
      conversations.map((c) => ({
        userId: user.id,
        importId,
        sourceFile: c.sourceFile ?? null,
        contactName: c.contactName ?? null,
        contactIdentifier: c.contactIdentifier ?? null,
        direction: computeDirection(c.messages),
        transcript: c.messages.map((m) => ({ role: m.role ?? 'lead', text: m.text })),
      })),
    );

    // Processamento assíncrono (análise + extração de aprendizados).
    startImportBackground(importId, user.id);

    log.info(
      {
        importId,
        user: user.id.slice(0, 8),
        kind,
        fileName,
        sources: sources.length,
        conversations: conversations.length,
      },
      'memory: import accepted',
    );

    return reply.send({
      ok: true,
      importId,
      origin: kind,
      fileName,
      sourceFiles: sources.length,
      conversationsFound: conversations.length,
      inserted: Object.keys(inserted).length,
      processing: true,
    });
  });

  // ----------------------------------------------------------- DASHBOARD
  app.get('/api/ai/memory/dashboard', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    try {
      const dashboard = await getDashboard(user.id);
      return reply.send(dashboard);
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'dashboard_failed', message: em, statusCode: 502 });
    }
  });

  // ------------------------------------------------------------ IMPORTS
  app.get('/api/ai/memory/imports', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const parsed = listQuerySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 100;
    try {
      const imports = await listImports(user.id, limit);
      return reply.send({ imports });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'list_failed', message: em, statusCode: 502 });
    }
  });

  app.get('/api/ai/memory/imports/:id', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const params = req.params as { id?: string };
    const id = params.id;
    if (!id) return reply.status(400).send({ error: 'id_required', statusCode: 400 });
    try {
      const meta = await getImportRow(id);
      if (!meta || meta.user_id !== user.id) {
        return reply.status(404).send({ error: 'not_found', statusCode: 404 });
      }
      const conversations = await listConversations(user.id, { importId: id });
      return reply.send({
        ...meta,
        pending: isImportPending(id),
        conversations,
      });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'fetch_failed', message: em, statusCode: 502 });
    }
  });

  app.delete('/api/ai/memory/imports/:id', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const params = req.params as { id?: string };
    const id = params.id;
    if (!id) return reply.status(400).send({ error: 'id_required', statusCode: 400 });
    try {
      const ok = await deleteImportRow(id, user.id);
      if (!ok) return reply.status(404).send({ error: 'not_found', statusCode: 404 });
      return reply.send({ ok: true });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'delete_failed', message: em, statusCode: 502 });
    }
  });

  // ------------------------------------------------------- CONVERSATIONS
  app.get('/api/ai/memory/conversations', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const parsed = listQuerySchema.safeParse(req.query);
    const q = { ...parsed.success ? parsed.data : { importId: undefined, status: undefined, category: undefined, limit: 100 } } as {
      importId?: string;
      status?: string;
      category?: string;
      limit: number;
    };
    try {
      const conversations = await listConversations(user.id, {
        importId: q.importId,
        status: q.status,
        limit: q.limit,
      });
      return reply.send({ conversations });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'list_failed', message: em, statusCode: 502 });
    }
  });

  app.post('/api/ai/memory/conversations/:id/reprocess', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const params = req.params as { id?: string };
    const id = params.id;
    if (!id) return reply.status(400).send({ error: 'id_required', statusCode: 400 });
    try {
      // listConversations já filtra por user_id → existindo, o dono é o user.
      const rows = await listConversations(user.id, { limit: 500 });
      const conv = rows.find((r: MemoryConversationRow) => r.id === id);
      if (!conv) return reply.status(404).send({ error: 'not_found', statusCode: 404 });
      if (!conv.import_id) {
        return reply.status(400).send({ error: 'no_import', statusCode: 400 });
      }
      await updateConversationRow(id, { status: 'imported', error_message: null });
      startImportBackground(conv.import_id, user.id);
      return reply.send({ ok: true, reprocessed: true });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'reprocess_failed', message: em, statusCode: 502 });
    }
  });

  app.delete('/api/ai/memory/conversations/:id', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const params = req.params as { id?: string };
    const id = params.id;
    if (!id) return reply.status(400).send({ error: 'id_required', statusCode: 400 });
    try {
      const ok = await deleteConversationRow(id, user.id);
      if (!ok) return reply.status(404).send({ error: 'not_found', statusCode: 404 });
      return reply.send({ ok: true });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'delete_failed', message: em, statusCode: 502 });
    }
  });

  // ------------------------------------------------------------ LEARNINGS
  app.get('/api/ai/memory/learnings', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const parsed = listQuerySchema.safeParse(req.query);
    const q = { ...parsed.success ? parsed.data : { importId: undefined, status: undefined, category: undefined, limit: 100 } } as {
      importId?: string;
      status?: string;
      category?: string;
      limit: number;
    };
    try {
      const learnings = await listLearnings(user.id, {
        category: q.category,
        status: q.status,
        limit: q.limit,
      });
      return reply.send({ learnings });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'list_failed', message: em, statusCode: 502 });
    }
  });

  app.patch('/api/ai/memory/learnings/:id', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const params = req.params as { id?: string };
    const id = params.id;
    if (!id) return reply.status(400).send({ error: 'id_required', statusCode: 400 });
    const parsed = learningPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.important !== undefined) patch.important = parsed.data.important;
    if (parsed.data.content !== undefined) patch.content = parsed.data.content;
    if (parsed.data.category !== undefined) patch.category = parsed.data.category;
    if (parsed.data.confidence !== undefined) patch.confidence = parsed.data.confidence;
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: 'nothing_to_update', statusCode: 400 });
    }
    try {
      const ok = await updateLearningRow(id, user.id, patch);
      if (!ok) return reply.status(404).send({ error: 'not_found', statusCode: 404 });
      return reply.send({ ok: true });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'update_failed', message: em, statusCode: 502 });
    }
  });

  app.delete('/api/ai/memory/learnings/:id', async (req, reply) => {
    const user = await resolveSupabaseUser(bearer(req));
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    const params = req.params as { id?: string };
    const id = params.id;
    if (!id) return reply.status(400).send({ error: 'id_required', statusCode: 400 });
    try {
      const ok = await deleteLearningRow(id, user.id);
      if (!ok) return reply.status(404).send({ error: 'not_found', statusCode: 404 });
      return reply.send({ ok: true });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'delete_failed', message: em, statusCode: 502 });
    }
  });

  log.info('memory: routes registered');
}