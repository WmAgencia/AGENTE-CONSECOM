/**
 * Consecom agent service with a real agent loop.
 *
 * Pipeline:
 *   1. Build OpenAI-style message list (system + history + user).
 *   2. POST to NVIDIA NIM chat/completions with `tools` when enabled and
 *      supported by the model.
 *   3. If the model returns `tool_calls`, execute each via the tool
 *      registry, append results as role:"tool", and re-call the model.
 *   4. Loop up to AGENT_MAX_ITERATIONS or until the model returns a
 *      plain assistant message (no tool_calls).
 *   5. Return the final assistant content + diagnostics.
 *
 * Compatibility:
 *   - The legacy `runAgent(task)` signature is preserved; it delegates to
 *     `runAgentLoop({ task, conversationId, source })` with conversationId
 *     undefined and tools disabled, so existing callers (webhook.ts) keep
 *     their existing behavior unless explicitly upgraded.
 *
 * Security:
 *   - Secrets (NVIDIA_API_KEY) never appear in the model's context.
 *   - Tool execution goes through the registry's permission gate.
 *   - Each tool call has a soft deadline (AGENT_TOOL_TIMEOUT_MS).
 */
import { getEnv, getNvidiaApiKey } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import type { AgentResponse } from '../types.js';
import {
  getDefaultRegistry,
  type ToolCallContext,
} from '../tools/registry.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: Role;
  content: string;
  /** Present only on assistant messages that requested tools. */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** Present only on role:"tool" messages. */
  tool_call_id?: string;
}

interface NvidiaChatResponseChoice {
  message?: {
    role?: Role;
    content?: string | null;
    tool_calls?: ChatMessage['tool_calls'];
  };
  finish_reason?: string;
}

interface NvidiaChatResponse {
  choices?: NvidiaChatResponseChoice[];
  error?: { message?: string };
}

interface RunAgentLoopInput {
  task: string;
  conversationId?: string;
  source?: 'http' | 'whatsapp' | 'internal';
  history?: ChatMessage[];
  /** Optional site-provided rules/guidelines injected into the system prompt. */
  directives?: string;
  /** Optional auto-trained patterns injected into the system prompt. */
  learnings?: string;
  /** Optional commercial memory (padrões validados de conversas reais). */
  commercialMemory?: string;
  /** Evolution instance name (when known) passed to tools for per-user config. */
  instance?: string;
  /** Contexto do lead (nome/nicho/telefone) para personalizar a resposta. */
  leadContext?: string;
  /** Estratégia de abordagem vinculada ao lead (estilo a seguir). */
  strategyDirective?: string;
  /** Sobrescreve AGENT_ENABLE_TOOLS (ex: simulação de fluxo = false). */
  enableTools?: boolean;
  /**
   * Sobrescreve o system prompt padrão (ex.: Chat de Treinamento, onde a IA
   * interpreta a PERSONA DO CLIENTE e não o agente comercial).
   */
  systemPromptOverride?: string;
}

export interface RunAgentLoopResult extends AgentResponse {
  iterations: number;
  toolCalls: number;
  usedTools: boolean;
}

/**
 * Playbook de vendas embutido no system prompt (todas as etapas do funil).
 * Baseado em práticas consolidadas: SPIN Selling, AIDA, PAS, BANT e os
 * 7 estágios do funil B2B (prospecção, qualificação, descoberta, apresentação,
 * objeções, proposta, fechamento) adaptados para conversa de WhatsApp.
 */
const SALES_PLAYBOOK = [
  '=== SALES PLAYBOOK: como conduzir TODA a venda (siga sempre) ===',
  'Você é a MELHOR vendedora do mercado. Conduza a conversa por estágios, um passo de cada vez, sem pular etapas e sem pressão.',
  '1) ABERTURA (atração): nos primeiros 2-3 turnos, conecte-se ao lead. Use o contexto do lead (nicho/negócio) para mostrar que entende o problema dele. NUNCA comece com pitch genérico de empresa. Objetivo: gerar confiança e o lead querer continuar.',
  '2) QUALIFICAÇÃO (BANT leve): descubra, em perguntas curtas e naturais (máx. 1 pergunta por mensagem), se o lead tem (B) budget, (A) autoridade para decidir, (N) necessidade real e (T) tempo/urgência. Não vire interrogatório: cada pergunta deve fluir como conversa.',
  '3) DESCOBERTA (SPIN): faça perguntas na ordem S (situação atual) → P (problema) → I (implicação: o que isso custa em dinheiro/tempo) → N (need-payoff: o que resolver o problema valeria). Ouça mais do que fale. Faça o lead perceber o próprio problema e o valor da solução.',
  '4) APRESENTAÇÃO (benefícios, não features): mostre a solução amarrada ao que o lead acabou de dizer. Use AIDA quando útil: Atenção → Interesse → Desejo (prova/social proof com números) → Ação. Nunca liste recursos; mostre o resultado.',
  '5) OBJEÇÕES: objeção não é rejeição, é pedido de mais informação. Trate como algo normal: (a) acolha, (b) diagnostique o motivo real, (c) responda com prova/evidência, (d) reconfirme o próximo passo. Para "caro", relembre o valor/implicação que o próprio lead descreveu e ofereça caminho.',
  '6) FECHAMENTO: quando o lead estiver quente, seja específico. Proponha um próximo passo concreto (reunião com data/hora) e use o critério de urgência real, nunca pressão falsa. Peça a decisão diretamente e com naturalidade.',
  '7) ACOMPANHAMENTO: se o lead não respondeu, reforce valor com um novo ângulo (não repita o mesmo texto). No WhatsApp: mensagens curtas (2-4 frases), uma pergunta/pedido por vez, tom consultivo e humano.',
  'REGRAS DE TOM: fale português claro e natural; mensagens curtas para WhatsApp; personalizar sempre (use nome/nicho do lead quando souber); ser consultora confiável, nunca vendedora agressiva; avançar a conversa rumo a marcar uma reunião.',
].join(' ');


function buildSystemPrompt(opts: {
  useReactFallback: boolean;
  toolNames: string[];
  directives?: string;
  learnings?: string;
  commercialMemory?: string;
  leadContext?: string;
  strategyDirective?: string;
  injectIntentMarker?: boolean;
}): string {
  const agoraBrasilia = new Date(Date.now() - 3 * 3600_000);
  const dataAtual = agoraBrasilia.toISOString().slice(0, 10);
  const horaAtual = agoraBrasilia.toISOString().slice(11, 16);
const base = [
    'You are the developer of Consecom, a focused autonomous prospecting agent that follows up with business owners on WhatsApp.',
    'When you have enough information, answer concisely in plain text.',
    'Never reveal API keys, tokens, or secrets.',
    'Always follow the greeting, personality, tone and business rules sent in the PROSPECTION DIRECTIVES below.',
    `Today is ${dataAtual} (YYYY-MM-DD) and the current time is ${horaAtual} in Brasilia (UTC-3). When the prospect mentions "hoje", "amanha", "depois de amanha" or any relative date, ALWAYS resolve it against this exact date.`,
    'Never end a turn by promising to check or return something and then stopping. Every reply must be complete.',
    'Be FAST and decisive. Your goal is to build rapport, answer questions about the service, and move the conversation toward scheduling a meeting.',
    'BOOKING RULE: NEVER schedule a meeting on your own and NEVER invent an agreement. First ask the prospect when they are available and offer the closest options (e.g. "hoje 14h, amanhã 10h ou 15h"). Only call marcar_reuniao AFTER the prospect explicitly chooses a date AND time in their own words. IMPORTANT: the marcar_reuniao tool has a GUARD that checks the conversation for the prospect\'s explicit acceptance — if there is no evidence, it will fail and you must go back to asking for availability. Never announce "reunião confirmada" unless the tool returned ok=true.',
    'SIGNATURE RULE: NEVER sign your messages. Do not end any message with a name, a dash, or any signature like "– Alex", "- Alex", "Alex" or "Att.". The opening greeting is added automatically as "*Alex*" — you only write the body text.',
    'If the prospect declines or goes quiet, do not insist or spam. Respond gracefully and stop. A single objection (e.g. "não quero tráfego pago" or "está caro") is NOT a refusal: address it per the SALES_PLAYBOOK objections step and keep the conversation moving toward a meeting.',
    'OUTCOME RULE: when the prospect clearly refuses/interrupts or says they are not interested, call finalizar_sem_interesse with the lead id (when known) or phone and outcome="sem_interesse" in the SAME turn, then reply gracefully and stop. When the prospect cancels an already-scheduled meeting, call finalizar_sem_interesse with outcome="reuniao_cancelada" and a short motive.',
  ];
  base.push(SALES_PLAYBOOK);
  if (opts.injectIntentMarker) {
    base.push(
      'INTENT MARKER RULE (mandatory on WhatsApp): you must END your reply with a single exact line: <!--INTENT:intencao-->',
      'Choose EXACTLY one of: interesse, duvida, informacao, reuniao, orcamento, sem_interesse, encerrar, ambiguo.',
      'Meaning: sem_interesse = the prospect clearly refused/interrupted; reuniao = asked for or agreed to schedule a meeting;',
      'encerrar = politely ended the conversation; ambiguo = cannot classify. That line is processed by the system and',
      'automatically removed before sending — never write it as part of the message body.',
    );
  }
  if (opts.leadContext) {
    base.push(
      '=== LEAD (dados que VOCE tem sobre este cliente; use para personalizar e NUNCA peça o que ja tem) ===',
      opts.leadContext,
      '=== FIM DO LEAD ===',
    );
  }
  if (opts.strategyDirective) {
    base.push(
      '=== ESTRATÉGIA DE ABORDAGEM (siga este estilo nesta conversa) ===',
      opts.strategyDirective,
      '=== FIM DA ESTRATÉGIA ===',
    );
  }
  if (opts.directives) {
    base.push(
      '=== PROSPECTION DIRECTIVES (always follow these rules) ===',
      opts.directives,
      '=== END OF PROSPECTION DIRECTIVES ===',
    );
  }
  if (opts.commercialMemory) {
    base.push(
      '=== MEMÓRIA COMERCIAL ===',
      opts.commercialMemory,
      '=== FIM DA MEMÓRIA COMERCIAL ===',
    );
  }
  if (opts.learnings) {
    base.push(
      '=== AUTO-TREINO: padrões aprendidos com conversas reais ===',
      opts.learnings,
      'Use these to refine your approach, tone and arguments. They come from past wins/rejections.',
    );
  }
  if (opts.useReactFallback && opts.toolNames.length > 0) {
    base.push(
      'To call a tool, emit on its own line a tag like:',
      '<tool name="tool.name" args=\'{"key":"value"}\'/>',
      'Available tools: ' + opts.toolNames.join(', ') + '.',
      'After the tool executes, you will see its result in the next user',
      'message as <tool_result>...</tool_result>. Then continue reasoning',
      'or finish your answer in plain text.',
    );
  }
  return base.join(' ');
}

function modelSupportsToolsCached(): boolean | null {
  const v = getEnv().AGENT_MODEL_SUPPORTS_TOOLS;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null; // 'auto' -> detect on first error
}

let supportsToolsCache: boolean | null | undefined = undefined;

function getSupportsTools(): boolean | null {
  if (supportsToolsCache === undefined) {
    supportsToolsCache = modelSupportsToolsCached();
  }
  return supportsToolsCache;
}

function setSupportsTools(v: boolean): void {
  supportsToolsCache = v;
}

/**
 * ReAct fallback parser. Detects tool invocation tags emitted by the model
 * when the backend does not support OpenAI-style function calling.
 *
 * Recognized form (one per line, validated):
 *   <tool name="tool.name" args='{"key":"value"}'/>
 *   <tool name="tool.name"/>
 *
 * Returns the first match; we only execute one ReAct tool per iteration
 * to keep behavior predictable and traceable.
 */
/**
 * Heuristic for "I'll check in a moment" answers that the model produces when
 * it intends to run a tool but ends the turn without calling it. Matches the
 * common Portuguese/English phrasings seen in this assistant's replies.
 */
const PROMISE_RE =
  /\b(vou verificar|vou consultar|vou checar|vou ver|deixa eu verificar|deixe-me verificar|um momento|aguarde|já verifico|ja verifico|verificarei|vou dar uma olhada|let me check|i will check|one moment|checking now|give me a moment)\b/i;

function parseReactToolCall(
  text: string,
): { name: string; args: Record<string, unknown> } | null {
  const re = /<tool\s+name="([a-zA-Z0-9_.-]+)"(?:\s+args='([^']*)')?\s*\/>/;
  const m = text.match(re);
  if (!m) return null;
  const name = m[1];
  let args: Record<string, unknown> = {};
  if (m[2]) {
    try {
      args = JSON.parse(m[2]) as Record<string, unknown>;
    } catch {
      // malformed args; pass empty obj
    }
  }
  return { name, args };
}

/**
 * Builds the recent-transcript slice passed to tools via ToolCallContext.
 * Drops the system prompt (never relevant to tool gates) and flattens
 * assistant tool_call scaffolds (content may be empty) into plain turns.
 */
function toolCallHistory(
  messageLog: ChatMessage[],
): Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> {
  return messageLog
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant' | 'tool',
      content: typeof m.content === 'string' ? m.content : '',
    }));
}

/**
 * Main agent entrypoint used by routes.
 */
export async function runAgentLoop(
  input: RunAgentLoopInput,
): Promise<RunAgentLoopResult> {
  const env = getEnv();
  const log = getLogger();
  const start = Date.now();
  const source = input.source ?? 'http';

  log.info(
    {
      taskLength: input.task.length,
      conversationId: input.conversationId,
      source,
      toolsEnabled: env.AGENT_ENABLE_TOOLS,
    },
    'agent: starting loop',
  );

  const registry = (() => {
    try {
      return getDefaultRegistry();
    } catch {
      return null;
    }
  })();

  const useToolsFromEnv = env.AGENT_ENABLE_TOOLS === true;
  const wantTools = (input.enableTools ?? useToolsFromEnv) && registry?.isEnabled() === true;
  const toolNames = registry ? registry.list().map((t) => t.definition.name) : [];

  // sendTools / useReactFallback are recomputed per-iteration to react to
  // supportsToolsCache changes (the first iteration may auto-detect the
  // model's lack of function-calling support and flip the cache to false).
  let toolTriedAndRetried = false;

  const messageLog: ChatMessage[] = [];
  messageLog.push({
    role: 'system',
    content: input.systemPromptOverride
      ? input.systemPromptOverride
      : buildSystemPrompt({
          useReactFallback: false,
          toolNames,
          directives: input.directives,
          learnings: input.learnings,
          commercialMemory: input.commercialMemory,
          leadContext: input.leadContext,
          strategyDirective: input.strategyDirective,
          injectIntentMarker: source === 'whatsapp',
        }),
  });
  if (input.history && input.history.length > 0) {
    messageLog.push(...input.history);
  }
  messageLog.push({ role: 'user', content: input.task });

  let iterations = 0;
  let toolCallsTotal = 0;
  let finalAssistantContent = '';

  for (let i = 0; i < env.AGENT_MAX_ITERATIONS; i++) {
    iterations = i + 1;

    const supportsTools = getSupportsTools();
    let sendTools = wantTools && supportsTools !== false;
    const useReactFallback = wantTools && supportsTools === false;

    // When fallback mode flips mid-loop, refresh the system prompt so the
    // model learns the ReAct convention. (Cheap; caps at AGENT_MAX_ITERATIONS.)
    if (useReactFallback && messageLog[0]?.role === 'system') {
      messageLog[0].content = input.systemPromptOverride
        ? input.systemPromptOverride
        : buildSystemPrompt({
            useReactFallback: true,
            toolNames,
            directives: input.directives,
            learnings: input.learnings,
            commercialMemory: input.commercialMemory,
            leadContext: input.leadContext,
            strategyDirective: input.strategyDirective,
            injectIntentMarker: source === 'whatsapp',
          });
    }

    const body: Record<string, unknown> = {
      model: env.AGENT_MODEL,
      messages: messageLog,
      max_tokens: env.AGENT_MAX_TOKENS,
      temperature: 0.2,
      top_p: 0.7,
      stream: false,
    };
    if (sendTools && registry) {
      body.tools = registry.toOpenAITools();
      // Don't force tool choice; let the model decide.
    }

    let parsed: NvidiaChatResponse;
    let rawStatus = 0;
    let rawText = '';

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
        // Heuristic: if we sent tools and the API rejects the request
        // with a 400 mentioning tools/functions, cache "unsupported"
        // and retry once without tools on the same iteration.
        const looksLikeToolsError =
          sendTools &&
          rawStatus === 400 &&
          /(tool|function|not support)/i.test(rawText);
        log.error(
          {
            status: rawStatus,
            model: env.AGENT_MODEL,
            endpoint: `${NVIDIA_BASE_URL}/chat/completions`,
            sendTools,
          },
          'agent: NVIDIA API returned non-OK status',
        );
        if (looksLikeToolsError && !toolTriedAndRetried) {
          setSupportsTools(false);
          toolTriedAndRetried = true;
          sendTools = false;
          log.warn('agent: tools rejected by model; retrying without tools');
          continue;
        }
        let apiErrorMessage: string | undefined;
        try {
          apiErrorMessage = (JSON.parse(rawText) as NvidiaChatResponse)
            .error?.message;
        } catch {
          // ignore
        }
        const err = new Error(
          `NVIDIA API request failed with status ${rawStatus}` +
            (apiErrorMessage ? `: ${apiErrorMessage}` : ''),
        );
        throw err;
      }

      parsed = JSON.parse(rawText) as NvidiaChatResponse;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NVIDIA API')) {
        throw err;
      }
      log.error(
        { errMessage: err instanceof Error ? err.message : 'unknown' },
        'agent: network/parse error',
      );
      throw new Error(
        `Agent execution failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }

    if (parsed.error) {
      throw new Error(`NVIDIA API error: ${parsed.error.message ?? 'unknown'}`);
    }

    const choice = parsed.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    let content = (choice?.message?.content ?? '').toString().trim();

    // ReAct fallback: scan content for <tool .../> and execute one.
    if (
      useReactFallback &&
      (!toolCalls || toolCalls.length === 0) &&
      content.includes('<tool ')
    ) {
      const parsedTool = parseReactToolCall(content);
      if (parsedTool) {
        toolCallsTotal++;
        messageLog.push({ role: 'assistant', content });

        const ctx: ToolCallContext = {
          conversationId: input.conversationId,
          source,
          deadlineMs: Date.now() + env.AGENT_TOOL_TIMEOUT_MS,
          instance: input.instance,
          history: toolCallHistory(messageLog),
        };

        log.info(
          { tool: parsedTool.name, mode: 'react', conversationId: input.conversationId },
          'agent: invoking tool',
        );

        let result;
        try {
          if (registry) {
            result = await Promise.race([
              registry.run(parsedTool.name, parsedTool.args, ctx),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('tool timeout')),
                  env.AGENT_TOOL_TIMEOUT_MS,
                ),
              ),
            ]);
          } else {
            result = {
              ok: false,
              output: 'Tool registry not initialized.',
              error: 'tool_disabled' as const,
            };
          }
        } catch (err) {
          result = {
            ok: false,
            output: err instanceof Error ? err.message : 'tool error',
            error: 'unknown' as const,
          };
        }

        log.info(
          {
            tool: parsedTool.name,
            ok: result.ok,
            outputLength: result.output.length,
            mode: 'react',
          },
          'agent: tool completed',
        );

        // Feed the tool result back to the model as a user turn wrapped
        // in <tool_result> tags so the ReAct convention is preserved.
        messageLog.push({
          role: 'user',
          content: `<tool_result tool="${parsedTool.name}" ok="${result.ok}">${result.output}</tool_result>`,
        });
        continue;
      }
      // tool tag malformed -> let the model finish as plain output
    }

    if (!toolCalls || toolCalls.length === 0) {
      // Terminal assistant turn
      finalAssistantContent =
        content ||
        '[no content returned by the model]';

      // Anti-promise guard: the model sometimes replies "vou verificar... um
      // momento" without actually calling a tool, ending the turn before the
      // real data is fetched. When that happens we do NOT accept the answer:
      // we push an explicit instruction to call the tool right now and loop
      // again, so availability/booking is resolved within this same request.
      const looksLikePromise = PROMISE_RE.test(content);
      const canUseTools = wantTools && registry?.isEnabled() === true;
      if (looksLikePromise && canUseTools && i < env.AGENT_MAX_ITERATIONS - 1) {
        log.warn(
          { content: content.slice(0, 200) },
          'agent: response promises to check without a tool call; forcing tool use',
        );
        messageLog.push({ role: 'assistant', content });
        messageLog.push({
          role: 'user',
          content:
            'You just said you would check/verify something but did not call any tool. ' +
            'Do not reply in prose. Call the required tool NOW (marcar_reuniao if the ' +
            'prospect agreed to a meeting) and wait for its result before answering. ' +
            'If the tool cannot run or there is nothing to schedule, answer naturally and stop.',
        });
        continue;
      }

      break;
    }

    // Append assistant turn (with tool_calls) to the log
    messageLog.push({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls,
    });

    // Execute each tool call and append its result
    for (const call of toolCalls) {
      toolCallsTotal++;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        // malformed arguments; pass empty
      }

      const ctx: ToolCallContext = {
        conversationId: input.conversationId,
        source,
        deadlineMs: Date.now() + env.AGENT_TOOL_TIMEOUT_MS,
        instance: input.instance,
        history: toolCallHistory(messageLog),
      };

      log.info(
        { tool: call.function.name, conversationId: input.conversationId },
        'agent: invoking tool',
      );

      let result;
      try {
        if (registry) {
          result = await Promise.race([
            registry.run(call.function.name, args, ctx),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('tool timeout')),
                env.AGENT_TOOL_TIMEOUT_MS,
              ),
            ),
          ]);
        } else {
          result = {
            ok: false,
            output: 'Tool registry not initialized.',
            error: 'tool_disabled' as const,
          };
        }
      } catch (err) {
        result = {
          ok: false,
          output: err instanceof Error ? err.message : 'tool error',
          error: 'unknown' as const,
        };
      }

      log.info(
        {
          tool: call.function.name,
          ok: result.ok,
          outputLength: result.output.length,
        },
        'agent: tool completed',
      );

      messageLog.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.output,
      });
    }
  }

  if (!finalAssistantContent) {
    finalAssistantContent =
      '[agent stopped: max iterations reached without a final answer]';
  }

  const latencyMs = Date.now() - start;
  log.info(
    { latencyMs, iterations, toolCalls: toolCallsTotal, conversationId: input.conversationId },
    'agent: loop completed',
  );

  return {
    task: input.task,
    result: finalAssistantContent,
    model: env.AGENT_MODEL,
    latencyMs,
    iterations,
    toolCalls: toolCallsTotal,
    usedTools: toolCallsTotal > 0,
  };
}

/**
 * Legacy single-shot entrypoint. Kept for backwards compatibility for
 * existing callers (webhook.ts). Equivalent to runAgentLoop with
 * tools disabled and no conversationId.
 */
export async function runAgent(task: string): Promise<AgentResponse> {
  return runAgentLoop({ task, source: 'internal' });
}
