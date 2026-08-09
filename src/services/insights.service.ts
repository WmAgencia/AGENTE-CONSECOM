/**
 * Insight service for the Consecom prospection agent.
 *
 * Provides a safe bridge between the agent and the analytics module:
 *  - recordAgentInsight: stores an observation/hypothesis proposed by the model
 *    as a NEW (draft) row in agent_insights. It NEVER changes production
 *    prompts or rules by itself — a human must approve it in the UI.
 *
 * The learning loop is therefore: data -> hypothesis (draft) -> human approval
 * -> strategy test -> production.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

export type InsightKind =
  | 'estrategia'
  | 'mensagem'
  | 'pergunta'
  | 'segmento'
  | 'servico'
  | 'objecao'
  | 'gargalo';

export interface InsightInput {
  kind: InsightKind;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  strategyId?: string;
  leadId?: string;
}

export interface InsightResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Records a new agent insight as a DRAFT (status='nova'). Never auto-applies.
 * Fails silently (returns ok:false) when Supabase is not configured.
 */
export async function recordAgentInsight(input: InsightInput): Promise<InsightResult> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return { ok: false, error: 'supabase_unconfigured' };
  try {
    const payload = {
      kind: input.kind,
      title: typeof input.title === 'string' ? input.title.slice(0, 180) : String(input.title ?? '').slice(0, 180),
      body: typeof input.body === 'string' ? input.body.slice(0, 2000) : String(input.body ?? '').slice(0, 2000),
      data: {
        ...(input.data ?? {}),
        ...(input.leadId ? { lead_id: input.leadId } : {}),
        suggested_by: 'agent',
        created_from_conversation: true,
      },
      strategy_id: input.strategyId ?? null,
      status: 'nova',
    };
    const res = await fetch(`${cfg.url}/rest/v1/agent_insights`, {
      method: 'POST',
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      getLogger().warn({ status: res.status, body: text.slice(0, 200) }, 'insights: insert failed');
      return { ok: false, error: 'insert_failed' };
    }
    const rows = (await res.json()) as Array<{ id: string }>;
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    getLogger().warn({ errMessage: msg }, 'insights: record failed');
    return { ok: false, error: 'exception' };
  }
}
