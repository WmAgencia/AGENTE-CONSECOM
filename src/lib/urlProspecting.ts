/**
 * URL prospecting — extração flexível de (nome, telefone) a partir do HTML
 * de uma página. Arquitetura de "adapters": cada fonte (Google Maps, site
 * corporativo, diretório, WhatsApp, etc.) é tratada por heurísticas genéricas
 * e não por seletores fixos, para funcionar com páginas dinâmicas/múltiplas.
 *
 * Regras:
 *   - Nunca ignora CAPTCHA/login/anti-bot: se a página sinalizar bloqueio,
 *     retorna `blocked` e a UI avisa em português.
 *   - Extrai telefones de: links `tel:`, links `wa.me` / `api.whatsapp.com`,
 *     texto com padrão brasileiro (via classifyBrazilianPhone).
 *   - Associa um nome ao telefone quando o HTML traz um rótulo próximo
 *     (ancoragem de link, elemento de título ou texto de lista).
 */

import { classifyBrazilianPhone } from './phone.js';

export interface ProspectedContact {
  name: string;
  phone: string;
  phone_normalized: string | null;
  whatsapp: boolean;
  context?: string;
}

export interface ProspectResult {
  title: string;
  contacts: ProspectedContact[];
  blocked: 'captcha' | 'auth' | 'blocked' | 'not_found' | 'inaccessible' | null;
  reason?: string;
  httpStatus?: number;
  finalUrl?: string;
}

const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3MB de página
const FETCH_TIMEOUT_MS = 15000;

/** Sinais comuns de páginas protegidas por CAPTCHA/anti-bot. */
const CAPTCHA_SIGNALS = [
  'g-recaptcha',
  'hcaptcha',
  'cf-challenge',
  'cloudflare',
  'turnstile',
  'recaptcha',
  'captcha',
  'are you a human',
  'verify you are human',
];

/** Sinais de página que exige login/autorização. */
const AUTH_SIGNALS = [
  'sign in',
  'sign-in',
  'log in',
  'login',
  'access denied',
  'authentication required',
  '401',
  'permission denied',
];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    // Elementos de bloco viram quebras de linha (para separar contatos).
    .replace(/<\/(?:li|p|div|section|article|tr|h[1-6]|ul|ol|br|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return n > 0 && n < 65536 ? String.fromCharCode(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza um telefone encontrado em URL (tel:/wa.me) para dígitos puros. */
function digitsFromLink(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Extrai um nome provável a partir do contexto ao redor de uma posição do HTML
 * (procura o heading precedente mais próximo, senão adivinha do texto).
 */
function contextName(html: string, position: number): string | null {
  const start = Math.max(0, position - 1200);
  const windowHtml = html.slice(start, position);
  // Procura o último heading (h1-h6) antes da posição.
  const headingRegex = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let lastHeading: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(windowHtml)) !== null) {
    const text = decodeEntities(stripTags(m[1])).trim();
    if (text && text.length > 1) lastHeading = text;
  }
  if (lastHeading) return lastHeading;
  // Senão, adivinha do texto do bloco (remove atributos e tags).
  const text = stripTags(windowHtml);
  return guessName(text);
}

/**
 * Extrai telefones de links tel: e wa.me / api.whatsapp.com, retornando a
 * posição do match para associação de nome por contexto.
 */
function collectLinkMatches(html: string): Array<{
  digits: string;
  whatsapp: boolean;
  label: string;
  position: number;
}> {
  const out: Array<{ digits: string; whatsapp: boolean; label: string; position: number }> = [];
  const patterns: Array<{ re: RegExp; whatsapp: boolean }> = [
    { re: /<a[^>]*href=["']tel:([^"'<>]+)["'][^>]*>([\s\S]*?)<\/a>/gi, whatsapp: false },
    { re: /<a[^>]*href=["'](?:https?:)?\/\/wa\.me\/([0-9+()\s-]+)[^"'<>]*["'][^>]*>([\s\S]*?)<\/a>/gi, whatsapp: true },
    { re: /<a[^>]*href=["'](?:https?:)?\/\/api\.whatsapp\.com\/send\?phone=([0-9+()\s-]+)[^"'<>]*["'][^>]*>([\s\S]*?)<\/a>/gi, whatsapp: true },
  ];
  for (const { re, whatsapp } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const digits = digitsFromLink(m[1]);
      if (digits.length >= 10) {
        out.push({
          digits,
          whatsapp,
          label: decodeEntities(stripTags(m[2] ?? '')).trim().slice(0, 120) || m[1].trim(),
          position: m.index,
        });
      }
    }
  }
  return out;
}

/** Extrai nomes prováveis (palavras capitalizadas, sem dígitos de telefone). */
function guessName(block: string): string | null {
  const withoutPhone = block.replace(/\+?[\d\s().-]{8,}/g, ' ');
  const words = withoutPhone
    .split(/[\n,;|•·\t]/)
    .map((w) => w.trim())
    .filter(Boolean);
  for (const chunk of words) {
    let clean = chunk.replace(/^[\s\-—•*]+|[\s\-—•*]+$/g, '').trim();
    clean = clean.replace(/^[-–—]+|[-–—]+$/g, '').trim();
    if (!clean || clean.length < 3 || clean.length > 80) continue;
    // Nome = ao menos 2 palavras capitalizadas sem ser email/url.
    if (/^[\wÀ-ÿ ]+$/.test(clean) && /^[A-ZÀ-Ý]/.test(clean) && clean.split(/\s+/).length >= 2) {
      return clean;
    }
  }
  return null;
}

/**
 * Detecta bloqueio (CAPTCHA/login/anti-bot) a partir do conteúdo e da URL.
 */
export function detectBlocked(
  title: string,
  text: string,
  lowerUrl: string,
): 'captcha' | 'auth' | 'blocked' | null {
  const sample = `${title}\n${text}`.slice(0, 12000).toLowerCase();
  if (CAPTCHA_SIGNALS.some((s) => sample.includes(s))) return 'captcha';
  if (/captcha|hcaptcha|recaptcha|turnstile/i.test(lowerUrl)) return 'captcha';
  if (AUTH_SIGNALS.some((s) => sample.includes(s)) && /login|auth/i.test(lowerUrl)) {
    return 'auth';
  }
  if (
    sample.includes('access denied') ||
    sample.includes('blocked') ||
    sample.includes('not allowed') ||
    sample.includes('request blocked')
  ) {
    return 'blocked';
  }
  return null;
}

/**
 * Pipeline principal: dado o HTML de uma página, extrai contatos com melhor
 * esforço, desduplica por telefone normalizado + nome e sinaliza bloqueio.
 */
export function prospectFromHtml(
  html: string,
  url: string,
): ProspectResult {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : '';

  const text = stripTags(html);

  const blocked = detectBlocked(title, text, url);
  if (blocked) {
    return { title, contacts: [], blocked, reason: blocked };
  }

  const contacts: ProspectedContact[] = [];
  const seen = new Map<string, ProspectedContact>(); // e164|name

  const pushContact = (
    rawPhone: string,
    nameGuess: string | null,
    whatsapp: boolean,
    context?: string,
  ) => {
    const info = classifyBrazilianPhone(rawPhone);
    if (info.class === 'INVALID') return;
    const normalized = info.e164!;
    const name = (nameGuess ?? context ?? 'Sem nome').slice(0, 200);
    const key = `${normalized}|${name}`;
    if (seen.has(key)) return;
    const contact: ProspectedContact = {
      name,
      phone: rawPhone.replace(/[^\d+]/g, ''),
      phone_normalized: normalized,
      whatsapp,
      context,
    };
    seen.set(key, contact);
    contacts.push(contact);
  };

  // 1) Links tel:/wa.me com nome inferido do contexto (heading precedente).
  const linkMatches = collectLinkMatches(html);
  for (const link of linkMatches) {
    const nameGuess = contextName(html, link.position) ?? (link.label ? null : null);
    pushContact(link.digits, nameGuess, link.whatsapp, link.label);
  }

  // 2) Telefones soltos no texto — associa por contexto textual da linha.
  const phoneInText = /(?:\(\d{2,3}\)|\b\d{2,3}\b)?[\s.-]*\d{4,5}[\s.-]*\d{4}/g;
  const lines = text.split(/(?:\r?\n|\s{2,})/).map((l) => l.trim()).filter((l) => l.length > 2);
  for (const line of lines) {
    const matches = line.match(phoneInText);
    if (!matches || matches.length === 0) continue;
    const nameGuess = guessName(line);
    for (const match of matches) {
      pushContact(match, nameGuess, false, nameGuess ?? undefined);
    }
  }

  // 3) Fallback: telefones no texto geral (sem associação confiável de nome).
  if (contacts.length === 0) {
    const allMatches = text.match(phoneInText);
    const unique = [...new Set(allMatches ?? [])];
    for (const match of unique) {
      pushContact(match, null, false);
    }
  }

  // Pós-processamento: para cada telefone, se houver um contato com nome real,
  // remove os "Sem nome" do mesmo número (duplicatas da etapa 2).
  const byPhone = new Map<string, ProspectedContact[]>();
  for (const c of contacts) {
    const list = byPhone.get(c.phone_normalized!) ?? [];
    list.push(c);
    byPhone.set(c.phone_normalized!, list);
  }
  const finalContacts: ProspectedContact[] = [];
  for (const list of byPhone.values()) {
    const withName = list.find((c) => c.name && c.name !== 'Sem nome');
    if (withName) {
      finalContacts.push(withName);
    } else {
      finalContacts.push(list[0]);
    }
  }
  contacts.length = 0;
  contacts.push(...finalContacts);

  return { title, contacts, blocked: null, finalUrl: url };
}

/**
 * Baixa a página com timeout e limites de tamanho. Retorna { ok, html, status }.
 * Evita fazer proxy de páginas protegidas: apenas baixa o HTML público.
 */
export async function fetchPageHtml(url: string): Promise<{
  ok: boolean;
  html?: string;
  status?: number;
  error?: string;
}> {
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 VyntraProspector/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml|application\/xml/.test(contentType)) {
      return { ok: false, error: `Página não é HTML (${contentType}).` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) {
      return { ok: false, error: 'Página muito grande.' };
    }
    return { ok: true, html: Buffer.from(buf).toString('utf-8'), status: res.status };
  } catch (err) {
    const em = err instanceof Error ? err.message : 'unknown';
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'A página demorou demais para responder.' };
    }
    return { ok: false, error: em };
  } finally {
    clearTimeout(timer);
  }
}

/** Valida que a URL informada é uma URL HTTP(S) plausível. */
export function isValidProspectingUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (!/^https?:\/\//i.test(trimmed)) {
    // Aceita domínio simples e adiciona https:// depois.
    return /^[\w-]+(\.[\w-]+)+([/?#][^\s]*)?$/i.test(trimmed);
  }
  try {
    const u = new URL(trimmed);
    return u.hostname.includes('.');
  } catch {
    return false;
  }
}