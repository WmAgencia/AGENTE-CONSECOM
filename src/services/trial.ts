/**
 * Vyntra — Plano TESTE (anti-abuso).
 *
 * O plano TESTE é uma porta de entrada barata mas que precisa ser à prova
 * de abuso: nada de criar dezenas de contas para obter 250 leads grátis
 * repetidamente. Defesa em camadas, tudo no backend:
 *
 *   1. Ativação atômica: `trial_redemption.user_id` é UNIQUE. Duas chamadas
 *      concorrentes para o MESMO usuário => só uma insere (a outra falha).
 *   2. Bloqueio por identidade: hashes SHA-256 de e-mail, telefone, IP e
 *      device. Índices UNIQUE em email/phone impedem burla com contas novas.
 *   3. Rate limit: janela deslizante por IP/device (429 Too Many Requests).
 *   4. Risk score: sinais combinados (IP já usado, contas novas no mesmo IP,
 *      e-mail descartável, dispositivo reutilizado). Acima do limiar => nega.
 *   5. Trilha: cada tentativa grava um security_event (painel antifraude).
 */
import { createHash } from 'node:crypto';
import {
  serviceBaseUrl,
  serviceHeaders,
  writeAudit,
} from './saas.auth.js';

// ---------------------------------------------------------------
// Hash helpers (SHA-256 — nunca armazenamos dado pessoal em claro)
// ---------------------------------------------------------------

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, '');
}

/** Domínios de e-mail descartável comuns (bloqueio do plano TESTE). */
const BURNER_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'yopmail.com',
  'throwaway.email',
  'getnada.com',
  'discard.email',
  'maildrop.cc',
  'mailnesia.com',
  'trashmail.com',
  'temp-mail.io',
  'emailondeck.com',
  'mohmal.com',
]);

export function isBurnerEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return BURNER_DOMAINS.has(domain);
}

// ---------------------------------------------------------------
// Rate limiting em memória (janela deslizante por chave)
// ---------------------------------------------------------------

interface Window {
  timestamps: number[];
}

const rateBuckets = new Map<string, Window>();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_MAX = 3; // máx. tentativas de TESTE por chave/hora

function rateLimited(key: string): boolean {
  const now = Date.now();
  let w = rateBuckets.get(key);
  if (!w) {
    w = { timestamps: [] };
    rateBuckets.set(key, w);
  }
  w.timestamps = w.timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  if (w.timestamps.length >= RATE_MAX) return true;
  w.timestamps.push(now);
  return false;
}

/** Limpeza periódica (evita vazamento de memória). */
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of rateBuckets) {
    w.timestamps = w.timestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (w.timestamps.length === 0) rateBuckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------
// Acesso ao Supabase (service role)
// ---------------------------------------------------------------

async function query<T>(path: string): Promise<T[] | null> {
  try {
    const res = await fetch(`${serviceBaseUrl()}/rest/v1${path}`, { headers: serviceHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T[];
  } catch {
    return null;
  }
}

async function insert(path: string, body: unknown, select: string): Promise<Array<Record<string, unknown>> | null> {
  try {
    const res = await fetch(`${serviceBaseUrl()}/rest/v1${path}?select=${select}`, {
      method: 'POST',
      headers: { ...serviceHeaders(true), Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

export interface TrialAttempt {
  userId: string;
  tenantId: string;
  email: string;
  phone: string | null;
  ip: string;
  deviceId: string | null;
}

export type TrialResult =
  | { ok: true; riskScore: number }
  | { ok: false; statusCode: number; error: string; message: string; riskScore?: number };

/** Registra um evento de segurança (best-effort). */
async function logEvent(ev: {
  eventType: string;
  userId: string | null;
  tenantId: string | null;
  ipHash: string | null;
  emailHash: string | null;
  phoneHash: string | null;
  deviceHash: string | null;
  riskScore: number;
  reason: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await fetch(`${serviceBaseUrl()}/rest/v1/security_events`, {
      method: 'POST',
      headers: serviceHeaders(true),
      body: JSON.stringify({
        event_type: ev.eventType,
        user_id: ev.userId,
        tenant_id: ev.tenantId,
        ip_hash: ev.ipHash,
        email_hash: ev.emailHash,
        phone_hash: ev.phoneHash,
        device_hash: ev.deviceHash,
        risk_score: ev.riskScore,
        reason: ev.reason,
        detail: ev.detail ?? {},
      }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Tenta resgatar o plano TESTE de forma atômica e anti-abuso.
 *
 * Retorna ok=true apenas quando o resgate foi CONCEDIDO (inserção no
 * trial_redemption teve sucesso). O backend depois ativa a assinatura
 * do plano TESTE. Se outra requisição concorrente vencer, retorna o
 * mesmo resultado de "já resgatado" (idempotente para o usuário).
 */
export async function attemptTrialRedemption(
  a: TrialAttempt,
  planId: string,
): Promise<TrialResult> {
  const email = normalizeEmail(a.email);
  const phone = a.phone ? normalizePhone(a.phone) : null;
  const emailHash = sha256(email);
  const phoneHash = phone ? sha256(phone) : null;
  const ipHash = sha256(a.ip);
  const deviceHash = a.deviceId ? sha256(a.deviceId) : null;

  // ---- 1) Rate limit por IP e device ----
  if (rateLimited(`ip:${ipHash}`) || (deviceHash && rateLimited(`dev:${deviceHash}`))) {
    await logEvent({
      eventType: 'trial_rate_limited',
      userId: a.userId,
      tenantId: a.tenantId,
      ipHash,
      emailHash,
      phoneHash,
      deviceHash,
      riskScore: 40,
      reason: 'too_many_attempts',
      detail: { plan_id: planId },
    });
    return {
      ok: false,
      statusCode: 429,
      error: 'too_many_attempts',
      message: 'Muitas tentativas em pouco tempo. Tente novamente mais tarde.',
      riskScore: 40,
    };
  }

  // ---- 2) Já resgatou (user_id único)? ----
  const byUser = await query<{ id: string }>(
    `/trial_redemption?select=id&user_id=eq.${encodeURIComponent(a.userId)}&limit=1`,
  );
  if (byUser && byUser.length > 0) {
    await logEvent({
      eventType: 'trial_already_redeemed',
      userId: a.userId,
      tenantId: a.tenantId,
      ipHash,
      emailHash,
      phoneHash,
      deviceHash,
      riskScore: 0,
      reason: 'user_already_redeemed',
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'trial_already_redeemed',
      message: 'Você já utilizou o plano TESTE.',
    };
  }

  // ---- 3) Mesmo e-mail / telefone (contas novas tentando burlar)? ----
  if (emailHash) {
    const byEmail = await query<{ id: string }>(
      `/trial_redemption?select=id&email_hash=eq.${encodeURIComponent(emailHash)}&limit=1`,
    );
    if (byEmail && byEmail.length > 0) {
      await logEvent({
        eventType: 'trial_blocked',
        userId: a.userId,
        tenantId: a.tenantId,
        ipHash,
        emailHash,
        phoneHash,
        deviceHash,
        riskScore: 60,
        reason: 'email_already_redeemed',
      });
      return {
        ok: false,
        statusCode: 409,
        error: 'trial_blocked',
        message: 'Este e-mail já utilizou o plano TESTE.',
        riskScore: 60,
      };
    }
  }
  if (phoneHash) {
    const byPhone = await query<{ id: string }>(
      `/trial_redemption?select=id&phone_hash=eq.${encodeURIComponent(phoneHash)}&limit=1`,
    );
    if (byPhone && byPhone.length > 0) {
      await logEvent({
        eventType: 'trial_blocked',
        userId: a.userId,
        tenantId: a.tenantId,
        ipHash,
        emailHash,
        phoneHash,
        deviceHash,
        riskScore: 60,
        reason: 'phone_already_redeemed',
      });
      return {
        ok: false,
        statusCode: 409,
        error: 'trial_blocked',
        message: 'Este telefone já utilizou o plano TESTE.',
        riskScore: 60,
      };
    }
  }

  // ---- 4) Risk score ----
  let risk = 0;
  // IP que já resgatou outro teste (múltiplas contas no mesmo IP).
  const ipUsed = await query<{ id: string }>(
    `/trial_redemption?select=id&ip_hash=eq.${encodeURIComponent(ipHash)}&limit=1`,
  );
  if (ipUsed && ipUsed.length > 0) risk += 40;
  // Device reutilizado.
  if (deviceHash) {
    const devUsed = await query<{ id: string }>(
      `/trial_redemption?select=id&device_hash=eq.${encodeURIComponent(deviceHash)}&limit=1`,
    );
    if (devUsed && devUsed.length > 0) risk += 25;
  }
  // E-mail descartável.
  if (isBurnerEmail(email)) risk += 25;
  // Já teve outro plano/pagamento (não é um trial puro).
  const paid = await query<{ id: string }>(
    `/payments?select=id&tenant_id=eq.${encodeURIComponent(a.tenantId)}&status=eq.approved&limit=1`,
  );
  if (paid && paid.length > 0) risk += 30;

  if (risk >= 70) {
    await logEvent({
      eventType: 'trial_high_risk',
      userId: a.userId,
      tenantId: a.tenantId,
      ipHash,
      emailHash,
      phoneHash,
      deviceHash,
      riskScore: risk,
      reason: 'risk_score_too_high',
      detail: { plan_id: planId, email_burner: isBurnerEmail(email) },
    });
    await writeAudit({
      actor: a.userId,
      action: 'TRIAL_REJECTED_RISK',
      tenantId: a.tenantId,
      targetType: 'plan',
      targetIds: [planId],
      details: { risk_score: risk, reason: 'risk_score_too_high' },
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'trial_blocked',
      message: 'Não foi possível liberar o plano TESTE para esta conta.',
      riskScore: risk,
    };
  }

  // ---- 5) Ativação atômica (user_id UNIQUE) ----
  const inserted = await insert(
    '/trial_redemption',
    {
      user_id: a.userId,
      tenant_id: a.tenantId,
      plan_id: planId,
      email_hash: emailHash,
      phone_hash: phoneHash,
      ip_hash: ipHash,
      device_hash: deviceHash,
      risk_score: risk,
      status: 'redeemed',
    },
    'id,user_id',
  );
  if (!inserted || inserted.length === 0) {
    // Perdeu a corrida para outra requisição => já resgatado.
    await logEvent({
      eventType: 'trial_already_redeemed',
      userId: a.userId,
      tenantId: a.tenantId,
      ipHash,
      emailHash,
      phoneHash,
      deviceHash,
      riskScore: 0,
      reason: 'concurrent_redeem',
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'trial_already_redeemed',
      message: 'Você já utilizou o plano TESTE.',
    };
  }

  await logEvent({
    eventType: 'trial_redeemed',
    userId: a.userId,
    tenantId: a.tenantId,
    ipHash,
    emailHash,
    phoneHash,
    deviceHash,
    riskScore: risk,
    reason: 'redeemed',
    detail: { plan_id: planId },
  });
  await writeAudit({
    actor: a.userId,
    action: 'TRIAL_REDEEMED',
    tenantId: a.tenantId,
    targetType: 'plan',
    targetIds: [planId],
    details: { risk_score: risk },
  });
  return { ok: true, riskScore: risk };
}

/** Já usou o plano TESTE? (consulta barata para o /me). */
export async function hasRedeemedTrial(userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `/trial_redemption?select=id&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  return !!(rows && rows.length > 0);
}