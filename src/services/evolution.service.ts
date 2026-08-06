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
 * Returns { ok, status, instance, profileName? } without leaking secrets.
 * Calls GET `${apiUrl}/instance/fetchInstances/${instance}` (v2 endpoint).
 */
export interface EvolutionHealthResult {
  ok: boolean;
  status: number | string;
  mock: boolean;
  instance: string;
  profileName?: string;
  error?: string;
}

export async function checkEvolutionHealth(): Promise<EvolutionHealthResult> {
  if (isEvolutionMockMode()) {
    return { ok: true, status: 'mock', mock: true, instance: 'mock' };
  }
  const cfg = getEvolutionConfig();
  const endpoint = `${cfg.apiUrl}/instance/fetchInstances/${encodeURIComponent(cfg.instance)}`;
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
    let profileName: string | undefined;
    try {
      const parsed = JSON.parse(raw) as
        | { instance?: { profileName?: string } }
        | Array<{ instance?: { profileName?: string } }>;
      if (Array.isArray(parsed)) {
        profileName = parsed[0]?.instance?.profileName;
      } else if (parsed) {
        profileName = parsed.instance?.profileName;
      }
    } catch {
      // not json, ignore
    }
    return {
      ok: true,
      status: response.status,
      mock: false,
      instance: cfg.instance,
      profileName,
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
  const endpoint = `${cfg.apiUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`;

  const body = {
    number: stripJidSuffix(to),
    options: { delay: 0, presence: 'composing' },
    textMessage: { text },
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
  const endpoint = `${cfg.apiUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`;
  const body = {
    number: to,
    options: { delay: 0, presence: 'composing' },
    textMessage: { text },
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
