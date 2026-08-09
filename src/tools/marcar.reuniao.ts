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

export function createMarcarReuniaoTool(): ToolBase {
  return {
    definition: {
      name: 'marcar_reuniao',
      description:
        'Registra que o lead aceitou/reuniu com você (prospecção Consecom). ' +
        'Quando o lead tem um ID no sistema, marcamos a reunião no Supabase e, se o ' +
        'grupo admin estiver configurado, notifica a equipe. Use SOMENTE quando o ' +
        'prospect realmente agendou/aceitou a reunião. Informe leadId quando conhecer.',
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
            description: 'Data/hora sugerida da reunião, em texto livre.',
          },
          notes: {
            type: 'string',
            description: 'Observações sobre a reunião (opcional).',
          },
        },
        required: [],
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

      let recorded = false;
      let supabaseError: string | undefined;
      if (hasSupabaseProspeccao() && leadId) {
        const cfg = getSupabaseProspeccaoConfig();
        if (!cfg.url || !cfg.serviceRoleKey) {
          supabaseError = 'Supabase não configurado';
        } else {
          try {
            // p_meeting_at é TIMESTAMPTZ no banco: só envia quando o texto
            // for uma data ISO parseável; caso contrário a data livre vai
            // para p_notes para não derrubar o RPC (evita erro 22007).
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