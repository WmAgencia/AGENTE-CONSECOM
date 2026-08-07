/**
 * Autotreino do agente de prospecção (aprender com vitórias + rejeições).
 *
 * Quando um desfecho é registrado (vitória = reunião marcada/fechada,
 * rejeição = sem interesse / reunião cancelada / não fechou), captura o
 * transcript real da conversa, pede ao modelo um resumo curto do que
 * funcionou (ou o que provocou a rejeição) e grava em `agent_learning`.
 *
 * Nas próximas conversas o `buildSystemPrompt` injeta os aprendizados
 * recentes, então o agente ajusta o tom/abordagem pelo que deu certo/errado.
 */
import { getEnv, getNvidiaApiKey, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { fetchLeadTranscript } from './supabase.leads.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export type LearningKind = 'vitoria' | 'rejeicao';

interface LearningRow {
  outcome: LearningKind;
  lesson: string;
  created_at: string;
}

/** Pede ao modelo um resumo de 1-2 frases do que pode ser extraído da conversa. */
async function summarizeLesson(
  kind: LearningKind,
  transcript: Array<{ role: string; content: string }>,
): Promise<string> {
  if (transcript.length === 0 || !getNvidiaApiKey()) return '';
  const env = getEnv();

  const prompt =
    kind === 'vitoria'
      ? 'Resuma em UMA frase objetiva o que funcionou (tom, argumento ou gatilho) que fez este lead ACEITAR. Dica de prospecção climática a usar da próxima vez.'
      : 'Resuma em UMA frase objetiva o motivo da REJEIÇÃO e o que EVITAR em futuras conversas. Foco no sinal de recusa do lead.';

  const text = transcript
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'Lead' : 'Agente'}: ${t.content}`)
    .join('\n');

  try {
    const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getNvidiaApiKey()}`,
      },
      body: JSON.stringify({
        model: env.AGENT_MODEL,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: text },
        ],
        max_tokens: 120,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) return '';
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Captura o desfecho da conversa de um lead e grava um learning.
 * Fire-and-forget: nunca lança erro (não quebra o fluxo do agente).
 */
export async function captureLearning(
  kind: LearningKind,
  leadId: string,
  opts?: { lessonOverride?: string },
): Promise<void> {
  const log = getLogger();
  const cfg = getSupabaseProspeccaoConfig();
  if (!leadId || !cfg.url || !cfg.serviceRoleKey) return;

  try {
    let lesson = opts?.lessonOverride ?? '';
    if (!lesson) {
      const transcript = await fetchLeadTranscript(leadId);
      lesson = await summarizeLesson(kind, transcript);
    }
    if (!lesson) {
      log.info({ leadId, kind }, 'learning: no lesson generated, skipping');
      return;
    }

    const res = await fetch(`${cfg.url}/rest/v1/agent_learning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
      },
      body: JSON.stringify({ lead_id: leadId, outcome: kind, lesson }),
    });
    if (!res.ok) {
      log.warn({ leadId, kind, status: res.status }, 'learning: store failed');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log.warn({ leadId, err: msg }, 'learning: capture failed');
  }
}

/**
 * Carrega os aprendizados recentes para injetar no system prompt.
 * Retorna texto de bullets ou null.
 */
export async function loadLearningsForPrompt(limit = 8): Promise<string | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/agent_learning?select=outcome,lesson,created_at&order=created_at.desc&limit=${limit}`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as LearningRow[];
    if (rows.length === 0) return null;

    const wins = rows.filter((r) => r.outcome === 'vitoria');
    const rej = rows.filter((r) => r.outcome === 'rejeicao');
    const parts: string[] = [];
    if (wins.length > 0) {
      parts.push(
        'ABORDAGENS QUE JÁ FUNCIONARAM (segue estes padrões):',
        ...wins.map((w) => `- ${w.lesson}`),
      );
    }
    if (rej.length > 0) {
      parts.push(
        'PADRÕES QUE LEVARAM A REJEIÇÃO (evite, ajuste o tom):',
        ...rej.map((r) => `- ${r.lesson}`),
      );
    }
    return parts.join('\n');
  } catch {
    return null;
  }
}
