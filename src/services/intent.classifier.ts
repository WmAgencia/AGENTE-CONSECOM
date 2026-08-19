/**
 * Classificação de intenção das mensagens recebidas dos leads (VYNTRA).
 *
 * Duas camadas:
 *   1. Markdown emitido pelo agente: o system prompt manda a IA terminar toda
 *      resposta com `<!--INTENT:intencao-->`. Parsea aqui e é removido antes
 *      do envio/persistência (fonte principal, com contexto).
 *   2. Heurística determinística: usada quando o marker falta/falha. Cobre as
 *      variações naturais do português (com/sem acento, "não quero", "já
 *      temos", "pode retirar meu contato"...) com proteção contra falsos
 *      positivos (palavras isoladas como "não"/"obrigado"). É um FALLBACK —
 *      a decisão final (Kanban/campanha) sempre prioriza o marker da IA.
 *
 * A separação CAMPAIGN (disparo) x CONVERSA (IA) x KANBAN (estado comercial)
 * vive aqui: o plano emite SOMENTE a movimentação de status necessária.
 */

export type InboundIntent =
  | 'interesse'
  | 'duvida'
  | 'informacao'
  | 'reuniao'
  | 'orcamento'
  | 'sem_interesse'
  | 'encerrar'
  | 'responder_depois'
  | 'humano'
  | 'ambiguo';

export const VALID_INTENTS: InboundIntent[] = [
  'interesse',
  'duvida',
  'informacao',
  'reuniao',
  'orcamento',
  'sem_interesse',
  'encerrar',
  'ambiguo',
];

const INTENT_MARKER_RE = /<!--\s*INTENT:\s*([a-z_]+)\s*-->/i;

/** Extrai a intenção declarada pelo modelo em `<!--INTENT:x-->`. */
export function parseIntentMarker(response: string): InboundIntent | null {
  const m = response.match(INTENT_MARKER_RE);
  if (!m) return null;
  const value = m[1].toLowerCase();
  return VALID_INTENTS.includes(value as InboundIntent) ? (value as InboundIntent) : null;
}

/** Remove a linha de marker do texto final (envio/persistência limpos). */
export function stripIntentMarker(response: string): string {
  return response.replace(INTENT_MARKER_RE, '').trim();
}

/** Normaliza: minúsculas, remove acentos, colapsa espaços. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(needle: string, patterns: string[]): boolean {
  return patterns.some((p) => needle.includes(p));
}

// --- Sem interesse (uma recusa EXPLÍCITA de continuar/contratar) -------------
const SEM_INTERESSE = [
  'sem interesse',
  'seminteresse',
  'nao tenho interesse',
  'nao temos interesse',
  'nao estou interessado',
  'nao estou interessada',
  'nao estamos interessados',
  'nao quero',
  'nao queremos',
  'nao preciso',
  'nao precisamos',
  'nao vamos precisar',
  'nao vamos precisar do servico',
  'obrigado mas nao',
  'obrigada mas nao',
  'obrigado, mas nao',
  'ja temos',
  'ja tenho',
  'ja contratamos',
  'ja utilizamos',
  'pode retirar meu contato',
  'pode retirar meu numero',
  'tira meu contato',
  'retire meu contato',
  'pode tirar meu contato',
  'nao quero mais receber',
  'nao quero mais',
  'sem interesse no momento',
  'por favor remova',
  'remova meu numero',
];

// --- Reunião / agendamento ---------------------------------------------------
const REUNIAO_VERBS = ['marcar', 'agendar', 'marca uma', 'agenda', 'quisermos', 'gostaria de marcar', 'podemos marcar', 'vamos marcar', 'marcar'];
const REUNIAO_SIGNAL = ['reuniao', 'videochamada', 'videoconferencia', 'horario', 'chamada'];

// --- Pedidos comerciais ------------------------------------------------------
const ORCAMENTO = [
  'orcamento',
  'orçamento',
  'quanto custa',
  'qual o valor',
  'qual o preco',
  'preco',
  'tabela de preco',
  'proposta comercial',
  'valores',
  'pacotes',
];

const INFORMACAO = [
  'me explica',
  'explica melhor',
  'pode me explicar',
  'poderia me explicar',
  'como funciona',
  'quero saber mais',
  'gostaria de saber',
  'saber mais',
  'mais informacoes',
  'informacoes',
  'detalhes',
  'fale mais',
  'o que e',
  'conte mais',
];

const INTERESSE = [
  'tenho interesse',
  'estou interessado',
  'estou interessada',
  'estamos interessados',
  'tenho interesse no momento',
  'quero contratar',
  'quero fechar',
  'gostei',
  'parece otimo',
  'quero conhecer',
  'quero saber como contrata',
];

const DUVIDA = [
  'tenho uma duvida',
  'minha duvida',
  'nao entendi',
  'pode esclarecer',
  'esclarece',
  'me tira uma duvida',
];

const ENCERRAR = [
  'era so isso',
  'era so',
  'so isso',
  'obrigado pelo contato',
  'obrigada pelo contato',
  'pode encerrar',
  'encerrar a conversa',
  'encerrar conversa',
];

// --- Responder depois / falar depois (contato futuro) -------------------------
const RESPONDER_DEPOIS = [
  'falar comigo amanha',
  'falar comigo depois',
  'fala comigo amanha',
  'fala comigo depois',
  'fale comigo amanha',
  'fale comigo depois',
  'me chama amanha',
  'me chame amanha',
  'me chama depois',
  'me chame depois',
  'me lembra amanha',
  'me avisa amanha',
  'amanha eu te respondo',
  'amanha eu respondo',
  'depois eu te respondo',
  'depois eu respondo',
  'te respondo depois',
  'respondo mais tarde',
  'amanha te respondo',
  'volto a falar depois',
  'volto a falar mais tarde',
  'vamos falar depois',
  'me procure depois',
  'me procura depois',
  'pode falar amanha',
  'pode me chamar amanha',
  'pode me chamar depois',
  'me contata depois',
  'me chama mais tarde',
  'falo com voce amanha',
  'falo com voce depois',
  'mais tarde',
  'nao posso responder agora',
  'nao posso agora',
  'agora nao posso',
  'estou ocupado agora',
  'me manda depois',
  'me mande depois',
  'manda depois',
  'pode mandar depois',
  'me chama mais tarde hoje',
  'depois eu falo com voce',
  'depois eu falo',
];

// --- Falar com humano / pessoa real ------------------------------------------
const HUMANO = [
  'quero falar com uma pessoa',
  'quero falar com humano',
  'falar com um humano',
  'falar com uma pessoa',
  'quero falar com alguem',
  'atendente',
  'quero atendimento humano',
  'me passa um atendente',
  'pode me transferir para um atendente',
  'quero falar com o responsavel',
  'quero falar com um vendedor',
  'falar com o vendedor',
  'quero falar com alguem de verdade',
  'voce e uma maquina quero humano',
  'pode me passar para um humano',
];

export interface HeuristicResult {
  intent: InboundIntent;
  /** confiança qualitativa: high somente para sinais inequívocos. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Classifica a mensagem do lead por heurística (fallback do marker da IA).
 * Nunca lança. Retorna null sem alto sinal -> "ambiguo".
 */
export function classifyIntentHeuristic(text: string): HeuristicResult | null {
  const n = normalize(text);
  if (!n) return null;

  // Primeiro os sinais que IMPEDEM recusa parcial com "mas".
  // Ex.: "não tenho interesse em X, mas gostei..." => não classifica recusa
  // imediata quando existe um "mas"/"porém" de continuidade.
  const hasContinuation = /(mas|porém|porem|so que|só que)\s/.test(n);

  if (!hasContinuation && hasAny(n, SEM_INTERESSE)) {
    return { intent: 'sem_interesse', confidence: 'high' };
  }

  // "Amanhã/depois eu respondo" — contato futuro explícito.
  if (hasAny(n, RESPONDER_DEPOIS)) {
    return { intent: 'responder_depois', confidence: 'high' };
  }

  // Pedido explícito por atendimento humano.
  if (hasAny(n, HUMANO)) {
    return { intent: 'humano', confidence: 'high' };
  }

  if (hasAny(n, REUNIAO_SIGNAL) && hasAny(n, REUNIAO_VERBS)) {
    return { intent: 'reuniao', confidence: 'high' };
  }

  if (hasAny(n, ORCAMENTO)) return { intent: 'orcamento', confidence: 'medium' };
  if (hasAny(n, INFORMACAO)) return { intent: 'informacao', confidence: 'medium' };
  if (hasAny(n, INTERESSE)) return { intent: 'interesse', confidence: 'medium' };
  if (hasAny(n, DUVIDA)) return { intent: 'duvida', confidence: 'medium' };
  if (hasAny(n, ENCERRAR)) return { intent: 'encerrar', confidence: 'low' };

  return null;
}

// ---------------------------------------------------------------------------
// PLANO DE AÇÃO: como o identifica a intenção vira movimentação (Kanban +
// campanha) SEM misturar os dois sistemas.
// ---------------------------------------------------------------------------

export interface InboundPlan {
  intent: InboundIntent;
  /** Status que o lead deve assumir no Kanban (undefined = manter). */
  nextStatus?: 'conversando' | 'sem_interesse' | 'responder_depois';
  /** true quando a campanha do lead deve ser interrompida. */
  stopCampaign: boolean;
}

/**
 * Decide a ação sobre o LEAD dado o status atual e a intenção detectada.
 * - sem_interesse  => move para "sem_interesse" + interrompe a campanha do lead.
 * - primeiro retorno de funil => "conversando".
 * - demais intenções => mantém o status (a conversa continua; campanha segue
 *   o fluxo normal — campanha ≠ conversa).
 * - estados que já não recebem IA (ex.: fechado/nao_fechado) => nenhuma ação.
 */
export function planInbound(
  leadStatus: string | null | undefined,
  intent: InboundIntent,
): InboundPlan {
  const status = leadStatus ? String(leadStatus) : '';

  if (intent === 'sem_interesse') {
    return { intent, nextStatus: 'sem_interesse', stopCampaign: true };
  }

  if (intent === 'responder_depois') {
    return { intent, nextStatus: 'responder_depois', stopCampaign: false };
  }

  // Reunião marcada: só rebaixa para "conversando" se NÃO estiver em reunião.
  if (
    intent === 'reuniao' &&
    (status === 'reuniao_marcada' || status === 'reuniao_cancelada')
  ) {
    return { intent, nextStatus: undefined, stopCampaign: false };
  }

  return { intent, nextStatus: undefined, stopCampaign: false };
}