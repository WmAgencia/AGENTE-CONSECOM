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
 * Uses the Supabase REST API with the service role key (bypasses RLS).
 * Does not store secrets; reads them from env via the config module.
 */
import { getSupabaseProspeccaoConfig, getEnv } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { sendText, sendMedia, type MediaKind } from './evolution.service.js';
import { classifyBrazilianPhone, normalizeBrazilianPhone } from '../lib/phone.js';
import { loadAgentName, formatAgentSignature } from './supabase.leads.js';
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
  status: string | null;
  strategy_id?: string | null;
}

/** Substitutes dynamic placeholders ({nome_empresa}, {telefone}, ...) in a string. */
function applyPlaceholders(input: string, lead: LeadRow): string {
  const values: Record<string, string> = {
    nome_empresa: lead.name ?? '',
    telefone: lead.phone ?? '',
    cidade: lead.city ?? '',
    estado: lead.state ?? '',
    endereco: lead.address ?? '',
    categoria: lead.category ?? '',
    site: lead.website ?? '',
    nicho: lead.niche ?? '',
    avaliacao: lead.rating != null ? String(lead.rating) : '',
    avaliacoes: lead.reviews != null ? String(lead.reviews) : '',
  };
  return input.replace(/\{(\w+)\}/g, (match, key: string) =>
    values[key] !== undefined ? values[key] : match,
  );
}

export class SendWorker {
  private readonly url: string;
  private readonly key: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private started = false;

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

  private async getActiveCampaigns(): Promise<Array<{ id: string }>> {
    // Campanhas em andamento. O worker finaliza cada uma quando não há mais
    // nenhum run pendente/ativo (execução sequencial por lead).
    const r = await fetch(
      `${this.url}/rest/v1/campaigns?select=id&status=eq.em_progresso`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    return (await r.json()) as Array<{ id: string }>;
  }

  private async getCampaignRuns(campaignId: string): Promise<SendRunRow[]> {
    const r = await fetch(
      `${this.url}/rest/v1/send_runs?select=id,campaign_id,lead_id,status,current_position,next_send_at&campaign_id=eq.${encodeURIComponent(campaignId)}&status=in.("pending","running")&order=created_at.asc`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    return (await r.json()) as SendRunRow[];
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

  private async processRun(run: SendRunRow): Promise<void> {
    const log = getLogger();
    const msgs = await this.getQueueMessages(run.campaign_id);
    if (msgs.length === 0) {
      await this.patchSendRun(run.id, { status: 'done', current_position: 0 });
      return;
    }

    const position = run.current_position;
    const next = msgs[position];
    if (!next) {
      await this.patchSendRun(run.id, { status: 'done', current_position: position });
      await this.updateLeadStatus(run.lead_id, 'enviado');
      log.info({ runId: run.id, leadId: run.lead_id }, 'send-worker: run done');
      return;
    }

    const lead = await this.getLead(run.lead_id);
    if (!lead) {
      log.warn({ runId: run.id, leadId: run.lead_id }, 'send-worker: lead not found, failing');
      await this.patchSendRun(run.id, { status: 'failed', current_position: position });
      return;
    }
    const phone = lead.phone;
    if (!phone) {
      log.warn({ runId: run.id, leadId: run.lead_id }, 'send-worker: no phone, failing');
      await this.patchSendRun(run.id, { status: 'failed', current_position: position, fail_reason: 'sem_telefone' });
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
      await this.patchSendRun(run.id, {
        status: 'failed',
        current_position: position,
        fail_reason: callReason,
      });
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

    log.info({ runId: run.id, position, kind: next.kind, phone: sendPhone }, 'send-worker: sending');
    const agentName = await loadAgentName();
    let ok: boolean;
    if (strategyKind === 'text' && strategyText) {
      ok = (await sendText({ to: sendPhone, text: formatAgentSignature(applyPlaceholders(strategyText, lead), agentName) })).ok;
    } else if (strategyMediaUrl) {
      const mediaUrl = strategyMediaUrl.startsWith('http')
        ? strategyMediaUrl
        : `${this.url}/storage/v1/object/public/${strategyMediaUrl.replace(/^\/+/, '')}`;
      ok = (
        await sendMedia({
          to: sendPhone,
          kind: strategyKind as MediaKind,
          media: mediaUrl,
          caption: strategyCaption
            ? formatAgentSignature(applyPlaceholders(strategyCaption, lead), agentName)
            : undefined,
          mimetype: guessMimetype(mediaUrl, strategyKind),
          filename: basename(mediaUrl),
        })
      ).ok;
    } else {
      ok = false;
    }

    if (!ok) {
      log.warn({ runId: run.id, position, kind: next.kind }, 'send-worker: send failed');
      await this.patchSendRun(run.id, { status: 'failed', current_position: position });
      await this.bumpCampaign(run.campaign_id, 'fail_count');
      return;
    }

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
      log.info({ runId: run.id, leadId: run.lead_id }, 'send-worker: sequence done');
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
      const body = applyPlaceholders(message, lead);
      const agentName = await loadAgentName();
      const finalText = formatAgentSignature(body, agentName);
      const ok = (await sendText({ to: sendPhone, text: finalText })).ok;
      if (!ok) {
        log.warn({ leadId: lead.id, phone: sendPhone }, 'send-worker: remarketing send failed');
        continue;
      }
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
        // EXECUÇÃO SEQUENCIAL POR LEAD: apenas o run mais antigo da campanha
        // avança. Os demais permanecem 'pending' até este concluir a sequência
        // inteira (done/failed). Isso garante o formato:
        //   Lead A: M1 -> espera -> M2 -> espera -> M3 -> (conclui)
        //   Lead B: M1 -> ...
        // e NUNCA M1 para todos, depois M2 para todos, etc.
        const run = runs[0];
        if (run.next_send_at && new Date(run.next_send_at).getTime() > now) continue;
        try {
          await this.processRun(run);
        } catch (e) {
          log.error({ runId: run.id, err: e instanceof Error ? e.message : e }, 'send-worker: run crashed');
          await this.patchSendRun(run.id, { status: 'failed', fail_reason: 'crashed' });
        }
      }
      await this.processRemarketing();
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const log = getLogger();
    log.info({ tickMs: TICK_MS }, 'send-worker: started');
    this.timer = setInterval(() => void this.tick(), TICK_MS);
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
