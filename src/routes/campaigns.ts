/**
 * Campaign schedule routes — agendamento de campanhas (painel).
 *
 * Auth: x-user-id / x-workspace-id (mesmo padrão das rotas de agenda/metas).
 *
 * GET    /api/campaigns/schedule/config                 → configuração central
 * PUT    /api/campaigns/schedule/config                 → salvar configuração
 * GET    /api/campaigns/schedule                        → campanhas agendadas
 * GET    /api/campaigns/schedule/next?campaignId=&afterMs= → próximo início livre
 * POST   /api/campaigns/schedule/validate               → validar horário (conflito)
 * POST   /api/campaigns/schedule                        → agendar campanha
 * DELETE /api/campaigns/schedule/:id                    → cancelar agendamento
 * GET    /api/campaigns/schedule/calendar?start=&end=   → ocupação no calendário
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getWorkspaceAndUser } from '../services/evolution.connections.js';
import {
  loadScheduleConfig,
  saveScheduleConfig,
  validateSchedule,
  scheduleCampaign,
  cancelScheduledCampaign,
  listScheduledCampaigns,
  getCampaignCalendar,
  nextAvailableStart,
  estimateDurationMinutes,
  type CampaignScheduleConfig,
} from '../services/campaign.schedule.service.js';

function identifier(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const { workspaceId, userId } = getWorkspaceAndUser(req);
  return workspaceId ?? userId;
}

function requireIdentifier(req: unknown, reply: { status: (c: number) => { send: (b: unknown) => void } }): string | null {
  const id = identifier(req as { headers: Record<string, string | string[] | undefined> });
  if (!id) {
    reply.status(401).send({ error: 'unauthorized' });
    return null;
  }
  return id;
}

function number(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerCampaignScheduleRoutes(app: FastifyInstance): void {
  const log = getLogger();

  // ==== Configuração central (intervalo entre campanhas) ====
  app.get('/api/campaigns/schedule/config', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const config = await loadScheduleConfig();
    return reply.send({ config });
  });

  app.put('/api/campaigns/schedule/config', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as Partial<CampaignScheduleConfig> | null;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    const patch: Partial<CampaignScheduleConfig> = {};
    if (body.interval_min != null) patch.interval_min = Number(body.interval_min);
    if (body.avg_seconds_per_msg != null) patch.avg_seconds_per_msg = Number(body.avg_seconds_per_msg);
    if (body.min_duration_min != null) patch.min_duration_min = Number(body.min_duration_min);
    const config = await saveScheduleConfig(patch);
    if (!config) return reply.status(502).send({ error: 'save_failed' });
    return reply.send({ ok: true, config });
  });

  // ==== Lista de agendadas ====
  app.get('/api/campaigns/schedule', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const items = await listScheduledCampaigns();
    return reply.send({ items });
  });

  // ==== Próximo início livre (sugestão para o modal) ====
  app.get('/api/campaigns/schedule/next', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const q = req.query as { campaignId?: string; afterMs?: string };
    if (!q.campaignId) {
      return reply.status(400).send({ error: 'campaign_required', message: 'Informe campaignId.' });
    }
    const afterMs = number(q.afterMs) ?? Date.now();
    const config = await loadScheduleConfig();
    const durationMin = await estimateDurationMinutes(q.campaignId);
    const nextStart = await nextAvailableStart({ afterMs, durationMin, excludeCampaignId: q.campaignId });
    return reply.send({
      config,
      durationMin,
      nextAvailableStart: new Date(nextStart).toISOString(),
    });
  });

  // ==== Validar horário ====
  app.post('/api/campaigns/schedule/validate', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as { campaignId?: unknown; startIso?: unknown } | null;
    if (typeof body?.campaignId !== 'string' || typeof body?.startIso !== 'string') {
      return reply.status(400).send({ error: 'invalid_body', message: 'campaignId e startIso são obrigatórios.' });
    }
    const result = await validateSchedule({ campaignId: body.campaignId, startIso: body.startIso });
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  // ==== Agendar ====
  app.post('/api/campaigns/schedule', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const body = req.body as { campaignId?: unknown; startIso?: unknown } | null;
    if (typeof body?.campaignId !== 'string' || typeof body?.startIso !== 'string') {
      return reply.status(400).send({ error: 'invalid_body', message: 'campaignId e startIso são obrigatórios.' });
    }
    const result = await scheduleCampaign({ campaignId: body.campaignId, startIso: body.startIso });
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  // ==== Cancelar agendamento ====
  app.delete('/api/campaigns/schedule/:id', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const params = req.params as { id?: string };
    if (!params.id) return reply.status(400).send({ error: 'campaign_id_required' });
    const result = await cancelScheduledCampaign(params.id);
    return reply.status(result.ok ? 200 : 409).send(result);
  });

  // ==== Calendário (ocupação de campanhas) ====
  app.get('/api/campaigns/schedule/calendar', async (req, reply) => {
    const id = requireIdentifier(req, reply);
    if (!id) return;
    const q = req.query as { start?: string; end?: string };
    const start = q.start ?? '';
    const end = q.end ?? '';
    if (!start || !end) {
      return reply.status(400).send({ error: 'range_required', message: 'Informe start e end (YYYY-MM-DD).' });
    }
    const items = await getCampaignCalendar(start, end);
    return reply.send({ items });
  });

  log.info('campaign-schedule: routes registered');
}
