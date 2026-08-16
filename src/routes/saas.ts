/**
 * Vyntra SaaS — rotas do usuário.
 *
 * GET   /api/saas/me                    -> perfil + plano + uso
 * GET   /api/saas/plans                 -> catálogo de planos ativos
 * POST  /api/saas/checkout              -> cria pagamento + checkout do gateway
 * POST  /api/saas/coupons/validate      -> valida cupom contra um plano
 * POST  /api/saas/webhook/payments      -> webhook de pagamento (idempotente)
 * POST  /api/account/password           -> alterar senha (Supabase Auth)
 * POST  /api/source-requests            -> landing: enviar URL de fonte (público)
 * GET   /api/public/pixels              -> pixels ativos (público, landing)
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { extractBearerToken } from '../utils/auth.js';
import {
  authOf,
  requireAuth,
  serviceBaseUrl,
  serviceHeaders,
  writeAudit,
} from '../services/saas.auth.js';
import {
  listPlans,
  getPlan,
  getActiveSubscription,
  getUsageInfo,
  getActiveGateway,
  validateCoupon,
  createPayment,
  setPaymentGatewayIds,
  findPaymentByGatewayPaymentId,
  findPaymentByIdempotencyKey,
  processApprovedPayment,
  updatePaymentStatus,
} from '../services/saas.js';
import { SandboxGateway } from '../services/payment.gateway.js';

const URL_SCHEMA = new URL('https://example.com');
function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

function randomKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerSaaSRoutes(app: FastifyInstance): void {
  const log = getLogger();
  void URL_SCHEMA;

  app.get('/api/saas/me', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
    const a = auth!;
    const [usage, subscription, plan] = await Promise.all([
      getUsageInfo(a.tenantId),
      getActiveSubscription(a.tenantId),
      (async () => {
        const sub = await getActiveSubscription(a.tenantId);
        return sub ? getPlan(sub.plan_id) : null;
      })(),
    ]);
    return reply.send({
      user: { id: a.userId, email: a.email, role: a.role, status: a.status },
      tenantId: a.tenantId,
      subscription,
      plan,
      usage,
    });
  });

  app.get('/api/saas/plans', async (_req, reply) => {
    const plans = await listPlans(true);
    return reply.send({ plans });
  });

  app.post('/api/saas/coupons/validate', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
    const body = (req.body ?? {}) as { code?: unknown; planId?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const planId = typeof body.planId === 'string' ? body.planId : '';
    if (!planId) return reply.status(400).send({ error: 'plan_id_required', statusCode: 400 });
    const plan = await getPlan(planId);
    if (!plan || !plan.active) return reply.status(400).send({ error: 'plan_not_found', statusCode: 400 });
    const result = await validateCoupon(code, plan);
    if (!result.ok) return reply.status(400).send({ error: result.error, statusCode: 400 });
    return reply.send({
      ok: true,
      code: result.coupon.code,
      discountType: result.coupon.discount_type,
      discountValue: result.coupon.discount_value,
      discountAmount: result.discountAmount,
      total: Math.max(0, Math.round((plan.price - result.discountAmount) * 100) / 100),
    });
  });

  app.post('/api/saas/checkout', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
    const a = auth!;

    const body = (req.body ?? {}) as {
      planId?: unknown;
      couponCode?: unknown;
      backUrl?: unknown;
    };
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const couponCode = typeof body.couponCode === 'string' ? body.couponCode.trim() : '';
    const backUrl = typeof body.backUrl === 'string' ? body.backUrl : undefined;
    if (!planId) return reply.status(400).send({ error: 'plan_id_required', statusCode: 400 });

    const plan = await getPlan(planId);
    if (!plan || !plan.active) {
      return reply.status(400).send({ error: 'plan_not_found', statusCode: 400 });
    }

    let discountAmount = 0;
    if (couponCode) {
      const result = await validateCoupon(couponCode, plan);
      if (!result.ok) return reply.status(400).send({ error: result.error, statusCode: 400 });
      discountAmount = result.discountAmount;
    }

    const idempotencyKey = randomKey();
    const payment = await createPayment({
      tenantId: a.tenantId,
      planId,
      amount: plan.price,
      discountAmount,
      couponCode: couponCode || null,
      gateway: 'sandbox',
      idempotencyKey,
    });
    if (!payment) {
      return reply.status(502).send({ error: 'payment_create_failed', statusCode: 502 });
    }

    const gateway = (await getActiveGateway()) ?? new SandboxGateway();
    const checkout = await gateway.createCheckout({
      externalId: payment.id,
      amount: plan.price,
      discountAmount,
      planName: plan.name,
      payerEmail: a.email,
      notificationUrl: undefined,
      backUrl,
    });
    if (!checkout.ok) {
      await updatePaymentStatus(payment.id, 'rejected');
      return reply.status(502).send({ error: 'checkout_failed', message: checkout.error, statusCode: 502 });
    }
    if (checkout.gatewayPaymentId) {
      await setPaymentGatewayIds(payment.id, {
        gatewayPaymentId: checkout.gatewayPaymentId,
        gatewayPreferenceId: checkout.gatewayPreferenceId,
      });
    }

    // Sandbox: simula aprovação imediata para o fluxo funcionar ponta a ponta.
    if (gateway.provider === 'sandbox') {
      await processApprovedPayment(payment.id);
    }

    await writeAudit({
      actor: a.userId,
      action: 'PAYMENT_CREATED',
      tenantId: a.tenantId,
      targetType: 'payment',
      targetIds: [payment.id],
      details: { plan_id: planId, amount: plan.price, discount: discountAmount, gateway: gateway.provider },
    });

    return reply.send({
      ok: true,
      paymentId: payment.id,
      checkoutUrl: checkout.checkoutUrl ?? null,
      provider: gateway.provider,
    });
  });

  app.post('/api/saas/webhook/payments', async (req, reply) => {
    const gateway = (await getActiveGateway()) ?? new SandboxGateway();
    const parsed = await gateway.parseWebhook(req.body ?? {});
    const payment =
      (parsed.externalReference ? await findPaymentByIdempotencyKey(parsed.externalReference) : null) ??
      (await findPaymentByIdempotencyKey(parsed.gatewayPaymentId ?? '')) ??
      (parsed.gatewayPaymentId ? await findPaymentByGatewayPaymentId(parsed.gatewayPaymentId) : null);
    if (!payment) {
      log.warn({ gateway: gateway.provider }, 'saas: webhook sem pagamento correspondente');
      return reply.send({ ok: true, processed: false });
    }
    switch (parsed.status) {
      case 'approved':
        await processApprovedPayment(payment.id);
        break;
      case 'rejected':
      case 'cancelled':
        await updatePaymentStatus(payment.id, parsed.status);
        break;
      case 'refunded':
        await updatePaymentStatus(payment.id, 'refunded');
        break;
      default:
        break; // pending: aguarda confirmação
    }
    return reply.send({ ok: true, processed: true });
  });

  app.post('/api/account/password', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });

    const s = getSupabaseProspeccaoConfig();
    if (!s.url || !s.serviceRoleKey) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });

    const authHeader = req.headers.authorization;
    const token = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);
    if (!token) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });

    const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown };
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    const confirm = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
    if (!current) return reply.status(400).send({ error: 'current_password_required', statusCode: 400 });
    if (!next) return reply.status(400).send({ error: 'new_password_required', statusCode: 400 });
    if (next !== confirm) return reply.status(400).send({ error: 'password_mismatch', statusCode: 400 });
    if (next.length < 8) return reply.status(400).send({ error: 'password_too_short', statusCode: 400 });

    // 1) Valida a senha atual via token grant (mesma do login).
    try {
      const verify = await fetch(`${s.url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: serviceHeaders(true),
        body: JSON.stringify({ email: auth!.email, password: current }),
      });
      if (!verify.ok) {
        await writeAudit({ actor: auth!.userId, action: 'PASSWORD_CHANGE_FAILED', tenantId: auth!.tenantId, details: { reason: 'invalid_current' } });
        return reply.status(403).send({ error: 'invalid_current_password', statusCode: 403 });
      }
    } catch {
      return reply.status(502).send({ error: 'password_check_failed', statusCode: 502 });
    }

    // 2) Altera a senha usando o token atual.
    const update = await fetch(`${s.url}/auth/v1/user`, {
      method: 'PUT',
      headers: serviceHeaders(true),
      body: JSON.stringify({ password: next }),
    });
    if (!update.ok) {
      return reply.status(502).send({ error: 'password_update_failed', statusCode: 502 });
    }
    await writeAudit({ actor: auth!.userId, action: 'PASSWORD_CHANGED', tenantId: auth!.tenantId });
    return reply.send({ ok: true });
  });

  // Landing pública: aceita SOMENTE URLs http(s).
  app.post('/api/source-requests', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: unknown; email?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url || !isValidHttpUrl(url)) {
      return reply.status(400).send({ error: 'url_invalid', message: 'Envie uma URL válida (ex.: https://exemplo.com).', statusCode: 400 });
    }
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;

    const auth = authOf(req);
    const tenantId = auth && !auth.blocked ? auth.tenantId : null;
    const res = await fetch(`${serviceBaseUrl()}/rest/v1/source_requests?select=*`, {
      method: 'POST',
      headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
      body: JSON.stringify({
        url,
        tenant_id: tenantId,
        requested_by: auth ? auth.email : email,
        status: 'recebida',
      }),
    });
    if (!res.ok) return reply.status(502).send({ error: 'request_create_failed', statusCode: 502 });
    const rows = (await res.json()) as Array<{ id: string }>;
    return reply.send({ ok: true, id: rows[0]?.id, message: 'Solicitação recebida. Vamos analisar!' });
  });

  // Pixels ativos para a landing page (apenas IDs de pixel — não secretos).
  app.get('/api/public/pixels', async (_req, reply) => {
    try {
      const res = await fetch(
        `${serviceBaseUrl()}/rest/v1/marketing_settings?select=meta_pixel_id,meta_pixel_active,tiktok_pixel_id,tiktok_pixel_active&limit=1`,
        { headers: serviceHeaders() },
      );
      if (!res.ok) return reply.send({ meta: null, tiktok: null });
      const rows = (await res.json()) as Array<{
        meta_pixel_id: string | null;
        meta_pixel_active: boolean;
        tiktok_pixel_id: string | null;
        tiktok_pixel_active: boolean;
      }>;
      const s = rows[0] ?? {};
      return reply.send({
        meta: s.meta_pixel_active ? s.meta_pixel_id ?? null : null,
        tiktok: s.tiktok_pixel_active ? s.tiktok_pixel_id ?? null : null,
      });
    } catch {
      return reply.send({ meta: null, tiktok: null });
    }
  });

  log.info('saas: routes registered');
}