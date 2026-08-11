/**
 * Parser de conversas importadas para a Memória Comercial da IA.
 *
 * Reconhece as principais variações reais de exportação:
 *  - WhatsApp Web/Desktop atual: `dd/mm/aaaa, hh:mm(:ss) - Nome: msg`
 *  - WhatsApp com colchetes:      `[dd/mm/aaaa, hh:mm(:ss)] Nome: msg`
 *  - Simplificado:                `hh:mm(:ss) - Nome: msg`
 *  (dia/mês com 1 ou 2 dígitos, ano com 2 ou 4, AM/PM, com/sem segundos)
 *
 *  - CSV (exportadores/outras ferramentas): inferência de colunas por cabeçalho
 *    (remetente / mensagem / data-hora), sem depender de nomes rígidos.
 *  - ZIP: descompacta e processa cada .txt/.csv interno como uma conversa.
 *
 * Mensagens multilinha, emojis, acentos, caracteres unicode, mídia omitida e
 * mensagens de sistema são tratadas. O parser nunca rejeita a conversa inteira
 * por causa de linhas isoladas — linhas não reconhecidas são contadas em
 * `stats.unsupported` e o restante segue sendo processado.
 */
import AdmZip from 'adm-zip';

export interface ParsedMessage {
  sender: string;
  text: string;
  time?: string;
  role?: 'agente' | 'lead';
}

export interface ParseStats {
  /** Total de linhas não-vazias lidas. */
  lines: number;
  /** Mensagens reconhecidas. */
  messages: number;
  /** Linhas que não pertenceram a nenhuma mensagem. */
  unsupported: number;
}

export interface ParsedText {
  messages: ParsedMessage[];
  stats: ParseStats;
}

export interface ParsedConversation {
  contactIdentifier?: string;
  contactName?: string;
  messages: ParsedMessage[];
  sourceFile?: string;
  stats?: ParseStats;
}

export type ContentKind = 'txt' | 'csv' | 'zip';

const MEDIA_PLACEHOLDER = '[midia]';

/** Rótulos de "si mesmo" nas exportações (o dono do aparelho). */
const SELF_LABELS = new Set(['você', 'voce', 'eu', 'me', 'myself', 'you']);

/** Caracteres invisíveis que podem anteceder linhas/nomes (BOM, LRM/RLM). */
const INVISIBLE_PREFIX_RE = /^[\u200e\u200f\uFEFF]+/;

// ---------------------------------------------------------------------------
// Detecção de formato
// ---------------------------------------------------------------------------

export function detectContentKind(content: string): ContentKind {
  if (!content) return 'txt';
  const c = content.replace(INVISIBLE_PREFIX_RE, '');
  // Base64 de um ZIP começa com "UEsDB" (PK\x03\x04), "UEsFB" ou "UEsFBw".
  const head = c.trimStart().slice(0, 8);
  if (/^UEsDB|^UEsFB|^UEsFBw/.test(head)) return 'zip';
  const firstLine = c.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  if (looksLikeCsvHeader(firstLine)) return 'csv';
  return 'txt';
}

const SENDER_HEADER_WORDS = [
  'remetente', 'enviado por', 'enviadopor', 'autor', 'author', 'sender',
  'usuario', 'user', 'speaker', 'participante', 'quem', 'contato', 'from',
  'vendedor', 'cliente', 'lead', 'agente', 'nome', 'name', 'phone',
  'telefone', 'numero', 'de', 'do', 'por',
];

const MESSAGE_HEADER_WORDS = [
  'mensagem', 'texto', 'message', 'text', 'conteudo', 'content', 'msg',
  'body', 'frase', 'conversa', 'comentario', 'dialogo',
];

const TIME_HEADER_WORDS = [
  'datahora', 'data hora', 'data/hora', 'datetime', 'timestamp', 'quando',
  'enviado em', 'enviadoem', 'created', 'criado em', 'hora', 'data', 'time',
  'date', 'createdat',
];

export function normalizeWord(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function looksLikeCsvHeader(line: string): boolean {
  const cells = line.split(/[,;\t]/);
  if (cells.length < 2) return false;
  const words = cells.map((c) => normalizeWord(c.trim()));
  const hasSender = words.some((c) => SENDER_HEADER_WORDS.includes(c));
  const hasMessage = words.some((c) => MESSAGE_HEADER_WORDS.includes(c));
  const hasTime = words.some((c) => TIME_HEADER_WORDS.includes(c));
  return (hasSender && hasMessage) || (hasMessage && hasTime);
}

// ---------------------------------------------------------------------------
// CSV (parser leve, com aspas, delimitador automático e células multilinha)
// ---------------------------------------------------------------------------

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [
    d,
    firstLine.split(d).length - 1,
  ]);
  counts.sort((a, b) => b[1] - a[1]);
  return (counts[0]?.[1] ?? 0) > 0 ? (counts[0][0] ?? ',') : ',';
}

/** Divide uma linha CSV respeitando aspas e o delimitador detectado. */
function splitCsvLine(line: string, delimiter = ','): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

interface CsvColumns {
  sender: number;
  message: number;
  timeCols: number[];
}

function inferCsvColumns(words: string[]): CsvColumns | null {
  const senderIdx = words.findIndex((w) => SENDER_HEADER_WORDS.includes(w));
  const messageIdx = words.findIndex((w) => MESSAGE_HEADER_WORDS.includes(w));
  if (senderIdx === -1 || messageIdx === -1) return null;
  const timeCols = words
    .map((w, i) => (TIME_HEADER_WORDS.includes(w) ? i : -1))
    .filter((i) => i >= 0 && i !== senderIdx && i !== messageIdx);
  return { sender: senderIdx, message: messageIdx, timeCols };
}

/** Junta linhas físicas quando uma célula com aspas continua na linha seguinte. */
function joinCsvPhysicalLines(raw: string): string[] {
  const physical = raw.split(/\r?\n/);
  const logical: string[] = [];
  let buf = '';
  for (const l of physical) {
    buf = buf ? buf + '\n' + l : l;
    const quotes = (buf.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      logical.push(buf);
      buf = '';
    }
  }
  if (buf) logical.push(buf);
  return logical;
}

function parseCsvInternal(raw: string): ParsedText {
  const lines = joinCsvPhysicalLines(raw);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { messages: [], stats: { lines: 0, messages: 0, unsupported: 0 } };
  }

  const delimiter = detectDelimiter(nonEmpty.join('\n'));
  const rows = nonEmpty.map((l) => splitCsvLine(l, delimiter).map((c) => c.trim()));

  let start = 0;
  let cols: CsvColumns | null = null;
  if (looksLikeCsvHeader(nonEmpty[0]!)) {
    const headerWords = rows[0]!.map((c) => normalizeWord(c));
    cols = inferCsvColumns(headerWords);
    if (cols) start = 1;
  }
  if (!cols) {
    // Sem cabeçalho reconhecível: assume [sender, mensagem, data...].
    cols = { sender: 0, message: 1, timeCols: [2] };
  }

  const out: ParsedMessage[] = [];
  let unsupported = 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (cols.message >= row.length) {
      unsupported++;
      continue;
    }
    const sender = (row[cols.sender] ?? '').trim();
    const text = (row[cols.message] ?? '').trim();
    if (!sender && !text) {
      unsupported++;
      continue;
    }
    const timeParts = cols.timeCols
      .map((idx) => (idx >= 0 && idx < row.length ? row[idx] : ''))
      .filter(Boolean);
    const time = timeParts.length > 0 ? timeParts.join(' ').trim() : undefined;
    out.push({ sender: sender || 'Desconhecido', text, time: time || undefined });
  }
  return {
    messages: out,
    stats: { lines: rows.length - start, messages: out.length, unsupported },
  };
}

/** Converte o CSV (com ou sem cabeçalho) em ParsedMessage[]. */
export function parseCsvExport(raw: string): ParsedMessage[] {
  return parseCsvInternal(raw).messages;
}

// ---------------------------------------------------------------------------
// TXT (WhatsApp / exportadores)
// ---------------------------------------------------------------------------

// DATA: dd/mm/aaaa (ou d/m/aa, ou com '.') — 1-2 dígitos, ano 2 ou 4.
const DATE_PART = String.raw`\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}`;
// HORA: HH:mm(:ss) com AM/PM opcional.
const TIME_PART = String.raw`\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?`;

/**
 * Tenta extrair (data hora, resto) do início de uma linha de exportação.
 * Não depende de um único formato: aceita colchetes, travessão, sem travessão,
 * com/sem segundos e AM/PM.
 */
function matchHeaderLine(line: string): { time: string; rest: string } | null {
  const l = line.replace(INVISIBLE_PREFIX_RE, '');
  const dateTime = `${DATE_PART}[ ,]\\s*${TIME_PART}`;

  // [dd/mm/aaaa, hh:mm(:ss)] (\u200e) Nome: msg
  const bracket = new RegExp(
    `^\\[(${dateTime})\\]\\s*\\u200e?\\s*(.*)$`,
    'i',
  ).exec(l);
  if (bracket) return { time: bracket[1]!.trim(), rest: bracket[2]! };

  // dd/mm/aaaa, hh:mm(:ss) - Nome: msg   (formato real das exportações atuais)
  const dash = new RegExp(`^(${dateTime})\\s*-\\s*(.*)$`, 'i').exec(l);
  if (dash) return { time: dash[1]!.trim(), rest: dash[2]! };

  // dd/mm/aaaa, hh:mm(:ss) Nome: msg   (sem travessão)
  const noDash = new RegExp(`^(${dateTime})\\s+(.*)$`, 'i').exec(l);
  if (noDash) return { time: noDash[1]!.trim(), rest: noDash[2]! };

  // hh:mm(:ss) - Nome: msg
  const simple = new RegExp(`^(${TIME_PART})\\s*-\\s*(.*)$`, 'i').exec(l);
  if (simple) return { time: simple[1]!.trim(), rest: simple[2]! };

  // hh:mm(:ss) Nome: msg
  const simpleNoDash = new RegExp(`^(${TIME_PART})\\s+(.*)$`, 'i').exec(l);
  if (simpleNoDash) return { time: simpleNoDash[1]!.trim(), rest: simpleNoDash[2]! };

  return null;
}

/** Linha cujo conteúdo é apenas uma referência de mídia (`<mídia omitida>`). */
function isMediaLine(text: string): boolean {
  const t = text.trim();
  return /^<.+>$/i.test(t);
}

/** Mensagens automáticas/sistema do WhatsApp que não devem virar aprendizados. */
function isSystemLine(text: string): boolean {
  const t = text.trim().replace(/^[\u200e\u200f]+/, '');
  if (!t) return true;
  const lower = t.toLowerCase();
  return (
    /^(mensagens? e chamadas são protegidas|as mensagens e as chamadas|messages? and calls? are end.to.end encrypt)/.test(lower) ||
    /criptografia de ponta a ponta|end.to.end encrypted/.test(lower) ||
    /\b(você|voce|user) (alterou|mudou|definiu|criou|adicionou|removeu|entrou|saiu|renomeou)\b/.test(lower) ||
    /\b(criou o grupo|grupo foi criado|created the group|created group|joined the group|left the group|entrou no grupo|saiu do grupo|adicionou (o|a|você|voce|user)|\bremoveu (o|a|você|voce|user)|removeu .* do grupo|adicionou .* ao grupo|renomeou o grupo|alterou o nome do grupo|mudou o nome do grupo|mudou a foto do grupo|definiu a foto do grupo|changed the (group )?(subject|name|photo|icon))\b/.test(lower) ||
    /^(chamada de (áudio|vídeo|voz)|chamada perdida|missed (voice|video) call|voice call|video call|chamada de voz|chamada de vídeo)/.test(lower) ||
    /^(mensagem apagada|esta mensagem foi apagada|message deleted|this message was deleted)/.test(lower) ||
    /^(o grupo|os administradores|apenas o administrador|somente administradores|para adicionar|você pode ver)/.test(lower)
  );
}

function parseTxtInternal(raw: string): ParsedText {
  const lines = raw.split(/\r?\n/);
  const nonEmptyTotal = lines.filter((l) => l.trim().length > 0).length;
  const out: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;
  let headerLines = 0;
  let continuationLines = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    const m = matchHeaderLine(line);
    if (m) {
      const parts = splitSender(m.rest);
      if (parts.sender || parts.text) {
        const added = pushMessage(out, parts, m.time);
        if (added) {
          headerLines++;
          current = out[out.length - 1] ?? null;
        } else {
          // Linha de sistema descartada: não vira "atual" para continuações.
          current = null;
        }
      }
      continue;
    }

    // Linha sem cabeçalho → continuação da mensagem anterior.
    if (current) {
      continuationLines++;
      current.text += '\n' + line;
    }
  }

  const messages = out.filter((m) => m.text.trim().length > 0);
  return {
    messages,
    stats: {
      lines: nonEmptyTotal,
      messages: messages.length,
      unsupported: Math.max(0, nonEmptyTotal - headerLines - continuationLines),
    },
  };
}

export function parseWhatsAppText(raw: string): ParsedMessage[] {
  return parseTxtInternal(raw).messages;
}

function splitSender(body: string): { sender: string; text: string } {
  const b = body.replace(/^[\u200e\u200f\s]+/, '');
  const idx = b.search(/:\s/);
  if (idx > 0 && idx <= 120) {
    return { sender: b.slice(0, idx).trim(), text: b.slice(idx + 2).trim() };
  }
  return { sender: '', text: b.trim() };
}

/**
 * Adiciona (ou mescla) uma mensagem. Retorna false quando a linha é uma
 * mensagem de sistema (não deve virar mensagem nem receber continuações).
 */
function pushMessage(
  out: ParsedMessage[],
  parts: { sender: string; text: string },
  time: string | undefined,
): boolean {
  if (!parts.sender && !parts.text) return false;
  const trimmed = parts.text.trim();
  if (isSystemLine(trimmed)) return false;

  const text = isMediaLine(trimmed) ? MEDIA_PLACEHOLDER : trimmed;
  const sender = parts.sender || 'Desconhecido';

  // Mesmo sender + mesmo instante = continuação (ex.: resposta em partes).
  const last = out[out.length - 1];
  if (last && last.sender === sender && last.time === time && text !== MEDIA_PLACEHOLDER) {
    last.text += '\n' + text;
    return true;
  }
  out.push({ sender, text, time });
  return true;
}

/** Ponto de entrada unificado: devolve mensagens + estatísticas de diagnóstico. */
export function parseText(content: string, kind: ContentKind): ParsedText {
  if (kind === 'csv') return parseCsvInternal(content);
  return parseTxtInternal(content);
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

export interface ZipParsedConversation {
  entryName: string;
  fileName: string;
  content: string;
  kind: ContentKind;
}

/** Descompacta um ZIP (base64) e devolve os arquivos de texto internos. */
export function parseZipToText(base64: string): ZipParsedConversation[] {
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) return [];
    const zip = new AdmZip(buffer);
    const out: ZipParsedConversation[] = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.split('/').pop() ?? entry.entryName;
      if (!/\.(txt|csv|tsv)$/i.test(name)) continue;
      const bytes = entry.getData();
      if (!bytes || bytes.length === 0 || bytes.length > 4 * 1024 * 1024) continue;
      let text = bytes.toString('utf8');
      if (text.includes('\uFFFD')) text = bytes.toString('latin1');
      if (text.trim().length === 0) continue;
      // Determina o formato pelo conteúdo (não só pela extensão).
      out.push({
        entryName: entry.entryName,
        fileName: name,
        content: text,
        kind: detectContentKind(text),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agrupamento / classificação
// ---------------------------------------------------------------------------

/**
 * Monta conversas a partir de fontes (arquivos). Um arquivo = uma conversa,
 * com contato deduzido, papéis classificados (agente/lead) e estatísticas.
 */
export function buildConversations(
  sources: Array<{ fileName: string; content: string; kind: ContentKind }>,
  agentName?: string | null,
): ParsedConversation[] {
  const out: ParsedConversation[] = [];
  for (const src of sources) {
    const parsed = parseText(src.content, src.kind);
    if (parsed.messages.length === 0) continue;
    const classified = classifyRoles(parsed.messages, agentName);
    const contact = findContact(classified);
    out.push({ sourceFile: src.fileName, ...contact, messages: classified, stats: parsed.stats });
  }
  return out;
}

function findContact(messages: Array<ParsedMessage & { role: 'agente' | 'lead' }>): {
  contactName?: string;
  contactIdentifier?: string;
} {
  const leadSenders = new Map<string, number>();
  for (const m of messages) {
    const s = m.sender.trim();
    if (m.role !== 'lead' || !s || s === MEDIA_PLACEHOLDER) continue;
    leadSenders.set(s, (leadSenders.get(s) ?? 0) + 1);
  }
  const sorted = [...leadSenders.entries()].sort((a, b) => b[1] - a[1]);
  const name = sorted[0]?.[0];
  if (!name) return {};
  const looksPhone = /^[+0-9\s-]{8,}$/.test(name);
  return looksPhone
    ? { contactIdentifier: name.replace(/[^\d]/g, '') }
    : { contactName: name };
}

/**
 * Classifica cada mensagem como 'agente' ou 'lead':
 *  - Com agentName configurado: senders que casam (case-insensitive) = agente;
 *    rótulos de si mesmo (você/eu) = agente também.
 *  - Sem agentName: quem enviou MAIS mensagens é o agente (venda outbound);
 *    o resto é lead.
 */
export function classifyRoles(
  messages: ParsedMessage[],
  agentName?: string | null,
): Array<ParsedMessage & { role: 'agente' | 'lead' }> {
  if (agentName && agentName.trim()) {
    const needle = normalizeWord(agentName.trim());
    return messages.map((m) => {
      const sender = normalizeWord(m.sender.trim());
      const isAgent = sender.includes(needle) || needle.includes(sender) || SELF_LABELS.has(sender);
      return { ...m, role: isAgent ? 'agente' : 'lead' };
    });
  }

  const counts = new Map<string, number>();
  for (const m of messages) {
    const s = m.sender.trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const agentSender = sorted[0]?.[0];

  return messages.map((m) => {
    const s = m.sender.trim();
    const norm = normalizeWord(s);
    return { ...m, role: SELF_LABELS.has(norm) || (s !== '' && s === agentSender) ? 'agente' : 'lead' };
  });
}

/** Serializa a conversa para o modelo (etiqueta Agente/Lead, corta no máximo). */
export function transcriptToModelLines(messages: Array<ParsedMessage & { role: 'agente' | 'lead' }>, max = 200): string {
  return messages
    .slice(-max)
    .map((m) => `${m.role === 'agente' ? 'Agente' : 'Lead'}: ${m.text}`)
    .filter((l) => l.trim().length > 0)
    .join('\n');
}