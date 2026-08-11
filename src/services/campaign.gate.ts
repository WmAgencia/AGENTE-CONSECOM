/**
 * Portão de sequência de campanha (Regra B).
 *
 * Enquanto um lead tem uma sequência de campanha ATIVA (existe um send_run com
 * status 'pending' ou 'running'), a IA NÃO deve responder às mensagens do lead.
 * As mensagens são recebidas e SALVAS (conversation store + historico
 * consecom_conversations), mas a IA não é chamada e nenhuma resposta é enviada.
 *
 * Quando a sequência termina (todas as mensagens confirmadas => run 'done')
 * ou é interrompida (run 'failed' por regra comercial / retries esgotados),
 * o portão libera e a IA volta a responder nas próximas mensagens.
 *
 * A fonte da verdade é a tabela `send_runs` (estado individual por lead), não o
 * status do funil: durante a campanha o lead pode estar 'novo'/'enviado', e
 * ambos precisam ficar bloqueados até o fim da sequência.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { getConversationStore } from './conversation.store.js';
import { appendConversationTurn } from './supabase.leads.js';

/** true quando o lead possui um send_run pendente/em andamento. */
export async function isLeadSequenceActive(leadId: string): Promise<boolean> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey || !leadId) return false;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/send_runs?select=id&lead_id=eq.${encodeURIComponent(leadId)}&status=in.("pending","running")&limit=1`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Regra B: se a sequência da campanha do lead estiver ativa, salva a mensagem
 * recebida (não se perde nada) e NÃO deixa a IA responder.
 *
 * @returns true quando a IA ficou bloqueada (mensagem salva); false quando o
 *          lead está liberado para resposta automática.
 */
export async function blockIfSequenceActive(opts: {
  leadId: string;
  conversationId: string;
  text: string;
}): Promise<boolean> {
  const log = getLogger();
  if (!(await isLeadSequenceActive(opts.leadId))) return false;

  try {
    await getConversationStore().appendUser(opts.conversationId, opts.text);
  } catch (err) {
    log.warn(
      { leadId: opts.leadId, errMessage: err instanceof Error ? err.message : 'unknown' },
      '[AI] falha ao salvar mensagem no conversation store durante bloqueio',
    );
  }
  await appendConversationTurn(opts.leadId, 'user', opts.text).catch(() => {});

  log.info(
    { leadId: opts.leadId },
    '[AI] IA bloqueada — sequência de campanha ativa (mensagem do lead salva, sem resposta)',
  );
  return true;
}
