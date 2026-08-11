/**
 * Agenda routes — painel de reuniões (configuração + operação).
 *
 * Auth: x-user-id / x-workspace-id (mesmo padrão das rotas de metas comerciais).
 *
 * GET    /api/agenda/data?start=YYYY-MM-DD&end=YYYY-MM-DD  → agenda (reuniões + bloqueios + config)
 * GET    /api/agenda/slots?start=...&end=...&durationMin=  → horários disponíveis
 * GET    /api/agenda/settings                              → settings + slots semanais + bloqueios
 * PUT    /api/agenda/settings                              → salvar configuração global
 * PUT    /api/agenda/slots                                 → salvar janelas semanais
 * POST   /api/agenda/blocks                                → criar bloqueio
 * DELETE /api/agenda/blocks/:id                            → remover bloqueio
 * POST   /api/agenda/reserve                               → reservar reunião (RPC canônica)
 * POST   /api/agenda/edit                                  → editar (reagendar / notas / duração)
 * POST   /api/agenda/cancel                                → cancelar reunião
 * POST   /api/agenda/realized                              → marcar reunião como realizada
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getWorkspaceAndUser } from '../services/evolution.connections.js';
import {
  loadSettings,
  saveSettings,
  loadSlots,
  saveSlots,
  loadBlocks,
  addBlock,
  removeBlock,
  getAgendaData,
  getAvailableSlots,
  reserveMeeting,
  editMeeting,
  cancelMeeting,
  markMeetingRealized,
  type AgendaSettings,
  type WeeklySlot,
} from '../services/agenda.service.js';

function identifier(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const { workspaceId, userId } = getWorkspaceAndUser(req);
  return workspaceId ?? userId;
}

function bool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function number(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function requireIdentifier(req: unknown, reply: { status: (c: number) => { send: (b: unknown) => void } }): string | null {
  const id = identifier(req as { headers: Record<string, string | string[] | undefined> });
  if (!id) {
    reply.status(401).send({ error: 'unauthorized' });
    return null;
  }
  return id;
}

export function registerAgendaRoutes(app: FastifyInstance): void {
  const log = getLogger();

  // ==== Leitura da agenda (reuniões + bloqueios + config) ====
  app.get('/api/agenda/data', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const q = req.query as { start?: string; end?: string };
    const start = q.start ?? '';
    const end = q.end ?? '';
    if (!start || !end) return reply.status(400).send({ error: 'range_required', message: 'Informe start e end (YYYY-MM-DD).' });
    const data = await getAgendaData(start, end);
    return reply.send(data);
  });

  // ==== Horários disponíveis ====
  app.get('/api/agenda/slots', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const q = req.query as { start?: string; end?: string; durationMin?: string };
    const slots = await getAvailableSlots({
      startDate: q.start,
      endDate: q.end,
      durationMin: number(q.durationMin),
    });
    return reply.send({ slots });
  });

  // ==== Configuração (settings + janelas semanais + bloqueios) ====
  app.get('/api/agenda/settings', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const [settings, slots, blocks] = await Promise.all([loadSettings(), loadSlots(), loadBlocks()]);
    return reply.send({ settings, slots, blocks });
  });

  app.put('/api/agenda/settings', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as Partial<AgendaSettings> | null;
    if (!body || typeof body !== 'object') return reply.status(400).send({ error: 'invalid_body' });
    const patch: Partial<AgendaSettings> = {};
    if (body.duration_min != null) patch.duration_min = Number(body.duration_min);
    if (body.gap_min != null) patch.gap_min = Number(body.gap_min);
    if (body.future_days != null) patch.future_days = Number(body.future_days);
    const ok = await saveSettings(patch);
    if (!ok) return reply.status(502).send({ error: 'save_failed' });
    const settings = await loadSettings();
    return reply.send({ ok: true, settings });
  });

  app.put('/api/agenda/slots', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as { slots?: unknown } | null;
    if (!body || !Array.isArray(body.slots)) return reply.status(400).send({ error: 'invalid_body' });
    const slots: WeeklySlot[] = body.slots
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        day: Number(s.day),
        start: Number(s.start),
        end: Number(s.end),
      }))
      .filter((s) =>
        Number.isInteger(s.day) && s.day >= 0 && s.day <= 6 &&
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
      );
    const ok = await saveSlots(slots);
    if (!ok) return reply.status(502).send({ error: 'save_failed' });
    return reply.send({ ok: true, slots });
  });

  // ==== Bloqueios ====
  app.post('/api/agenda/blocks', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as { start_at?: unknown; end_at?: unknown; reason?: unknown } | null;
    const start_at = typeof body?.start_at === 'string' ? body.start_at : '';
    const end_at = typeof body?.end_at === 'string' ? body.end_at : '';
    const reason = typeof body?.reason === 'string' ? body.reason : null;
    const startMs = Date.parse(start_at);
    const endMs = Date.parse(end_at);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      return reply.status(400).send({ error: 'invalid_range', message: 'Bloqueio inválido (start_at < end_at, ISO).' });
    }
    const block = await addBlock({ start_at, end_at, reason });
    if (!block) return reply.status(502).send({ error: 'save_failed' });
    return reply.send({ ok: true, block });
  });

  app.delete('/api/agenda/blocks/:id', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const params = req.params as { id?: string };
    if (!params.id) return reply.status(400).send({ error: 'block_id_required' });
    const ok = await removeBlock(params.id);
    if (!ok) return reply.status(404).send({ error: 'block_not_found' });
    return reply.send({ ok: true });
  });

  // ==== Operação ====
  app.post('/api/agenda/reserve', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as {
      leadId?: unknown;
      startIso?: unknown;
      durationMin?: unknown;
      notes?: unknown;
      notifyAdmin?: unknown;
      instance?: unknown;
    } | null;
    if (typeof body?.leadId !== 'string' || typeof body?.startIso !== 'string') {
      return reply.status(400).send({ error: 'invalid_body', message: 'leadId e startIso são obrigatórios.' });
    }
    const result = await reserveMeeting({
      leadId: body.leadId,
      startIso: body.startIso,
      durationMin: number(body.durationMin),
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      notifyAdmin: bool(body.notifyAdmin),
      instance: typeof body.instance === 'string' ? body.instance : undefined,
    });
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  app.post('/api/agenda/edit', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as {
      leadId?: unknown;
      startIso?: unknown;
      durationMin?: unknown;
      notes?: unknown;
      instance?: unknown;
    } | null;
    if (typeof body?.leadId !== 'string') {
      return reply.status(400).send({ error: 'invalid_body', message: 'leadId é obrigatório.' });
    }
    const result = await editMeeting({
      leadId: body.leadId,
      startIso: typeof body.startIso === 'string' ? body.startIso : undefined,
      durationMin: number(body.durationMin),
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      instance: typeof body.instance === 'string' ? body.instance : undefined,
    });
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  app.post('/api/agenda/cancel', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as { leadId?: unknown; motive?: unknown } | null;
    if (typeof body?.leadId !== 'string') {
      return reply.status(400).send({ error: 'invalid_body', message: 'leadId é obrigatório.' });
    }
    const result = await cancelMeeting(body.leadId, typeof body.motive === 'string' ? body.motive : undefined);
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  app.post('/api/agenda/realized', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as { leadId?: unknown } | null;
    if (typeof body?.leadId !== 'string') {
      return reply.status(400).send({ error: 'invalid_body', message: 'leadId é obrigatório.' });
    }
    const result = await markMeetingRealized(body.leadId);
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  log.info('agenda: routes registered');
}
