/**
 * Connections routes — integrations management (WhatsApp + group notifications).
 *
 * Endpoints:
 *   GET    /api/connections/whatsapp
 *   POST   /api/connections/whatsapp/connect
 *   POST   /api/connections/whatsapp/qr
 *   DELETE /api/connections/whatsapp
 *   GET    /api/connections/groups
 *   GET    /api/connections/whatsapp/groups
 *   POST   /api/connections/groups/test
 *   GET    /api/connections/settings
 *   PATCH  /api/connections/settings
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import {
  getUserConnection,
  createInstanceForUser,
  regenerateQRCode,
  disconnectInstance,
  fetchUserGroups,
  sendTestMessage,
  getWorkspaceAndUser,
} from '../services/evolution.connections.js';

function auth(req: { headers: Record<string, string | string[] | undefined> }) {
  const { workspaceId, userId } = getWorkspaceAndUser(req);
  // Multi-tenant: prefer workspace_id; fallback to user_id (single-tenant).
  return {
    workspaceId,
    userId,
    identifier: workspaceId ?? userId,
  };
}

export function registerConnectionsRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/connections/whatsapp', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const conn = await getUserConnection(identifier);
    return reply.send({ connection: conn });
  });

  app.post('/api/connections/whatsapp/connect', async (req, reply) => {
    const { workspaceId, userId, identifier } = auth(req);
    if (!identifier || !userId) return reply.status(401).send({ error: 'unauthorized' });

    const existing = await getUserConnection(identifier);
    if (existing && existing.status === 'connected') {
      return reply.send({ connection: existing });
    }

    const result = await createInstanceForUser(userId, workspaceId);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'create_failed' });
    }
    const conn = await getUserConnection(identifier);
    return reply.send({ connection: conn, qrCode: result.qrCode });
  });

  app.post('/api/connections/whatsapp/qr', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const result = await regenerateQRCode(identifier);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'qr_failed' });
    }
    return reply.send({ qrCode: result.qrCode });
  });

  app.delete('/api/connections/whatsapp', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const result = await disconnectInstance(identifier);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'disconnect_failed' });
    }
    return reply.send({ ok: true });
  });

  app.get('/api/connections/whatsapp/groups', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const result = await fetchUserGroups(identifier);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'groups_failed' });
    }
    return reply.send({ groups: result.groups });
  });

  app.post('/api/connections/groups/test', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const body = req.body as { groupId?: string } | null;
    if (!body?.groupId) return reply.status(400).send({ error: 'groupId_required' });
    const result = await sendTestMessage(identifier, body.groupId);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'test_failed' });
    }
    return reply.send({ ok: true });
  });

  log.info('connections: routes registered');
}
