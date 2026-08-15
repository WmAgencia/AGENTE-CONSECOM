/**
 * Centralized environment configuration and validation.
 * Secrets are read here and never re-exposed via getters that leak them.
 */
import { z } from 'zod';

const envSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 3000))
    .refine((v) => Number.isInteger(v) && v > 0 && v < 65536, {
      message: 'PORT must be a valid integer between 1 and 65535',
    }),

  NVIDIA_API_KEY: z
    .string()
    .min(1, 'NVIDIA_API_KEY is required and must not be empty'),

  SERVICE_NAME: z
    .string()
    .optional()
    .default('agente-consecom'),

  SERVICE_VERSION: z
    .string()
    .optional()
    .default('0.1.0'),

  LOG_LEVEL: z
    .string()
    .optional()
    .default('info')
    .refine(
      (v) =>
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(v),
      { message: 'Invalid LOG_LEVEL' },
    ),

  AGENT_MODEL: z
    .string()
    .optional()
    .default('meta/llama-3.1-8b-instruct'),

  AGENT_MAX_TOKENS: z
    .string()
    .optional()
    .default('1024')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'AGENT_MAX_TOKENS must be a positive integer',
    }),

  // === Evolution API integration (webhook MVP) ===
  EVOLUTION_API_URL: z
    .string()
    .optional()
    .refine(
      (v) => !v || /^https?:\/\//.test(v) || v === 'mock://evolution',
      { message: 'EVOLUTION_API_URL must start with http://, https:// or be "mock://evolution"' },
    ),

  EVOLUTION_API_KEY: z
    .string()
    .optional(),

  EVOLUTION_INSTANCE_NAME: z
    .string()
    .optional(),

  WEBHOOK_SECRET: z
    .string()
    .optional(),

  EVOLUTION_WEBHOOK_EVENTS: z
    .string()
    .optional()
    .default('messages.upsert,messages.upsert-ephemeral,QRCODE_UPDATED,CONNECTION_UPDATE,APPLICATION_STARTUP')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  EVOLUTION_AGENT_CONCURRENCY: z
    .string()
    .optional()
    .default('1')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'EVOLUTION_AGENT_CONCURRENCY must be a positive integer',
    }),

  // === Agent loop + tools ===
  AGENT_ENABLE_TOOLS: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  AGENT_ALLOWED_PERMS: z
    .string()
    .optional()
    .default('READ'),

  AGENT_ALLOWED_TOOLS: z
    .string()
    .optional()
    .default(''),

  AGENT_ALLOWED_DIR: z
    .string()
    .optional()
    .default(''),

  AGENT_MAX_ITERATIONS: z
    .string()
    .optional()
    .default('6')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 20, {
      message: 'AGENT_MAX_ITERATIONS must be an integer between 1 and 20',
    }),

  AGENT_TOOL_TIMEOUT_MS: z
    .string()
    .optional()
    .default('15000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'AGENT_TOOL_TIMEOUT_MS must be a positive integer',
    }),

  AGENT_MODEL_SUPPORTS_TOOLS: z
    .string()
    .optional()
    .default('auto')
    .refine((v) => ['auto', 'true', 'false'].includes(v), {
      message: 'AGENT_MODEL_SUPPORTS_TOOLS must be auto|true|false',
    }),

  // === Persistence (Etapa 2B) ===
  DATABASE_URL: z
    .string()
    .optional()
    .refine(
      (v) => !v || /^postgres(ql)?:\/\//.test(v),
      { message: 'DATABASE_URL must start with postgres:// or postgresql://' },
    ),

  // === Public API (Site Samira Revela) ===

  // Bearer token that the site must send as `Authorization: Bearer <AGENT_API_KEY>`
  // on every call to POST /api/chat. Lives only server-side. When unset, the
  // /api/chat endpoint refuses requests with 503 (never serves open by default).
  AGENT_API_KEY: z.string().optional(),

  // Comma-separated origin allowlist for CORS. Only these origins may call the
  // API from a browser. Use the literal "*" only for local dev (allows all).
  // When unset, cross-origin requests are blocked (no CORS headers emitted).
  // Example: ALLOWED_ORIGINS=https://samirarevela.com.br,https://www.samirarevela.com.br
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // === Extensão Vyntra Prospector (download do build) ===

  // Bucket do Supabase Storage que armazena o .zip público da extensão.
  EXTENSION_BUCKET: z.string().optional().default('consecom-media'),

  // Caminho do objeto (.zip) dentro do bucket.
  EXTENSION_OBJECT_PATH: z
    .string()
    .optional()
    .default('extensions/vyntra-prospector.zip'),

  // URL base do .zip público servido pela Vercel/estático — usada pelo backend
  // para gerar o .zip PERSONALIZADO por conta (injeta `auto-config.json` com a
  // extensionKey + ownerUserId do usuário). Quando vazia, usa o build público.
  EXTENSION_BASE_ZIP_URL: z.string().optional().default(''),

  // Chave de API que a extensão usa (header `x-extension-key`) para importar
  // leads e consultar dados — SEM login/token Supabase na extensão. O backend
  // grava com service role e o ownerUserId embutido no .zip personalizado.
  EXTENSION_API_KEY: z.string().optional().default(''),

  // === Scheduling / availability (site agenda) ===

  // Endpoint on the site that returns already-booked appointments so the agent
  // can tell which times are still free. JSON: array of date/time strings,
  // array of objects with start/date/time fields, or {appointments: [...]}.
  // When unset, consultar_horarios reports it cannot determine availability.
  AGENDA_API_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\//.test(v), {
      message: 'AGENDA_API_URL must start with http:// or https://',
    }),

  // WhatsApp JID of the admin group notified when a client is left waiting.
  // Used by notify_admin_group (requires Evolution API configured here).
  AGENT_ADMIN_GROUP_JID: z.string().optional(),

  // Endpoint on the site that CREATES a booking (POST /api/public/booking).
  // Used by criar_agendamento. When unset, the agent cannot create bookings
  // and must never confirm a reservation to the client.
  AGENT_BOOKING_API_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\//.test(v), {
      message: 'AGENT_BOOKING_API_URL must start with http:// or https://',
    }),

  // === Consecom prospecção ===

  // Base URL of your Supabase project: https://<ref>.supabase.co
  // Used server-side by the marcar_reuniao tool via the REST API.
  SUPABASE_URL: z.string().optional(),

  // Supabase REST/api key with permission to run the RPC that marks a meeting.
  // Lives only server-side. Never log it or return it from HTTP handlers.
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // RPC function name that records a won meeting for a lead id.
  // Defaults to consecom_marcar_reuniao.
  SUPABASE_MARCAR_REUNIAO_RPC: z
    .string()
    .optional()
    .default('consecom_marcar_reuniao'),

  // Auto-send worker polling interval in ms (how often it checks pending runs).
  CONSECOM_WORKER_TICK_MS: z
    .string()
    .optional()
    .default('5000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'CONSECOM_WORKER_TICK_MS must be a positive integer',
    }),

  // Número máximo de tentativas do worker para uma mesma mensagem da campanha
  // (além das retries internas do sendText). Enquanto não esgota as tentativas,
  // a sequência do lead permanece ATIVA (sequence_active = true) e a IA fica
  // bloqueada. Ao esgotar, o run é marcado como 'failed' e a IA é liberada.
  CONSECOM_SEND_MAX_RETRIES: z
    .string()
    .optional()
    .default('3')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 10, {
      message: 'CONSECOM_SEND_MAX_RETRIES must be an integer 1..10',
    }),

  // Backoff base (ms) entre tentativas do worker para a mesma mensagem.
  // O atraso real é backoff x número da tentativa (ex.: 60s, 120s, 180s).
  CONSECOM_SEND_RETRY_BACKOFF_MS: z
    .string()
    .optional()
    .default('60000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'CONSECOM_SEND_RETRY_BACKOFF_MS must be a positive integer',
    }),

  // === Exclusão definitiva de leads/histórico ===
  // Senha exigida na rota POST /api/leads/permanent-delete (validada SOMENTE no
  // backend). Nunca é enviada/validada no frontend. Se não configurada, a rota
  // de exclusão definitiva fica desativada (retorna 503).
  CONSECOM_ADMIN_PASSWORD: z
    .string()
    .optional(),

  // === Rate limiting (Etapa 2C) ===
  RATE_LIMIT_MAX: z
    .string()
    .optional()
    .default('60')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'RATE_LIMIT_MAX must be a positive integer',
    }),

  RATE_LIMIT_WINDOW: z
    .string()
    .optional()
    .default('60')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0, {
      message: 'RATE_LIMIT_WINDOW must be a positive integer (seconds)',
    }),

  // === Evolution API production hardening (Etapa 2D) ===
  EVOLUTION_ALLOWED_INSTANCES: z
    .string()
    .optional()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // JIDs of allowed group chats (e.g. "120363xxx@g.us"). Empty => all groups
  // allowed. Single-PC anti-spam defense.
  EVOLUTION_ALLOWED_GROUPS: z
    .string()
    .optional()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // When true, in group chats the agent only replies when its number is
  // mentioned (pushName appears in the message body or quotedJid matches).
  // Default false because single-chat is the primary use case.
  EVOLUTION_MENTION_ONLY: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  EVOLUTION_SENDTEXT_MAX_RETRIES: z
    .string()
    .optional()
    .default('3')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 10, {
      message: 'EVOLUTION_SENDTEXT_MAX_RETRIES must be an integer 1..10',
    }),

  // TTL (ms) do cache de estado real das instâncias no send.worker. Controla
  // com que frequência o worker consulta a Evolution (connectionState) antes
  // de enviar — um valor maior reduz chamadas à API, menor reage mais rápido.
  EVOLUTION_CONNECTION_STATE_TTL_MS: z
    .string()
    .optional()
    .default('15000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 1000 && v <= 300000, {
      message: 'EVOLUTION_CONNECTION_STATE_TTL_MS must be an integer 1000..300000',
    }),

  // Auto-limpeza de conexões novas: se uma conexão criada (status pending/
  // connecting) não CONECTAR em até EVOLUTION_CONNECTION_CONNECT_TIMEOUT_MS,
  // o worker apaga a instância na Evolution e fecha a conexão no banco.
  // Default 60000 = 1 minuto.
  EVOLUTION_CONNECTION_CONNECT_TIMEOUT_MS: z
    .string()
    .optional()
    .default('60000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 5000 && v <= 3_600_000, {
      message: 'EVOLUTION_CONNECTION_CONNECT_TIMEOUT_MS must be an integer 5000..3600000',
    }),

  // Intervalo entre varreduras de auto-limpeza de conexões não conectadas
  // (ver cleanupStaleConnections no send.worker).
  EVOLUTION_CONNECTION_CLEANUP_INTERVAL_MS: z
    .string()
    .optional()
    .default('30000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 5000 && v <= 3_600_000, {
      message: 'EVOLUTION_CONNECTION_CLEANUP_INTERVAL_MS must be an integer 5000..3600000',
    }),

  // Anti-spam do disparo de campanhas (SpamProtection no send.worker).
  // 0 desabilita o limite de mensagens por minuto.
  EVOLUTION_RATE_LIMIT_MAX_PER_MINUTE: z
    .string()
    .optional()
    .default('20')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 0 && v <= 600, {
      message: 'EVOLUTION_RATE_LIMIT_MAX_PER_MINUTE must be an integer 0..600 (0 = disabled)',
    }),

  // Jitter aleatório entre envios consecutivos. JITTER_MAX 0 desabilita.
  EVOLUTION_SEND_JITTER_MIN_MS: z
    .string()
    .optional()
    .default('800')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 0 && v <= 60_000, {
      message: 'EVOLUTION_SEND_JITTER_MIN_MS must be an integer 0..60000',
    }),

  EVOLUTION_SEND_JITTER_MAX_MS: z
    .string()
    .optional()
    .default('4000')
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= 0 && v <= 60_000, {
      message: 'EVOLUTION_SEND_JITTER_MAX_MS must be an integer 0..60000',
    }),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');

    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  return parsed.data;
}

let cached: Env | null = null;

/**
 * Clears the cached environment. Production does not mutate process.env, so
 * this is only used by tests that need to change env vars between cases.
 */
export function resetEnvCache(): void {
  cached = null;
}

export function getEnv(): Env {
  if (!cached) {
    cached = loadEnv();
  }

  return cached;
}

/**
 * Returns true when the NVIDIA API key has been configured.
 * Used by status endpoint without leaking the actual value.
 */
export function hasNvidiaApiKey(): boolean {
  try {
    return Boolean(getEnv().NVIDIA_API_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns the NVIDIA API key for use in backend calls only.
 * Never log or return this value from HTTP handlers.
 */
export function getNvidiaApiKey(): string {
  return getEnv().NVIDIA_API_KEY;
}

/**
 * Returns true when Evolution API configuration is available.
 * Used by status endpoint without leaking values.
 */
export function hasEvolutionConfig(): boolean {
  try {
    const e = getEnv();
    return Boolean(
      e.EVOLUTION_API_URL && e.EVOLUTION_API_KEY && e.EVOLUTION_INSTANCE_NAME,
    );
  } catch {
    return false;
  }
}

/**
 * Returns the WEBHOOK_SECRET for validating Evolution webhook calls.
 * Never log or return this value from HTTP handlers.
 */
export function getWebhookSecret(): string | undefined {
  return getEnv().WEBHOOK_SECRET;
}

/**
 * Returns true when DATABASE_URL has been configured.
 * Used by status and health endpoints without leaking the URL.
 */
export function hasDatabase(): boolean {
  try {
    return Boolean(getEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

/**
 * Returns the DATABASE_URL for the pg pool. Throws if not set.
 * Never log or return this value from HTTP handlers.
 */
export function getDatabaseUrl(): string {
  const e = getEnv();
  if (!e.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  return e.DATABASE_URL;
}

/**
 * Returns true when AGENT_API_KEY is configured.
 * Used by status endpoint and /api/chat preHandler without leaking the value.
 */
export function hasAgentApiKey(): boolean {
  try {
    return Boolean(getEnv().AGENT_API_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns the AGENT_API_KEY for server-side Bearer validation only.
 * Never log or return this value from HTTP handlers.
 */
export function getAgentApiKey(): string {
  return getEnv().AGENT_API_KEY ?? '';
}

/**
 * Returns the comma-separated CORS origin allowlist (trimmed). Never contains
 * secrets. The literal "*" means "allow any origin" (local dev only).
 */
export function getAllowedOrigins(): string[] {
  try {
    return getEnv().ALLOWED_ORIGINS ?? [];
  } catch {
    return [];
  }
}

/**
 * Returns Evolution API configuration for backend calls only.
 * Never log or return apiKey from HTTP handlers.
 */
export function getEvolutionConfig(): {
  apiUrl: string;
  apiKey: string;
  instance: string;
  allowedEvents: string[];
  concurrency: number;
} {
  const e = getEnv();
  if (!e.EVOLUTION_API_URL || !e.EVOLUTION_API_KEY || !e.EVOLUTION_INSTANCE_NAME) {
    throw new Error(
      'Evolution API not configured: EVOLUTION_API_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE_NAME are required',
    );
  }
  return {
    apiUrl: e.EVOLUTION_API_URL.replace(/\/$/, ''),
    apiKey: e.EVOLUTION_API_KEY,
    instance: e.EVOLUTION_INSTANCE_NAME,
    allowedEvents: e.EVOLUTION_WEBHOOK_EVENTS,
    concurrency: e.EVOLUTION_AGENT_CONCURRENCY,
  };
}

/**
 * Returns the Consecom prospection config (Supabase) for backend calls only.
 * Never log or return the service role key from HTTP handlers.
 */
export function getSupabaseProspeccaoConfig(): {  url: string;
  serviceRoleKey: string;
  rpc: string;
} {
  const e = getEnv();
  return {
    url: (e.SUPABASE_URL ?? '').replace(/\/$/, ''),
    serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY ?? '',
    rpc: e.SUPABASE_MARCAR_REUNIAO_RPC,
  };
}

/**
 * Returns true when Supabase prospection config is available (postgres driver
 * not needed; uses REST API via the service role key).
 */
export function hasSupabaseProspeccao(): boolean {
  try {
    const e = getEnv();
    return Boolean(e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns the configured admin password for permanent lead/history deletion.
 * Empty when not configured (the permanent-delete route stays disabled).
 */
export function getConsecomAdminPassword(): string {
  return getEnv().CONSECOM_ADMIN_PASSWORD ?? '';
}