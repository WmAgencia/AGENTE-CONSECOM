/**
 * Processador assíncrono da Memória Comercial.
 *
 * Após o upload (que já persiste as conversas no Supabase), este módulo roda em
 * background: para cada conversa importada, chama a análise com a NVIDIA,
 * grava os aprendizados extraídos e atualiza o lote. Nunca aplica nada
 * automaticamente no agente (status dos aprendizados = "identificado").
 */
import { getLogger } from '../utils/logger.js';
import { analyzeTranscript } from './memory.analyze.js';
import {
  getConversationsByImport,
  updateImportRow,
  updateConversationRow,
  bulkCreateLearnings,
  type MemoryConversationFullRow,
} from './memory.service.js';

function nowIso(): string {
  return new Date().toISOString();
}

/** Heurística de desfecho comercial da conversa (só para o dashboard). */
export function inferConversationOutcome(
  transcript: Array<{ role: 'agente' | 'lead'; text: string }>,
): string | null {
  const leadText = transcript
    .filter((m) => m.role === 'lead')
    .map((m) => m.text.toLowerCase())
    .join('\n');
  const full = transcript.map((m) => m.text.toLowerCase()).join('\n');

  const notInterestedRe = /(não quero|nao quero|sem interesse|não preciso|nao preciso|não tenho interesse|nao tenho interesse|obrigado pela atenção|estou sem tempo)/;
  const meetingRe = /(reunião|reuniao|agendar|marcar|podemos nos falar|pode ser (amanhã|hoje|terça|quarta|quinta|sexta)|vamos falar|vou agendar|pode agendar|ok, pode|aceit(o|ei)|topo|bora|pode ser às|pode ser as)/;
  const interestRe = /(interess\w+|quero saber|orçamento|orcamento|quanto custa|valor|investi\w+|quero contratar|como funciona)/;

  if (meetingRe.test(full)) return 'reuniao';
  if (notInterestedRe.test(leadText)) return 'sem_interesse';
  if (interestRe.test(leadText)) return 'interesse';
  return null;
}

/**
 * Processa todas as conversas de um lote em background. Idempotente por
 * status: conversas já 'processed' são ignoradas.
 */
export async function processImportInBackground(importId: string, userId: string): Promise<void> {
  const log = getLogger();
  const conversations: MemoryConversationFullRow[] = await getConversationsByImport(importId, userId);
  if (conversations.length === 0) {
    await updateImportRow(importId, {
      status: 'done',
      conversations_processed: 0,
      learnings_generated: 0,
      failures: 0,
      finished_at: nowIso(),
    });
    return;
  }

  log.info({ importId, conversations: conversations.length }, 'memory: processing import');

  let processed = 0;
  let learningsCreated = 0;
  let failures = 0;

  for (const conv of conversations) {
    if (conv.status === 'processed') {
      processed++;
      continue;
    }
    try {
      await updateConversationRow(conv.id, { status: 'processing' });

      const transcriptLines = (conv.transcript ?? [])
        .map((m) => `${m.role === 'agente' ? 'Agente' : 'Lead'}: ${m.text}`)
        .filter((l) => l.trim().length > 0)
        .join('\n')
        .slice(0, 60_000);

      const extracted = await analyzeTranscript(transcriptLines);

      if (extracted.length > 0) {
        const n = await bulkCreateLearnings(
          userId,
          extracted.map((learning) => ({ importId, conversationId: conv.id, learning })),
        );
        learningsCreated += n;
      }

      await updateConversationRow(conv.id, {
        status: 'processed',
        processed_at: nowIso(),
        outcome: inferConversationOutcome(conv.transcript ?? []),
      });
      processed++;
      log.info(
        { conversationId: conv.id, extracted: extracted.length, stored: extracted.length },
        'memory: conversation processed',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      failures++;
      log.warn({ conversationId: conv.id, errMessage: message }, 'memory: conversation failed');
      await updateConversationRow(conv.id, {
        status: 'failed',
        error_message: message.slice(0, 200),
      });
    }
  }

  const status = failures === conversations.length ? 'failed' : 'done';
  await updateImportRow(importId, {
    status,
    conversations_processed: processed,
    learnings_generated: learningsCreated,
    failures,
    error_message: failures === conversations.length ? 'all conversations failed' : null,
    finished_at: nowIso(),
  });
  log.info({ importId, processed, learningsCreated, failures, status }, 'memory: import finished');
}

/** Simples fila em memória para evitar sobreposição de processamentos pesados. */
let activeImports = new Set<string>();

export function isImportPending(importId: string): boolean {
  return activeImports.has(importId);
}

export function startImportBackground(importId: string, userId: string): void {
  if (activeImports.has(importId)) return;
  activeImports.add(importId);
  void processImportInBackground(importId, userId)
    .catch((err) => {
      getLogger().warn(
        { errMessage: err instanceof Error ? err.message : 'unknown' },
        'memory: background import crashed',
      );
    })
    .finally(() => {
      activeImports.delete(importId);
    });
}