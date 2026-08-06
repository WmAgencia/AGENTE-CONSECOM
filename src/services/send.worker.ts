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
 *   - On completion marks the run `done` and the lead status `mensagem_enviada`.
 *
 * Uses the Supabase REST API with the service role key (bypasses RLS).
 * Does not store secrets; reads them from env via the config module.
 */
import { getSupabaseProspeccaoConfig, getEnv } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { sendText, sendMedia, type MediaKind } from './evolution.service.js';

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

  private async getPendingRuns(): Promise<SendRunRow[]> {
    const r = await fetch(
      `${this.url}/rest/v1/send_runs?status=in.("pending","running")&select=*`,
      { headers: this.headers() },
    );
    if (!r.ok) return [];
    return (await r.json()) as SendRunRow[];
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
      await this.updateLeadStatus(run.lead_id, 'mensagem_enviada');
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
      await this.patchSendRun(run.id, { status: 'failed', current_position: position });
      return;
    }

    log.info({ runId: run.id, position, kind: next.kind, phone }, 'send-worker: sending');
    let ok: boolean;
    if (next.kind === 'text' && next.text) {
      ok = (await sendText({ to: phone, text: applyPlaceholders(next.text, lead) })).ok;
    } else if (next.media_url) {
      const mediaUrl = next.media_url.startsWith('http')
        ? next.media_url
        : `${this.url}/storage/v1/object/public/${next.media_url.replace(/^\/+/, '')}`;
      ok = (
        await sendMedia({
          to: phone,
          kind: next.kind as MediaKind,
          media: mediaUrl,
          caption: next.media_caption
            ? applyPlaceholders(next.media_caption, lead)
            : undefined,
          mimetype: guessMimetype(mediaUrl, next.kind),
          filename: basename(mediaUrl),
        })
      ).ok;
    } else {
      ok = false;
    }

    if (!ok) {
      log.warn({ runId: run.id, position, kind: next.kind }, 'send-worker: send failed');
      await this.patchSendRun(run.id, { status: 'failed', current_position: position });
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
      await this.updateLeadStatus(run.lead_id, 'mensagem_enviada');
      log.info({ runId: run.id, leadId: run.lead_id }, 'send-worker: sequence done');
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const runs = await this.getPendingRuns();
      const now = Date.now();
      for (const run of runs) {
        const due = !run.next_send_at || new Date(run.next_send_at).getTime() <= now;
        if (!due) continue;
        try {
          await this.processRun(run);
        } catch (e) {
          const log = getLogger();
          log.error({ runId: run.id, err: e instanceof Error ? e.message : e }, 'send-worker: run crashed');
          await this.patchSendRun(run.id, { status: 'failed' });
        }
      }
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