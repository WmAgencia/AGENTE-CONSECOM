/**
 * Helpers para extrair e normalizar o QR Code vindo da Evolution API.
 *
 * A Evolution API v2.x responde com formatos ligeiramente diferentes
 * dependendo do endpoint e da versão:
 *
 *   - GET /instance/connect/{instance}
 *       { pairingCode: null|string, code: string, base64: string, count: number }
 *       onde base64 já inclui o prefixo `data:image/png;base64,`.
 *
 *   - Webhook QRCODE_UPDATED
 *       { event, instance, data: { qrcode?: string|object, base64?: string, code?: string, ... } }
 *
 * Esta camada única normaliza essas variações para que o restante do
 * sistema sempre veja um único formato bem definido.
 */

const DATA_URI_PREFIX = 'data:image/png;base64,';

/**
 * Limpa o conteúdo base64: remove prefixos duplicados, espaços,
 * quebras de linha e vírgulas espúrias que possam ter sido
 * concatenadas por engano em algum ponto do pipeline.
 *
 * Retorna `null` se o conteúdo não parece um base64 PNG válido.
 */
export function normalizeQrBase64(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // Remove prefixo duplicado: data:image/png;base64,data:image/png;base64,...
  while (s.toLowerCase().startsWith(DATA_URI_PREFIX.toLowerCase())) {
    s = s.slice(DATA_URI_PREFIX.length).trim();
  }

  // Remove prefixo simples data:image/png;base64,
  const lower = s.toLowerCase();
  const sepIdx = lower.indexOf(',');
  if (sepIdx > 0 && lower.startsWith('data:') && sepIdx < 30) {
    s = s.slice(sepIdx + 1).trim();
  }

  // Remove qualquer outra ocorrência de "data:image/png;base64," ao longo
  // do texto (concatenação múltipla acidental).
  s = s.replace(/data:image\/png;base64,/gi, '');

  // Mantém apenas caracteres válidos para base64: A-Z a-z 0-9 + / =.
  s = s.replace(/[^A-Za-z0-9+/=]/g, '');

  // Base64 PNG decente tem pelo menos ~80 chars (64x64 placeholder),
  // imagens reais começam em ~200+.
  if (s.length < 80) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;

  return s;
}

/**
 * Monta o data URI final no formato canônico `data:image/png;base64,{base64}`.
 * Garante exatamente um único prefixo e nenhum caractere espúrio.
 */
export function toQrDataUri(raw: string | null | undefined): string | null {
  const base64 = normalizeQrBase64(raw);
  if (!base64) return null;
  return `${DATA_URI_PREFIX}${base64}`;
}

interface LooseQrContainer {
  qrcode?: unknown;
  base64?: unknown;
  code?: unknown;
  pairingCode?: unknown;
  count?: unknown;
}

/**
 * Tenta extrair o conteúdo do QR de uma resposta da Evolution API em
 * qualquer um dos formatos conhecidos.
 *
 * Ordem de preferência:
 *   1. data.base64 (formato novo, completo)
 *   2. data.qrcode (formato legado, pode ser string ou { base64 })
 *   3. code puro (sem imagem; geramos QR depois se possível)
 *
 * Retorna `{ base64, code }` com os valores normalizados, ou `null` se
 * nenhum campo útil foi encontrado.
 */
export function extractQrFromEvolution(
  data: unknown,
): { base64: string | null; code: string | null; dataUri: string | null } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as LooseQrContainer;

  const codeRaw = typeof d.code === 'string' ? d.code.trim() : null;

  // 1. data.base64 (formato completo com prefixo data:image/png;base64,)
  let base64: string | null = null;
  if (typeof d.base64 === 'string') {
    base64 = toQrDataUri(d.base64);
  }

  // 2. data.qrcode (pode ser string direta OU objeto { base64, code })
  if (!base64 && d.qrcode !== undefined) {
    if (typeof d.qrcode === 'string') {
      base64 = toQrDataUri(d.qrcode);
    } else if (d.qrcode && typeof d.qrcode === 'object') {
      const inner = d.qrcode as { base64?: unknown; code?: unknown };
      if (typeof inner.base64 === 'string') base64 = toQrDataUri(inner.base64);
    }
  }

  const dataUri = base64 ?? null;

  if (!dataUri && !codeRaw) return null;
  return { base64, code: codeRaw, dataUri };
}

/**
 * Verifica se uma string é um data URI PNG bem-formado.
 */
export function isValidQrDataUri(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  if (!value.toLowerCase().startsWith(DATA_URI_PREFIX.toLowerCase())) return false;
  const base64 = value.slice(DATA_URI_PREFIX.length);
  return base64.length >= 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
}
