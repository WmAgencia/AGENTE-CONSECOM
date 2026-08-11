/**
 * Commercial Intelligence routes — Metas e Inteligência Comercial.
 *
 *   GET  /api/commercial/dashboard  -> meta + projeção + resultados reais
 *   GET  /api/commercial/goal       -> meta persistida do usuário/workspace
 *   PUT  /api/commercial/goal       -> salva/atualiza a meta
 *   POST /api/commercial/simulate   -> calcula a projeção sem persistir (calculadora)
 *
 * Auth: x-user-id / x-workspace-id (mesmo padrão das demais rotas).
 * Todo cálculo vem de commercial.service.ts (fonte única de verdade).
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getWorkspaceAndUser } from '../services/evolution.connections.js';
import {
  buildCommercialDashboard,
  computeProjection,
  fetchGoal,
  upsertGoal,
  type GoalInput,
} from '../services/commercial.service.js';

function identifier(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const { workspaceId, userId } = getWorkspaceAndUser(req);
  return workspaceId ?? userId;
}

const PERIODS = [30, 60, 90];

function parseGoalInput(body: unknown): GoalInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const goal_amount = Number(b.goal_amount);
  const avg_ticket = Number(b.avg_ticket);
  const meeting_close_rate = Number(b.meeting_close_rate);
  const period_days = Number(b.period_days);
  if (
    !Number.isFinite(goal_amount) || goal_amount <= 0 ||
    !Number.isFinite(avg_ticket) || avg_ticket <= 0 ||
    !Number.isFinite(meeting_close_rate) || meeting_close_rate < 0 || meeting_close_rate > 100 ||
    !PERIODS.includes(period_days)
  ) {
    return null;
  }
  const leads_per_day_raw = b.leads_per_day;
  const leads_per_day =
    leads_per_day_raw == null || leads_per_day_raw === '' || leads_per_day_raw === 0
      ? null
      : Number(leads_per_day_raw);
  if (leads_per_day != null && (!Number.isFinite(leads_per_day) || leads_per_day <= 0)) {
    return null;
  }
  return {
    goal_amount,
    period_days: period_days as 30 | 60 | 90,
    avg_ticket,
    meeting_close_rate,
    leads_per_day,
  };
}

export function registerCommercialRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/commercial/goal', async (req, reply) => {
    const id = identifier(req);
    if (!id) return reply.status(401).send({ error: 'unauthorized' });
    const goal = await fetchGoal(id);
    if (!goal) return reply.status(404).send({ error: 'goal_not_found' });
    return reply.send({ goal });
  });

  app.put('/api/commercial/goal', async (req, reply) => {
    const id = identifier(req);
    if (!id) return reply.status(401).send({ error: 'unauthorized' });
    const input = parseGoalInput(req.body);
    if (!input) return reply.status(400).send({ error: 'invalid_goal', message: 'Meta inválida. Confira meta de faturamento, período, ticket médio e conversão.' });
    const goal = await upsertGoal(id, input);
    if (!goal) return reply.status(502).send({ error: 'goal_save_failed' });
    log.info({ userId: id }, 'commercial: goal saved');
    return reply.send({ ok: true, goal });
  });

  app.post('/api/commercial/simulate', async (req, reply) => {
    const id = identifier(req);
    if (!id) return reply.status(401).send({ error: 'unauthorized' });
    const input = parseGoalInput(req.body);
    if (!input) return reply.status(400).send({ error: 'invalid_goal' });
    return reply.send({ projection: computeProjection(input) });
  });

  app.get('/api/commercial/dashboard', async (req, reply) => {
    const id = identifier(req);
    if (!id) return reply.status(401).send({ error: 'unauthorized' });
    const data = await buildCommercialDashboard(id);
    if (!data) return reply.status(502).send({ error: 'dashboard_failed' });
    return reply.send(data);
  });

  log.info('commercial: routes registered');
}
