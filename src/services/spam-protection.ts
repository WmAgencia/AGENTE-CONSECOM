/**
 * SpamProtection — proteção contra bloqueio de spam na Evolution API.
 *
 * Adaptado do sketch original para a arquitetura do backend Consecom:
 *  - Rate limit de janela fixa de 1 minuto (máx. mensagens/min, configurável).
 *  - Jitter aleatório entre envios consecutivos (delay variável configurável).
 *  - Aplicado SOMENTE no disparo de campanhas (send.worker), que já é
 *    sequencial (um lead por vez). Não atrasa as respostas do agente em chat.
 *  - NÃO inclui digitação simulada nem reações: a build atual da Evolution
 *    (evolution_exchange v2.3.7) não expõe esses endpoints, e uma chamada a
 *    endpoint inexistente faria o envio falhar e entrar em retry/duplicação.
 *
 * Testabilidade: o construtor aceita configuração injetada (janela curta etc.)
 * e, sem ela, lê os valores do ambiente via getEnv() (com fallback seguro).
 */
import { getEnv } from '../config/env.js';

export interface SpamProtectionConfig {
  /** Máx. de mensagens por janela. 0 = desabilitado. */
  maxPerMinute?: number;
  /** Janela de rate limit em ms (default 60_000). */
  windowMs?: number;
  /** Delay mínimo do jitter em ms (default 800). */
  jitterMinMs?: number;
  /** Delay máximo do jitter em ms. 0 = desabilitado. */
  jitterMaxMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface EnvConfig {
  maxPerMinute: number;
  jitterMinMs: number;
  jitterMaxMs: number;
}

/** Lê as envs com fallback seguro (getEnv() pode lançar em testes parciais). */
function envConfig(): EnvConfig {
  try {
    const e = getEnv();
    return {
      maxPerMinute: e.EVOLUTION_RATE_LIMIT_MAX_PER_MINUTE,
      jitterMinMs: e.EVOLUTION_SEND_JITTER_MIN_MS,
      jitterMaxMs: e.EVOLUTION_SEND_JITTER_MAX_MS,
    };
  } catch {
    return { maxPerMinute: 20, jitterMinMs: 800, jitterMaxMs: 4000 };
  }
}

export class SpamProtection {
  private readonly maxPerMinute: number;
  private readonly windowMs: number;
  private readonly jitterMinMs: number;
  private readonly jitterMaxMs: number;

  private counter = 0;
  private windowStart = Date.now();

  constructor(cfg: SpamProtectionConfig = {}) {
    const d = envConfig();
    this.maxPerMinute = cfg.maxPerMinute ?? d.maxPerMinute;
    this.windowMs = cfg.windowMs ?? 60_000;
    this.jitterMinMs = cfg.jitterMinMs ?? d.jitterMinMs;
    this.jitterMaxMs = cfg.jitterMaxMs ?? d.jitterMaxMs;
  }

  /**
   * Bloqueia até liberar uma "vaga" dentro da janela de 1 minuto. Quando o
   * limite é atingido, espera o fim da janela e recomeça a contagem.
   */
  async checkRateLimit(): Promise<void> {
    if (this.maxPerMinute <= 0) return;
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.counter = 0;
      this.windowStart = now;
    }
    if (this.counter >= this.maxPerMinute) {
      const waitMs = this.windowMs - (now - this.windowStart);
      if (waitMs > 0) await sleep(waitMs);
      this.counter = 0;
      this.windowStart = Date.now();
    }
    this.counter++;
  }

  /** Delay aleatório entre envios consecutivos (anti-padrão de bot). */
  async jitter(): Promise<void> {
    if (this.jitterMaxMs <= 0) return;
    const min = Math.min(this.jitterMinMs, this.jitterMaxMs);
    const ms = min + Math.random() * Math.max(0, this.jitterMaxMs - min);
    await sleep(ms);
  }
}
