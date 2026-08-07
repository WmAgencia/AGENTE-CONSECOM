/**
 * Evolution API connections service.
 *
 * Manages WhatsApp instances and group notifications per user:
 *  - createInstance / connectInstance / fetchQRCode
 *  - fetchGroups
 *  - persist connection state in supabase (whatsapp_connections / notification_groups / notification_settings)
 *
 * Uses the Supabase REST API with the service role key (server-side only).
 */
import { getEvolutionConfig, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

/**
 * Returns the public base URL of this backend (used to register the
 * webhook on the Evolution instance). Prefers RAILWAY_PUBLIC_DOMAIN
 * (auto-set by Railway), then PUBLIC_BASE_URL (manual override), and
 * finally throws if neither is set so we never silently point at the
 * wrong environment.
 */
function getPublicBaseUrl(): string {
  const fromRailway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (fromRailway) return `https://${fromRailway.replace(/\/$/, '')}`;
  const manual = process.env.PUBLIC_BASE_URL;
  if (manual) return manual.replace(/\/$/, '');
  throw new Error(
    'PUBLIC_BASE_URL (or RAILWAY_PUBLIC_DOMAIN) must be set so the ' +
      'Evolution API can reach /webhook/evolution on this backend.',
  );
}

/**
 * Builds the Evolution instance name for a given workspace.
 * Naming convention: `consecom-<workspace_id>` (sanitized for Evolution rules).
 * Falls back to `consecom-user-<id8>` when no workspace_id is provided.
 */
function buildInstanceName(workspaceId: string | null, userId: string): string {
  const sanitize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  if (workspaceId) {
    return `consecom-${sanitize(workspaceId)}`;
  }
  return `consecom-user-${sanitize(userId).slice(0, 12)}`;
}

/**
 * Returns the workspace_id and user_id from the request headers.
 * Prefers workspace_id (multi-tenant); falls back to user_id.
 */
export function getWorkspaceAndUser(req: {
  headers: Record<string, string | string[] | undefined>;
}): { workspaceId: string | null; userId: string | null } {
  const headerVal = (k: string): string | null => {
    const v = req.headers[k.toLowerCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
    return null;
  };
  return {
    workspaceId: headerVal('x-workspace-id'),
    userId: headerVal('x-user-id'),
  };
}

export interface WhatsAppConnection {
  id: string;
  user_id: string | null;
  workspace_id: string | null;
  instance_name: string;
  phone_number: string | null;
  whatsapp_name: string | null;
  status: 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error';
  evolution_instance_id: string | null;
  qr_code: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppGroup {
  id: string;
  name: string | null;
}

function supHeaders(): Record<string, string> {
  const cfg = getSupabaseProspeccaoConfig();
  return {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

function supUrl(): string {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url;
}

/** Lê a conexão WhatsApp do usuário da tabela whatsapp_connections. */
export async function getUserConnection(userId: string): Promise<WhatsAppConnection | null> {
  const log = getLogger();
  try {
    const res = await fetch(
      `${supUrl()}/rest/v1/whatsapp_connections?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`,
      { headers: supHeaders() },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as WhatsAppConnection[];
    return rows[0] ?? null;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: getUserConnection failed');
    return null;
  }
}

/** Cria uma nova instância na Evolution API e persiste a conexão no Supabase. */
export async function createInstanceForUser(
  userId: string,
  workspaceId: string | null = null,
): Promise<{ ok: boolean; qrCode?: string; error?: string }> {
  const log = getLogger();
  try {
    const cfg = getEvolutionConfig();
    const instanceName = buildInstanceName(workspaceId, userId);

    // POST /instance/create — cria instância na Evolution API
    const createRes = await fetch(`${cfg.apiUrl}/instance/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
      body: JSON.stringify({
        instanceName,
        webhook: `${getPublicBaseUrl()}/webhook/evolution`,
        webhook_by_events: true,
        events: ['APPLICATION_STARTUP', 'QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'SEND_MESSAGE'],
      }),
    });

    if (!createRes.ok) {
      const txt = await createRes.text();
      log.error({ status: createRes.status, body: txt.slice(0, 200) }, 'connections: Evolution create failed');
      return { ok: false, error: `Evolution API erro ${createRes.status}` };
    }

    // Tenta gerar QR code imediatamente
    const qrRes = await fetch(`${cfg.apiUrl}/instance/connect/${encodeURIComponent(instanceName)}`, {
      method: 'GET',
      headers: { apikey: cfg.apiKey },
    });

    let qrCode: string | null = null;
    if (qrRes.ok) {
      const qrJson = (await qrRes.json()) as { qrcode?: { base64?: string } | string };
      if (typeof qrJson.qrcode === 'string') {
        qrCode = qrJson.qrcode;
      } else if (qrJson.qrcode?.base64) {
        qrCode = qrJson.qrcode.base64;
      }
    }

    // Persiste no Supabase
    await fetch(`${supUrl()}/rest/v1/whatsapp_connections`, {
      method: 'POST',
      headers: supHeaders(),
      body: JSON.stringify({
        user_id: userId,
        workspace_id: workspaceId,
        instance_name: instanceName,
        status: qrCode ? 'connecting' : 'pending',
        qr_code: qrCode,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });

    return { ok: true, qrCode: qrCode ?? undefined };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: createInstanceForUser failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

/** Gera um novo QR Code para uma instância existente. */
export async function regenerateQRCode(userId: string): Promise<{ ok: boolean; qrCode?: string; error?: string }> {
  const log = getLogger();
  try {
    const conn = await getUserConnection(userId);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();
    const qrRes = await fetch(`${cfg.apiUrl}/instance/connect/${encodeURIComponent(conn.instance_name)}`, {
      method: 'GET',
      headers: { apikey: cfg.apiKey },
    });

    if (!qrRes.ok) {
      return { ok: false, error: `Evolution API erro ${qrRes.status}` };
    }

    const qrJson = (await qrRes.json()) as { qrcode?: { base64?: string } | string };
    let qrCode: string | null = null;
    if (typeof qrJson.qrcode === 'string') {
      qrCode = qrJson.qrcode;
    } else if (qrJson.qrcode?.base64) {
      qrCode = qrJson.qrcode.base64;
    }

    if (!qrCode) {
      return { ok: false, error: 'qr_not_available' };
    }

    // Atualiza no Supabase
    await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      headers: supHeaders(),
      body: JSON.stringify({
        qr_code: qrCode,
        status: 'connecting',
        last_sync_at: new Date().toISOString(),
      }),
    });

    return { ok: true, qrCode };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: regenerateQRCode failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

/** Desconecta a instância do WhatsApp. */
export async function disconnectInstance(userId: string): Promise<{ ok: boolean; error?: string }> {
  const log = getLogger();
  try {
    const conn = await getUserConnection(userId);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();
    await fetch(`${cfg.apiUrl}/instance/logout/${encodeURIComponent(conn.instance_name)}`, {
      method: 'DELETE',
      headers: { apikey: cfg.apiKey },
    });

    await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      headers: supHeaders(),
      body: JSON.stringify({
        status: 'disconnected',
        last_sync_at: new Date().toISOString(),
      }),
    });

    return { ok: true };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: disconnectInstance failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

/** Busca os grupos disponíveis do WhatsApp conectado. */
export async function fetchUserGroups(userId: string): Promise<{ ok: boolean; groups?: WhatsAppGroup[]; error?: string }> {
  const log = getLogger();
  try {
    const conn = await getUserConnection(userId);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();
    const res = await fetch(`${cfg.apiUrl}/chat/findGroups/${encodeURIComponent(conn.instance_name)}`, {
      method: 'GET',
      headers: { apikey: cfg.apiKey },
    });

    if (!res.ok) {
      return { ok: false, error: `Evolution API erro ${res.status}` };
    }

    const data = (await res.json()) as unknown;
    // Evolution retorna array de { id, name } ou objeto com grupos
    const raw = (Array.isArray(data) ? data : Object.values(data as Record<string, unknown>)) as Array<{
      id: string;
      name?: string;
      subject?: string;
    }>;
    const groups: WhatsAppGroup[] = raw.map((g) => ({
      id: g.id,
      name: g.name ?? g.subject ?? 'Grupo sem nome',
    }));

    return { ok: true, groups };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: fetchUserGroups failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

/** Envia mensagem de teste para um grupo. */
export async function sendTestMessage(userId: string, groupId: string): Promise<{ ok: boolean; error?: string }> {
  const log = getLogger();
  try {
    const conn = await getUserConnection(userId);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();
    const res = await fetch(`${cfg.apiUrl}/message/sendText/${encodeURIComponent(conn.instance_name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
      body: JSON.stringify({
        number: groupId,
        text: '✅ *Teste de Notificação* — sua integração está funcionando!',
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `Evolution API erro ${res.status}` };
    }

    return { ok: true };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: sendTestMessage failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}
