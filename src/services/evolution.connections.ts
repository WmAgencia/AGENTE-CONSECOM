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
import { extractQrFromEvolution, isValidQrDataUri, toQrDataUri } from '../utils/qr.js';

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

/** Lê a conexão WhatsApp do usuário/workspace da tabela whatsapp_connections.
 *  Aceita um identifier que pode ser workspace_id (multi-tenant) ou user_id (legado).
 *  Faz lookup em workspace_id primeiro (precedência), depois em user_id.
 */
export async function getUserConnection(identifier: string): Promise<WhatsAppConnection | null> {
  const log = getLogger();
  try {
    const url = supUrl();
    const hdrs = supHeaders();
    // 1) Tenta por workspace_id (multi-tenant)
    const wRes = await fetch(
      `${url}/rest/v1/whatsapp_connections?select=*&workspace_id=eq.${encodeURIComponent(identifier)}&order=created_at.desc&limit=1`,
      { headers: hdrs },
    );
    if (wRes.ok) {
      const wRows = (await wRes.json()) as WhatsAppConnection[];
      if (wRows.length > 0) return wRows[0];
    }
    // 2) Fallback: por user_id (legado single-tenant)
    const uRes = await fetch(
      `${url}/rest/v1/whatsapp_connections?select=*&user_id=eq.${encodeURIComponent(identifier)}&order=created_at.desc&limit=1`,
      { headers: hdrs },
    );
    if (!uRes.ok) return null;
    const uRows = (await uRes.json()) as WhatsAppConnection[];
    return uRows[0] ?? null;
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

    // POST /instance/create — cria instância na Evolution API.
    // Importante: a Evolution API v2.3.x rejeita o payload quando `webhook` +
    // `events` são enviados juntos no create (bug interno: "Cannot read
    // properties of undefined (reading 'length')"). Solução: criar primeiro só
    // com instanceName + integration, e setar o webhook em um segundo POST.
    const createRes = await fetch(`${cfg.apiUrl}/instance/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
      body: JSON.stringify({
        instanceName,
        integration: 'WHATSAPP-BAILEYS',
      }),
    });

    if (!createRes.ok) {
      const txt = await createRes.text();
      log.error({ status: createRes.status, body: txt.slice(0, 200) }, 'connections: Evolution create failed');
      return { ok: false, error: `Evolution API erro ${createRes.status}` };
    }

    // POST /webhook/set/{instance} — registra webhook separadamente.
    // Necessário por causa do bug da Evolution v2.3.x que rejeita webhook no create.
    const webhookRes = await fetch(`${cfg.apiUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
      body: JSON.stringify({
        webhook: {
          url: `${getPublicBaseUrl()}/webhook/evolution`,
          enabled: true,
          webhook_by_events: true,
          events: ['APPLICATION_STARTUP', 'QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'SEND_MESSAGE'],
        },
      }),
    });
    if (!webhookRes.ok) {
      const txt = await webhookRes.text();
      log.warn(
        { status: webhookRes.status, body: txt.slice(0, 200) },
        'connections: webhook setup failed (instance still created)',
      );
    }

    // Tenta gerar QR code imediatamente
    let qrCode: string | null = null;
    try {
      const qrRes = await fetch(`${cfg.apiUrl}/instance/connect/${encodeURIComponent(instanceName)}`, {
        method: 'GET',
        headers: { apikey: cfg.apiKey },
      });
      if (qrRes.ok) {
        const qrJson = (await qrRes.json()) as unknown;
        const extracted = extractQrFromEvolution(qrJson);
        if (extracted?.dataUri && isValidQrDataUri(extracted.dataUri)) {
          qrCode = extracted.dataUri;
        }
      } else {
        log.warn(
          { status: qrRes.status },
          'connections: Evolution /instance/connect returned non-OK on create',
        );
      }
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : 'unknown' },
        'connections: failed to fetch initial QR code',
      );
    }

    // Se a chamada síncrona não devolveu QR (comum: Baileys ainda está
    // inicializando), o webhook QRCODE_UPDATED atualizará o qr_code
    // automaticamente. Marca como `connecting` para o frontend saber
    // que está aguardando.
    const initialStatus: 'pending' | 'connecting' = qrCode ? 'connecting' : 'pending';

    // Persiste no Supabase
    await fetch(`${supUrl()}/rest/v1/whatsapp_connections`, {
      method: 'POST',
      headers: supHeaders(),
      body: JSON.stringify({
        user_id: userId,
        workspace_id: workspaceId,
        instance_name: instanceName,
        status: initialStatus,
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
export async function regenerateQRCode(identifier: string): Promise<{ ok: boolean; qrCode?: string; error?: string }> {
  const log = getLogger();
  try {
    const conn = await getUserConnection(identifier);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();

    // Algumas versões da Evolution exigem POST /instance/connect/{instance}
    // para forçar nova geração; outras respondem em GET. Tentamos POST
    // primeiro (mais comum em v2.x) e caímos para GET.
    let qrJson: unknown = null;
    let lastStatus = 0;
    for (const method of ['POST', 'GET'] as const) {
      try {
        const res = await fetch(`${cfg.apiUrl}/instance/connect/${encodeURIComponent(conn.instance_name)}`, {
          method,
          headers: { apikey: cfg.apiKey },
        });
        lastStatus = res.status;
        if (res.ok) {
          qrJson = await res.json();
          break;
        }
      } catch (inner) {
        log.warn(
          { err: inner instanceof Error ? inner.message : 'unknown', method },
          'connections: regenerate QR attempt failed',
        );
      }
    }

    if (!qrJson) {
      return { ok: false, error: `evolution_unreachable_${lastStatus || 'network'}` };
    }

    const extracted = extractQrFromEvolution(qrJson);
    if (!extracted?.dataUri || !isValidQrDataUri(extracted.dataUri)) {
      log.warn(
        { hasBase64: Boolean(qrJson && typeof qrJson === 'object' && (qrJson as { base64?: unknown }).base64) },
        'connections: Evolution response did not contain a valid QR data URI',
      );
      return { ok: false, error: 'qr_not_available' };
    }

    const qrCode = extracted.dataUri;

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

/**
 * Limpa o QR code armazenado e marca a conexão como conectada.
 * Chamado pelo handler CONNECTION_UPDATE quando state=open.
 */
export async function clearQrCode(identifier: string): Promise<void> {
  const log = getLogger();
  try {
    const conn = await getUserConnection(identifier);
    if (!conn) return;
    if (!conn.qr_code) return;
    await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      headers: supHeaders(),
      body: JSON.stringify({
        qr_code: null,
        last_sync_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : 'unknown' },
      'connections: clearQrCode failed (non-fatal)',
    );
  }
}

/**
 * Versão "inteligente" de toQrDataUri re-exportada para que routes/
 * possam usar sem importar o módulo utils inteiro se quiserem.
 */
export { toQrDataUri };

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
        qr_code: null,
        phone_number: null,
        whatsapp_name: null,
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
