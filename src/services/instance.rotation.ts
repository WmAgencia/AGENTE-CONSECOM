/**
 * Rotação de instâncias + reconciliação de conexões.
 *
 * Dois problemas resolvidos aqui:
 *
 * 1) ROTAÇÃO (a cada campanha): antes da campanha começar, para cada WhatsApp
 *    conectado na campanha criamos uma instância NOVA (linha `rotation_of` =
 *    id da conexão antiga). O frontend mostra o popup com QR + nome. Quando o
 *    usuário escaneia e conecta, o webhook chama `reconcileConnectionOnConnect`,
 *    que troca as referências (campaigns.connection_ids, send_runs) da conexão
 *    antiga para a nova e APAGA a instância antiga da Evolution (não acumula
 *    lixo). Se o usuário clica "Pular", `skipRotation` apaga a instância nova
 *    e mantém a antiga.
 *
 * 2) RECONEXÃO no meio da campanha: se um WhatsApp cair sozinho e o usuário
 *    reconectar com uma instância NOVA, o sistema precisa entender que aquela
 *    instância nova pertence à campanha. Como a conexão nova passa a ter o
 *    mesmo `phone_number` da antiga, `reconcileConnectionOnConnect` casa por
 *    telefone (mesmo user/workspace), troca as referências das conexões antigas
 *    para a nova e marca as antigas como `superseded_by`.
 *
 * O gatilho é o webhook CONNECTION_UPDATE (state=open) na instância recém
 * conectada — ver src/routes/webhook.ts.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import {
  createInstanceForUser,
  deleteInstanceFromEvolution,
  fetchConnectionById,
  type WhatsAppConnection,
} from './evolution.connections.js';

// ---------------------------------------------------------------------------
// Acesso Supabase (service role)
// ---------------------------------------------------------------------------

function sup() {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

function headers(json = false): Record<string, string> {
  const cfg = getSupabaseProspeccaoConfig();
  return json
    ? { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}`, 'Content-Type': 'application/json' }
    : { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
}

interface CampaignConnectionsRow {
  id: string;
  connection_ids: string[] | null;
}

async function fetchCampaignConnectionIds(campaignId: string): Promise<string[]> {
  const s = sup();
  if (!s) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/campaigns?select=id,connection_ids&id=eq.${encodeURIComponent(campaignId)}&limit=1`,
      { headers: headers() },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as CampaignConnectionsRow[];
    return rows[0]?.connection_ids ?? [];
  } catch {
    return [];
  }
}

async function fetchConnectionsByIds(ids: string[]): Promise<WhatsAppConnection[]> {
  const s = sup();
  if (!s || ids.length === 0) return [];
  const orFilter = ids.map((id) => `id.eq.${encodeURIComponent(id)}`).join(',');
  try {
    const res = await fetch(
      `${s.url}/rest/v1/whatsapp_connections?select=*&or=(${orFilter})`,
      { headers: headers() },
    );
    if (!res.ok) return [];
    return (await res.json()) as WhatsAppConnection[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Utilitários de troca de referências
// ---------------------------------------------------------------------------

/** Troca o id da conexão antiga pela nova em `campaigns.connection_ids`
 *  (apenas campanhas que referenciam a antiga) e em `send_runs` pendentes
 *  (`connection_id`/`connection_instance`). Retorna quantas linhas mudaram. */
async function swapConnectionReferences(
  oldId: string,
  newId: string,
  newInstance: string,
): Promise<{ campaigns: number; sendRuns: number }> {
  const s = sup();
  const log = getLogger();
  let campaigns = 0;
  let sendRuns = 0;
  if (!s) return { campaigns, sendRuns };

  // Campanhas que ainda apontam para a conexão antiga.
  try {
    const cr = await fetch(
      `${s.url}/rest/v1/campaigns?select=id,connection_ids&connection_ids=cs.{${oldId}}`,
      { headers: headers() },
    );
    if (cr.ok) {
      const rows = (await cr.json()) as CampaignConnectionsRow[];
      for (const row of rows) {
        const next = (row.connection_ids ?? []).map((id) => (id === oldId ? newId : id));
        await fetch(`${s.url}/rest/v1/campaigns?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: headers(true),
          body: JSON.stringify({ connection_ids: next }),
        });
        campaigns += 1;
      }
    }
  } catch (e) {
    log.warn(
      { oldId, err: e instanceof Error ? e.message : 'unknown' },
      'rotation: falha ao trocar referências em campaigns',
    );
  }

  // send_runs pendentes/rodando da conexão antiga.
  try {
    const rr = await fetch(
      `${s.url}/rest/v1/send_runs?select=id&connection_id=eq.${encodeURIComponent(oldId)}`,
      { headers: headers() },
    );
    if (rr.ok) {
      const rows = (await rr.json()) as Array<{ id: string }>;
      for (const row of rows) {
        await fetch(`${s.url}/rest/v1/send_runs?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: headers(true),
          body: JSON.stringify({ connection_id: newId, connection_instance: newInstance }),
        });
        sendRuns += 1;
      }
    }
  } catch (e) {
    log.warn(
      { oldId, err: e instanceof Error ? e.message : 'unknown' },
      'rotation: falha ao trocar referências em send_runs',
    );
  }

  return { campaigns, sendRuns };
}

// ---------------------------------------------------------------------------
// ROTAÇÃO — preparação / pulo / finalização
// ---------------------------------------------------------------------------

export interface RotationPrepareResult {
  ok: boolean;
  message?: string;
  /** Conexões novas criadas (ou já pendentes) para o usuário escanear. */
  rotations?: Array<{ connection: WhatsAppConnection; displayName: string | null }>;
}

/**
 * Prepara a rotação de instâncias de uma campanha: para cada conexão conectada
 * na campanha, garante que existe UMA instância nova pendente (com QR) cujo
 * `rotation_of` aponta para a antiga. Idempotente: se já existe uma rotação
 * pendente/em conexão, reutiliza. Não cria para conexões desconectadas.
 */
export async function prepareRotationForCampaign(campaignId: string): Promise<RotationPrepareResult> {
  const log = getLogger();
  const ids = await fetchCampaignConnectionIds(campaignId);
  if (ids.length === 0) {
    return { ok: false, message: 'Campanha não tem conexões configuradas.' };
  }
  const conns = await fetchConnectionsByIds(ids);
  const rotations: Array<{ connection: WhatsAppConnection; displayName: string | null }> = [];

  for (const conn of conns) {
    if (conn.status !== 'connected') continue;
    // Se já existe uma rotação pendente para esta conexão, não duplica.
    const existing = await findPendingRotation(conn.id);
    if (existing) {
      rotations.push({ connection: existing, displayName: existing.display_name ?? existing.whatsapp_name });
      continue;
    }
    const result = await createInstanceForUser(
      conn.user_id ?? conn.workspace_id ?? 'unknown',
      conn.workspace_id,
      { rotationOf: conn.id },
    );
    if (result.ok && result.connection) {
      rotations.push({
        connection: result.connection,
        displayName: result.connection.display_name ?? result.connection.whatsapp_name,
      });
    } else {
      log.warn(
        { connId: conn.id, err: result.error },
        'rotation: falha ao criar instância de rotação',
      );
    }
  }

  return {
    ok: rotations.length > 0,
    message: rotations.length > 0
      ? `${rotations.length} WhatsApp(s) pronto(s) para escanear.`
      : 'Nenhuma conexão conectada para rotacionar.',
    rotations,
  };
}

/** Busca a rotação pendente (status pending/connecting) de uma conexão. */
async function findPendingRotation(rotationOf: string): Promise<WhatsAppConnection | null> {
  const s = sup();
  if (!s) return null;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/whatsapp_connections?select=*&rotation_of=eq.${encodeURIComponent(rotationOf)}&status=in.("pending","connecting")&limit=1`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as WhatsAppConnection[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * "Pular" a rotação: mantém a instância antiga e apaga a instância nova
 * pendente (Evolution + linha local). A campanha continua usando a conexão
 * antiga normalmente.
 */
export async function skipRotation(connectionId: string): Promise<{ ok: boolean; error?: string }> {
  const log = getLogger();
  const conn = await fetchConnectionById(connectionId);
  if (!conn) return { ok: false, error: 'conexão não encontrada.' };
  if (!conn.rotation_of) return { ok: false, error: 'conexão não é uma rotação.' };
  if (conn.status === 'connected') {
    return { ok: false, error: 'a rotação já foi conectada.' };
  }
  await deleteInstanceFromEvolution(conn.instance_name);

  const s = sup();
  if (!s) return { ok: false, error: 'supabase não configurado.' };
  const del = await fetch(`${s.url}/rest/v1/whatsapp_connections?id=eq.${encodeURIComponent(conn.id)}`, {
    method: 'DELETE',
    headers: headers(),
  });
  log.info({ connectionId, instance: conn.instance_name }, 'rotation: rotação pulada — instância nova apagada');
  if (!del.ok) {
    return { ok: false, error: 'falha ao remover a conexão pendente.' };
  }
  return { ok: true };
}

/**
 * Remove todas as rotações PENDENTES de uma campanha (instâncias novas que
 * nunca foram escaneadas/conectadas). Chamado quando a campanha realmente
 * começa (agendada -> em_progresso) ou quando o agendamento é cancelado —
 * evita instâncias "órfãs" acumulando no servidor.
 */
export async function cleanupPendingRotationsForCampaign(campaignId: string): Promise<number> {
  const log = getLogger();
  const ids = await fetchCampaignConnectionIds(campaignId);
  let cleaned = 0;
  for (const connId of ids) {
    const pending = await findPendingRotation(connId);
    if (!pending) continue;
    await deleteInstanceFromEvolution(pending.instance_name);
    const s = sup();
    if (s) {
      try {
        await fetch(`${s.url}/rest/v1/whatsapp_connections?id=eq.${encodeURIComponent(pending.id)}`, {
          method: 'DELETE',
          headers: headers(),
        });
      } catch (e) {
        log.warn(
          { pendingId: pending.id, err: e instanceof Error ? e.message : 'unknown' },
          'rotation: falha ao remover rotação pendente órfã',
        );
      }
    }
    cleaned += 1;
  }
  if (cleaned > 0) {
    log.info({ campaignId, cleaned }, 'rotation: rotações pendentes removidas');
  }
  return cleaned;
}

/**
 * Finaliza a rotação de UMA conexão recém conectada: troca referências da
 * antiga para a nova e apaga a instância antiga da Evolution. Retorna quantas
 * campanhas/send_runs foram atualizados.
 */
async function finalizeRotation(
  newConn: WhatsAppConnection,
  oldConn: WhatsAppConnection,
): Promise<{ campaigns: number; sendRuns: number }> {
  const log = getLogger();
  const swapped = await swapConnectionReferences(oldConn.id, newConn.id, newConn.instance_name);

  // Apaga a instância antiga da Evolution para não acumular lixo no VPS.
  await deleteInstanceFromEvolution(oldConn.instance_name);

  // Marca a antiga como substituída (auditoria) e limpa a ref de rotação na nova.
  const s = sup();
  if (s) {
    try {
      await fetch(`${s.url}/rest/v1/whatsapp_connections?id=eq.${encodeURIComponent(oldConn.id)}`, {
        method: 'PATCH',
        headers: headers(true),
        body: JSON.stringify({
          superseded_by: newConn.id,
          status: 'disconnected',
          qr_code: null,
          last_sync_at: new Date().toISOString(),
        }),
      });
    } catch (e) {
      log.warn(
        { oldId: oldConn.id, err: e instanceof Error ? e.message : 'unknown' },
        'rotation: falha ao marcar conexão antiga como substituída',
      );
    }
    try {
      await fetch(`${s.url}/rest/v1/whatsapp_connections?id=eq.${encodeURIComponent(newConn.id)}`, {
        method: 'PATCH',
        headers: headers(true),
        body: JSON.stringify({ rotation_of: null }),
      });
    } catch (e) {
      log.warn(
        { newId: newConn.id, err: e instanceof Error ? e.message : 'unknown' },
        'rotation: falha ao limpar rotation_of da conexão nova',
      );
    }
  }

  log.info(
    { oldInstance: oldConn.instance_name, newInstance: newConn.instance_name, campaigns: swapped.campaigns, sendRuns: swapped.sendRuns },
    'rotation: rotação finalizada — referências trocadas e instância antiga apagada',
  );
  return swapped;
}

// ---------------------------------------------------------------------------
// RECONCILIAÇÃO — chamada pelo webhook quando uma instância conecta (state=open)
// ---------------------------------------------------------------------------

/**
 * Chamada quando UMA instância acabou de conectar (webhook CONNECTION_UPDATE
 * state=open). Faz duas coisas:
 *
 * 1. Se a conexão nova é uma ROTAÇÃO (rotation_of set), finaliza: troca
 *    referências da antiga para a nova e apaga a instância antiga.
 *
 * 2. Caso contrário (reconexão normal com instância NOVA no meio da campanha),
 *    casa por phone_number no mesmo user/workspace: para cada conexão antiga
 *    (mesmo telefone, status != connected) que ainda é referenciada por
 *    campanhas, troca as referências para a nova e marca `superseded_by`.
 */
export async function reconcileConnectionOnConnect(instanceName: string): Promise<void> {
  const log = getLogger();
  const s = sup();
  if (!s) return;

  try {
    const res = await fetch(
      `${s.url}/rest/v1/whatsapp_connections?select=*&instance_name=eq.${encodeURIComponent(instanceName)}&limit=1`,
      { headers: headers() },
    );
    if (!res.ok) return;
    const rows = (await res.json()) as WhatsAppConnection[];
    const newConn = rows[0];
    if (!newConn || newConn.status !== 'connected') return;

    // Caso 1: rotação.
    if (newConn.rotation_of) {
      const oldConn = await fetchConnectionById(newConn.rotation_of);
      if (oldConn) {
        await finalizeRotation(newConn, oldConn);
        return;
      }
    }

    // Caso 2: reconexão com instância nova — casa por phone_number.
    if (!newConn.phone_number) return;
    const qPhone = encodeURIComponent(newConn.phone_number);
    const ownerFilter = newConn.workspace_id
      ? `workspace_id=eq.${encodeURIComponent(newConn.workspace_id)}`
      : `user_id=eq.${encodeURIComponent(newConn.user_id ?? '')}`;

    const oldRes = await fetch(
      `${s.url}/rest/v1/whatsapp_connections?select=*&phone_number=eq.${qPhone}&status=neq.connected&or=(${ownerFilter})`,
      { headers: headers() },
    );
    if (!oldRes.ok) return;
    const oldRows = (await oldRes.json()) as WhatsAppConnection[];
    if (oldRows.length === 0) return;

    // Filtra candidatas: ignora a própria conexão e as já substituídas.
    const candidates = oldRows.filter((c) => c.id !== newConn.id && !c.superseded_by);
    if (candidates.length === 0) return;

    for (const oldConn of candidates) {
      await finalizeRotation(newConn, oldConn);
    }
    log.info(
      { instance: instanceName, phone: newConn.phone_number, replaced: candidates.length },
      'rotation: reconexão com instância nova detectada — referências trocadas',
    );
  } catch (e) {
    log.warn(
      { instance: instanceName, err: e instanceof Error ? e.message : 'unknown' },
      'rotation: reconcileConnectionOnConnect falhou',
    );
  }
}