import { getEnv, getNvidiaApiKey } from '../config/env.js';
import { shortenLeadName } from './lead-name.service.js';

const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

interface PersonalizationLead {
  name?: string | null;
  category?: string | null;
  niche?: string | null;
  city?: string | null;
  website?: string | null;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

const cache = new Map<string, string>();

function fallbackName(lead: PersonalizationLead): string {
  return shortenLeadName(lead.name || lead.niche || lead.category || '');
}

function isCleanDisplayName(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  return (
    value.length <= 60 &&
    words.length >= 1 &&
    words.length <= 3 &&
    !/[|•,;:/\\()[\]{}\d]/.test(value)
  );
}

/**
 * Resolve a forma de tratamento usada por {nome}/{nome_empresa}.
 * O resultado é curto e cacheado por lead para não chamar o modelo a cada etapa.
 */
export async function resolveCampaignLeadName(lead: PersonalizationLead): Promise<string> {
  const raw = String(lead.name ?? '').trim();
  const fallback = fallbackName(lead);
  if (!raw || raw === 'Sem nome') return fallback;
  // Nomes já limpos não precisam pagar o custo de uma chamada ao modelo.
  if (isCleanDisplayName(raw)) return fallback;

  const key = [raw, lead.category ?? '', lead.niche ?? '', lead.city ?? '', lead.website ?? ''].join('|');
  const cached = cache.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(NVIDIA_CHAT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getNvidiaApiKey()}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: getEnv().CAMPAIGN_AI_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'Você normaliza nomes para mensagens comerciais de WhatsApp.',
              'Decida se o valor é nome de pessoa ou nome de empresa.',
              'Pessoa: retorne somente o primeiro nome, ou os dois primeiros se forem necessários para distinguir.',
              'Empresa: retorne somente o nome comercial curto, sem CNPJ, endereço, cidade, categoria, emojis ou slogans.',
              'Retorne apenas o nome final, sem aspas, explicações ou pontuação extra. Máximo de 80 caracteres.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              nome_original: raw,
              categoria: lead.category ?? null,
              nicho: lead.niche ?? null,
              cidade: lead.city ?? null,
              possui_site: Boolean(lead.website),
            }),
          },
        ],
        max_tokens: 40,
        temperature: 0,
        top_p: 1,
        stream: false,
      }),
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as ChatResponse;
    const value = body.choices?.[0]?.message?.content?.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
    const resolved = value ? shortenLeadName(value) : fallback;
    if (resolved) cache.set(key, resolved);
    return resolved;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
