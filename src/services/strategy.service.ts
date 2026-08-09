/**
 * Strategy service for the Consecom prospection agent.
 *
 * Responsibilities:
 *  - distribute strategies among leads of a campaign (weighted A/B pick)
 *  - load the strategy attached to a lead (used to inject style into the prompt)
 *  - list/link strategies for the admin UI
 *
 * A "strategy" is a versioned approach (e.g. strategy_001 direct, strategy_002
 * consultative). When a campaign has strategies linked via campaign_strategies,
 * each lead gets one picked by weight so the funnel can compare them later.
 *
 * Safe-by-default: all functions return null/[] on missing config or errors and
 * never throw, so the agent flow is never broken by strategy bookkeeping.
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

export interface Strategy {
  id: string;
  code: string;
  version: number;
  name: string;
  description: string | null;
  first_message: string | null;
  segment: string | null;
  service: string | null;
  status: string;
  approval_status: string;
}

export interface CampaignStrategyLink {
  strategy_id: string;
  weight: number;
}

function sup(): { url: string; key: string } | null {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  return { url: cfg.url, key: cfg.serviceRoleKey };
}

function headers(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

/**
 * Loads the strategies linked to a campaign (with their weights).
 * Returns [] when none are linked or on any error.
 */
export async function loadCampaignStrategies(
  campaignId: string,
): Promise<CampaignStrategyLink[]> {
  const s = sup();
  if (!s || !campaignId) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/campaign_strategies?select=strategy_id,weight&campaign_id=eq.${encodeURIComponent(campaignId)}`,
      { headers: headers(s.key) },
    );
    if (!res.ok) return [];
    return (await res.json()) as CampaignStrategyLink[];
  } catch {
    return [];
  }
}

/**
 * Loads full strategy rows for the given strategy ids (chunked lookup).
 */
export async function loadStrategiesByIds(
  ids: string[],
): Promise<Strategy[]> {
  const s = sup();
  if (!s || ids.length === 0) return [];
  const unique = Array.from(new Set(ids));
  try {
    const res = await fetch(
      `${s.url}/rest/v1/strategies?select=*&id=in.(${unique.map((i) => encodeURIComponent(i)).join(',')})`,
      { headers: headers(s.key) },
    );
    if (!res.ok) return [];
    return (await res.json()) as Strategy[];
  } catch {
    return [];
  }
}

/**
 * Weighted pick among campaign strategies. Returns the chosen strategy id or
 * null when none are linked. If a previous strategy is already set on the lead
 * and still valid, it is kept (idempotent re-runs).
 */
export function pickStrategyForLead(
  links: CampaignStrategyLink[],
  currentStrategyId: string | null,
): string | null {
  if (links.length === 0) return null;
  if (currentStrategyId) return currentStrategyId;
  const total = links.reduce((acc, l) => acc + Math.max(1, l.weight), 0);
  let roll = Math.floor(Math.random() * total);
  for (const l of links) {
    roll -= Math.max(1, l.weight);
    if (roll < 0) return l.strategy_id;
  }
  return links[0].strategy_id;
}

/**
 * Assigns a strategy to a lead (used by the send-worker before first send and
 * by the webhook when a lead starts a conversation). Only updates when the lead
 * has no strategy yet. Returns the strategy id applied or the existing one.
 */
export async function assignStrategyToLead(
  leadId: string,
  campaignId: string | null,
  currentStrategyId: string | null,
): Promise<string | null> {
  const s = sup();
  if (!s || !leadId || !campaignId) return currentStrategyId;
  try {
    if (currentStrategyId) return currentStrategyId;
    const links = await loadCampaignStrategies(campaignId);
    const chosen = pickStrategyForLead(links, null);
    if (!chosen) return null;
    await fetch(`${s.url}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      headers: headers(s.key, true),
      body: JSON.stringify({ strategy_id: chosen }),
    });
    return chosen;
  } catch {
    return currentStrategyId;
  }
}

/**
 * Loads the strategy attached to a lead (null when absent). Used by the webhook
 * to inject the approach style into the agent prompt.
 */
export async function loadLeadStrategy(leadId: string): Promise<Strategy | null> {
  const s = sup();
  if (!s || !leadId) return null;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/leads?select=strategy_id&id=eq.${encodeURIComponent(leadId)}&limit=1`,
      { headers: headers(s.key) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ strategy_id: string | null }>;
    const strategyId = rows[0]?.strategy_id;
    if (!strategyId) return null;
    const strategies = await loadStrategiesByIds([strategyId]);
    return strategies[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds the strategy directive text injected into the agent prompt.
 * Returns null when there is nothing to inject.
 */
export function buildStrategyDirective(strategy: Strategy | null): string | null {
  if (!strategy) return null;
  const parts: string[] = [];
  parts.push(
    `Você está usando a estratégia "${strategy.name}" (${strategy.code} v${strategy.version}).`,
  );
  if (strategy.description) {
    parts.push(`Abordagem: ${strategy.description}`);
  }
  if (strategy.segment) parts.push(`Foco de segmento: ${strategy.segment}`);
  if (strategy.service) parts.push(`Foco de serviço: ${strategy.service}`);
  return parts.join(' ');
}

/** Logs a warning helper (keeps pino usage consistent). */
function warn(msg: string): void {
  getLogger().warn({ service: 'strategy' }, msg);
}

/** Explicitly unused but kept for future admin UI list endpoints. */
export async function listActiveStrategies(): Promise<Strategy[]> {
  const s = sup();
  if (!s) return [];
  try {
    const res = await fetch(
      `${s.url}/rest/v1/strategies?select=*&status=eq.ativa&order=created_at.desc`,
      { headers: headers(s.key) },
    );
    if (!res.ok) return [];
    return (await res.json()) as Strategy[];
  } catch {
    return [];
  }
}

// keep warn referenced (TS noUnusedLocals) - used by helpers above in future.
void warn;
