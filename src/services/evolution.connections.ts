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
import { getEvolutionConfig, getSupabaseProspeccaoConfig, getWebhookSecret } from '../config/env.js';
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
 * Builds the base Evolution instance name for a given workspace.
 * Naming convention: `consecom-<workspace_id>` (sanitized for Evolution rules).
 * Falls back to `consecom-user-<id12>` when no workspace_id is provided.
 */
function buildInstanceBaseName(workspaceId: string | null, userId: string): string {
  const sanitize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  if (workspaceId) {
    return `consecom-${sanitize(workspaceId)}`;
  }
  return `consecom-user-${sanitize(userId).slice(0, 12)}`;
}

/**
 * Retorna os nomes de instância que JÁ existem na Evolution API.
 * Usado para gerar nomes únicos ao conectar múltiplos WhatsApps —
 * a Evolution rejeita criação de instância duplicada (nome já em uso).
 */
async function fetchEvolutionInstanceNames(): Promise<Set<string>> {
  const log = getLogger();
  try {
    const cfg = getEvolutionConfig();
    const res = await fetch(`${cfg.apiUrl}/instance/fetchInstances`, {
      method: 'GET',
      headers: { apikey: cfg.apiKey },
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as Array<{ name?: string }>;
    return new Set((Array.isArray(data) ? data : []).map((x) => x.name).filter(Boolean) as string[]);
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : 'unknown' },
      'connections: fetchEvolutionInstanceNames failed',
    );
    return new Set();
  }
}

/**
 * Gera um nome de instância ÚNICO na Evolution para uma nova conexão.
 * Base = consecom-<workspace>/consecom-user-<id>. Se o nome base já existe
 * (nesta Evolution ou na tabela), acrescenta um sufixo -2, -3, ... até achar
 * um livre. Isso permite conectar 2, 3, ... WhatsApps independentes.
 */
async function buildUniqueInstanceName(
  workspaceId: string | null,
  userId: string,
  localUsed: Set<string>,
): Promise<string> {
  const base = buildInstanceBaseName(workspaceId, userId);
  const remote = await fetchEvolutionInstanceNames();
  const taken = new Set<string>([...remote, ...localUsed]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
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
  display_name: string | null;
  status: 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error';
  evolution_instance_id: string | null;
  qr_code: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  rotation_of: string | null;
  superseded_by: string | null;
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

/** Interface de seleção de conexão (multi-WhatsApp).
 *  id = UUID da linha em whatsapp_connections; instanceName = nome da instância Evolution.
 *  Quando ambos ausentes, resolve a conexão "primária" (connected > connecting > mais recente).
 */
export interface ConnectionTarget {
  id?: string;
  instanceName?: string;
}

/** Lista TODAS as conexões WhatsApp do usuário/workspace (multi-WhatsApp).
 *  Busca por workspace_id e user_id, desduplica por id e ordena por created_at desc.
 */
export async function getUserConnections(identifier: string): Promise<WhatsAppConnection[]> {
  const log = getLogger();
  try {
    const url = supUrl();
    const hdrs = supHeaders();
    const seen = new Map<string, WhatsAppConnection>();
    const consume = async (filterParam: string) => {
      const res = await fetch(
        `${url}/rest/v1/whatsapp_connections?select=*&${filterParam}&order=created_at.desc`,
        { headers: hdrs },
      );
      if (res.ok) {
        const rows = (await res.json()) as WhatsAppConnection[];
        for (const row of rows) {
          if (!seen.has(row.id)) seen.set(row.id, row);
        }
      }
    };
    await consume(`workspace_id=eq.${encodeURIComponent(identifier)}`);
    await consume(`user_id=eq.${encodeURIComponent(identifier)}`);
    const all = [...seen.values()];
    all.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    return all;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: getUserConnections failed');
    return [];
  }
}

/** Resolve uma conexão específica OU a "primária" do usuário/workspace.
 *  target.id tem precedência; depois target.instanceName; senão: connected > connecting > mais recente.
 */
export async function resolveConnection(
  identifier: string,
  target?: ConnectionTarget,
): Promise<WhatsAppConnection | null> {
  const all = await getUserConnections(identifier);
  if (all.length === 0) return null;
  if (target?.id) {
    const found = all.find((c) => c.id === target.id);
    if (found) return found;
  }
  if (target?.instanceName) {
    const found = all.find((c) => c.instance_name === target.instanceName);
    if (found) return found;
  }
  return (
    all.find((c) => c.status === 'connected') ??
    all.find((c) => c.status === 'connecting' || c.status === 'pending') ??
    all[0]
  );
}

/** Lê a conexão WhatsApp "primária" do usuário/workspace (compatibilidade com fluxos legados). */
export async function getUserConnection(identifier: string): Promise<WhatsAppConnection | null> {
  return resolveConnection(identifier);
}

/**
 * Resolve o grupo de notificações configurado para o dono da instância.
 * Fluxo: instance_name -> whatsapp_connections (user_id/workspace_id) ->
 * notification_groups (enabled=true). Retorna o JID do grupo ou null.
 */
export async function resolveNotificationGroupJid(instanceName: string): Promise<string | null> {
  const log = getLogger();
  try {
    const url = supUrl();
    const hdrs = supHeaders();

    // 1) Encontra a conexão da instância para obter user/workspace.
    const connRes = await fetch(
      `${url}/rest/v1/whatsapp_connections?select=user_id,workspace_id&instance_name=eq.${encodeURIComponent(instanceName)}&limit=1`,
      { headers: hdrs },
    );
    if (!connRes.ok) return null;
    const conns = (await connRes.json()) as Array<{ user_id: string | null; workspace_id: string | null }>;
    const conn = conns[0];
    if (!conn) return null;

    // 2) Busca o grupo de notificações ativo. Algumas conexões têm
    //    workspace_id preenchido mas o grupo foi gravado só com user_id
    //    (workspace null): tenta workspace_id e user_id.
    const connUserId = conn.user_id ?? '';
    const seen = new Set<string>();
    for (const cand of [conn.workspace_id, connUserId]) {
      if (!cand || seen.has(cand)) continue;
      seen.add(cand);
      const groupCandidates = `${url}/rest/v1/notification_groups?select=group_id&workspace_id=eq.${encodeURIComponent(cand)}&enabled=eq.true&order=created_at.desc&limit=1`;
      const gRes = await fetch(groupCandidates, { headers: hdrs });
      if (gRes.ok) {
        const groups = (await gRes.json()) as Array<{ group_id: string }>;
        if (groups[0]?.group_id) return groups[0].group_id;
      }
    }
    // Fallback: grupo vinculado apenas ao user_id.
    if (connUserId) {
      const gRes = await fetch(
        `${url}/rest/v1/notification_groups?select=group_id&user_id=eq.${encodeURIComponent(connUserId)}&enabled=eq.true&order=created_at.desc&limit=1`,
        { headers: hdrs },
      );
      if (gRes.ok) {
        const groups = (await gRes.json()) as Array<{ group_id: string }>;
        if (groups[0]?.group_id) return groups[0].group_id;
      }
    }
    return null;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: resolveNotificationGroupJid failed');
    return null;
  }
}

/** Opções de criação de instância. `rotationOf` indica que esta instância é
 *  uma ROTAÇÃO: ela substitui a conexão antiga (que ainda está em uso pela
 *  campanha) e, ao conectar, o fluxo de reconciliação troca as referências e
 *  apaga a antiga. Herda display_name/whatsapp_name da conexão antiga para o
 *  popup mostrar o nome cadastrado no WhatsApp.
 */
export interface CreateInstanceOptions {
  rotationOf?: string;
}

/** Cria uma nova instância na Evolution API e persiste a conexão no Supabase.
 *  A connection passa a ser identificada pelo instance_name ÚNICO, permitindo
 *  múltiplos WhatsApps simultâneos sem reutilizar a mesma instância.
 */
export async function createInstanceForUser(
  userId: string,
  workspaceId: string | null = null,
  opts: CreateInstanceOptions = {},
): Promise<{ ok: boolean; connection?: WhatsAppConnection; qrCode?: string; error?: string }> {
  const log = getLogger();
  try {
    const cfg = getEvolutionConfig();

    // Em caso de rotação, herda o nome cadastrado do WhatsApp da conexão antiga.
    let inheritedName: string | null = null;
    if (opts.rotationOf) {
      const old = await fetchConnectionById(opts.rotationOf);
      inheritedName = old?.display_name ?? old?.whatsapp_name ?? null;
    }

    // Nomes já usados localmente (mesmo usuário) => garante que o 2º WhatsApp
    // receba um instance_name diferente do 1º (multi-instância).
    const local = new Set<string>();
    const lists: Promise<WhatsAppConnection[]>[] = [];
    if (workspaceId) lists.push(fetchList('workspace_id', workspaceId));
    lists.push(fetchList('user_id', userId));
    const existing = (await Promise.all(lists)).flat();
    for (const row of existing) local.add(row.instance_name);
    const instanceName = await buildUniqueInstanceName(workspaceId, userId, local);

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
    const wbSecret = getWebhookSecret();
    const webhookRes = await fetch(`${cfg.apiUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
      body: JSON.stringify({
        webhook: {
          url: `${getPublicBaseUrl()}/webhook/evolution${wbSecret ? `?secret=${encodeURIComponent(wbSecret)}` : ''}`,
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
    const nowIso = new Date().toISOString();
    const insertPayload: Record<string, unknown> = {
      user_id: userId,
      workspace_id: workspaceId,
      instance_name: instanceName,
      status: initialStatus,
      qr_code: qrCode,
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (opts.rotationOf) {
      insertPayload.rotation_of = opts.rotationOf;
      if (inheritedName) insertPayload.display_name = inheritedName;
    }
    const insertRes = await fetch(`${supUrl()}/rest/v1/whatsapp_connections`, {
      method: 'POST',
      // Prefer: return=representation — sem ele o PostgREST responde 201 sem
      // corpo (`return=minimal`), o que quebra o `.json()` abaixo.
      headers: { ...supHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify(insertPayload),
    });
    let connection: WhatsAppConnection | undefined;
    if (insertRes.ok) {
      const text = await insertRes.text();
      if (text && text.trim().length > 0) {
        const created = JSON.parse(text) as WhatsAppConnection;
        connection = created;
      }
    }
    if (!connection) {
      // Fallback: busca a linha recém-criada para retornar ao frontend.
      const found = await getUserConnections(userId);
      connection = found.find((c) => c.instance_name === instanceName) ?? found[0];
    }

    return { ok: true, connection, qrCode: qrCode ?? undefined };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: createInstanceForUser failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

async function fetchList(col: 'workspace_id' | 'user_id', value: string): Promise<WhatsAppConnection[]> {
  try {
    const res = await fetch(
      `${supUrl()}/rest/v1/whatsapp_connections?select=id,instance_name&${col}=eq.${encodeURIComponent(value)}&order=created_at.desc`,
      { headers: supHeaders() },
    );
    if (!res.ok) return [];
    return (await res.json()) as WhatsAppConnection[];
  } catch {
    return [];
  }
}

/** Busca UMA conexão pelo id (usada para herdar nome na rotação e para
 *  reconciliar referências). Retorna null se não existir ou em erro. */
export async function fetchConnectionById(id: string): Promise<WhatsAppConnection | null> {
  try {
    const res = await fetch(
      `${supUrl()}/rest/v1/whatsapp_connections?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
      { headers: supHeaders() },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as WhatsAppConnection[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function updateConnectionDisplayName(identifier: string, id: string, displayName: string | null): Promise<WhatsAppConnection | null> {
  const current = await fetchConnectionById(id);
  if (!current || (current.user_id !== identifier && current.workspace_id !== identifier)) return null;
  const res = await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: 'PATCH',
    headers: { ...supHeaders(), Prefer: 'return=representation', 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as WhatsAppConnection[];
  return rows[0] ?? { ...current, display_name: displayName };
}

/** Apaga DEFINITIVAMENTE uma instância da Evolution API (rotas usadas para
 *  rotação: ao trocar a instância, a antiga é removida para não acumular
 *  instâncias "mortas" no servidor). Best-effort: falha não é fatal. */
export async function deleteInstanceFromEvolution(instanceName: string): Promise<boolean> {
  const log = getLogger();
  try {
    const cfg = getEvolutionConfig();
    const res = await fetch(
      `${cfg.apiUrl}/instance/delete/${encodeURIComponent(instanceName)}`,
      { method: 'DELETE', headers: { apikey: cfg.apiKey } },
    );
    log.info(
      { instance: instanceName, status: res.status },
      'connections: Evolution instance delete',
    );
    return res.ok || res.status === 404;
  } catch (e) {
    log.warn(
      { instance: instanceName, err: e instanceof Error ? e.message : 'unknown' },
      'connections: Evolution instance delete failed',
    );
    return false;
  }
}

/**
 * Auto-limpeza de conexões novas: apaga da Evolution e fecha no banco toda
 * conexão com status `pending`/`connecting` que NÃO conectou dentro de
 * `timeoutMs` desde a criação. Evita acúmulo de instâncias mortas/órfãs
 * (ex.: sessões com 401 device_removed) quando o usuário cria uma conexão
 * e não completa o pareamento via QR.
 *
 * Retorna o número de conexões limpas. Best-effort: erros parciais não
 * abortam a limpeza das demais.
 */
export async function cleanupStaleConnections(timeoutMs = 60_000): Promise<number> {
  const log = getLogger();
  try {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const url = `${supUrl()}/rest/v1/whatsapp_connections?select=id,instance_name,status&or=(status.eq.pending,status.eq.connecting)&created_at=lt.${encodeURIComponent(cutoff)}`;
    const res = await fetch(url, { headers: supHeaders() });
    if (!res.ok) return 0;
    const rows = (await res.json()) as Array<{ id: string; instance_name: string; status: string }>;
    if (rows.length === 0) return 0;

    log.info({ count: rows.length, cutoff }, 'connections: cleanupStaleConnections found stale connections');

    let cleaned = 0;
    for (const row of rows) {
      // Apaga a instância da Evolution (best-effort; 404 já conta como ok).
      const deleted = await deleteInstanceFromEvolution(row.instance_name);
      if (deleted) {
        // Instância removida de fato: apaga a linha — a conexão nunca
        // conectou e não há sessão a preservar. O usuário recomeça limpo.
        const delRes = await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${row.id}`, {
          method: 'DELETE',
          headers: supHeaders(),
        });
        if (delRes.ok) cleaned++;
        log.info(
          { instance: row.instance_name, status: row.status, deleted: delRes.ok },
          'connections: cleanupStaleConnections removed connection',
        );
      } else {
        // Falha ao apagar na Evolution (ex.: API instável): não deixa a linha
        // órfã apontando para uma instância inexistente. Marca 'error' para o
        // frontend mostrar e o usuário decidir; não fica mais 'connecting'
        // (a próxima varredura não o pega de novo, evitando loop).
        const patchRes = await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: supHeaders(),
          body: JSON.stringify({
            status: 'error',
            qr_code: null,
            last_sync_at: new Date().toISOString(),
          }),
        });
        if (patchRes.ok) cleaned++;
        log.warn(
          { instance: row.instance_name, patched: patchRes.ok },
          'connections: cleanupStaleConnections instance delete failed; connection marked error',
        );
      }
    }
    return cleaned;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : 'unknown' },
      'connections: cleanupStaleConnections failed',
    );
    return 0;
  }
}

/** Gera um novo QR Code para uma instância específica (ou a primária). */
export async function regenerateQRCode(
  identifier: string,
  target?: ConnectionTarget,
): Promise<{ ok: boolean; connection?: WhatsAppConnection; qrCode?: string; error?: string }> {
  const log = getLogger();
  try {
    const conn = await resolveConnection(identifier, target);
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

    return { ok: true, connection: { ...conn, qr_code: qrCode, status: 'connecting' }, qrCode };
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

/**
 * Desconecta UMA instância específica do WhatsApp (a passada em target, ou a
 * primária). O fluxo REAL de logout é:
 *   1. ENDPOINT: DELETE /instance/logout/{instance}?apikey=
 *      (esta build "evolution_exchange" v2.3.7 aceita DELETE — o teste direto
 *      confirmou: autorizado com header `apikey`; `x-api-key` retorna 401 e
 *      POST retorna 404. Ao logar com sucesso, a Evolution dispara
 *      CONNECTION_UPDATE state=open na instância.)
 *   2. Se DELETE falhar (ex: 404 de rota), cai no POST /instance/logout que
 *      nesta build devolve 404 — então NÃO forçamos estado local: o estado
 *      final fica conhecido pelo webhook CONNECTION_UPDATE que a Evolution
 *      envia após o logout de verdade.
 *   3. Local: marca status disconnected apenas quando a Evolution respondeu
 *      OK ao logout (remoteOk=true). Se o logout remoto falhou, DEIXA o estado
 *      como estava — assim o painel não mente dizendo que desconectou.
 *
 * Retorna { ok, connection } com a linha atualizada (status e dados limpos).
 */
export async function disconnectInstance(
  identifier: string,
  target?: ConnectionTarget,
): Promise<{ ok: boolean; connection?: WhatsAppConnection; error?: string }> {
  const log = getLogger();
  try {
    if (!target || (!target.id && !target.instanceName)) {
      return { ok: false, error: 'target_required' };
    }
    const conn = await resolveConnection(identifier, target);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();

    let remoteOk = false;
    // DELETE é o verbo correto nesta build (teste direto: 400 quando não
    // conectada, 401 só se header errado). DELETE 200 = logout ok.
    // 400 = "instance not connected" => o estado remoto já é desconectado,
    // portanto também conta como sucesso (objetivo alcançado).
    try {
      const res = await fetch(
        `${cfg.apiUrl}/instance/logout/${encodeURIComponent(conn.instance_name)}`,
        { method: 'DELETE', headers: { apikey: cfg.apiKey } },
      );
      log.info(
        { instance: conn.instance_name, status: res.status },
        'connections: logout DELETE',
      );
      remoteOk = res.ok || res.status === 400;
    } catch (inner) {
      log.warn(
        { err: inner instanceof Error ? inner.message : 'unknown' },
        'connections: logout DELETE failed',
      );
    }
// Se DELETE não existir nesta build, ou a Evolution retornar erro (ex:
    // sessão já morta com 500 "Connection Closed"), still mark local DB as
    // disconnected — o estado real da Evolution é desconhecido/inacessível,
    // então a conexão não pode ficar disponível para envio.
    if (!remoteOk) {
      log.warn(
        { instance: conn.instance_name },
        'connections: logout remoto falhou; marcando disconnected no banco local (sessao provavelmente morta)',
      );
    }

    const patch = {
      status: 'disconnected',
      qr_code: null,
      phone_number: null,
      whatsapp_name: null,
      display_name: null,
      evolution_instance_id: null,
      last_sync_at: new Date().toISOString(),
    } as const;
    await fetch(`${supUrl()}/rest/v1/whatsapp_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      headers: supHeaders(),
      body: JSON.stringify(patch),
    });

    const updated: WhatsAppConnection = {
      ...conn,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    return { ok: true, connection: updated };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: disconnectInstance failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

/** Busca os grupos disponíveis de uma instância específica (ou a primária). */
export async function fetchUserGroups(
  userId: string,
  target?: ConnectionTarget,
): Promise<{ ok: boolean; groups?: WhatsAppGroup[]; error?: string }> {
  const log = getLogger();
  try {
    const conn = await resolveConnection(userId, target);
    if (!conn) return { ok: false, error: 'no_connection' };

    const cfg = getEvolutionConfig();
    const res = await fetch(
      `${cfg.apiUrl}/group/fetchAllGroups/${encodeURIComponent(conn.instance_name)}?getParticipants=false`,
      {
        method: 'GET',
        headers: { apikey: cfg.apiKey },
      },
    );

    if (!res.ok) {
      return { ok: false, error: `Evolution API erro ${res.status}` };
    }

    const data = (await res.json()) as unknown;
    const raw = (Array.isArray(data) ? data : []) as Array<{
      id: string;
      subject?: string;
      name?: string;
    }>;
    const groups: WhatsAppGroup[] = raw.map((g) => ({
      id: g.id,
      name: g.subject ?? g.name ?? 'Grupo sem nome',
    }));

    return { ok: true, groups };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'connections: fetchUserGroups failed');
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  }
}

/** Envia mensagem de teste para um grupo via instância específica (ou a primária). */
export async function sendTestMessage(
  userId: string,
  groupId: string,
  target?: ConnectionTarget,
): Promise<{ ok: boolean; error?: string }> {
  const log = getLogger();
  try {
    const conn = await resolveConnection(userId, target);
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
