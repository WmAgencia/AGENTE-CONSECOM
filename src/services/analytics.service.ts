/**
 * Analytics service for the Consecom prospection funnel.
 *
 * Computes funnel metrics (response, conversation, meeting, show, completion,
 * close, overall conversion) broken down by strategy, segment and service.
 *
 * Data comes from the Supabase REST API (service role). Aggregation is done in
 * memory here because Supabase REST does not expose GROUP BY to the client and
 * the dataset is small enough to compute deterministically.
 *
 * Every metric is a pure function of the rows — no randomness, no model calls —
 * so the Intelligence dashboard can be recomputed on demand.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

export interface LeadAnalyticsRow {
  id: string;
  status: string | null;
  strategy_id: string | null;
  campaign_id: string | null;
  niche: string | null;
  category: string | null;
  service_interest: string | null;
  score: number | null;
  interest_level: string | null;
  problem_identified: boolean | null;
  meeting_at: string | null;
  meeting_outcome: string | null;
  sale_status: string | null;
  loss_reason: string | null;
  no_interest_until: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface StrategyRow {
  id: string;
  code: string;
  name: string;
  status: string;
  approval_status: string;
  segment: string | null;
  service: string | null;
}

export interface FunnelMetrics {
  enviados: number;
  conversando: number;
  remarketing: number;
  sem_interesse: number;
  reunioes: number;
  canceladas: number;
  concluidos: number;
  vendas: number;
  responseRate: number;
  conversationRate: number;
  meetingRate: number;
  showRate: number;
  completionRate: number;
  closeRate: number;
  overallConversion: number;
}

export interface StrategyBreakdown extends FunnelMetrics {
  strategy_id: string;
  code: string;
  name: string;
  segment: string | null;
  service: string | null;
  sample: number;
}

export interface SegmentBreakdown {
  segment: string;
  sample: number;
  reunioes: number;
  vendas: number;
  meetingRate: number;
  closeRate: number;
}

export interface ServiceBreakdown {
  service: string;
  sample: number;
  reunioes: number;
  vendas: number;
  meetingRate: number;
  closeRate: number;
}

const RATE = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : 0;

function pct(n: number): number {
  return Math.round(n * 10) / 10;
}

function countByStatus(rows: LeadAnalyticsRow[], statuses: string[]): number {
  return rows.filter((r) => statuses.includes(r.status ?? '')).length;
}

function responseDenominator(rows: LeadAnalyticsRow[]): number {
  // Enviados = leads que saíram da fila (qualquer status pós "enviado").
  return rows.length;
}

export function computeFunnel(rows: LeadAnalyticsRow[]): FunnelMetrics {
  const conversando = countByStatus(rows, ['conversando']);
  const reunioesAgendadas = countByStatus(rows, ['reuniao_marcada']);
  const canceladas = countByStatus(rows, ['reuniao_cancelada']);
  const concluidos = countByStatus(rows, ['fechado', 'nao_fechado']);
  const semInteresse = countByStatus(rows, ['sem_interesse']);
  const remarketing = countByStatus(rows, ['remarketing']);
  const enviados = Math.max(
    0,
    rows.length - countByStatus(rows, ['novo', 'na_fila']),
  );

  const respondeu =
    conversando + reunioesAgendadas + canceladas + concluidos + semInteresse + remarketing;
  const conversasRelevantes = conversando + reunioesAgendadas + canceladas + concluidos;
  // Vendas = qualquer lead com sale_status venda, mesmo sem status fechado
  // (a venda pode ser registrada direto pelo humano).
  const vendas = rows.filter((r) => r.sale_status === 'venda').length;
  // Leads que chegaram à reunião: agendados hoje + concluídos (fechado/nao_fechado
  // só existem após a reunião acontecer).
  const reunioes = reunioesAgendadas + concluidos;
  const showDenominator = reunioesAgendadas + canceladas;

  return {
    enviados,
    conversando,
    remarketing,
    sem_interesse: semInteresse,
    reunioes,
    canceladas,
    concluidos,
    vendas,
    responseRate: RATE(respondeu, responseDenominator(rows)),
    conversationRate: RATE(conversasRelevantes, respondeu),
    meetingRate: RATE(reunioes, conversasRelevantes),
    showRate: RATE(reunioes, showDenominator),
    completionRate: RATE(concluidos, reunioes),
    closeRate: RATE(vendas, concluidos),
    overallConversion: RATE(vendas, responseDenominator(rows)),
  };
}

function withDenom(base: FunnelMetrics, _sample: number): FunnelMetrics {
  return {
    ...base,
    responseRate: pct(base.responseRate),
    conversationRate: pct(base.conversationRate),
    meetingRate: pct(base.meetingRate),
    showRate: pct(base.showRate),
    completionRate: pct(base.completionRate),
    closeRate: pct(base.closeRate),
    overallConversion: pct(base.overallConversion),
  };
}

export function breakdownByStrategy(
  leads: LeadAnalyticsRow[],
  strategies: StrategyRow[],
): StrategyBreakdown[] {
  const byId = new Map<string, LeadAnalyticsRow[]>();
  for (const l of leads) {
    const key = l.strategy_id ?? 'none';
    const arr = byId.get(key) ?? [];
    arr.push(l);
    byId.set(key, arr);
  }
  const out: StrategyBreakdown[] = [];
  for (const st of strategies) {
    const group = byId.get(st.id) ?? [];
    out.push({
      strategy_id: st.id,
      code: st.code,
      name: st.name,
      segment: st.segment,
      service: st.service,
      sample: group.length,
      ...withDenom(computeFunnel(group), group.length),
    });
  }
  // Leva sem estratégia definida (fallback visibility).
  const none = byId.get('none') ?? [];
  if (none.length > 0) {
    out.push({
      strategy_id: 'none',
      code: 'sem_estrategia',
      name: 'Sem estratégia',
      segment: null,
      service: null,
      sample: none.length,
      ...withDenom(computeFunnel(none), none.length),
    });
  }
  return out;
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

export function breakdownBySegment(leads: LeadAnalyticsRow[]): SegmentBreakdown[] {
  return Array.from(groupBy(leads, (l) => l.niche ?? l.category).entries())
    .map(([segment, group]) => {
      const f = computeFunnel(group);
      return {
        segment,
        sample: group.length,
        reunioes: f.reunioes,
        vendas: f.vendas,
        meetingRate: f.meetingRate,
        closeRate: f.closeRate,
      };
    })
    .sort((a, b) => b.sample - a.sample);
}

export function breakdownByService(leads: LeadAnalyticsRow[]): ServiceBreakdown[] {
  return Array.from(groupBy(leads, (l) => l.service_interest).entries())
    .map(([service, group]) => {
      const f = computeFunnel(group);
      return {
        service,
        sample: group.length,
        reunioes: f.reunioes,
        vendas: f.vendas,
        meetingRate: f.meetingRate,
        closeRate: f.closeRate,
      };
    })
    .sort((a, b) => b.sample - a.sample);
}

export interface AnalyticsSnapshot {
  funnel: FunnelMetrics;
  byStrategy: StrategyBreakdown[];
  bySegment: SegmentBreakdown[];
  byService: ServiceBreakdown[];
  sampleSize: number;
  generatedAt: string;
}

/**
 * Fetches the leads + strategies needed to compute a full snapshot.
 * Returns null when Supabase is not configured or fetch fails.
 */
export async function fetchAnalyticsSnapshot(): Promise<AnalyticsSnapshot | null> {
  const log = getLogger();
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  try {
    const hdrs = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
    const [leadsRes, stratRes] = await Promise.all([
      fetch(
        `${cfg.url}/rest/v1/leads?select=id,status,strategy_id,campaign_id,niche,category,service_interest,score,interest_level,problem_identified,meeting_at,meeting_outcome,sale_status,loss_reason,no_interest_until,created_at,updated_at`,
        { headers: hdrs },
      ),
      fetch(`${cfg.url}/rest/v1/strategies?select=*`, { headers: hdrs }),
    ]);
    if (!leadsRes.ok || !stratRes.ok) return null;
    const leads = (await leadsRes.json()) as LeadAnalyticsRow[];
    const strategies = (await stratRes.json()) as StrategyRow[];
    const funnel = computeFunnel(leads);
    return {
      funnel,
      byStrategy: breakdownByStrategy(leads, strategies),
      bySegment: breakdownBySegment(leads),
      byService: breakdownByService(leads),
      sampleSize: leads.length,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log.warn({ errMessage: msg }, 'analytics: snapshot failed');
    return null;
  }
}
