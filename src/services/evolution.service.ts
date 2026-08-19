/**
 * Evolution API client (MVP).
 *
 * Sends text messages back to WhatsApp via Evolution API v2 endpoint
 * POST /message/sendText using native fetch (Node 20+). No external deps.
 *
 * Security:
 *  - The API key is read from env and only placed in the `apikey` header.
 *  - It is never logged (pino redaction in utils/logger.ts).
 *  - Errors thrown here never include the API key or the Authorization header.
 *
 * Testability:
 *  - When EVOLUTION_API_URL is unset OR set to the literal "mock://evolution",
 *    sendText does NOT perform a real HTTP call; instead it resolves with a
 *    synthetic acknowledgement. This allows the webhook route to be tested
 *    end-to-end locally without an Evolution API instance running.
 */
import { getEnv, getEvolutionConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

export interface SendTextParams {
  /** Destination JID (e.g. "5511999999999@s.whatsapp.net") or bare number. */
  to: string;
  /** Text body to send. */
  text: string;
  /** Optional Evolution instance name to send through (defaults to EVOLUTION_INSTANCE_NAME). */
  instance?: string;
}

export interface SendTextResult {
  ok: boolean;
  status: number;
  /** Mock-mode sentinel for tests. */
  mock?: boolean;
  /** Evolution API message id when available. */
  messageId?: string;
  /** Non-fatal error message when ok=false. */
  error?: string;
  /**
   * Sinal definitivo de SESSAO MORTA: a Evolution responde HTTP 500 com body
   * "Connection Closed" quando o socket Baileys existe (connectionState=open)
   * mas a sessão WhatsApp foi invalidada (logout 401, número em outra instancia,
   * etc.). Em vez de contar como falha do LEAD, o worker marca a conexao como
   * disconnected e troca para uma instancia saudavel. Sem retry (retry numa
   * sessao morta so perde tempo).
   */
  connectionClosed?: boolean;
  /**
   * Sinal de ROTA INDISPONIVEL (HTTP 404). Algumas builds da Evolution
   * (ex.: "evolution_exchange" v2.3.7) não expõem a rota de voice note
   * `/message/sendWhatsAppAudio/{instance}`. O chamador pode então cair no
   * fallback (sendMedia com mediatype audio = arquivo de áudio) sem quebrar
   * o envio existente.
   */
  routeNotFound?: boolean;
}

export function isEvolutionMockMode(): boolean {
  try {
    const url = getEnv().EVOLUTION_API_URL;
    return !url || url === 'mock://evolution';
  } catch {
    return true;
  }
}

/**
 * Probes the Evolution API instance to verify connectivity and auth.
 * Returns { ok, status, instance, state? } without leaking secrets.
 * Calls GET `${apiUrl}/instance/connectionState/${instance}` — nesta build
 * da Evolution (v2.3.7 "evolution_exchange") a rota
 * `/instance/fetchInstances/{instance}` não existe (404); a que existe e
 * responde o estado da conexão é `/instance/connectionState/{instance}`.
 */
export interface EvolutionHealthResult {
  ok: boolean;
  status: number | string;
  mock: boolean;
  instance: string;
  profileName?: string;
  state?: string;
  error?: string;
}

export async function checkEvolutionHealth(): Promise<EvolutionHealthResult> {
  if (isEvolutionMockMode()) {
    return { ok: true, status: 'mock', mock: true, instance: 'mock' };
  }
  const cfg = getEvolutionConfig();
  const endpoint = `${cfg.apiUrl}/instance/connectionState/${encodeURIComponent(cfg.instance)}`;
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        apikey: cfg.apiKey,
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        mock: false,
        instance: cfg.instance,
        error: `Evolution API returned status ${response.status}`,
      };
    }
    const raw = await response.text();
    let state: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { instance?: { state?: string } };
      state = parsed.instance?.state;
    } catch {
      // not json, ignore
    }
    return {
      ok: true,
      status: response.status,
      mock: false,
      instance: cfg.instance,
      state,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown network error';
    return {
      ok: false,
      status: 0,
      mock: false,
      instance: cfg.instance,
      error: message,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Detecta se uma resposta da Evolution indica SESSAO MORTA (não falha
 * transitória de rede). A Evolution retorna HTTP 500 com body contendo
 * "Connection Closed" quando o socket Baileys aceitou a chamada mas a sessão
 * WhatsApp foi invalidada (logout 401 por número duplicado, dispositivo
 * removido, etc.). Nesse caso `connectionState` ainda mente "open" — só o
 * sendText revela a verdade. Retornamos um sinal limpo em vez de retry.
 */
function isConnectionClosed(status: number, body: string): boolean {
  if (status !== 500) return false;
  const low = body.toLowerCase();
  return low.includes('connection closed') || low.includes('connection_closed') || low.includes('session closed');
}

/** Estado REAL de UMA instância na Evolution API (não confia no status do banco).
 *  GET /instance/connectionState/{instance} -> { instance: { state } }.
 *  state: 'open' (conectada) | 'close' (desconectada) | 'connecting'.
 *  Retorna connected=true apenas quando state === 'open'.
 */
export interface EvolutionInstanceStateResult {
  ok: boolean;
  state: string | null;
  connected: boolean;
  status?: number;
}

export async function getEvolutionInstanceState(instance: string): Promise<EvolutionInstanceStateResult> {
  if (isEvolutionMockMode()) {
    return { ok: true, state: 'open', connected: true };
  }
  const cfg = getEvolutionConfig();
  try {
    const response = await fetch(
      `${cfg.apiUrl}/instance/connectionState/${encodeURIComponent(instance)}`,
      { method: 'GET', headers: { Accept: 'application/json', apikey: cfg.apiKey } },
    );
    if (!response.ok) {
      // 404 = a instância NÃO EXISTE mais na Evolution (foi apagada, perdeu o
      // banco, etc.). Isso é uma resposta DEFINITIVA (não um problema de rede):
      // trata como 'close' para que o worker marque disconnected no banco e
      // pare de mandar por uma instância fantasma. Só 5xx/0 (rede) indica que a
      // Evolution está inacessível e o worker deve confiar no banco.
      if (response.status === 404) {
        return { ok: true, state: 'close', connected: false, status: 404 };
      }
      return { ok: false, state: null, connected: false, status: response.status };
    }
    const raw = await response.text();
    let state: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { instance?: { state?: string } };
      state = (parsed.instance?.state ?? '').toLowerCase() || null;
    } catch {
      // resposta não-JSON: sem estado confirmado
    }
    return { ok: true, state, connected: state === 'open' };
  } catch {
    return { ok: false, state: null, connected: false };
  }
}

export async function sendText(params: SendTextParams): Promise<SendTextResult> {
  const log = getLogger();
  const { to, text } = params;

  if (!to || !text) {
    return { ok: false, status: 0, error: 'to and text are required' };
  }

  if (isEvolutionMockMode()) {
    log.info(
      { to: maskJid(to), textLength: text.length, mock: true },
      'evolution: sendText (mock mode)',
    );
    return {
      ok: true,
      status: 200,
      mock: true,
      messageId: `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    };
  }

  const cfg = getEvolutionConfig();
  const sendInstance = params.instance || cfg.instance;
  const endpoint = `${cfg.apiUrl}/message/sendText/${encodeURIComponent(sendInstance)}`;

  const body = {
    number: stripJidSuffix(to),
    text,
  };

  const maxRetries = getEnv().EVOLUTION_SENDTEXT_MAX_RETRIES;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.apiKey,
        },
        body: JSON.stringify(body),
      });

      const raw = await response.text();

      // Sessão MORTA (Base64 socket open mas WhatsApp invalidado): não
      // adianta retry — retorna sinal para o worker trocar de instancia.
      if (isConnectionClosed(response.status, raw)) {
        log.warn({ status: response.status, to: maskJid(to), endpoint }, 'evolution: sendText — sessão WhatsApp morta (Connection Closed)');
        return { ok: false, status: response.status, error: 'connection_closed', connectionClosed: true };
      }

      // Retry on 5xx and 429 (transient). Never retry on 4xx (except 429)
      // because those are deterministic configuration errors.
      if (response.status >= 500 || response.status === 429) {
        log.warn(
          { status: response.status, attempt, maxRetries, endpoint },
          'evolution: sendText transient error',
        );
        if (attempt < maxRetries) {
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          await sleep(backoffMs);
          continue;
        }
        return {
          ok: false,
          status: response.status,
          error: `Evolution API returned status ${response.status} after ${attempt} attempts`,
        };
      }

      if (!response.ok) {
        log.error(
          { status: response.status, endpoint },
          'evolution: sendText non-OK status',
        );
        return {
          ok: false,
          status: response.status,
          error: `Evolution API returned status ${response.status}`,
        };
      }

      let parsed: { key?: { id?: string } } = {};
      try {
        parsed = JSON.parse(raw) as { key?: { id?: string } };
      } catch {
        // non-JSON but 2xx - still considered success
      }

      const messageId = parsed.key?.id;
      log.info(
        { status: response.status, to: maskJid(to), messageId, attempt },
        'evolution: sendText delivered',
      );

      return { ok: true, status: response.status, messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown send error';
      log.warn(
        { errMessage: message, attempt, maxRetries, endpoint },
        'evolution: sendText network failure (retryable)',
      );
      lastError = message;
      if (attempt < maxRetries) {
        const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
        await sleep(backoffMs);
        continue;
      }
    }
  }
  return { ok: false, status: 0, error: lastError ?? 'sendText failed' };
}

/** Masks a JID for logs: "5511999999999@s.whatsapp.net" -> "5511...s.net" */
function maskJid(jid: string): string {
  if (!jid) return '';
  if (jid.length <= 12) return jid;
  const head = jid.slice(0, 4);
  const tail = jid.slice(-6);
  return `${head}...${tail}`;
}

/** Strips the WhatsApp JID suffix if present, returning the bare number. */
function stripJidSuffix(jid: string): string {
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : jid;
}

/**
 * Sends a text message to a group chat via Evolution API.
 * Unlike sendText, the full JID (e.g. "120363...@g.us") is used as the
 * destination because group chats require the group JID, not a bare number.
 */
export async function sendGroupText(
  to: string,
  text: string,
  instance?: string,
): Promise<SendTextResult> {
  const log = getLogger();
  if (!to || !text) {
    return { ok: false, status: 0, error: 'to and text are required' };
  }
  if (isEvolutionMockMode()) {
    log.info({ to: maskJid(to), textLength: text.length, mock: true }, 'evolution: sendGroupText (mock mode)');
    return {
      ok: true,
      status: 200,
      mock: true,
      messageId: `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    };
  }

  const cfg = getEvolutionConfig();
  const sendInstance = instance || cfg.instance;
  const endpoint = `${cfg.apiUrl}/message/sendText/${encodeURIComponent(sendInstance)}`;
  const body = {
    number: to,
    text,
  };

  const maxRetries = getEnv().EVOLUTION_SENDTEXT_MAX_RETRIES;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      if (response.status >= 500 || response.status === 429) {
        log.warn({ status: response.status, attempt, maxRetries, endpoint }, 'evolution: sendGroupText transient error');
        if (attempt < maxRetries) {
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, status: response.status, error: `Evolution API returned status ${response.status}` };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, error: `Evolution API returned status ${response.status}` };
      }
      let parsed: { key?: { id?: string } } = {};
      try {
        parsed = JSON.parse(raw) as { key?: { id?: string } };
      } catch {
        // non-JSON but 2xx - still success
      }
      const messageId = parsed.key?.id;
      log.info({ status: response.status, to: maskJid(to), messageId, attempt }, 'evolution: sendGroupText delivered');
      return { ok: true, status: response.status, messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown send error';
      log.warn({ errMessage: message, attempt, maxRetries, endpoint }, 'evolution: sendGroupText network failure (retryable)');
      lastError = message;
      if (attempt < maxRetries) {
        const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
        await sleep(backoffMs);
        continue;
      }
    }
  }
  return { ok: false, status: 0, error: lastError ?? 'sendGroupText failed' };
}

export type MediaKind = 'audio' | 'video' | 'image' | 'document';

export interface SendMediaParams {
  to: string;
  kind: MediaKind;
  /** base64 (without data-prefix) + filename/mimetype, OR a public media URL. */
  media: string;
  caption?: string;
  mimetype?: string;
  filename?: string;
  /** Optional Evolution instance name to send through (defaults to EVOLUTION_INSTANCE_NAME). */
  instance?: string;
}

/** Maps Consecom kind to the Evolution v1 media type */
const MEDIA_TYPE: Record<MediaKind, string> = {
  audio: 'audio',
  video: 'video',
  image: 'image',
  document: 'document',
};

export async function sendMedia(params: SendMediaParams): Promise<SendTextResult> {
  const log = getLogger();
  const { to, kind, media, caption, mimetype, filename } = params;
  if (!to || !media) {
    return { ok: false, status: 0, error: 'to and media are required' };
  }
  if (isEvolutionMockMode()) {
    log.info({ to: maskJid(to), kind, captionLength: caption?.length ?? 0 }, 'evolution: sendMedia (mock mode)');
    return {
      ok: true,
      status: 200,
      mock: true,
      messageId: `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    };
  }

  const cfg = getEvolutionConfig();
  // Algumas builds da Evolution API (ex: "evolution_exchange" v2.3.7) não
  // expõem rotas individuais (/message/sendVideo, /message/sendImage, ...).
  // A rota consolidada /message/sendMedia/{instance} + campo `mediatype`
  // funciona para áudio, vídeo, imagem e documento.
  const sendInstance = params.instance || cfg.instance;
  const endpoint = `${cfg.apiUrl}/message/sendMedia/${encodeURIComponent(sendInstance)}`;

  const mediaBody: Record<string, unknown> = { media };
  if (caption) mediaBody.caption = caption;
  if (mimetype) mediaBody.mimetype = mimetype;
  if (filename) mediaBody.fileName = filename;

  const body = {
    number: stripJidSuffix(to),
    mediatype: MEDIA_TYPE[kind],
    ...mediaBody,
  };

  const maxRetries = getEnv().EVOLUTION_SENDTEXT_MAX_RETRIES;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      if (isConnectionClosed(response.status, raw)) {
        log.warn({ status: response.status, to: maskJid(to), endpoint }, 'evolution: sendMedia — sessão WhatsApp morta (Connection Closed)');
        return { ok: false, status: response.status, error: 'connection_closed', connectionClosed: true };
      }
      if (response.status >= 500 || response.status === 429) {
        log.warn({ status: response.status, attempt, endpoint }, 'evolution: sendMedia transient error');
        if (attempt < maxRetries) {
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, status: response.status, error: `Evolution API returned status ${response.status}` };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, error: `Evolution API returned status ${response.status}: ${raw.slice(0, 200)}` };
      }
      let parsed: { key?: { id?: string } } = {};
      try {
        parsed = JSON.parse(raw) as { key?: { id?: string } };
      } catch {
        // ignore
      }
      const messageId = parsed.key?.id;
      log.info({ status: response.status, kind, to: maskJid(to), messageId, attempt }, 'evolution: sendMedia delivered');
      return { ok: true, status: response.status, messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown send error';
      log.warn({ errMessage: message, attempt, endpoint }, 'evolution: sendMedia network failure (retryable)');
      lastError = message;
      if (attempt < maxRetries) {
        const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
        await sleep(backoffMs);
        continue;
      }
    }
  }
  return { ok: false, status: 0, error: lastError ?? 'sendMedia failed' };
}

export interface SendVoiceNoteParams {
  /** Destination JID (e.g. "5511999999999@s.whatsapp.net") or bare number. */
  to: string;
  /**
   * URL pública do arquivo de áudio (ou base64 sem prefixo `data:`).
   * A Evolution baixa o arquivo e transcode para OGG/Opus (voice note PTT)
   * quando a build expõe `/message/sendWhatsAppAudio`.
   */
  audio: string;
  /** Optional Evolution instance name (defaults to EVOLUTION_INSTANCE_NAME). */
  instance?: string;
}

/**
 * Envia um áudio como MENSAGEM DE VOZ NATIVA do WhatsApp (voice note / PTT),
 * usando o endpoint `/message/sendWhatsAppAudio/{instance}` da Evolution.
 * Visualmente o destinatário vê o áudio como um "áudio gravado" (com waveform),
 * NÃO como arquivo/documento encaminhado.
 *
 * LIMITAÇÃO DA BUILD ATUAL (v2.3.7 "evolution_exchange"): a rota pode não
 * existir (HTTP 404) — nessas builds o `routeNotFound` é marcado e o chamador
 * deve cair no fallback (sendMedia com mediatype 'audio', que envia o áudio
 * como arquivo). Para habilitar voice notes de verdade, a build da Evolution
 * precisa expor `/message/sendWhatsAppAudio`; a transcodificação para
 * OGG/Opus com waveform é feita pela própria Evolution nesse fluxo.
 */
export async function sendVoiceNote(params: SendVoiceNoteParams): Promise<SendTextResult> {
  const log = getLogger();
  const { to, audio } = params;
  if (!to || !audio) {
    return { ok: false, status: 0, error: 'to and audio are required' };
  }
  if (isEvolutionMockMode()) {
    log.info({ to: maskJid(to) }, 'evolution: sendVoiceNote (mock mode)');
    return {
      ok: true,
      status: 200,
      mock: true,
      messageId: `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    };
  }

  const cfg = getEvolutionConfig();
  const sendInstance = params.instance || cfg.instance;
  const endpoint = `${cfg.apiUrl}/message/sendWhatsAppAudio/${encodeURIComponent(sendInstance)}`;
  const body = {
    number: stripJidSuffix(to),
    audio,
  };

  const maxRetries = getEnv().EVOLUTION_SENDTEXT_MAX_RETRIES;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      if (isConnectionClosed(response.status, raw)) {
        log.warn({ status: response.status, to: maskJid(to), endpoint }, 'evolution: sendVoiceNote — sessão WhatsApp morta (Connection Closed)');
        return { ok: false, status: response.status, error: 'connection_closed', connectionClosed: true };
      }
      // 404 = rota de voice note não existe nesta build. Sinaliza o fallback.
      if (response.status === 404) {
        log.warn({ status: 404, to: maskJid(to), endpoint }, 'evolution: sendVoiceNote — rota indisponível nesta build (404)');
        return { ok: false, status: 404, error: 'route_not_found', routeNotFound: true };
      }
      if (response.status >= 500 || response.status === 429) {
        log.warn({ status: response.status, attempt, endpoint }, 'evolution: sendVoiceNote transient error');
        if (attempt < maxRetries) {
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, status: response.status, error: `Evolution API returned status ${response.status}` };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, error: `Evolution API returned status ${response.status}: ${raw.slice(0, 200)}` };
      }
      let parsed: { key?: { id?: string } } = {};
      try {
        parsed = JSON.parse(raw) as { key?: { id?: string } };
      } catch {
        // ignore
      }
      const messageId = parsed.key?.id;
      log.info({ status: response.status, to: maskJid(to), messageId, attempt }, 'evolution: sendVoiceNote delivered (PTT)');
      return { ok: true, status: response.status, messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown send error';
      log.warn({ errMessage: message, attempt, endpoint }, 'evolution: sendVoiceNote network failure (retryable)');
      lastError = message;
      if (attempt < maxRetries) {
        const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
        await sleep(backoffMs);
        continue;
      }
    }
  }
  return { ok: false, status: 0, error: lastError ?? 'sendVoiceNote failed' };
}
