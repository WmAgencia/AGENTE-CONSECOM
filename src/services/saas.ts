/**
 * Vyntra SaaS — serviços de planos, assinaturas, pagamentos, cupons e uso.
 * Todas as leituras/escritas usam a service role (backend) e filtram por
 * tenant quando aplicável. O tenant vem do AuthContext, nunca do cliente.
 */
import {
  serviceBaseUrl,
  serviceHeaders,
  writeAudit,
} from './saas.auth.js';
import {
  buildGateway,
  type PaymentGateway,
} from './payment.gateway.js';
import { getEnv } from '../config/env.js';

export interface Plan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  currency: string;
  lead_limit: number;
  duration_days: number | null;
  billing_type: 'one_time' | 'recurring';
  active: boolean;
  features: unknown[];
  featured: boolean;
  display_order: number;
  campaign_equivalence: number;
  badge_label: string | null;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: 'active' | 'pending' | 'past_due' | 'cancelled' | 'expired';
  current_period_start: string | null;
  current_period_end: string | null;
  leads_used: number;
  cancel_at_period_end: boolean;
}

export interface Payment {
  id: string;
  tenant_id: string;
  subscription_id: string | null;
  plan_id: string | null;
  gateway: string;
  gateway_payment_id: string | null;
  gateway_preference_id: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'approved' | 'rejected' | 'refunded' | 'cancelled';
  coupon_code: string | null;
  discount_amount: number;
  webhook_id: string | null;
  idempotency_key: string | null;
  paid_at: string | null;
}

export interface Coupon {
  id: string;
  code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  valid_from: string | null;
  valid_until: string | null;
  usage_limit: number | null;
  usage_count: number;
  active: boolean;
  applicable_plan_ids: string[];
}

export interface UsageInfo {
  lead_limit: number;
  leads_used: number;
  leads_remaining: number;
}

export interface LeadsBalance {
  /** Total de leads adquiridos (compras + trial). */
  acquired: number;
  /** Total de leads consumidos (importados/prospectados). */
  used: number;
  /** Saldo disponível = acquired - used (nunca negativo). */
  available: number;
  /** true quando o tenant tem limite (plano ativo com créditos). */
  limited: boolean;
}

export interface CreditEntry {
  id: string;
  tenant_id: string;
  kind: 'purchase' | 'consumption' | 'trial' | 'refund' | 'adjustment';
  delta: number;
  plan_id: string | null;
  payment_id: string | null;
  lead_id: string | null;
  note: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

async function get<T>(path: string): Promise<T | null> {
  const url = `${serviceBaseUrl()}/rest/v1${path}`;
  try {
    const res = await fetch(url, { headers: serviceHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function first<T>(path: string): Promise<T | null> {
  const rows = await get<T[]>(path);
  return rows?.[0] ?? null;
}

// =============================================================
// Planos
// =============================================================

export async function listPlans(activeOnly = true): Promise<Plan[]> {
  const suffix = activeOnly ? '&active=eq.true' : '';
  const unique = (plans: Plan[]): Plan[] => {
    if (!activeOnly) return plans;
    const seen = new Set<string>();
    return plans.filter((plan) => {
      const key = (plan.name || plan.slug).trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  // Ordena por display_order quando a migration v31 já foi aplicada; cai para
  // price.asc quando a coluna ainda não existe (schema antigo).
  const ordered = await get<Plan[]>(`/plans?select=*&order=display_order.asc,price.asc${suffix}`);
  if (ordered) {
    return unique(ordered);
  }
  const plain = await get<Plan[]>(`/plans?select=*&order=price.asc${suffix}`);
  return unique(plain ?? []);
}

export async function getPlan(planId: string): Promise<Plan | null> {
  return first<Plan>(`/plans?select=*&id=eq.${encodeURIComponent(planId)}&limit=1`);
}

export async function getPlanBySlug(slug: string): Promise<Plan | null> {
  return first<Plan>(`/plans?select=*&slug=eq.${encodeURIComponent(slug)}&limit=1`);
}

// =============================================================
// Assinaturas
// =============================================================

export async function getActiveSubscription(tenantId: string): Promise<Subscription | null> {
  return first<Subscription>(
    `/subscriptions?select=*&tenant_id=eq.${encodeURIComponent(tenantId)}&status=in.(active,past_due)&order=created_at.desc&limit=1`,
  );
}

export async function getLatestSubscription(tenantId: string): Promise<Subscription | null> {
  return first<Subscription>(
    `/subscriptions?select=*&tenant_id=eq.${encodeURIComponent(tenantId)}&order=created_at.desc&limit=1`,
  );
}

// =============================================================
// Uso de leads
// =============================================================

/**
 * Leads consumidos = total de leads do tenant (modelo por importação).
 * Cada lead importado pela extensão dá baixa no plano.
 */
export async function countConsumedLeads(tenantId: string): Promise<number> {
  const rows = await get<Array<{ id: string }>>(
    `/leads?select=id&tenant_id=eq.${encodeURIComponent(tenantId)}`,
  );
  return rows?.length ?? 0;
}

/** Limite de leads do plano ativo (0 = sem limite). */
export async function getActiveLeadLimit(tenantId: string): Promise<number> {
  const sub = await getActiveSubscription(tenantId);
  if (!sub) return 0;
  const plan = await getPlan(sub.plan_id);
  return plan?.lead_limit ?? 0;
}

/**
 * Cota de importação da extensão.
 * Retorna { limited, used, limit, remaining }.
 * - Sem saldo adquirido => sem limite (backward compat com dados atuais).
 * - Com saldo => remaining = acquired - used.
 */
export async function getImportQuota(
  tenantId: string,
): Promise<{ limited: boolean; used: number; limit: number; remaining: number | null }> {
  const balance = await getLeadsBalance(tenantId);
  if (!balance.limited) {
    return { limited: false, used: balance.used, limit: 0, remaining: null };
  }
  return { limited: true, used: balance.used, limit: balance.acquired, remaining: balance.available };
}

/** Retorna limite/uso/restante do tenant (saldo adquiridos - consumidos). */
export async function getUsageInfo(tenantId: string): Promise<UsageInfo> {
  const balance = await getLeadsBalance(tenantId);
  return {
    lead_limit: balance.acquired,
    leads_used: balance.used,
    leads_remaining: balance.available,
  };
}

// =============================================================
// Créditos de leads (saldo = adquiridos - consumidos)
// =============================================================

/**
 * Total de leads adquiridos (credit_ledger kind purchase/trial/refund+).
 * Sem registros no ledger, cai no limite do plano ativo (backward compat
 * com tenants criados antes do ledger existir).
 */
export async function getAcquiredLeads(tenantId: string): Promise<number> {
  const rows = await get<Array<{ kind: string; delta: number }>>(
    `/credit_ledger?select=kind,delta&tenant_id=eq.${encodeURIComponent(tenantId)}`,
  );
  const ledger = rows ?? [];
  if (ledger.length > 0) {
    const acquired = ledger.reduce(
      (acc, r) => acc + (r.kind === 'purchase' || r.kind === 'trial' || r.kind === 'adjustment' ? r.delta : 0),
      0,
    );
    return Math.max(0, acquired);
  }
  // Backward compat: sem ledger, usa o limite do plano ativo.
  return getActiveLeadLimit(tenantId);
}

/** Saldo real do tenant: adquiridos - consumidos. */
export async function getLeadsBalance(tenantId: string): Promise<LeadsBalance> {
  const acquired = await getAcquiredLeads(tenantId);
  const used = await countConsumedLeads(tenantId);
  return {
    acquired,
    used,
    available: Math.max(0, acquired - used),
    limited: acquired > 0,
  };
}

/** Registra um movimento no credit_ledger (best-effort). */
export async function recordCredit(input: {
  tenantId: string;
  kind: CreditEntry['kind'];
  delta: number;
  planId?: string | null;
  paymentId?: string | null;
  leadId?: string | null;
  note?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await fetch(`${serviceBaseUrl()}/rest/v1/credit_ledger`, {
      method: 'POST',
      headers: serviceHeaders(true),
      body: JSON.stringify({
        tenant_id: input.tenantId,
        kind: input.kind,
        delta: input.delta,
        plan_id: input.planId ?? null,
        payment_id: input.paymentId ?? null,
        lead_id: input.leadId ?? null,
        note: input.note ?? null,
        detail: input.detail ?? {},
      }),
    });
  } catch {
    /* best-effort */
  }
}

/** Últimos movimentos de crédito/consumo do tenant. */
export async function listCreditLedger(tenantId: string, limit = 50): Promise<CreditEntry[]> {
  const rows = await get<CreditEntry[]>(
    `/credit_ledger?select=*&tenant_id=eq.${encodeURIComponent(tenantId)}&order=created_at.desc&limit=${limit}`,
  );
  return rows ?? [];
}

// =============================================================
// Gateways
// =============================================================

export async function getActiveGateway(): Promise<PaymentGateway | null> {
  const row = await first<{
    provider: string;
    enabled: boolean;
    sandbox: boolean;
    config: Record<string, unknown>;
  }>(`/payment_gateways?select=provider,enabled,sandbox,config&enabled=eq.true&order=created_at.asc&limit=1`);
  if (!row || !row.enabled) {
    try {
      const env = getEnv();
      if (env.MERCADOPAGO_ACCESS_TOKEN) return buildGateway({ provider: 'mercadopago', accessToken: env.MERCADOPAGO_ACCESS_TOKEN, sandbox: env.MERCADOPAGO_SANDBOX });
    } catch { /* configuração ausente */ }
    return null;
  }
  const cfg = row.config ?? {};
  const accessToken =
    typeof cfg.accessToken === 'string' ? cfg.accessToken : typeof cfg.access_token === 'string' ? (cfg.access_token as string) : '';
  return buildGateway({
    provider: row.provider,
    accessToken,
    sandbox: row.sandbox,
  });
}

export async function getActiveGatewayPublicKey(): Promise<string> {
  const row = await first<{ config: Record<string, unknown> }>(`/payment_gateways?select=config&enabled=eq.true&order=created_at.asc&limit=1`);
  const configured = row?.config?.publicKey ?? row?.config?.public_key;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  try { return getEnv().MERCADOPAGO_PUBLIC_KEY; } catch { return ''; }
}

export async function getActiveGatewayWebhookSecret(): Promise<string> {
  const row = await first<{ config: Record<string, unknown> }>(`/payment_gateways?select=config&enabled=eq.true&order=created_at.asc&limit=1`);
  const configured = row?.config?.webhookSecret ?? row?.config?.webhook_secret;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  try { return getEnv().MERCADOPAGO_WEBHOOK_SECRET; } catch { return ''; }
}

// =============================================================
// Cupons
// =============================================================

export type CouponValidation =
  | { ok: true; coupon: Coupon; discountAmount: number }
  | { ok: false; error: string };

export async function validateCoupon(code: string, plan: Plan): Promise<CouponValidation> {
  if (!code.trim()) return { ok: false, error: 'Cupom não informado.' };
  const coupon = await first<Coupon>(
    `/coupons?select=*&code=eq.${encodeURIComponent(code.trim().toUpperCase())}&limit=1`,
  );
  if (!coupon) return { ok: false, error: 'Cupom não encontrado.' };
  if (!coupon.active) return { ok: false, error: 'Cupom desativado.' };
  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    return { ok: false, error: 'Cupom ainda não está válido.' };
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return { ok: false, error: 'Cupom expirado.' };
  }
  if (coupon.usage_limit != null && coupon.usage_count >= coupon.usage_limit) {
    return { ok: false, error: 'Cupom atingiu o limite de uso.' };
  }
  const plans = Array.isArray(coupon.applicable_plan_ids) ? coupon.applicable_plan_ids : [];
  if (plans.length > 0 && !plans.includes(plan.id)) {
    return { ok: false, error: 'Cupom não se aplica a este plano.' };
  }
  let discountAmount = 0;
  if (coupon.discount_type === 'percentage') {
    discountAmount = Math.round(plan.price * (coupon.discount_value / 100) * 100) / 100;
  } else {
    discountAmount = Math.min(coupon.discount_value, plan.price);
  }
  discountAmount = Math.round(discountAmount * 100) / 100;
  return { ok: true, coupon, discountAmount };
}

export async function recordCouponUsage(couponId: string, tenantId: string, paymentId: string): Promise<void> {
  try {
    const coupon = await first<Coupon>(`/coupons?select=id,usage_count&id=eq.${encodeURIComponent(couponId)}&limit=1`);
    if (coupon) {
      await fetch(`${serviceBaseUrl()}/rest/v1/coupons?id=eq.${encodeURIComponent(coupon.id)}`, {
        method: 'PATCH',
        headers: serviceHeaders(true),
        body: JSON.stringify({ usage_count: (coupon.usage_count ?? 0) + 1 }),
      });
    }
    await fetch(`${serviceBaseUrl()}/rest/v1/coupon_redemptions`, {
      method: 'POST',
      headers: serviceHeaders(true),
      body: JSON.stringify({ tenant_id: tenantId, coupon_id: couponId, payment_id: paymentId }),
    });
  } catch {
    /* best-effort */
  }
}

// =============================================================
// Pagamentos + ativação de assinatura
// =============================================================

export async function createPayment(input: {
  tenantId: string;
  planId: string;
  amount: number;
  discountAmount: number;
  couponCode: string | null;
  gateway: string;
  idempotencyKey: string;
}): Promise<Payment | null> {
  const res = await fetch(`${serviceBaseUrl()}/rest/v1/payments?select=*`, {
    method: 'POST',
    headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: input.tenantId,
      plan_id: input.planId,
      amount: input.amount,
      discount_amount: input.discountAmount,
      coupon_code: input.couponCode,
      gateway: input.gateway,
      idempotency_key: input.idempotencyKey,
      status: 'pending',
    }),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Payment[];
  return rows[0] ?? null;
}

export async function setPaymentGatewayIds(
  paymentId: string,
  ids: { gatewayPaymentId?: string; gatewayPreferenceId?: string },
): Promise<void> {
  await fetch(`${serviceBaseUrl()}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}`, {
    method: 'PATCH',
    headers: serviceHeaders(true),
    body: JSON.stringify(ids),
  });
}

export async function findPaymentByExternalReference(ref: string): Promise<Payment | null> {
  return first<Payment>(`/payments?select=*&id=eq.${encodeURIComponent(ref)}&limit=1`);
}

export async function findPaymentByGatewayPaymentId(gatewayPaymentId: string): Promise<Payment | null> {
  return first<Payment>(
    `/payments?select=*&gateway_payment_id=eq.${encodeURIComponent(gatewayPaymentId)}&limit=1`,
  );
}

export async function findPaymentById(paymentId: string): Promise<Payment | null> {
  return first<Payment>(`/payments?select=*&id=eq.${encodeURIComponent(paymentId)}&limit=1`);
}

export async function findPaymentByIdempotencyKey(key: string): Promise<Payment | null> {
  return first<Payment>(`/payments?select=*&idempotency_key=eq.${encodeURIComponent(key)}&limit=1`);
}

export async function updatePaymentStatus(
  paymentId: string,
  status: Payment['status'],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await fetch(`${serviceBaseUrl()}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}`, {
    method: 'PATCH',
    headers: serviceHeaders(true),
    body: JSON.stringify({
      status,
      paid_at: status === 'approved' ? new Date().toISOString() : undefined,
      ...extra,
    }),
  });
}

/**
 * Ativa uma assinatura para o tenant a partir de um plano aprovado.
 * Cancela assinaturas ativas anteriores (troca de plano/renovação).
 */
export async function activateSubscription(
  tenantId: string,
  planId: string,
  paymentId: string,
): Promise<Subscription | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;

  // Cancela assinaturas ativas anteriores.
  await fetch(`${serviceBaseUrl()}/rest/v1/subscriptions?tenant_id=eq.${encodeURIComponent(tenantId)}&status=in.(active,past_due,pending)`, {
    method: 'PATCH',
    headers: serviceHeaders(true),
    body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
  });

  const now = new Date();
  const periodEnd =
    plan.duration_days && plan.duration_days > 0
      ? new Date(now.getTime() + plan.duration_days * 86400_000).toISOString()
      : null;
  const res = await fetch(`${serviceBaseUrl()}/rest/v1/subscriptions?select=*`, {
    method: 'POST',
    headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: tenantId,
      plan_id: planId,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd,
      leads_used: 0,
    }),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Subscription[];
  const sub = rows[0] ?? null;

  // Associa o pagamento à assinatura.
  if (sub) {
    await fetch(`${serviceBaseUrl()}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}`, {
      method: 'PATCH',
      headers: serviceHeaders(true),
      body: JSON.stringify({ subscription_id: sub.id }),
    });
  }
  return sub;
}

/**
 * Ativa o plano TESTE (sem pagamento). Cancela assinaturas ativas
 * anteriores e registra o crédito no credit_ledger.
 */
export async function activateTrialSubscription(
  tenantId: string,
  planId: string,
): Promise<Subscription | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;

  // Cancela assinaturas ativas anteriores.
  await fetch(`${serviceBaseUrl()}/rest/v1/subscriptions?tenant_id=eq.${encodeURIComponent(tenantId)}&status=in.(active,past_due,pending)`, {
    method: 'PATCH',
    headers: serviceHeaders(true),
    body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
  });

  const now = new Date();
  const periodEnd =
    plan.duration_days && plan.duration_days > 0
      ? new Date(now.getTime() + plan.duration_days * 86400_000).toISOString()
      : null;
  const res = await fetch(`${serviceBaseUrl()}/rest/v1/subscriptions?select=*`, {
    method: 'POST',
    headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: tenantId,
      plan_id: planId,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd,
      leads_used: 0,
    }),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Subscription[];
  const sub = rows[0] ?? null;

  if (sub && plan.lead_limit > 0) {
    await recordCredit({
      tenantId,
      kind: 'trial',
      delta: plan.lead_limit,
      planId,
      note: `Plano TESTE (${plan.lead_limit} leads)`,
      detail: { plan_name: plan.name },
    });
  }
  return sub;
}

/**
 * Processa um pagamento aprovado: atualiza status, ativa assinatura,
 * registra uso do cupom e auditoria. Idempotente por payment id.
 */
export async function processApprovedPayment(paymentId: string): Promise<{ ok: boolean; error?: string }> {
  const payment = await first<Payment>(`/payments?select=*&id=eq.${encodeURIComponent(paymentId)}&limit=1`);
  if (!payment) return { ok: false, error: 'payment_not_found' };
  if (payment.status === 'approved') return { ok: true }; // já processado
  if (!payment.plan_id) return { ok: false, error: 'plan_missing' };

  await updatePaymentStatus(payment.id, 'approved');
  const sub = await activateSubscription(payment.tenant_id, payment.plan_id, payment.id);
  const plan = await getPlan(payment.plan_id);
  if (plan && plan.lead_limit > 0) {
    await recordCredit({
      tenantId: payment.tenant_id,
      kind: 'purchase',
      delta: plan.lead_limit,
      planId: payment.plan_id,
      paymentId: payment.id,
      note: `Compra do plano ${plan.name} (${plan.lead_limit} leads)`,
      detail: { plan_name: plan.name, amount: payment.amount },
    });
  }
  if (payment.coupon_code && payment.coupon_code.trim()) {
    const coupon = await first<Coupon>(`/coupons?select=id&code=eq.${encodeURIComponent(payment.coupon_code.trim().toUpperCase())}&limit=1`);
    if (coupon) await recordCouponUsage(coupon.id, payment.tenant_id, payment.id);
  }
  await writeAudit({
    actor: payment.tenant_id,
    action: 'PAYMENT_APPROVED',
    tenantId: payment.tenant_id,
    targetType: 'payment',
    targetIds: [payment.id],
    details: { amount: payment.amount, plan_id: payment.plan_id, gateway: payment.gateway },
  });
  void sub;
  return { ok: true };
}
