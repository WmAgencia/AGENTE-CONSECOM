/**
 * ASSISTENTE PESSOAL DA VYNTRA — IA PESSOAL do operador (ISOLADA).
 *
 * Este serviço é um agente de IA COMPLETAMENTE SEPARADO do agente comercial
 * de atendimento (agent.service.ts, tools/registry.ts, prompts, memória e
 * handoff do agente de clientes NÃO são tocados nem reutilizados aqui).
 *
 * Características:
 *   - Executa AÇÕES REAIS no VYNTRA através de ferramentas próprias (não é um
 *     sandbox): reuniões (marcar/reagendar/cancelar via agenda.service),
 *     campanhas (pausar/retomar/consultar) e consultas (agenda, leads).
 *   - MULTI-TENANCY: toda consulta/mutação é escopada por `owner_user_id` do
 *     usuário autenticado. Nenhuma ferramenta lê/escreve dados de outro usuário.
 *   - AÇÕES DESTRUTIVAS exigem confirmação explícita do usuário: `cancelar_reuniao`
 *     tem um guard determinístico que só executa se o histórico recente da
 *     conversa contiver a confirmação do operador (mesma filosofia do guard de
 *     `marcar_reuniao` do agente comercial, mas independente).
 *   - O loop de LLM replica o padrão do agente comercial (NVIDIA NIM
 *     chat/completions com tool-calling + fallback ReAct) sem compartilhar
 *     estado com o agente dos clientes.
 */
import { getEnv, getNvidiaApiKey, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import {
  getAvailableSlots,
  formatSlotsForAgent,
  reserveMeeting,
  editMeeting,
  cancelMeeting,
  markMeetingRealized,
} from './agenda.service.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** Offset fixo de São Paulo (UTC-3, sem DST desde 2019). */
const SP_OFFSET_MS = -3 * 3600_000;

const DAY_LABELS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

// ---------------------------------------------------------------------------
// Tipos internos (framework próprio de tools — não usa tools/registry.ts)
// ---------------------------------------------------------------------------

type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface PersonalHistoryItem {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

/** Contexto passado para os executores de ferramentas (multitenancy + guard). */
export interface PersonalToolContext {
  /** id do usuário autenticado (filtro obrigatório owner_user_id). */
  userId: string;
  /** turnos recentes da conversa (para guard de confirmação). */
  history: PersonalHistoryItem[];
}

export interface PersonalToolResult {
  ok: boolean;
  /** Texto legível que volta para o modelo. */
  output: string;
}

interface PersonalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: PersonalToolContext) => Promise<PersonalToolResult>;
}

export interface PersonalAgentResult {
  result: string;
  model: string;
  latencyMs: number;
  iterations: number;
  toolCalls: number;
  usedTools: boolean;
}

// ---------------------------------------------------------------------------
// Helpers Supabase (REST service-role, padrão do projeto)
// ---------------------------------------------------------------------------

function supabase(): { url: string; serviceRoleKey: string } | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

function headers(json = false): Record<string, string> {
  const cfg = getSupabaseProspeccaoConfig();
  return json
    ? { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}`, 'Content-Type': 'application/json' }
    : { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
}

/** Formata um instante ISO em "Segunda-feira 12/08 às 14:30" (fuso SP). */
export function fmtDateTimeIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + SP_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DAY_LABELS[d.getUTCDay()]} ${dd}/${mm} às ${hh}:${min}`;
}

// ---------------------------------------------------------------------------
// Guard de confirmação (ações destrutivas)
// ---------------------------------------------------------------------------

const CONFIRMATION_RE = /^(sim|certo|ok|pode|confirmo|confirmad|pode cancelar|vamos|claro|exato|com certeza)[\s,.!?)]/i;

/**
 * Verifica se os últimos turnos do USUÁRIO contêm confirmação explícita.
 * Só considera as últimas 2 mensagens do usuário para não "vazar"
 * confirmações antigas de outra ação.
 */
export function hasExplicitConfirmation(history: PersonalHistoryItem[]): boolean {
  const recent = history
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content.trim());
  if (recent.length === 0) return false;
  return recent.some((text) => {
    if (/(cancela|cancelar)/i.test(text) && /(pode|pode sim|confirmo|confirmo o cancelamento|ok|sim|pode cancelar)/i.test(text)) {
      return true;
    }
    return CONFIRMATION_RE.test(text) && /(cancela|cancelar|reuni[ãa]o|sim|certo|ok|claro)/i.test(text);
  });
}

// ---------------------------------------------------------------------------
// Ferramentas (todas escopadas por owner_user_id)
// ---------------------------------------------------------------------------

const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  pronta: 'pronta',
  em_progresso: 'em andamento',
  pausada: 'pausada',
  finalizada: 'finalizada',
  cancelada: 'cancelada',
  agendada: 'agendada',
};

async function listOwnMeetings(userId: string, limit = 15): Promise<string> {
  const s = supabase();
  if (!s) return 'Agenda não configurada (Supabase indisponível).';
  const nowIso = new Date().toISOString();
  const url =
    `${s.url}/rest/v1/leads?select=id,name,phone,status,meeting_at,meeting_notes` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}` +
    `&status=in.("reuniao_marcada","reuniao_cancelada")` +
    `&meeting_at=gte.${encodeURIComponent(nowIso)}` +
    `&order=meeting_at.asc&limit=${limit}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return 'Não foi possível consultar a agenda.';
  const rows = (await res.json()) as Array<{
    id: string;
    name: string | null;
    phone: string | null;
    status: string | null;
    meeting_at: string | null;
    meeting_notes: string | null;
  }>;
  if (rows.length === 0) return 'Nenhuma reunião futura encontrada para vocês.';
  const lines = rows.map((r) => {
    const state = r.status === 'reuniao_cancelada' ? ' [CANCELADA]' : '';
    const who = r.name || r.phone || 'sem identificação';
    return `- ${who}: ${fmtDateTimeIso(r.meeting_at)}${state}${r.meeting_notes ? ` — nota: ${r.meeting_notes}` : ''}`;
  });
  return `Próximas reuniões:\n${lines.join('\n')}`;
}

async function searchOwnLead(userId: string, term: string): Promise<string> {
  const s = supabase();
  if (!s) return 'Sistema não configurado.';
  const orFilter = `or=(name.ilike.*${encodeURIComponent(term)}*,phone.ilike.*${encodeURIComponent(term)}*)`;
  const url =
    `${s.url}/rest/v1/leads?select=id,name,phone,company,status,meeting_at` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}` +
    `&${orFilter}&order=created_at.desc&limit=10`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return 'Não foi possível consultar leads.';
  const rows = (await res.json()) as Array<{
    id: string;
    name: string | null;
    phone: string | null;
    company: string | null;
    status: string | null;
    meeting_at: string | null;
  }>;
  if (rows.length === 0) return `Nenhum lead encontrado para "${term}".`;
  const lines = rows.map((r) => {
    const name = r.name || '(sem nome)';
    const company = r.company ? ` / ${r.company}` : '';
    const status = r.status ? ` — status: ${r.status}` : '';
    const meeting = r.meeting_at && r.status === 'reuniao_marcada' ? ` — reunião: ${fmtDateTimeIso(r.meeting_at)}` : '';
    return `- id=${r.id}: ${name}${company}${status}${meeting}`;
  });
  return `Leads encontrados:\n${lines.join('\n')}`;
}

async function countOwnLeads(userId: string): Promise<string> {
  const s = supabase();
  if (!s) return 'Sistema não configurado.';
  const url = `${s.url}/rest/v1/leads?select=status&owner_user_id=eq.${encodeURIComponent(userId)}&limit=5000`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return 'Não foi possível consultar leads.';
  const rows = (await res.json()) as Array<{ status: string | null }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const st = r.status || 'sem_status';
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  const total = rows.length;
  const byStatus = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([st, n]) => `  ${st}: ${n}`)
    .join('\n');
  return `Total de leads próprios: ${total}\nPor status:\n${byStatus}`;
}

async function listOwnCampaigns(userId: string): Promise<string> {
  const s = supabase();
  if (!s) return 'Sistema não configurado.';
  const url =
    `${s.url}/rest/v1/campaigns?select=id,name,status,scheduled_at,started_at,created_at,lead_count,whatsapp_instance` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return 'Não foi possível consultar as campanhas.';
  const rows = (await res.json()) as Array<{
    id: string;
    name: string | null;
    status: string | null;
    scheduled_at: string | null;
    started_at: string | null;
    created_at: string | null;
    lead_count: number | null;
    whatsapp_instance: string | null;
  }>;
  if (rows.length === 0) return 'Nenhuma campanha encontrada para vocês.';
  const lines = rows.map((r) => {
    const label = CAMPAIGN_STATUS_LABEL[String(r.status ?? '')] ?? String(r.status ?? '');
    const when = r.status === 'agendada'
      ? ` — início ${fmtDateTimeIso(r.scheduled_at ?? r.created_at)}`
      : r.status === 'em_progresso' || r.status === 'pausada'
        ? ` — início ${fmtDateTimeIso(r.started_at ?? r.scheduled_at ?? r.created_at)}`
        : '';
    return `- id=${r.id}: ${r.name || 'Campanha'} — ${label}${when}${r.lead_count ? ` (${r.lead_count} leads)` : ''}`;
  });
  return `Campanhas:\n${lines.join('\n')}`;
}

/** Verifica que o lead existe e pertence ao usuário (multi-tenancy). */
async function requireOwnLead(userId: string, leadId: string): Promise<{ ok: boolean; name?: string; status?: string; message?: string }> {
  const s = supabase();
  if (!s) return { ok: false, message: 'Sistema não configurado.' };
  const url =
    `${s.url}/rest/v1/leads?select=id,name,status&id=eq.${encodeURIComponent(leadId)}` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}&limit=1`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return { ok: false, message: 'Falha ao verificar o lead.' };
  const rows = (await res.json()) as Array<{ id: string; name: string | null; status: string | null }>;
  if (rows.length === 0) {
    return {
      ok: false,
      message: 'Lead não encontrado ou não pertence ao seu usuário. Use buscar_lead para obter o id correto.',
    };
  }
  return { ok: true, name: rows[0].name ?? undefined, status: rows[0].status ?? undefined };
}

async function execListMeetings(_args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  try {
    const out = await listOwnMeetings(ctx.userId);
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, output: `Erro ao consultar agenda: ${err instanceof Error ? err.message : 'desconhecido'}` };
  }
}

async function execAvailability(args: Record<string, unknown>, _ctx: PersonalToolContext): Promise<PersonalToolResult> {
  try {
    const durationMin = Number(args.durationMin);
    const slots = await getAvailableSlots({
      durationMin: Number.isFinite(durationMin) && durationMin > 0 ? Math.round(durationMin) : undefined,
    });
    const out = slots.length === 0
      ? 'Nenhum horário disponível na janela consultada (verifique se a agenda está configurada no painel).'
      : await formatSlotsForAgent(slots);
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, output: `Erro ao consultar disponibilidade: ${err instanceof Error ? err.message : 'desconhecido'}` };
  }
}

async function execSearchLead(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const term = String(args.term ?? '');
  if (!term.trim()) return { ok: false, output: 'Informe um termo de busca (nome ou telefone).' };
  try {
    return { ok: true, output: await searchOwnLead(ctx.userId, term.trim()) };
  } catch (err) {
    return { ok: false, output: `Erro ao buscar lead: ${err instanceof Error ? err.message : 'desconhecido'}` };
  }
}

async function execCountLeads(_args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  try {
    return { ok: true, output: await countOwnLeads(ctx.userId) };
  } catch (err) {
    return { ok: false, output: `Erro ao consultar leads: ${err instanceof Error ? err.message : 'desconhecido'}` };
  }
}

async function execListCampaigns(_args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  try {
    return { ok: true, output: await listOwnCampaigns(ctx.userId) };
  } catch (err) {
    return { ok: false, output: `Erro ao consultar campanhas: ${err instanceof Error ? err.message : 'desconhecido'}` };
  }
}

async function execMarkMeeting(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const leadId = String(args.leadId ?? '');
  const startIso = String(args.startIso ?? '');
  const durationMin = Number(args.durationMin);
  if (!leadId || !startIso) {
    return { ok: false, output: 'leadId e startIso são obrigatórios para marcar a reunião.' };
  }
  const owner = await requireOwnLead(ctx.userId, leadId);
  if (!owner.ok) return { ok: false, output: owner.message ?? 'Lead inválido.' };
  const result = await reserveMeeting({
    leadId,
    startIso,
    durationMin: Number.isFinite(durationMin) && durationMin > 0 ? Math.round(durationMin) : undefined,
  });
  if (!result.ok) {
    const suggestions = result.suggestions && result.suggestions.length > 0
      ? `\nHorários alternativos: ${result.suggestions.join('; ')}`
      : '';
    return { ok: false, output: `${result.message ?? 'Não foi possível marcar a reunião.'}${suggestions}` };
  }
  return { ok: true, output: `Reunião marcada com sucesso: ${fmtDateTimeIso(startIso)}.` };
}

async function execRescheduleMeeting(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const leadId = String(args.leadId ?? '');
  const startIso = String(args.startIso ?? '');
  if (!leadId || !startIso) {
    return { ok: false, output: 'leadId e startIso são obrigatórios para reagendar.' };
  }
  const owner = await requireOwnLead(ctx.userId, leadId);
  if (!owner.ok) return { ok: false, output: owner.message ?? 'Lead inválido.' };
  if (owner.status && owner.status !== 'reuniao_marcada') {
    return { ok: false, output: `Este contato não possui reunião marcada (status atual: ${owner.status}).` };
  }
  const durationMin = Number(args.durationMin);
  const result = await editMeeting({
    leadId,
    startIso,
    durationMin: Number.isFinite(durationMin) && durationMin > 0 ? Math.round(durationMin) : undefined,
  });
  if (!result.ok) {
    const suggestions = result.suggestions && result.suggestions.length > 0
      ? `\nHorários alternativos: ${result.suggestions.join('; ')}`
      : '';
    return { ok: false, output: `${result.message ?? 'Não foi possível reagendar.'}${suggestions}` };
  }
  return { ok: true, output: `Reunião reagendada com sucesso: ${fmtDateTimeIso(startIso)}.` };
}

async function execCancelMeeting(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const leadId = String(args.leadId ?? '');
  const motive = String(args.motive ?? '').trim() || undefined;
  if (!leadId) return { ok: false, output: 'leadId é obrigatório para cancelar a reunião.' };
  const owner = await requireOwnLead(ctx.userId, leadId);
  if (!owner.ok) return { ok: false, output: owner.message ?? 'Lead inválido.' };

  if (!hasExplicitConfirmation(ctx.history)) {
    return {
      ok: false,
      output:
        'AÇÃO NÃO EXECUTADA. Cancelar uma reunião é uma ação destrutiva e precisa da ' +
        `confirmação explícita do usuário. Pergunte: "Confirma o cancelamento da reunião com ${owner.name ?? 'este contato'}?" ` +
        'e só chame cancelar_reuniao de novo quando o usuário confirmar.',
    };
  }

  const result = await cancelMeeting(leadId, motive);
  return result.ok
    ? { ok: true, output: `Reunião com ${owner.name ?? 'o contato'} cancelada. ${result.message ?? ''}`.trim() }
    : { ok: false, output: result.message ?? 'Não foi possível cancelar a reunião.' };
}

async function execMarkRealized(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const leadId = String(args.leadId ?? '');
  if (!leadId) return { ok: false, output: 'leadId é obrigatório.' };
  const owner = await requireOwnLead(ctx.userId, leadId);
  if (!owner.ok) return { ok: false, output: owner.message ?? 'Lead inválido.' };
  const result = await markMeetingRealized(leadId);
  return result.ok
    ? { ok: true, output: result.message ?? 'Reunião marcada como realizada.' }
    : { ok: false, output: result.message ?? 'Falha ao marcar como realizada.' };
}

async function setCampaignStatus(
  userId: string,
  campaignId: string,
  target: 'pausada' | 'em_progresso',
  allowedFrom: string[],
): Promise<PersonalToolResult> {
  const s = supabase();
  if (!s) return { ok: false, output: 'Sistema não configurado.' };
  const url =
    `${s.url}/rest/v1/campaigns?select=id,name,status` +
    `&id=eq.${encodeURIComponent(campaignId)}&owner_user_id=eq.${encodeURIComponent(userId)}&limit=1`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return { ok: false, output: 'Falha ao consultar a campanha.' };
  const rows = (await res.json()) as Array<{ id: string; name: string | null; status: string | null }>;
  const camp = rows[0];
  if (!camp) {
    return {
      ok: false,
      output: 'Campanha não encontrada ou não pertence ao seu usuário. Use consultar_campanhas para obter o id.',
    };
  }
  const current = String(camp.status ?? '');
  if (!allowedFrom.includes(current)) {
    return {
      ok: false,
      output: `A campanha "${camp.name ?? 'Campanha'}" está ${CAMPAIGN_STATUS_LABEL[current] ?? current} e não pode ser ${target === 'pausada' ? 'pausada' : 'retomada'} agora.`,
    };
  }
  const patchUrl = `${s.url}/rest/v1/campaigns?id=eq.${encodeURIComponent(campaignId)}&owner_user_id=eq.${encodeURIComponent(userId)}`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...headers(true), Prefer: 'return=representation' },
    body: JSON.stringify({ status: target, updated_at: new Date().toISOString() }),
  });
  if (!patchRes.ok) return { ok: false, output: 'Falha ao atualizar a campanha no sistema.' };
  const patched = (await patchRes.json()) as Array<{ status: string | null }>;
  if (!patched[0] || patched[0].status !== target) {
    return { ok: false, output: 'A campanha não foi atualizada (verifique o status atual).' };
  }
  return {
    ok: true,
    output:
      target === 'pausada'
        ? `Campanha "${camp.name ?? 'Campanha'}" pausada. O envio de mensagens foi interrompido e pode ser retomado depois.`
        : `Campanha "${camp.name ?? 'Campanha'}" retomada (em andamento). O envio continua de onde parou.`,
  };
}

async function execPauseCampaign(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const campaignId = String(args.campaignId ?? '');
  if (!campaignId) return { ok: false, output: 'campaignId é obrigatório.' };
  return setCampaignStatus(ctx.userId, campaignId, 'pausada', ['agendada', 'em_progresso', 'pronta']);
}

async function execResumeCampaign(args: Record<string, unknown>, ctx: PersonalToolContext): Promise<PersonalToolResult> {
  const campaignId = String(args.campaignId ?? '');
  if (!campaignId) return { ok: false, output: 'campaignId é obrigatório.' };
  return setCampaignStatus(ctx.userId, campaignId, 'em_progresso', ['pausada']);
}

// ---------------------------------------------------------------------------
// Helpers REST (usados pelas rotas /api/personal/* — mesmo escopo owner)
// ---------------------------------------------------------------------------

export interface OwnMeetingJson {
  id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  meeting_at: string | null;
  meeting_notes: string | null;
}

export interface OwnLeadJson {
  id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  meeting_at: string | null;
}

export async function listOwnMeetingsJson(userId: string, limit = 50): Promise<OwnMeetingJson[]> {
  const s = supabase();
  if (!s) return [];
  const nowIso = new Date().toISOString();
  const url =
    `${s.url}/rest/v1/leads?select=id,name,phone,status,meeting_at,meeting_notes` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}` +
    `&status=in.("reuniao_marcada","reuniao_cancelada")` +
    `&meeting_at=gte.${encodeURIComponent(nowIso)}` +
    `&order=meeting_at.asc&limit=${limit}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  return (await res.json()) as OwnMeetingJson[];
}

export async function searchOwnLeadsJson(userId: string, q: string, limit = 25): Promise<OwnLeadJson[]> {
  const s = supabase();
  if (!s) return [];
  const term = String(q ?? '').trim();
  const orFilter = `or=(name.ilike.*${encodeURIComponent(term)}*,phone.ilike.*${encodeURIComponent(term)}*)`;
  const url =
    `${s.url}/rest/v1/leads?select=id,name,phone,status,meeting_at` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}` +
    `&${orFilter}&order=created_at.desc&limit=${limit}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  return (await res.json()) as OwnLeadJson[];
}

export async function reserveOwnMeeting(
  userId: string,
  leadId: string,
  startIso: string,
  durationMin?: number,
): Promise<{ ok: boolean; message?: string; suggestions?: string[] }> {
  const owner = await requireOwnLead(userId, leadId);
  if (!owner.ok) return { ok: false, message: owner.message ?? 'Lead inválido.' };
  const result = await reserveMeeting({
    leadId,
    startIso,
    durationMin: durationMin && durationMin > 0 ? Math.round(durationMin) : undefined,
  });
  return { ok: result.ok, message: result.message, suggestions: result.suggestions };
}

export async function rescheduleOwnMeeting(
  userId: string,
  leadId: string,
  startIso: string,
): Promise<{ ok: boolean; message?: string; suggestions?: string[] }> {
  const owner = await requireOwnLead(userId, leadId);
  if (!owner.ok) return { ok: false, message: owner.message ?? 'Lead inválido.' };
  if (owner.status && owner.status !== 'reuniao_marcada') {
    return { ok: false, message: `Este contato não possui reunião marcada (status atual: ${owner.status}).` };
  }
  const result = await editMeeting({ leadId, startIso });
  return { ok: result.ok, message: result.message, suggestions: result.suggestions };
}

export async function cancelOwnMeeting(
  userId: string,
  leadId: string,
  motive?: string,
): Promise<{ ok: boolean; message?: string }> {
  const owner = await requireOwnLead(userId, leadId);
  if (!owner.ok) return { ok: false, message: owner.message ?? 'Lead inválido.' };
  return cancelMeeting(leadId, motive);
}

export async function realizeOwnMeeting(
  userId: string,
  leadId: string,
): Promise<{ ok: boolean; message?: string }> {
  const owner = await requireOwnLead(userId, leadId);
  if (!owner.ok) return { ok: false, message: owner.message ?? 'Lead inválido.' };
  return markMeetingRealized(leadId);
}

// ---------------------------------------------------------------------------
// Registro de ferramentas (schema OpenAI-compatible)
// ---------------------------------------------------------------------------

const LEAD_ID = {
  type: 'string',
  description: 'id do lead (use buscar_lead para obtê-lo).',
};
const START_ISO = {
  type: 'string',
  description: 'Data/hora da reunião em ISO 8601 (ex: 2026-08-14T14:00:00-03:00).',
};

export const PERSONAL_TOOLS: PersonalTool[] = [
  {
    name: 'consultar_agenda',
    description: 'Lista as próximas reuniões marcadas (e canceladas) do usuário.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: execListMeetings,
  },
  {
    name: 'verificar_disponibilidade',
    description:
      'Consulta os horários livres na agenda (leva em conta a disponibilidade semanal, bloqueios e reuniões já marcadas). Use SEMPRE antes de sugerir horários.',
    parameters: {
      type: 'object',
      properties: {
        durationMin: { type: 'number', description: 'Duração desejada em minutos (opcional; padrão da agenda).' },
      },
      required: [],
    },
    execute: execAvailability,
  },
  {
    name: 'buscar_lead',
    description: 'Pesquisa leads do usuário por nome ou telefone e retorna o id de cada um.',
    parameters: {
      type: 'object',
      properties: { term: { type: 'string', description: 'Nome ou telefone para buscar.' } },
      required: ['term'],
    },
    execute: execSearchLead,
  },
  {
    name: 'consultar_leads',
    description: 'Conta os leads do usuário por status (funil).',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: execCountLeads,
  },
  {
    name: 'consultar_campanhas',
    description: 'Lista as campanhas do usuário com status (agendada, em andamento, pausada, etc.) e horários.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: execListCampaigns,
  },
  {
    name: 'marcar_reuniao',
    description:
      'Marca uma reunião em um horário livre. Use verificar_disponibilidade primeiro e só chame quando o usuário escolher o horário.',
    parameters: {
      type: 'object',
      properties: { leadId: LEAD_ID, startIso: START_ISO, durationMin: { type: 'number', description: 'Duração em minutos (opcional).' } },
      required: ['leadId', 'startIso'],
    },
    execute: execMarkMeeting,
  },
  {
    name: 'reagendar_reuniao',
    description: 'Altera a data/hora de uma reunião já marcada. Valida o novo horário na disponibilidade.',
    parameters: {
      type: 'object',
      properties: { leadId: LEAD_ID, startIso: START_ISO, durationMin: { type: 'number', description: 'Duração em minutos (opcional).' } },
      required: ['leadId', 'startIso'],
    },
    execute: execRescheduleMeeting,
  },
  {
    name: 'cancelar_reuniao',
    description:
      'CANCELA uma reunião. AÇÃO DESTRUTIVA: requer confirmação explícita do usuário na conversa. Pergunte a confirmação antes de chamar.',
    parameters: {
      type: 'object',
      properties: {
        leadId: LEAD_ID,
        motive: { type: 'string', description: 'Motivo do cancelamento (opcional).' },
      },
      required: ['leadId'],
    },
    execute: execCancelMeeting,
  },
  {
    name: 'marcar_reuniao_realizada',
    description: 'Marca uma reunião como realizada (desfecho).',
    parameters: { type: 'object', properties: { leadId: LEAD_ID }, required: ['leadId'] },
    execute: execMarkRealized,
  },
  {
    name: 'pausar_campanha',
    description: 'Pausa uma campanha (interrompe o envio de mensagens). Reversível com retomar_campanha.',
    parameters: {
      type: 'object',
      properties: { campaignId: { type: 'string', description: 'id da campanha (use consultar_campanhas).' } },
      required: ['campaignId'],
    },
    execute: execPauseCampaign,
  },
  {
    name: 'retomar_campanha',
    description: 'Retoma uma campanha pausada (volta para "em andamento").',
    parameters: {
      type: 'object',
      properties: { campaignId: { type: 'string', description: 'id da campanha (use consultar_campanhas).' } },
      required: ['campaignId'],
    },
    execute: execResumeCampaign,
  },
];

// ---------------------------------------------------------------------------
// System prompt do Assistente Pessoal (próprio — não usa prompt do agente)
// ---------------------------------------------------------------------------

export function buildPersonalSystemPrompt(): string {
  const agora = new Date(Date.now() + SP_OFFSET_MS);
  const dataAtual = agora.toISOString().slice(0, 10);
  const horaAtual = agora.toISOString().slice(11, 16);
  const toolNames = PERSONAL_TOOLS.map((t) => t.name);
  return [
    'Você é o Assistente Pessoal da VYNTRA: o braço executivo do operador da plataforma.',
    'Você NÃO atende clientes: você auxilia SOMENTE o dono/operador autenticado.',
    'Você executa AÇÕES REAIS no sistema através de ferramentas (agenda de reuniões, campanhas e leads).',
    'SEMPRE resolva datas relativas ("hoje", "amanhã", "depois de amanhã") contra a data atual.',
    `Data de hoje: ${dataAtual} (America/Sao_Paulo, UTC-3). Hora atual: ${horaAtual}.`,
    'REGRAS OBRIGATÓRIAS:',
    '- Nunca invente dados: use as ferramentas para consultar antes de afirmar qualquer coisa sobre reuniões, campanhas ou leads.',
    '- Para sugerir um horário de reunião, PRIMEIRO chame verificar_disponibilidade e ofereça apenas horários realmente livres.',
    '- Só chame marcar_reuniao quando o usuário escolher explicitamente um horário.',
    '- CANCELAR REUNIÃO é destrutivo: primeira pergunta pela confirmação; só chame cancelar_reuniao quando o usuário confirmar.',
    '- Campanhas: pausar interrompe o envio (reversível); retomar volta ao estado em andamento.',
    '- Responda em português, curto e direto, com o resultado real das operações.',
    '- Nunca revele chaves, tokens ou segredos.',
    'Ferramentas disponíveis: ' + toolNames.join(', ') + '.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Loop de LLM (padrão do projeto, isolado do agente comercial)
// ---------------------------------------------------------------------------

interface NvidiaChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: ChatMessage['tool_calls'];
  };
}

function parseReactToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const re = /<tool\s+name="([a-zA-Z0-9_.-]+)"(?:\s+args='([^']*)')?\s*\/>/;
  const m = text.match(re);
  if (!m) return null;
  const name = m[1];
  let args: Record<string, unknown> = {};
  if (m[2]) {
    try {
      args = JSON.parse(m[2]) as Record<string, unknown>;
    } catch {
      args = {};
    }
  }
  return { name, args };
}

let supportsToolsCache: boolean | null | undefined = undefined;

function getSupportsTools(): boolean | null {
  if (supportsToolsCache === undefined) {
    const v = getEnv().AGENT_MODEL_SUPPORTS_TOOLS;
    supportsToolsCache = v === 'true' ? true : v === 'false' ? false : null;
  }
  return supportsToolsCache;
}

function setSupportsTools(v: boolean): void {
  supportsToolsCache = v;
}

const toolMap = new Map<string, PersonalTool>();
for (const tool of PERSONAL_TOOLS) toolMap.set(tool.name, tool);

/** Executa uma ferramenta com timeout (padrão do agente comercial). */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PersonalToolContext,
  timeoutMs: number,
): Promise<PersonalToolResult> {
  const tool = toolMap.get(name);
  if (!tool) return { ok: false, output: `Ferramenta desconhecida: ${name}` };
  try {
    return await Promise.race([
      tool.execute(args, ctx),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tool timeout')), timeoutMs)),
    ]);
  } catch (err) {
    return { ok: false, output: `Ferramenta ${name} falhou: ${err instanceof Error ? err.message : 'erro desconhecido'}` };
  }
}

function toolHistory(messages: ChatMessage[]): PersonalHistoryItem[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant' | 'tool', content: typeof m.content === 'string' ? m.content : '' }));
}

function openAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return PERSONAL_TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface PersonalChatInput {
  task: string;
  conversationId?: string;
  userId: string;
  history?: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
}

/**
 * Entrypoint do chat da IA Pessoal. `userId` é obrigatório e define o escopo
 * (owner_user_id) de todas as operações.
 */
export async function runPersonalAgent(input: PersonalChatInput): Promise<PersonalAgentResult> {
  const env = getEnv();
  const log = getLogger();
  const start = Date.now();
  const systemContent = buildPersonalSystemPrompt();

  const messageLog: ChatMessage[] = [{ role: 'system', content: systemContent }];
  if (input.history && input.history.length > 0) {
    messageLog.push(...(input.history as ChatMessage[]));
  }
  messageLog.push({ role: 'user', content: input.task });

  let iterations = 0;
  let toolCallsTotal = 0;
  let finalContent = '';

  for (let i = 0; i < env.AGENT_MAX_ITERATIONS; i++) {
    iterations = i + 1;
    const supportsTools = getSupportsTools();
    const sendTools = supportsTools !== false;
    const useReactFallback = supportsTools === false;

    const body: Record<string, unknown> = {
      model: env.AGENT_MODEL,
      messages: messageLog,
      max_tokens: env.AGENT_MAX_TOKENS,
      temperature: 0.2,
      top_p: 0.7,
      stream: false,
    };
    if (sendTools) body.tools = openAITools();

    let rawStatus = 0;
    let rawText = '';
    let parsed: { choices?: NvidiaChatChoice[]; error?: { message?: string } };
    try {
      const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getNvidiaApiKey()}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      rawStatus = response.status;
      rawText = await response.text();
      if (!response.ok) {
        const looksLikeToolsError =
          sendTools && rawStatus === 400 && /(tool|function|not support)/i.test(rawText);
        if (looksLikeToolsError && getSupportsTools() !== false) {
          setSupportsTools(false);
          log.warn('personal-agent: tools reject by model; switching to ReAct fallback');
          continue;
        }
        let apiMessage: string | undefined;
        try {
          apiMessage = (JSON.parse(rawText) as { error?: { message?: string } }).error?.message;
        } catch {
          apiMessage = undefined;
        }
        throw new Error(
          `NVIDIA API request failed with status ${rawStatus}` + (apiMessage ? `: ${apiMessage}` : ''),
        );
      }
      parsed = JSON.parse(rawText) as { choices?: NvidiaChatChoice[]; error?: { message?: string } };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NVIDIA API')) throw err;
      throw new Error(
        `Personal assistant failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    if (parsed.error) {
      throw new Error(`NVIDIA API error: ${parsed.error.message ?? 'unknown'}`);
    }

    const choice = parsed.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    let content = (choice?.message?.content ?? '').toString().trim();

    if (useReactFallback && (!toolCalls || toolCalls.length === 0) && content.includes('<tool ')) {
      const react = parseReactToolCall(content);
      if (react) {
        toolCallsTotal++;
        messageLog.push({ role: 'assistant', content });
        const result = await runTool(react.name, react.args, {
          userId: input.userId,
          history: toolHistory(messageLog),
        }, env.AGENT_TOOL_TIMEOUT_MS);
        log.info({ tool: react.name, ok: result.ok }, 'personal-agent: tool completed (react)');
        messageLog.push({
          role: 'user',
          content: `<tool_result tool="${react.name}" ok="${result.ok}">${result.output}</tool_result>`,
        });
        continue;
      }
    }

    if (!toolCalls || toolCalls.length === 0) {
      finalContent = content || '[sem resposta do modelo]';
      break;
    }

    messageLog.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });

    for (const call of toolCalls) {
      toolCallsTotal++;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      const result = await runTool(call.function.name, args, {
        userId: input.userId,
        history: toolHistory(messageLog),
      }, env.AGENT_TOOL_TIMEOUT_MS);
      log.info({ tool: call.function.name, ok: result.ok, userId: input.userId }, 'personal-agent: tool completed');
      messageLog.push({ role: 'tool', tool_call_id: call.id, content: result.output });
    }
  }

  if (!finalContent) {
    finalContent = '[assistente pessoal parou: limite de iterações sem resposta final]';
  }

  const latencyMs = Date.now() - start;
  return {
    result: finalContent,
    model: env.AGENT_MODEL,
    latencyMs,
    iterations,
    toolCalls: toolCallsTotal,
    usedTools: toolCallsTotal > 0,
  };
}