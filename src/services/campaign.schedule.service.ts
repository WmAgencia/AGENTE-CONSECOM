/**
 * Agendamento de campanhas — fonte de verdade do "quando" cada campanha entra
 * no ar, sem tocar no motor de disparo (`send.worker.ts`).
 *
 * Ponto central: a coluna `campaigns.scheduled_at` + status `agendada`
 * (migração v16). O worker continua só vendo `em_progresso`; este serviço é
 * quem faz a transição `agendada -> em_progresso` quando `scheduled_at`
 * venceu (no tick e na subida do worker — scheduler persistente, sobrevive a
 * restarts).
 *
 * Regra de conflito (sem hardcode): o intervalo entre campanhas é LIDO da
 * configuração central (`agent_settings.campaign_schedule.interval_min`),
 * mesma infra da agenda. O início de uma nova campanha é válido apenas se:
 *   - não sobrepõe a janela de nenhuma outra campanha ativa/agendada, e
 *   - começa depois de `fim da anterior + interval_min`.
 * A duração estimada por campanha é calculada (leads x sequência), não
 * chutada: (soma dos delay_seconds + nº mensagens × avg_seconds_per_msg) ×
 * nº de leads, com piso `min_duration_min`.
 *
 * Status que ocupam tempo: `agendada`, `em_progresso`, `pausada`. `pronta`,
 * `finalizada` e `cancelada` não bloqueiam.
 */
import { getSupabaseProspeccaoConfig, hasSupabaseProspeccao } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { wallDateToMs, msToWallDate } from './agenda.service.js';

// ---------------------------------------------------------------------------
// Constantes e tipos
// ---------------------------------------------------------------------------

export interface CampaignScheduleConfig {
  /** intervalo (min) entre o fim de uma campanha e o início da próxima */
  interval_min: number;
  /** tempo médio (s) por mensagem enviada a cada lead (duração estimada) */
  avg_seconds_per_msg: number;
  /** piso da duração estimada (min) */
  min_duration_min: number;
}

export interface CampaignTimeWindow {
  campaignId: string;
  name: string;
  status: string;
  startMs: number;
  endMs: number;
  durationMin: number;
  scheduledAt: string | null | undefined;
}

export interface ScheduleConflict {
  campaignId: string;
  name: string;
  status: string;
  startIso: string;
  endIso: string;
}

export type ValidateReason = 'conflito' | 'fora_do_horario' | 'invalid_args' | 'io_error';

export interface ValidateScheduleResult {
  ok: boolean;
  reason?: ValidateReason;
  message?: string;
  conflicts?: ScheduleConflict[];
  nextAvailableStart?: string;
  durationMin?: number;
  startMs?: number;
}

export interface CalendarItem {
  campaignId: string;
  name: string;
  status: string;
  startIso: string;
  endIso: string;
  durationMin: number;
  scheduledAt: string | null | undefined;
  leadCount: number;
}

const DEFAULT_CONFIG: CampaignScheduleConfig = {
  interval_min: 20,
  avg_seconds_per_msg: 6,
  min_duration_min: 30,
};

const KEY_CONFIG = 'campaign_schedule';

const WEEK_MS = 7 * 86_400_000;

interface CampaignRow {
  id: string;
  name: string | null;
  status: string;
  started_at: string | null;
  scheduled_at: string | null;
  created_at: string | null;
  lead_count: number | null;
  connection_ids: string[] | null;
  whatsapp_instance: string | null;
}

interface QueueRow {
  delay_seconds: number | null;
}

// ---------------------------------------------------------------------------
// Acesso a agent_settings (JSON) via REST
// ---------------------------------------------------------------------------

function supabase() {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

function headers(json = false): Record<string, string> {
  const cfg = getSupabaseProspeccaoConfig();
  return json
    ? { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}`, 'Content-Type': 'application/json' }
    : { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
}

async function fetchRow(key: string): Promise<{ ok: boolean; value: unknown | null }> {
  const s = supabase();
  if (!s) return { ok: false, value: null };
  try {
    const res = await fetch(
      `${s.url}/rest/v1/agent_settings?select=value&key=eq.${encodeURIComponent(key)}&limit=1`,
      { headers: headers() },
    );
    if (!res.ok) return { ok: false, value: null };
    const rows = (await res.json()) as Array<{ value: unknown }>;
    if (rows.length === 0) return { ok: true, value: null };
    const raw = rows[0].value;
    if (typeof raw !== 'string') return { ok: true, value: raw ?? null };
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: true, value: raw };
    }
  } catch {
    return { ok: false, value: null };
  }
}

async function getRow(key: string): Promise<unknown | null> {
  const res = await fetchRow(key);
  return res.ok ? res.value : null;
}

async function upsertRow(key: string, value: unknown): Promise<boolean> {
  const s = supabase();
  if (!s) return false;
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const exists = await getRow(key);
    if (exists !== null) {
      const res = await fetch(
        `${s.url}/rest/v1/agent_settings?key=eq.${encodeURIComponent(key)}`,
        { method: 'PATCH', headers: headers(true), body: JSON.stringify({ value: json }) },
      );
      return res.ok;
    }
    const res = await fetch(`${s.url}/rest/v1/agent_settings`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ key, value: json }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Configuração central (intervalo entre campanhas — NÃO hardcoded)
// ---------------------------------------------------------------------------

export async function loadScheduleConfig(): Promise<CampaignScheduleConfig> {
  const raw = await getRow(KEY_CONFIG);
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<CampaignScheduleConfig>;
    return {
      interval_min: positiveInt(r.interval_min, DEFAULT_CONFIG.interval_min),
      avg_seconds_per_msg: positiveInt(r.avg_seconds_per_msg, DEFAULT_CONFIG.avg_seconds_per_msg),
      min_duration_min: positiveInt(r.min_duration_min, DEFAULT_CONFIG.min_duration_min),
    };
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveScheduleConfig(patch: Partial<CampaignScheduleConfig>): Promise<CampaignScheduleConfig | null> {
  const current = await loadScheduleConfig();
  const next: CampaignScheduleConfig = {
    interval_min: positiveInt(patch.interval_min, current.interval_min),
    avg_seconds_per_msg: positiveInt(patch.avg_seconds_per_msg, current.avg_seconds_per_msg),
    min_duration_min: positiveInt(patch.min_duration_min, current.min_duration_min),
  };
  if (!(await upsertRow(KEY_CONFIG, next))) return null;
  return next;
}

// ---------------------------------------------------------------------------
// Dados das campanhas (janelas ocupadas + duração estimada)
// ---------------------------------------------------------------------------

async function countSendRuns(campaignId: string): Promise<number> {
  const s = supabase();
  if (!s) return 0;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/send_runs?select=id&campaign_id=eq.${encodeURIComponent(campaignId)}`,
      { headers: { ...headers(), Prefer: 'count=exact' } },
    );
    if (res.ok) {
      const count = res.headers.get('content-range')?.split('/')[1];
      const n = Number(count);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // mantém 0 -> usa o agregado da campanha
  }
  return 0;
}

async function fetchCampaign(campaignId: string): Promise<CampaignRow | null> {
  const s = supabase();
  if (!s) return null;
  const res = await fetch(
    `${s.url}/rest/v1/campaigns?select=id,name,status,started_at,scheduled_at,created_at,lead_count,connection_ids,whatsapp_instance&id=eq.${encodeURIComponent(campaignId)}`,
    { headers: headers() },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CampaignRow[];
  return rows[0] ?? null;
}

async function fetchMessagesDelays(campaignId: string): Promise<QueueRow[]> {
  const s = supabase();
  if (!s) return [];
  const res = await fetch(
    `${s.url}/rest/v1/queue_messages?select=delay_seconds&campaign_id=eq.${encodeURIComponent(campaignId)}`,
    { headers: headers() },
  );
  if (!res.ok) return [];
  return (await res.json()) as QueueRow[];
}

/**
 * Duração estimada de uma campanha (min): (soma delay_seconds + nº msgs ×
 * avg_seconds_per_msg) × nº leads, com piso min_duration_min. É uma ESTIMATIVA
 * de reserva de agenda — o fim real é quando o último run conclui.
 *
 * Fonte única de duração: os send_runs são a fonte de verdade do nº de leads
 * que realmente serão disparados (o `campaigns.lead_count` é um agregado que
 * pode ficar defasado). Usamos a contagem real de send_runs quando existir;
 * fallback para lead_count apenas se a campanha ainda não tem fila montada.
 */
export async function estimateDurationMinutes(campaignId: string): Promise<number> {
  const config = await loadScheduleConfig();
  const camp = await fetchCampaign(campaignId);
  const msgs = await fetchMessagesDelays(campaignId);

  let leadCount = await countSendRuns(campaignId);
  if (leadCount === 0) {
    // Sem fila montada ainda: usa o agregado de leads da campanha.
    leadCount = camp?.lead_count && camp.lead_count > 0 ? camp.lead_count : 0;
  }
  leadCount = Math.max(1, leadCount);

  const totalDelaySec = msgs.reduce((acc, m) => acc + Math.max(0, Number(m.delay_seconds) || 0), 0);
  const perLeadSec = totalDelaySec + msgs.length * Math.max(1, config.avg_seconds_per_msg);
  const durationSec = perLeadSec * leadCount;
  const durationMin = Math.max(config.min_duration_min, Math.ceil(durationSec / 60));
  return durationMin;
}

async function fetchActiveCampaigns(): Promise<CampaignRow[]> {
  const s = supabase();
  if (!s) return [];
  const res = await fetch(
    `${s.url}/rest/v1/campaigns?select=id,name,status,started_at,scheduled_at,created_at,lead_count,connection_ids,whatsapp_instance&status=in.("agendada","em_progresso","pausada")`,
    { headers: headers() },
  );
  if (!res.ok) return [];
  return (await res.json()) as CampaignRow[];
}

function windowStartMs(c: CampaignRow): number {
  if (c.status === 'agendada') return Date.parse(c.scheduled_at ?? '');
  return Date.parse(c.started_at ?? c.scheduled_at ?? c.created_at ?? '');
}

/** Janelas ocupadas por campanhas ativas/agendadas (com duração estimada). */
export async function listTimeWindows(): Promise<CampaignTimeWindow[]> {
  const camps = await fetchActiveCampaigns();
  const windows: CampaignTimeWindow[] = [];
  for (const c of camps) {
    const startMs = windowStartMs(c);
    if (Number.isNaN(startMs)) continue;
    const durationMin = await estimateDurationMinutes(c.id);
    windows.push({
      campaignId: c.id,
      name: c.name ?? 'Campanha',
      status: c.status,
      startMs,
      endMs: startMs + durationMin * 60_000,
      durationMin,
      scheduledAt: c.scheduled_at,
    });
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Validação de conflito (regra dinâmica: fim da anterior + interval_min)
// ---------------------------------------------------------------------------

function toConflict(w: CampaignTimeWindow): ScheduleConflict {
  return {
    campaignId: w.campaignId,
    name: w.name,
    status: w.status,
    startIso: new Date(w.startMs).toISOString(),
    endIso: new Date(w.endMs).toISOString(),
  };
}

interface ConflictInput {
  startMs: number;
  durationMin: number;
  excludeCampaignId?: string;
  config: CampaignScheduleConfig;
  windows: CampaignTimeWindow[];
}

/** Janelas que entram em conflito com o horário proposto. Pura (testável). */
export function findConflicts(input: ConflictInput): CampaignTimeWindow[] {
  const { startMs, durationMin, excludeCampaignId, config, windows } = input;
  const gapMs = config.interval_min * 60_000;
  const durMs = durationMin * 60_000;
  return windows.filter(
    (w) =>
      w.campaignId !== excludeCampaignId &&
      startMs < w.endMs + gapMs &&
      startMs + durMs > w.startMs,
  );
}

export interface NextStartInput {
  afterMs: number;
  durationMin: number;
  excludeCampaignId?: string;
  config: CampaignScheduleConfig;
  windows: CampaignTimeWindow[];
}

/**
 * Próximo início permitido após `afterMs`: caminha para frente sobre as janelas
 * ocupadas aplicando a regra dinâmica (fim da anterior + interval_min). Pura.
 */
export function computeNextAvailableStart(input: NextStartInput): number {
  const { afterMs, durationMin, excludeCampaignId, config, windows } = input;
  let s = Math.max(afterMs, 0);
  let guard = 0;
  let conflict = findConflicts({ startMs: s, durationMin, excludeCampaignId, config, windows })[0];
  while (conflict && guard < 60) {
    s = conflict.endMs + config.interval_min * 60_000;
    conflict = findConflicts({ startMs: s, durationMin, excludeCampaignId, config, windows })[0];
    guard += 1;
  }
  return s;
}

/**
 * Próximo início permitido após `afterMs` (com carregamento de config/janelas).
 * I/O + chamada à lógica pura.
 */
export async function nextAvailableStart(opts: {
  afterMs: number;
  durationMin?: number;
  excludeCampaignId?: string;
  config?: CampaignScheduleConfig;
  windows?: CampaignTimeWindow[];
}): Promise<number> {
  const config = opts.config ?? (await loadScheduleConfig());
  const windows = opts.windows ?? (await listTimeWindows());
  const durationMin = opts.durationMin ?? config.min_duration_min;
  return computeNextAvailableStart({
    afterMs: Math.max(opts.afterMs, Date.now()),
    durationMin,
    excludeCampaignId: opts.excludeCampaignId,
    config,
    windows,
  });
}

export interface ValidateScheduleInput {
  campaignId: string;
  startIso: string;
}

/** Valida se uma campanha pode agendar o início em `startIso`. */
export async function validateSchedule(input: ValidateScheduleInput): Promise<ValidateScheduleResult> {
  if (!hasSupabaseProspeccao()) {
    return { ok: false, reason: 'io_error', message: 'Supabase não configurado.' };
  }
  if (!input.campaignId || typeof input.campaignId !== 'string') {
    return { ok: false, reason: 'invalid_args', message: 'Campanha obrigatória.' };
  }
  const startMs = Date.parse(input.startIso);
  if (Number.isNaN(startMs)) {
    return { ok: false, reason: 'invalid_args', message: 'Data/hora de início inválida.' };
  }
  if (startMs <= Date.now()) {
    return { ok: false, reason: 'fora_do_horario', message: 'O início precisa ser no futuro.' };
  }

  const config = await loadScheduleConfig();
  const windows = await listTimeWindows();
  const durationMin = await estimateDurationMinutes(input.campaignId);

  const camp = await fetchCampaign(input.campaignId);
  if (!camp) {
    return { ok: false, reason: 'invalid_args', message: 'Campanha não encontrada.' };
  }
  const hasConnection = (camp.connection_ids ?? []).length > 0 || !!camp.whatsapp_instance;
  if (!hasConnection) {
    return {
      ok: false,
      reason: 'fora_do_horario',
      message: 'Selecione ao menos uma conexão do WhatsApp na campanha antes de agendar — sem conexão o envio não acontece.',
    };
  }

  const conflicts = findConflicts({ startMs, durationMin, excludeCampaignId: input.campaignId, config, windows });
  if (conflicts.length > 0) {
    const nextStart = await nextAvailableStart({
      afterMs: startMs,
      durationMin,
      excludeCampaignId: input.campaignId,
      config,
      windows,
    });
    return {
      ok: false,
      reason: 'conflito',
      message: `Conflito com ${conflicts.length} campanha(s) já em andamento ou agendada(s). O próximo horário livre começa às ${new Date(nextStart).toISOString()}.`,
      conflicts: conflicts.map(toConflict),
      nextAvailableStart: new Date(nextStart).toISOString(),
      durationMin,
      startMs,
    };
  }

  return { ok: true, message: 'Horário livre.', durationMin, startMs };
}

// ---------------------------------------------------------------------------
// Agendar / cancelar
// ---------------------------------------------------------------------------

export interface ScheduleResult {
  ok: boolean;
  reason?: ValidateReason;
  message?: string;
  conflicts?: ScheduleConflict[];
  nextAvailableStart?: string;
  scheduledAt?: string;
  status?: string;
}

/** Agenda a campanha (status 'agendada' + scheduled_at) após validar conflito. */
export async function scheduleCampaign(input: ValidateScheduleInput): Promise<ScheduleResult> {
  const check = await validateSchedule(input);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      message: check.message,
      conflicts: check.conflicts,
      nextAvailableStart: check.nextAvailableStart,
    };
  }
  const s = supabase();
  if (!s) return { ok: false, reason: 'io_error', message: 'Supabase não configurado.' };
  const res = await fetch(`${s.url}/rest/v1/campaigns?id=eq.${encodeURIComponent(input.campaignId)}`, {
    method: 'PATCH',
    headers: headers(true),
    body: JSON.stringify({ status: 'agendada', scheduled_at: input.startIso, started_at: null }),
  });
  if (!res.ok) {
    getLogger().warn(
      { campaignId: input.campaignId, status: res.status, errBody: res.status === 400 ? await safeText(res) : undefined },
      'campaign-schedule: PATCH agendada falhou (verifique a migração v16 aplicada)',
    );
    return { ok: false, reason: 'io_error', message: 'Não foi possível agendar a campanha (banco rejeitou o status — confirme se a migração v16 foi aplicada).' };
  }
  return {
    ok: true,
    message: 'Campanha agendada.',
    scheduledAt: input.startIso,
    status: 'agendada',
  };
}

/** Cancela o agendamento (status 'cancelada'). Campanhas 'pronta' não são afetadas. */
export async function cancelScheduledCampaign(campaignId: string): Promise<{ ok: boolean; message?: string }> {
  const s = supabase();
  if (!s) return { ok: false, message: 'Supabase não configurado.' };
  const camp = await fetchCampaign(campaignId);
  if (!camp) return { ok: false, message: 'Campanha não encontrada.' };
  if (camp.status !== 'agendada') {
    return { ok: false, message: 'Esta campanha não está agendada.' };
  }
  const res = await fetch(`${s.url}/rest/v1/campaigns?id=eq.${encodeURIComponent(campaignId)}`, {
    method: 'PATCH',
    headers: headers(true),
    body: JSON.stringify({ status: 'cancelada', scheduled_at: null }),
  });
  if (!res.ok) return { ok: false, message: 'Falha ao cancelar o agendamento.' };
  return { ok: true, message: 'Agendamento cancelado.' };
}

// ---------------------------------------------------------------------------
// Scheduler persistente (worker) + listagem/calendário
// ---------------------------------------------------------------------------

/**
 * Transiciona campanhas 'agendada' cujo scheduled_at já venceu para
 * 'em_progresso' (com started_at). Chamado no tick e na subida do worker —
 * o scheduler sobrevive a restarts. Retorna quantas foram ativadas.
 */
export async function processDueScheduledCampaigns(): Promise<number> {
  const s = supabase();
  if (!s) return 0;
  const now = new Date().toISOString();
  try {
    const res = await fetch(
      `${s.url}/rest/v1/campaigns?select=id&status=eq.agendada&scheduled_at=lte.${encodeURIComponent(now)}`,
      { headers: headers() },
    );
    if (!res.ok) return 0;
    const rows = (await res.json()) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    for (const row of rows) {
      await fetch(`${s.url}/rest/v1/campaigns?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: headers(true),
        body: JSON.stringify({ status: 'em_progresso', started_at: now }),
      });
    }
    return rows.length;
  } catch (err) {
    getLogger().warn(
      { errMessage: err instanceof Error ? err.message : 'unknown' },
      'campaign-schedule: processDueScheduled falhou',
    );
    return 0;
  }
}

export interface ScheduledCampaign {
  id: string;
  name: string;
  status: string;
  scheduled_at: string | null;
  lead_count: number | null;
}

/** Campanhas atualmente agendadas (status 'agendada'), por data. */
export async function listScheduledCampaigns(): Promise<ScheduledCampaign[]> {
  const s = supabase();
  if (!s) return [];
  const res = await fetch(
    `${s.url}/rest/v1/campaigns?select=id,name,status,scheduled_at,lead_count&status=eq.agendada&order=scheduled_at.asc`,
    { headers: headers() },
  );
  if (!res.ok) return [];
  return (await res.json()) as ScheduledCampaign[];
}

/** Ocupação das campanhas ativas/agendadas que tocam o intervalo pedido. */
export async function getCampaignCalendar(startDate: string, endDate: string): Promise<CalendarItem[]> {
  const startMs = wallDateToMs(startDate);
  const endMs = wallDateToMs(endDate) + 86_400_000;
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return [];
  const camps = await fetchActiveCampaigns();
  const items: CalendarItem[] = [];
  for (const c of camps) {
    const start = windowStartMs(c);
    if (Number.isNaN(start)) continue;
    const durationMin = await estimateDurationMinutes(c.id);
    const end = start + durationMin * 60_000;
    // janela que toca o intervalo consultado (span de 7 dias p/ lateral)
    if (end + WEEK_MS < startMs || start > endMs) continue;
    let leadCount = c.lead_count ?? 0;
    if (leadCount === 0) leadCount = await countSendRuns(c.id);
    items.push({
      campaignId: c.id,
      name: c.name ?? 'Campanha',
      status: c.status,
      startIso: new Date(start).toISOString(),
      endIso: new Date(end).toISOString(),
      durationMin,
      scheduledAt: c.scheduled_at,
      leadCount,
    });
  }
  return items.sort((a, b) => a.startIso.localeCompare(b.startIso));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positiveInt(v: number | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/** Re-export usado pelos testes/rotas. */
export function scheduleDayLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const day = msToWallDate(ms);
  const [y, m, d] = day.split('-');
  const labels = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${Number(d)} ${labels[Number(m) - 1]} ${y}`;
}