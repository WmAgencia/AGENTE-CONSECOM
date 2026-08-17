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
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { getEnv, getSupabaseProspeccaoConfig } from '../config/env.js';
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
  getPlanBySlug,
  getActiveSubscription,
  getUsageInfo,
  getLeadsBalance,
  listCreditLedger,
  getActiveGateway,
  getActiveGatewayPublicKey,
  getActiveGatewayWebhookSecret,
  validateCoupon,
  createPayment,
  setPaymentGatewayIds,
  findPaymentByGatewayPaymentId,
  findPaymentById,
  findPaymentByIdempotencyKey,
  processApprovedPayment,
  updatePaymentStatus,
  activateTrialSubscription,
} from '../services/saas.js';
import { SandboxGateway } from '../services/payment.gateway.js';
import { attemptTrialRedemption, hasRedeemedTrial } from '../services/trial.js';

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
    const [usage, subscription, plan, balance, trialUsed, ledger] = await Promise.all([
      getUsageInfo(a.tenantId),
      getActiveSubscription(a.tenantId),
      (async () => {
        const sub = await getActiveSubscription(a.tenantId);
        return sub ? getPlan(sub.plan_id) : null;
      })(),
      getLeadsBalance(a.tenantId),
      hasRedeemedTrial(a.userId),
      listCreditLedger(a.tenantId, 25),
    ]);
    return reply.send({
      user: { id: a.userId, email: a.email, username: a.username, role: a.role, status: a.status },
      tenantId: a.tenantId,
      subscription,
      plan,
      usage,
      balance,
      trialUsed,
      ledger,
    });
  });

  /** Histórico de compras + consumo de leads (credit_ledger). */
  app.get('/api/saas/transactions', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
    const a = auth!;
    const ledger = await listCreditLedger(a.tenantId, 100);
    return reply.send({ transactions: ledger });
  });

  /**
   * Resgata o plano TESTE (anti-abuso no backend).
   * body: { deviceId?: string, phone?: string }
   */
  app.post('/api/saas/trial/redeem', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
    const a = auth!;

    const body = (req.body ?? {}) as { deviceId?: unknown; phone?: unknown };
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 128) : null;
    const phone = typeof body.phone === 'string' ? body.phone : null;

    const plan = await getPlanBySlug('teste');
    if (!plan || !plan.active) {
      return reply.status(404).send({ error: 'plan_not_found', statusCode: 404 });
    }

    const result = await attemptTrialRedemption(
      {
        userId: a.userId,
        tenantId: a.tenantId,
        email: a.email,
        phone,
        ip: req.ip ?? '0.0.0.0',
        deviceId,
      },
      plan.id,
    );
    if (!result.ok) {
      return reply.status(result.statusCode).send({
        error: result.error,
        message: result.message,
        statusCode: result.statusCode,
      });
    }

    const sub = await activateTrialSubscription(a.tenantId, plan.id);
    if (!sub) {
      return reply.status(502).send({ error: 'trial_activation_failed', statusCode: 502 });
    }

    const usage = await getUsageInfo(a.tenantId);
    const balance = await getLeadsBalance(a.tenantId);
    return reply.send({ ok: true, subscription: sub, plan, usage, balance });
  });

  app.get('/api/saas/plans', async (_req, reply) => {
    const plans = await listPlans(true);
    return reply.send({ plans });
  });

  app.post('/api/public/checkout', async (req, reply) => {
    const body = (req.body ?? {}) as { planId?: unknown; name?: unknown; email?: unknown; password?: unknown; cpf?: unknown; phone?: unknown; method?: unknown; paymentMethodId?: unknown; cardToken?: unknown; installments?: unknown; issuerId?: unknown; couponCode?: unknown };
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const cpf = typeof body.cpf === 'string' ? body.cpf.replace(/\D/g, '') : '';
    const method = body.method === 'pix' ? 'pix' : 'card';
    if (!planId || !name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || cpf.length !== 11) return reply.status(400).send({ error: 'checkout_fields_invalid', message: 'Informe nome, e-mail, senha de 8 caracteres e CPF válido.', statusCode: 400 });
    const plan = await getPlan(planId);
    if (!plan || !plan.active) return reply.status(400).send({ error: 'plan_not_found', statusCode: 400 });
    const sup = getSupabaseProspeccaoConfig();
    if (!sup.url || !sup.serviceRoleKey) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    const created = await fetch(`${sup.url.replace(/\/$/, '')}/auth/v1/admin/users`, { method: 'POST', headers: serviceHeaders(true), body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: name, cpf } }) });
    if (!created.ok) return reply.status(400).send({ error: 'account_create_failed', message: 'Não foi possível criar a conta. Verifique se o e-mail já está cadastrado.', statusCode: 400 });
    const authUser = (await created.json()) as { id?: string };
    const appUserRes = await fetch(`${sup.url.replace(/\/$/, '')}/rest/v1/app_users?select=tenant_id&id=eq.${encodeURIComponent(authUser.id ?? '')}&limit=1`, { headers: serviceHeaders() });
    const appUsers = (await appUserRes.json()) as Array<{ tenant_id: string }>;
    const tenantId = appUsers[0]?.tenant_id;
    if (!tenantId) return reply.status(502).send({ error: 'account_profile_failed', statusCode: 502 });
    let discountAmount = 0;
    const couponCode = typeof body.couponCode === 'string' ? body.couponCode.trim() : '';
    if (couponCode) { const coupon = await validateCoupon(couponCode, plan); if (!coupon.ok) return reply.status(400).send({ error: coupon.error, statusCode: 400 }); discountAmount = coupon.discountAmount; }
    const gateway = (await getActiveGateway()) ?? new SandboxGateway();
    if (!gateway.createTransparentPayment) return reply.status(503).send({ error: 'transparent_checkout_unavailable', statusCode: 503 });
    const payment = await createPayment({ tenantId, planId, amount: plan.price, discountAmount, couponCode: couponCode || null, gateway: gateway.provider, idempotencyKey: randomKey() });
    if (!payment) return reply.status(502).send({ error: 'payment_create_failed', statusCode: 502 });
    const result = await gateway.createTransparentPayment({ externalId: payment.id, amount: Math.max(0, Math.round((plan.price - discountAmount) * 100) / 100), planName: plan.name, payerEmail: email, cpf, phone: typeof body.phone === 'string' ? body.phone : undefined, paymentMethodId: typeof body.paymentMethodId === 'string' ? body.paymentMethodId : method === 'pix' ? 'pix' : '', cardToken: typeof body.cardToken === 'string' ? body.cardToken : undefined, installments: typeof body.installments === 'number' ? body.installments : 1, issuerId: typeof body.issuerId === 'string' ? body.issuerId : undefined, notificationUrl: `${getEnv().PUBLIC_BACKEND_URL}/api/saas/webhook/payments`, idempotencyKey: randomKey() });
    if (!result.ok) return reply.status(502).send({ error: 'payment_failed', message: result.error, statusCode: 502 });
    if (result.gatewayPaymentId) await setPaymentGatewayIds(payment.id, { gatewayPaymentId: result.gatewayPaymentId });
    if (result.status === 'approved') await processApprovedPayment(payment.id);
    return reply.send({ ok: true, userId: authUser.id, paymentId: payment.id, status: result.status, qrCode: result.qrCode ?? null, qrCodeBase64: result.qrCodeBase64 ?? null, ticketUrl: result.ticketUrl ?? null });
  });

  app.get('/api/saas/payment/public-key', async (_req, reply) => {
    return reply.send({ provider: 'mercadopago', publicKey: await getActiveGatewayPublicKey() });
  });

  app.post('/api/saas/transparent-payment', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });
    const body = (req.body ?? {}) as { planId?: unknown; couponCode?: unknown; method?: unknown; cpf?: unknown; phone?: unknown; email?: unknown; paymentMethodId?: unknown; cardToken?: unknown; installments?: unknown; issuerId?: unknown };
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const method = body.method === 'pix' ? 'pix' : 'card';
    const cpf = typeof body.cpf === 'string' ? body.cpf.replace(/\D/g, '') : '';
    const payerEmail = typeof body.email === 'string' && /@/.test(body.email) ? body.email.trim() : auth!.email;
    if (!planId || cpf.length !== 11) return reply.status(400).send({ error: 'plan_and_cpf_required', statusCode: 400 });
    const plan = await getPlan(planId);
    if (!plan || !plan.active) return reply.status(400).send({ error: 'plan_not_found', statusCode: 400 });
    let discountAmount = 0;
    const couponCode = typeof body.couponCode === 'string' ? body.couponCode.trim() : '';
    if (couponCode) {
      const coupon = await validateCoupon(couponCode, plan);
      if (!coupon.ok) return reply.status(400).send({ error: coupon.error, statusCode: 400 });
      discountAmount = coupon.discountAmount;
    }
    const gateway = (await getActiveGateway()) ?? new SandboxGateway();
    if (!gateway.createTransparentPayment) return reply.status(503).send({ error: 'transparent_checkout_unavailable', statusCode: 503 });
    const payment = await createPayment({ tenantId: auth!.tenantId, planId, amount: plan.price, discountAmount, couponCode: couponCode || null, gateway: gateway.provider, idempotencyKey: randomKey() });
    if (!payment) return reply.status(502).send({ error: 'payment_create_failed', statusCode: 502 });
    const result = await gateway.createTransparentPayment({
      externalId: payment.id,
      amount: Math.max(0, Math.round((plan.price - discountAmount) * 100) / 100),
      planName: plan.name,
      payerEmail,
      cpf,
      phone: typeof body.phone === 'string' ? body.phone : undefined,
      paymentMethodId: typeof body.paymentMethodId === 'string' ? body.paymentMethodId : method === 'pix' ? 'pix' : '',
      cardToken: typeof body.cardToken === 'string' ? body.cardToken : undefined,
      installments: typeof body.installments === 'number' ? body.installments : 1,
      issuerId: typeof body.issuerId === 'string' ? body.issuerId : undefined,
      notificationUrl: `${getEnv().PUBLIC_BACKEND_URL}/api/saas/webhook/payments`,
      idempotencyKey: randomKey(),
    });
    if (!result.ok) { await updatePaymentStatus(payment.id, 'rejected'); return reply.status(502).send({ error: 'payment_failed', message: result.error, statusCode: 502 }); }
    if (result.gatewayPaymentId) await setPaymentGatewayIds(payment.id, { gatewayPaymentId: result.gatewayPaymentId });
    if (result.status === 'approved') await processApprovedPayment(payment.id);
    return reply.send({ ok: true, paymentId: payment.id, status: result.status, qrCode: result.qrCode ?? null, qrCodeBase64: result.qrCodeBase64 ?? null, ticketUrl: result.ticketUrl ?? null, provider: gateway.provider });
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
    if (gateway.provider === 'mercadopago') {
      const secret = await getActiveGatewayWebhookSecret();
      if (secret) {
        const signature = typeof req.headers['x-signature'] === 'string' ? req.headers['x-signature'] : '';
        const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : '';
        const dataId = String(((req.body ?? {}) as { data?: { id?: unknown } }).data?.id ?? '').toLowerCase();
        const ts = signature.match(/(?:^|,)ts=([^,]+)/)?.[1] ?? '';
        const v1 = signature.match(/(?:^|,)v1=([^,]+)/)?.[1] ?? '';
        const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
        const expected = createHmac('sha256', secret).update(manifest).digest('hex');
        const valid = Boolean(v1) && v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
        const payload = (req.body ?? {}) as { live_mode?: unknown; data?: { id?: unknown } };
        const isMercadoValidationTest = payload.live_mode === false && String(payload.data?.id ?? '') === '123456';
        if (!valid && !isMercadoValidationTest) return reply.status(401).send({ error: 'invalid_webhook_signature', statusCode: 401 });
      }
    }
    const parsed = await gateway.parseWebhook(req.body ?? {});
    const payment =
      (parsed.externalReference ? await findPaymentById(parsed.externalReference) : null) ??
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
