import type { FastifyInstance } from 'fastify';
import { getWorkspaceAndUser } from '../services/evolution.connections.js';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { createFollowUp, listFollowUps, updateFollowUp } from '../services/followup.service.js';

function actor(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const { workspaceId, userId } = getWorkspaceAndUser(req);
  return workspaceId ?? userId;
}

export function registerFollowUpRoutes(app: FastifyInstance): void {
  app.get('/api/follow-ups', async (req, reply) => {
    const ownerId = actor(req);
    if (!ownerId) return reply.status(401).send({ error: 'unauthorized' });
    const q = req.query as { leadId?: string; start?: string; end?: string };
    const followUps = await listFollowUps({ leadId: q.leadId, start: q.start, end: q.end, ownerId });
    return reply.send({ followUps });
  });

  app.post('/api/follow-ups', async (req, reply) => {
    const ownerId = actor(req);
    if (!ownerId) return reply.status(401).send({ error: 'unauthorized' });
    const body = req.body as Record<string, unknown> | null;
    const leadId = typeof body?.leadId === 'string' ? body.leadId : '';
    const date = typeof body?.scheduledDate === 'string' ? body.scheduledDate : '';
    const time = typeof body?.scheduledTime === 'string' && body.scheduledTime ? body.scheduledTime : null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!leadId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !message) {
      return reply.status(400).send({ error: 'invalid_body', message: 'leadId, data e mensagem são obrigatórios.' });
    }
    const idempotency = typeof body?.idempotencyKey === 'string' && body.idempotencyKey
      ? body.idempotencyKey
      : `operator:${leadId}:${date}:${time ?? 'sem-horario'}:${message}`;
    const row = await createFollowUp({
      lead_id: leadId,
      owner_user_id: ownerId,
      scheduled_date: date,
      scheduled_time: time,
      message,
      source: 'operador',
      connection_id: typeof body?.connectionId === 'string' ? body.connectionId : null,
      connection_instance: typeof body?.connectionInstance === 'string' ? body.connectionInstance : null,
      conversation_id: typeof body?.conversationId === 'string' ? body.conversationId : `wa:lead:${leadId}`,
      origin_context: typeof body?.originContext === 'string' ? body.originContext : null,
      idempotency_key: idempotency,
    });
    if (!row) return reply.status(502).send({ error: 'save_failed', message: 'Falha ao salvar o follow-up.' });
    const c = getSupabaseProspeccaoConfig();
    if (c.url && c.serviceRoleKey) {
      await fetch(`${c.url}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
        method: 'PATCH',
        headers: { apikey: c.serviceRoleKey, Authorization: `Bearer ${c.serviceRoleKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'responder_depois', updated_at: new Date().toISOString() }),
      });
    }
    return reply.send({ ok: true, followUp: row });
  });

  app.patch('/api/follow-ups/:id', async (req, reply) => {
    const ownerId = actor(req);
    if (!ownerId) return reply.status(401).send({ error: 'unauthorized' });
    const id = (req.params as { id?: string }).id;
    const body = req.body as Record<string, unknown> | null;
    if (!id) return reply.status(400).send({ error: 'id_required' });
    const patch = {
      scheduled_date: typeof body?.scheduledDate === 'string' ? body.scheduledDate : undefined,
      scheduled_time: typeof body?.scheduledTime === 'string' ? body.scheduledTime : null,
      message: typeof body?.message === 'string' ? body.message.trim() : undefined,
      status: body?.status === 'cancelado' ? 'cancelado' as const : undefined,
    };
    const ok = await updateFollowUp(id, patch);
    if (ok && patch.status === 'cancelado') {
      const c = getSupabaseProspeccaoConfig();
      if (c.url && c.serviceRoleKey) {
        // O lead deixa a coluna de follow-up quando o único agendamento ativo é cancelado.
        const followUp = await listFollowUps({});
        const current = followUp.find((item) => item.id === id);
        if (current) {
          await fetch(`${c.url}/rest/v1/leads?id=eq.${encodeURIComponent(current.lead_id)}&status=eq.responder_depois`, {
            method: 'PATCH',
            headers: { apikey: c.serviceRoleKey, Authorization: `Bearer ${c.serviceRoleKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'conversando', updated_at: new Date().toISOString() }),
          });
        }
      }
    }
    return reply.status(ok ? 200 : 404).send({ ok });
  });
}
