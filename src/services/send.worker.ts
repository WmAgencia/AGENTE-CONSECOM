/**
 * Consecom auto-send worker.
 *
 * Polls Supabase (via service role) for pending `send_runs` and delivers the
 * campaign message sequence to each lead on schedule:
 *
 *   - Reads pending/running `send_runs`.
 *   - When `next_send_at <= now`, pops the next `queue_message` and sends it
 *     (text via sendText, media via sendMedia).
 *   - Advances `current_position`, sets the gap `+delay_seconds` into
 *     `next_send_at`.
 *   - On completion marks the run `done` and the lead status `enviado`.
 *
 * ORDERING (sequencial por lead — Regra A): a cada tick a campanha dispara
 * SOMENTE o lead ativo, em ordem de entrada (`created_at`): o primeiro run
 * 'running' é o lead em andamento; sem nenhum, o primeiro 'pending' (mais
 * antigo) inicia. A sequência completa de um lead (M1..Mn com os intervalos
 * `delay_seconds` de cada mensagem) termina ANTES de o próximo lead começar:
 *   L1 M1 -> (6s) L1 M2 -> (3s) L1 M3 -> (3s) L1 M4 ... -> L2 M1 -> ...
 * Os demais leads ('pending') aguardam a vez e não disparam em paralelo.
 *
 * FAILURE (Regra B): erro temporário (transiente/5xx) não é falha definitiva —
 * o run permanece ATIVO ('running') com um retry agendado (backoff x tentativa),
 * mantendo a IA do lead bloqueada. QUALQUER falha definitiva (retries esgotados,
 * número inválido/fixo, lead sem telefone, lead não encontrado) ABORTA a
 * sequência inteira daquele lead: as próximas mensagens NÃO são enviadas, o run
 * é marcado 'failed' com a etapa que falhou (failed_step) e o motivo
 * registrados no histórico, e o próximo lead da fila passa a ser processado.
 * Um lead 'failed' nunca é retomado.
 *
 * PAUSE: o worker só processa campanhas `em_progresso`. Ao pausar, o frontend
 * grava `status = pausada` e o worker simplesmente ignora a campanha (nenhum
 * novo disparo, mesmo com next_send_at vencido). Ao retomar (`em_progresso`),
 * a campanha volta ao polling e continua EXATAMENTE de onde parou
 * (current_position + next_send_at por lead são preservados — nada é reenviado).
 *
 * CONCURRENCY: instância única por processo (`started` guard) + `busy` + um set
 * de runs em processamento garantem execução única (sem M2 duplicada), inclusive
 * com ticks sobrepostos e cliques repetidos em retomar.
 *
 * ANTI-SPAM: antes de cada envio o worker passa pelo SpamProtection — limite
 * de mensagens por minuto (EVOLUTION_RATE_LIMIT_MAX_PER_MINUTE) e jitter
 * aleatório (EVOLUTION_SEND_JITTER_MIN_MS/MAX_MS). Ao atingir o limite, o
 * worker espera o fim da janela de 1 minuto (o run permanece 'running').
 *
 * Uses the Supabase REST API with the service role key (bypasses RLS).
 * Does not store secrets; reads them from env via the config module.
 */
import { getSupabaseProspeccaoConfig, getEnv } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { sendText, sendMedia, type MediaKind } from './evolution.service.js';
import { validateVideoSize } from './media.limits.js';
import { SpamProtection } from './spam-protection.js';
import { classifyBrazilianPhone, normalizeBrazilianPhone } from '../lib/phone.js';
import { loadAgentName, formatAgentSignature } from './supabase.leads.js';
import { renderTemplate } from './template.service.js';
import { getConversationStore } from './conversation.store.js';
import { processDueScheduledCampaigns } from './campaign.schedule.service.js';
import {
  loadCampaignStrategies,
  pickStrategyForLead,
  loadStrategiesByIds,
  type Strategy,
} from './strategy.service.js';

const TICK_MS = Number(getEnv().CONSECOM_WORKER_TICK_MS ?? 5000);

interface SendRunRow {
  id: string;
  campaign_id: string;
  lead_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  current_position: number;
  next_send_at: string | null;
  position?: number | null;
  connection_id?: string | null;
  connection_instance?: string | null;
}

interface QueueMessageRow {
  id: string;
  position: number;
  kind: 'text' | 'audio' | 'video' | 'image' | 'document';
  text: string | null;
  media_url: string | null;
  media_caption: string | null;
  delay_seconds: number;
}

interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  category: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  rating: number | null;
  reviews: number | null;
  niche: string | null;
  instagram?: string | null;
  status: string | null;
  strategy_id?: string | null;
}

export class SendWorker {
  private readonly url: string;
  private readonly key: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private started = false;

  // Guard de concorrência: runs em processamento neste momento (evita
  // processar o mesmo run duas vezes em ticks sobrepostos).
  private readonly processingRuns = new Set<string>();

  // Contagem de tentativas por envio (worker-scoped). Garante que uma mensagem
  // com falha permanente não fique em retry infinito: após
  // CONSECOM_SEND_MAX_RETRIES o run é marcado 'failed'.
  private readonly retryCounts = new Map<string, number>();

  // Anti-spam da Evolution: rate limit por minuto + jitter entre envios.
  private readonly spam = new SpamProtection();

  // Conexões atualmente indisponíveis (instance_name): o worker pula envios
  // por essas conexões sem abortar o lead, e remove daqui quando voltam.
  private readonly downConnections = new Map<string, number>();

  constructor() {
    const c = getSupabaseProspeccaoConfig();
    this.url = c.url;
    this.key = c.serviceRoleKey;
  }

  private headers(json = false): Record<string, string> {
    return json
      ? { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }
      : { apikey: this.key, Authorization: `Bearer ${this.key}` };
  }

  private async getLead(leadId: string): Promise<LeadRow | null> {
    const r = await fetch(`${this.url}/rest/v1/leads?id=eq.${leadId}&select=*`, {
      headers: this.headers(),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as LeadRow[];
    return rows[0] ?? null;
  }

  private async getActiveCampaigns(): Promise<Array<{ id: string; status: string }>> {
    // Campanhas em andamento. O worker finaliza cada uma quando não há mais
    // nenhum run pendente/ativo (intercalado por rodadas dentro da campanha).
    // 'waiting_connection' entra no mesmo fence para retomar sozinho quando
    // uma conexão voltar (item 28/33).
    const r = await fetch(
      `${this.url}/rest/v1/campaigns?select=id,status&status=in.("em_progresso","waiting_connection")`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    return (await r.json()) as Array<{ id: string; status: string }>;
  }

  private async getCampaignRuns(campaignId: string): Promise<SendRunRow[]> {
    // Ordenação persistente por campanha. Os fallbacks mantêm compatibilidade
    // com rows criadas antes da migração da posição.
    const query = `campaign_id=eq.${encodeURIComponent(campaignId)}&status=in.("pending","running")`;
    let r = await fetch(
      `${this.url}/rest/v1/send_runs?select=id,campaign_id,lead_id,status,current_position,next_send_at,position,connection_id,connection_instance&${query}&order=position.asc,created_at.asc,id.asc`,
      { headers: this.headers() },
    );
    if (!r.ok) {
      // Permite deploy gradual enquanto a v21 ainda aguarda aplicação manual.
      r = await fetch(
        `${this.url}/rest/v1/send_runs?select=id,campaign_id,lead_id,status,current_position,next_send_at,connection_id,connection_instance&${query}&order=created_at.asc,id.asc`,
        { headers: this.headers() },
      );
    }
    if (!r.ok) return [];
    return (await r.json()) as SendRunRow[];
  }

  private async getCampaignInstance(campaignId: string): Promise<string | null> {
    const r = await fetch(
      `${this.url}/rest/v1/campaigns?select=whatsapp_instance&id=eq.${encodeURIComponent(campaignId)}`,
      { headers: this.headers() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ whatsapp_instance: string | null }>;
    return rows[0]?.whatsapp_instance ?? null;
  }

  private async getConnectionInstance(connectionId?: string | null): Promise<string | null> {
    if (!connectionId) return null;
    const r = await fetch(
      `${this.url}/rest/v1/whatsapp_connections?select=instance_name&id=eq.${encodeURIComponent(connectionId)}&limit=1`,
      { headers: this.headers() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ instance_name: string | null }>;
    return rows[0]?.instance_name ?? null;
  }

  /** Lista as conexões disponíveis da campanha (connection_ids filtradas por status 'connected'). */
  private async getAvailableCampaignConnections(campaignId: string): Promise<Array<{ id: string; instance_name: string }>> {
    const cr = await fetch(
      `${this.url}/rest/v1/campaigns?select=connection_ids&id=eq.${encodeURIComponent(campaignId)}`,
      { headers: this.headers() },
    );
    if (!cr.ok) return [];
    const rows = (await cr.json()) as Array<{ connection_ids: string[] | null }>;
    const ids = rows[0]?.connection_ids ?? [];
    if (ids.length === 0) return [];
    const orFilter = ids.map((id) => `id.eq.${id}`).join(',');
    const r = await fetch(
      `${this.url}/rest/v1/whatsapp_connections?select=id,instance_name,status&or=(${orFilter})`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    const all = (await r.json()) as Array<{ id: string; instance_name: string; status: string }>;
    // Ordena na mesma ordem de `connection_ids` da campanha para que o
    // round-robin percorra as conexões na ordem em que o usuário as escolheu
    // (PostgREST não garante ordem no filtro `or`).
    const order = new Map(ids.map((id, i) => [id, i]));
    return all
      .filter((c) => c.status === 'connected')
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  /** Verifica se a instância está 'connected' agora. */
  private async isInstanceAvailable(instance: string): Promise<boolean> {
    const r = await fetch(
      `${this.url}/rest/v1/whatsapp_connections?select=status&instance_name=eq.${encodeURIComponent(instance)}&limit=1`,
      { headers: this.headers() },
    );
    if (!r.ok) return false;
    const rows = (await r.json()) as Array<{ status: string }>;
    return rows[0]?.status === 'connected';
  }

  /** Reatribui a conexão de um run pendente entre as conexões disponíveis (round-robin). */
  private async reassignRunConnection(run: SendRunRow, available: Array<{ id: string; instance_name: string }>): Promise<void> {
    if (available.length === 0) return;
    const conn = this.pickAvailableConnection(run.campaign_id, available);
    // Atualiza o objeto em memória ANTES do PATCH: processRun() usa o mesmo
    // objeto `run` neste tick e, se ficar stale (connection_id null), cai no
    // fallback legado (campaigns.whatsapp_instance) enviando TUDO por UM WhatsApp.
    run.connection_id = conn.id;
    run.connection_instance = conn.instance_name;
    await this.patchSendRun(run.id, { connection_id: conn.id, connection_instance: conn.instance_name });
  }

  /**
   * Pool dinâmico + round-robin: índice rotativo POR CAMPANHA sobre as
   * conexões disponíveis. Conexões que caem saem do pool automaticamente
   * (o `% available.length` redistribui) e voltam quando reconectam — sem
   * duplicar nem trocar lead no meio do envio (item 33/42).
   */
  private readonly rotationIndex = new Map<string, number>();

  private pickAvailableConnection(
    campaignId: string,
    available: Array<{ id: string; instance_name: string }>,
  ): { id: string; instance_name: string } {
    const rot = this.rotationIndex.get(campaignId) ?? 0;
    const conn = available[rot % available.length];
    this.rotationIndex.set(campaignId, rot + 1);
    return conn;
  }

  /** Reatribui um run para outra conexão viva do pool (se existir). */
  private async switchRunToAvailableConnection(run: SendRunRow): Promise<string | null> {
    const live = await this.getAvailableCampaignConnections(run.campaign_id);
    if (live.length === 0) return null;
    const conn = this.pickAvailableConnection(run.campaign_id, live);
    run.connection_id = conn.id;
    run.connection_instance = conn.instance_name;
    await this.patchSendRun(run.id, { connection_id: conn.id, connection_instance: conn.instance_name });
    return conn.instance_name;
  }

  /** Atualiza o status da campanha (best-effort; falha não derruba o tick). */
  private async patchCampaignStatus(campaignId: string, status: string): Promise<void> {
    const r = await fetch(
      `${this.url}/rest/v1/campaigns?id=eq.${encodeURIComponent(campaignId)}`,
      { method: 'PATCH', headers: this.headers(true), body: JSON.stringify({ status }) },
    );
    if (!r.ok) {
      getLogger().warn(
        { campaignId, status, http: r.status },
        'send-worker: falha ao atualizar status da campanha (verifique a migração do status waiting_connection)',
      );
    }
  }

  /** Retorna true se a campanha tem connection_ids configuradas (mesmo que todas caiam). */
  private async campaignHasConnections(campaignId: string): Promise<boolean> {
    const r = await fetch(
      `${this.url}/rest/v1/campaigns?select=connection_ids&id=eq.${encodeURIComponent(campaignId)}`,
      { headers: this.headers() },
    );
    if (!r.ok) return false;
    const rows = (await r.json()) as Array<{ connection_ids: string[] | null }>;
    return (rows[0]?.connection_ids ?? []).length > 0;
  }

  /** Registra que uma conexão caiu (uma vez por ocorrência; evita alerta repetido). */
  private onConnectionDown(instance: string): void {
    const log = getLogger();
    if (this.downConnections.has(instance)) return;
    this.downConnections.set(instance, Date.now());
    log.warn({ instance }, 'send-worker: conexao indisponivel — removida temporariamente do ciclo de distribuicao');
  }

  /** Registra que uma conexão voltou. */
  private onConnectionBack(instance: string): void {
    const log = getLogger();
    if (!this.downConnections.has(instance)) return;
    this.downConnections.delete(instance);
    log.info({ instance }, 'send-worker: conexao voltou — reentrou no ciclo de distribuicao');
  }

  private async getConnectionDisplayName(connectionId?: string | null, instance?: string | null): Promise<string | null> {
    if (!connectionId && !instance) return null;
    const filter = connectionId
      ? `id=eq.${encodeURIComponent(connectionId)}`
      : `instance_name=eq.${encodeURIComponent(instance!)}`;
    const r = await fetch(
      `${this.url}/rest/v1/whatsapp_connections?select=display_name&${filter}&limit=1`,
      { headers: this.headers() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ display_name: string | null }>;
    return rows[0]?.display_name ?? null;
  }

  /** Prefixa apenas a mensagem final da campanha, sem alterar o template salvo. */
  private formatConnectionMessage(text: string, displayName: string | null): string {
    const name = displayName?.trim();
    if (!name) return text;
    const prefix = `*${name}*`;
    if (text === prefix || text.startsWith(`${prefix}\n`) || text.startsWith(`${prefix}\r\n`)) return text;
    // Evita empilhar prefixos caso outro estágio já tenha formatado a mensagem.
    if (/^\*[^*\r\n]+\*\r?\n/.test(text)) return text;
    return `${prefix}\n${text}`;
  }

  /** Encerra de verdade a campanha (status finalizada + finished_at). */
  private async finalizeCampaign(campaignId: string): Promise<void> {
    await fetch(`${this.url}/rest/v1/campaigns?id=eq.${campaignId}`, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify({ status: 'finalizada', finished_at: new Date().toISOString() }),
    });
  }

  private async getQueueMessages(campaignId: string): Promise<QueueMessageRow[]> {
    const r = await fetch(
      `${this.url}/rest/v1/queue_messages?campaign_id=eq.${campaignId}&select=*&order=position.asc`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    return (await r.json()) as QueueMessageRow[];
  }

  private async patchSendRun(runId: string, patch: Record<string, unknown>): Promise<void> {
    await fetch(`${this.url}/rest/v1/send_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify(patch),
    });
  }

  /** Soma +1 no campo de sucesso/falha da campanha (contagem agregada). */
  private async bumpCampaign(campaignId: string, field: 'success_count' | 'fail_count'): Promise<void> {
    const r = await fetch(
      `${this.url}/rest/v1/campaigns?id=eq.${campaignId}&select=${field},fail_count,success_count`,
      { headers: this.headers() },
    );
    if (!r.ok) return;
    const rows = (await r.json()) as Array<Record<string, number>>;
    const row = rows[0];
    if (!row) return;
    const nextSuccess = field === 'success_count' ? row.success_count + 1 : row.success_count;
    const nextFail = field === 'fail_count' ? row.fail_count + 1 : row.fail_count;
    await fetch(`${this.url}/rest/v1/campaigns?id=eq.${campaignId}`, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify({ success_count: nextSuccess, fail_count: nextFail }),
    });
  }

  /**
   * ABORTA a sequência do lead (Regra de Falha).
   *
   * Uma falha definitiva interrompe TODO o restante da sequência daquele lead:
   * as próximas mensagens NÃO são enviadas e o próximo lead da fila passa a
   * ser processado. Registra a etapa que falhou (failed_step = position + 1) e
   * o motivo no histórico do lead, além de marcar o run 'failed'.
   */
  private async abortRun(run: SendRunRow, position: number, reason: string): Promise<void> {
    const log = getLogger();
    await this.patchSendRun(run.id, {
      status: 'failed',
      current_position: position,
      fail_reason: reason,
    });
    await this.bumpCampaign(run.campaign_id, 'fail_count');
    try {
      await fetch(`${this.url}/rest/v1/lead_status_history`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          lead_id: run.lead_id,
          status: 'failed',
          notes: `failed_step: ${position + 1}; reason: ${reason}`,
        }),
      });
    } catch (err) {
      log.warn(
        { runId: run.id, errMessage: err instanceof Error ? err.message : 'unknown' },
        'send-worker: falha ao registrar aborto no lead_status_history',
      );
    }
    log.info(
      { runId: run.id, leadId: run.lead_id, failedStep: position + 1, reason },
      '[CAMPAIGN] lead abortado — sequência interrompida (próximas mensagens não enviadas)',
    );
  }

  private async updateLeadStatus(leadId: string, status: string): Promise<void> {
    await fetch(`${this.url}/rest/v1/leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify({ status, last_message_sent: new Date().toISOString() }),
    });
    await fetch(`${this.url}/rest/v1/lead_status_history`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ lead_id: leadId, status }),
    });
  }

  /** Move o lead para a coluna "Números para ligação" (status 'para_ligacao'). */
  private async moveLeadToCall(leadId: string, reason: string): Promise<void> {
    await fetch(`${this.url}/rest/v1/leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify({
        status: 'para_ligacao',
        call_reason: reason,
        call_moved_at: new Date().toISOString(),
      }),
    });
    await fetch(`${this.url}/rest/v1/lead_status_history`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ lead_id: leadId, status: 'para_ligacao', notes: reason }),
    });
  }

  private async patchLeadStrategy(leadId: string, strategyId: string): Promise<void> {
    await fetch(`${this.url}/rest/v1/leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify({ strategy_id: strategyId }),
    });
  }

  /**
   * Persiste no histórico da conversa do lead a mensagem automática que a
   * campanha acabou de enviar. Assim, quando o lead responder, o agente
   * enxerga o que já foi dito pela campanha (contexto completo) em vez de
   * começar do zero. Grava (a) no conversation store (mesmo id usado pelo
   * webhook, role assistant) e (b) em consecom_conversations.
   */
  private async recordCampaignTurn(
    leadId: string,
    sendPhone: string,
    sentText: string,
    senderDisplayName: string | null = null,
  ): Promise<void> {
    try {
      const jid = `${sendPhone}@s.whatsapp.net`;
      await getConversationStore().appendAssistant(`wa:${jid}`, sentText);
    } catch (err) {
      const log = getLogger();
      log.warn(
        { leadId, errMessage: err instanceof Error ? err.message : 'unknown' },
        'send-worker: failed to record campaign turn in conversation store',
      );
    }
    try {
      await fetch(`${this.url}/rest/v1/consecom_conversations`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          lead_id: leadId,
          role: 'assistant',
          content: sentText,
          agent_model: null,
          sender_display_name: senderDisplayName,
        }),
      });
    } catch (err) {
      const log = getLogger();
      log.warn(
        { leadId, errMessage: err instanceof Error ? err.message : 'unknown' },
        'send-worker: failed to record campaign turn in consecom_conversations',
      );
    }
  }

  private async processRun(run: SendRunRow): Promise<void> {
    const log = getLogger();
    const msgs = await this.getQueueMessages(run.campaign_id);
    if (msgs.length === 0) {
      await this.patchSendRun(run.id, { status: 'done', current_position: 0 });
      return;
    }

    const assignedInstance = run.connection_instance || await this.getConnectionInstance(run.connection_id);
    const hasSelectedConnections = await this.campaignHasConnections(run.campaign_id);
    const campaignInstance = hasSelectedConnections ? null : await this.getCampaignInstance(run.campaign_id);
    const sendInstance = assignedInstance || campaignInstance || undefined;

    // Disponibilidade da conexão atribuída: se caiu, NÃO aborta o lead —
    // apenas pula este tick (o run continua 'running' e será reprocessado
    // quando a conexão voltar, ou com fallback se o lead ainda não recebeu
    // nenhuma mensagem).
    if (sendInstance) {
      const available = await this.isInstanceAvailable(sendInstance);
      if (!available) {
        this.onConnectionDown(sendInstance);
        // Conexão caiu: NÃO aborta o lead. Reatribui para qualquer conexão viva
        // do pool e o run continua 'running' na mesma posição (a mensagem do
        // instante da queda pode duplicar, mas o lead nunca é perdido nem pulado).
        const alt = await this.switchRunToAvailableConnection(run);
        if (alt) {
          log.warn(
            { runId: run.id, oldInstance: sendInstance, newInstance: alt },
            'send-worker: conexao caiu — continuando lead em conexao viva do pool',
          );
          return;
        }
        log.warn({ runId: run.id, instance: sendInstance }, 'send-worker: conexao indisponivel, aguardando (lead preservado)');
        return;
      }
      this.onConnectionBack(sendInstance);
    }

    const position = run.current_position;
    const next = msgs[position];
    if (!next) {
      await this.patchSendRun(run.id, { status: 'done', current_position: position });
      await this.updateLeadStatus(run.lead_id, 'enviado');
      log.info(
        { runId: run.id, leadId: run.lead_id },
        '[CAMPAIGN] run done — todas as mensagens da sequência enviadas',
      );
      return;
    }

    const lead = await this.getLead(run.lead_id);
    if (!lead) {
      log.warn({ runId: run.id, leadId: run.lead_id }, 'send-worker: lead not found, aborting');
      await this.abortRun(run, position, 'lead_nao_encontrado');
      return;
    }
    const phone = lead.phone;
    if (!phone) {
      log.warn({ runId: run.id, leadId: run.lead_id }, 'send-worker: no phone, aborting');
      await this.abortRun(run, position, 'sem_telefone');
      return;
    }

    // Normalização / roteamento por tipo de número. A Evolution API aceita
    // somente dígitos; fixos e números inválidos não entram em WhatsApp e são
    // movidos para a coluna "Números para ligação" do funil (status
    // 'para_ligacao'), saindo definitivamente da fila de disparo.
    const pinfo = classifyBrazilianPhone(phone);
    if (pinfo.class !== 'MOBILE') {
      const callReason = pinfo.class === 'LANDLINE' ? 'telefone_fixo' : 'numero_invalido';
      log.info(
        { runId: run.id, leadId: run.lead_id, klass: pinfo.class, reason: pinfo.reason },
        'send-worker: numero fora do padrao WhatsApp, movendo para lista de ligacao',
      );
      await this.moveLeadToCall(run.lead_id, callReason);
      await this.abortRun(run, position, callReason);
      return;
    }
    const sendPhone = pinfo.e164!;

    // Estratégia: na 1ª mensagem do lead, garante um strategy_id sorteado pela
    // campanha (A/B) e, quando a estratégia define uma first_message, usa-a no
    // lugar da mensagem 1 da sequência. Demais mensagens seguem o template.
    let strategyText = next.text ?? '';
    let strategyKind = next.kind;
    let strategyMediaUrl = next.media_url;
    let strategyCaption = next.media_caption;
    try {
      const links = await loadCampaignStrategies(run.campaign_id);
      const chosen = pickStrategyForLead(links, (lead as { strategy_id?: string | null }).strategy_id ?? null);
      if (chosen && chosen !== (lead as { strategy_id?: string | null }).strategy_id) {
        await this.patchLeadStrategy(run.lead_id, chosen);
      }
      if (chosen && position === 0) {
        const strategies = await loadStrategiesByIds([chosen]);
        const st: Strategy | undefined = strategies[0];
        if (st?.first_message && st.first_message.trim().length > 0) {
          strategyText = st.first_message.trim();
          strategyKind = 'text';
          strategyMediaUrl = null;
          strategyCaption = null;
          log.info({ runId: run.id, strategy: st.code }, 'send-worker: using strategy first_message');
        }
      }
    } catch (err) {
      log.warn(
        { runId: run.id, err: err instanceof Error ? err.message : 'unknown' },
        'send-worker: strategy assignment failed; continuing with default sequence',
      );
    }

    log.info({ runId: run.id, position, kind: next.kind, phone: sendPhone }, '[CAMPAIGN] disparando mensagem da campanha');
    // Anti-spam: respeita o limite de msg/min da Evolution e aplica um delay
    // aleatório antes do envio (pode bloquear o tick enquanto espera).
    await this.spam.checkRateLimit();
    await this.spam.jitter();
    const connectionDisplayName = await this.getConnectionDisplayName(run.connection_id, sendInstance);
    let ok = false;
    let sentText = '';
    let mediaValidationError: string | null = null;
    try {      if (strategyKind === 'text' && strategyText) {
        sentText = this.formatConnectionMessage(renderTemplate(strategyText, lead), connectionDisplayName);
        ok = (await sendText({ to: sendPhone, text: sentText, instance: sendInstance })).ok;
      } else if (strategyMediaUrl) {
        const mediaUrl = strategyMediaUrl.startsWith('http')
          ? strategyMediaUrl
          : `${this.url}/storage/v1/object/public/${strategyMediaUrl.replace(/^\/+/, '')}`;
        mediaValidationError = await this.validateRemoteVideoSize(mediaUrl, strategyKind);
        if (!mediaValidationError) {
          const captionText = strategyCaption
            ? this.formatConnectionMessage(renderTemplate(strategyCaption, lead), connectionDisplayName)
            : `[${strategyKind}]`;
          sentText = captionText;
          ok = (
            await sendMedia({
              to: sendPhone,
              kind: strategyKind as MediaKind,
              media: mediaUrl,
              caption: strategyCaption
                ? this.formatConnectionMessage(renderTemplate(strategyCaption, lead), connectionDisplayName)
                : undefined,
              mimetype: guessMimetype(mediaUrl, strategyKind),
              filename: basename(mediaUrl),
              instance: sendInstance,
            })
          ).ok;
          if (!strategyCaption) sentText = `${captionText} ${mediaUrl}`;
        }
      }
    } catch (err) {
      log.warn(
        { runId: run.id, position, err: err instanceof Error ? err.message : 'unknown' },
        'send-worker: send threw; treating as failure',
      );
      ok = false;
    }

    if (mediaValidationError) {
      log.warn({ runId: run.id, position, kind: strategyKind }, mediaValidationError);
      await this.abortRun(run, position, 'video_too_large');
      return;
    }

    if (!ok) {
      // Falha de envio (Regra B): a sequência NÃO é considerada concluída.
      // O run permanece ativo com um retry agendado (backoff x tentativa),
      // mantendo sequence_active = true e a IA bloqueada. Ao esgotar as
      // tentativas o run é marcado 'failed' (sequência interrompida).
      //
      // Discrimina falha de CONEXÃO de falha do LEAD: se a instância caiu no
      // momento do envio, reatribui para uma conexão viva e re-agenda o MESMO
      // passo SEM contar tentativa nem abortar — falha de infraestrutura não
      // deve penalizar o lead. Só falhas com a conexão de pé (número inválido,
      // recusa, banimento) contabilizam tentativa e podem abortar.
      if (sendInstance) {
        const connAlive = await this.isInstanceAvailable(sendInstance);
        if (!connAlive) {
          this.onConnectionDown(sendInstance);
          const alt = await this.switchRunToAvailableConnection(run);
          const retryAt = new Date(Date.now() + 30_000).toISOString();
          await this.patchSendRun(run.id, {
            status: 'running',
            current_position: position,
            next_send_at: retryAt,
            fail_reason: 'connection_failed',
          });
          log.warn(
            { runId: run.id, position, oldInstance: sendInstance, newInstance: alt ?? null },
            'send-worker: envio falhou por conexao — reatribuido, tentativa nao contabilizada',
          );
          return;
        }
      }
      const maxRetries = (() => {
        try {
          return getEnv().CONSECOM_SEND_MAX_RETRIES;
        } catch {
          return 3;
        }
      })();
      const backoffMs = (() => {
        try {
          return getEnv().CONSECOM_SEND_RETRY_BACKOFF_MS;
        } catch {
          return 60_000;
        }
      })();
      const attempt = (this.retryCounts.get(run.id) ?? 0) + 1;
      this.retryCounts.set(run.id, attempt);
      if (attempt >= maxRetries) {
        log.warn(
          { runId: run.id, position, kind: next.kind, attempt },
          'send-worker: send failed; retries exhausted, aborting lead',
        );
        await this.abortRun(run, position, 'send_failed');
        log.info(
          { runId: run.id, leadId: run.lead_id, position, attempt },
          '[CAMPAIGN] lead abortado — falha de envio definitiva (retries esgotados)',
        );
      } else {
        const retryAt = new Date(Date.now() + backoffMs * attempt).toISOString();
        log.warn(
          { runId: run.id, position, kind: next.kind, attempt, nextRetryAt: retryAt },
          'send-worker: send failed; retry scheduled (sequência continua ativa)',
        );
        await this.patchSendRun(run.id, {
          status: 'running',
          current_position: position,
          next_send_at: retryAt,
          fail_reason: 'send_failed',
        });
        log.info(
          { runId: run.id, leadId: run.lead_id, position, attempt },
          '[CAMPAIGN] sequência segue ativa — retry da mensagem agendado',
        );
      }
      return;
    }

    // Envio confirmado: zera o contador de tentativas deste run.
    this.retryCounts.delete(run.id);

    // Contexto da campanha no histórico do agente (assistant turn real).
    const recordedText = sentText || `[${next.kind}]`;
    await this.recordCampaignTurn(run.lead_id, sendPhone, recordedText, await this.getConnectionDisplayName(run.connection_id, sendInstance));

    const delayMs = (next.delay_seconds ?? 0) * 1000;
    const newPosition = position + 1;
    const nextAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
    const done = newPosition >= msgs.length;
    await this.patchSendRun(run.id, {
      status: done ? 'done' : 'running',
      current_position: newPosition,
      next_send_at: done ? null : nextAt,
      last_sent_at: new Date().toISOString(),
    });
    if (done) {
      await this.updateLeadStatus(run.lead_id, 'enviado');
      await this.bumpCampaign(run.campaign_id, 'success_count');
      log.info(
        { runId: run.id, leadId: run.lead_id },
        '[CAMPAIGN] sequência concluída — lead liberado para resposta da IA',
      );
    }
  }

/**
   * Lê a configuração do agente (presentation/remarketing) de agent_settings.
   * Retorna valores default quando vazio ou indisponível.
   */
  private async getAgentSettings(): Promise<Record<string, unknown>> {
    const r = await fetch(
      `${this.url}/rest/v1/agent_settings?select=key,value`,
      { headers: this.headers() },
    );
    if (!r.ok) return {};
    const rows = (await r.json()) as Array<{ key: string; value: unknown }>;
    const map: Record<string, unknown> = {};
    for (const row of rows) map[row.key] = row.value;
    return map;
  }

  /**
   * Remarketing automático: leads no estado "enviado" (campanha concluída,
   * sem resposta do lead) que estão há mais de `remarket_days` dias recebem
   * novamente a `remarket_message` e passam a "remarketing". Reenvia apenas
   * uma vez: o campo remarket_at guarda quando o reenvio foi feito.
   */
  private async processRemarketing(): Promise<void> {
    const log = getLogger();
    const settings = await this.getAgentSettings();
    const active = settings.remarket_active === true;
    const days = Number(settings.remarket_days) || 1;
    const message =
      (settings.remarket_message as string) || 'E aí, tudo certo? Te chamei ontem sobre uma oportunidade. Quer que eu detalhe?';

    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    // Leads "enviado" sem resposta, cujo last_message_sent passou do cutoff e
    // que ainda não receberam o reenvio de remarketing (remarket_at nulo).
    const r = await fetch(
      `${this.url}/rest/v1/leads?select=id,phone,name,city,website,category,niche,rating,reviews,address,state&status=eq.enviado&last_message_sent=lte.${encodeURIComponent(cutoff)}&remarket_at=is.null`,
      { headers: this.headers() },
    );
    if (!r.ok) return;
    const leads = (await r.json()) as Array<LeadRow & { remarket_at?: string | null }>;
    if (leads.length === 0) return;
    if (!active) {
      log.info({ candidates: leads.length }, 'send-worker: remarketing disabled, skipping');
      return;
    }

    for (const lead of leads) {
      if (!lead.phone) continue;
      const sendPhone = normalizeBrazilianPhone(lead.phone);
      if (!sendPhone) {
        log.warn({ leadId: lead.id, phone: lead.phone }, 'send-worker: remarketing numero invalido, pulando');
        continue;
      }
      const body = renderTemplate(message, lead);
      const agentName = await loadAgentName();
      const finalText = formatAgentSignature(body, agentName);
      const ok = (await sendText({ to: sendPhone, text: finalText })).ok;
      if (!ok) {
        log.warn({ leadId: lead.id, phone: sendPhone }, 'send-worker: remarketing send failed');
        continue;
      }
      await this.recordCampaignTurn(lead.id, sendPhone, body);
      await fetch(`${this.url}/rest/v1/leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        headers: this.headers(true),
        body: JSON.stringify({
          status: 'remarketing',
          remarket_at: new Date().toISOString(),
          last_message_sent: new Date().toISOString(),
        }),
      });
      await fetch(`${this.url}/rest/v1/lead_status_history`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ lead_id: lead.id, status: 'remarketing', notes: null }),
      });
      log.info({ leadId: lead.id }, 'send-worker: remarketing sent');
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const log = getLogger();
    try {
      // Scheduler persistente: campanhas agendadas cuja hora chegou entram no
      // ar (agendada -> em_progresso). Corre a cada tick e também na subida.
      const activated = await processDueScheduledCampaigns();
      if (activated > 0) {
        log.info({ activated }, 'send-worker: campanha(s) agendada(s) iniciada(s) pelo scheduler');
      }
      const camps = await this.getActiveCampaigns();
      const now = Date.now();
      for (const camp of camps) {
        const runs = await this.getCampaignRuns(camp.id);
        // Nenhum run pendente/ativo => a campanha realmente terminou.
        if (runs.length === 0) {
          await this.finalizeCampaign(camp.id);
          log.info({ campaignId: camp.id }, 'send-worker: campaign finalized / no active runs');
          continue;
        }
        // Conexões disponíveis da campanha. Se a campanha usa connection_ids,
        // e TODAS caíram, aguarda sem pausar a campanha (preserva a fila).
        const available = await this.getAvailableCampaignConnections(camp.id);
        const campaignHasConnections = await this.campaignHasConnections(camp.id);
        if (campaignHasConnections && available.length === 0) {
          // Todas as conexões caíram: sinaliza waiting_connection para a UI
          // (sem travar o loop) e preserva a fila. Status nunca é 'failed'.
          if (camp.status !== 'waiting_connection') {
            await this.patchCampaignStatus(camp.id, 'waiting_connection');
            log.warn({ campaignId: camp.id }, 'send-worker: todas as conexoes da campanha cairam — campanha em waiting_connection (fila preservada)');
          }
          continue;
        }
        // Conexão(ões) de volta: retoma automaticamente uma campanha pausada
        // por falta de conexão (waiting_connection -> em_progresso).
        if (camp.status === 'waiting_connection') {
          await this.patchCampaignStatus(camp.id, 'em_progresso');
          log.info({ campaignId: camp.id }, 'send-worker: conexao(ões) disponíveis novamente — campanha retomada (em_progresso)');
        }
        // EXECUÇÃO SEQUENCIAL POR LEAD (Regra A): a campanha dispara UM lead
        // por vez, na posição persistida. O lead ativo é o primeiro
        // run 'running' (em andamento); sem nenhum, o primeiro 'pending'
        // (mais antigo) inicia a própria sequência. Os demais leads aguardam:
        //   L1 M1 -> (delay L1 M1) L1 M2 -> ... -> L1 Mn -> L2 M1 -> ...
        const active =
          runs.find((r) => r.status === 'running') ??
          runs.find((r) => r.status === 'pending');
        if (!active) continue;
        // Intervalo entre mensagens do MESMO lead: enquanto next_send_at não
        // vence, o lead ativo aguarda e nenhum outro lead começa.
        const due =
          !active.next_send_at ||
          new Date(active.next_send_at).getTime() <= now;
        if (!due) continue;
        if (this.processingRuns.has(active.id)) continue;
        this.processingRuns.add(active.id);
        try {
          if (active.status === 'pending') {
            // A atribuição acontece somente quando a sequência começa. Assim,
            // alterar a seleção também corrige runs antigos sem trocar a
            // conexão de um lead que já está running.
            if (campaignHasConnections) await this.reassignRunConnection(active, available);
            // Início do disparo do lead: marca 'running' imediatamente para
            // fechar a janela do portão da IA (só o lead em disparo fica
            // bloqueado; 'pending' na fila não bloqueia).
            await this.patchSendRun(active.id, { status: 'running' });
          }
          await this.processRun(active);
        } catch (e) {
          log.error({ runId: active.id, err: e instanceof Error ? e.message : e }, 'send-worker: run crashed');
          await this.patchSendRun(active.id, { status: 'failed', fail_reason: 'crashed' });
        } finally {
          this.processingRuns.delete(active.id);
        }
      }
      await this.processRemarketing();
    } finally {
      this.busy = false;
    }
  }

  private async validateRemoteVideoSize(url: string, kind: string): Promise<string | null> {
    if (kind !== 'video') return null;
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) return null;
      const contentLength = Number(response.headers.get('content-length'));
      if (!Number.isFinite(contentLength) || contentLength <= 0) return null;
      return validateVideoSize(contentLength, 'video/*');
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const log = getLogger();
    log.info({ tickMs: TICK_MS }, 'send-worker: started');
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Check imediato na subida (scheduler persistente sobrevive a restarts).
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }
}

function guessMimetype(url: string, kind: string): string | undefined {
  const m = url.toLowerCase().match(/\.(\w+)(\?|$)/);
  const ext = m ? m[1] : '';
  if (kind === 'audio') return 'audio/mpeg';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'image') return `${ext === 'png' ? 'image/png' : 'image/jpeg'}`;
  if (kind === 'document') {
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return map[ext] ?? 'application/octet-stream';
  }
  return undefined;
}

function basename(url: string): string {
  try {
    return url.split('/').pop()?.split('?')[0] ?? 'arquivo';
  } catch {
    return 'arquivo';
  }
}
