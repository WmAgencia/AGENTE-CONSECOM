/**
 * Vyntra SaaS — autenticação multitenant.
 *
 * O frontend envia `Authorization: Bearer <access_token do Supabase>`.
 * Aqui nós:
 *   1. Validamos o token chamando `{SUPABASE_URL}/auth/v1/user` (server-side).
 *   2. Buscamos o registro em `app_users` (tenant_id + role + status).
 *   3. Retornamos um AuthContext que as rotas usam para filtrar por tenant.
 *
 * O tenant NUNCA é derivado de um `tenant_id` enviado pelo cliente: ele vem
 * sempre da sessão/autenticação (app_users.tenant_id).
 */
import type { FastifyRequest } from 'fastify';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { extractBearerToken } from '../utils/auth.js';

export type Role = 'USER' | 'MASTER';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  username: string | null;
  status: 'active' | 'blocked';
  blocked: boolean;
}

interface AppUserRow {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string | null;
  username: string | null;
  role: Role;
  status: 'active' | 'blocked';
}

interface SupabaseMeta {
  url: string;
  key: string;
}

function supMeta(): SupabaseMeta | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey
    ? { url: cfg.url.replace(/\/+$/, ''), key: cfg.serviceRoleKey }
    : null;
}

function supHeaders(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

async function fetchAppUser(s: SupabaseMeta, userId: string): Promise<AppUserRow | null> {
  try {
    const res = await fetch(
      `${s.url}/rest/v1/app_users?select=id,tenant_id,email,full_name,username,role,status&id=eq.${encodeURIComponent(userId)}&limit=1`,
      { headers: supHeaders(s.key) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as AppUserRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Cache curto por token (60s) para não martelar o Supabase a cada request. */
const cache = new Map<string, { at: number; ctx: AuthContext | null }>();
const CACHE_TTL_MS = 60_000;

/**
 * Resolve o contexto de autenticação de uma requisição.
 * Retorna null quando: sem token, token inválido, ou usuário sem app_users.
 * Nunca lança (falha de rede => null => 401 pelas rotas).
 */
export async function resolveAuthContext(req: FastifyRequest): Promise<AuthContext | null> {
  const authHeader = req.headers.authorization;
  const token = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);
  if (!token) return null;

  const cached = cache.get(token);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ctx;

  const s = supMeta();
  if (!s) return null;

  let ctx: AuthContext | null = null;
  try {
    // Valida o token DO USUÁRIO em /auth/v1/user. Usamos o service role apenas
    // como apikey; o Authorization deve carregar o token do usuário (o JWT do
    // service role não tem claim `sub` e é rejeitado com 403 bad_jwt).
    const res = await fetch(`${s.url}/auth/v1/user`, {
      headers: { apikey: s.key, Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res && res.ok) {
      const body = (await res.json()) as { id?: string; email?: string };
      const uid = typeof body.id === 'string' ? body.id : '';
      if (uid) {
        const appUser = await fetchAppUser(s, uid);
        if (appUser) {
          ctx = {
            userId: appUser.id,
            tenantId: appUser.tenant_id,
            role: appUser.role,
            email: appUser.email ?? body.email ?? '',
            username: appUser.username ?? null,
            status: appUser.status,
            blocked: appUser.status === 'blocked',
          };
        }
      }
    }
  } catch {
    ctx = null;
  }

  cache.set(token, { at: Date.now(), ctx });
  return ctx;
}

/** Lê o contexto anexado ao request pelo hook global (app.ts). */
export function authOf(req: FastifyRequest): AuthContext | null {
  return (req as unknown as { auth?: AuthContext | null }).auth ?? null;
}

const tenantCache = new Map<string, { at: number; tenantId: string | null }>();
const TENANT_CACHE_TTL_MS = 60_000;

/**
 * Resolve o tenant_id de um usuário (auth.users.id) a partir de app_users.
 * Usado para estampar tenant_id em escritas feitas via service role
 * (ex.: import-leads da extensão). Cache curto (60s).
 */
export async function getTenantForUserId(userId: string): Promise<string | null> {
  const cached = tenantCache.get(userId);
  if (cached && Date.now() - cached.at < TENANT_CACHE_TTL_MS) return cached.tenantId;
  let tenantId: string | null = null;
  const s = supMeta();
  if (s) {
    try {
      const res = await fetch(
        `${s.url}/rest/v1/app_users?select=tenant_id&id=eq.${encodeURIComponent(userId)}&limit=1`,
        { headers: supHeaders(s.key) },
      );
      if (res.ok) {
        const rows = (await res.json()) as Array<{ tenant_id: string }>;
        tenantId = rows[0]?.tenant_id ?? null;
      }
    } catch {
      tenantId = null;
    }
  }
  tenantCache.set(userId, { at: Date.now(), tenantId });
  return tenantId;
}

/** Filtro PostgREST de tenant (sempre derivado do auth, nunca do cliente). */
export function tenantFilter(tenantId: string, column = 'tenant_id'): string {
  return `${column}=eq.${encodeURIComponent(tenantId)}`;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; statusCode: number; error: string };

/** Requer usuário autenticado e ativo. */
export function requireAuth(auth: AuthContext | null): GuardResult {
  if (!auth) return { ok: false, statusCode: 401, error: 'unauthorized' };
  if (auth.blocked) return { ok: false, statusCode: 403, error: 'user_blocked' };
  return { ok: true };
}

/** Requer usuário com papel MASTER. */
export function requireMaster(auth: AuthContext | null): GuardResult {
  const base = requireAuth(auth);
  if (!base.ok) return base;
  if (auth!.role !== 'MASTER') return { ok: false, statusCode: 403, error: 'forbidden' };
  return { ok: true };
}

/** Headers service role (usados pelas rotas SaaS/Master). */
export function serviceHeaders(json = false): Record<string, string> {
  const s = supMeta();
  if (!s) throw new Error('Supabase not configured');
  return supHeaders(s.key, json);
}

/** URL do Supabase REST (service role). */
export function serviceBaseUrl(): string {
  const s = supMeta();
  if (!s) throw new Error('Supabase not configured');
  return s.url;
}

/** Registra um evento de auditoria (best-effort, service role). */
export async function writeAudit(
  opts: {
    actor: string;
    action: string;
    tenantId?: string | null;
    targetType?: string;
    targetIds?: string[];
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const s = supMeta();
    if (!s) return;
    await fetch(`${s.url}/rest/v1/consecom_audit_log`, {
      method: 'POST',
      headers: supHeaders(s.key, true),
      body: JSON.stringify({
        user_id: opts.actor,
        action: opts.action,
        tenant_id: opts.tenantId ?? null,
        target_type: opts.targetType ?? null,
        target_ids: opts.targetIds ?? [],
        details: opts.details ?? {},
      }),
    });
  } catch {
    // auditoria é best-effort
  }
}