/**
 * Tool: marcar_reuniao
 * Permission: NETWORK
 *
 * Records that a prospect agreed to a meeting. When the lead came from
 * Consecom (has a lead id), this marks the lead as "reuniao_marcada" in
 * Supabase (RPC consecom_marcar_reuniao) and, when an admin group is
 * configured, notifies the team so they know to attend/handle the meeting.
 *
 * If Supabase is not configured, the tool returns ok:false so the agent never
 * claims the meeting was recorded without real confirmation.
 */
import type { ToolBase } from './registry.js';
import {
  getSupabaseProspeccaoConfig,
  hasSupabaseProspeccao,
  getEnv,
} from '../config/env.js';
import { sendGroupText } from '../services/evolution.service.js';
import { resolveNotificationGroupJid } from '../services/evolution.connections.js';
import { captureLearning } from '../services/agent.learning.js';
import {
  resolveMeetingTime,
  reserveMeeting,
} from '../services/agenda.service.js';

export function createMarcarReuniaoTool(): ToolBase {
  return {
    definition: {
      name: 'marcar_reuniao',
      description:
        'Registra que o lead aceitou/reuniu com você (prospecção Consecom). ' +
        'Quando o lead tem um ID no sistema, marcamos a reunião no Supabase, validando ' +
        'que o horário está LIVRE na agenda (use consultar_disponibilidade antes para ' +
        'oferecer opções reais) e, se o grupo admin estiver configurado, notifica a equipe. ' +
        'Use SOMENTE quando o prospect realmente agendou/aceitou a reunião com data e hora ' +
        'concretas. Informe leadId quando conhecer.',
      parameters: {
        type: 'object',
        properties: {
          leadId: {
            type: 'string',
            description: 'ID do lead no sistema Consecom (quando conhecido).',
          },
          phone: {
            type: 'string',
            description: 'Número/whatsapp do lead (sem ou com @s.whatsapp.net).',
          },
          meetingAt: {
            type: 'string',
            description: 'Data/hora da reunião acordada com o lead (ex: "amanhã às 10h").',
          },
          notes: {
            type: 'string',
            description: 'Observações sobre a reunião (opcional).',
          },
        },
        required: ['meetingAt'],
      },
    },
    permission: 'NETWORK',
    async execute(args, ctx) {
      const leadId =
        typeof args.leadId === 'string' ? args.leadId.trim() : '';
      const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
      const meetingAt =
        typeof args.meetingAt === 'string' ? args.meetingAt.trim() : '';
      const notes =
        typeof args.notes === 'string' ? args.notes.trim() : '';

      if (!leadId && !phone) {
        return {
          ok: false,
          output:
            'Não há como registrar a reunião sem leadId ou phone. Peça o dado ou anote naturalmente.',
          error: 'invalid_args',
        };
      }

      // ------------------------------------------------------------------
      // GATE DETERMINÍSTICO: nunca registrar reunião "inventada" pelo modelo.
      // Só prossegue quando o LEAD escolheu explicitamente data E hora em
      // mensagens recentes da conversa. Se não houver evidência, retorna
      // ok:false e orienta o agente a perguntar a disponibilidade.
      // ------------------------------------------------------------------
      const acceptance = hasExplicitAcceptance(ctx.history ?? [], meetingAt);
      if (!acceptance.accepted) {
        return {
          ok: false,
          output:
            `Reunião NÃO registrada: ${acceptance.reason} ` +
            'Pergunte ao lead em que dia e horário ele prefere, ofereça opções ' +
            '(ex: "hoje 14h, amanhã às 10h ou 15h") e só marque quando ele escolher ' +
            'uma data e um horário. Não invente um acordo.',
          error: 'invalid_args',
        };
      }

      let recorded = false;
      let supabaseError: string | undefined;
      if (hasSupabaseProspeccao() && leadId) {
        const cfg = getSupabaseProspeccaoConfig();
        if (!cfg.url || !cfg.serviceRoleKey) {
          supabaseError = 'Supabase não configurado';
        } else {
          // Agenda: resolve data/hora concreta (fuso São Paulo) e valida
          // disponibilidade antes de gravar (evita horário duplo ou alucinado).
          const resolved = resolveMeetingTime(meetingAt);
          if (resolved) {
            const result = await reserveMeeting({
              leadId,
              startIso: resolved.toISOString(),
              notes,
              instance: ctx.instance,
            });
            if (result.ok) {
              recorded = true;
            } else if (
              result.reason === 'indisponivel' ||
              result.reason === 'fora_do_horario' ||
              result.reason === 'agenda_nao_configurada'
            ) {
              const suggestions = (result.suggestions ?? []).join(', ');
              return {
                ok: false,
                output:
                  `Reunião NÃO registrada: ${result.message}` +
                  (suggestions ? ` Horários alternativos: ${suggestions}.` : '') +
                  ' Consulte consultar_disponibilidade para oferecer horários livres ao lead.',
                error: 'invalid_args',
              };
            } else {
              supabaseError = result.message;
            }
          } else {
            // Sem data/hora concreta: fluxo legado (p_meeting_at null + data
            // livre em p_notes), para não inventar um horário nem derrubar o RPC.
            try {
              let meetingAtIso: string | null = null;
              if (meetingAt) {
                const parsed = Date.parse(meetingAt);
                if (!Number.isNaN(parsed)) meetingAtIso = new Date(parsed).toISOString();
              }
              const combinedNotes = [notes, meetingAt && !meetingAtIso ? `Data sugerida: ${meetingAt}` : null]
                .filter(Boolean)
                .join(' | ');
              const res = await fetch(`${cfg.url}/rest/v1/rpc/${cfg.rpc}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  apikey: cfg.serviceRoleKey,
                  Authorization: `Bearer ${cfg.serviceRoleKey}`,
                },
                body: JSON.stringify({
                  p_lead_id: leadId,
                  p_meeting_at: meetingAtIso,
                  p_notes: combinedNotes || null,
                }),
              });
              if (res.ok) {
                recorded = true;
              } else {
                supabaseError = `Supabase retornou status ${res.status}`;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'network error';
              supabaseError = `Falha ao chamar Supabase: ${msg}`;
            }
          }
        }
      }

      // Notify the user's configured notification group (best-effort).
      // Resolve por instância -> conexão -> notification_groups; cai para
      // AGENT_ADMIN_GROUP_JID quando nenhum grupo por usuário está configurado.
      const envAdminGroup = getEnv().AGENT_ADMIN_GROUP_JID;
      let notifiedAdmin = false;
      if (recorded) {
        const targetGroup =
          (ctx.instance ? await resolveNotificationGroupJid(ctx.instance) : null) ??
          envAdminGroup;
        if (targetGroup) {
          const leadInfo = leadId ? await fetchLeadInfo(leadId) : null;
          const summary = buildMeetingNotification({
            leadId,
            phone,
            meetingAt,
            notes,
            leadInfo,
          });
          const r = await sendGroupText(targetGroup, summary, ctx.instance);
          notifiedAdmin = r.ok;
        }
      }

      if (leadId && !recorded) {
        return {
          ok: false,
          output:
            `Não foi possível registrar a reunião no sistema: ${supabaseError ?? 'desconhecido'}. ` +
            'Não afirme ao lead que a reunião foi registrada.',
          error: 'io_error',
        };
      }

      // Autotreino: vitória real -> captura a lição (fire-and-forget).
      if (recorded && leadId) {
        void captureLearning('vitoria', leadId, {
          lessonOverride: notes || undefined,
        });
      }

      return {
        ok: true,
        output:
          `Reunião registrada com sucesso.${notifiedAdmin ? ' Equipe notificada.' : ''}`,
        data: { recorded, notifiedAdmin },
      };
    },
  };
}

interface LeadInfo {
  name?: string | null;
  email?: string | null;
  niche?: string | null;
  category?: string | null;
  phone?: string | null;
}

// ---------------------------------------------------------------------------
// GATE DE ACEITE: somente registra reunião quando existe evidência determinística
// de que o LEAD escolheu data (e/ou hora) na conversa recente. Nunca confia na
// data inventada pelo modelo (foi isso que causou reuniões alucinadas).
// ---------------------------------------------------------------------------

const REFUSAL_RE =
  /\b(n[aã]o\s+(preciso|quero|tenho|vou|posso)|nunc[aá]|sem\s+interesse|sem\s+hora|dispenso|desisto|nao\s+preciso)\b/i;

const DAY_RE =
  /\b(hoje|amanh[aã]|depois\s*de\s*amanh[aã]|segunda(-feira)?|seg\b|ter[cç]a(-feira)?|quarta(-feira)?|quinta(-feira)?|sexta(-feira)?|s[aá]bado|domingo)\b/i;

const TIME_RE =
  /\b((?:[01]?\d|2[0-3])\s*[:h]\s*(?:[0-5]\d)?)\b|(?:às\s*|as\s*|por\s+volta\s+de\s*)[0-9]{1,2}\s*[:h]?/i;

const ACCEPT_RE =
  /\b(sim|pode|podemos|t[aá]\s*bom|ta\s*bom|perfeito|o[́t]?timo|quero|vamos|combinado|fechado|aceito?|top[ao]|serve|serviria|ok\b|beleza|claro|agenda|marc[ao]?|confirm[ao]|deixa\s+marcado)\b/i;

export interface AcceptanceCheck {
  accepted: boolean;
  reason: string;
}

/**
 * Verifica se o lead escolheu uma data/hora de forma explícita nas mensagens
 * recentes da conversa. Usa apenas as mensagens do próprio lead (role 'user'):
 *   - recusa explícita -> rejeita
 *   - nenhuma mensagem do lead no recorte -> rejeita (não há evidência)
 *   - exige palavra de concordância + referência de dia OU hora na mensagem
 */
export function hasExplicitAcceptance(
  history: Array<{ role: string; content: string }>,
  claimedMeetingAt: string,
): AcceptanceCheck {
  const userTurns = (history ?? [])
    .filter((t) => t.role === 'user' && t.content && t.content.trim().length > 0)
    .map((t) => t.content.trim())
    .slice(-8);

  if (userTurns.length === 0) {
    return {
      accepted: false,
      reason: 'o lead ainda não respondeu na conversa recente.',
    };
  }

  // Toma como sinal a última mensagem do lead + um pouco de contexto anterior.
  const leadText = userTurns.join('\n');

  if (REFUSAL_RE.test(leadText)) {
    return {
      accepted: false,
      reason: 'o lead demonstrou não querer/estar com condição de reunir agora.',
    };
  }

  const hasDay = DAY_RE.test(leadText);
  const hasTime = TIME_RE.test(leadText);
  const hasAcceptance = ACCEPT_RE.test(leadText);

  if (!hasAcceptance) {
    return {
      accepted: false,
      reason: 'o lead não confirmou explicitamente (palavra de aceite) uma reunião.',
    };
  }

  if (!hasDay && !hasTime) {
    return {
      accepted: false,
      reason: 'o lead concordou, mas não escolheu nenhuma data/horário concreto.',
    };
  }

  // Sanidade extra: a data alegada pelo modelo precisa existir também.
  if (!claimedMeetingAt || claimedMeetingAt.trim().length === 0) {
    return {
      accepted: false,
      reason: 'não foi informada a data/hora combinada (campo meetingAt vazio).',
    };
  }

  return { accepted: true, reason: 'lead confirmou data/hora na conversa.' };
}

/** Busca dados extras do lead no Supabase (best-effort) para a notificação. */
async function fetchLeadInfo(leadId: string): Promise<LeadInfo | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!hasSupabaseProspeccao() || !cfg.url || !cfg.serviceRoleKey) return null;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/leads?select=name,phone,niche,category&id=eq.${encodeURIComponent(leadId)}&limit=1`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as LeadInfo[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Monta a notificação bonita de reunião marcada enviada ao grupo admin. */
function buildMeetingNotification(params: {
  leadId: string;
  phone: string;
  meetingAt: string;
  notes: string;
  leadInfo: LeadInfo | null;
}): string {
  const { leadId, phone, meetingAt, notes, leadInfo } = params;
  const name = leadInfo?.name || 'Não informado';
  const whatsapp = leadInfo?.phone || phone || 'Não informado';
  const email = leadInfo?.email || '';
  const niche = leadInfo?.niche || leadInfo?.category || 'Não informado';
  const company = leadInfo?.name || '';

  const lines = ['📅 NOVA REUNIÃO', ''];
  lines.push(`Nome: ${name}`);
  lines.push(`WhatsApp: ${whatsapp}`);
  if (email) lines.push(`E-mail: ${email}`);
  if (meetingAt) lines.push(`Data: ${meetingAt}`);
  if (notes) lines.push(`Horário: ${notes}`);
  lines.push(`Nicho: ${niche}`);
  if (company) lines.push(`Empresa: ${company}`);
  lines.push(`Ref: ${leadId}`);
  return lines.join('\n');
}