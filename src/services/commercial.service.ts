/**
 * Inteligência Comercial — cálculos centralizados (Metas + Faturamento).
 *
 * Toda a matemática de PROJEÇÃO e RESULTADOS REAIS vive aqui (funções puras),
 * para não duplicar lógica entre o Dashboard e a Analytics. O frontend consome
 * via /api/commercial/* e reutiliza os mesmos números.
 *
 * Regra de ouro: nenhum número é inventado. Todas as métricas são derivadas de
 * dados reais do Supabase; estados sem denominador suficiente retornam null
 * (o frontend exibe "Sem dados suficientes" em vez de porcentagens enganosas).
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface CommercialGoal {
  id: string;
  user_id: string;
  workspace_id: string | null;
  goal_amount: number;
  period_days: 30 | 60 | 90;
  avg_ticket: number;
  meeting_close_rate: number;
  leads_per_day: number | null;
  created_at: string;
  updated_at: string;
}

export interface GoalInput {
  goal_amount: number;
  period_days: 30 | 60 | 90;
  avg_ticket: number;
  meeting_close_rate: number;
  leads_per_day: number | null;
}

export interface ProjectionResult {
  vendasNecessarias: number;
  reunioesNecessarias: number;
  reunioesPorDia: number;
  leadsNecessarios: number | null;
  leadsPorDia: number | null;
  conversaoLeadReuniaoNecessaria: number | null;
  conversaoLeadVendaNecessaria: number | null;
}

export interface FunnelStage {
  label: string;
  value: number;
}

export interface RealResults {
  faturamento: number;
  vendas: number;
  vendasComValor: number;
  leadsTrabalhados: number;
  conversando: number;
  reunioesMarcadas: number;
  reunioesRealizadas: number;
  conversaoLeadReuniao: number | null;
  conversaoReuniaoVenda: number | null;
  conversaoLeadVenda: number | null;
  funnel: FunnelStage[];
  hoje: {
    faturamento: number;
    vendas: number;
    reunioes: number;
  };
  historico: Array<{ mes: string; faturamento: number }>;
  diasRestantes: number;
  rPorDiaNecessario: number | null;
  metaAtingida: number | null;
  operacao: OperacaoResults;
}

/** Métricas operacionais reais (mensagens, respostas, campanhas, conexões, follow-ups). */
export interface OperacaoResults {
  mensagensEnviadas: number;
  respostasRecebidas: number;
  followUpsPendentes: number;
  campanhasAtivas: number;
  campanhasTotal: number;
  conexoesConectadas: number;
  conexoesTotal: number;
}

export interface CommercialDashboard {
  goal: CommercialGoal | null;
  projection: ProjectionResult | null;
  real: RealResults;
  generatedAt: string;
}

export interface LeadRowCommercial {
  id: string;
  status: string | null;
  sale_value: number | null;
  sale_status: string | null;
  meeting_at: string | null;
  meeting_outcome: string | null;
  closed_at: string | null;
  created_at: string | null;
  last_message_sent: string | null;
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

const ceil = (n: number): number => Math.ceil(n);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (n: number): number => Math.round(n * 10) / 10;

/** Retorna null quando o denominador é zero (não enganar com 0% ou 100%). */
function safeRate(num: number, den: number): number | null {
  if (den <= 0) return null;
  return pct((num / den) * 100);
}

function startOfDay(iso?: string | null): number {
  const d = iso ? new Date(iso) : new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function isSameDay(iso: string | null | undefined, dayMs: number): boolean {
  if (!iso) return false;
  return startOfDay(iso) === dayMs;
}

// ---------------------------------------------------------------------------
// PROJEÇÃO (calculadora)
// ---------------------------------------------------------------------------

export function computeProjection(goal: GoalInput): ProjectionResult {
  const vendasNecessarias = goal.goal_amount > 0 && goal.avg_ticket > 0
    ? ceil(goal.goal_amount / goal.avg_ticket)
    : 0;

  const rate = goal.meeting_close_rate > 0 ? goal.meeting_close_rate / 100 : 0;
  const reunioesNecessarias = vendasNecessarias > 0 && rate > 0
    ? ceil(vendasNecessarias / rate)
    : 0;

  const dias = Math.max(1, goal.period_days);
  const reunioesPorDia = round2(reunioesNecessarias / dias);

  let leadsNecessarios: number | null = null;
  let leadsPorDia: number | null = null;
  let conversaoLeadReuniaoNecessaria: number | null = null;
  let conversaoLeadVendaNecessaria: number | null = null;

  if (goal.leads_per_day && goal.leads_per_day > 0) {
    leadsPorDia = goal.leads_per_day;
    leadsNecessarios = ceil(goal.leads_per_day * dias);
    if (leadsNecessarios > 0) {
      conversaoLeadReuniaoNecessaria = pct((reunioesNecessarias / leadsNecessarios) * 100);
      conversaoLeadVendaNecessaria = pct((vendasNecessarias / leadsNecessarios) * 100);
    }
  }

  return {
    vendasNecessarias,
    reunioesNecessarias,
    reunioesPorDia,
    leadsNecessarios,
    leadsPorDia,
    conversaoLeadReuniaoNecessaria,
    conversaoLeadVendaNecessaria,
  };
}

// ---------------------------------------------------------------------------
// RESULTADOS REAIS
// ---------------------------------------------------------------------------

export function computeRealResults(
  leads: LeadRowCommercial[],
  goal: CommercialGoal | null,
  now = new Date(),
): RealResults {
  const isFechado = (s: string | null | undefined) => s === 'fechado';
  const isNaoFechado = (s: string | null | undefined) => s === 'nao_fechado';
  const isTrabalhado = (s: string | null | undefined) =>
    !!s && s !== 'novo' && s !== 'na_fila';

  const leadsTrabalhados = leads.filter((l) => isTrabalhado(l.status)).length;
  const conversando = leads.filter((l) => l.status === 'conversando').length;
  const reunioesMarcadas = leads.filter((l) => l.status === 'reuniao_marcada').length;

  // Reunião "realizada" = desfecho registrado após o encontro (fechado/
  // nao_fechado) OU marcado explicitamente como realizada no funil.
  const reunioesRealizadas = leads.filter(
    (l) =>
      isFechado(l.status) ||
      isNaoFechado(l.status) ||
      l.meeting_outcome === 'realizada',
  ).length;

  const vendasComValor = leads.filter(
    (l) => isFechado(l.status) && l.sale_value != null && l.sale_value > 0,
  );
  const vendas = leads.filter((l) => isFechado(l.status)).length;
  const faturamento = round2(vendasComValor.reduce((acc, l) => acc + (l.sale_value ?? 0), 0));

  const conversaoLeadReuniao = safeRate(reunioesMarcadas, leadsTrabalhados);
  const conversaoReuniaoVenda = safeRate(vendas, reunioesRealizadas);
  const conversaoLeadVenda = safeRate(vendas, leadsTrabalhados);

  // Hoje
  const hojeMs = startOfDay();
  const vendasHoje = vendasComValor.filter((l) => isSameDay(l.closed_at, hojeMs)).length;
  const faturamentoHoje = round2(
    vendasComValor
      .filter((l) => isSameDay(l.closed_at, hojeMs))
      .reduce((acc, l) => acc + (l.sale_value ?? 0), 0),
  );
  const reunioesHoje = leads.filter(
    (l) => isSameDay(l.meeting_at, hojeMs) && !isFechado(l.status) && !isNaoFechado(l.status),
  ).length;

  // Funil Leads -> Conversas -> Reuniões -> Realizadas -> Fechados
  const funnel: FunnelStage[] = [
    { label: 'Leads trabalhados', value: leadsTrabalhados },
    { label: 'Conversando', value: conversando },
    { label: 'Reuniões marcadas', value: reunioesMarcadas },
    { label: 'Reuniões realizadas', value: reunioesRealizadas },
    { label: 'Fechados', value: vendas },
  ];

  // Histórico (faturamento mensal por data de fechamento)
  const byMes = new Map<string, number>();
  for (const l of vendasComValor) {
    if (!l.closed_at) continue;
    const mes = l.closed_at.slice(0, 7);
    byMes.set(mes, round2((byMes.get(mes) ?? 0) + (l.sale_value ?? 0)));
  }
  const historico = Array.from(byMes.entries())
    .map(([mes, valor]) => ({ mes, faturamento: valor }))
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .slice(-12);

  // Dias restantes do período da meta + R$/dia necessário
  let diasRestantes = 0;
  let metaAtingida: number | null = null;
  let rPorDiaNecessario: number | null = null;

  if (goal) {
    const inicio = goal.created_at ? new Date(goal.created_at).getTime() : now.getTime();
    const fimPeriodo = inicio + goal.period_days * 24 * 60 * 60 * 1000;
    diasRestantes = Math.max(0, Math.ceil((fimPeriodo - now.getTime()) / (24 * 60 * 60 * 1000)));
    const restante = goal.goal_amount - faturamento;
    metaAtingida = goal.goal_amount > 0 ? pct((faturamento / goal.goal_amount) * 100) : null;
    rPorDiaNecessario =
      diasRestantes > 0 ? round2(Math.max(0, restante) / diasRestantes) : null;
  }

  return {
    faturamento,
    vendas,
    vendasComValor: vendasComValor.length,
    leadsTrabalhados,
    conversando,
    reunioesMarcadas,
    reunioesRealizadas,
    conversaoLeadReuniao,
    conversaoReuniaoVenda,
    conversaoLeadVenda,
    funnel,
    hoje: { faturamento: faturamentoHoje, vendas: vendasHoje, reunioes: reunioesHoje },
    historico,
    diasRestantes,
    rPorDiaNecessario,
    metaAtingida,
    operacao: {
      mensagensEnviadas: 0,
      respostasRecebidas: 0,
      followUpsPendentes: 0,
      campanhasAtivas: 0,
      campanhasTotal: 0,
      conexoesConectadas: 0,
      conexoesTotal: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Acesso ao Supabase (service role) + montagem do dashboard
// ---------------------------------------------------------------------------

function sup() {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

function supHeaders(json = false): Record<string, string> {
  const cfg = getSupabaseProspeccaoConfig();
  return json
    ? { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}`, 'Content-Type': 'application/json' }
    : { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
}

async function fetchLeads(): Promise<LeadRowCommercial[]> {
  const s = sup();
  if (!s) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/leads?select=id,status,sale_value,sale_status,meeting_at,meeting_outcome,closed_at,created_at,last_message_sent`,
      { headers: supHeaders() },
    );
    if (!res.ok) return [];
    return (await res.json()) as LeadRowCommercial[];
  } catch {
    return [];
  }
}

async function fetchOperacaoCounts(): Promise<OperacaoResults> {
  const s = sup();
  const empty: OperacaoResults = {
    mensagensEnviadas: 0,
    respostasRecebidas: 0,
    followUpsPendentes: 0,
    campanhasAtivas: 0,
    campanhasTotal: 0,
    conexoesConectadas: 0,
    conexoesTotal: 0,
  };
  if (!s) return empty;
  try {
    const res = await fetch(`${s.url}/rest/v1/leads?select=status,last_message_sent`, {
      headers: supHeaders(),
    });
    if (!res.ok) return empty;
    const rows = (await res.json()) as Array<{ status: string | null; last_message_sent: string | null }>;
    const replied = new Set<string>([
      'conversando', 'sem_interesse', 'remarketing', 'reuniao_marcada',
      'reuniao_cancelada', 'fechado', 'nao_fechado', 'para_ligacao', 'responder_depois',
    ]);
    const mensagensEnviadas = rows.filter((l) => !!l.last_message_sent).length;
    const respostasRecebidas = rows.filter((l) => replied.has(l.status ?? '')).length;
    return { ...empty, mensagensEnviadas, respostasRecebidas };
  } catch {
    return empty;
  }
}

async function fetchCampaignCounts(): Promise<{ ativas: number; total: number }> {
  const s = sup();
  if (!s) return { ativas: 0, total: 0 };
  try {
    const res = await fetch(`${s.url}/rest/v1/campaigns?select=status`, { headers: supHeaders() });
    if (!res.ok) return { ativas: 0, total: 0 };
    const rows = (await res.json()) as Array<{ status: string | null }>;
    const ativas = rows.filter((c) => ['em_progresso', 'agendada', 'pausada', 'pronta'].includes(c.status ?? '')).length;
    return { ativas, total: rows.length };
  } catch {
    return { ativas: 0, total: 0 };
  }
}

async function fetchConnectionCounts(): Promise<{ conectadas: number; total: number }> {
  const s = sup();
  if (!s) return { conectadas: 0, total: 0 };
  try {
    const res = await fetch(`${s.url}/rest/v1/whatsapp_connections?select=status`, { headers: supHeaders() });
    if (!res.ok) return { conectadas: 0, total: 0 };
    const rows = (await res.json()) as Array<{ status: string | null }>;
    const conectadas = rows.filter((c) => c.status === 'connected').length;
    return { conectadas, total: rows.length };
  } catch {
    return { conectadas: 0, total: 0 };
  }
}

async function fetchFollowUpCount(): Promise<number> {
  const s = sup();
  if (!s) return 0;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/follow_ups?select=id&status=in.("agendado","processando")`,
      { headers: supHeaders() },
    );
    if (!res.ok) return 0;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows.length;
  } catch {
    return 0;
  }
}

export async function fetchGoal(identifier: string): Promise<CommercialGoal | null> {
  const s = sup();
  if (!s) return null;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/commercial_goals?select=*&user_id=eq.${encodeURIComponent(identifier)}&order=updated_at.desc&limit=1`,
      { headers: supHeaders() },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as CommercialGoal[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function upsertGoal(identifier: string, input: GoalInput): Promise<CommercialGoal | null> {
  const s = sup();
  if (!s) return null;
  const log = getLogger();

  const existing = await fetchGoal(identifier);
  const body: Record<string, unknown> = {
    goal_amount: input.goal_amount,
    period_days: input.period_days,
    avg_ticket: input.avg_ticket,
    meeting_close_rate: input.meeting_close_rate,
    leads_per_day: input.leads_per_day ?? null,
    user_id: identifier,
  };
  if (existing?.workspace_id) body.workspace_id = existing.workspace_id;

  try {
    const method = existing ? 'PATCH' : 'POST';
    const url = existing
      ? `${s.url}/rest/v1/commercial_goals?id=eq.${encodeURIComponent(existing.id)}`
      : `${s.url}/rest/v1/commercial_goals`;
    const res = await fetch(url, {
      method,
      headers: { ...supHeaders(true), Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn({ status: res.status, body: text.slice(0, 200) }, 'commercial: upsert goal failed');
      return null;
    }
    const text = await res.text();
    const rows = text ? (JSON.parse(text) as CommercialGoal[]) : [];
    const created = Array.isArray(rows) ? rows[0] : (rows as unknown as CommercialGoal);
    return created ?? null;
  } catch (err) {
    log.warn({ errMessage: err instanceof Error ? err.message : 'unknown' }, 'commercial: upsert goal error');
    return null;
  }
}

export async function buildCommercialDashboard(identifier: string): Promise<CommercialDashboard | null> {
  const goal = await fetchGoal(identifier);
  const leads = await fetchLeads();
  const real = computeRealResults(leads, goal);
  const [operacao, campanhas, conexoes, followUps] = await Promise.all([
    fetchOperacaoCounts(),
    fetchCampaignCounts(),
    fetchConnectionCounts(),
    fetchFollowUpCount(),
  ]);
  real.operacao = {
    ...real.operacao,
    ...operacao,
    followUpsPendentes: followUps,
    campanhasAtivas: campanhas.ativas,
    campanhasTotal: campanhas.total,
    conexoesConectadas: conexoes.conectadas,
    conexoesTotal: conexoes.total,
  };
  const projection = goal ? computeProjection({
    goal_amount: Number(goal.goal_amount),
    period_days: goal.period_days,
    avg_ticket: Number(goal.avg_ticket),
    meeting_close_rate: Number(goal.meeting_close_rate),
    leads_per_day: goal.leads_per_day != null ? Number(goal.leads_per_day) : null,
  }) : null;

  return {
    goal,
    projection,
    real,
    generatedAt: new Date().toISOString(),
  };
}
