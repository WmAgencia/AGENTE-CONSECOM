import { z } from 'zod';

export const agentRequestSchema = z.object({
  task: z
    .string()
    .min(1, 'task must be a non-empty string')
    .max(8000, 'task must be at most 8000 characters'),
  conversationId: z
    .string()
    .min(1, 'conversationId must be a non-empty string')
    .max(200, 'conversationId must be at most 200 characters')
    .optional(),
});

export const agentRequestSchemaSite = z.object({
  message: z
    .string()
    .min(1, 'message must be a non-empty string')
    .max(8000, 'message must be at most 8000 characters'),
  conversationId: z
    .string()
    .min(1)
    .max(200)
    .optional(),
});

export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type SiteAgentRequest = z.infer<typeof agentRequestSchemaSite>;

/**
 * Request schema for the public site-facing endpoint POST /api/chat.
 * conversationId identifies a conversation; messages sharing the same id
 * belong to the same memory. Required so contexts never mix.
 *
 * `directives` (optional) carries the site's trained rules/guidelines. When
 * present, the agent injects them into its system prompt so the model follows
 * the site's directives on top of its base identity.
 */
export const chatRequestSchema = z.object({
  conversationId: z
    .string()
    .min(1, 'conversationId must be a non-empty string')
    .max(200, 'conversationId must be at most 200 characters'),
  message: z
    .string()
    .min(1, 'message must be a non-empty string')
    .max(8000, 'message must be at most 8000 characters'),
  directives: z
    .string()
    .max(100_000, 'directives must be at most 100000 characters')
    .optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Response shape of POST /api/chat. Deliberately minimal: the site only
 * needs the answer, the model that produced it, and the latency. Diagnostics
 * from the agent loop (iterations, toolCalls, ...) are intentionally not
 * exposed on this public endpoint.
 */
export interface ChatResponse {
  conversationId: string;
  response: string;
  model: string;
  latencyMs: number;
}

export interface AgentResponse {
  task: string;
  result: string;
  model: string;
  latencyMs: number;
}

export interface AgentLoopResponse extends AgentResponse {
  iterations: number;
  toolCalls: number;
  usedTools: boolean;
  conversationId?: string;
}

export interface HealthResponse {
  status: 'ok';
  uptime: number;
}

export interface StatusResponse {
  service: string;
  version: string;
  status: 'operational';
  uptime: number;
  nvidiaApiKeyConfigured: boolean;
  model: string;
  evolutionConfigured: boolean;
  toolsEnabled: boolean;
  toolsRegistered: number;
  conversationsInMemory: number;
  dbConnected: boolean;
  timestamp: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
