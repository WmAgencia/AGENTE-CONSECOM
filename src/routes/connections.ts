/**
 * Connections routes — integrations management (WhatsApp + group notifications).
 *
 * Endpoints:
 *   GET    /api/connections/whatsapp
 *   POST   /api/connections/whatsapp/connect
 *   POST   /api/connections/whatsapp/qr
 *   POST   /api/connections/whatsapp/connect/refresh   (alias do /qr)
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
  getUserConnections,
  createInstanceForUser,
  regenerateQRCode,
  disconnectInstance,
  fetchUserGroups,
  sendTestMessage,
  getWorkspaceAndUser,
  type ConnectionTarget,
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

function readTarget(body: unknown): ConnectionTarget | undefined {
  const b = (body ?? {}) as { id?: unknown; instanceName?: unknown };
  const target: ConnectionTarget = {};
  if (typeof b.id === 'string' && b.id) target.id = b.id;
  if (typeof b.instanceName === 'string' && b.instanceName) target.instanceName = b.instanceName;
  return Object.keys(target).length > 0 ? target : undefined;
}

export function registerConnectionsRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/connections/whatsapp', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const connections = await getUserConnections(identifier);
    const conn = await getUserConnection(identifier);
    return reply.send({ connections, connection: conn });
  });

  app.post('/api/connections/whatsapp/connect', async (req, reply) => {
    const { workspaceId, userId, identifier } = auth(req);
    if (!identifier || !userId) return reply.status(401).send({ error: 'unauthorized' });

    const body = (req.body ?? {}) as { forceNew?: boolean };
    const forceNew = body.forceNew === true;

    // Sem forceNew: reutiliza conexão existente (connected/connecting/pending).
    if (!forceNew) {
      const existing = await getUserConnection(identifier);
      if (existing && ['connected', 'connecting', 'pending'].includes(existing.status)) {
        return reply.send({ connection: existing });
      }
    }

    const result = await createInstanceForUser(userId, workspaceId);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'create_failed' });
    }
    return reply.send({ connection: result.connection, qrCode: result.qrCode });
  });

  app.post('/api/connections/whatsapp/qr', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const target = readTarget(req.body);
    const result = await regenerateQRCode(identifier, target);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'qr_failed' });
    }
    return reply.send({ connection: result.connection, qrCode: result.qrCode });
  });

  // Alias semântico de /qr — rota "refresh" pedida no spec.
  app.post('/api/connections/whatsapp/connect/refresh', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const target = readTarget(req.body);
    const result = await regenerateQRCode(identifier, target);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'qr_failed' });
    }
    return reply.send({ connection: result.connection, qrCode: result.qrCode, status: 'connecting' });
  });

  app.delete('/api/connections/whatsapp', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const target = readTarget(req.body);
    const result = await disconnectInstance(identifier, target);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'disconnect_failed' });
    }
    return reply.send({ ok: true, connection: result.connection });
  });

  app.get('/api/connections/whatsapp/groups', async (req, reply) => {
    const { identifier } = auth(req);
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });
    const target = readTarget(req.query);
    const result = await fetchUserGroups(identifier, target);
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
    const target = readTarget(body);
    const result = await sendTestMessage(identifier, body.groupId, target);
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'test_failed' });
    }
    return reply.send({ ok: true });
  });

  log.info('connections: routes registered');
}
