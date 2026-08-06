/**
 * Conversation store with Postgres persistence + in-RAM fallback.
 *
 * - When DATABASE_URL is set and ensureSchema() succeeds: writes go to pg,
 *   reads come from pg. Latest N turns are kept in a small in-RAM window
 *   to feed the agent loop cheaply without a round trip on every message.
 * - When DATABASE_URL is absent or pg is unreachable: pure RAM fallback so
 *   the service still works (degraded). A log warning is emitted once.
 *
 * Public API is intentionally the same as the previous RAM-only store so
 * callers (agent.ts, webhook.ts) don't change.
 */
import { getPool, isDbEnabled, ensureSchema } from './db.js';
import { getLogger } from '../utils/logger.js';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  ts: number;
  toolName?: string;
}

const MAX_TURNS_RETURNED = 16;
const MAX_CONVERSATIONS_RAM = 1000;
const MAX_TURNS_RAM = 16;

class ConversationStore {
  private map = new Map<string, ConversationTurn[]>();
  private readonly maxConversations: number;
  private readonly maxTurns: number;
  private warnedFallback: boolean = false;

  constructor(
    maxConversations = MAX_CONVERSATIONS_RAM,
    maxTurns = MAX_TURNS_RAM,
  ) {
    this.maxConversations = maxConversations;
    this.maxTurns = maxTurns;
  }

  /** Returns the chronological list of turns (oldest first). */
  async get(conversationId: string): Promise<ConversationTurn[]> {
    if (!isDbEnabled()) return this.getRam(conversationId);
    try {
      const pool = getPool();
      const res = await pool.query(
        `SELECT role, content, tool_name AS "toolName",
                EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms
         FROM messages
         WHERE conversation_id = $1
         ORDER BY id DESC
         LIMIT $2`,
        [conversationId, MAX_TURNS_RETURNED],
      );
      const rows = res.rows.slice().reverse();
      return rows.map((r: { role: string; content: string; toolName: string | null; ts_ms: string }) => ({
        role: r.role as ConversationTurn['role'],
        content: r.content,
        toolName: r.toolName ?? undefined,
        ts: Number(r.ts_ms),
      }));
    } catch {
      return this.getRam(conversationId);
    }
  }

  private getRam(id: string): ConversationTurn[] {
    return (this.map.get(id) ?? []).map((t) => ({ ...t }));
  }

  async appendUser(conversationId: string, content: string): Promise<void> {
    return this.append(conversationId, { role: 'user', content, ts: Date.now() });
  }

  async appendAssistant(conversationId: string, content: string): Promise<void> {
    return this.append(conversationId, { role: 'assistant', content, ts: Date.now() });
  }

  async appendTool(
    conversationId: string,
    toolName: string,
    content: string,
  ): Promise<void> {
    return this.append(conversationId, {
      role: 'tool',
      content,
      ts: Date.now(),
      toolName,
    });
  }

  private async append(id: string, turn: ConversationTurn): Promise<void> {
    // Always mirror in RAM (cheap cache; bounded)
    this.appendRam(id, turn);

    if (!isDbEnabled()) return;

    try {
      const pool = getPool();
      // Upsert conversation row when absent (cheap)
      await pool.query(
        `INSERT INTO conversations(id, last_turn_at)
         VALUES ($1, now())
         ON CONFLICT (id) DO UPDATE SET last_turn_at = now()`,
        [id],
      );
      await pool.query(
        `INSERT INTO messages(conversation_id, role, content, tool_name, ts)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))`,
        [id, turn.role, turn.content, turn.toolName ?? null, turn.ts],
      );
    } catch (err) {
      const log = getLogger();
      const message = err instanceof Error ? err.message : 'unknown';
      if (!this.warnedFallback) {
        log.warn(
          { errMessage: message },
          'conversation: write to db failed; using RAM fallback',
        );
        this.warnedFallback = true;
      }
    }
  }

  private appendRam(id: string, turn: ConversationTurn): void {
    let turns = this.map.get(id);
    if (!turns) {
      if (this.map.size >= this.maxConversations) {
        const firstKey = this.map.keys().next().value;
        if (firstKey !== undefined) this.map.delete(firstKey);
      }
      turns = [];
      this.map.set(id, turns);
    }
    turns.push(turn);
    if (turns.length > this.maxTurns) {
      turns.splice(0, turns.length - this.maxTurns);
    }
  }

  size(): number {
    return this.map.size;
  }

  /** Calls ensureSchema (idempotent). Safe to call from server boot. */
  async init(): Promise<boolean> {
    return ensureSchema();
  }

  /** Deletes a conversation and all its turns (DB + RAM). */
  async clear(conversationId: string): Promise<boolean> {
    this.map.delete(conversationId);
    if (!isDbEnabled()) return true;
    try {
      const pool = getPool();
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
      return true;
    } catch (err) {
      const log = getLogger();
      const message = err instanceof Error ? err.message : 'unknown';
      log.warn({ errMessage: message, conversationId }, 'conversation: clear failed');
      return false;
    }
  }
}

let singleton: ConversationStore | null = null;

export function getConversationStore(): ConversationStore {
  if (!singleton) singleton = new ConversationStore();
  return singleton;
}

/**
 * Converts stored ConversationTurns into the ChatMessage[] the agent loop
 * expects. Tool turns become role:"user" with the tool result wrapped as
 * `<tool_result>` so the conversation remains meaningful when replayed.
 */
export function turnsToHistory(turns: ConversationTurn[]): Array<{
  role: 'user' | 'assistant';
  content: string;
}> {
  return turns.flatMap((t) => {
    if (t.role === 'tool') {
      return [{
        role: 'user' as const,
        content: `<tool_result tool="${t.toolName ?? 'unknown'}">${t.content}</tool_result>`,
      }];
    }
    return [{ role: t.role as 'user' | 'assistant', content: t.content }];
  });
}
