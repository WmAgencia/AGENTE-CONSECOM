/**
 * Vyntra SaaS — Painel Master (apenas role MASTER).
 *
 * GET    /api/master/dashboard            -> métricas reais (users, tenants, receita, requests, leads)
 * GET    /api/master/users                -> lista de usuários/tenants
 * PATCH  /api/master/users/:id            -> mudar role/status de um app_user
 * GET    /api/master/plans                -> todos os planos
 * POST   /api/master/plans                -> criar plano
 * PATCH  /api/master/plans/:id            -> atualizar plano
 * DELETE /api/master/plans/:id            -> remover plano (soft)
 * GET    /api/master/subscriptions        -> assinaturas
 * GET    /api/master/payments             -> pagamentos
 * GET    /api/master/gateways             -> gateways (sem secrets)
 * POST   /api/master/gateways             -> criar/atualizar gateway (config guardada)
 * POST   /api/master/gateways/:id/test    -> testar conexão do gateway
 * GET    /api/master/coupons              -> cupons
 * POST   /api/master/coupons              -> criar cupom
 * PATCH  /api/master/coupons/:id          -> atualizar cupom
 * DELETE /api/master/coupons/:id          -> remover cupom (soft)
 * GET    /api/master/pixels               -> pixels atuais
 * PATCH  /api/master/pixels               -> atualizar pixels
 * GET    /api/master/source-requests      -> solicitações de fonte
 * PATCH  /api/master/source-requests/:id  -> mudar status
 * GET    /api/master/audit-logs           -> auditoria
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import {
  authOf,
  requireMaster,
  serviceBaseUrl,
  serviceHeaders,
  writeAudit,
} from '../services/saas.auth.js';
import { buildGateway } from '../services/payment.gateway.js';

async function getJson<T>(path: string, select: string): Promise<T[] | null> {
  const res = await fetch(`${serviceBaseUrl()}/rest/v1${path}?select=${select}`, { headers: serviceHeaders() });
  if (!res.ok) return null;
  return (await res.json()) as T[];
}

export function registerMasterRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.addHook('preHandler', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireMaster(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
  });

  // Dashboard: métricas reais.
  app.get('/api/master/dashboard', async (_req, reply) => {
    const [appUsers, payments, subs, requests, leads] = await Promise.all([
      getJson<{ role: string; status: string }>('/app_users', 'role,status'),
      getJson<{ status: string; amount: number }>('/payments', 'status,amount'),
      getJson<{ status: string }>('/subscriptions', 'status'),
      getJson<{ status: string }>('/source_requests', 'status'),
      getJson<{ id: string }>('/leads', 'id'),
    ]);
    const revenue = (payments ?? [])
      .filter((p) => p.status === 'approved')
      .reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
    const planCount = (await getJson<{ id: string }>('/plans', 'id')) ?? [];
    return reply.send({
      users: appUsers?.length ?? 0,
      masters: appUsers?.filter((u) => u.role === 'MASTER').length ?? 0,
      actives: appUsers?.filter((u) => u.status === 'active').length ?? 0,
      tenants: (await getJson<{ id: string }>('/tenants', 'id'))?.length ?? 0,
      subscriptions: subs?.length ?? 0,
      activeSubscriptions: subs?.filter((s) => s.status === 'active').length ?? 0,
      approvedPayments: payments?.filter((p) => p.status === 'approved').length ?? 0,
      revenue,
      requests: requests?.length ?? 0,
      pendingRequests: requests?.filter((r) => r.status === 'recebida').length ?? 0,
      leads: leads?.length ?? 0,
      plans: planCount.length,
    });
  });

  // ---- Usuários ----
  app.get('/api/master/users', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>(
      '/app_users',
      'id,user_id,tenant_id,email,role,status,plan,last_login_at,created_at',
    );
    return reply.send({ users: rows ?? [] });
  });

  app.patch('/api/master/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { role?: unknown; status?: unknown };
    const patch: Record<string, unknown> = {};
    if (body.role === 'MASTER' || body.role === 'USER') patch.role = body.role;
    if (body.status === 'active' || body.status === 'blocked') patch.status = body.status;
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: 'nothing_to_update', statusCode: 400 });
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/app_users?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return reply.status(502).send({ error: 'user_update_failed', statusCode: 502 });
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'USER_UPDATED', tenantId: auth!.tenantId, targetType: 'app_user', targetIds: [id], details: patch });
    return reply.send({ ok: true });
  });

  // ---- Planos ----
  app.get('/api/master/plans', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>('/plans', '*');
    return reply.send({ plans: rows ?? [] });
  });

  app.post('/api/master/plans', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.status(400).send({ error: 'name_required', statusCode: 400 });
    const payload = {
      name,
      slug: typeof body.slug === 'string' ? body.slug : name.toLowerCase().replace(/\s+/g, '-'),
      description: typeof body.description === 'string' ? body.description : null,
      price: Number(body.price) || 0,
      currency: typeof body.currency === 'string' ? body.currency : 'BRL',
      lead_limit: Number(body.lead_limit) || 0,
      duration_days: body.duration_days == null ? null : Number(body.duration_days),
      billing_type: body.billing_type === 'recurring' ? 'recurring' : 'one_time',
      active: body.active === true,
      features: Array.isArray(body.features) ? body.features : [],
    };
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/plans?select=*`, {
      method: 'POST',
      headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return reply.status(502).send({ error: 'plan_create_failed', statusCode: 502 });
    const rows = (await res.json()) as Array<{ id: string }>;
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'PLAN_CREATED', tenantId: auth!.tenantId, targetType: 'plan', targetIds: [rows[0]?.id ?? ''], details: payload });
    return reply.send({ ok: true, id: rows[0]?.id });
  });

  app.patch('/api/master/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.slug === 'string' && body.slug.trim()) patch.slug = body.slug.trim();
    if (typeof body.description === 'string') patch.description = body.description;
    if (body.price != null) patch.price = Number(body.price) || 0;
    if (body.lead_limit != null) patch.lead_limit = Number(body.lead_limit) || 0;
    if (body.duration_days != null) patch.duration_days = Number(body.duration_days);
    if (body.active === true || body.active === false) patch.active = body.active;
    if (body.billing_type === 'one_time' || body.billing_type === 'recurring') patch.billing_type = body.billing_type;
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: 'nothing_to_update', statusCode: 400 });
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/plans?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return reply.status(502).send({ error: 'plan_update_failed', statusCode: 502 });
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'PLAN_UPDATED', tenantId: auth!.tenantId, targetType: 'plan', targetIds: [id], details: patch });
    return reply.send({ ok: true });
  });

  app.delete('/api/master/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/plans?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return reply.status(502).send({ error: 'plan_delete_failed', statusCode: 502 });
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'PLAN_DEACTIVATED', tenantId: auth!.tenantId, targetType: 'plan', targetIds: [id] });
    return reply.send({ ok: true });
  });

  // ---- Assinaturas / Pagamentos ----
  app.get('/api/master/subscriptions', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>(
      '/subscriptions',
      '*,plan:plans(name,slug,price,lead_limit)',
    );
    return reply.send({ subscriptions: rows ?? [] });
  });

  app.get('/api/master/payments', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>('/payments', '*,plan:plans(name,slug)');
    return reply.send({ payments: rows ?? [] });
  });

  // ---- Gateways ----
  app.get('/api/master/gateways', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>(
      '/payment_gateways',
      'id,provider,enabled,sandbox,active,created_at,updated_at',
    );
    return reply.send({ gateways: rows ?? [] });
  });

  app.post('/api/master/gateways', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = typeof body.provider === 'string' ? body.provider : 'mercadopago';
    const cfg = (typeof body.config === 'object' && body.config ? body.config : {}) as Record<string, unknown>;
    const accessToken = typeof cfg.accessToken === 'string' ? cfg.accessToken : typeof cfg.access_token === 'string' ? (cfg.access_token as string) : '';
    const sandbox = body.sandbox === true;
    if (!accessToken) return reply.status(400).send({ error: 'access_token_required', statusCode: 400 });

    // Verifica a conexão antes de salvar.
    const gw = buildGateway({ provider, accessToken, sandbox });
    const test = await gw.testConnection();
    if (!test.ok) return reply.status(400).send({ error: 'gateway_connection_failed', message: test.error, statusCode: 400 });

    const existing = await getJson<{ id: string }>('/payment_gateways', 'id');
    if (existing && existing.length > 0) {
      const id = existing[0].id;
      await fetch(`${serviceBaseUrl()}/rest/v1/payment_gateways?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: serviceHeaders(true),
        body: JSON.stringify({
          provider,
          sandbox,
          active: body.active === true,
          config: { accessToken },
          updated_at: new Date().toISOString(),
        }),
      });
    } else {
      await fetch(`${serviceBaseUrl()}/rest/v1/payment_gateways`, {
        method: 'POST',
        headers: serviceHeaders(true),
        body: JSON.stringify({
          provider,
          sandbox,
          enabled: true,
          active: body.active === true,
          config: { accessToken },
        }),
      });
    }
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'GATEWAY_UPDATED', tenantId: auth!.tenantId, targetType: 'gateway', targetIds: [], details: { provider, sandbox, active: body.active === true } });
    return reply.send({ ok: true });
  });

  app.post('/api/master/gateways/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await getJson<{ provider: string; sandbox: boolean; config: Record<string, unknown> }>(
      `/payment_gateways?id=eq.${encodeURIComponent(id)}`,
      'provider,sandbox,config',
    );
    const row = rows?.[0];
    if (!row) return reply.status(404).send({ error: 'gateway_not_found', statusCode: 404 });
    const accessToken =
      typeof row.config?.accessToken === 'string' ? row.config.accessToken : typeof row.config?.access_token === 'string' ? (row.config.access_token as string) : '';
    const gw = buildGateway({ provider: row.provider, accessToken, sandbox: row.sandbox });
    const test = await gw.testConnection();
    return reply.send({ ok: test.ok, error: test.error ?? null });
  });

  app.post('/api/master/gateways/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: unknown; active?: unknown };
    const patch: Record<string, unknown> = {};
    if (body.enabled === true || body.enabled === false) patch.enabled = body.enabled;
    if (body.active === true || body.active === false) patch.active = body.active;
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: 'nothing_to_update', statusCode: 400 });
    await fetch(`${serviceBaseUrl()}/rest/v1/payment_gateways?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    return reply.send({ ok: true });
  });

  // ---- Cupons ----
  app.get('/api/master/coupons', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>('/coupons', '*');
    return reply.send({ coupons: rows ?? [] });
  });

  app.post('/api/master/coupons', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!code) return reply.status(400).send({ error: 'code_required', statusCode: 400 });
    const payload = {
      code,
      discount_type: body.discount_type === 'fixed' ? 'fixed' : 'percentage',
      discount_value: Number(body.discount_value) || 0,
      valid_from: typeof body.valid_from === 'string' ? body.valid_from : null,
      valid_until: typeof body.valid_until === 'string' ? body.valid_until : null,
      usage_limit: body.usage_limit == null ? null : Number(body.usage_limit),
      active: body.active !== false,
      applicable_plan_ids: Array.isArray(body.applicable_plan_ids) ? body.applicable_plan_ids : [],
    };
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/coupons?select=*`, {
      method: 'POST',
      headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return reply.status(502).send({ error: 'coupon_create_failed', statusCode: 502 });
    const rows = (await res.json()) as Array<{ id: string }>;
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'COUPON_CREATED', tenantId: auth!.tenantId, targetType: 'coupon', targetIds: [rows[0]?.id ?? ''], details: { code } });
    return reply.send({ ok: true, id: rows[0]?.id });
  });

  app.patch('/api/master/coupons/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.code === 'string' && body.code.trim()) patch.code = body.code.trim().toUpperCase();
    if (body.discount_type === 'fixed' || body.discount_type === 'percentage') patch.discount_type = body.discount_type;
    if (body.discount_value != null) patch.discount_value = Number(body.discount_value) || 0;
    if (typeof body.valid_from === 'string') patch.valid_from = body.valid_from;
    if (typeof body.valid_until === 'string') patch.valid_until = body.valid_until;
    if (body.usage_limit != null) patch.usage_limit = Number(body.usage_limit);
    if (body.active === true || body.active === false) patch.active = body.active;
    if (Array.isArray(body.applicable_plan_ids)) patch.applicable_plan_ids = body.applicable_plan_ids;
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: 'nothing_to_update', statusCode: 400 });
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/coupons?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return reply.status(502).send({ error: 'coupon_update_failed', statusCode: 502 });
    return reply.send({ ok: true });
  });

  app.delete('/api/master/coupons/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await fetch(`${serviceBaseUrl()}/rest/v1/coupons?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
    });
    return reply.send({ ok: true });
  });

  // ---- Pixels ----
  app.get('/api/master/pixels', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>('/marketing_settings', '*');
    return reply.send({ settings: rows?.[0] ?? null });
  });

  app.patch('/api/master/pixels', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.meta_pixel_id != null) patch.meta_pixel_id = typeof body.meta_pixel_id === 'string' ? body.meta_pixel_id : null;
    if (body.meta_pixel_active === true || body.meta_pixel_active === false) patch.meta_pixel_active = body.meta_pixel_active;
    if (body.tiktok_pixel_id != null) patch.tiktok_pixel_id = typeof body.tiktok_pixel_id === 'string' ? body.tiktok_pixel_id : null;
    if (body.tiktok_pixel_active === true || body.tiktok_pixel_active === false) patch.tiktok_pixel_active = body.tiktok_pixel_active;
    if (body.meta_pixel_test_event != null) patch.meta_pixel_test_event = String(body.meta_pixel_test_event);
    if (body.tiktok_pixel_test_event != null) patch.tiktok_pixel_test_event = String(body.tiktok_pixel_test_event);
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: 'nothing_to_update', statusCode: 400 });
    const rows = await getJson<{ id: string }>('/marketing_settings', 'id');
    if (rows && rows.length > 0) {
      await fetch(`${serviceBaseUrl()}/rest/v1/marketing_settings?id=eq.${encodeURIComponent(rows[0].id)}`, {
        method: 'PATCH',
        headers: serviceHeaders(true),
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      });
    } else {
      await fetch(`${serviceBaseUrl()}/rest/v1/marketing_settings`, {
        method: 'POST',
        headers: serviceHeaders(true),
        body: JSON.stringify(patch),
      });
    }
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'PIXELS_UPDATED', tenantId: auth!.tenantId, targetType: 'marketing', targetIds: [], details: patch });
    return reply.send({ ok: true });
  });

  // ---- Solicitações de fonte ----
  app.get('/api/master/source-requests', async (_req, reply) => {
    const rows = await getJson<Record<string, unknown>>('/source_requests', '*');
    return reply.send({ requests: rows ?? [] });
  });

  app.patch('/api/master/source-requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: unknown };
    const status = typeof body.status === 'string' ? body.status : '';
    if (!['recebida', 'em_analise', 'integrada', 'recusada'].includes(status)) {
      return reply.status(400).send({ error: 'invalid_status', statusCode: 400 });
    }
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/source_requests?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return reply.status(502).send({ error: 'request_update_failed', statusCode: 502 });
    const auth = authOf(req);
    await writeAudit({ actor: auth!.userId, action: 'SOURCE_REQUEST_UPDATED', tenantId: auth!.tenantId, targetType: 'source_request', targetIds: [id], details: { status } });
    return reply.send({ ok: true });
  });

  // ---- Auditoria ----
  app.get('/api/master/audit-logs', async (req, reply) => {
    const query = req.query as { limit?: unknown };
    const limit = Math.min(Number(query.limit) || 100, 500);
    const rows = await getJson<Record<string, unknown>>(
      '/consecom_audit_log',
      `*&order=created_at.desc&limit=${limit}`,
    );
    return reply.send({ logs: rows ?? [] });
  });

  log.info('master: routes registered');
}

