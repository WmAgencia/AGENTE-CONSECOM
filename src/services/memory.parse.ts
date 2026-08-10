/**
 * Parser de conversas importadas para a Memória Comercial da IA.
 *
 * Suporta os formatos mais comuns de exportação de conversas:
 *  - TXT do WhatsApp (Web/Desktop): linhas `[dd/mm/aaaa, hh:mm:ss] Nome: msg`
 *    e variantes simplificadas tipo `hh:mm - Nome: msg`.
 *  - CSV (exportadores/outras ferramentas): inferência de colunas por cabeçalho
 *    (remetente / mensagem / data-hora), sem depender de nomes rígidos.
 *  - ZIP: descompacta e processa cada .txt/.csv interno como uma conversa.
 *
 * O parser é agnóstico de nomes: retorna senders crus e classifica quale lado
 * é o agente comercial (o que enviou mais mensagens, ou o que casa com o nome
 * configurado do agente — nunca usa um nome fixo).
 */
import AdmZip from 'adm-zip';

export interface ParsedMessage {
  sender: string;
  text: string;
  time?: string;
  role?: 'agente' | 'lead';
}

export interface ParsedConversation {
  contactIdentifier?: string;
  contactName?: string;
  messages: ParsedMessage[];
  sourceFile?: string;
}

export type ContentKind = 'txt' | 'csv' | 'zip';

const MEDIA_PLACEHOLDER = '[midia]';

/** Rótulos de "si mesmo" nas exportações (o dono do aparelho). */
const SELF_LABELS = new Set(['você', 'voce', 'eu', 'me', 'myself', 'you']);

// ---------------------------------------------------------------------------
// Detecção de formato
// ---------------------------------------------------------------------------

export function detectContentKind(content: string): ContentKind {
  if (!content) return 'txt';
  // Base64 de um ZIP começa com "UEsDB" (PK\x03\x04), "UEsFB" ou "UEsFBw".
  const head = content.trimStart().slice(0, 8);
  if (/^UEsDB|^UEsFB|^UEsFBw/.test(head)) return 'zip';
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  if (looksLikeCsvHeader(firstLine)) return 'csv';
  return 'txt';
}

const SENDER_HEADER_WORDS = [
  'remetente', 'enviado por', 'enviadopor', 'autor', 'usuario', 'speaker',
  'participante', 'quem', 'contato', 'vendedor', 'cliente', 'nome', 'de', 'do',
];

const MESSAGE_HEADER_WORDS = [
  'mensagem', 'texto', 'message', 'text', 'conteudo', 'content', 'msg', 'body',
  'frase', 'conversa',
];

const TIME_HEADER_WORDS = [
  'datahora', 'data hora', 'data/hora', 'datetime', 'timestamp', 'quando',
  'enviado em', 'hora', 'data', 'time', 'date',
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
// CSV (parser leve, com aspas e delimitador automático)
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

/** Converte o CSV (com ou sem cabeçalho) em ParsedMessage[]. */
export function parseCsvExport(raw: string): ParsedMessage[] {
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  const delimiter = detectDelimiter(raw);
  const rows = nonEmpty.map((l) => splitCsvLine(l, delimiter).map((c) => c.trim()));

  let start = 0;
  let cols: CsvColumns | null = null;
  if (looksLikeCsvHeader(nonEmpty[0])) {
    const headerWords = rows[0]!.map((c) => normalizeWord(c));
    cols = inferCsvColumns(headerWords);
    if (cols) start = 1;
  }
  if (!cols) {
    // Sem cabeçalho reconhecível: assume [sender, mensagem, data...].
    cols = { sender: 0, message: 1, timeCols: [2] };
  }

  const out: ParsedMessage[] = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (cols.message >= row.length) continue;
    const sender = (row[cols.sender] ?? '').trim();
    const text = (row[cols.message] ?? '').trim();
    if (!sender && !text) continue;
    const timeParts = cols.timeCols
      .map((idx) => (idx >= 0 && idx < row.length ? row[idx] : ''))
      .filter(Boolean);
    const time = timeParts.length > 0 ? timeParts.join(' ') : undefined;
    out.push({ sender: sender || 'Desconhecido', text, time: time || undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// TXT (WhatsApp / exportadores)
// ---------------------------------------------------------------------------

// Cabeçalho do WhatsApp Web/Desktop: [dd/mm/aaaa, hh:mm(:ss)] (d/m ou m/d).
const WA_HEADER =
  /^\[(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4},\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s*/i;
// Cabeçalho simplificado: "10:03 - Nome: msg".
const SIMPLE_HEADER =
  /^(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*-\s*/i;

const MEDIA_LINE_RE =
  /^\u200e?\s*<(.+?)>$/i;

function isIgnorableMetaLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (MEDIA_LINE_RE.test(t)) return true;
  return /^(Mensagem editada|Você alterou|Você mudou|Você adicionou|Você removeu|Você criou|Você entrou|Você saiu|O grupo|As mensagens|Esta mensagem|Chamada|Lig ação)/i.test(t);
}

export function parseWhatsAppText(raw: string): ParsedMessage[] {
  const lines = raw.split(/\r?\n/);
  const out: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;

  for (const line of lines) {
    let rest: string | null = null;
    let time: string | undefined;

    const wa = line.match(WA_HEADER);
    if (wa) {
      time = wa[1];
      rest = line.slice(wa[0].length);
    } else {
      const simple = line.match(SIMPLE_HEADER);
      if (simple) {
        time = simple[1];
        rest = line.slice(simple[0].length);
      }
    }

    if (rest !== null) {
      const parts = splitSender(rest);
      if (parts.sender || parts.text) {
        pushMessage(out, parts, time);
        current = out[out.length - 1] ?? null;
      }
      continue;
    }

    // Linha sem cabeçalho → continuação da mensagem anterior.
    if (current) {
      current.text += '\n' + line;
    }
  }

  return out.filter((m) => m.text.trim().length > 0);
}

function splitSender(body: string): { sender: string; text: string } {
  const idx = body.search(/:\s/);
  if (idx > 0 && idx <= 120) {
    return { sender: body.slice(0, idx).trim(), text: body.slice(idx + 2).trim() };
  }
  return { sender: '', text: body.trim() };
}

function pushMessage(out: ParsedMessage[], parts: { sender: string; text: string }, time: string | undefined): void {
  if (!parts.sender && !parts.text) return;
  const sender = parts.sender || 'Desconhecido';
  const text = isIgnorableMetaLine(parts.text) ? MEDIA_PLACEHOLDER : parts.text.trim();
  // Mesmo sender + mesmo minuto = continuação (ex.: resposta em múltiplas partes).
  const last = out[out.length - 1];
  if (last && last.sender === sender && last.time === time && text !== MEDIA_PLACEHOLDER) {
    last.text += '\n' + text;
    return;
  }
  out.push({ sender, text, time });
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
      out.push({
        entryName: entry.entryName,
        fileName: name,
        content: text,
        kind: /\.csv$/i.test(name) ? 'csv' : 'txt',
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
 * com contato deduzido e papéis classificados (agente/lead).
 */
export function buildConversations(
  sources: Array<{ fileName: string; content: string; kind: ContentKind }>,
  agentName?: string | null,
): ParsedConversation[] {
  const out: ParsedConversation[] = [];
  for (const src of sources) {
    const messages =
      src.kind === 'csv'
        ? parseCsvExport(src.content)
        : parseWhatsAppText(src.content);
    if (messages.length === 0) continue;
    const classified = classifyRoles(messages, agentName);
    const contact = findContact(classified);
    out.push({ sourceFile: src.fileName, ...contact, messages: classified });
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