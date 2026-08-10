/**
 * Análise de conversas importadas para a Memória Comercial da IA.
 *
 * Envia o transcript (etiquetado Agente/Lead) para a NVIDIA NIM e pede um
 * conjunto estruturado de aprendizados comerciais por categoria. Nada é
 * aplicado automaticamente ao agente: o resultado vira linhas em
 * ai_memory_learnings (status "identificado") aguardando validação humana.
 *
 * O prompt é agnóstico de nomes e foca em PADRÕES com evidências, nunca em
 * dados pessoais/telefones.
 */
import { getEnv, getNvidiaApiKey } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export const LEARNING_CATEGORIES = [
  'communication_style',
  'opening_patterns',
  'discovery_questions',
  'value_proposition',
  'objection_handling',
  'meeting_transition',
  'follow_up_patterns',
  'successful_patterns',
  'unsuccessful_patterns',
  'common_objections',
  'conversation_patterns',
] as const;

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

export type Confidence = 'alta' | 'media' | 'baixa';
export type Performance = 'positivo' | 'negativo' | 'neutro';

export interface ExtractedLearning {
  category: LearningCategory;
  content: string;
  confidence: Confidence;
  performance: Performance;
  evidence: string[];
}

const CATEGORY_GUIDE = `
Categorias (use OBRIGATORIAMENTE estas): ${LEARNING_CATEGORIES.join(', ')}.
- communication_style: tom/estilo do vendedor que funciona (ou não) com o lead.
- opening_patterns: como o vendedor abre a conversa e o que gera resposta.
- discovery_questions: perguntas de descoberta que revelam necessidade/objetivo.
- value_proposition: como o valor/serviço é apresentado e o que convence.
- objection_handling: objeções do lead e como foram tratadas.
- meeting_transition: a condução até propor/aceitar a reunião.
- follow_up_patterns: reengajamento quando o lead não responde.
- successful_patterns: padrões que levaram a um sinal positivo (interesse/reunião/venda).
- unsuccessful_patterns: padrões que geraram recusa/desistência.
- common_objections: objeções recorrentes (frases reais do lead).
- conversation_patterns: estrutura/fluxo típico percebido na conversa.`;

const SYSTEM_PROMPT = `Você é um analista comercial especializado em aprender com conversas reais de WhatsApp
para melhorar a abordagem de um agente de vendas B2B.

Analise o transcript abaixo (cada linha etiquetada como "Agente" ou "Lead").
Extraia APRENDIZADOS ACIONÁVEIS: padrões concretos com evidência na conversa.
REGRAS:
- NUNCA invente. Só extraia o que estiver evidenciado no transcript.
- Não dê mais de 8 aprendizados por conversa.
- Cada aprendizado precisa de evidence = 1 a 3 trechos curtos (máx. 200 caracteres cada) copiados literalmente das mensagens.
- performance: "positivo" = o padrão levou a interesse/aceite/reunião/venda; "negativo" = levou a recusa/desistência; "neutro" = padrão de comportamento sem desfecho claro.
- confidence: "alta" = repetido ou decisivo; "media" = evidenciado; "baixa" = sugestivo sinal único.
- content: 1 frase objetiva, prescritiva, em português ("Ao X, fazer Y porque Z").
- Se não houver nenhum padrão relevante, retorne [] (array vazio).
- Reply SOMENTE com um JSON array válido, sem markdown, sem texto extra.
${CATEGORY_GUIDE}
Formato de cada item:
{"category":"<categoria>","content":"...","confidence":"alta|media|baixa","performance":"positivo|negativo|neutro","evidence":["trecho 1","trecho 2"]}`;

function extractJsonArray(raw: string): unknown[] {
  let text = raw.trim();
  // Remove fences markdown e texto solto ao redor do array.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeLearning(raw: unknown): ExtractedLearning | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const category = String(o.category ?? '');
  const content = String(o.content ?? '').trim();
  if (!LEARNING_CATEGORIES.includes(category as LearningCategory) || !content) return null;
  const confidence: Confidence = o.confidence === 'alta' || o.confidence === 'baixa' ? o.confidence : 'media';
  const performance: Performance = o.performance === 'positivo' || o.performance === 'negativo' ? o.performance : 'neutro';
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.map((e) => String(e).slice(0, 220)).filter(Boolean).slice(0, 3)
    : [];
  return {
    category: category as LearningCategory,
    content: content.slice(0, 400),
    confidence,
    performance,
    evidence: evidence.length > 0 ? evidence : [content.slice(0, 220)],
  };
}

/**
 * Extrai aprendizados de um transcript. Retorna [] se a análise falhar
 * (nunca lança — falha silenciosa, o lote registra a conversa como failed).
 */
export async function analyzeTranscript(transcriptLines: string): Promise<ExtractedLearning[]> {
  if (!getNvidiaApiKey() || !transcriptLines.trim()) return [];
  const env = getEnv();
  const log = getLogger();

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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcriptLines.slice(0, 60_000) },
        ],
        max_tokens: 1600,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'memory: analyze failed (non-ok)');
      return [];
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content ?? '';
    const list = extractJsonArray(reply);
    const cleaned = list
      .map(sanitizeLearning)
      .filter((l): l is ExtractedLearning => l !== null);
    // Dedup por category+content (normalizado)
    const seen = new Set<string>();
    const unique = cleaned.filter((l) => {
      const key = `${l.category}|${l.content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.slice(0, 12);
  } catch (err) {
    log.warn(
      { errMessage: err instanceof Error ? err.message : 'unknown' },
      'memory: analyze threw',
    );
    return [];
  }
}